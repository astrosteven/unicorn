"use client";
// Explore — an interactive fitsgl WebGL color map of CEERS. Pan/zoom the NIRCam
// RGB mosaic; every catalog source is drawn as a clickable Kron-ellipse overlay
// (green = selected, yellow = not) that opens the SAME SED / P(z) ResultCard used by
// the Search page (shared app/data/_card module). A sidebar filters the shown set
// live, and a "go to" box recenters on an object ID or ra,dec.
//
// The WebGL viewer (window + WebGL2) is loaded client-only via next/dynamic with
// { ssr: false }, as required by this Next 16 static export (output: "export").
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  SEARCH_FIELDS,
  loadField,
  loadSpecz,
  fetchObject,
  ResultCard,
  type FieldConfig,
  type FieldIndex,
  type SourceResult,
} from "@/app/data/_card/objectCard";
import type { FitsViewerHandle } from "@fitsgl/core/react";
import { skyToPix } from "@fitsgl/core";
import { type MapFilters, DEFAULT_FILTERS, type CameraTarget } from "./MapViewer";
import { makePredicate } from "@/app/data/search/page";   // validate the on-map query box

// The viewer touches WebGL/window on import — must never render on the server.
const MapViewer = dynamic(() => import("./MapViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0a1a" }}>
      <span className="mono" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Loading viewer…</span>
    </div>
  ),
});

const FITSGL_ROOT = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl";
// Fields whose fitsgl tile pyramids are live on Corral. Add a prefix once its tiles
// are uploaded — the switcher + per-field overlay then work automatically.
const FITSGL_PREFIXES = ["ceers", "goodss", "goodsn", "a2744", "ngdeep", "primercosmos", "primeruds", "egs", "cosmos"];
const FITSGL_FIELDS: FieldConfig[] = SEARCH_FIELDS.filter(f => FITSGL_PREFIXES.includes(f.prefix));

// Bands offered in the magnitude-filter dropdown. F277W/F444W come straight from the
// base index; the rest resolve from the lazy per-band filters file on demand.
const MAG_BANDS = ["F277W", "F444W", "F090W", "F115W", "F150W", "F200W", "F356W", "F410M"];

// "Go to" recenter field of view: show a ~5" region around the target. The viewer's
// zoom is drawing-buffer px per native px, so the zoom that fits GOTO_FOV_ARCSEC across
// the viewer width W (buffer px) is  W / (fov_arcsec / pixscale).
const GOTO_FOV_ARCSEC = 5;       // manual "go to" box
const DEEPLINK_FOV_ARCSEC = 10;  // map↗ deep-link from search zooms to a ~10"×10" region
const PIXSCALE_ARCSEC = 0.03;   // 30 mas mosaics — native pixel scale of the fitsgl tiles

// Base URL for a field's fitsgl tiles: the ?data= mirror if set (…/fitsgl/<prefix>),
// else the public Corral fitsgl root.
function tileBase(field: FieldConfig): string {
  if (typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("data");
    if (o) return `${o.replace(/\/$/, "")}/fitsgl/${field.prefix}`;
  }
  return `${FITSGL_ROOT}/${field.prefix}`;
}

// Deep-link support: /data/map?field=<name|prefix>&id=<objid> opens that field and jumps
// to the object (used by the Search page's "map" column).
function initialField(): FieldConfig {
  if (typeof window !== "undefined") {
    const f = new URLSearchParams(window.location.search).get("field");
    if (f) {
      const fc = FITSGL_FIELDS.find(x => x.field === f || x.prefix === f.toLowerCase());
      if (fc) return fc;
    }
  }
  return FITSGL_FIELDS[0];
}
function initialGotoId(): string | null {
  return typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("id") : null;
}
// Optional ?fov=<arcsec> on a deep-link overrides the zoom region (e.g. the inspector opens
// a 5" view). Falls back to DEEPLINK_FOV_ARCSEC; clamped to a sane range.
function initialFov(): number {
  if (typeof window !== "undefined") {
    const f = parseFloat(new URLSearchParams(window.location.search).get("fov") || "");
    // Up to 30′ — a shared MSA-planning link zooms out to the whole focal plane (~a few arcmin),
    // well beyond the inspector's 5″ deep-links.
    if (Number.isFinite(f) && f > 0 && f <= 1800) return f;
  }
  return DEEPLINK_FOV_ARCSEC;
}

// ---- Search → map handoff ("view N on map") --------------------------------
// The Search page stashes the matched objects in localStorage["mapQueue"] (localStorage,
// not sessionStorage — it must survive the new tab). One queued object: which field it's
// on + its id + sky position (for the auto-fit bounding box). Read ONCE on load.
type QueuedObj = { field: string; id: number; ra: number | null; dec: number | null };
type MapQueue = { label: string; ts: number; objects: QueuedObj[] };
const MAP_QUEUE_MAX_AGE_MS = 60 * 60 * 1000;   // 1 h — stale handoffs are ignored

