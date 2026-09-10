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
import {
  loadFitsglConfig,
  skyToPix,
  pixToSky,
  angularSeparationDeg,
  DEFAULT_TRILOGY_PARAMS,
  type FitsglConfig,
  type ViewerConfig,
  type TrilogyParams,
  type TrilogyStats,
  type StretchMode,
} from "@fitsgl/core";
import {
  loadField,
  loadFilters,
  type FieldConfig,
  type FieldIndex,
  type NumCol,
} from "@/app/data/_card/objectCard";
import { supabase } from "@/lib/supabase";
import { measureAperture } from "@/lib/photometry";
import PhotometryPanel, { type PhotState } from "./PhotometryPanel";

type LoadState = "loading" | "ready" | "error";

// Overlay colors (priority): a campfire spec-z → green; else selected → yellow;
// else not selected → red.
const GREEN = "#43d17a";   // has a campfire spec-z
const YELLOW = "#f2d43a";  // selected (no spec-z)
const RED = "#e0503a";     // not selected
// Custom-aperture photometry draw tool: the drawn circle's stroke colour.
const CYAN = "#38d0f0";

// Default trilogy scaling — the CAMPFIRE values (campfire.hollisakins.com) the map
// ships with; the scaling panel starts here and "Reset to default" returns here. Same
// knobs FitsglCutout's CAMPFIRE_TRILOGY uses so the map matches the card cutouts.
const CAMPFIRE_TRILOGY: TrilogyParams = {
  ...DEFAULT_TRILOGY_PARAMS,
  noiselum: 0.12,
  satpercent: 0.01,
  noisesig: 2.0,
  noisesig0: 2.0,
};

// The scaling knobs surfaced in the panel, with drag range + step. These four are the
// trilogy params that actually change the look (see @fitsgl/core TrilogyParams docs):
//  noiselum   — output luminance the noise floor maps to (noise-floor brightness)
//  noisesig   — where the noise level is anchored: x1 = mean + noisesig*sigma (contrast)
//  satpercent — % of pixels allowed to saturate; the white point (log-ish, so a log slider)
//  noisesig0  — black point below the sky: x0 = mean - noisesig0*sigma
type Knob = {
  key: keyof TrilogyParams;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  log?: boolean;        // slider position is log10-spaced across [min,max]
  trilogyOnly?: boolean; // only shapes the trilogy curve (ignored by linear/log/sqrt/asinh)
};
// The trilogy params set each band's normalization interval [x0,x2] (black/white points)
// via applyTrilogy — the multiband shader then applies the SELECTED transfer curve
// (u_stretchMode) over that interval. So noisesig/satpercent/noisesig0 shape the levels
// for EVERY mode; noiselum only solves the trilogy softening K, so it is trilogy-only.
const SCALING_KNOBS: Knob[] = [
  { key: "noiselum", label: "Noise floor", hint: "brightness of the sky/noise (trilogy)", min: 0, max: 0.4, step: 0.005, trilogyOnly: true },
  { key: "noisesig", label: "Contrast", hint: "noise anchor · mean + n·σ", min: 0.5, max: 4, step: 0.05 },
  { key: "satpercent", label: "White point", hint: "% pixels saturated", min: 0.001, max: 1, step: 0.001, log: true },
  { key: "noisesig0", label: "Black point", hint: "sky floor · mean − n·σ", min: 1, max: 3, step: 0.05 },
];

// Every transfer curve @fitsgl/core supports (StretchMode). trilogy is the campfire
// default; the others reuse the same per-band black/white points and just swap the curve
// applied on top (u_stretchMode) — no tile rescan, no camera move.
const STRETCH_MODE_OPTS: { mode: StretchMode; label: string; hint: string }[] = [
  { mode: "trilogy", label: "Trilogy", hint: "Coe faithful log (campfire default)" },
  { mode: "log",     label: "Log",     hint: "astropy LogStretch (a=1000)" },
  { mode: "asinh",   label: "Asinh",   hint: "astropy AsinhStretch (a=0.1)" },
  { mode: "sqrt",    label: "Sqrt",    hint: "square-root" },
  { mode: "linear",  label: "Linear",  hint: "identity" },
];
const DEFAULT_STRETCH_MODE: StretchMode = "trilogy";

// Cap on drawn overlay glyphs per frame — the viewport cull keeps only what's visible,
// and this bounds the SVG node count so pan/zoom stays smooth even zoomed all the way
// out over the whole 174k-source mosaic.
const MAX_GLYPHS = 4000;
// When the filtered/queued list is at most this many, bypass the viewport cull and draw
// every source every frame — small sets shouldn't flicker in/out at the window edge while
// zooming. Comfortably under MAX_GLYPHS so the stride never kicks in for a "show all" set.
const SHOW_ALL_MAX = 500;
// Ellipse polygon resolution (vertices). 16 is smooth on-screen and cheap.
const ELLIPSE_SEGMENTS = 16;
// Below this many drawing-buffer px per world px, draw a small dot instead of a Kron
// ellipse — so ellipses only appear once you're zoomed in far enough for them to read
// as real galaxy shapes (raise to hold ellipses off until deeper zoom; lower to show
// them sooner).
const DOT_ZOOM = 0.5;

// Adaptive scale-bar target: aim for a bar ~this many CSS px wide, then snap its ANGULAR
// length to the nearest nice round value (…1,2,5,10,20,30,60″ → 1,2,5′…). Returns the
// snapped screen length in px + a label in arcsec (or arcmin when ≥60″).
const SCALEBAR_TARGET_PX = 90;
// Nice round angular lengths in ARCSEC, ascending. Covers deep zoom (0.2″) out to ~30′.
const NICE_ARCSEC = [
  0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800,
];
function niceScaleBar(arcsecPerCssPx: number): { px: number; label: string } | null {
  if (!(arcsecPerCssPx > 0) || !Number.isFinite(arcsecPerCssPx)) return null;
  const targetArcsec = SCALEBAR_TARGET_PX * arcsecPerCssPx;
  // Pick the largest nice length not exceeding the target (fall back to the smallest).
  let chosen = NICE_ARCSEC[0];
  for (const a of NICE_ARCSEC) { if (a <= targetArcsec) chosen = a; else break; }
  const px = chosen / arcsecPerCssPx;
  const label =
    chosen >= 60
      ? `${(chosen / 60) % 1 === 0 ? (chosen / 60).toFixed(0) : (chosen / 60).toFixed(1)}′`
      : `${chosen % 1 === 0 ? chosen.toFixed(0) : chosen.toFixed(1)}″`;
  return { px, label };
}

// ---- NIRSpec aperture geometry ---------------------------------------------
// NIRSpec MSA micro-shutter: ~0.20" (dispersion) × 0.46" (spatial), with ~0.07" opaque
// bars between adjacent shutters. A 3-shutter slitlet stacks 3 along the SPATIAL axis:
// spatial extent = 3×0.46 + 2×0.07 = 1.52" (each open shutter drawn separately so the
// bars read as gaps). NIRSpec IFU aperture is a 3"×3" square.
const MSA_SHUTTER_DISP = 0.20;   // arcsec, dispersion (short) axis
const MSA_SHUTTER_SPAT = 0.46;   // arcsec, spatial (long) axis of one shutter
const MSA_BAR = 0.07;            // arcsec, opaque bar between shutters
const IFU_SIDE = 3.0;            // arcsec, NIRSpec IFU field of view (3"×3")

