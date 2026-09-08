"use client";
// Client-only WebGL viewer wrapper around @fitsgl/core's bare <FitsViewer>. Renders
// the CEERS tile pyramid color map, then draws OUR OWN source overlay as an SVG layer
// positioned over the viewer canvas: every catalog source (from the site search index)
// is a Kron ELLIPSE — semi-axes A_IMAGE*KRON_RADIUS / B_IMAGE*KRON_RADIUS, PA =
// THETA_IMAGE, the exact parametrization unicorn_bioplots.pro's tvellipse uses — drawn
// GREEN if SELECTED and YELLOW if not, and clickable to open the shared ResultCard.
//
// Why an SVG overlay (not fitsgl's own markers/regions): the SVG layer is trivially
// verifiable (count DOM nodes), reliably clickable (real DOM events), and lets us cull
// to the viewport so 174k sources stay smooth. Each ellipse's WORLD-space vertices are
// mapped to screen via the viewer handle's `imageToScreen` (documented for exactly this
// — positioning a DOM overlay over a data point), so pan / zoom / North-up are all
// handled by the viewer and the ellipses stay registered under any camera transform.
//
// MUST stay client-only (WebGL2 + window): the route dynamic-imports it with
// { ssr: false }.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FitsViewer,
  type FitsViewerHandle,
  deriveViewerConfig,
  explorerBandsFromConfig,
  defaultViewFromConfig,
  defaultExplorerState,
} from "@fitsgl/core/react";
import { loadFitsglConfig, type FitsglConfig, type ViewerConfig } from "@fitsgl/core";
import {
  SEARCH_FIELDS,
  loadField,
  loadFilters,
  type FieldIndex,
  type NumCol,
} from "@/app/data/_card/objectCard";

type LoadState = "loading" | "ready" | "error";

const CEERS = SEARCH_FIELDS.find(f => f.field === "CEERS")!;

// Overlay colors: selected sources green, everything else yellow.
const GREEN = "#43d17a";
const YELLOW = "#f2d43a";

// Cap on drawn overlay glyphs per frame — the viewport cull keeps only what's visible,
// and this bounds the SVG node count so pan/zoom stays smooth even zoomed all the way
// out over the whole 174k-source mosaic.
const MAX_GLYPHS = 4000;
// Ellipse polygon resolution (vertices). 16 is smooth on-screen and cheap.
const ELLIPSE_SEGMENTS = 16;
// Below this many drawing-buffer px per world px, an ellipse is too tiny to resolve —
// draw a small dot instead of a full polygon (saves nodes when zoomed way out).
const DOT_ZOOM = 0.15;

// ---- Filter model ----------------------------------------------------------
export type MapFilters = {
  selectedOnly: boolean;
  zMin: number | null;
  zMax: number | null;
  magMin: number | null;
  magMax: number | null;
  magFilter: string;
};
export const DEFAULT_FILTERS: MapFilters = {
  selectedOnly: false, zMin: null, zMax: null, magMin: null, magMax: null, magFilter: "F277W",
};

// A source that passed the active filters, with the geometry needed to draw it.
type Src = {
  i: number; id: number; sel: boolean;
  x: number; y: number;               // detection-pixel centre (world coords)
  semiA: number; semiB: number; th: number;  // ellipse semi-axes (px) + PA (rad); th=NaN → circle
};

