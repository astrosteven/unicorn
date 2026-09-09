"use client";
// On-the-fly color cutout rendered from a field's fitsgl tile pyramid — the SAME
// WebGL trilogy color the /data/map viewer shows, generated client-side at the
// object's sky position with NO pre-baked PNG.
//
// How it works (all frozen @fitsgl/core public API — see node_modules/@fitsgl/core):
//  - loadFitsglConfig(base + "/fitsgl.json") fetches + validates + URL-resolves the
//    producer config (bands with precomputed trilogy stats + a weighted default view).
//  - We derive the controlled ViewerConfig exactly as <FitsExplorer> does, via the
//    exported pure helpers (explorerBandsFromConfig / defaultViewFromConfig /
//    defaultExplorerState / deriveViewerConfig). CEERS' defaultView is an RGB trilogy,
//    which derives to a `multiband` (faithful weighted-trilogy) view.
//  - A bare <FitsViewer> (NOT <FitsExplorer> — that has no ref handle) is mounted at a
//    small fixed size. On ready we reproduce the explorer's `applyTrilogyFromStats`:
//    viewer.applyTrilogy([per-band stats], trilogyParams) + setStretchMode('trilogy'),
//    then getWcs() + skyToPix(ra,dec) -> setCenter, and setZoom for the target FOV.
//  - The <FitsViewer> React wrapper destroys the core viewer + every band pyramid on
//    unmount, so no WebGL context leaks as cards open/close.
//
// MUST be client-only (WebGL2 + window): consumers dynamic-import it with { ssr:false }.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitsViewer, type FitsViewerHandle } from "@fitsgl/core/react";
import {
  loadFitsglConfig,
  type FitsglConfig,
  type ViewerConfig,
  skyToPix,
  DEFAULT_TRILOGY_PARAMS,
  type TrilogyParams,
  type TrilogyStats,
} from "@fitsgl/core";
import {
  explorerBandsFromConfig,
  defaultViewFromConfig,
  defaultExplorerState,
  deriveViewerConfig,
} from "@fitsgl/core/react";

// Trilogy scaling knobs matched to campfire (campfire.hollisakins.com / COSMOS-Web
// defaults). Applied over each field's own per-band stats, so it recomputes the same
// stretch campfire uses — no tile rebuild needed. Shared by the map (MapViewer) too.
export const CAMPFIRE_TRILOGY = { noiselum: 0.12, satpercent: 0.01, noisesig: 2.0, noisesig0: 2.0 };

// Per-field fitsgl base URL. Only fields present here render an on-the-fly cutout;
// others render nothing (the card simply omits the color panel). Extend as each
// field's tiles come online on Corral. Keys match SEARCH_FIELDS[].field.
const FITSGL_ROOT = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl";
export const FITSGL_BASE: Record<string, string> = {
  "CEERS":         `${FITSGL_ROOT}/ceers`,
  "GOODS-S":       `${FITSGL_ROOT}/goodss`,
  "GOODS-N":       `${FITSGL_ROOT}/goodsn`,
  "A2744":         `${FITSGL_ROOT}/a2744`,
  "NGDEEP":        `${FITSGL_ROOT}/ngdeep`,
  "PRIMER-COSMOS": `${FITSGL_ROOT}/primercosmos`,
  "PRIMER-UDS":    `${FITSGL_ROOT}/primeruds`,
  "EGS":           `${FITSGL_ROOT}/egs`,
  "COSMOS":        `${FITSGL_ROOT}/cosmos`,
};

// The default cutout field of view, arcsec (matches the retired static RGB stamp).
const DEFAULT_FOV_ARCSEC = 2.4;
// Rendered pixel size of the cutout (CSS px; the GL backing store is × devicePixelRatio).
const CUTOUT_PX = 200;

// Resolve `?data=<mirror>` for local testing: if a fitsgl mirror lives under the
// override at /fitsgl/<slug>, point there; else use the live Corral base. The slug is
// the last path segment of the live base (e.g. "ceers").
function resolveBase(field: string): string | null {
  const live = FITSGL_BASE[field];
  if (!live) return null;
  if (typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("data");
    if (o) {
      const slug = live.replace(/\/$/, "").split("/").pop();
      return `${o.replace(/\/$/, "")}/fitsgl/${slug}`;
    }
  }
  return live;
}