// Full NIRSpec MSA field: 4 quadrants in a 2×2 arrangement, each 365 shutters
// (dispersion/X) × 171 shutters (spatial/Y) at a shutter pitch of 0.267" (dispersion) ×
// 0.528" (spatial) — pitch includes the bar. ⇒ each quadrant ≈ 365×0.267 = 97.5" (disp)
// × 171×0.528 = 90.3" (spat). The full field is ≈ 3.6′×3.4′ (≈208"×199") including the
// inter-quadrant gaps, so the gap between the two quadrant COLUMNS ≈ 208 − 2×97.5 ≈ 13"
// (dispersion) and between the two ROWS ≈ 199 − 2×90.3 ≈ 18" (spatial). Same PA/centre as
// the slitlet: the spatial axis points along PA, the dispersion axis along PA+90°.
const MSA_QUAD_DISP = 365 * 0.267;   // arcsec, one quadrant along dispersion (≈97.5")
const MSA_QUAD_SPAT = 171 * 0.528;   // arcsec, one quadrant along spatial (≈90.3")
const MSA_GAP_DISP = 13.0;           // arcsec, inter-quadrant gap between columns (dispersion)
const MSA_GAP_SPAT = 18.0;           // arcsec, inter-quadrant gap between rows (spatial)

// Screen-space aperture frame at a centre point. `disp`/`spat` are the on-screen vectors
// (CSS px) of a +1" step along the dispersion and spatial axes respectively — already
// carrying the arcsec→px scale, the PA rotation, and the WCS orientation (North-up/flip).
type ApFrame = { cx: number; cy: number; disp: { x: number; y: number }; spat: { x: number; y: number } };

// Build the aperture screen frame anchored EXACTLY on the aperture's world pixel. PA is
// east-of-north and orients the SPATIAL (long) axis of the aperture — the slitlet's long
// axis / the IFU's +y side points along PA; the dispersion axis is PA+90°.
//
// Everything is measured empirically from the WCS at the APERTURE position (not the view
// centre): we project the centre pixel and two points exactly 1″ north/east through the
// SAME `imageToScreen` the Kron-ellipse overlay uses, so the per-arcsec screen VECTORS
// (magnitude = local px/arcsec, direction = local N/E under North-up + any parity flip)
// are correct right at the aperture and stay locked as the camera zooms/pans.
//
// Two conventions must match the ellipse path so the aperture doesn't drift on zoom:
//  1. FITS pixel-centre: `skyToPix`/camera pixels are corner-origin (world (0,0) = top-left
//     pixel corner), so `imageToScreen` needs +0.5 on both axes — the ellipse code uses
//     `imageToScreen(s.x+0.5, s.y+0.5)`. Omitting it leaves a half-native-pixel error that
//     scales with zoom (0.5·zoom screen px) — the exact "drifts off on zoom-in" bug.
//  2. `imageToScreen` returns viewport-relative CLIENT px; the overlay SVG is inset:0 in
//     the wrapper, so subtract the wrapper rect's left/top to get overlay-local px.
//
// `fallbackScale` (view-centre arcsec/CSS-px) is used only when there is no WCS.
function apertureFrame(
  h: FitsViewerHandle,
  centerWorld: { x: number; y: number },
  rect: { left: number; top: number },
  fallbackScale: number,
  paDeg: number,
): ApFrame | null {
  const P = (wx: number, wy: number) => {
    const p = h.imageToScreen(wx + 0.5, wy + 0.5);   // +0.5: FITS pixel-centre (match ellipses)
    return p ? { x: p.x - rect.left, y: p.y - rect.top } : null;
  };
  const c = P(centerWorld.x, centerWorld.y);
  if (!c) return null;

  const wcs = h.getViewer()?.getWcs();
  // Per-arcsec screen VECTORS for North (+Dec) and East (+RA) — magnitude carries the
  // local px/arcsec, direction the local orientation. Fall back to axis-aligned N/E at the
  // view-centre scale when no WCS is available (PA still applies).
  let nVec = { x: 0, y: -1 / fallbackScale };  // north = screen up
  let eVec = { x: -1 / fallbackScale, y: 0 };  // east  = screen left (E-left, standard)
  if (wcs) {
    const sky = pixToSky(wcs, centerWorld.x, centerWorld.y);
    const dDeg = 1 / 3600; // 1" step
    const north = skyToPix(wcs, sky.ra, sky.dec + dDeg);
    const east = skyToPix(wcs, sky.ra + dDeg / Math.cos((sky.dec * Math.PI) / 180), sky.dec);
    const pN = P(north.x, north.y);
    const pE = P(east.x, east.y);
    if (pN && pE) {
      const nv = { x: pN.x - c.x, y: pN.y - c.y };   // 1″ north, in screen px at the aperture
      const ev = { x: pE.x - c.x, y: pE.y - c.y };   // 1″ east
      if (Math.hypot(nv.x, nv.y) > 0 && Math.hypot(ev.x, ev.y) > 0) { nVec = nv; eVec = ev; }
    }
  }
  // Spatial axis points along PA (east-of-north): cos·N + sin·E. Dispersion is PA+90°.
  const pa = (paDeg * Math.PI) / 180;
  const cs = Math.cos(pa), sn = Math.sin(pa);
  return {
    cx: c.x, cy: c.y,
    spat: { x: cs * nVec.x + sn * eVec.x, y: cs * nVec.y + sn * eVec.y },
    disp: { x: -sn * nVec.x + cs * eVec.x, y: -sn * nVec.y + cs * eVec.y },
  };
}

// Map an aperture-frame point (dArcsec along dispersion, sArcsec along spatial) to a
// screen "x,y" string for an SVG polygon.
function apPt(f: ApFrame, dArcsec: number, sArcsec: number): string {
  const x = f.cx + f.disp.x * dArcsec + f.spat.x * sArcsec;
  const y = f.cy + f.disp.y * dArcsec + f.spat.y * sArcsec;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

// One rectangle (2·halfDisp × 2·halfSpat about a spatial offset), as a 4-point polygon.
function apRect(f: ApFrame, halfDisp: number, sCenter: number, halfSpat: number): string {
  return [
    apPt(f, -halfDisp, sCenter - halfSpat),
    apPt(f, halfDisp, sCenter - halfSpat),
    apPt(f, halfDisp, sCenter + halfSpat),
    apPt(f, -halfDisp, sCenter + halfSpat),
  ].join(" ");
}

// One rectangle centred at (dCenter along dispersion, sCenter along spatial), 2·halfDisp ×
// 2·halfSpat, as a 4-point polygon — used for the MSA field quadrants, which are offset on
// BOTH axes (apRect only offsets along spatial).
function apRectAt(f: ApFrame, dCenter: number, halfDisp: number, sCenter: number, halfSpat: number): string {
  return [
    apPt(f, dCenter - halfDisp, sCenter - halfSpat),
    apPt(f, dCenter + halfDisp, sCenter - halfSpat),
    apPt(f, dCenter + halfDisp, sCenter + halfSpat),
    apPt(f, dCenter - halfDisp, sCenter + halfSpat),
  ].join(" ");
}

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
  x: number; y: number;               // world-pixel centre (from index x/y; overwritten from ra/dec for tiled fields)
  ra: number; dec: number;            // sky position — used to resolve world px on tiled fields
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
    out.push({ i, id: idx.id[i], sel: isSel, x: xi, y: yi, ra: idx.ra[i], dec: idx.dec[i], semiA, semiB, th });
  }
  return out;
}