// Precompute the filtered source list (positions + ellipse params). Recomputed only
// when the index, mag column, or filters change — NOT per frame.
function filterSources(idx: FieldIndex, magCol: NumCol, f: MapFilters): Src[] {
  const n = idx.n;
  const sel = idx.selected, za = idx.za;
  const a = idx.a_image, b = idx.b_image, kr = idx.kron_radius, theta = idx.theta ?? null;
  const x = idx.x, y = idx.y;
  const haveXY = x != null && y != null;
  const { zMin, zMax, magMin: mMin, magMax: mMax, selectedOnly } = f;
  const out: Src[] = [];
  if (!haveXY) return out;
  for (let i = 0; i < n; i++) {
    const isSel = sel?.[i] === 1;
    if (selectedOnly && !isSel) continue;
    const z = za?.[i];
    if (zMin != null && (z == null || z < zMin)) continue;
    if (zMax != null && (z == null || z > zMax)) continue;
    if (mMin != null || mMax != null) {
      const m = magCol?.[i];
      if (m == null) continue;
      if (mMin != null && m < mMin) continue;
      if (mMax != null && m > mMax) continue;
    }
    const xi = x![i], yi = y![i];
    if (xi == null || yi == null) continue;
    // Ellipse params (Kron): semi-axes a*kron, b*kron; PA theta deg CCW from +x.
    let semiA = 0, semiB = 0, th = NaN;
    const av = a?.[i], bv = b?.[i], kv = kr?.[i], tv = theta?.[i];
    if (av != null && bv != null && kv != null && kv > 0 && tv != null) {
      semiA = av * kv; semiB = bv * kv; th = (tv * Math.PI) / 180;
    }
    out.push({ i, id: idx.id[i], sel: isSel, x: xi, y: yi, semiA, semiB, th });
  }
  return out;
}

// One drawable glyph in SCREEN space, produced by projecting a source through the
// viewer's imageToScreen for the current frame.
type Glyph = { id: number; sel: boolean; poly?: string; cx?: number; cy?: number; r?: number };