// Module-scoped cache: a field's resolved FitsglConfig + derived ViewerConfig +
// per-band trilogy stats are built at most once per session (a card reopen is instant).
type Prepared = {
  fitsgl: FitsglConfig;
  viewer: ViewerConfig;
  params: TrilogyParams;
  // Whether the derived view is a single band or the weighted multiband composite.
  single: boolean;
  // Per-band precomputed trilogy stats, in the SAME order the render source's bands are
  // built (view.bands for multiband, [view.band] for single) — exactly what
  // viewer.applyTrilogy() expects. null if any active band lacks precomputed stats.
  stats: TrilogyStats[] | null;
};
const _prepCache: Record<string, Prepared> = {};
const _prepPromise: Record<string, Promise<Prepared>> = {};

async function prepare(base: string): Promise<Prepared> {
  if (base in _prepCache) return _prepCache[base];
  if (base in _prepPromise) return _prepPromise[base];
  _prepPromise[base] = (async () => {
    const fitsgl = await loadFitsglConfig(`${base}/fitsgl.json`);
    const eb = explorerBandsFromConfig(fitsgl);
    const state = defaultExplorerState(eb, defaultViewFromConfig(fitsgl));
    const viewer = deriveViewerConfig(eb, state);
    // Trilogy knobs: producer's defaultView, overridden to CAMPFIRE's scaling
    // (noiselum 0.12 / satpercent 0.01 / noisesig 2) so our color matches campfire.
    const params: TrilogyParams = { ...DEFAULT_TRILOGY_PARAMS, ...state.trilogyParams, ...CAMPFIRE_TRILOGY };
    // Active band names, in render-source order, straight from the derived view.
    const v = viewer.view;
    const names =
      v.mode === "single" ? [v.band] : v.mode === "rgb" ? [v.r, v.g, v.b] : v.bands.map((b) => b.band);
    const raw = names.map((n) => eb.find((b) => b.name === n)?.trilogy);
    const stats = raw.every((s) => s !== undefined) ? (raw as TrilogyStats[]) : null;
    const prep: Prepared = { fitsgl, viewer, params, single: v.mode === "single", stats };
    _prepCache[base] = prep;
    return prep;
  })();
  try {
    return await _prepPromise[base];
  } catch (e) {
    delete _prepPromise[base]; // allow retry
    throw e;
  }
}

// Reproduce <FitsExplorer>'s `applyTrilogyFromStats`: drive the faithful, color-
// preserving trilogy from the producer's precomputed global per-band stats (no tile
// rescan), so the color matches the /data/map viewer exactly and is stable on the
// first paint. Returns false if the viewer mode hasn't settled or a band lacks stats.
function applyTrilogy(viewer: any, prep: Prepared): boolean {
  if (prep.stats === null) return false;
  const expectedMode = prep.single ? "single" : "multiband";
  if (viewer.sourceMode !== expectedMode) return false;
  viewer.applyTrilogy(prep.single ? prep.stats[0] : prep.stats, prep.params);
  viewer.setStretchMode("trilogy");
  return true;
}

type Status = "loading" | "ready" | "empty";

