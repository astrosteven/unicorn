"use client";
// Client-only WebGL viewer wrapper around @fitsgl/core's <FitsExplorer>. Loads the
// producer `fitsgl.json` for the CEERS tile pyramid, renders the interactive color
// map, and overlays our OWN source markers built from the site search index
// (public/searchindex/): every catalog source is positioned by RA/Dec, colored
// GREEN if SELECTED and YELLOW if not. When the index carries a per-object THETA
// (position angle), each source is drawn as a Kron ELLIPSE (a/b = A_IMAGE/B_IMAGE *
// KRON_RADIUS, PA = THETA_IMAGE — the exact parametrization unicorn_bioplots.pro's
// tvellipse uses) via a rotatable world-space polygon fitsgl REGION; without theta
// it falls back to a colored circle MARKER. A sidebar filters the shown set live.
//
// MUST stay client-only (WebGL2 + window): the route dynamic-imports it with
// { ssr: false }. @fitsgl/core@0.3.2 reads these v0.1.0-built tiles directly.
import { useEffect, useMemo, useRef, useState } from "react";
import { FitsExplorer, type FitsExplorerProps, type FitsViewerHandle } from "@fitsgl/core/react";
import { loadFitsglConfig, type FitsglConfig, type MarkerInput, type RegionInput } from "@fitsgl/core";
import {
  SEARCH_FIELDS,
  loadField,
  loadFilters,
  type FieldIndex,
  type NumCol,
} from "@/app/data/_card/objectCard";

type LoadState = "loading" | "ready" | "error";

const CEERS = SEARCH_FIELDS.find(f => f.field === "CEERS")!;

// Marker/region colors: selected sources green, everything else yellow (the demo ask).
const GREEN = "#43d17a";
const YELLOW = "#f2d43a";

// ---- Filter model ----------------------------------------------------------
export type MapFilters = {
  selectedOnly: boolean;
  zMin: number | null;
  zMax: number | null;
  magMin: number | null;
  magMax: number | null;
  magFilter: string;   // which band's mag the mag range applies to (e.g. "F277W")
};
export const DEFAULT_FILTERS: MapFilters = {
  selectedOnly: false, zMin: null, zMax: null, magMin: null, magMax: null, magFilter: "F277W",
};

// Number of polygon vertices used to approximate each Kron ellipse.
const ELLIPSE_SEGMENTS = 24;

type Overlay =
  | { kind: "regions"; regions: RegionInput[] }
  | { kind: "markers"; markers: MarkerInput[] };

// Build the drawable overlay from the field index (+ an optional mag column),
// applying the active filters. Returns fitsgl RegionInputs (rotatable world-sized
// ellipse polygons) when theta is present, else MarkerInputs (colored circles).
function buildOverlay(idx: FieldIndex, magCol: NumCol, f: MapFilters): Overlay {
  const n = idx.n;
  const sel = idx.selected, za = idx.za;
  const a = idx.a_image, b = idx.b_image, kr = idx.kron_radius;
  const x = idx.x, y = idx.y, theta = idx.theta ?? null;
  const useEllipse = theta != null && x != null && y != null && a != null && b != null && kr != null;

  const { zMin, zMax, magMin: mMin, magMax: mMax, selectedOnly } = f;

  const regions: RegionInput[] = [];
  const markers: MarkerInput[] = [];

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

    const color = isSel ? GREEN : YELLOW;
    const id = String(idx.id[i]);

    if (useEllipse && a![i] != null && b![i] != null && kr![i] != null && kr![i]! > 0) {
      // Kron ellipse: semi-axes a*kron, b*kron (detection px); PA = theta deg CCW
      // from the +x image axis. Emit as a world-space polygon so it scales with
      // zoom and rotates with the display orientation.
      const semiA = a![i]! * kr![i]!;
      const semiB = b![i]! * kr![i]!;
      const cx = x![i]!, cy = y![i]!;
      const th = (theta![i]! * Math.PI) / 180;
      const ct = Math.cos(th), st = Math.sin(th);
      const verts: { x: number; y: number }[] = [];
      for (let s = 0; s < ELLIPSE_SEGMENTS; s++) {
        const phi = (2 * Math.PI * s) / ELLIPSE_SEGMENTS;
        const ex = semiA * Math.cos(phi);
        const ey = semiB * Math.sin(phi);
        verts.push({ x: cx + ex * ct - ey * st, y: cy + ex * st + ey * ct });
      }
      regions.push({ id, worldVertices: verts, stroke: color, strokeWidth: 1.4, data: { id: idx.id[i] } });
    } else {
      markers.push({ id, ra: idx.ra[i], dec: idx.dec[i], shape: "circle", size: 9, color, edgeWidth: 1.6, data: { id: idx.id[i] } });
    }
  }

  return regions.length > 0 ? { kind: "regions", regions } : { kind: "markers", markers };
}