export default function MapViewer({
  configUrl,
  filters,
  onSourceClick,
  onCount,
  onReadyHandle,
}: {
  configUrl: string;
  filters: MapFilters;
  onSourceClick: (id: number) => void;
  /** Report how many sources pass the active filters (total, not just on-screen). */
  onCount?: (n: number) => void;
  /** Hand the viewer handle + index up to the page (for the "go to" control). */
  onReadyHandle?: (h: FitsViewerHandle, idx: FieldIndex) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [idx, setIdx] = useState<FieldIndex | null>(null);
  const [magCol, setMagCol] = useState<NumCol>(null);
  const [glyphs, setGlyphs] = useState<Glyph[]>([]);

  const clickRef = useRef(onSourceClick);
  useEffect(() => { clickRef.current = onSourceClick; }, [onSourceClick]);
  const countRef = useRef(onCount);
  useEffect(() => { countRef.current = onCount; }, [onCount]);
  const readyHandleRef = useRef(onReadyHandle);
  useEffect(() => { readyHandleRef.current = onReadyHandle; }, [onReadyHandle]);

  const handleRef = useRef<FitsViewerHandle | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The current filtered source list, held in a ref so the per-frame projector reads
  // the latest without being a hook dependency (projection must not re-subscribe onFrame).
  const sourcesRef = useRef<Src[]>([]);

  // Load the tile config.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) { setState("loading"); setConfig(null); } });
    loadFitsglConfig(configUrl)
      .then(cfg => { if (!cancelled) { setConfig(cfg); setState("ready"); } })
      .catch(err => {
        if (cancelled) return;
        console.error("[map] failed to load fitsgl config:", err);
        setErrMsg(err instanceof Error ? err.message : String(err));
        setState("error");
      });
    return () => { cancelled = true; };
  }, [configUrl]);

  // Derive the bare-viewer ViewerConfig (bands + default RGB view) from the producer
  // FitsglConfig — the same transform <FitsExplorer> does internally.
  const viewerConfig = useMemo<ViewerConfig | null>(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    // Match campfire's trilogy scaling (same knobs as FitsglCutout's CAMPFIRE_TRILOGY),
    // recomputed from each field's own per-band stats — so the map color matches campfire.
    st.trilogyParams = { ...st.trilogyParams, noiselum: 0.12, satpercent: 0.01, noisesig: 2.0, noisesig0: 2.0 };
    return deriveViewerConfig(bands, st);
  }, [config]);

  // Load our search index (positions, selected, za, geometry) once.
  useEffect(() => {
    let cancelled = false;
    loadField(CEERS)
      .then(({ idx }) => { if (!cancelled) setIdx(idx); })
      .catch(err => console.error("[map] failed to load search index:", err));
    return () => { cancelled = true; };
  }, []);

  // Resolve the mag column for the active band when a mag range is set.
  const magBand = filters.magFilter;
  const magRangeActive = filters.magMin != null || filters.magMax != null;
  useEffect(() => {
    if (!idx || !magRangeActive) { setMagCol(null); return; }
    let cancelled = false;
    if (magBand === "F277W" && idx.m277) { setMagCol(idx.m277); return; }
    if (magBand === "F444W" && idx.m444) { setMagCol(idx.m444); return; }
    (async () => {
      const fx = await loadFilters(CEERS);
      if (cancelled || !fx) { setMagCol(null); return; }
      const flux = fx[`flux_${magBand.toLowerCase()}`];
      if (!flux) { setMagCol(null); return; }
      const col = flux.map(v => (v != null && v > 0 ? 31.4 - 2.5 * Math.log10(v) : null));
      if (!cancelled) setMagCol(col as NumCol);
    })();
    return () => { cancelled = true; };
  }, [idx, magBand, magRangeActive]);

  // Rebuild the filtered source list when index / mag column / filters change.
  const sources = useMemo(
    () => (idx ? filterSources(idx, magRangeActive ? magCol : null, filters) : []),
    [idx, magCol, filters, magRangeActive],
  );
  useEffect(() => {
    sourcesRef.current = sources;
    countRef.current?.(sources.length);
    // Reproject against the current camera (filters changed between frames). A couple
    // of delayed retries cover the case where the viewer handle / first frame isn't
    // ready yet at the instant the source list first resolves.
    project();
    const t1 = setTimeout(() => project(), 200);
    const t2 = setTimeout(() => project(), 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // Project the (culled) filtered sources to screen glyphs for the current frame. Reads
  // sourcesRef + the live viewer handle; called from onFrame and on filter change.
  const project = useCallback(() => {
    const h = handleRef.current;
    const wrap = wrapRef.current;
    if (!h || !wrap) return;
    const cam = h.getCameraState();
    if (!cam) return;
    const rect = wrap.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const zoom = cam.zoom;
    const list = sourcesRef.current;
    const asDot = zoom < DOT_ZOOM;

    // Phase 1 — WORLD-space viewport cull (cheap, no imageToScreen). The viewport spans
    // W/zoom × H/zoom world px about the camera centre; take a generous margin (×1.5 +
    // pad) so display rotation / North-up can't clip edge sources. This yields the set
    // actually on-screen without projecting every one of the 174k sources per frame.
    const halfW = (W / zoom) * 0.75 + 60;
    const halfH = (H / zoom) * 0.75 + 60;
    const x0 = cam.centerX - halfW, x1 = cam.centerX + halfW;
    const y0 = cam.centerY - halfH, y1 = cam.centerY + halfH;
    const visible: Src[] = [];
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) visible.push(s);
    }

    // Phase 2 — if more are visible than the cap, stride-sample the VISIBLE set uniformly
    // so the drawn glyphs spread evenly across the on-screen field instead of clustering
    // on the first N. Zoomed in (few visible) the stride is 1 and every visible source
    // is drawn. Only the sampled survivors are projected to screen.
    const stride = Math.max(1, Math.ceil(visible.length / MAX_GLYPHS));
    const out: Glyph[] = [];
    for (let k = 0; k < visible.length && out.length < MAX_GLYPHS; k += stride) {
      const s = visible[k];
      const c = h.imageToScreen(s.x + 0.5, s.y + 0.5);
      if (!c) continue;
      const scx = c.x - rect.left, scy = c.y - rect.top;

      if (asDot || !(s.semiA > 0 && s.semiB > 0) || Number.isNaN(s.th)) {
        out.push({ id: s.id, sel: s.sel, cx: scx, cy: scy, r: asDot ? 1.6 : 4 });
        continue;
      }
      // Project the ellipse's world-space rim vertices → screen (handles North-up too).
      const ct = Math.cos(s.th), st = Math.sin(s.th);
      const pts: string[] = [];
      let bad = false;
      for (let j = 0; j < ELLIPSE_SEGMENTS; j++) {
        const phi = (2 * Math.PI * j) / ELLIPSE_SEGMENTS;
        const ex = s.semiA * Math.cos(phi), ey = s.semiB * Math.sin(phi);
        const wx = s.x + 0.5 + ex * ct - ey * st;
        const wy = s.y + 0.5 + ex * st + ey * ct;
        const p = h.imageToScreen(wx, wy);
        if (!p) { bad = true; break; }
        pts.push(`${(p.x - rect.left).toFixed(1)},${(p.y - rect.top).toFixed(1)}`);
      }
      if (bad) continue;
      out.push({ id: s.id, sel: s.sel, poly: pts.join(" ") });
    }
    setGlyphs(out);
  }, []);

  // Kick a few projection attempts spaced out in time. fitsgl fires onFrame only when
  // the view actually changes (no idle loop), so on first load — or when the source
  // list changes while the camera sits still — we must project proactively rather than
  // wait for a frame. Retries cover the window where the camera/tiles settle after
  // ready. Stops early once something paints.
  const pokeProject = useCallback(() => {
    let tries = 0;
    const tick = () => {
      project();
      tries += 1;
      if (tries < 12) setTimeout(tick, 250);
    };
    requestAnimationFrame(tick);
  }, [project]);

  const onReady = useCallback((h: FitsViewerHandle) => {
    handleRef.current = h;
    if (idx) readyHandleRef.current?.(h, idx);
    pokeProject();
  }, [idx, pokeProject]);

  // If the index arrives after the viewer is ready, still hand it up.
  useEffect(() => {
    if (idx && handleRef.current) readyHandleRef.current?.(handleRef.current, idx);
  }, [idx]);

  if (state === "error") {
    return (
      <MapMessage
        title="Could not load the color map"
        body={
          <>
            The tile dataset (<code style={{ color: "var(--text-muted)" }}>fitsgl.json</code>) failed to load from<br />
            <code style={{ color: "var(--text-muted)", wordBreak: "break-all" }}>{configUrl}</code>
            {errMsg && <><br /><span style={{ color: "var(--text-dim)" }}>{errMsg}</span></>}
          </>
        }
      />
    );
  }

  if (state === "loading" || !config || !viewerConfig) {
    return <MapMessage title="Loading color map…" body="Fetching tile pyramid + source catalog." spin />;
  }

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      <FitsViewer
        config={viewerConfig}
        onReady={onReady}
        onFrame={() => project()}
        onError={(err) => {
          console.error("[map] FitsViewer error:", err);
          setErrMsg(err instanceof Error ? err.message : String(err));
          setState("error");
        }}
        style={{ width: "100%", height: "100%" }}
      />
      {/* Overlay layer — pointer-events only on the glyphs, so panning the map still
          works everywhere between sources. */}
      <svg
        data-overlay="sources"
        width="100%" height="100%"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
      >
        {glyphs.map((g, k) => {
          const color = g.sel ? GREEN : YELLOW;
          const onClick = (e: React.MouseEvent) => { e.stopPropagation(); clickRef.current(g.id); };
          if (g.poly) {
            return (
              <polygon
                key={k} data-src-id={g.id} points={g.poly}
                fill="transparent" stroke={color} strokeWidth={1.4}
                style={{ pointerEvents: "visible", cursor: "pointer" }}
                onClick={onClick}
              >
                <title>ID {g.id}</title>
              </polygon>
            );
          }
          return (
            <circle
              key={k} data-src-id={g.id} cx={g.cx} cy={g.cy} r={g.r}
              fill={g.r! <= 2 ? color : "transparent"} stroke={color} strokeWidth={1.4}
              style={{ pointerEvents: "visible", cursor: "pointer" }}
              onClick={onClick}
            >
              <title>ID {g.id}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}

function MapMessage({ title, body, spin }: { title: string; body: React.ReactNode; spin?: boolean }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "12px", textAlign: "center",
      padding: "2rem", background: "#0d0a1a",
    }}>
      {spin && (
        <div style={{
          width: "28px", height: "28px", borderRadius: "50%",
          border: "3px solid rgba(196,144,216,0.25)", borderTopColor: "var(--accent)",
          animation: "unicorn-spin 0.9s linear infinite",
        }} />
      )}
      <div className="mono" style={{ color: "var(--accent)", fontSize: "0.95rem", fontWeight: 700 }}>{title}</div>
      <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", lineHeight: 1.7, maxWidth: "460px" }}>{body}</div>
      <style>{`@keyframes unicorn-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