// Read + clear the queue. Only honoured when the URL carries ?queued=1 (so a plain
// /data/map visit never picks up a stale queue) and it isn't older than the max age.
function readMapQueue(): MapQueue | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  if (sp.get("queued") !== "1") return null;
  let raw: string | null = null;
  try { raw = localStorage.getItem("mapQueue"); localStorage.removeItem("mapQueue"); } catch { return null; }
  if (!raw) return null;
  try {
    const q = JSON.parse(raw) as MapQueue;
    if (!q || !Array.isArray(q.objects) || !q.objects.length) return null;
    if (typeof q.ts === "number" && Date.now() - q.ts > MAP_QUEUE_MAX_AGE_MS) return null;
    return q;
  } catch { return null; }
}

// The queued field to open: honour ?field= if it has any queued objects, else the field
// with the most queued objects. Returns null if none of the fitsgl fields are represented.
function queueTopField(q: MapQueue): FieldConfig | null {
  const counts = new Map<string, number>();
  for (const o of q.objects) if (o.field) counts.set(o.field, (counts.get(o.field) ?? 0) + 1);
  if (typeof window !== "undefined") {
    const want = new URLSearchParams(window.location.search).get("field");
    if (want) {
      const fc = FITSGL_FIELDS.find(x => x.field === want || x.prefix === want.toLowerCase());
      if (fc && counts.has(fc.field)) return fc;
    }
  }
  let best: FieldConfig | null = null, bestN = 0;
  for (const fc of FITSGL_FIELDS) {
    const n = counts.get(fc.field) ?? 0;
    if (n > bestN) { best = fc; bestN = n; }
  }
  return best;
}

// The queued id set for a given field (what MapViewer filters its overlay to).
function queueIdsForField(q: MapQueue | null, field: string): Set<number> | null {
  if (!q) return null;
  const ids = new Set<number>();
  for (const o of q.objects) if (o.field === field && Number.isFinite(o.id)) ids.add(o.id);
  return ids.size ? ids : null;
}

// ---- Upload → map: raw coordinate markers -----------------------------------
// The Upload tab (plot-as-is mode) stashes arbitrary sky coords in localStorage["mapRawMarkers"]
// for one field, and opens /data/map?field=<f>&raw=1. These are NOT catalog objects — MapViewer
// draws them as bright diamonds so an external target list can be planned against the footprints.
type RawMarkers = { field: string; ts: number; coords: [number, number][] };
function readRawMarkers(): RawMarkers | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  if (sp.get("raw") !== "1") return null;
  let raw: string | null = null;
  try { raw = localStorage.getItem("mapRawMarkers"); localStorage.removeItem("mapRawMarkers"); } catch { return null; }
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as RawMarkers;
    if (!m || !Array.isArray(m.coords) || !m.coords.length) return null;
    if (typeof m.ts === "number" && Date.now() - m.ts > MAP_QUEUE_MAX_AGE_MS) return null;
    return m;
  } catch { return null; }
}
// Shared MSA-planning link (from the footprints panel's Share button): PA, which overlays are on
// (ov=field,msa,ifu), the fixed slit rotated about, the exact pointing (aptra/aptdec), the shown
// instrument footprints (fp), plus mq= for the left query. Read once on load → initialMsa.
type InitialMsa = { pa?: number; msa?: boolean; ifu?: boolean; field?: boolean; slit?: string; aptra?: number; aptdec?: number; fp?: string[] };
function readInitialMsa(): InitialMsa | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  if (!(sp.has("pa") || sp.has("ov") || sp.has("slit") || sp.has("aptra"))) return null;
  const ov = (sp.get("ov") || "").split(",").map(s => s.trim());
  const num = (k: string) => { const v = parseFloat(sp.get(k) || ""); return Number.isFinite(v) ? v : undefined; };
  return {
    pa: num("pa"), field: ov.includes("field"), msa: ov.includes("msa"), ifu: ov.includes("ifu"),
    slit: sp.get("slit") || undefined, aptra: num("aptra"), aptdec: num("aptdec"),
    fp: (sp.get("fp") || "").split(",").map(s => s.trim()).filter(Boolean),
  };
}
// Restore the full filter state from a shared link (query + z/mag sliders + selected-only).
function readSharedFilters(): MapFilters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  const sp = new URLSearchParams(window.location.search);
  const n = (k: string): number | null => { const v = parseFloat(sp.get(k) || ""); return Number.isFinite(v) ? v : null; };
  return {
    ...DEFAULT_FILTERS,
    query: sp.get("mq") || "",
    selectedOnly: sp.get("sel") === "1",
    zMin: n("zmin"), zMax: n("zmax"), magMin: n("magmin"), magMax: n("magmax"),
    magFilter: sp.get("magfilt") || DEFAULT_FILTERS.magFilter,
  };
}