export default function MapViewer({
  configUrl,
  filters,
  onSourceClick,
  onCount,
}: {
  configUrl: string;
  filters: MapFilters;
  onSourceClick: (id: number) => void;
  /** Report how many sources are currently shown (for the sidebar readout). */
  onCount?: (n: number) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [idx, setIdx] = useState<FieldIndex | null>(null);
  const [magCol, setMagCol] = useState<NumCol>(null);

  const clickRef = useRef(onSourceClick);
  useEffect(() => { clickRef.current = onSourceClick; }, [onSourceClick]);
  const countRef = useRef(onCount);
  useEffect(() => { countRef.current = onCount; }, [onCount]);

  const handleRef = useRef<FitsViewerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Load our search index (positions, selected, za, geometry) once.
  useEffect(() => {
    let cancelled = false;
    loadField(CEERS)
      .then(({ idx }) => { if (!cancelled) setIdx(idx); })
      .catch(err => console.error("[map] failed to load search index:", err));
    return () => { cancelled = true; };
  }, []);

  // Resolve the mag column for the active band when a mag range is set. m277/m444
  // are in the base index; other bands come from the lazy filters file (flux -> mag).
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

  // Build the filtered overlay set. Memoized on index + mag column + filters.
  const overlay = useMemo<Overlay | null>(
    () => (idx ? buildOverlay(idx, magRangeActive ? magCol : null, filters) : null),
    [idx, magCol, filters, magRangeActive],
  );

  // Push the overlay into the viewer imperatively via the ref handle so a filter
  // change repacks without remounting the WebGL viewer.
  useEffect(() => {
    const h = handleRef.current;
    if (!h || !overlay) return;
    if (overlay.kind === "regions") {
      h.clearMarkers();
      h.setRegions(overlay.regions);
      countRef.current?.(overlay.regions.length);
    } else {
      h.clearRegions();
      h.setMarkers(overlay.markers);
      countRef.current?.(overlay.markers.length);
    }
  }, [overlay, state]);

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

  if (state === "loading" || !config) {
    return <MapMessage title="Loading color map…" body="Fetching tile pyramid + source catalog." spin />;
  }

  const explorerProps: FitsExplorerProps = {
    config,
    onMarkerClick: (e) => {
      const raw = e.marker.data?.id ?? e.marker.id;
      const id = Number(raw);
      if (Number.isFinite(id)) clickRef.current(id);
    },
    onError: (err) => {
      console.error("[map] FitsExplorer error:", err);
      setErrMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    },
    style: { width: "100%", height: "100%" },
  };

  return (
    <div ref={rootRef} style={{ width: "100%", height: "100%" }}>
      <FitsExplorer
        {...explorerProps}
        // onReady + onRegionClick are handled by the underlying <FitsViewer> and
        // forwarded by <FitsExplorer>; typed loosely because FitsExplorerProps does
        // not re-export them.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({
          onReady: (h: FitsViewerHandle) => { handleRef.current = h; },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onRegionClick: (e: any) => {
            const raw = e?.region?.data?.id ?? e?.region?.id;
            const id = Number(raw);
            if (Number.isFinite(id)) clickRef.current(id);
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)}
      />
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