// One drawable glyph in SCREEN space, produced by projecting a source through the
// viewer's imageToScreen for the current frame.
type Glyph = { id: number; sel: boolean; zspec?: boolean; poly?: string; cx?: number; cy?: number; r?: number };

// A camera target the viewer must ADOPT AND HOLD: world-pixel centre + zoom (drawing-
// buffer px per native px). The page writes this ref (deep-link goto or the "go to" box);
// MapViewer re-asserts it on EVERY drawn frame until the camera actually holds it, which
// defeats the viewer's construction/tile-load auto-fit that would otherwise clobber a
// setCenter/setZoom issued too early. Cleared once held so the user can pan/zoom freely.
export type CameraTarget = { cx: number; cy: number; zoom: number; until: number };

export default function MapViewer({
  field,
  configUrl,
  filters,
  queuedIds,
  zspecIds,
  onSourceClick,
  onCount,
  onReadyHandle,
  cameraTargetRef,
}: {
  /** The active field's config — drives which search index the overlay loads. */
  field: FieldConfig;
  configUrl: string;
  filters: MapFilters;
  /** Search → map handoff: when non-null, draw ONLY sources whose id ∈ this set (the
   *  queried objects for the active field). When null, draw every source (default). */
  queuedIds?: Set<number> | null;
  /** Ids (this field) that have a campfire spec-z — drawn green, overriding selected/not. */
  zspecIds?: Set<number> | null;
  onSourceClick: (id: number) => void;
  /** Report how many sources pass the active filters (total, not just on-screen). */
  onCount?: (n: number) => void;
  /** Hand the viewer handle + index up to the page (for the "go to" control). */
  onReadyHandle?: (h: FitsViewerHandle, idx: FieldIndex) => void;
  /** A pending camera target to adopt-and-hold across auto-fit; null once satisfied. */
  cameraTargetRef?: React.MutableRefObject<CameraTarget | null>;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [idx, setIdx] = useState<FieldIndex | null>(null);
  const [magCol, setMagCol] = useState<NumCol>(null);
  const [glyphs, setGlyphs] = useState<Glyph[]>([]);
  // Adaptive scale bar (bottom-left): pixel length on screen + its human label. Recomputed
  // every frame from the live zoom; null until the first projection has a camera.
  const [scaleBar, setScaleBar] = useState<{ px: number; label: string } | null>(null);
  // NIRSpec aperture overlays (MSA 3-shutter slitlet + IFU). Toggles + a shared PA (deg,
  // east-of-north). Optionally pinned to a fixed sky position; null = follow view centre.
  const [msaOn, setMsaOn] = useState(false);
  const [ifuOn, setIfuOn] = useState(false);
  const [msaFieldOn, setMsaFieldOn] = useState(false);
  const [paDeg, setPaDeg] = useState(0);
  const [apertureSky, setApertureSky] = useState<{ ra: number; dec: number } | null>(null);
  // Screen-space polygons for the active apertures, recomputed each frame in project().
  const [apertures, setApertures] = useState<{ msa: string[]; ifu: string | null; field: string[] }>({ msa: [], ifu: null, field: [] });

  // ---- Custom-aperture photometry draw tool ---------------------------------
  // The tool is enabled only when the user is signed in (Supabase session) AND the active
  // field is CEERS (the Worker is CEERS-only). `photoTool` toggles the draw mode on/off.
  const [session, setSession] = useState<import("@supabase/supabase-js").Session | null>(null);
  const [photoTool, setPhotoTool] = useState(false);
  const isCeers = field.field === "CEERS";
  const photoEnabled = session != null && isCeers;
  // The drawn aperture's SKY centre + radius (arcsec), stored so project() re-pins it to
  // screen every frame (welded to its sky pixel under pan/zoom, exactly like the ellipses).
  // null when nothing is drawn. `draw` holds the in-progress drag; `photoAp` the committed
  // aperture (kept while its results panel is open).
  const [draw, setDraw] = useState<{ ra: number; dec: number; radiusArcsec: number } | null>(null);
  const [photoAp, setPhotoAp] = useState<{ ra: number; dec: number; radiusArcsec: number } | null>(null);
  // Screen-space projection of the active aperture (centre px + radius px), rebuilt each
  // frame in project() from its sky centre — null when off-screen or nothing drawn.
  const [photoCircle, setPhotoCircle] = useState<{ cx: number; cy: number; r: number } | null>(null);
  // The results-panel state (spinner / done / error), driven by measureAperture.
  const [photoState, setPhotoState] = useState<PhotState>({ kind: "idle" });

  // Track the Supabase session (same pattern as /data/review) so the tool button gates on
  // sign-in and re-enables/disables live on login/logout.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  // Live trilogy scaling params driven by the SCALING panel. Starts at CAMPFIRE; the
  // panel mutates these and each change re-derives the stretch on the existing viewer
  // via applyTrilogy — no camera move, no overlay rebuild.
  const [trilogy, setTrilogy] = useState<TrilogyParams>(CAMPFIRE_TRILOGY);
  // Selected transfer curve. trilogy is the default; the panel can switch to any mode
  // @fitsgl/core supports (log/asinh/sqrt/linear), applied over the same per-band levels.
  const [stretchMode, setStretchMode] = useState<StretchMode>(DEFAULT_STRETCH_MODE);
  const [panelOpen, setPanelOpen] = useState(true);

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
  // Search → map handoff id set (queried objects for this field), in a ref so the stable
  // per-frame project() reads the latest without re-subscribing. null = draw all sources.
  const queuedIdsRef = useRef<Set<number> | null>(queuedIds ?? null);
  queuedIdsRef.current = queuedIds ?? null;
  // Campfire spec-z id set for this field (green glyphs), same live-ref pattern.
  const zspecIdsRef = useRef<Set<number> | null>(zspecIds ?? null);
  zspecIdsRef.current = zspecIds ?? null;
  // Tiled fields (COSMOS/EGS) have per-tile catalog x,y that don't map to the fitsgl
  // virtual grid — resolve each source's world px from ra/dec via the viewer WCS instead.
  const tiledRef = useRef(false);
  const resolvedRef = useRef(false);   // world px resolved for the current source list?
  // Latest per-band trilogy stats + view kind, in a ref so applyScaling reads them
  // without re-subscribing. Set from the config memo.
  const statsRef = useRef<{ stats: TrilogyStats[] | null; single: boolean }>({ stats: null, single: false });

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
  // FitsglConfig — the same transform <FitsExplorer> does internally — AND the per-band
  // trilogy stats (in render-source order) that `viewer.applyTrilogy(stats, params)`
  // needs, so the scaling panel can re-derive the stretch live from the panel's params
  // without a tile rescan (exactly how FitsglCutout drives it). `single` distinguishes a
  // one-band view (stats is a lone TrilogyStats) from the multiband composite (an array).
  const prep = useMemo<{ viewer: ViewerConfig; stats: TrilogyStats[] | null; single: boolean } | null>(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    // Start from CAMPFIRE's scaling (recomputed from each field's own per-band stats) so
    // the map opens matching campfire / the card cutouts; the panel tunes from here.
    st.trilogyParams = { ...st.trilogyParams, ...CAMPFIRE_TRILOGY };
    const viewer = deriveViewerConfig(bands, st);
    const v = viewer.view;
    const names =
      v.mode === "single" ? [v.band] : v.mode === "rgb" ? [v.r, v.g, v.b] : v.bands.map(b => b.band);
    const raw = names.map(n => bands.find(b => b.name === n)?.trilogy);
    const stats = raw.every(s => s !== undefined) ? (raw as TrilogyStats[]) : null;
    return { viewer, stats, single: v.mode === "single" };
  }, [config]);
  const viewerConfig = prep?.viewer ?? null;
  useEffect(() => {
    statsRef.current = { stats: prep?.stats ?? null, single: prep?.single ?? false };
  }, [prep]);

  // Native pixel scale (arcsec/px) from the first band's grid; 0.03 for the 30 mas
  // mosaics. Drives the scale-bar overlay (arcsec across a screen span).
  const pixelScale = useMemo(() => {
    const g = config?.dataset.bands[0]?.grid?.pixelScaleArcsec;
    return g && g > 0 ? g : 0.03;
  }, [config]);
  // In a ref too, so the stable per-frame `project` reads it without re-subscribing.
  const pixelScaleRef = useRef(pixelScale);
  pixelScaleRef.current = pixelScale;
  // Aperture-overlay settings, in a ref for the same reason (project runs per frame).
  const apRef = useRef({ msaOn, ifuOn, msaFieldOn, paDeg, apertureSky });
  apRef.current = { msaOn, ifuOn, msaFieldOn, paDeg, apertureSky };
  // The photometry aperture to draw this frame — the in-progress drag if drawing, else the
  // committed aperture. In a ref so the stable per-frame project() reads the latest.
  const photoDrawRef = useRef<{ ra: number; dec: number; radiusArcsec: number } | null>(null);
  photoDrawRef.current = draw ?? photoAp;

  // Re-derive + apply the trilogy stretch on the LIVE viewer from the given params. This
  // is the exact FitsExplorer path (applyTrilogy + setStretchMode("trilogy")): it only
  // updates the transfer curve — it does NOT touch the camera or the SVG overlay, so the
  // Kron ellipses and the current pan/zoom are preserved. No-ops until the viewer's
  // source mode has settled (else applyTrilogy would run against the wrong band set).
  const applyScaling = useCallback((params: TrilogyParams, mode: StretchMode) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    const { stats, single } = statsRef.current;
    if (!viewer || !stats) return;
    const expectedMode = single ? "single" : "multiband";
    if (viewer.sourceMode !== expectedMode) return;
    // applyTrilogy sets each band's black/white points (x0/x2) from the params; the
    // selected curve is then applied over that interval by the shader. For any non-
    // trilogy curve we still call applyTrilogy to establish the levels, then override
    // the transfer function with setStretchMode(mode).
    viewer.applyTrilogy(single ? stats[0] : stats, params);
    viewer.setStretchMode(mode);
  }, []);

  // Apply live whenever the panel params OR the selected mode change (viewer already up).
  // The onReady/onFrame paths cover the pre-mode-settled window; this covers panel edits.
  useEffect(() => { applyScaling(trilogy, stretchMode); }, [trilogy, stretchMode, applyScaling]);

  // Latest scaling, read by the post-ready poke loop so it can (re)apply the stretch as
  // the viewer's source mode settles even if no panel edit fires the effect above.
  const scalingRef = useRef({ trilogy, stretchMode });
  scalingRef.current = { trilogy, stretchMode };

  // Load our search index (positions, selected, za, geometry) once.
  useEffect(() => {
    let cancelled = false;
    loadField(field)
      .then(({ idx }) => { if (!cancelled) { tiledRef.current = idx.tile != null; setIdx(idx); } })
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
      const fx = await loadFilters(field);
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
  // Count reported to the sidebar: the queued subset when a handoff is active, else all.
  const countShown = useCallback((list: Src[]) => {
    const qids = queuedIdsRef.current;
    countRef.current?.(qids ? list.reduce((n, s) => n + (qids.has(s.id) ? 1 : 0), 0) : list.length);
  }, []);

  useEffect(() => {
    sourcesRef.current = sources;
    resolvedRef.current = false;   // new list → re-resolve tiled world px on next project
    countShown(sources);
    // Reproject against the current camera (filters changed between frames). A couple
    // of delayed retries cover the case where the viewer handle / first frame isn't
    // ready yet at the instant the source list first resolves.
    project();
    const t1 = setTimeout(() => project(), 200);
    const t2 = setTimeout(() => project(), 800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // The queued id set changed (search → map handoff toggled, or the field switched to one
  // with a different queued subset): re-count + re-project immediately. No source-list
  // rebuild — project() reads queuedIdsRef live and filters there.
  useEffect(() => {
    countShown(sourcesRef.current);
    project();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedIds, zspecIds]);

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
    // Search → map handoff: draw ONLY the queried objects when a queued id set is present;
    // otherwise the full filtered list. Filtered here (not in filterSources) so toggling
    // the queue on/off — or switching fields — needs no source-list rebuild.
    const qids = queuedIdsRef.current;
    const list = qids ? sourcesRef.current.filter(s => qids.has(s.id)) : sourcesRef.current;
    const zids = zspecIdsRef.current;
    const asDot = zoom < DOT_ZOOM;

    // Adaptive scale bar + NIRSpec apertures both need CSS px per native px: measure it
    // empirically from imageToScreen over a 100-native-px span at the view centre (robust
    // to DPR + North-up rotation). arcsec/CSS-px = pixelScale / (cssPxPerNativePx).
    {
      const a = h.imageToScreen(cam.centerX, cam.centerY);
      const b = h.imageToScreen(cam.centerX + 100, cam.centerY);
      let arcsecPerCssPx = 0;
      if (a && b) {
        const cssPxPer100 = Math.hypot(b.x - a.x, b.y - a.y);
        if (cssPxPer100 > 0) {
          arcsecPerCssPx = (pixelScaleRef.current * 100) / cssPxPer100;
          setScaleBar(niceScaleBar(arcsecPerCssPx));
        }
      }

      // NIRSpec aperture overlays. Centre on a pinned sky position if set, else the view
      // centre. Build the screen frame (arcsec→px + PA + WCS orientation), then the MSA
      // 3-shutter slitlet (3 open shutters along the spatial axis, ~0.07" bars between)
      // and/or the 3"×3" IFU square. All in arcsec, so they scale with zoom.
      const ap = apRef.current;
      if ((ap.msaOn || ap.ifuOn || ap.msaFieldOn) && arcsecPerCssPx > 0) {
        // Aperture centre world pixel: the pinned sky position (locked under pan/zoom) if
        // set, else the live view centre. apertureFrame anchors on this exact pixel via the
        // same +0.5 / rect-relative imageToScreen the ellipses use, so a pinned aperture
        // stays welded to its sky pixel at every zoom.
        let cw = { x: cam.centerX, y: cam.centerY };
        if (ap.apertureSky) {
          const wcs = h.getViewer()?.getWcs();
          if (wcs) {
            const p = skyToPix(wcs, ap.apertureSky.ra, ap.apertureSky.dec);
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) cw = { x: p.x, y: p.y };
          }
        }
        const frame = apertureFrame(h, cw, rect, arcsecPerCssPx, ap.paDeg);
        if (frame) {
          const hd = MSA_SHUTTER_DISP / 2, hs = MSA_SHUTTER_SPAT / 2;
          const pitch = MSA_SHUTTER_SPAT + MSA_BAR;   // shutter-to-shutter spacing
          const msa = ap.msaOn
            ? [-1, 0, 1].map(k => apRect(frame, hd, k * pitch, hs))
            : [];
          const ifu = ap.ifuOn ? apRect(frame, IFU_SIDE / 2, 0, IFU_SIDE / 2) : null;
          // Full MSA field: 4 quadrants (2×2). Each quadrant's centre is offset by half a
          // quadrant + half a gap along both axes; ± that offset gives the four corners.
          const hqd = MSA_QUAD_DISP / 2, hqs = MSA_QUAD_SPAT / 2;
          const offD = hqd + MSA_GAP_DISP / 2;   // quadrant-centre offset along dispersion
          const offS = hqs + MSA_GAP_SPAT / 2;   // quadrant-centre offset along spatial
          const field = ap.msaFieldOn
            ? [[-offD, -offS], [offD, -offS], [-offD, offS], [offD, offS]].map(
                ([cd, cs]) => apRectAt(frame, cd, hqd, cs, hqs),
              )
            : [];
          setApertures({ msa, ifu, field });
        } else {
          setApertures({ msa: [], ifu: null, field: [] });
        }
      } else {
        setApertures({ msa: [], ifu: null, field: [] });
      }

      // Custom-aperture photometry circle. Pinned to its SKY centre (welded under pan/zoom):
      // sky → world px via the viewer WCS, then world → screen via the SAME +0.5 / rect-
      // relative imageToScreen the ellipses use, so it never drifts. Radius: project a point
      // radius_arcsec due north of the centre and take the screen distance (matches the
      // scale-bar's arcsec→px measurement above).
      const pd = photoDrawRef.current;
      if (pd && arcsecPerCssPx > 0) {
        const wcs = h.getViewer()?.getWcs();
        if (wcs) {
          const cWorld = skyToPix(wcs, pd.ra, pd.dec);
          const cScreen = h.imageToScreen(cWorld.x + 0.5, cWorld.y + 0.5);
          const edgeWorld = skyToPix(wcs, pd.ra, pd.dec + pd.radiusArcsec / 3600);
          const eScreen = h.imageToScreen(edgeWorld.x + 0.5, edgeWorld.y + 0.5);
          if (cScreen && eScreen) {
            const cx = cScreen.x - rect.left, cy = cScreen.y - rect.top;
            const ex = eScreen.x - rect.left, ey = eScreen.y - rect.top;
            const r = Math.hypot(ex - cx, ey - cy);
            setPhotoCircle({ cx, cy, r });
          } else {
            setPhotoCircle(null);
          }
        } else {
          setPhotoCircle(null);
        }
      } else {
        setPhotoCircle(null);
      }
    }

    // Tiled fields: the catalog x,y are per-tile and don't line up with the fitsgl virtual
    // grid, so resolve each source's world px from its ra/dec via the viewer WCS (once per
    // source list). Single-mosaic fields keep their index x,y (already world px).
    if (tiledRef.current && !resolvedRef.current && list.length) {
      const wcs = h.getViewer()?.getWcs();
      if (wcs) {
        for (const s of list) {
          const p = skyToPix(wcs, s.ra, s.dec);
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { s.x = p.x; s.y = p.y; }
        }
        resolvedRef.current = true;
      }
    }

    // Phase 1 — WORLD-space viewport cull (cheap, no imageToScreen). The viewport spans
    // W/zoom × H/zoom world px about the camera centre; take a generous margin (×1.5 +
    // pad) so display rotation / North-up can't clip edge sources. This yields the set
    // actually on-screen without projecting every one of the 174k sources per frame.
    //
    // BUT when the whole list is small (e.g. a small query subset), skip the cull and draw
    // every source every frame — otherwise sources near the padded window edge flicker in
    // and out while zooming. A few hundred glyphs is cheap to project unconditionally.
    let visible: Src[];
    if (list.length <= SHOW_ALL_MAX) {
      visible = list;
    } else {
      const halfW = (W / zoom) * 0.75 + 60;
      const halfH = (H / zoom) * 0.75 + 60;
      const x0 = cam.centerX - halfW, x1 = cam.centerX + halfW;
      const y0 = cam.centerY - halfH, y1 = cam.centerY + halfH;
      visible = [];
      for (let k = 0; k < list.length; k++) {
        const s = list[k];
        if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) visible.push(s);
      }
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

      const zspec = zids?.has(s.id) ?? false;
      if (asDot || !(s.semiA > 0 && s.semiB > 0) || Number.isNaN(s.th)) {
        out.push({ id: s.id, sel: s.sel, zspec, cx: scx, cy: scy, r: asDot ? 1.6 : 4 });
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
      out.push({ id: s.id, sel: s.sel, zspec, poly: pts.join(" ") });
    }
    setGlyphs(out);
  }, []);

  // Re-project when aperture settings change — toggling/PA don't move the camera, so
  // onFrame won't fire; poke project directly so the overlay updates immediately.
  useEffect(() => { project(); }, [msaOn, ifuOn, msaFieldOn, paDeg, apertureSky, project]);

  // Re-project when the drawn photometry aperture changes (drag / commit / clear) — no
  // camera move, so onFrame won't fire on its own.
  useEffect(() => { project(); }, [draw, photoAp, project]);

  // ---- Photometry draw tool: pointer handlers -------------------------------
  // With the tool active, a drag on the map draws the aperture (NOT a pan): mousedown sets
  // the sky centre, mousemove sets the radius (great-circle sep centre→cursor × 3600), and
  // mouseup finalises and fires measureAperture. We intercept the pointer ONLY while the
  // tool is active and a draw is in progress, so with the tool off the map pans exactly as
  // before. Uses capture + stopPropagation so the viewer's own drag-pan never sees the drag.
  const drawingRef = useRef<{ ra: number; dec: number } | null>(null);

  const skyAt = useCallback((clientX: number, clientY: number): { ra: number; dec: number } | null => {
    const h = handleRef.current;
    if (!h) return null;
    const w = h.screenToImage(clientX, clientY);
    if (!w) return null;
    const wcs = h.getViewer()?.getWcs();
    if (!wcs) return null;
    const s = pixToSky(wcs, w.x, w.y);
    return Number.isFinite(s.ra) && Number.isFinite(s.dec) ? { ra: s.ra, dec: s.dec } : null;
  }, []);

  const onPhotoDown = useCallback((e: React.PointerEvent) => {
    if (!photoTool) return;                 // tool off → let the map pan as usual
    if (e.button !== 0) return;             // left-drag only
    const c = skyAt(e.clientX, e.clientY);
    if (!c) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = c;
    setPhotoAp(null);                       // clear any prior committed aperture
    setPhotoState({ kind: "idle" });
    setDraw({ ra: c.ra, dec: c.dec, radiusArcsec: 0 });
  }, [photoTool, skyAt]);

  const onPhotoMove = useCallback((e: React.PointerEvent) => {
    const start = drawingRef.current;
    if (!start) return;                     // not drawing → ignore (map handles its own moves)
    e.stopPropagation();
    const cur = skyAt(e.clientX, e.clientY);
    if (!cur) return;
    const radiusArcsec = angularSeparationDeg(start, cur) * 3600;
    setDraw({ ra: start.ra, dec: start.dec, radiusArcsec });
  }, [skyAt]);

  const onPhotoUp = useCallback((e: React.PointerEvent) => {
    const start = drawingRef.current;
    if (!start) return;
    e.stopPropagation();
    drawingRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const cur = skyAt(e.clientX, e.clientY);
    const radiusArcsec = cur ? angularSeparationDeg(start, cur) * 3600 : 0;
    const ap = { ra: start.ra, dec: start.dec, radiusArcsec };
    setDraw(null);
    // A too-small aperture (a stray click) is discarded — nothing to measure.
    if (!(radiusArcsec > 0.02)) { setPhotoAp(null); setPhotoState({ kind: "idle" }); return; }
    setPhotoAp(ap);
    setPhotoState({ kind: "measuring", ra: ap.ra, dec: ap.dec, radiusArcsec });
    void measureAperture(ap.ra, ap.dec, { type: "circle", radius_arcsec: radiusArcsec })
      .then(result => setPhotoState({ kind: "done", ra: ap.ra, dec: ap.dec, radiusArcsec, result }))
      .catch(err => setPhotoState({
        kind: "error", ra: ap.ra, dec: ap.dec, radiusArcsec,
        message: err instanceof Error ? err.message : String(err),
      }));
  }, [skyAt]);

  // The capture overlay occludes the viewer canvas, so wheel events land on it instead of
  // the canvas — which would kill zoom while the tool is on. Re-dispatch the wheel to the
  // canvas beneath so zoom keeps working; the drag (pointer) is still ours for drawing.
  const forwardWheel = useCallback((e: React.WheelEvent) => {
    const canvas = wrapRef.current?.querySelector("canvas");
    if (!canvas) return;
    e.preventDefault();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
      clientX: e.clientX, clientY: e.clientY, bubbles: false, cancelable: true,
    }));
  }, []);

  // Close the results panel: clear the drawn aperture + state so the user can draw another.
  const closePhoto = useCallback(() => {
    drawingRef.current = null;
    setDraw(null);
    setPhotoAp(null);
    setPhotoState({ kind: "idle" });
  }, []);

  // Turning the tool off (or the enabling conditions lapsing) clears any in-progress draw.
  useEffect(() => {
    if (!photoTool) { drawingRef.current = null; setDraw(null); }
  }, [photoTool]);
  useEffect(() => {
    if (!photoEnabled && photoTool) setPhotoTool(false);
  }, [photoEnabled, photoTool]);

  // Re-assert a pending camera target (set by the page's deep-link / "go to") until the
  // viewer actually holds it. The viewer auto-fits the whole mosaic at construction and
  // AGAIN as tiles land, which silently overrides a setCenter/setZoom issued right after
  // ready — so a single goto doesn't stick. Called on EVERY frame: if the live camera is
  // off-target (centre by >0.5 native px, or zoom by >0.5%), re-apply and keep the target
  // pending; once it matches, clear the target so subsequent user pan/zoom is left alone.
  // Mirrors FitsglCutout's onFrame "re-assert camera until placed" pattern.
  const enforceCamera = useCallback(() => {
    const ref = cameraTargetRef;
    const t = ref?.current;
    if (!t) return;
    const h = handleRef.current;
    if (!h) return;
    // Keep re-asserting through the viewer's tile-load auto-fits for a fixed window,
    // THEN release so the user can pan. (Clearing on the first "held" let a later
    // auto-fit win with no target left to restore — that was the "doesn't zoom" bug.)
    if (Date.now() >= t.until) { ref!.current = null; return; }
    const cam = h.getCameraState();
    if (!cam) return;
    const held =
      Math.abs(cam.centerX - t.cx) < 0.5 &&
      Math.abs(cam.centerY - t.cy) < 0.5 &&
      Math.abs(cam.zoom - t.zoom) <= t.zoom * 0.005;
    if (!held) { h.setCenter(t.cx, t.cy); h.setZoom(t.zoom); }
  }, [cameraTargetRef]);

  // Kick a few projection attempts spaced out in time. fitsgl fires onFrame only when
  // the view actually changes (no idle loop), so on first load — or when the source
  // list changes while the camera sits still — we must project proactively rather than
  // wait for a frame. Retries cover the window where the camera/tiles settle after
  // ready. Stops early once something paints.
  const pokeProject = useCallback(() => {
    let tries = 0;
    const tick = () => {
      enforceCamera();
      applyScaling(scalingRef.current.trilogy, scalingRef.current.stretchMode);
      project();
      tries += 1;
      if (tries < 20) setTimeout(tick, 250);   // ~5s: cover the camera re-assert window
    };
    requestAnimationFrame(tick);
  }, [project, enforceCamera, applyScaling]);

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

  // Thicken the glyph strokes when few are shown (a restrictive filter, or deep zoom) so
  // sparse sources pop; thin out when the field is dense.
  const glyphSW = glyphs.length <= 40 ? 3 : glyphs.length <= 200 ? 2.3 : glyphs.length <= 1200 ? 1.7 : 1.3;

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      <FitsViewer
        config={viewerConfig}
        onReady={onReady}
        onFrame={() => { enforceCamera(); project(); }}
        onError={(err) => {
          console.error("[map] FitsViewer error:", err);
          setErrMsg(err instanceof Error ? err.message : String(err));
          setState("error");
        }}
        style={{ width: "100%", height: "100%" }}
      />

      {/* Photometry draw-capture layer. Only mounted (and only pointer-eventful) while the
          tool is active, so it intercepts the drag BEFORE the viewer's own pan; with the
          tool off it isn't in the tree and the map pans/zooms/clicks exactly as before. */}
      {photoTool && (
        <div
          data-overlay="photo-capture"
          onPointerDown={onPhotoDown}
          onPointerMove={onPhotoMove}
          onPointerUp={onPhotoUp}
          onWheel={forwardWheel}
          style={{ position: "absolute", inset: 0, zIndex: 18, cursor: "crosshair", touchAction: "none" }}
        />
      )}

      {/* Overlay layer — pointer-events only on the glyphs, so panning the map still
          works everywhere between sources. */}
      <svg
        data-overlay="sources"
        width="100%" height="100%"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
      >
        {glyphs.map((g, k) => {
          const color = g.zspec ? GREEN : g.sel ? YELLOW : RED;
          const onClick = (e: React.MouseEvent) => { e.stopPropagation(); clickRef.current(g.id); };
          if (g.poly) {
            return (
              <polygon
                key={k} data-src-id={g.id} points={g.poly}
                fill="transparent" stroke={color} strokeWidth={glyphSW}
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
              fill={g.r! <= 2 ? color : "transparent"} stroke={color} strokeWidth={glyphSW}
              style={{ pointerEvents: "visible", cursor: "pointer" }}
              onClick={onClick}
            >
              <title>ID {g.id}</title>
            </circle>
          );
        })}
      </svg>

      {/* NIRSpec aperture overlays — MSA 3-shutter slitlet (cyan) + IFU 3"×3" (magenta) +
          full MSA 4-quadrant field (amber), centred on the view (or pinned sky pos),
          rotated by PA. Non-interactive. */}
      {(apertures.msa.length > 0 || apertures.ifu || apertures.field.length > 0) && (
        <svg
          data-overlay="apertures"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {apertures.field.map((pts, k) => (
            <polygon key={`f${k}`} points={pts} fill="rgba(240,176,80,0.06)" stroke="#f0b050" strokeWidth={1.4} />
          ))}
          {apertures.ifu && (
            <polygon points={apertures.ifu} fill="rgba(224,120,224,0.08)" stroke="#e078e0" strokeWidth={1.6} />
          )}
          {apertures.msa.map((pts, k) => (
            <polygon key={k} points={pts} fill="rgba(94,224,224,0.12)" stroke="#5ee0e0" strokeWidth={1.4} />
          ))}
        </svg>
      )}

      {/* Custom-aperture photometry circle (cyan) — pinned to its sky centre via the same
          +0.5 / rect-relative imageToScreen the ellipses use, so it stays welded on pan/zoom.
          Non-interactive; the capture layer above handles the drawing. */}
      {photoCircle && (
        <svg
          data-overlay="photometry-circle"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          <circle
            cx={photoCircle.cx} cy={photoCircle.cy} r={photoCircle.r}
            fill="rgba(56,208,240,0.08)" stroke={CYAN} strokeWidth={1.6}
          />
          <circle cx={photoCircle.cx} cy={photoCircle.cy} r={1.5} fill={CYAN} />
        </svg>
      )}

      {/* Adaptive scale bar — bottom-left. Length + label recomputed every frame from the
          live zoom, snapped to a nice round arcsec/arcmin value. */}
      {scaleBar && (
        <div
          data-overlay="scalebar"
          style={{
            position: "absolute", left: 14, bottom: 14, zIndex: 15,
            pointerEvents: "none", display: "flex", flexDirection: "column",
            alignItems: "center", gap: 3,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: "0.68rem", color: "#fff", letterSpacing: "0.03em",
              textShadow: "0 1px 3px rgba(0,0,0,0.9)",
            }}
          >
            {scaleBar.label}
          </span>
          <div
            style={{
              width: scaleBar.px, height: 7,
              borderLeft: "2px solid #fff", borderRight: "2px solid #fff",
              borderBottom: "3px solid #fff",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.9))",
            }}
          />
        </div>
      )}

      {/* Photometry results panel — bottom-left, above the scale bar. */}
      <PhotometryPanel state={photoState} onClose={closePhoto} />

      {/* SCALING panel — top-right, where FitsExplorer's View panel used to sit. Drives
          the trilogy stretch live via applyScaling (through the viewer handle). Stacked
          with the NIRSpec aperture panel in one top-right column so they never overlap. */}
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 15, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
        <ScalingPanel
          params={trilogy}
          mode={stretchMode}
          open={panelOpen}
          onToggle={() => setPanelOpen(o => !o)}
          onChange={patch => setTrilogy(p => ({ ...p, ...patch }))}
          onModeChange={setStretchMode}
          onReset={() => { setTrilogy(CAMPFIRE_TRILOGY); setStretchMode(DEFAULT_STRETCH_MODE); }}
        />
        <AperturePanel
          msaOn={msaOn} ifuOn={ifuOn} msaFieldOn={msaFieldOn} paDeg={paDeg} pinned={apertureSky != null}
          photoTool={photoTool} photoEnabled={photoEnabled}
          photoHint={session == null ? "sign in on /data/review to measure" : !isCeers ? "CEERS only for now" : ""}
          onPhotoTool={() => setPhotoTool(v => !v)}
          onMsa={setMsaOn} onIfu={setIfuOn} onMsaField={setMsaFieldOn} onPa={setPaDeg}
          onTogglePin={() => {
            setApertureSky(prev => {
              if (prev) return null;   // unpin → follow view centre
              // Pin to the CURRENT view centre's sky position.
              const h = handleRef.current;
              const cam = h?.getCameraState();
              const wcs = h?.getViewer()?.getWcs();
              if (cam && wcs) {
                const s = pixToSky(wcs, cam.centerX, cam.centerY);
                if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) return { ra: s.ra, dec: s.dec };
              }
              return prev;
            });
          }}
        />
      </div>
    </div>
  );
}