function rawFieldConfig(m: RawMarkers | null): FieldConfig | null {
  if (!m) return null;
  return FITSGL_FIELDS.find(x => x.field === m.field || x.prefix === m.field.toLowerCase()) ?? null;
}

type PanelState =
  | { kind: "hidden" }
  | { kind: "loading"; id: number }
  | { kind: "found"; id: number; src: SourceResult }
  | { kind: "notfound"; id: number };

export default function MapPage() {
  // Search → map handoff: read (and clear) the queued matched objects once, before first
  // render, so the initial field + overlay filter come up already narrowed to the query.
  const mapQueueRef = useRef<MapQueue | null>(null);
  if (mapQueueRef.current === null && typeof window !== "undefined" && !("__mapQueueRead" in mapQueueRef)) {
    (mapQueueRef as { __mapQueueRead?: boolean }).__mapQueueRead = true;
    mapQueueRef.current = readMapQueue();
  }
  // Upload → map: raw coordinate markers (read + cleared once, like the queue).
  const rawRef = useRef<RawMarkers | null>(null);
  if (rawRef.current === null && typeof window !== "undefined" && !("__rawRead" in rawRef)) {
    (rawRef as { __rawRead?: boolean }).__rawRead = true;
    rawRef.current = readRawMarkers();
  }
  const initialActive = (): FieldConfig =>
    rawFieldConfig(rawRef.current) ??
    queueTopField(mapQueueRef.current ?? { label: "", ts: 0, objects: [] }) ?? initialField();

  const [activeField, setActiveField] = useState<FieldConfig>(initialActive);
  // Only honour the queue while the user hasn't cleared it via "show all".
  const [queueOn, setQueueOn] = useState<boolean>(() => mapQueueRef.current != null);
  // The queued id set for the ACTIVE field — MapViewer filters its overlay to just these.
  // Re-derived whenever the active field or the on/off toggle changes.
  const queuedIds = useMemo<Set<number> | null>(
    () => (queueOn ? queueIdsForField(mapQueueRef.current, activeField.field) : null),
    [queueOn, activeField],
  );
  // Whether the CURRENT field has any queued objects (drives the banner + auto-fit).
  const queuedHereRef = useRef<Set<number> | null>(null);
  queuedHereRef.current = queueIdsForField(mapQueueRef.current, activeField.field);

  // Raw uploaded markers for the ACTIVE field (null on other fields).
  const rawMarkers = useMemo<[number, number][] | null>(() => {
    const fc = rawFieldConfig(rawRef.current);
    return fc && fc.field === activeField.field ? rawRef.current!.coords : null;
  }, [activeField]);

  // Campfire spec-z ids for the active field: ellipses with a spec-z draw green. Loaded
  // from the same per-field sidecar the cards use (cached); null until it lands / if absent.
  const [zspecIds, setZspecIds] = useState<Set<number> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setZspecIds(null);
    loadSpecz(activeField)
      .then(map => {
        if (cancelled) return;
        const ids = new Set<number>();
        for (const k in map) if (map[k]?.z != null) ids.add(Number(k));
        setZspecIds(ids.size ? ids : null);
      })
      .catch(() => { if (!cancelled) setZspecIds(null); });
    return () => { cancelled = true; };
  }, [activeField]);

  const configUrl = useMemo(() => `${tileBase(activeField)}/fitsgl.json`, [activeField]);
  const pendingGotoRef = useRef<string | null>(initialGotoId());
  // The deep-linked object (?id=) is the "primary" — MapViewer boxes it in white so it stays
  // identifiable at any zoom. Only when arriving with a numeric ?id= (a map↗ from a source).
  const primaryId = useMemo(() => {
    const g = initialGotoId();
    const n = g ? parseInt(g, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }, []);
  const deeplinkFov = initialFov();   // ?fov= override (e.g. inspector's 5" link), else default
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<PanelState>({ kind: "hidden" });
  // Init the full filter state from a shared link so the recipient sees the same filtered sources.
  const [filters, setFilters] = useState<MapFilters>(readSharedFilters);
  // Shared MSA-planning setup to restore (PA/overlays/slit/pointing/footprints), read once.
  const initialMsa = useMemo(() => readInitialMsa(), []);
  // Safety-net: re-apply a shared link's filters after mount (covers the static-prerender case where
  // the useState initializer above ran with window undefined → defaults). Only if still at defaults.
  useEffect(() => {
    const s = readSharedFilters();
    if (s.query || s.selectedOnly || s.zMin != null || s.zMax != null || s.magMin != null || s.magMax != null) {
      setFilters(f => (f.query || f.selectedOnly || f.zMin != null || f.zMax != null ? f : s));
    }
  }, []);
  const [shown, setShown] = useState<number | null>(null);
  const [gotoMsg, setGotoMsg] = useState<string>("");
  // Narrow screens (phones): the 220px filter sidebar eats most of the width, so collapse it into
  // a toggle-drawer and let the map viewer go full-width.
  const [narrow, setNarrow] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Viewer handle + loaded index, captured once ready — drives the "go to" control.
  const handleRef = useRef<FitsViewerHandle | null>(null);
  const idxRef = useRef<FieldIndex | null>(null);
  const viewerBoxRef = useRef<HTMLDivElement | null>(null);  // measured for the go-to FOV
  // Camera target the viewer must adopt AND HOLD (world px + zoom). handleGoto writes it;
  // MapViewer re-asserts it every frame until held, so a deep-link goto survives the
  // viewer's tile-load auto-fit (the bug where a single setCenter/setZoom didn't stick).
  const cameraTargetRef = useRef<CameraTarget | null>(null);
  const onReadyHandle = useCallback((h: FitsViewerHandle, idx: FieldIndex) => {
    handleRef.current = h;
    idxRef.current = idx;
    setReady(true);
  }, []);

  const openSource = useCallback(async (id: number) => {
    setPanel({ kind: "loading", id });
    try {
      const { zg } = await loadField(activeField);
      const src = await fetchObject(activeField, id, zg);
      setPanel(prev => {
        if (prev.kind === "hidden" || prev.id !== id) return prev;
        return src ? { kind: "found", id, src } : { kind: "notfound", id };
      });
    } catch {
      setPanel(prev => (prev.kind !== "hidden" && prev.id === id ? { kind: "notfound", id } : prev));
    }
  }, [activeField]);

  // "Go to": recenter + zoom on an object ID, or an "ra,dec" (decimal deg) pair.
  // Recenter + zoom on an ID or "ra,dec". Returns false ONLY for transient
  // not-ready conditions (viewer/index/WCS still loading) so a deep-link can retry;
  // returns true on success or a definitive error (bad input / not found).
  const handleGoto = useCallback((raw: string, fovArcsec: number = GOTO_FOV_ARCSEC): boolean => {
    const h = handleRef.current;
    const idx = idxRef.current;
    setGotoMsg("");
    const s = raw.trim();
    if (!s) return true;
    if (!h) { setGotoMsg("viewer not ready"); return false; }   // retry

    let ra: number | null = null, dec: number | null = null;

    if (/[ ,]/.test(s)) {
      // ra,dec (comma or whitespace separated)
      const parts = s.split(/[ ,]+/).map(Number);
      if (parts.length >= 2 && parts.every(Number.isFinite)) { ra = parts[0]; dec = parts[1]; }
      else { setGotoMsg("couldn't parse ra,dec"); return true; }
    } else {
      // Bare integer → object ID; look up its ra/dec in the index.
      const id = Number(s);
      if (!Number.isInteger(id)) { setGotoMsg("enter an ID or ra,dec"); return true; }
      if (!idx) { setGotoMsg("index not loaded yet"); return false; }   // retry
      const pos = idx.id.indexOf(id);
      if (pos < 0) { setGotoMsg(`ID ${id} not found`); return true; }
      ra = idx.ra[pos]; dec = idx.dec[pos];
    }

    if (ra == null || dec == null || !Number.isFinite(ra) || !Number.isFinite(dec)) {
      setGotoMsg("no position for target"); return true;
    }
    const wcs = h.getViewer()?.getWcs();
    if (!wcs) { setGotoMsg("viewer not ready"); return false; }   // retry — WCS not up yet
    const px = skyToPix(wcs, ra, dec);
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) { setGotoMsg("target off the projection"); return true; }
    // Zoom so the target spans ~fovArcsec across the viewer (buffer px per native px).
    const cssW = viewerBoxRef.current?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1000);
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const fovNativePx = fovArcsec / PIXSCALE_ARCSEC;   // ~333 px for 10"
    const zoom = (cssW * dpr) / fovNativePx;
    // Hand the target to MapViewer's frame loop rather than setting the camera directly,
    // so it is re-asserted until held and can't be clobbered by the viewer's auto-fit.
    // Re-assert for a fixed window so tile-load auto-fits can't clobber it (see MapViewer).
    cameraTargetRef.current = { cx: px.x, cy: px.y, zoom, until: Date.now() + 4000 };
    h.setCenter(px.x, px.y);
    h.setZoom(zoom);
    setGotoMsg(`→ ${ra.toFixed(5)}, ${dec.toFixed(5)}`);
    return true;
  }, []);

  // Deep-link (?id=…): jump to the object at ~10"×10" once the viewer is ready. The
  // viewer's WCS can lag the `ready` signal (esp. big fields), so retry until it lands.
  useEffect(() => {
    if (!ready || !pendingGotoRef.current) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const g = pendingGotoRef.current;
      if (!g) return;
      if (handleGoto(g, deeplinkFov)) { pendingGotoRef.current = null; return; }
      if (++tries < 30) timer = setTimeout(tick, 200);   // up to ~6 s for tiles/WCS
      else pendingGotoRef.current = null;
    };
    timer = setTimeout(tick, 150);
    return () => clearTimeout(timer);
  }, [ready, handleGoto, deeplinkFov]);

  // Auto-fit the view to the bounding box of the ACTIVE field's queued objects (the
  // search → map handoff). Runs once the viewer/WCS are up; re-runs when the active field
  // changes (each field fits to its own queued subset). Projects every queued object's
  // ra/dec → world px via the viewer WCS, takes the bbox, and hands a centre+zoom to the
  // same cameraTargetRef the "go to"/deep-link use (so it survives the tile-load auto-fit).
  // Skipped while a ?id= deep-link is pending (that takes precedence) or after "show all".
  const fitToQueued = useCallback((): boolean => {
    if (!queueOn) return true;                       // cleared via "show all" — nothing to fit
    const ids = queuedHereRef.current;
    if (!ids || !ids.size) return true;              // no queued objects on this field
    const q = mapQueueRef.current;
    if (!q) return true;
    const h = handleRef.current;
    if (!h) return false;                            // viewer not ready — retry
    const wcs = h.getViewer()?.getWcs();
    if (!wcs) return false;                          // WCS not up yet — retry
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const o of q.objects) {
      if (o.field !== activeField.field) continue;
      if (o.ra == null || o.dec == null || !Number.isFinite(o.ra) || !Number.isFinite(o.dec)) continue;
      const p = skyToPix(wcs, o.ra, o.dec);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      n++;
    }
    if (!n) return true;                             // no positions to fit
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // Span the bbox with ~12% padding; ensure a sensible floor (~a few arcsec) for a
    // single object or a tight clump so we don't zoom absurdly deep.
    const spanX = Math.max(maxX - minX, 0), spanY = Math.max(maxY - minY, 0);
    const minNativePx = 5 / PIXSCALE_ARCSEC;         // ≥ ~5" field for a lone/tight set
    const fitX = Math.max(spanX * 1.24, minNativePx);
    const fitY = Math.max(spanY * 1.24, minNativePx);
    const box = viewerBoxRef.current;
    const cssW = box?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1000);
    const cssH = box?.clientHeight ?? (typeof window !== "undefined" ? window.innerHeight : 700);
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    // zoom = drawing-buffer px per native px; fit BOTH axes (take the tighter).
    const zoom = Math.min((cssW * dpr) / fitX, (cssH * dpr) / fitY);
    if (!Number.isFinite(zoom) || zoom <= 0) return true;
    cameraTargetRef.current = { cx, cy, zoom, until: Date.now() + 4000 };
    h.setCenter(cx, cy);
    h.setZoom(zoom);
    return true;
  }, [queueOn, activeField]);

  // Drive the auto-fit once ready, retrying until the WCS lands (mirrors the deep-link).
  // A pending ?id= deep-link wins, so don't fit while one is queued.
  useEffect(() => {
    if (!ready || !queueOn || pendingGotoRef.current) return;
    if (!queuedHereRef.current?.size) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (fitToQueued()) return;
      if (++tries < 30) timer = setTimeout(tick, 200);
    };
    timer = setTimeout(tick, 150);
    return () => clearTimeout(timer);
  }, [ready, queueOn, activeField, fitToQueued]);

  // Same auto-fit, for raw uploaded markers (plot-as-is upload has no queue).
  const fitToRaw = useCallback((): boolean => {
    const coords = rawMarkers;
    if (!coords || !coords.length) return true;
    const h = handleRef.current;
    if (!h) return false;
    const wcs = h.getViewer()?.getWcs();
    if (!wcs) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const [ra, dec] of coords) {
      if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
      const p = skyToPix(wcs, ra, dec);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      n++;
    }
    if (!n) return true;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, 0), spanY = Math.max(maxY - minY, 0);
    const minNativePx = 5 / PIXSCALE_ARCSEC;
    const fitX = Math.max(spanX * 1.24, minNativePx), fitY = Math.max(spanY * 1.24, minNativePx);
    const box = viewerBoxRef.current;
    const cssW = box?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1000);
    const cssH = box?.clientHeight ?? (typeof window !== "undefined" ? window.innerHeight : 700);
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const zoom = Math.min((cssW * dpr) / fitX, (cssH * dpr) / fitY);
    if (!Number.isFinite(zoom) || zoom <= 0) return true;
    cameraTargetRef.current = { cx, cy, zoom, until: Date.now() + 4000 };
    h.setCenter(cx, cy);
    h.setZoom(zoom);
    return true;
  }, [rawMarkers]);

  useEffect(() => {
    if (!ready || !rawMarkers?.length || pendingGotoRef.current) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (fitToRaw()) return;
      if (++tries < 30) timer = setTimeout(tick, 200);
    };
    timer = setTimeout(tick, 150);
    return () => clearTimeout(timer);
  }, [ready, rawMarkers, fitToRaw]);

  const panelOpen = panel.kind !== "hidden";
  const queuedShownHere = queueOn ? (queuedHereRef.current?.size ?? 0) : 0;

  return (
    <main style={{ height: "calc(100dvh - 64px)", display: "flex", flexDirection: "column" }}>
      {/* Header strip + go-to */}
      <div style={{ padding: "1rem 1.5rem 0.75rem", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "2px" }}>
              <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", margin: 0 }}>
                Explore
              </h1>
              <select
                aria-label="Field"
                value={activeField.field}
                onChange={e => {
                  const f = FITSGL_FIELDS.find(x => x.field === e.target.value);
                  if (f) { setActiveField(f); setPanel({ kind: "hidden" }); setGotoMsg(""); cameraTargetRef.current = null; }
                }}
                style={{
                  background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
                  color: "var(--accent)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem",
                  fontWeight: 700, letterSpacing: "0.04em", padding: "4px 10px", cursor: "pointer",
                }}
              >
                {FITSGL_FIELDS.map(f => <option key={f.field} value={f.field}>{f.field}</option>)}
              </select>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
              Interactive NIRCam color map. Pan and zoom the mosaic; click a source
              (<span style={{ color: "#43d17a" }}>green = spec-z</span>,{" "}
              <span style={{ color: "#f2d43a" }}>yellow = selected</span>,{" "}
              <span style={{ color: "#e0503a" }}>red = not selected</span>) to open its SED and P(z).
              Filter at left; jump to a source at right.
            </p>
          </div>
          <GotoBox onGo={handleGoto} msg={gotoMsg} />
        </div>

        {/* Search → map handoff banner: only the queried objects' Kron ellipses are drawn
            on the active field. "Show all" drops the filter (no reload) and reveals every
            source. Shown while the queue is active and this field has queued objects. */}
        {queueOn && queuedShownHere > 0 && (
          <div style={{
            marginTop: "0.7rem", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
            background: "rgba(196,144,216,0.10)", border: "1px solid var(--border-bright)",
            borderRadius: "6px", padding: "7px 12px",
          }}>
            <span className="mono" style={{ fontSize: "0.76rem", color: "var(--accent)", letterSpacing: "0.03em" }}>
              ▸ showing {queuedShownHere.toLocaleString()} queried object{queuedShownHere === 1 ? "" : "s"} on {activeField.field}
            </span>
            {mapQueueRef.current?.label && (
              <span className="mono" title="the search query these came from"
                style={{ fontSize: "0.68rem", color: "var(--text-dim)", maxWidth: "42ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mapQueueRef.current.label}
              </span>
            )}
            <button
              onClick={() => setQueueOn(false)}
              className="mono"
              title="Drop the query filter and show every source in this field (no reload)"
              style={{
                marginLeft: "auto", background: "none", border: "1px solid var(--border-bright)",
                borderRadius: "5px", color: "var(--text-muted)", cursor: "pointer",
                fontSize: "0.7rem", padding: "5px 11px",
              }}
            >
              show all
            </button>
          </div>
        )}
      </div>

      {/* Sidebar + viewer + card panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {/* Wide screens: sidebar inline. Phones: a slide-in drawer toggled by the ☰ button over
            the map, so the viewer keeps the full width. */}
        {!narrow && <FilterSidebar filters={filters} setFilters={setFilters} shown={shown} />}
        {narrow && filtersOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex" }}>
            <div style={{ position: "relative", zIndex: 1, maxWidth: "82%", overflowY: "auto", background: "var(--bg)", boxShadow: "12px 0 40px rgba(0,0,0,0.5)" }}>
              <FilterSidebar filters={filters} setFilters={setFilters} shown={shown} />
            </div>
            <div onClick={() => setFiltersOpen(false)} style={{ flex: 1, background: "rgba(0,0,0,0.4)" }} />
          </div>
        )}

        <div ref={viewerBoxRef} style={{ flex: 1, minWidth: 0, position: "relative", background: "#0d0a1a" }}>
          {narrow && !filtersOpen && (
            <button
              onClick={() => setFiltersOpen(true)}
              className="mono"
              style={{
                position: "absolute", top: 10, left: 10, zIndex: 16,
                background: "rgba(13,10,26,0.86)", border: "1px solid var(--border-bright)",
                borderRadius: 6, color: "var(--text)", cursor: "pointer", fontSize: "0.72rem", padding: "7px 11px",
              }}
            >
              ☰ Filters
            </button>
          )}
          <MapViewer
            key={activeField.field}
            field={activeField}
            configUrl={configUrl}
            filters={filters}
            queuedIds={queuedIds}
            zspecIds={zspecIds}
            onSourceClick={openSource}
            onCount={setShown}
            onReadyHandle={onReadyHandle}
            cameraTargetRef={cameraTargetRef}
            primaryId={primaryId}
            rawMarkers={rawMarkers}
            initialMsa={initialMsa}
          />
        </div>

        {/* Source card side panel — slides in over the map's right edge. */}
        {panelOpen && (
          <aside style={{
            width: "min(520px, 92vw)", flexShrink: 0,
            borderLeft: "1px solid var(--border)", background: "var(--bg)", overflowY: "auto",
            position: "absolute", right: 0, top: 0, bottom: 0,
            boxShadow: "-12px 0 40px rgba(0,0,0,0.45)", zIndex: 20,
          }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)",
              position: "sticky", top: 0, background: "var(--bg)", zIndex: 1,
            }}>
              <span className="mono" style={{ fontSize: "0.8rem", color: "var(--accent)", letterSpacing: "0.06em" }}>
                {activeField.field} · ID {panel.id}
              </span>
              <button
                onClick={() => setPanel({ kind: "hidden" })}
                aria-label="Close"
                style={{
                  background: "none", border: "1px solid var(--border-bright)", borderRadius: "5px",
                  color: "var(--text-muted)", cursor: "pointer", fontSize: "0.9rem", lineHeight: 1, padding: "5px 10px",
                }}
              >
                ✕ Close
              </button>
            </div>
            <div style={{ padding: "1rem" }}>
              {panel.kind === "loading" && (
                <div style={{ padding: "2.5rem 1rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.85rem" }}>
                  Loading source {panel.id}…
                </div>
              )}
              {panel.kind === "notfound" && (
                <div className="card" style={{
                  padding: "1.25rem", borderLeft: "3px solid var(--amber)",
                  background: "rgba(240,192,112,0.05)", color: "var(--text-muted)", fontSize: "0.85rem",
                }}>
                  <span className="mono" style={{ color: "var(--amber)", marginRight: "10px", fontSize: "0.75rem" }}>NO CARD</span>
                  No object card is available for {activeField.field} ID {panel.id}. (Per-object cards are served from Corral;
                  when previewing a local tile server with <code>?data=</code>, cards may be unavailable.)
                </div>
              )}
              {panel.kind === "found" && <ResultCard src={panel.src} />}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

// ---- "Go to" control -------------------------------------------------------
function GotoBox({ onGo, msg }: { onGo: (v: string) => void; msg: string }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: "260px" }}>
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onGo(val); }}
          placeholder="Go to: object ID  or  ra,dec"
          aria-label="Go to object ID or ra,dec"
          style={{
            flex: 1, background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
            color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem", padding: "6px 9px",
          }}
        />
        <button
          onClick={() => onGo(val)}
          className="mono"
          style={{
            background: "var(--accent-dim)", border: "1px solid rgba(196,144,216,0.35)", borderRadius: "5px",
            color: "var(--accent)", cursor: "pointer", fontSize: "0.78rem", padding: "6px 12px",
          }}
        >
          Go
        </button>
      </div>
      {msg && <span className="mono" style={{ fontSize: "0.68rem", color: msg.startsWith("→") ? "var(--green)" : "var(--amber)" }}>{msg}</span>}
    </div>
  );
}