export function FitsglCutout({
  field,
  ra,
  dec,
  fovArcsec = DEFAULT_FOV_ARCSEC,
}: {
  field: string;
  ra: number;
  dec: number;
  fovArcsec?: number;
}) {
  const base = useMemo(() => resolveBase(field), [field]);
  const [status, setStatus] = useState<Status>(base ? "loading" : "empty");
  const [prep, setPrep] = useState<Prepared | null>(null);
  const handleRef = useRef<FitsViewerHandle | null>(null);
  // Latest target, read by the (construction-fixed) onFrame trampoline.
  const targetRef = useRef({ ra, dec, fovArcsec });
  targetRef.current = { ra, dec, fovArcsec };
  const placedRef = useRef(false);

  // Fetch + derive the field's config (cached). Nothing renders if the field has no
  // fitsgl tiles, or if the config fails to load (graceful — the card omits the panel).
  useEffect(() => {
    if (!base) {
      setStatus("empty");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setPrep(null);
    placedRef.current = false;
    prepare(base)
      .then((p) => {
        if (cancelled) return;
        setPrep(p);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`[cutout] ${field}: failed to load fitsgl config:`, err);
        setStatus("empty");
      });
    return () => {
      cancelled = true;
    };
  }, [base, field]);

  // Native pixel scale (arcsec/px) from the first band's grid; 0.03 for CEERS.
  const pixelScale = useMemo(() => {
    const g = prep?.fitsgl.dataset.bands[0]?.grid?.pixelScaleArcsec;
    return g && g > 0 ? g : 0.03;
  }, [prep]);

  // Center on the target sky position and zoom to the requested FOV. Called once the
  // viewer is up and again on the first drawn frame (the construction-time fitToImage
  // runs before onReady, so we must (re)assert our camera). Idempotent-ish: re-running
  // just re-sets the same center/zoom.
  const placeCamera = useCallback(() => {
    const h = handleRef.current;
    if (!h || !prep) return false;
    const viewer = h.getViewer();
    if (!viewer) return false;
    const wcs = viewer.getWcs();
    if (!wcs) return false;
    const t = targetRef.current;
    const px = skyToPix(wcs, t.ra, t.dec);
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return false;
    h.setCenter(px.x, px.y);
    // zoom = drawing-buffer px per native px. We want `fov` arcsec to span CUTOUT_PX
    // CSS px; native px across that fov = fov / pixelScale; zoom (CSS-px basis) = CSS
    // px / native px. (hiDpiLevels is off, so the level tracks the CSS zoom.)
    const nativeAcross = t.fovArcsec / pixelScale;
    if (nativeAcross > 0) h.setZoom(CUTOUT_PX / nativeAcross);
    return true;
  }, [prep, pixelScale]);

  const onReady = useCallback(
    (h: FitsViewerHandle) => {
      handleRef.current = h;
      const viewer = h.getViewer();
      if (viewer && prep) applyTrilogy(viewer, prep);
      placeCamera();
    },
    [prep, placeCamera]
  );

  // First drawn frame: re-assert the camera (survives construction fitToImage), retry
  // the trilogy if the mode wasn't settled at onReady, then reveal the canvas.
  const onFrame = useCallback(() => {
    if (!placedRef.current) {
      const viewer = handleRef.current?.getViewer();
      if (viewer && prep) applyTrilogy(viewer, prep);
      const ok = placeCamera();
      if (ok) {
        placedRef.current = true;
        setStatus("ready");
      }
    }
  }, [prep, placeCamera]);

  if (!base || status === "empty") return null;

  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "4px" }}>
        COLOR <span style={{ color: "var(--text-dim)" }}>(fitsgl · ~{fovArcsec.toFixed(1)}″)</span>
      </div>
      <div
        style={{
          position: "relative",
          width: CUTOUT_PX,
          height: CUTOUT_PX,
          border: "1px solid var(--border)",
          borderRadius: "6px",
          overflow: "hidden",
          background: "#0d0a1a",
        }}
      >
        {prep && (
          <FitsViewer
            ref={handleRef}
            config={prep.viewer}
            onReady={onReady}
            onFrame={onFrame}
            onError={(err) => {
              console.error(`[cutout] ${field}: FitsViewer error:`, err);
              setStatus("empty");
            }}
            style={{
              width: "100%",
              height: "100%",
              // Hidden until the first color frame has painted at the right position,
              // so the card never flashes the whole-field fit view or a blank canvas.
              opacity: status === "ready" ? 1 : 0,
              transition: "opacity 0.15s ease",
              // Purely a thumbnail: no pan/zoom interaction on the card.
              pointerEvents: "none",
            }}
          />
        )}
        {status === "loading" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                width: "22px",
                height: "22px",
                borderRadius: "50%",
                border: "3px solid rgba(196,144,216,0.25)",
                borderTopColor: "var(--accent)",
                animation: "unicorn-spin 0.9s linear infinite",
              }}
            />
          </div>
        )}
      </div>
      <style>{`@keyframes unicorn-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default FitsglCutout;