// ---- SCALING control panel -------------------------------------------------
// Compact, collapsible color-scaling panel pinned to the map's top-right. Each knob is a
// range slider (log-spaced for satpercent) with its live numeric value; changes stream
// straight to setTrilogy, which re-derives the stretch on the next paint. A "Reset to
// default" button restores the CAMPFIRE values. This replaces the built-in control panel
// FitsExplorer rendered on the right (which exposed the same trilogy knobs as rotary
// Knobs plus the RGB weight matrix / colormap / band rail — none of which the map needs,
// since the map's bands, weights and colormap are fixed).
function ScalingPanel({
  params, mode, open, onToggle, onChange, onModeChange, onReset,
}: {
  params: TrilogyParams;
  mode: StretchMode;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<TrilogyParams>) => void;
  onModeChange: (mode: StretchMode) => void;
  onReset: () => void;
}) {
  const isDefault =
    mode === DEFAULT_STRETCH_MODE &&
    SCALING_KNOBS.every(k => params[k.key] === CAMPFIRE_TRILOGY[k.key]);
  // noiselum only shapes the trilogy curve; hide it for the other transfer functions.
  const knobs = SCALING_KNOBS.filter(k => !k.trilogyOnly || mode === "trilogy");
  return (
    <div
      style={{
        width: open ? 224 : undefined,
        background: "rgba(13,10,26,0.86)", backdropFilter: "blur(6px)",
        border: "1px solid var(--border-bright)", borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)", overflow: "hidden",
      }}
    >
      <button
        onClick={onToggle}
        className="mono"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--accent)", fontSize: "0.72rem", letterSpacing: "0.08em",
          padding: "9px 11px",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", fontSize: "0.7rem" }}>▸</span>
        SCALING
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px" }}>
          {/* Transfer-curve (stretch-mode) selector. */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: "0.68rem", color: "var(--text)", fontWeight: 600, marginBottom: 3 }}>Stretch</div>
            <select
              aria-label="Stretch mode"
              value={mode}
              onChange={e => onModeChange(e.target.value as StretchMode)}
              className="mono"
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
                borderRadius: 5, color: "var(--accent)", fontSize: "0.7rem", padding: "5px 7px", cursor: "pointer",
              }}
            >
              {STRETCH_MODE_OPTS.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
            </select>
            <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 2 }}>
              {STRETCH_MODE_OPTS.find(o => o.mode === mode)?.hint}
            </div>
          </div>

          {knobs.map(k => {
            const val = params[k.key];
            // For a log slider, map the value to a 0..1000 position over [log(min),log(max)].
            const toPos = (v: number) =>
              k.log ? ((Math.log10(v) - Math.log10(k.min)) / (Math.log10(k.max) - Math.log10(k.min))) * 1000 : v;
            const fromPos = (p: number) =>
              k.log ? Math.pow(10, Math.log10(k.min) + (p / 1000) * (Math.log10(k.max) - Math.log10(k.min))) : p;
            return (
              <div key={k.key} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                  <span style={{ fontSize: "0.68rem", color: "var(--text)", fontWeight: 600 }}>{k.label}</span>
                  <span className="mono" style={{ fontSize: "0.68rem", color: "var(--accent)" }}>
                    {k.log ? val.toFixed(3) : val.toFixed(k.step < 0.01 ? 3 : 2)}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label={k.label}
                  min={k.log ? 0 : k.min}
                  max={k.log ? 1000 : k.max}
                  step={k.log ? 1 : k.step}
                  value={toPos(val)}
                  onChange={e => onChange({ [k.key]: fromPos(Number(e.target.value)) } as Partial<TrilogyParams>)}
                  style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer", height: 4 }}
                />
                <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 1 }}>{k.hint}</div>
              </div>
            );
          })}
          <button
            onClick={onReset}
            disabled={isDefault}
            className="mono"
            style={{
              width: "100%", marginTop: 2,
              background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
              color: isDefault ? "var(--text-dim)" : "var(--text-muted)",
              cursor: isDefault ? "default" : "pointer", opacity: isDefault ? 0.55 : 1,
              fontSize: "0.68rem", padding: "6px 10px",
            }}
          >
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}