// ---- Filter sidebar --------------------------------------------------------
function FilterSidebar({
  filters, setFilters, shown,
}: {
  filters: MapFilters;
  setFilters: React.Dispatch<React.SetStateAction<MapFilters>>;
  shown: number | null;
}) {
  const num = (s: string): number | null => (s.trim() === "" ? null : (Number.isFinite(+s) ? +s : null));
  const patch = (p: Partial<MapFilters>) => setFilters(f => ({ ...f, ...p }));
  // Controlled query text, committed on blur/Enter (so we don't re-filter every keystroke). Synced
  // from filters.query so a shared link's restored query — and the Reset button — show in the box.
  const [qLocal, setQLocal] = useState(filters.query);
  useEffect(() => { setQLocal(filters.query); }, [filters.query]);

  const labelStyle: React.CSSProperties = { fontSize: "0.68rem", color: "var(--text-dim)", letterSpacing: "0.04em", marginBottom: "4px", textTransform: "uppercase" };
  const inputStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
    color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem", padding: "6px 8px",
  };

  return (
    <aside style={{
      width: "220px", flexShrink: 0, borderRight: "1px solid var(--border)",
      background: "var(--bg)", overflowY: "auto", padding: "1rem 0.9rem",
    }}>
      <div className="mono" style={{ fontSize: "0.72rem", color: "var(--accent)", letterSpacing: "0.08em", marginBottom: "1rem" }}>
        FILTERS
      </div>

      {/* Free-form query — same language as the Search page, applied live to the shown sources
          AND the "sources in the MSA quadrants" list (for NIRSpec MSA planning). */}
      <div style={{ marginBottom: "1.2rem" }}>
        <div style={labelStyle}>Query <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }}>za · zspec · m444 · mabs…</span></div>
        <textarea
          value={qLocal}
          onChange={e => setQLocal(e.target.value)}
          onBlur={() => patch({ query: qLocal })}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); patch({ query: qLocal }); } }}
          placeholder="za > 8 and zspec = none"
          rows={2}
          style={{ ...inputStyle, resize: "vertical", minHeight: "42px", fontSize: "0.74rem" }}
        />
        {(() => {
          const q = filters.query.trim();
          if (!q) return <div style={{ fontSize: "0.63rem", color: "var(--text-dim)", marginTop: "3px", lineHeight: 1.45 }}>Filters the shown sources + the in-MSA list. Base columns only (za, zspec, m277/m444, mabs, beta, chia, selected).</div>;
          const r = makePredicate(q);
          return "error" in r
            ? <div className="mono" style={{ fontSize: "0.66rem", color: "var(--red)", marginTop: "3px", lineHeight: 1.4 }}>{r.error}</div>
            : <div className="mono" style={{ fontSize: "0.66rem", color: "#43d17a", marginTop: "3px" }}>✓ filtering</div>;
        })()}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "1.1rem" }}>
        <input
          type="checkbox"
          checked={filters.selectedOnly}
          onChange={e => patch({ selectedOnly: e.target.checked })}
          style={{ accentColor: "#43d17a", width: "15px", height: "15px" }}
        />
        <span style={{ fontSize: "0.8rem", color: "var(--text)" }}>Selected only</span>
      </label>

      <div style={{ marginBottom: "1.1rem" }}>
        <div style={labelStyle}>Redshift z_a</div>
        <div style={{ display: "flex", gap: "6px" }}>
          <input style={inputStyle} inputMode="decimal" placeholder="min"
            defaultValue={filters.zMin ?? ""} onBlur={e => patch({ zMin: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ zMin: num((e.target as HTMLInputElement).value) }); }} />
          <input style={inputStyle} inputMode="decimal" placeholder="max"
            defaultValue={filters.zMax ?? ""} onBlur={e => patch({ zMax: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ zMax: num((e.target as HTMLInputElement).value) }); }} />
        </div>
      </div>

      <div style={{ marginBottom: "1.1rem" }}>
        <div style={labelStyle}>Magnitude (AB)</div>
        <select
          value={filters.magFilter}
          onChange={e => patch({ magFilter: e.target.value })}
          style={{ ...inputStyle, marginBottom: "6px", cursor: "pointer" }}
        >
          {MAG_BANDS.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <div style={{ display: "flex", gap: "6px" }}>
          <input style={inputStyle} inputMode="decimal" placeholder="min"
            defaultValue={filters.magMin ?? ""} onBlur={e => patch({ magMin: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ magMin: num((e.target as HTMLInputElement).value) }); }} />
          <input style={inputStyle} inputMode="decimal" placeholder="max"
            defaultValue={filters.magMax ?? ""} onBlur={e => patch({ magMax: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ magMax: num((e.target as HTMLInputElement).value) }); }} />
        </div>
      </div>

      <button
        onClick={() => setFilters(DEFAULT_FILTERS)}
        className="mono"
        style={{
          background: "none", border: "1px solid var(--border-bright)", borderRadius: "5px",
          color: "var(--text-muted)", cursor: "pointer", fontSize: "0.72rem", padding: "6px 10px", width: "100%",
        }}
      >
        Reset
      </button>

      <div style={{ marginTop: "1.4rem", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid #43d17a", display: "inline-block" }} />
          spec-z
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid #f2d43a", display: "inline-block" }} />
          selected
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid #e0503a", display: "inline-block" }} />
          not selected
        </div>
        {shown != null && (
          <div className="mono" style={{ marginTop: "10px", color: "var(--text-dim)" }}>
            {shown.toLocaleString()} match
          </div>
        )}
      </div>
    </aside>
  );
}