// ---- NIRSpec aperture control panel ----------------------------------------
// Compact panel pinned under the SCALING panel (top-right). Toggles the MSA 3-shutter
// slitlet and the IFU 3"×3" overlays, a shared PA input (degrees, east-of-north, orients
// the slitlet long axis), and a pin that fixes the aperture at the current view centre's
// sky position (so panning no longer drags it) vs following the view centre.
function AperturePanel({
  msaOn, ifuOn, msaFieldOn, paDeg, pinned,
  photoTool, photoEnabled, photoHint, onPhotoTool,
  onMsa, onIfu, onMsaField, onPa, onTogglePin,
}: {
  msaOn: boolean;
  ifuOn: boolean;
  msaFieldOn: boolean;
  paDeg: number;
  pinned: boolean;
  /** Custom-aperture photometry draw tool: current on/off, whether it's usable, and — when
   *  not usable — a muted reason (not signed in / wrong field). */
  photoTool: boolean;
  photoEnabled: boolean;
  photoHint: string;
  onPhotoTool: () => void;
  onMsa: (v: boolean) => void;
  onIfu: (v: boolean) => void;
  onMsaField: (v: boolean) => void;
  onPa: (v: number) => void;
  onTogglePin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anyOn = msaOn || ifuOn || msaFieldOn;
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 9 };
  return (
    <div
      style={{
        width: open ? 224 : undefined,
        background: "rgba(13,10,26,0.86)", backdropFilter: "blur(6px)",
        border: "1px solid var(--border-bright)", borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)", overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="mono"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          color: photoTool ? "#38d0f0" : anyOn ? "#5ee0e0" : "var(--accent)", fontSize: "0.72rem", letterSpacing: "0.08em",
          padding: "9px 11px",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", fontSize: "0.7rem" }}>▸</span>
        APERTURES{anyOn || photoTool ? " ●" : ""}
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px" }}>
          {/* Custom-aperture photometry draw tool. Enabled only when signed in + on CEERS
              (the Worker is CEERS-only); otherwise a muted button + hint. */}
          <div style={{ marginBottom: 12, paddingBottom: 11, borderBottom: "1px solid var(--border)" }}>
            <button
              onClick={onPhotoTool}
              disabled={!photoEnabled}
              className="mono"
              aria-pressed={photoTool}
              style={{
                width: "100%",
                background: photoTool ? "rgba(56,208,240,0.16)" : "none",
                border: `1px solid ${photoTool ? "rgba(56,208,240,0.5)" : "var(--border-bright)"}`,
                borderRadius: 5,
                color: !photoEnabled ? "var(--text-dim)" : photoTool ? "#38d0f0" : "var(--text-muted)",
                cursor: photoEnabled ? "pointer" : "default", opacity: photoEnabled ? 1 : 0.6,
                fontSize: "0.7rem", padding: "6px 10px",
              }}
            >
              ⬤ Measure photometry{photoTool ? " · ON" : ""}
            </button>
            <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>
              {!photoEnabled
                ? photoHint
                : photoTool
                  ? "drag on the map to draw a circular aperture"
                  : "custom circular-aperture flux (CEERS)"}
            </div>
          </div>

          <label style={row}>
            <input type="checkbox" checked={msaOn} onChange={e => onMsa(e.target.checked)}
              style={{ accentColor: "#5ee0e0", width: 15, height: 15 }} />
            <span style={{ fontSize: "0.72rem", color: "var(--text)" }}>MSA 3-shutter slitlet</span>
          </label>
          <label style={row}>
            <input type="checkbox" checked={ifuOn} onChange={e => onIfu(e.target.checked)}
              style={{ accentColor: "#e078e0", width: 15, height: 15 }} />
            <span style={{ fontSize: "0.72rem", color: "var(--text)" }}>IFU (3″×3″)</span>
          </label>
          <label style={row}>
            <input type="checkbox" checked={msaFieldOn} onChange={e => onMsaField(e.target.checked)}
              style={{ accentColor: "#f0b050", width: 15, height: 15 }} />
            <span style={{ fontSize: "0.72rem", color: "var(--text)" }}>MSA field (4 quadrants)</span>
          </label>

          <div style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
              <span style={{ fontSize: "0.68rem", color: "var(--text)", fontWeight: 600 }}>PA (deg)</span>
              <span className="mono" style={{ fontSize: "0.68rem", color: "var(--accent)" }}>{paDeg.toFixed(0)}°</span>
            </div>
            <input
              type="range" aria-label="Position angle" min={0} max={360} step={1}
              value={((paDeg % 360) + 360) % 360}
              onChange={e => onPa(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer", height: 4 }}
            />
            <input
              type="number" aria-label="Position angle degrees" value={paDeg}
              onChange={e => onPa(Number(e.target.value))}
              style={{
                width: "100%", marginTop: 5, background: "var(--bg)",
                border: "1px solid var(--border-bright)", borderRadius: 5, color: "var(--text)",
                fontFamily: "'Space Mono', monospace", fontSize: "0.72rem", padding: "4px 7px",
              }}
            />
            <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 2 }}>east of north · orients the slit long axis</div>
          </div>

          <button
            onClick={onTogglePin}
            className="mono"
            style={{
              width: "100%", background: pinned ? "var(--accent-dim)" : "none",
              border: "1px solid var(--border-bright)", borderRadius: 5,
              color: pinned ? "var(--accent)" : "var(--text-muted)", cursor: "pointer",
              fontSize: "0.68rem", padding: "6px 10px",
            }}
          >
            {pinned ? "Pinned · click to follow view" : "Pin to view centre"}
          </button>
        </div>
      )}
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
