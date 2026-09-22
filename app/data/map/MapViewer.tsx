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
  type ColormapName,
} from "@fitsgl/core";
import FitsglControls, {
  RGB_WEIGHTED,
  RGB_SIMPLE,
  STACK_SW,
  STACK_LW,
  SW_BANDS,
  LW_BANDS,
  DEFAULT_STRETCH_MODE,
  isStackView,
  applyFitsglDisplay,
  singleBandSource,
  simpleRgbSource,
  weightedSource,
  weightsEqual,
  stackWeights,
  TRILOGY_KNOBS,
  type ViewSel,
  type ControlBand,
  type Weights,
} from "@/app/data/_card/FitsglControls";
import {
  loadField,
  loadFilters,
  corralBase,
  fieldCatDir,
  type FieldConfig,
  type FieldIndex,
  type NumCol,
} from "@/app/data/_card/objectCard";
import { supabase } from "@/lib/supabase";
import { measureAperture, abMagFromNJy, type PhotometryResult } from "@/lib/photometry";
import PhotometryPanel, { type MeasuredAperture, type PickedCatalog } from "./PhotometryPanel";
import { catalogBandsFromFilters } from "./PhotometrySED";
import { FILTER_WAVES } from "@/app/data/_card/objectCard";
import { makePredicate } from "@/app/data/search/page";   // reuse the Search query language on the map

type LoadState = "loading" | "ready" | "error";

// Overlay colors (priority): a campfire spec-z → green; else selected → yellow;
// else not selected → red.
const GREEN = "#43d17a";   // has a campfire spec-z
const YELLOW = "#f2d43a";  // selected (no spec-z)
const RED = "#e0503a";     // not selected
// Custom-aperture photometry draw tool: the IN-PROGRESS drag circle's stroke colour.
const CYAN = "#38d0f0";
// Fields the photometry Worker can measure (mosaics on Corral + wired in the Worker's
// per-field config). Extend as each field's SCI/ERR mosaics come online.
const PHOTO_FIELDS = new Set(["CEERS", "NGDEEP", "GOODS-S", "GOODS-N", "A2744", "PRIMER-UDS", "PRIMER-COSMOS", "EGS"]);
// Palette cycled across ACCUMULATED photometry apertures — each measured aperture takes the
// next colour (wrapping), shared by its map circle, its legend swatch and its SED series.
const PHOTO_PALETTE = ["#38d0f0", "#f2d43a", "#43d17a", "#e078e0", "#f0902d", "#8a7bff", "#e0503a", "#4dd6c0"];

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

// The scaling knobs + stretch-mode list + default stretch mode now live in the SHARED
// control component (FitsglControls) so the map and the per-field Fields viewer render the
// same panel; TRILOGY_KNOBS / DEFAULT_STRETCH_MODE are imported above.

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

// Full NIRSpec focal plane, SIAF-exact (pysiaf NIRSpec PRD, extracted in the MSA ideal frame
// and mapped to our (dispersion d, spatial s) arcsec axes via d = −Xidl, s = +Yidl — the
// handedness calibrated against pysiaf's Idl→sky transform: at aperture PA=0, +s is North and
// +d is EAST (+Xidl points West, so d=−Xidl points East — verified end-to-end against a pysiaf
// attitude transform, worst-case overlay error 0.017″). Do NOT "correct" this to West: that
// would mirror the entire overlay. All positions are relative to the NRS_FULL_MSA reference, so the whole assembly
// pins to one sky point + PA. The 4 MSA quadrants (2×2, each ≈98″×92″, in the corners), the
// central band of fixed slits, and the 3″×3″ IFU all sit in fixed relative positions.
const MSA_QUADS_DS: [number, number][][] = [
  [[-109.898, 110.378], [-109.168, 18.91], [-11.304, 18.527], [-11.39, 109.951]],
  [[-109.194, -18.13], [-108.652, -107.731], [-11.527, -107.988], [-11.586, -18.484]],
  [[11.667, 109.931], [11.598, 18.525], [109.436, 18.814], [110.158, 110.256]],
  [[11.595, -18.469], [11.533, -107.965], [108.638, -107.798], [109.19, -18.208]],
];
// Fixed slits (S200A1/A2, S400A1, S1600A1 on one side; S200B1 on the other).
const MSA_SLITS_DS: { label: string; ds: [number, number][] }[] = [
  { label: "S200A1",  ds: [[68.678, 8.891], [68.663, 5.61], [68.855, 5.61], [68.871, 8.892]] },
  { label: "S200A2",  ds: [[88.3, 5.19], [88.28, 1.88], [88.474, 1.881], [88.494, 5.191]] },
  { label: "S400A1",  ds: [[75.417, 1.352], [75.398, -2.416], [75.793, -2.414], [75.812, 1.353]] },
  { label: "S1600A1", ds: [[72.24, -3.034], [72.232, -4.641], [73.831, -4.635], [73.839, -3.028]] },
  { label: "S200B1",  ds: [[-88.512, -5.166], [-88.493, -8.475], [-88.291, -8.476], [-88.311, -5.167]] },
];
// NIRSpec IFU 3″×3″ aperture (NRS_FULL_IFU), in its true position beyond the A slits.
const MSA_IFU_DS: [number, number][] = [[103.527, 1.916], [103.506, -1.284], [106.603, -1.268], [106.625, 1.932]];

// Other JWST instruments' footprints, precomputed in the SAME (d,s) frame as the MSA above
// (scripts/make_siaf_footprints.py → public/nirspec/siaf_footprints.json). Each aperture is a
// polygon of [d,s] arcsec corners; instruments sit at their true focal-plane offsets from the
// MSA reference, so drawing them at the MSA pin + PA reproduces the real JWST field layout.
type SiafFootprints = {
  instruments: { key: string; label: string; color: string;
    apertures: { name: string; ds: [number, number][] }[] }[];
};
// Centre (d,s arcsec) of a named fixed slit — used to place the map-centred galaxy in a slit.
function slitCenterDS(label: string): [number, number] {
  const sl = MSA_SLITS_DS.find((x) => x.label === label);
  if (!sl) return [0, 0];
  let md = 0, ms = 0;
  for (const [d, s] of sl.ds) { md += d; ms += s; }
  return [md / sl.ds.length, ms / sl.ds.length];
}
// NIRSpec MSA V3IdlYAngle from pysiaf (NRS_FULL_MSA) — the angle between the aperture's ideal
// Y axis and the telescope V3 axis. APT's aperture PA relates to the observatory V3PA by
// APA = V3PA + V3IdlYAngle, so V3PA = (aperture PA) − 138.5746°. Our PA slider IS the aperture
// PA (on-sky, E of N), so this converts the shown PA to the JWST V3PA to request in APT.
const NRS_MSA_V3IDLYANGLE = 138.5746;

// ---- Allowed-PA lookup (per-field, from scripts/make_nirspec_v3pa.py) -------
// Static JSON in public/nirspec/v3pa/<fieldid>.json. `samples` is the per-observable-day
// achievability series: [dayOffsetFromBaseDate, nominalV3PA_deg, rollHalfwidth_deg]. On
// that day the achievable V3PA is nominalV3PA ± roll (=> APA = V3PA + v3idlyangle). This is
// exactly the panel's PA control (which IS the APA). See the script header for the full
// convention derivation (verified against pysiaf SIAF + jwst_gtvt).
type V3paData = {
  field: string; base_date: string; v3idlyangle: number; prd: string;
  windows: { start: string; end: string }[];
  samples: [number, number, number][];
};
// Smallest signed angular difference a−b in (−180,180].
function angDiff(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
// Given a target APA (deg, E of N — the panel's PA), decide whether some observable day can
// achieve it, and gather the achievable date spans. Returns achievable flag, the matching
// date windows, and — if not achievable — the nearest achievable APA (with its dates).
function achievability(data: V3paData, apaDeg: number): {
  achievable: boolean;
  dates: { start: string; end: string }[];
  nearestApa: number | null;
  nearestDates: { start: string; end: string }[];
} {
  const wantV3pa = apaDeg - data.v3idlyangle;   // APA -> V3PA
  const base = new Date(data.base_date + "T00:00:00Z").getTime();
  const iso = (dayOff: number) => new Date(base + dayOff * 86400000).toISOString().slice(0, 10);
  // Which samples cover wantV3pa within their ±roll band? Merge contiguous days into spans.
  const hitDays: number[] = [];
  let best = { miss: Infinity, apa: 0, day: -1 };
  for (const [day, nom, roll] of data.samples) {
    const miss = Math.abs(angDiff(wantV3pa, nom));
    if (miss <= roll + 1e-6) hitDays.push(day);
    // Nearest achievable APA on any day: clamp wantV3pa to [nom−roll, nom+roll].
    const clamped = Math.max(-roll, Math.min(roll, angDiff(wantV3pa, nom)));
    const overshoot = Math.abs(angDiff(wantV3pa, nom)) - roll;   // how far outside the band
    if (overshoot < best.miss) best = { miss: overshoot, apa: ((nom + clamped + data.v3idlyangle) % 360 + 360) % 360, day };
  }
  const spans = (days: number[]) => {
    const out: { start: string; end: string }[] = [];
    days.sort((a, b) => a - b);
    for (const d of days) {
      const last = out[out.length - 1];
      if (last && new Date(iso(d)).getTime() - new Date(last.end).getTime() <= 86400000) last.end = iso(d);
      else out.push({ start: iso(d), end: iso(d) });
    }
    return out;
  };
  if (hitDays.length) return { achievable: true, dates: spans(hitDays), nearestApa: null, nearestDates: [] };
  // Not achievable at any date: report nearest achievable APA + the day(s) that get closest.
  const nearestApa = data.samples.length ? Math.round(best.apa * 10) / 10 : null;
  const nearDays = data.samples.filter(([, nom, roll]) =>
    Math.abs(Math.abs(angDiff(wantV3pa, nom)) - roll) <= best.miss + 0.5).map(([d]) => d);
  return { achievable: false, dates: [], nearestApa, nearestDates: spans(nearDays) };
}

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
// Coordinate convention (must match every other overlay so nothing drifts):
//  1. `skyToPix` already returns fitsgl WORLD coordinates (per @fitsgl/core: world (0,0) is
//     the top-left pixel CORNER, pixel centres at +0.5, and skyToPix folds the FITS-1-based
//     CRPIX in via its own -0.5). `imageToScreen` is the exact inverse of that world space,
//     so `imageToScreen(skyToPix(ra,dec))` lands on the source with NO extra offset. (A prior
//     spurious +0.5 here shifted every overlay half a native pixel off the rendered image —
//     Mark Dickinson's off-centre ellipses. Do NOT re-add it.)
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
    const p = h.imageToScreen(wx, wy);   // no offset: skyToPix world coords register 1:1 with the image
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
// screen {x,y}.
function apXY(f: ApFrame, dArcsec: number, sArcsec: number): { x: number; y: number } {
  return {
    x: f.cx + f.disp.x * dArcsec + f.spat.x * sArcsec,
    y: f.cy + f.disp.y * dArcsec + f.spat.y * sArcsec,
  };
}
// …as an SVG-polygon "x,y" string.
function apPt(f: ApFrame, dArcsec: number, sArcsec: number): string {
  const p = apXY(f, dArcsec, sArcsec);
  return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}
// A polygon from explicit (d,s) corners (arcsec in the aperture frame) → "x,y x,y …".
function apPoly(f: ApFrame, corners: readonly (readonly [number, number])[]): string {
  return corners.map(([d, s]) => apPt(f, d, s)).join(" ");
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

// ---- MSA-field point-in-quadrant collection (WORLD/pixel space) -------------
// A 2-D vector in WORLD PIXELS (the fitsgl camera's native grid), used to build the MSA
// quadrant corners in the SAME space the catalog sources live in (each Src has world px
// x,y). This is deliberately NOT screen space: testing in world px means EVERY catalog
// source is tested (not just the on-screen ones), so the collected set is complete.
type Vec2 = { x: number; y: number };

// The aperture frame in WORLD PIXELS: the quadrant-centre world px + the per-arcsec world-px
// vectors along the dispersion and spatial axes (already carrying PA + the WCS N/E
// orientation, mirroring apertureFrame but in world px rather than screen px). Built by
// projecting the centre and two 1″ N/E offsets through skyToPix and combining by PA — the
// exact analogue of apertureFrame's screen basis.
type ApFrameWorld = { cx: number; cy: number; disp: Vec2; spat: Vec2 };
function apertureFrameWorld(
  wcs: NonNullable<ReturnType<NonNullable<ReturnType<FitsViewerHandle["getViewer"]>>["getWcs"]>>,
  center: { ra: number; dec: number },
  paDeg: number,
): ApFrameWorld | null {
  const c = skyToPix(wcs, center.ra, center.dec);
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
  const dDeg = 1 / 3600; // 1″ step
  const north = skyToPix(wcs, center.ra, center.dec + dDeg);
  const east = skyToPix(wcs, center.ra + dDeg / Math.cos((center.dec * Math.PI) / 180), center.dec);
  const nVec: Vec2 = { x: north.x - c.x, y: north.y - c.y };   // 1″ north, in world px
  const eVec: Vec2 = { x: east.x - c.x, y: east.y - c.y };     // 1″ east
  if (!(Math.hypot(nVec.x, nVec.y) > 0) || !(Math.hypot(eVec.x, eVec.y) > 0)) return null;
  // Spatial axis points along PA (east-of-north): cos·N + sin·E. Dispersion is PA+90°.
  const pa = (paDeg * Math.PI) / 180;
  const cs = Math.cos(pa), sn = Math.sin(pa);
  return {
    cx: c.x, cy: c.y,
    spat: { x: cs * nVec.x + sn * eVec.x, y: cs * nVec.y + sn * eVec.y },
    disp: { x: -sn * nVec.x + cs * eVec.x, y: -sn * nVec.y + cs * eVec.y },
  };
}

// The 4 world-pixel corners of one MSA quadrant centred at (dCenter,sCenter) arcsec in the
// aperture frame, half-extent (halfDisp,halfSpat) arcsec — the world-px analogue of apRectAt.
function quadCornersWorld(f: ApFrameWorld, dCenter: number, halfDisp: number, sCenter: number, halfSpat: number): Vec2[] {
  const at = (d: number, s: number): Vec2 => ({
    x: f.cx + f.disp.x * d + f.spat.x * s,
    y: f.cy + f.disp.y * d + f.spat.y * s,
  });
  return [
    at(dCenter - halfDisp, sCenter - halfSpat),
    at(dCenter + halfDisp, sCenter - halfSpat),
    at(dCenter + halfDisp, sCenter + halfSpat),
    at(dCenter - halfDisp, sCenter + halfSpat),
  ];
}

// World-pixel corners from explicit (d,s) arcsec corners — the world-px analogue of apPoly,
// used to point-in-poly the SIAF-exact MSA quadrants against every catalog source.
function polyCornersWorld(f: ApFrameWorld, corners: readonly (readonly [number, number])[]): Vec2[] {
  return corners.map(([d, s]) => ({
    x: f.cx + f.disp.x * d + f.spat.x * s,
    y: f.cy + f.disp.y * d + f.spat.y * s,
  }));
}

// Standard ray-cast point-in-polygon (works for any simple polygon; each quadrant is a
// convex rotated rectangle, so this is exact). `poly` is a CCW/CW loop of world-px corners.
function pointInPoly(px: number, py: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const hit = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// ---- Filter model ----------------------------------------------------------
export type MapFilters = {
  selectedOnly: boolean;
  zMin: number | null;
  zMax: number | null;
  magMin: number | null;
  magMax: number | null;
  magFilter: string;
  query: string;            // free-form Search-style query (za/zspec/m444/… — base index cols)
};
export const DEFAULT_FILTERS: MapFilters = {
  selectedOnly: false, zMin: null, zMax: null, magMin: null, magMax: null, magFilter: "F277W", query: "",
};

// One query-evaluable row from the base index at position i (the numeric built-ins the query
// language understands directly; per-band mag/snr/flux/colors need the lazy filters file and
// aren't available here). Keys match the Search column names so makePredicate/colGetter read them.
type QRow = Record<string, number | null>;
function idxQueryRow(idx: FieldIndex, i: number): QRow {
  const g = (c: NumCol | undefined) => (c ? (c[i] ?? null) : null);
  return {
    za: g(idx.za), zspec: g(idx.zspec), m277: g(idx.m277), m444: g(idx.m444),
    m1500: g(idx.m1500), m1300: g(idx.m1300), mabs: g(idx.mabs), beta: g(idx.beta),
    chia: g(idx.chia), z_lowz: g(idx.z_lowz), zl68: g(idx.zl68), zu68: g(idx.zu68),
    selected: g(idx.selected), inspected: g(idx.inspected), sample: g(idx.sample),
  };
}

// A source that passed the active filters, with the geometry needed to draw it.
type Src = {
  i: number; id: number; sel: boolean;
  x: number; y: number;               // world-pixel centre (from index x/y; overwritten from ra/dec for tiled fields)
  ra: number; dec: number;            // sky position — used to resolve world px on tiled fields
  semiA: number; semiB: number; th: number;  // ellipse semi-axes (px) + PA (rad); th=NaN → circle
};

// Precompute the filtered source list (positions + ellipse params). Recomputed only
// when the index, mag column, or filters change — NOT per frame.
function filterSources(idx: FieldIndex, magCol: NumCol, f: MapFilters, pred: ((r: QRow) => boolean) | null): Src[] {
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
    // Free-form query (za/zspec/m444/… on the base index) — applied last so it only runs on
    // sources that pass the cheap range filters.
    if (pred && !pred(idxQueryRow(idx, i))) continue;
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
  primaryId,
  rawMarkers,
}: {
  /** The active field's config — drives which search index the overlay loads. */
  field: FieldConfig;
  configUrl: string;
  filters: MapFilters;
  /** The object a search deep-linked to (?id=): drawn with a persistent white box so it
   *  stays identifiable at any zoom. null when the map wasn't opened for a specific object. */
  primaryId?: number | null;
  /** Search → map handoff: when non-null, draw ONLY sources whose id ∈ this set (the
   *  queried objects for the active field). When null, draw every source (default). */
  queuedIds?: Set<number> | null;
  /** Ids (this field) that have a campfire spec-z — drawn green, overriding selected/not. */
  zspecIds?: Set<number> | null;
  /** Upload → map: arbitrary user-supplied sky positions to plot as-is (not catalog objects),
   *  drawn as bright diamonds pinned to sky. Used for MSA planning against an external target list. */
  rawMarkers?: [number, number][] | null;
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
  // What point the MSA rotates ABOUT when PA changes: "view" (screen centre — your target, the
  // default), "ref" (the MSA reference / field centre, d=s=0), or a fixed-slit label (keep that
  // slit pinned on the sky as you roll). Held-fixed point is resolved in handlePaChange.
  const [rotateAbout, setRotateAbout] = useState<string>("view");
  // Per-field allowed-PA lookup (public/nirspec/v3pa/<id>.json). null = none / still loading;
  // when absent the panel behaves exactly as before (no achievability flag).
  const [v3paData, setV3paData] = useState<V3paData | null>(null);
  const [apertureSky, setApertureSky] = useState<{ ra: number; dec: number } | null>(null);
  // NIRSpec aperture is now always PLACED at a sky position (apertureSky, set to the view
  // centre when first enabled) rather than following the view. `apLocked` (the pin button)
  // just hides the drag handle so the map pans freely — it never moves the aperture. The
  // aperture's screen centre (from project()) drives the drag handle; apDragRef = mid-drag.
  const [apLocked, setApLocked] = useState(false);
  const [apCenterScreen, setApCenterScreen] = useState<{ cx: number; cy: number } | null>(null);
  const apDragRef = useRef(false);
  // Screen-space polygons for the active apertures, recomputed each frame in project().
  const [apertures, setApertures] = useState<{
    msa: string[]; ifu: string | null; field: string[];
    slits: { label: string; pts: string; lx: number; ly: number }[];
    fieldIfu: { pts: string; lx: number; ly: number } | null;
    fp: { key: string; color: string; polys: string[]; lx: number; ly: number;
      off: { x: number; y: number; arcmin: number } | null }[];
  }>({ msa: [], ifu: null, field: [], slits: [], fieldIfu: null, fp: [] });
  // ---- JWST instrument footprints (SIAF, all in the NRS_FULL_MSA ideal frame) --------------
  // The whole focal plane pins at one sky point and rotates by the shared aperture PA, so every
  // instrument co-registers with the NIRSpec MSA and rolls correctly with V3PA. Data:
  // public/nirspec/siaf_footprints.json (scripts/make_siaf_footprints.py). `footprints` = the
  // set of instrument keys currently shown.
  const [siaf, setSiaf] = useState<SiafFootprints | null>(null);
  const [footprints, setFootprints] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    fetch("/unicorn/nirspec/siaf_footprints.json")
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j?.instruments) setSiaf(j as SiafFootprints); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Catalog sources whose world-px position falls inside any of the 4 MSA quadrants at the
  // current centre + PA. Collected in WORLD/pixel space (ALL sources tested, not just the
  // on-screen ones) whenever the MSA-field overlay is on; drives the "N in MSA" readout +
  // the CSV / results-table handoff. Each carries id + sky pos (+ za / mag for the CSV).
  const [msaSources, setMsaSources] = useState<{ id: number; ra: number; dec: number; za: number | null; mag: number | null }[]>([]);

  // ---- Custom-aperture photometry draw tool ---------------------------------
  // The tool is enabled only when the user is signed in (Supabase session) AND the active
  // field is CEERS (the Worker is CEERS-only). `photoTool` toggles the draw mode on/off.
  const [session, setSession] = useState<import("@supabase/supabase-js").Session | null>(null);
  const [photoTool, setPhotoTool] = useState(false);
  const photoToolRef = useRef(false);
  photoToolRef.current = photoTool;
  // Which shape the Measure tool draws while it's ON: a drag CIRCLE (mousedown centre →
  // drag radius) or a hand-drawn POLYGON (click vertices → double-click / Enter to close).
  const [photoShape, setPhotoShape] = useState<"circle" | "polygon">("circle");
  const photoFieldOk = PHOTO_FIELDS.has(field.field);
  const photoEnabled = session != null && photoFieldOk;
  // `draw` holds the IN-PROGRESS drag (its sky centre + radius, re-pinned each frame). On
  // release it becomes a new entry in the ACCUMULATED aperture list `photoAps` — measurements
  // don't replace each other, they stack (each with a palette colour) until Clear.
  const [draw, setDraw] = useState<{ ra: number; dec: number; radiusArcsec: number } | null>(null);
  // The IN-PROGRESS polygon while shape=polygon: the vertices dropped so far (sky [ra,dec]
  // degrees), plus the live cursor sky position for the rubber-band edge back to the first
  // vertex. Null when no polygon is being drawn. On close (double-click / Enter, ≥3 verts) it
  // becomes a new accumulated aperture; Esc cancels it. Re-projected each frame like circles.
  const [polyDraw, setPolyDraw] = useState<{ verts: [number, number][]; cursor: { ra: number; dec: number } | null } | null>(null);
  // Every measured aperture, in draw order. Each carries its sky centre + radius (so project()
  // re-pins its circle every frame, welded to its sky pixel like the ellipses), its 1-based
  // index `n`, palette `color`, and its measurement state (measuring / done / error).
  const [photoAps, setPhotoAps] = useState<MeasuredAperture[]>([]);
  // Screen-space projections of ALL accumulated apertures' circles (centre px + radius px +
  // colour), rebuilt each frame in project() from each sky centre — plus the in-progress drag.
  const [photoCircles, setPhotoCircles] = useState<{ cx: number; cy: number; r: number; color: string }[]>([]);
  // Screen-space projections of ALL accumulated polygon apertures (their vertex "x,y" point
  // string + colour), rebuilt each frame in project() from each sky vertex — plus the
  // in-progress polygon (its drawn edges as a point string, its rubber-band edge to the
  // cursor, and its vertex dots), so hand-drawn apertures stay welded on pan/zoom like circles.
  const [photoPolys, setPhotoPolys] = useState<{ points: string; color: string; closed: boolean; dots: { x: number; y: number }[]; rubber: string | null }[]>([]);
  // Screen-space markers for the picked catalog objects (centre px + colour), rebuilt each
  // frame in project() from each pick's sky position so they stay welded on pan/zoom.
  const [catalogMarks, setCatalogMarks] = useState<{ cx: number; cy: number; color: string }[]>([]);
  // The deep-linked "primary" object's screen position — a persistent white box (see project()).
  const [primaryMark, setPrimaryMark] = useState<{ cx: number; cy: number } | null>(null);
  const primaryIdRef = useRef<number | null>(primaryId ?? null);
  useEffect(() => { primaryIdRef.current = primaryId ?? null; setPrimaryMark(null); }, [primaryId]);
  // Raw uploaded markers (arbitrary sky positions, not catalog objects) — projected each frame.
  const [rawMarks, setRawMarks] = useState<{ cx: number; cy: number }[]>([]);
  const rawMarkersRef = useRef<[number, number][] | null>(rawMarkers ?? null);
  rawMarkersRef.current = rawMarkers ?? null;
  // PHOTOMETRY panel expand/collapse (its own section beside SCALING / NIRSpec).
  const [photoPanelOpen, setPhotoPanelOpen] = useState(false);
  // Monotonic aperture index; assigned on each measurement so its async result patch can
  // match the exact entry. Reset to 0 by Clear so the legend re-numbers from #1.
  const photoSeqRef = useRef(0);

  // ---- "Show catalog objects" mode ------------------------------------------
  // A separate mode (mutually exclusive with the draw tool) that turns every catalog ellipse
  // into a picker: while ON, a click overlays that object's NATIVE catalog photometry (from
  // loadFilters) on the SED as a distinct hollow/dashed "catalog" series instead of opening
  // the ResultCard. Not gated on sign-in/CEERS — any field with per-band flux data works.
  const [catalogMode, setCatalogMode] = useState(false);
  // The picked catalog objects, in pick order, each carrying its id + palette colour + native
  // per-band fluxes (+ z_a / M_UV for the legend). Cleared by Clear (and per-object by the ✕).
  const [catalogPicks, setCatalogPicks] = useState<PickedCatalog[]>([]);
  // Monotonic index used only to cycle the palette across catalog picks (independent of the
  // measured-aperture counter so the two never collide on a colour). Reset to 0 by Clear.
  const catalogSeqRef = useRef(0);
  // The per-band native flux table for this field (loadFilters), fetched lazily the first time
  // a catalog object is picked and cached for the session. null until loaded / if unavailable.
  const filtersTableRef = useRef<Record<string, NumCol> | null>(null);

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
  // View mode: RGB-weighted composite (default) / simple 3-band RGB / a single band by name.
  // Switching swaps the viewer's render source; single-band adds colormap + a percentile
  // black/white window (null = auto from the band's precomputed trilogy stats).
  const [view, setView] = useState<ViewSel>(RGB_WEIGHTED);
  const [colormap, setColormap] = useState<ColormapName>("gray");
  const [percentile, setPercentile] = useState<{ lo: number; hi: number } | null>(null);
  // Per-band (R,G,B) weights for the weighted composite. Seeded from the producer default
  // once `prep` loads (see the effect below), so the map opens on the exact ship colour.
  const [weights, setWeights] = useState<Weights>({ bands: [], map: {} });
  // Band order currently loaded into the viewer's multiband source (from the last setSource)
  // — lets a weight-only change use the fast setBandWeights path and keeps applyTrilogy's
  // stats in matching order. Declared here (before the prep-seed effect that primes it).
  const appliedBandsRef = useRef<string[]>([]);

  const clickRef = useRef(onSourceClick);
  useEffect(() => { clickRef.current = onSourceClick; }, [onSourceClick]);
  const countRef = useRef(onCount);
  useEffect(() => { countRef.current = onCount; }, [onCount]);
  const readyHandleRef = useRef(onReadyHandle);
  useEffect(() => { readyHandleRef.current = onReadyHandle; }, [onReadyHandle]);

  // Load this field's allowed-PA lookup. Prefer the per-field copy make_web_index emits into the
  // field's Corral web/ dir (<prefix>_v3pa.json — automatic for new fields), then fall back to the
  // committed Pages copy (public/nirspec/v3pa/<id>.json from scripts/make_nirspec_v3pa.py). Missing
  // in both is fine — the panel simply shows no achievability flag.
  useEffect(() => {
    let alive = true;
    setV3paData(null);
    const id = field.field.toLowerCase();   // "CEERS" -> "ceers", "GOODS-S" -> "goods-s"
    const urls = [
      `${corralBase()}/${fieldCatDir(field)}/web/${field.prefix}_v3pa.json`,
      `/unicorn/nirspec/v3pa/${id}.json`,
    ];
    (async () => {
      for (const url of urls) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            const d = await r.json();
            if (alive && d && Array.isArray(d.samples)) { setV3paData(d as V3paData); return; }
          }
        } catch { /* try the next source */ }
        if (!alive) return;
      }
    })();
    return () => { alive = false; };
  }, [field.field, field.prefix, field.dir]);

  const handleRef = useRef<FitsViewerHandle | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The last freely-viewed camera (centre + zoom), captured each frame in project() while no
  // goto/deep-link target is pending. Used to restore the view after the browser tab is
  // backgrounded and refocused — browsers can drop the WebGL context (or zero the drawing
  // buffer) while hidden, and fitsgl then re-fits the whole mosaic on return.
  const lastCamRef = useRef<{ cx: number; cy: number; zoom: number } | null>(null);
  // WebGL context-loss recovery. @fitsgl/core doesn't handle context loss, so a backgrounded
  // tab that loses the GL context comes back broken. We detect the loss and, on return, remount
  // the <FitsViewer> (bump viewerKey) for a clean re-init — overlays/filters are React state and
  // survive; the camera restores through cameraTargetRef's adopt-and-hold on the new onReady.
  const [viewerKey, setViewerKey] = useState(0);
  const contextLostRef = useRef(false);
  // The current filtered source list, held in a ref so the per-frame projector reads
  // the latest without being a hook dependency (projection must not re-subscribe onFrame).
  const sourcesRef = useRef<Src[]>([]);
  // The loaded index in a ref so the per-frame MSA-quadrant collector can read za / mag
  // (parallel arrays) at each source's position without re-subscribing project().
  const idxRef = useRef<FieldIndex | null>(null);
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
  const prep = useMemo<{
    viewer: ViewerConfig;
    // The band list the view selector offers (name + label + stats + wavelength for rainbow).
    bands: ControlBand[];
    // Per-band precomputed trilogy stats by name — every mode derives its levels from these.
    bandStats: Record<string, TrilogyStats | undefined>;
    // The producer default weighted composite (map + ordered bands) — the ship colour.
    defaultWeights: Weights;
    // The simple 3-band RGB triple (producer default_rgb).
    rgbTriple: { r: string; g: string; b: string };
    // Precomputed grayscale stack weights for the SW/LW NIRCam groups present in this field
    // (null when the group has no bands here → its preset is hidden).
    swStack: Weights | null;
    lwStack: Weights | null;
  } | null>(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    // Start from CAMPFIRE's scaling (recomputed from each field's own per-band stats) so
    // the map opens matching campfire / the card cutouts; the panel tunes from here.
    st.trilogyParams = { ...st.trilogyParams, ...CAMPFIRE_TRILOGY };
    const viewer = deriveViewerConfig(bands, st);
    const bandStats: Record<string, TrilogyStats | undefined> = {};
    for (const b of bands) bandStats[b.name] = b.trilogy;
    const controlBands: ControlBand[] = bands.map(b => ({
      name: b.name, label: b.label ?? b.name, trilogy: b.trilogy, wavelengthMicron: b.wavelengthMicron,
    }));
    // Producer weighted composite: state.weightBands/weights when the config shipped a
    // weighted default; else fall back to the rgb triple as three pure-channel weights.
    const rgbTriple = { r: st.rgb.r, g: st.rgb.g, b: st.rgb.b };
    const defaultWeights: Weights = st.weightBands.length
      ? { bands: [...st.weightBands], map: { ...st.weights } }
      : { bands: [rgbTriple.r, rgbTriple.g, rgbTriple.b], map: { [rgbTriple.r]: [1, 0, 0], [rgbTriple.g]: [0, 1, 0], [rgbTriple.b]: [0, 0, 1] } };
    const swStack = stackWeights(controlBands, SW_BANDS);
    const lwStack = stackWeights(controlBands, LW_BANDS);
    return { viewer, bands: controlBands, bandStats, defaultWeights, rgbTriple, swStack, lwStack };
  }, [config]);
  const viewerConfig = prep?.viewer ?? null;
  const controlBands = prep?.bands ?? [];
  // The default look = RGB-weighted + campfire trilogy + producer default weights. Drives the
  // "Reset to default" enabled state.
  const isDefaultLook =
    view === RGB_WEIGHTED && stretchMode === DEFAULT_STRETCH_MODE &&
    TRILOGY_KNOBS.every(k => trilogy[k.key] === CAMPFIRE_TRILOGY[k.key]) &&
    (prep ? weightsEqual(weights, prep.defaultWeights) : true);
  // Per-band stats + the simple-RGB triple, read imperatively (no re-subscribe).
  const bandStatsRef = useRef<Record<string, TrilogyStats | undefined>>({});
  const rgbTripleRef = useRef<{ r: string; g: string; b: string } | null>(null);
  // Precomputed SW/LW grayscale stack weights, read imperatively in switchSource/applyScaling.
  const stacksRef = useRef<{ [STACK_SW]: Weights | null; [STACK_LW]: Weights | null }>({ [STACK_SW]: null, [STACK_LW]: null });
  useEffect(() => {
    bandStatsRef.current = prep?.bandStats ?? {};
    rgbTripleRef.current = prep?.rgbTriple ?? null;
    stacksRef.current = { [STACK_SW]: prep?.swStack ?? null, [STACK_LW]: prep?.lwStack ?? null };
  }, [prep]);
  // Seed the weighted-composite weights from the producer default once prep loads (or when
  // the field changes). This is what makes the map open on the exact ship colour. Also seed
  // appliedBandsRef so the poke-loop applyScaling has the right stats order before the first
  // switchSource runs (the mounted config default already holds this band order).
  useEffect(() => {
    if (!prep) return;
    setWeights(prep.defaultWeights);
    appliedBandsRef.current = [...prep.defaultWeights.bands];
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
  const apRef = useRef({ msaOn, ifuOn, msaFieldOn, paDeg, apertureSky, rotateAbout, footprints, siaf });
  apRef.current = { msaOn, ifuOn, msaFieldOn, paDeg, apertureSky, rotateAbout, footprints, siaf };

  // When an aperture is first switched on, PLACE it (a fixed sky pos) so it's a positioned,
  // draggable object — not something that follows the view. For the MSA field, offset the
  // reference so the S200A1 fixed slit lands on the view centre (the galaxy the map is centred
  // on); otherwise centre the aperture itself. Once set it stays put.
  useEffect(() => {
    if (!(msaOn || ifuOn || msaFieldOn || footprints.size > 0) || apertureSky) return;
    const h = handleRef.current;
    const cam = h?.getCameraState();
    const wcs = h?.getViewer()?.getWcs();
    if (!cam || !wcs) return;
    const vsky = pixToSky(wcs, cam.centerX, cam.centerY);
    if (!Number.isFinite(vsky.ra) || !Number.isFinite(vsky.dec)) return;
    if (!msaFieldOn) { setApertureSky({ ra: vsky.ra, dec: vsky.dec }); return; }
    const [sd, ss] = slitCenterDS("S200A1");
    const fr = apertureFrameWorld(wcs, vsky, paDeg);       // disp/spat directions at current PA
    if (!fr) { setApertureSky({ ra: vsky.ra, dec: vsky.dec }); return; }
    const cx = cam.centerX - (fr.disp.x * sd + fr.spat.x * ss);   // ref px s.t. S200A1 = view centre
    const cy = cam.centerY - (fr.disp.y * sd + fr.spat.y * ss);
    const s = pixToSky(wcs, cx, cy);
    if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) setApertureSky({ ra: s.ra, dec: s.dec });
  }, [msaOn, ifuOn, msaFieldOn, footprints, apertureSky, paDeg]);

  // Rotate ABOUT a chosen pivot: on a PA change, keep one point fixed on the sky and swing the
  // rest of the MSA around it. The pivot (per the "Rotate about" dropdown) is either the point
  // currently at the VIEW CENTRE ("view", default — a galaxy centred in a slit stays in it), the
  // MSA REFERENCE ("ref", d=s=0 — the field centre of the MSA footprint), or a FIXED SLIT (keep
  // that slit pinned on the sky). We take the pivot's current screen pixel, solve its (d,s) in the
  // old frame, then reposition the reference so that same (d,s) lands back on that pixel at the new PA.
  const handlePaChange = useCallback((newPa: number) => {
    const h = handleRef.current;
    const wcs = h?.getViewer()?.getWcs();
    const cam = h?.getCameraState();
    const sky = apRef.current.apertureSky;
    if (!h || !wcs || !cam || !sky) { setPaDeg(newPa); return; }
    const oldF = apertureFrameWorld(wcs, sky, apRef.current.paDeg);
    if (!oldF) { setPaDeg(newPa); return; }
    const k2 = oldF.disp.x * oldF.disp.x + oldF.disp.y * oldF.disp.y;   // px²/arcsec² (disp⊥spat, equal scale)
    if (!(k2 > 0)) { setPaDeg(newPa); return; }
    // Pixel to hold fixed under the rotation.
    const about = apRef.current.rotateAbout;
    let pivotX = cam.centerX, pivotY = cam.centerY;   // "view" (default)
    if (about !== "view") {
      const [dP, sP] = about === "ref" ? [0, 0] : slitCenterDS(about);
      pivotX = oldF.cx + oldF.disp.x * dP + oldF.spat.x * sP;
      pivotY = oldF.cy + oldF.disp.y * dP + oldF.spat.y * sP;
    }
    const ox = pivotX - oldF.cx, oy = pivotY - oldF.cy;
    const d = (ox * oldF.disp.x + oy * oldF.disp.y) / k2;
    const s = (ox * oldF.spat.x + oy * oldF.spat.y) / k2;
    const newF = apertureFrameWorld(wcs, sky, newPa);      // new-PA disp/spat directions
    if (!newF) { setPaDeg(newPa); return; }
    const cx = pivotX - (newF.disp.x * d + newF.spat.x * s);
    const cy = pivotY - (newF.disp.y * d + newF.spat.y * s);
    const ns = pixToSky(wcs, cx, cy);
    if (Number.isFinite(ns.ra) && Number.isFinite(ns.dec)) setApertureSky({ ra: ns.ra, dec: ns.dec });
    setPaDeg(newPa);
  }, []);

  // Choosing "rotate about" = a fixed slit ALSO snaps that slit onto the current target (view
  // centre), so "put my slit on my target, then roll the PA" works in one step — after this,
  // handlePaChange pivots about that slit so it stays locked on the target as the mask rotates.
  // ("View centre" / "MSA centre" don't reposition — they only set the pivot.)
  const handleRotateAbout = useCallback((v: string) => {
    setRotateAbout(v);
    if (v === "view" || v === "ref") return;
    const h = handleRef.current;
    const wcs = h?.getViewer()?.getWcs();
    const cam = h?.getCameraState();
    if (!h || !wcs || !cam) return;
    const vsky = pixToSky(wcs, cam.centerX, cam.centerY);   // the target under the view centre
    if (!Number.isFinite(vsky.ra) || !Number.isFinite(vsky.dec)) return;
    const fr = apertureFrameWorld(wcs, vsky, apRef.current.paDeg);
    if (!fr) return;
    const [dP, sP] = slitCenterDS(v);
    // Place the aperture reference so the chosen slit's (d,s) lands exactly on the view centre.
    const cx = cam.centerX - (fr.disp.x * dP + fr.spat.x * sP);
    const cy = cam.centerY - (fr.disp.y * dP + fr.spat.y * sP);
    const s = pixToSky(wcs, cx, cy);
    if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) setApertureSky({ ra: s.ra, dec: s.dec });
  }, []);

  // Zoom/pan so EVERY enabled overlay (MSA field + checked instrument footprints) fits the
  // viewport — the JWST focal plane spans ~15′, so distant instruments (MIRI ~14′) need a wide
  // view. Bbox the world-px corners of all enabled apertures at the current pin + PA, then hand a
  // centre+zoom to the same adopt-and-hold cameraTargetRef the deep-link/goto use.
  const fitFootprints = useCallback(() => {
    const h = handleRef.current;
    const wcs = h?.getViewer()?.getWcs();
    const wrap = wrapRef.current;
    if (!h || !wcs || !wrap) return;
    const ap = apRef.current;
    let sky = ap.apertureSky;
    const cam = h.getCameraState();
    if (!sky && cam) { const s = pixToSky(wcs, cam.centerX, cam.centerY); if (Number.isFinite(s.ra)) sky = { ra: s.ra, dec: s.dec }; }
    if (!sky) return;
    const fw = apertureFrameWorld(wcs, sky, ap.paDeg);
    if (!fw) return;
    const dsPolys: (readonly (readonly [number, number])[])[] = [];
    if (ap.msaFieldOn) { dsPolys.push(...MSA_QUADS_DS, MSA_IFU_DS, ...MSA_SLITS_DS.map(s => s.ds)); }
    if (ap.msaOn || ap.ifuOn) dsPolys.push([[-2, -2], [2, -2], [2, 2], [-2, 2]]);   // small box at the pin
    if (ap.footprints.size && ap.siaf) for (const ins of ap.siaf.instruments) if (ap.footprints.has(ins.key)) for (const a of ins.apertures) dsPolys.push(a.ds);
    if (!dsPolys.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of dsPolys) for (const c of polyCornersWorld(fw, poly)) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    }
    if (!Number.isFinite(minX)) return;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rect = wrap.getBoundingClientRect();
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const fitX = Math.max((maxX - minX) * 1.15, 10), fitY = Math.max((maxY - minY) * 1.15, 10);
    const zoom = Math.min((rect.width * dpr) / fitX, (rect.height * dpr) / fitY);
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    if (cameraTargetRef) cameraTargetRef.current = { cx, cy, zoom, until: Date.now() + 4000 };
    h.setCenter(cx, cy);
    h.setZoom(zoom);
  }, [cameraTargetRef]);

  // Touch pan + pinch-zoom. @fitsgl/core only wires MOUSE + wheel, so on phones/iPads the map
  // wouldn't pan or zoom at all. Bridge touch → the camera handle here: one finger pans (keep the
  // world point under the finger), two fingers pinch-zoom about the midpoint. preventDefault (with
  // touch-action:none on the wrap) stops the page from scrolling/zooming instead of the map.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let prevMid: { x: number; y: number } | null = null;
    let prevDist = 0;
    const midOf = (t: TouchList) => t.length >= 2
      ? { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }
      : { x: t[0].clientX, y: t[0].clientY };
    const distOf = (t: TouchList) => t.length >= 2 ? Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) : 0;
    const onStart = (e: TouchEvent) => {
      if (photoToolRef.current || e.touches.length === 0) return;   // draw tool handles its own touches
      prevMid = midOf(e.touches); prevDist = distOf(e.touches);
    };
    const onMove = (e: TouchEvent) => {
      if (photoToolRef.current || !prevMid) return;
      const h = handleRef.current;
      const cam0 = h?.getCameraState();
      if (!h || !cam0) return;
      e.preventDefault();
      const curMid = midOf(e.touches), curDist = distOf(e.touches);
      const worldPrev = h.screenToImage(prevMid.x, prevMid.y);      // world under the previous midpoint (current cam)
      if (curDist > 0 && prevDist > 0) h.setZoom(cam0.zoom * (curDist / prevDist));
      const cam1 = h.getCameraState() ?? cam0;
      const worldNow = h.screenToImage(curMid.x, curMid.y);          // world now under the new midpoint (post-zoom cam)
      if (worldPrev && worldNow) h.setCenter(cam1.centerX + (worldPrev.x - worldNow.x), cam1.centerY + (worldPrev.y - worldNow.y));
      prevMid = curMid; prevDist = curDist;
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) { prevMid = null; prevDist = 0; }
      else { prevMid = midOf(e.touches); prevDist = distOf(e.touches); }   // a finger lifted → re-baseline
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Is the current PA (= aperture PA, APA) achievable at this field on some observable date?
  // null when no lookup is loaded for the field (panel then hides the flag).
  const paAchieve = useMemo(
    () => (v3paData ? achievability(v3paData, paDeg) : null),
    [v3paData, paDeg],
  );

  // Drag-to-move: while the handle is grabbed, map the cursor to a sky position and move the
  // aperture there live. Window listeners so the drag survives leaving the small handle.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!apDragRef.current) return;
      const h = handleRef.current;
      const wcs = h?.getViewer()?.getWcs();
      if (!h || !wcs) return;
      const w = h.screenToImage(e.clientX, e.clientY);
      if (!w) return;
      const s = pixToSky(wcs, w.x, w.y);
      if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) setApertureSky({ ra: s.ra, dec: s.dec });
    };
    const up = () => { apDragRef.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);
  // The photometry circles to draw this frame — every accumulated aperture (each with its
  // palette colour) plus the in-progress drag (drawn in CYAN). In a ref so the stable
  // per-frame project() reads the latest without re-subscribing.
  const photoDrawRef = useRef<{ ra: number; dec: number; radiusArcsec: number; color: string }[]>([]);
  photoDrawRef.current = [
    // Circle apertures only — polygons are drawn separately (photoPolyRef below).
    ...photoAps.filter(a => a.shape.kind === "circle").map(a => ({ ra: a.ra, dec: a.dec, radiusArcsec: a.radiusArcsec, color: a.color })),
    ...(draw ? [{ ra: draw.ra, dec: draw.dec, radiusArcsec: draw.radiusArcsec, color: CYAN }] : []),
  ];
  // The polygon apertures to draw this frame — every accumulated polygon (its sky vertices +
  // palette colour, drawn closed) plus the in-progress polygon (drawn open, CYAN, with its
  // live cursor for the rubber-band edge). In a ref so the stable per-frame project() reads
  // the latest without re-subscribing.
  const photoPolyRef = useRef<{ verts: [number, number][]; color: string; closed: boolean; cursor: { ra: number; dec: number } | null }[]>([]);
  photoPolyRef.current = [
    ...photoAps
      .filter(a => a.shape.kind === "polygon")
      .map(a => ({ verts: (a.shape as { vertices: [number, number][] }).vertices, color: a.color, closed: true, cursor: null })),
    ...(polyDraw ? [{ verts: polyDraw.verts, color: CYAN, closed: false, cursor: polyDraw.cursor }] : []),
  ];

  // Re-derive + apply the display on the LIVE viewer from the current view + params. This
  // is the exact FitsExplorer path (applyTrilogy + setStretchMode) routed through the shared
  // applyFitsglDisplay helper: it only updates the transfer curve / colormap — it does NOT
  // touch the camera or the SVG overlay, so the Kron ellipses and the current pan/zoom are
  // preserved. No-ops until the viewer's source mode has settled (else applyTrilogy would
  // run against the wrong band set). `viewSel` lets callers pass the pending view during a
  // source switch before React state has updated.
  // Latest panel state in refs so the stable callbacks read them without re-subscribing.
  const viewRef = useRef<ViewSel>(view); viewRef.current = view;
  const colormapRef = useRef<ColormapName>(colormap); colormapRef.current = colormap;
  const percentileRef = useRef<{ lo: number; hi: number } | null>(percentile); percentileRef.current = percentile;
  const weightsRef = useRef<Weights>(weights); weightsRef.current = weights;
  const trilogyRef = useRef<TrilogyParams>(trilogy); trilogyRef.current = trilogy;
  const stretchRef = useRef<StretchMode>(stretchMode); stretchRef.current = stretchMode;

  // Per-band trilogy stats in a given band order (for applyTrilogy). Missing stats ⇒ null.
  const orderedStats = useCallback((names: string[]): TrilogyStats[] | null => {
    const out: TrilogyStats[] = [];
    for (const n of names) {
      const s = bandStatsRef.current[n];
      if (!s) return null;
      out.push(s);
    }
    return out.length ? out : null;
  }, []);

  // Re-derive + apply the display on the LIVE viewer for the current view + params. Routed
  // through the shared applyFitsglDisplay helper: it only updates the transfer curve /
  // colormap / levels — never the camera or the SVG overlay, so overlays + pan/zoom persist.
  // No-ops until the viewer's source mode has settled. `viewSel` lets callers pass the
  // pending view during a source switch before React state has updated.
  const applyScaling = useCallback((params: TrilogyParams, mode: StretchMode, viewSel?: ViewSel) => {
    const h = handleRef.current;
    if (!h) return;
    const v = viewSel ?? viewRef.current;
    if (v === RGB_WEIGHTED || isStackView(v)) {
      // Weighted composite / grayscale stack — both multiband; stats follow the applied band
      // order (set by switchSource). The 4 trilogy sliders drive the levels on the stack too.
      applyFitsglDisplay(h, { view: v, trilogy: params, stretchMode: mode, stats: orderedStats(appliedBandsRef.current) });
    } else if (v === RGB_SIMPLE) {
      const t = rgbTripleRef.current;
      applyFitsglDisplay(h, { view: RGB_SIMPLE, trilogy: params, stretchMode: mode, stats: t ? orderedStats([t.r, t.g, t.b]) : null });
    } else {
      applyFitsglDisplay(h, {
        view: v, trilogy: params, stretchMode: mode,
        stats: bandStatsRef.current[v] ?? null,
        colormap: colormapRef.current, percentile: percentileRef.current,
      });
    }
  }, [orderedStats]);

  // Switch the viewer's render source when the view changes: weighted MultiBandSource /
  // simple RgbSource / SingleBandSource. setSource is a live in-memory swap (all bands are
  // loaded up front) and preserves the grid — so North-up, the WCS cursor readout and every
  // overlay stay registered. After the swap we re-apply the display.
  const switchSource = useCallback((v: ViewSel) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    if (!h || !viewer) return;
    try {
      if (v === RGB_WEIGHTED || isStackView(v)) {
        // Weighted RGB composite (user weights) OR a grayscale SW/LW stack (precomputed equal
        // weights) — both are weighted MultiBandSources; only the weight set differs.
        const w = v === RGB_WEIGHTED ? weightsRef.current : (v === STACK_SW ? stacksRef.current[STACK_SW] : stacksRef.current[STACK_LW]);
        if (!w) return;
        const applied: string[] = [];
        const src = weightedSource(h, w, applied);
        if (!src) return;
        viewer.setSource(src);
        appliedBandsRef.current = applied;
      } else if (v === RGB_SIMPLE) {
        const t = rgbTripleRef.current;
        const src = t && simpleRgbSource(h, t.r, t.g, t.b);
        if (!src) return;
        viewer.setSource(src);
        appliedBandsRef.current = t ? [t.r, t.g, t.b] : [];
      } else {
        const src = singleBandSource(h, v);
        if (!src) return;
        viewer.setSource(src);
        appliedBandsRef.current = [v];
      }
    } catch (err) {
      console.error("[map] setSource failed:", err);
      return;
    }
    applyScaling(trilogyRef.current, stretchRef.current, v);
  }, [applyScaling]);

  // Apply a weights change to the LIVE weighted composite. If the band SET is unchanged we
  // take the fast setBandWeights path (no rebuild); otherwise we rebuild the source. Then
  // re-apply the trilogy so the new levels/curve stick. Only runs in RGB-weighted mode.
  const applyWeights = useCallback((w: Weights) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    if (!h || !viewer || viewRef.current !== RGB_WEIGHTED) return;
    const applied = appliedBandsRef.current;
    const sameSet = applied.length === w.bands.length && applied.every((b, i) => b === w.bands[i]);
    if (sameSet && viewer.sourceMode === "multiband") {
      try { viewer.setBandWeights(applied.map(b => w.map[b] ?? [0, 0, 0])); }
      catch (err) { console.error("[map] setBandWeights failed:", err); }
    } else {
      // Band set changed (add/remove/rainbow-different-set): rebuild via switchSource, which
      // reads weightsRef — updated by the caller before this runs.
      switchSource(RGB_WEIGHTED);
    }
  }, [switchSource]);

  // Apply live whenever the panel params / mode / colormap / percentile change (viewer up).
  useEffect(() => { applyScaling(trilogy, stretchMode); }, [trilogy, stretchMode, colormap, percentile, applyScaling]);
  // Swap the render source when the view changes.
  useEffect(() => { switchSource(view); }, [view, switchSource]);
  // Push weight edits to the live composite (weightsRef is set above before this runs).
  useEffect(() => { applyWeights(weights); }, [weights, applyWeights]);

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

  // Compile the free-form query once per keystroke; expose its error for the sidebar. A blank
  // query is a no-op (pred = null). Reuses the exact Search query language.
  const queryPred = useMemo(() => {
    const q = filters.query.trim();
    if (!q) return { test: null as ((r: Record<string, number | null>) => boolean) | null, error: "" };
    const r = makePredicate(q);
    return "error" in r
      ? { test: null as ((r: Record<string, number | null>) => boolean) | null, error: r.error }
      : { test: r.test as (r: Record<string, number | null>) => boolean, error: "" };
  }, [filters.query]);

  // Rebuild the filtered source list when index / mag column / filters / query change.
  const sources = useMemo(
    () => (idx ? filterSources(idx, magRangeActive ? magCol : null, filters, queryPred.test) : []),
    [idx, magCol, filters, magRangeActive, queryPred],
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
    // Remember the current view whenever the user is freely panning/zooming (no goto or
    // deep-link target in flight) so a tab-switch context loss can be undone (see the
    // visibilitychange effect). Guard on a positive, finite zoom to skip transient states.
    if (!cameraTargetRef?.current && Number.isFinite(cam.zoom) && cam.zoom > 0) {
      lastCamRef.current = { cx: cam.centerX, cy: cam.centerY, zoom: cam.zoom };
    }
    const rect = wrap.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const zoom = cam.zoom;
    // Search → map handoff: draw ONLY the queried objects when a queued id set is present;
    // otherwise the full filtered list. Filtered here (not in filterSources) so toggling
    // the queue on/off — or switching fields — needs no source-list rebuild.
    // EXCEPTION: while "Show catalog objects" mode is ON, ignore the queued subset so EVERY
    // source is shown + pickable (the queued narrowing can otherwise hide objects the user
    // wants to pick — "sometimes they're not all highlighted").
    const qids = catalogModeRef.current ? null : queuedIdsRef.current;
    const list = qids ? sourcesRef.current.filter(s => qids.has(s.id)) : sourcesRef.current;
    const zids = zspecIdsRef.current;
    const asDot = zoom < DOT_ZOOM;
    // Scale marker size by HOW MANY are shown: the full catalog (thousands) stays small, but a
    // small uploaded list or query result is enlarged so the sources stay findable when zoomed
    // out — the case that matters for MSA planning. Grows ~1→3× as the shown count shrinks.
    // NB: applied ONLY to the dot/circle glyphs (visibility aid), never to the Kron ellipse
    // semi-axes — the ellipses stay true-size so aperture/morphology comparisons aren't distorted.
    const markerScale = list.length > 2000 ? 1 : Math.min(3, Math.sqrt(2000 / Math.max(list.length, 1)));

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
      const anyAperture = ap.msaOn || ap.ifuOn || ap.msaFieldOn || ap.footprints.size > 0;
      if (anyAperture && arcsecPerCssPx > 0) {
        // Aperture centre world pixel: the pinned sky position (locked under pan/zoom) if
        // set, else the live view centre. apertureFrame anchors on this exact pixel via the
        // same rect-relative imageToScreen the ellipses use, so a pinned aperture
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
          // Full MSA field (SIAF-exact): the 4 quadrants + the fixed slits + the IFU, each at
          // its true relative position (MSA_QUADS_DS / MSA_SLITS_DS / MSA_IFU_DS).
          const field = ap.msaFieldOn ? MSA_QUADS_DS.map(c => apPoly(frame, c)) : [];
          const slits = ap.msaFieldOn
            ? MSA_SLITS_DS.map(sl => {
                let md = 0, ms = 0;
                for (const [d, s] of sl.ds) { md += d; ms += s; }
                const c = apXY(frame, md / sl.ds.length, ms / sl.ds.length);
                return { label: sl.label, pts: apPoly(frame, sl.ds), lx: c.x, ly: c.y };
              })
            : [];
          const fieldIfu = ap.msaFieldOn
            ? (() => {
                let md = 0, ms = 0;
                for (const [d, s] of MSA_IFU_DS) { md += d; ms += s; }
                const c = apXY(frame, md / MSA_IFU_DS.length, ms / MSA_IFU_DS.length);
                return { pts: apPoly(frame, MSA_IFU_DS), lx: c.x, ly: c.y };
              })()
            : null;
          // Other-instrument footprints: each selected instrument's SIAF aperture polygons,
          // drawn in the SAME pinned+rotated frame so the whole JWST focal plane co-registers
          // with the MSA and rolls with the shared PA. Label sits at the centroid of all corners.
          const fp = (ap.footprints.size && ap.siaf)
            ? ap.siaf.instruments
                .filter(ins => ap.footprints.has(ins.key))
                .map(ins => {
                  let sx = 0, sy = 0, nc = 0;   // screen centroid
                  let dd = 0, ss = 0, nds = 0;  // ds centroid (arcsec) for the off-screen distance
                  const polys = ins.apertures.map(a => {
                    for (const [d, s] of a.ds) { const c = apXY(frame, d, s); sx += c.x; sy += c.y; nc++; dd += d; ss += s; nds++; }
                    return apPoly(frame, a.ds);
                  });
                  const lx = nc ? sx / nc : 0, ly = nc ? sy / nc : 0;
                  // JWST's instruments span ~15′, so at MSA-working zoom a distant one (MIRI ~14′)
                  // falls off-screen. If its centroid is outside the viewport, clamp a labelled
                  // marker to the edge pointing at it (with its offset in arcmin) so a checked
                  // instrument is never invisibly "missing".
                  const W = rect.width, H = rect.height;
                  let off: { x: number; y: number; arcmin: number } | null = null;
                  if (lx < 0 || lx > W || ly < 0 || ly > H) {
                    const cxv = W / 2, cyv = H / 2, m = 30;
                    const dx = lx - cxv, dy = ly - cyv;
                    const tx = dx > 0 ? (W - m - cxv) / dx : dx < 0 ? (m - cxv) / dx : Infinity;
                    const ty = dy > 0 ? (H - m - cyv) / dy : dy < 0 ? (m - cyv) / dy : Infinity;
                    const t = Math.max(0, Math.min(tx, ty));
                    off = { x: cxv + dx * t, y: cyv + dy * t, arcmin: nds ? Math.hypot(dd / nds, ss / nds) / 60 : 0 };
                  }
                  return { key: ins.key, color: ins.color, polys, lx, ly, off };
                })
            : [];
          setApertures({ msa, ifu, field, slits, fieldIfu, fp });
          setApCenterScreen({ cx: frame.cx, cy: frame.cy });   // drives the drag handle

          // Collect the catalog sources inside the 4 MSA quadrants — in WORLD/pixel space so
          // EVERY source is tested (not just the on-screen ones the screen `field` polygons
          // cover). Build the same 4 quadrant rectangles as `field` above, but as world-px
          // corners (quadCornersWorld mirrors apRectAt in world px), then point-in-poly each
          // source's (x,y). Uses the WHOLE filtered source list (sourcesRef), ignoring the
          // viewport cull. The quadrant offsets/half-extents match the drawn overlay exactly,
          // so the collected set visually coincides with the four amber rectangles.
          if (ap.msaFieldOn) {
            const wcs = h.getViewer()?.getWcs();
            // The aperture centre in SKY coords: the pinned sky pos, else the view-centre px
            // → sky. quadCornersWorld's frame is built from this same centre + PA.
            let centerSky: { ra: number; dec: number } | null = ap.apertureSky ?? null;
            if (!centerSky && wcs) {
              const s = pixToSky(wcs, cw.x, cw.y);
              if (Number.isFinite(s.ra) && Number.isFinite(s.dec)) centerSky = { ra: s.ra, dec: s.dec };
            }
            const fw = wcs && centerSky ? apertureFrameWorld(wcs, centerSky, ap.paDeg) : null;
            if (fw) {
              const quads = MSA_QUADS_DS.map(c => polyCornersWorld(fw, c));
              // A generous world-px bounding box over all 4 quadrants → cheap reject before the
              // per-quadrant ray-cast (the quadrant span is ~100″/0.03 ≈ few thousand px).
              let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
              for (const q of quads) for (const c of q) {
                if (c.x < bx0) bx0 = c.x; if (c.x > bx1) bx1 = c.x;
                if (c.y < by0) by0 = c.y; if (c.y > by1) by1 = c.y;
              }
              const ix = idxRef.current;
              const found: { id: number; ra: number; dec: number; za: number | null; mag: number | null }[] = [];
              for (const s of sourcesRef.current) {
                if (s.x < bx0 || s.x > bx1 || s.y < by0 || s.y > by1) continue;
                let inside = false;
                for (const q of quads) { if (pointInPoly(s.x, s.y, q)) { inside = true; break; } }
                if (!inside) continue;
                const pos = ix ? idToPosRef.current.get(s.id) : undefined;
                const za = pos != null && ix?.za ? (ix.za[pos] ?? null) : null;
                const mag = pos != null && ix ? (ix.m444?.[pos] ?? ix.m277?.[pos] ?? null) : null;
                found.push({ id: s.id, ra: s.ra, dec: s.dec, za, mag });
              }
              // Only push when the set actually changed (id list) — avoids a per-frame setState
              // storm (project runs every frame) that would re-render the panel needlessly.
              setMsaSources(prev => {
                if (prev.length === found.length && prev.every((p, k) => p.id === found[k].id)) return prev;
                return found;
              });
            } else {
              setMsaSources(prev => (prev.length ? [] : prev));
            }
          } else {
            setMsaSources(prev => (prev.length ? [] : prev));
          }
        }
        // else: the aperture centre didn't project this frame (transient, near an edge) —
        // keep the last-good overlay so the slits/quads/IFU stay persistent (no blink).
      } else if (!anyAperture) {
        // Toggles all off — clear. (A toggle on but arcsecPerCssPx transiently 0 keeps the last.)
        setApertures({ msa: [], ifu: null, field: [], slits: [], fieldIfu: null, fp: [] });
        setApCenterScreen(null);
        setMsaSources(prev => (prev.length ? [] : prev));
      }

      // Custom-aperture photometry circles. Every accumulated aperture (plus the in-progress
      // drag) is pinned to its SKY centre (welded under pan/zoom): sky → world px via the
      // viewer WCS, then world → screen via the SAME rect-relative imageToScreen the
      // ellipses use, so it never drifts. Radius: project a point radius_arcsec due north of
      // the centre and take the screen distance (matches the scale-bar's arcsec→px above).
      const pds = photoDrawRef.current;
      if (pds.length && arcsecPerCssPx > 0) {
        const wcs = h.getViewer()?.getWcs();
        if (wcs) {
          const circles: { cx: number; cy: number; r: number; color: string }[] = [];
          for (const pd of pds) {
            const cWorld = skyToPix(wcs, pd.ra, pd.dec);
            const cScreen = h.imageToScreen(cWorld.x, cWorld.y);
            const edgeWorld = skyToPix(wcs, pd.ra, pd.dec + pd.radiusArcsec / 3600);
            const eScreen = h.imageToScreen(edgeWorld.x, edgeWorld.y);
            if (cScreen && eScreen) {
              const cx = cScreen.x - rect.left, cy = cScreen.y - rect.top;
              const ex = eScreen.x - rect.left, ey = eScreen.y - rect.top;
              circles.push({ cx, cy, r: Math.hypot(ex - cx, ey - cy), color: pd.color });
            }
          }
          setPhotoCircles(circles);
        } else {
          setPhotoCircles([]);
        }
      } else {
        setPhotoCircles([]);
      }

      // Custom-aperture photometry POLYGONS. Same welding recipe as the circles: each sky
      // vertex → world px via the viewer WCS, then world → screen via the same
      // rect-relative imageToScreen the ellipses use, so the polygon stays pinned under
      // pan/zoom. Accumulated polygons are drawn closed; the in-progress one is drawn open
      // with a rubber-band edge from the last vertex to the live cursor + vertex dots.
      const pps = photoPolyRef.current;
      if (pps.length) {
        const wcs = h.getViewer()?.getWcs();
        if (wcs) {
          const toScreen = (ra: number, dec: number): { x: number; y: number } | null => {
            const w = skyToPix(wcs, ra, dec);
            const p = h.imageToScreen(w.x, w.y);
            return p ? { x: p.x - rect.left, y: p.y - rect.top } : null;
          };
          const polys: { points: string; color: string; closed: boolean; dots: { x: number; y: number }[]; rubber: string | null }[] = [];
          for (const pp of pps) {
            const dots: { x: number; y: number }[] = [];
            let bad = false;
            for (const [ra, dec] of pp.verts) {
              const s = toScreen(ra, dec);
              if (!s) { bad = true; break; }
              dots.push(s);
            }
            if (bad || dots.length === 0) continue;
            const points = dots.map(d => `${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(" ");
            // Rubber-band edge (in-progress only): last vertex → cursor → first vertex.
            let rubber: string | null = null;
            if (!pp.closed && pp.cursor) {
              const c = toScreen(pp.cursor.ra, pp.cursor.dec);
              if (c) {
                const last = dots[dots.length - 1], first = dots[0];
                rubber = `${last.x.toFixed(1)},${last.y.toFixed(1)} ${c.x.toFixed(1)},${c.y.toFixed(1)} ${first.x.toFixed(1)},${first.y.toFixed(1)}`;
              }
            }
            polys.push({ points, color: pp.color, closed: pp.closed, dots: pp.closed ? [] : dots, rubber });
          }
          setPhotoPolys(polys);
        } else {
          setPhotoPolys([]);
        }
      } else {
        setPhotoPolys([]);
      }

      // Picked catalog-object markers — one small outline per pick in its series colour, so the
      // user sees which objects are on the SED. Pinned to each pick's sky position via the same
      // rect-relative imageToScreen the ellipses use, so they stay welded on pan/zoom.
      const picks = catalogPicksRef.current;
      if (picks.length) {
        const wcs = h.getViewer()?.getWcs();
        if (wcs) {
          const marks: { cx: number; cy: number; color: string }[] = [];
          for (const p of picks) {
            if (!Number.isFinite(p.ra) || !Number.isFinite(p.dec)) continue;
            const cWorld = skyToPix(wcs, p.ra, p.dec);
            const cScreen = h.imageToScreen(cWorld.x, cWorld.y);
            if (cScreen) marks.push({ cx: cScreen.x - rect.left, cy: cScreen.y - rect.top, color: p.color });
          }
          setCatalogMarks(marks);
        } else {
          setCatalogMarks([]);
        }
      } else {
        setCatalogMarks([]);
      }
    }

    // Tiled fields: the catalog x,y are per-tile and don't line up with the fitsgl virtual
    // grid, so resolve each source's world px from its ra/dec via the viewer WCS (once per
    // source list). Resolve the FULL list (sourcesRef), not the possibly queue-narrowed `list` —
    // otherwise sources revealed later by "show all" / catalog mode keep raw per-tile x,y and
    // draw (and get MSA-collected) at wrong sky positions. Single-mosaic fields keep index x,y.
    if (tiledRef.current && !resolvedRef.current && sourcesRef.current.length) {
      const wcs = h.getViewer()?.getWcs();
      if (wcs) {
        for (const s of sourcesRef.current) {
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
      const c = h.imageToScreen(s.x, s.y);
      if (!c) continue;
      const scx = c.x - rect.left, scy = c.y - rect.top;

      const zspec = zids?.has(s.id) ?? false;
      if (asDot || !(s.semiA > 0 && s.semiB > 0) || Number.isNaN(s.th)) {
        out.push({ id: s.id, sel: s.sel, zspec, cx: scx, cy: scy, r: (asDot ? 1.6 : 4) * markerScale });
        continue;
      }
      // Project the ellipse's world-space rim vertices → screen (handles North-up too).
      const ct = Math.cos(s.th), st = Math.sin(s.th);
      const pts: string[] = [];
      let bad = false;
      for (let j = 0; j < ELLIPSE_SEGMENTS; j++) {
        const phi = (2 * Math.PI * j) / ELLIPSE_SEGMENTS;
        const ex = s.semiA * Math.cos(phi), ey = s.semiB * Math.sin(phi);
        const wx = s.x + ex * ct - ey * st;
        const wy = s.y + ex * st + ey * ct;
        const p = h.imageToScreen(wx, wy);
        if (!p) { bad = true; break; }
        pts.push(`${(p.x - rect.left).toFixed(1)},${(p.y - rect.top).toFixed(1)}`);
      }
      if (bad) continue;
      out.push({ id: s.id, sel: s.sel, zspec, poly: pts.join(" ") });
    }
    setGlyphs(out);

    // Primary (deep-linked) object: project its sky position to a persistent white box each
    // frame, so it stays welded to the object and visible at any zoom (find your target after
    // zooming out). Resolved from the index by id → ra/dec → screen (no +0.5, like the glyphs).
    const pid = primaryIdRef.current;
    const ixp = idxRef.current;
    const pos = pid != null && ixp ? idToPosRef.current.get(pid) : undefined;
    const wcsP = pos != null ? h.getViewer()?.getWcs() : null;
    if (ixp && pos != null && wcsP) {
      const pw = skyToPix(wcsP, ixp.ra[pos], ixp.dec[pos]);
      const ps = h.imageToScreen(pw.x, pw.y);
      setPrimaryMark(ps ? { cx: ps.x - rect.left, cy: ps.y - rect.top } : null);
    } else {
      setPrimaryMark(prev => (prev ? null : prev));
    }

    // Raw uploaded markers (arbitrary sky positions) — project each to screen, welded to sky.
    const raw = rawMarkersRef.current;
    if (raw && raw.length) {
      const wcsR = h.getViewer()?.getWcs();
      if (wcsR) {
        const marks: { cx: number; cy: number }[] = [];
        for (const [mra, mdec] of raw) {
          const pw = skyToPix(wcsR, mra, mdec);
          const ps = h.imageToScreen(pw.x, pw.y);
          if (ps) marks.push({ cx: ps.x - rect.left, cy: ps.y - rect.top });
        }
        setRawMarks(marks);
      }
    } else {
      setRawMarks(prev => (prev.length ? [] : prev));
    }
  }, []);

  // Re-project when the raw uploaded markers change (arrive / clear) — no camera move otherwise.
  useEffect(() => { project(); }, [rawMarkers, project]);

  // Re-project when aperture settings change — toggling/PA don't move the camera, so
  // onFrame won't fire; poke project directly so the overlay updates immediately.
  useEffect(() => { project(); }, [msaOn, ifuOn, msaFieldOn, footprints, siaf, paDeg, apertureSky, project]);

  // Re-project when the drawn photometry apertures change (drag / commit / clear) — no
  // camera move, so onFrame won't fire on its own. Includes the in-progress polygon so its
  // edges + rubber-band edge track each new vertex / cursor move immediately.
  useEffect(() => { project(); }, [draw, polyDraw, photoAps, project]);

  // Re-project when the picked catalog objects change (pick / remove / clear) so their map
  // markers appear/disappear immediately — no camera move to trigger onFrame otherwise.
  useEffect(() => { project(); }, [catalogPicks, project]);
  // Re-project when catalog mode toggles: entering it reveals ALL sources (bypasses the queued
  // subset, read live from catalogModeRef in project), so the ellipses redraw immediately.
  useEffect(() => { project(); }, [catalogMode, project]);

  // catalog mode + picks in refs so the stable per-frame project()/click path reads them live.
  const catalogModeRef = useRef(catalogMode);
  catalogModeRef.current = catalogMode;
  const catalogPicksRef = useRef<PickedCatalog[]>(catalogPicks);
  catalogPicksRef.current = catalogPicks;

  // id → catalog position lookup for the active index, so a picked ellipse's id resolves to
  // its row in loadFilters / the index property columns. Rebuilt only when the index changes.
  const idToPos = useMemo(() => {
    const m = new Map<number, number>();
    if (idx) for (let i = 0; i < idx.id.length; i++) m.set(idx.id[i], i);
    return m;
  }, [idx]);
  const idToPosRef = useRef(idToPos);
  idToPosRef.current = idToPos;
  idxRef.current = idx;

  // Pick a catalog object (called from an ellipse click while catalog mode is ON): resolve its
  // catalog position, pull its native per-band flux from loadFilters at that position, and append
  // a "catalog" SED series. Toggling an already-picked id off removes it. The filters table is
  // fetched lazily on the first pick and cached. Also opens the results panel so it's visible.
  const pickCatalog = useCallback(async (id: number) => {
    // Toggle off if already picked.
    if (catalogPicksRef.current.some(p => p.id === id)) {
      setCatalogPicks(prev => prev.filter(p => p.id !== id));
      return;
    }
    const pos = idToPosRef.current.get(id);
    if (pos == null) return;
    let fx = filtersTableRef.current;
    if (!fx) {
      fx = await loadFilters(field);
      if (!fx) return;                 // no per-band flux table for this field
      filtersTableRef.current = fx;
    }
    const bands = catalogBandsFromFilters(fx, pos);
    if (bands.length === 0) return;    // nothing plottable for this object
    const n = (catalogSeqRef.current += 1);
    const color = PHOTO_PALETTE[(n - 1) % PHOTO_PALETTE.length];
    const i = idx;
    const ra = i?.ra[pos] ?? NaN, dec = i?.dec[pos] ?? NaN;
    const za = i?.za?.[pos] ?? null;
    const mabs = i?.mabs?.[pos] ?? null;
    setPhotoPanelOpen(true);
    setCatalogPicks(prev => [...prev, { id, color, ra, dec, bands, za, mabs }]);
  }, [field, idx]);

  // Remove a single picked catalog object (its legend ✕).
  const removePick = useCallback((id: number) => {
    setCatalogPicks(prev => prev.filter(p => p.id !== id));
  }, []);

  // Field switch: the picked objects + cached flux table belong to the previous field's
  // catalog, so drop them (their ids/positions don't carry over).
  useEffect(() => {
    filtersTableRef.current = null;
    setCatalogPicks([]);
    catalogSeqRef.current = 0;
  }, [field.field]);

  // Entering catalog mode turns the draw tool OFF (mutually exclusive so the draw-capture layer
  // never intercepts the picking clicks); entering the draw tool turns catalog mode OFF.
  const toggleCatalogMode = useCallback(() => {
    setCatalogMode(v => { if (!v) setPhotoTool(false); return !v; });
  }, []);
  const togglePhotoTool = useCallback(() => {
    setPhotoTool(v => { if (!v) setCatalogMode(false); return !v; });
  }, []);

  // ---- Photometry draw tool: pointer handlers -------------------------------
  // With the tool active, a drag on the map draws the aperture (NOT a pan): mousedown sets
  // the sky centre, mousemove sets the radius (great-circle sep centre→cursor × 3600), and
  // mouseup finalises and fires measureAperture. We intercept the pointer ONLY while the
  // tool is active and a draw is in progress, so with the tool off the map pans exactly as
  // before. Uses capture + stopPropagation so the viewer's own drag-pan never sees the drag.
  const drawingRef = useRef<{ ra: number; dec: number } | null>(null);
  // shape + in-progress polygon in refs, so the stable-deps pointer/key handlers read the
  // latest without re-subscribing (same live-ref pattern the projector uses).
  const photoShapeRef = useRef(photoShape);
  photoShapeRef.current = photoShape;
  const polyDrawRef = useRef(polyDraw);
  polyDrawRef.current = polyDraw;
  // Live photoAps (for the pointer handlers' hit-test) + the in-progress MOVE of an existing
  // circle aperture's centre (grab near a centre → drag to reposition → re-measure on release).
  const photoApsRef = useRef(photoAps);
  photoApsRef.current = photoAps;
  // In-progress edit of an existing aperture: move a circle centre, drag one polygon vertex, or
  // move a whole polygon (tracking the last cursor sky for the per-move delta). Re-measure on release.
  const moveRef = useRef<
    | { kind: "circle"; n: number }
    | { kind: "vertex"; n: number; vi: number }
    | { kind: "polymove"; n: number; last: { ra: number; dec: number } }
    | null
  >(null);

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
    if (e.button !== 0) return;
    // Grab an EXISTING aperture to EDIT it (instead of starting a new draw): a circle centre
    // (~12 px) → move; a polygon vertex (~10 px) → drag that vertex; a polygon interior → move
    // the whole polygon. Works in either shape mode. Re-measures on release.
    const hm = handleRef.current, wcsm = hm?.getViewer()?.getWcs();
    if (hm && wcsm) {
      const scr = (ra: number, dec: number) => { const px = skyToPix(wcsm, ra, dec); return hm.imageToScreen(px.x, px.y); };
      const grabbed = () => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
      // ray-cast point-in-polygon on screen vertices
      const pip = (x: number, y: number, pts: { x: number; y: number }[]) => {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
      };
      // 1) circle centres
      for (const ap of photoApsRef.current) {
        if (ap.shape.kind !== "circle") continue;
        const sc = scr(ap.ra, ap.dec);
        if (sc && Math.hypot(e.clientX - sc.x, e.clientY - sc.y) <= 12) { moveRef.current = { kind: "circle", n: ap.n }; grabbed(); return; }
      }
      // 2) polygon vertices
      for (const ap of photoApsRef.current) {
        if (ap.shape.kind !== "polygon") continue;
        for (let vi = 0; vi < ap.shape.vertices.length; vi++) {
          const sc = scr(ap.shape.vertices[vi][0], ap.shape.vertices[vi][1]);
          if (sc && Math.hypot(e.clientX - sc.x, e.clientY - sc.y) <= 10) { moveRef.current = { kind: "vertex", n: ap.n, vi }; grabbed(); return; }
        }
      }
      // 3) polygon interiors → move the whole polygon
      for (const ap of photoApsRef.current) {
        if (ap.shape.kind !== "polygon") continue;
        const pts = ap.shape.vertices.map(([r, d]) => scr(r, d)).filter(Boolean) as { x: number; y: number }[];
        const cur = skyAt(e.clientX, e.clientY);
        if (pts.length >= 3 && cur && pip(e.clientX, e.clientY, pts)) { moveRef.current = { kind: "polymove", n: ap.n, last: cur }; grabbed(); return; }
      }
    }
    if (photoShapeRef.current !== "circle") return;  // polygon mode draws on click, not drag
    if (e.button !== 0) return;             // left-drag only
    const c = skyAt(e.clientX, e.clientY);
    if (!c) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawingRef.current = c;
    // NB: do NOT clear prior apertures — measurements accumulate until Clear.
    setDraw({ ra: c.ra, dec: c.dec, radiusArcsec: 0 });
  }, [photoTool, skyAt]);

  const onPhotoMove = useCallback((e: React.PointerEvent) => {
    // Moving an existing circle centre: re-pin it to the cursor sky position live (project()
    // re-derives its screen circle, so it follows the drag). Re-measure happens on release.
    const mv = moveRef.current;
    if (mv) {
      e.stopPropagation();
      const cur = skyAt(e.clientX, e.clientY);
      if (!cur) return;
      if (mv.kind === "circle") {
        setPhotoAps(prev => prev.map(a => a.n === mv.n ? { ...a, ra: cur.ra, dec: cur.dec } : a));
      } else if (mv.kind === "vertex") {
        setPhotoAps(prev => prev.map(a => (a.n === mv.n && a.shape.kind === "polygon")
          ? { ...a, shape: { kind: "polygon", vertices: a.shape.vertices.map((v, i) => i === mv.vi ? [cur.ra, cur.dec] as [number, number] : v) } }
          : a));
      } else { // polymove: shift every vertex (+ the centroid marker) by the per-move sky delta
        const dRa = cur.ra - mv.last.ra, dDec = cur.dec - mv.last.dec;
        mv.last = cur;
        setPhotoAps(prev => prev.map(a => (a.n === mv.n && a.shape.kind === "polygon")
          ? { ...a, ra: a.ra + dRa, dec: a.dec + dDec, shape: { kind: "polygon", vertices: a.shape.vertices.map(([r, d]) => [r + dRa, d + dDec] as [number, number]) } }
          : a));
      }
      return;
    }
    // Polygon mode: track the cursor sky position for the rubber-band edge to the first
    // vertex once at least one vertex is down. No drag capture — the map still pans between.
    if (photoShapeRef.current === "polygon") {
      if (!polyDrawRef.current) return;
      const cur = skyAt(e.clientX, e.clientY);
      if (cur) setPolyDraw(p => (p ? { ...p, cursor: cur } : p));
      return;
    }
    const start = drawingRef.current;
    if (!start) return;                     // not drawing → ignore (map handles its own moves)
    e.stopPropagation();
    const cur = skyAt(e.clientX, e.clientY);
    if (!cur) return;
    const radiusArcsec = angularSeparationDeg(start, cur) * 3600;
    setDraw({ ra: start.ra, dec: start.dec, radiusArcsec });
  }, [skyAt]);

  const onPhotoUp = useCallback((e: React.PointerEvent) => {
    // Finish a centre-move: re-measure the aperture at its new position.
    if (moveRef.current) {
      const n = moveRef.current.n;
      moveRef.current = null;
      e.stopPropagation();
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const ap = photoApsRef.current.find(a => a.n === n);
      if (ap) {
        const done = (result: PhotometryResult) => setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "done" as const, result } } : a));
        const fail = (err: unknown) => setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "error" as const, message: err instanceof Error ? err.message : String(err) } } : a));
        setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "measuring" } } : a));
        if (ap.shape.kind === "circle") {
          void measureAperture(field.field, ap.ra, ap.dec, { type: "circle", radius_arcsec: ap.radiusArcsec }).then(done).catch(fail);
        } else {
          const vertices = ap.shape.vertices;
          const cRa = vertices.reduce((s, v) => s + v[0], 0) / vertices.length;
          const cDec = vertices.reduce((s, v) => s + v[1], 0) / vertices.length;
          setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, ra: cRa, dec: cDec } : a));
          void measureAperture(field.field, cRa, cDec, { type: "polygon", vertices }).then(done).catch(fail);
        }
      }
      return;
    }
    const start = drawingRef.current;
    if (!start) return;
    e.stopPropagation();
    drawingRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const cur = skyAt(e.clientX, e.clientY);
    const radiusArcsec = cur ? angularSeparationDeg(start, cur) * 3600 : 0;
    const ra = start.ra, dec = start.dec;
    setDraw(null);
    // A too-small aperture (a stray click) is discarded — nothing to measure.
    if (!(radiusArcsec > 0.02)) return;
    // Append a new accumulated aperture in the "measuring" state; its index + palette colour
    // come from a monotonic counter (Clear resets it) so the async patch below can match this
    // exact entry regardless of state-update timing. Open the results panel so it's visible.
    setPhotoPanelOpen(true);
    const n = (photoSeqRef.current += 1);
    const color = PHOTO_PALETTE[(n - 1) % PHOTO_PALETTE.length];
    setPhotoAps(prev => [...prev, { n, color, ra, dec, radiusArcsec, shape: { kind: "circle", radiusArcsec }, state: { kind: "measuring" } }]);
    // When the request settles, patch ONLY this aperture's state (matched by its index n),
    // leaving the rest of the accumulated set untouched.
    void measureAperture(field.field, ra, dec, { type: "circle", radius_arcsec: radiusArcsec })
      .then(result => setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "done", result } } : a)))
      .catch(err => setPhotoAps(prev => prev.map(a => a.n === n
        ? { ...a, state: { kind: "error", message: err instanceof Error ? err.message : String(err) } }
        : a)));
  }, [skyAt]);

  // ---- Polygon draw: click a vertex, double-click / Enter to close, Esc to cancel --------
  // Drop a polygon vertex at the click. Guarded to polygon mode (the capture layer's onClick
  // fires for both shapes, but circle mode already handled its drag on down/up). Vertices are
  // sky [ra,dec] degrees, converted the same way the circle centre is (screenToImage→pixToSky).
  const onPhotoClick = useCallback((e: React.MouseEvent) => {
    if (!photoTool || photoShapeRef.current !== "polygon") return;
    if (e.button !== 0) return;
    const c = skyAt(e.clientX, e.clientY);
    if (!c) return;
    e.stopPropagation();
    setPolyDraw(p => {
      const verts = p ? [...p.verts, [c.ra, c.dec] as [number, number]] : [[c.ra, c.dec] as [number, number]];
      return { verts, cursor: c };
    });
  }, [photoTool, skyAt]);

  // Finalise the in-progress polygon (double-click / Enter): needs ≥3 vertices. Appends a new
  // accumulated aperture in the "measuring" state (its ra/dec = the vertex centroid, for the
  // panel label + map marker) and fires measureAperture with the polygon shape. Same monotonic
  // index / palette / async-patch pattern as the circle path. No-op with <3 vertices.
  const finishPolygon = useCallback(() => {
    const p = polyDrawRef.current;
    if (!p || p.verts.length < 3) return;
    const vertices = p.verts;
    setPolyDraw(null);
    // Vertex centroid — a representative ra/dec for the panel/legend + map marker only (the
    // Worker photometry rides on the vertices themselves, not this centre).
    const cRa = vertices.reduce((s, v) => s + v[0], 0) / vertices.length;
    const cDec = vertices.reduce((s, v) => s + v[1], 0) / vertices.length;
    setPhotoPanelOpen(true);
    const n = (photoSeqRef.current += 1);
    const color = PHOTO_PALETTE[(n - 1) % PHOTO_PALETTE.length];
    setPhotoAps(prev => [...prev, {
      n, color, ra: cRa, dec: cDec, radiusArcsec: 0,
      shape: { kind: "polygon", vertices }, state: { kind: "measuring" },
    }]);
    void measureAperture(field.field, cRa, cDec, { type: "polygon", vertices })
      .then(result => setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "done", result } } : a)))
      .catch(err => setPhotoAps(prev => prev.map(a => a.n === n
        ? { ...a, state: { kind: "error", message: err instanceof Error ? err.message : String(err) } }
        : a)));
  }, []);

  const cancelPolygon = useCallback(() => { setPolyDraw(null); }, []);

  // Double-click on the capture layer closes the polygon (browsers may also fire the two
  // clicks that added the last vertices first — that's fine, they just land on the same spot).
  const onPhotoDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!photoTool || photoShapeRef.current !== "polygon") return;
    e.stopPropagation();
    e.preventDefault();
    finishPolygon();
  }, [photoTool, finishPolygon]);

  // Keyboard: Enter closes the in-progress polygon, Esc cancels it. Bound at the window while
  // the tool is on + shape=polygon + a polygon is being drawn; torn down otherwise.
  useEffect(() => {
    if (!photoTool || photoShape !== "polygon") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); finishPolygon(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelPolygon(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoTool, photoShape, finishPolygon, cancelPolygon]);

  // Adjust an already-drawn aperture's radius (± from the panel) and re-measure it in place,
  // keeping the same centre + colour + index. The circle re-projects immediately (photoAps
  // change → project()); the new flux lands when the request settles.
  const adjustAperture = useCallback((n: number, newRadiusArcsec: number) => {
    const r = Math.max(0.03, Math.round(newRadiusArcsec * 1000) / 1000);
    const ap = photoAps.find(a => a.n === n);
    if (!ap || ap.shape.kind !== "circle") return;   // radius adjust is circles-only
    setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, radiusArcsec: r, shape: { kind: "circle", radiusArcsec: r }, state: { kind: "measuring" } } : a));
    void measureAperture(field.field, ap.ra, ap.dec, { type: "circle", radius_arcsec: r })
      .then(result => setPhotoAps(prev => prev.map(a => a.n === n ? { ...a, state: { kind: "done", result } } : a)))
      .catch(err => setPhotoAps(prev => prev.map(a => a.n === n
        ? { ...a, state: { kind: "error", message: err instanceof Error ? err.message : String(err) } }
        : a)));
  }, [photoAps]);

  // Remove ONE measured aperture (by index). project() re-derives the map circles/polys and the
  // SED from photoAps, so filtering it out is all that's needed — no re-measure, no re-pin.
  const removeAperture = useCallback((n: number) => {
    setPhotoAps(prev => prev.filter(a => a.n !== n));
  }, []);

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

  // Clear ALL accumulated apertures (SEDs + circles + tables) and any in-progress draw, and
  // reset the index counter so the next aperture is #1 again.
  const clearPhoto = useCallback(() => {
    drawingRef.current = null;
    setDraw(null);
    setPolyDraw(null);
    setPhotoAps([]);
    photoSeqRef.current = 0;
    // Wipe picked catalog objects too, and reset their palette counter.
    setCatalogPicks([]);
    catalogSeqRef.current = 0;
  }, []);

  // ---- MSA-quadrant source handoffs -----------------------------------------
  // Download the collected in-MSA sources as CSV (id,ra,dec,za,mag). Client-side Blob, no
  // deps — the same recipe downloadPhoto uses. mag is the F444W index mag (F277W fallback).
  const downloadMsaSources = useCallback(() => {
    if (!msaSources.length) return;
    const rows = ["id,ra,dec,za,mag"];
    for (const s of msaSources) {
      rows.push([
        s.id,
        Number.isFinite(s.ra) ? s.ra.toFixed(6) : "",
        Number.isFinite(s.dec) ? s.dec.toFixed(6) : "",
        s.za != null && Number.isFinite(s.za) ? s.za.toFixed(4) : "",
        s.mag != null && Number.isFinite(s.mag) ? s.mag.toFixed(3) : "",
      ].join(","));
    }
    const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "unicorn_msa_sources.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [msaSources]);

  // Open the collected in-MSA sources in the Search page's sortable results table. Mirrors the
  // map's own localStorage["mapQueue"] handoff (Search → map), but the OTHER direction: stash a
  // { field, id, ra, dec } list under localStorage["searchQueue"] (with a ts + label, so the
  // Search page can honour it once, fresh, then clear it) and open /data/search?queue=1 in a new
  // tab. Search reads it into the same table the Upload-List / Query modes use.
  const openMsaInTable = useCallback(() => {
    if (!msaSources.length) return;
    const objects = msaSources.map(s => ({
      field: field.field, id: s.id,
      ra: Number.isFinite(s.ra) ? s.ra : null,
      dec: Number.isFinite(s.dec) ? s.dec : null,
    }));
    try {
      localStorage.setItem("searchQueue", JSON.stringify({ label: "MSA quadrants", ts: Date.now(), objects }));
    } catch { /* quota — open the search page anyway */ }
    window.open("/unicorn/data/search?queue=1", "_blank");
  }, [msaSources, field.field]);

  // Export the accumulated photometry as CSV — one row per (aperture, band). Columns:
  // aperture,ra,dec,radius_arcsec,band,wavelength_um,flux_nJy,err_nJy,snr,ab_mag. Client-side
  // via a Blob + object URL (no deps). Only finished apertures contribute rows.
  const downloadPhoto = useCallback(() => {
    // `source` distinguishes drawn measured apertures from picked catalog objects. For catalog
    // rows `aperture` carries the catalog id, `radius_arcsec` is blank (not an aperture), and
    // err/snr are blank (native catalog fluxes carry no per-band error here).
    const header = ["source", "aperture", "ra", "dec", "radius_arcsec", "band", "wavelength_um", "flux_nJy", "err_nJy", "snr", "ab_mag"];
    const rows: string[] = [header.join(",")];
    for (const a of photoAps) {
      if (a.state.kind !== "done") continue;
      for (const b of a.state.result.results) {
        const wav = FILTER_WAVES[b.band];
        const snr = b.err_nJy > 0 ? b.flux_nJy / b.err_nJy : null;
        const ab = abMagFromNJy(b.flux_nJy);
        rows.push([
          "measured",
          a.n, a.ra.toFixed(6), a.dec.toFixed(6), a.radiusArcsec.toFixed(4),
          b.band, wav != null ? wav : "",
          Number.isFinite(b.flux_nJy) ? b.flux_nJy : "",
          Number.isFinite(b.err_nJy) ? b.err_nJy : "",
          snr != null ? snr.toFixed(3) : "",
          ab != null ? ab.toFixed(3) : "",
        ].join(","));
      }
    }
    // Picked catalog objects — one row per (object, band). native flux only (no err/snr).
    for (const p of catalogPicks) {
      for (const b of p.bands) {
        const ab = abMagFromNJy(b.flux);
        rows.push([
          "catalog",
          p.id, Number.isFinite(p.ra) ? p.ra.toFixed(6) : "", Number.isFinite(p.dec) ? p.dec.toFixed(6) : "", "",
          b.band, b.wav,
          Number.isFinite(b.flux) ? b.flux : "",
          "", "",
          ab != null ? ab.toFixed(3) : "",
        ].join(","));
      }
    }
    if (rows.length <= 1) return;   // nothing to export
    const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "unicorn_photometry.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [photoAps, catalogPicks]);

  // Turning the tool off (or the enabling conditions lapsing) clears any in-progress draw
  // (both the drag circle and the in-progress polygon).
  useEffect(() => {
    if (!photoTool) { drawingRef.current = null; setDraw(null); setPolyDraw(null); }
  }, [photoTool]);
  // Switching shape mid-draw abandons the in-progress polygon (and any drag circle), so the
  // two shapes never bleed into each other.
  useEffect(() => {
    drawingRef.current = null; setDraw(null); setPolyDraw(null);
  }, [photoShape]);
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
    // A fresh viewer opens in the producer default composite. Re-assert the CURRENT view +
    // weights (they may differ from the default after user edits, or after a context-loss
    // remount that reset to the config default). switchSource is idempotent + cheap.
    switchSource(viewRef.current);
    pokeProject();
  }, [idx, pokeProject, switchSource]);

  // If the index arrives after the viewer is ready, still hand it up.
  useEffect(() => {
    if (idx && handleRef.current) readyHandleRef.current?.(handleRef.current, idx);
  }, [idx]);

  // Detect WebGL context loss on the live canvas (fitsgl doesn't). preventDefault keeps the
  // element reusable; we flag it so the tab-return handler can remount for a clean re-init.
  // Re-runs after every remount (viewerKey) since a fresh canvas needs the listener re-attached.
  useEffect(() => {
    let canvas: HTMLCanvasElement | null = null;
    const onLost = (e: Event) => { e.preventDefault(); contextLostRef.current = true; };
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const attach = () => {
      canvas = wrapRef.current?.querySelector("canvas") ?? null;
      if (canvas) { canvas.addEventListener("webglcontextlost", onLost); return; }
      if (++tries < 50) timer = setTimeout(attach, 100);   // canvas appears shortly after mount
    };
    attach();
    return () => { clearTimeout(timer); if (canvas) canvas.removeEventListener("webglcontextlost", onLost); };
  }, [viewerKey]);

  // Keep the map in its last state across a browser tab-switch. On leave we snapshot the exact
  // camera; on return we restore it. If the GL context was DROPPED while hidden (fitsgl can't
  // recover on its own → a broken map), we remount the viewer for a clean re-init — the saved
  // camera is re-adopted on the new onReady, and overlays/filters (React state) are untouched.
  useEffect(() => {
    const onVis = () => {
      const h = handleRef.current;
      if (document.visibilityState === "hidden") {
        const cam = h?.getCameraState();
        if (cam && Number.isFinite(cam.zoom) && cam.zoom > 0) {
          lastCamRef.current = { cx: cam.centerX, cy: cam.centerY, zoom: cam.zoom };
        }
        return;
      }
      // Back on the tab. Pre-arm the saved camera so whatever re-init happens adopts it.
      const last = lastCamRef.current;
      if (last && cameraTargetRef) {
        cameraTargetRef.current = { cx: last.cx, cy: last.cy, zoom: last.zoom, until: Date.now() + 6000 };
      }
      if (contextLostRef.current) {
        contextLostRef.current = false;
        setViewerKey(k => k + 1);   // remount for a clean GL context; onReady restores everything
      } else {
        pokeProject();              // context intact — just re-assert camera + re-project overlays
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [cameraTargetRef, pokeProject]);

  // After a recovery remount (viewerKey bumped), keep re-projecting for a while: the fresh
  // viewer's WCS/tiles come up asynchronously, so the single onReady→pokeProject can fire too
  // early and the NIRSpec aperture block (needs arcsecPerCssPx>0) no-ops. This sweep guarantees
  // the overlays (glyphs + apertures) rebuild once the new viewer settles.
  useEffect(() => {
    if (viewerKey === 0) return;   // 0 = first mount, handled by the normal ready path
    let n = 0;
    const iv = setInterval(() => { enforceCamera(); project(); if (++n >= 40) clearInterval(iv); }, 200); // ~8s
    return () => clearInterval(iv);
  }, [viewerKey, project, enforceCamera]);

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
    <div ref={wrapRef} className="mapwrap" style={{ width: "100%", height: "100%", position: "relative", touchAction: "none" }}>
      <FitsViewer
        key={viewerKey}
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
          tool off it isn't in the tree and the map pans/zooms/clicks exactly as before. In
          CIRCLE mode the pointer down/move/up draws the drag circle; in POLYGON mode a click
          drops a vertex and a double-click closes it (Enter/Esc are handled at the window). */}
      {photoTool && (
        <div
          data-overlay="photo-capture"
          onPointerDown={onPhotoDown}
          onPointerMove={onPhotoMove}
          onPointerUp={onPhotoUp}
          onClick={onPhotoClick}
          onDoubleClick={onPhotoDoubleClick}
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
          const picked = catalogMode && catalogPicks.some(p => p.id === g.id);
          const color = picked ? catalogPicks.find(p => p.id === g.id)!.color
            : g.zspec ? GREEN : g.sel ? YELLOW : RED;
          // In catalog mode a click PICKS the object (overlays its photometry) instead of
          // opening the card; otherwise it opens the ResultCard exactly as before.
          const onClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (catalogModeRef.current) void pickCatalog(g.id);
            else clickRef.current(g.id);
          };
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
      {(apertures.msa.length > 0 || apertures.ifu || apertures.field.length > 0 ||
        apertures.fieldIfu || apertures.slits.length > 0 || apertures.fp.length > 0) && (
        <svg
          data-overlay="apertures"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {/* Other-instrument footprints (NIRCam / MIRI / NIRISS / FGS) — SIAF-exact, at their
              true focal-plane offsets, one colour each, with a label at the assembly centroid. */}
          {apertures.fp.map(ins => (
            <g key={`fp${ins.key}`}>
              {ins.polys.map((pts, k) => (
                <polygon key={k} points={pts} fill={`${ins.color}14`} stroke={ins.color} strokeWidth={1.3} />
              ))}
              {ins.off ? (
                // Off-screen: an edge marker pointing at the (far) footprint + its offset in arcmin.
                <g transform={`translate(${ins.off.x} ${ins.off.y})`} style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.9))" }}>
                  <circle r={5} fill={ins.color} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
                  <text x={0} y={16} fill={ins.color} fontSize={10} textAnchor="middle"
                    fontFamily="'Space Mono', monospace" style={{ userSelect: "none" }}>
                    {ins.key} · {ins.off.arcmin.toFixed(1)}′ out
                  </text>
                </g>
              ) : (
                <text x={ins.lx} y={ins.ly} fill={ins.color} fontSize={11} textAnchor="middle"
                  fontFamily="'Space Mono', monospace" style={{ userSelect: "none" }}>{ins.key}</text>
              )}
            </g>
          ))}
          {apertures.field.map((pts, k) => (
            <polygon key={`f${k}`} points={pts} fill="rgba(240,176,80,0.06)" stroke="#f0b050" strokeWidth={1.4} />
          ))}
          {/* NIRSpec IFU in its true focal-plane position (part of the MSA-field assembly). */}
          {apertures.fieldIfu && (
            <g>
              <polygon points={apertures.fieldIfu.pts} fill="rgba(224,120,224,0.12)" stroke="#e078e0" strokeWidth={1.6} />
              <text x={apertures.fieldIfu.lx + 5} y={apertures.fieldIfu.ly - 5} fill="#e078e0" fontSize={9}
                fontFamily="'Space Mono', monospace" style={{ userSelect: "none" }}>IFU</text>
            </g>
          )}
          {/* Fixed slits — true footprint (tiny) + a locator ring + label, so they're findable
              at the field scale and exact when zoomed in. */}
          {apertures.slits.map((sl, k) => (
            <g key={`sl${k}`}>
              <polygon points={sl.pts} fill="rgba(94,224,138,0.55)" stroke="#43d17a" strokeWidth={1.2} />
              <circle cx={sl.lx} cy={sl.ly} r={3.5} fill="none" stroke="#43d17a" strokeWidth={1.2} />
              <text x={sl.lx + 5} y={sl.ly - 4} fill="#43d17a" fontSize={8.5}
                fontFamily="'Space Mono', monospace" style={{ userSelect: "none" }}>{sl.label}</text>
            </g>
          ))}
          {apertures.ifu && (
            <polygon points={apertures.ifu} fill="rgba(224,120,224,0.08)" stroke="#e078e0" strokeWidth={1.6} />
          )}
          {apertures.msa.map((pts, k) => (
            <polygon key={k} points={pts} fill="rgba(94,224,224,0.12)" stroke="#5ee0e0" strokeWidth={1.4} />
          ))}
        </svg>
      )}

      {/* Drag handle at the aperture centre — grab it to move the whole NIRSpec assembly to a
          new sky position. Only the handle is pointer-eventful (the rest of the overlay lets
          the map pan through). Hidden when the aperture is pinned/locked. */}
      {apCenterScreen && !apLocked && (msaOn || ifuOn || msaFieldOn || footprints.size > 0) && (
        <svg width="100%" height="100%" data-overlay="aperture-handle"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
          <circle
            cx={apCenterScreen.cx} cy={apCenterScreen.cy} r={9}
            fill="rgba(0,0,0,0.35)" stroke="#ffffff" strokeWidth={2}
            style={{ pointerEvents: "auto", cursor: "move" }}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); apDragRef.current = true; }}
          >
            <title>Drag to move the NIRSpec aperture</title>
          </circle>
          <circle cx={apCenterScreen.cx} cy={apCenterScreen.cy} r={1.8} fill="#ffffff" style={{ pointerEvents: "none" }} />
        </svg>
      )}

      {/* Custom-aperture photometry circles — every accumulated aperture in its own palette
          colour, plus the in-progress drag (cyan). Each is pinned to its sky centre via the
          same rect-relative imageToScreen the ellipses use, so they stay welded on
          pan/zoom. Non-interactive; the capture layer above handles the drawing. */}
      {photoCircles.length > 0 && (
        <svg
          data-overlay="photometry-circle"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {photoCircles.map((c, k) => (
            <g key={k}>
              <circle cx={c.cx} cy={c.cy} r={c.r} fill="none" stroke={c.color} strokeWidth={1.6} />
              {/* Centre = drag handle when the Measure tool is on (grab to move the aperture). */}
              <circle cx={c.cx} cy={c.cy} r={photoTool ? 4 : 1.5} fill={c.color}
                stroke={photoTool ? "rgba(255,255,255,0.75)" : "none"} strokeWidth={photoTool ? 1 : 0} />
            </g>
          ))}
        </svg>
      )}

      {/* Custom-aperture photometry polygons — every accumulated polygon in its own palette
          colour (drawn closed/filled-faint), plus the in-progress polygon (cyan, open, with a
          dashed rubber-band edge to the cursor + vertex dots). Each vertex is pinned to its sky
          position via the same rect-relative imageToScreen the ellipses use, so they
          stay welded on pan/zoom. Non-interactive; the capture layer above handles the drawing. */}
      {photoPolys.length > 0 && (
        <svg
          data-overlay="photometry-polygon"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {photoPolys.map((p, k) => (
            <g key={k}>
              {p.closed ? (
                <>
                  <polygon points={p.points} fill={`${p.color}22`} stroke={p.color} strokeWidth={1.6} />
                  {/* Vertex grab handles while the Measure tool is on (drag a vertex to reshape;
                      drag the interior to move the whole polygon). */}
                  {photoTool && p.points.split(" ").filter(Boolean).map((xy, j) => {
                    const [x, y] = xy.split(",").map(Number);
                    return <circle key={j} cx={x} cy={y} r={4} fill={p.color} stroke="rgba(255,255,255,0.75)" strokeWidth={1} />;
                  })}
                </>
              ) : (
                <>
                  {/* In-progress: the drawn edges so far (open polyline), the rubber-band edge to
                      the cursor (dashed), and a dot on each dropped vertex. */}
                  <polyline points={p.points} fill="none" stroke={p.color} strokeWidth={1.6} />
                  {p.rubber && (
                    <polyline points={p.rubber} fill="none" stroke={p.color} strokeWidth={1.2} strokeDasharray="4 3" opacity={0.8} />
                  )}
                  {p.dots.map((d, j) => (
                    <circle key={j} cx={d.x} cy={d.y} r={2.5} fill={p.color} />
                  ))}
                </>
              )}
            </g>
          ))}
        </svg>
      )}

      {/* Picked catalog-object markers — a small hollow ring in each pick's series colour,
          welded to its sky position, so the user sees which objects are on the SED. The
          hollow ring mirrors the catalog series' hollow/dashed SED style. Non-interactive
          (the ellipse beneath handles the toggle-off click). */}
      {catalogMarks.length > 0 && (
        <svg
          data-overlay="catalog-marks"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {catalogMarks.map((m, k) => (
            <circle key={k} cx={m.cx} cy={m.cy} r={7} fill="none" stroke={m.color} strokeWidth={2} />
          ))}
        </svg>
      )}

      {/* Primary (deep-linked) object — a persistent white reticle box, fixed on-screen size so
          it stays clearly visible as you zoom out. Welded to the object's sky position. */}
      {primaryMark && (
        <svg
          data-overlay="primary-mark"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          <rect
            x={primaryMark.cx - 13} y={primaryMark.cy - 13} width={26} height={26}
            rx={2} fill="none" stroke="#ffffff" strokeWidth={2}
            style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.9))" }}
          />
        </svg>
      )}

      {/* Raw uploaded markers — arbitrary sky positions plotted as bright diamonds (not catalog
          objects). Sized up when few are shown so they're findable when zoomed out. */}
      {rawMarks.length > 0 && (
        <svg
          data-overlay="raw-markers"
          width="100%" height="100%"
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}
        >
          {(() => {
            const r = rawMarks.length > 2000 ? 5 : Math.min(11, 5 * Math.sqrt(2000 / Math.max(rawMarks.length, 1)));
            return rawMarks.map((m, k) => (
              <g key={k} transform={`translate(${m.cx} ${m.cy}) rotate(45)`}
                style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.9))" }}>
                <rect x={-r} y={-r} width={2 * r} height={2 * r} fill="none" stroke="#ffe14d" strokeWidth={2} />
              </g>
            ));
          })()}
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

      {/* SCALING panel — top-right, where FitsExplorer's View panel used to sit. Drives
          the trilogy stretch live via applyScaling (through the viewer handle). Stacked
          with the NIRSpec + PHOTOMETRY panels in one top-right column so they never overlap.
          maxHeight + overflow lets the (potentially tall) PHOTOMETRY panel scroll rather
          than run off the bottom of the map. */}
      <div style={{ position: "absolute", top: 12, right: 12, bottom: 12, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "flex-end", pointerEvents: "none" }}>
        {/* The INNER column is the scroller and the only pointer/touch target — the outer box stays
            pointer-transparent so the map pans/zooms in the empty space around the panels, while
            this column can be dragged to scroll (touch) and doesn't block map gestures elsewhere. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end", minHeight: 0, maxHeight: "100%", overflowY: "auto", paddingBottom: 28, pointerEvents: "auto", touchAction: "pan-y" }}>
        <FitsglControls
          title="DISPLAY"
          bands={controlBands}
          view={view}
          onViewChange={setView}
          params={trilogy}
          onParamsChange={patch => setTrilogy(p => ({ ...p, ...patch }))}
          weights={weights}
          onWeightsChange={setWeights}
          mode={stretchMode}
          onModeChange={setStretchMode}
          colormap={colormap}
          onColormapChange={setColormap}
          percentile={percentile}
          onPercentileChange={setPercentile}
          isDefault={isDefaultLook}
          onReset={() => {
            setView(RGB_WEIGHTED); setTrilogy(CAMPFIRE_TRILOGY); setStretchMode(DEFAULT_STRETCH_MODE);
            setColormap("gray"); setPercentile(null);
            if (prep) setWeights(prep.defaultWeights);
          }}
          open={panelOpen}
          onToggle={() => setPanelOpen(o => !o)}
        />
        <NIRSpecPanel
          msaOn={msaOn} ifuOn={ifuOn} msaFieldOn={msaFieldOn} paDeg={paDeg} pinned={apLocked}
          msaCount={msaSources.length}
          onMsaCsv={downloadMsaSources} onMsaTable={openMsaInTable}
          onMsa={setMsaOn} onIfu={setIfuOn} onMsaField={setMsaFieldOn} onPa={handlePaChange}
          rotateAbout={rotateAbout} onRotateAbout={handleRotateAbout}
          paAchieve={paAchieve} onPickPa={handlePaChange}
          instruments={siaf?.instruments ?? []}
          footprints={footprints}
          onToggleFootprint={(key, on) => setFootprints(prev => {
            const next = new Set(prev);
            if (on) next.add(key); else next.delete(key);
            return next;
          })}
          onFitFootprints={fitFootprints}
          // Pin = LOCK: hide the drag handle so the map pans freely. Never moves the aperture,
          // so pinning/unpinning leaves it exactly where you left it.
          onTogglePin={() => setApLocked(l => !l)}
        />
      </div>
      </div>

      {/* PHOTOMETRY panel — LEFT edge of the viewer. It MUST be a SIBLING of the right control
          column (positioned against the map wrapper), NOT nested inside it — otherwise left:14
          is measured from the right column's box and the panel lands on the right, clipped.
          Its SED + tables get tall, so cap height with an INTERNAL scroll (pointer-events:auto
          so the wheel scrolls it); the container shrink-wraps so it never blocks map panning. */}
      <div style={{ position: "absolute", top: 12, left: 14, zIndex: 20, maxHeight: "calc(100% - 64px)", overflowY: "auto", pointerEvents: "auto" }}>
        <PhotometryPanel
          open={photoPanelOpen}
          apertures={photoAps}
          catalogPicks={catalogPicks}
          catalogMode={catalogMode}
          photoTool={photoTool}
          photoShape={photoShape}
          photoEnabled={photoEnabled}
          photoHint={session == null ? "sign in on /data/review to measure" : !photoFieldOk ? "not available for this field yet" : ""}
          onToggleOpen={() => setPhotoPanelOpen(o => !o)}
          onPhotoTool={togglePhotoTool}
          onPhotoShape={setPhotoShape}
          onCatalogMode={toggleCatalogMode}
          onRemovePick={removePick}
          onRemoveAperture={removeAperture}
          onClear={clearPhoto}
          onDownload={downloadPhoto}
          onAdjust={adjustAperture}
        />
      </div>
    </div>
  );
}

// ---- NIRSpec aperture control panel ----------------------------------------
// Compact panel pinned under the SCALING panel (top-right). Toggles the MSA 3-shutter
// slitlet and the IFU 3"×3" overlays, a shared PA input (degrees, east-of-north, orients
// the slitlet long axis), and a pin that fixes the aperture at the current view centre's
// sky position (so panning no longer drags it) vs following the view centre. (The custom
// photometry draw tool lives in its own separate PHOTOMETRY panel below this one.)
function NIRSpecPanel({
  msaOn, ifuOn, msaFieldOn, paDeg, pinned, msaCount, paAchieve, rotateAbout, onRotateAbout,
  onMsa, onIfu, onMsaField, onPa, onTogglePin, onMsaCsv, onMsaTable, onPickPa,
  instruments, footprints, onToggleFootprint, onFitFootprints,
}: {
  msaOn: boolean;
  ifuOn: boolean;
  msaFieldOn: boolean;
  paDeg: number;
  pinned: boolean;
  /** What the MSA rotates about on a PA change: "view" | "ref" | a fixed-slit label. */
  rotateAbout: string;
  onRotateAbout: (v: string) => void;
  /** Count of catalog sources inside the 4 MSA quadrants at the current centre + PA. */
  msaCount: number;
  /** Achievability of the current PA (= APA) at this field, or null if no lookup loaded. */
  paAchieve: ReturnType<typeof achievability> | null;
  onMsa: (v: boolean) => void;
  onIfu: (v: boolean) => void;
  onMsaField: (v: boolean) => void;
  onPa: (v: number) => void;
  onTogglePin: () => void;
  /** Download the in-MSA sources as CSV (id,ra,dec,za,mag). */
  onMsaCsv: () => void;
  /** Open the in-MSA sources in the Search page's results table (new tab). */
  onMsaTable: () => void;
  /** Jump the PA to a value (used by the "nearest achievable" shortcut). */
  onPickPa: (v: number) => void;
  /** Other JWST instruments available to overlay (from siaf_footprints.json). */
  instruments: SiafFootprints["instruments"];
  /** Instrument keys currently shown. */
  footprints: Set<string>;
  onToggleFootprint: (key: string, on: boolean) => void;
  /** Zoom/pan the map to fit every enabled overlay. */
  onFitFootprints: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anyOn = msaOn || ifuOn || msaFieldOn || footprints.size > 0;
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
          color: anyOn ? "#5ee0e0" : "var(--accent)", fontSize: "0.72rem", letterSpacing: "0.08em",
          padding: "9px 11px",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", fontSize: "0.7rem" }}>▸</span>
        JWST Footprints{anyOn ? " ●" : ""}
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px" }}>
          {/* Quick how-to — keeps footprint planning discoverable without a separate help page. */}
          <p style={{ fontSize: "0.64rem", lineHeight: 1.55, color: "var(--text-dim)", margin: "0 0 11px" }}>
            Overlay JWST apertures, set the <b style={{ color: "var(--text-muted)" }}>PA</b> (this is the
            Aperture PA — request it as the APT ORIENT; the pointing V3PA is also shown), and drag the
            handle to place them. To plan against your own targets, upload a list on{" "}
            <a href="/unicorn/data/search" style={{ color: "var(--accent)" }}>Search → Upload</a>{" "}
            with <i>“plot as-is”</i>. Overlay accuracy ≈0.1″ (set by the imagery); shutter-level MSA
            design still needs MPT.
          </p>
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

          {/* Other JWST instruments — SIAF-exact footprints at their true focal-plane offsets from
              the NIRSpec MSA. Check any number; they all share the pin + PA below, so one V3PA rolls
              the whole focal plane together. */}
          {instruments.length > 0 && (
            <div style={{ marginTop: 2, marginBottom: 4, borderTop: "1px solid var(--border-bright)", paddingTop: 9 }}>
              <div className="mono" style={{ fontSize: "0.6rem", letterSpacing: "0.08em", color: "var(--text-dim)", marginBottom: 8 }}>
                OTHER INSTRUMENTS
              </div>
              {instruments.map(ins => (
                <label key={ins.key} style={row}>
                  <input type="checkbox" checked={footprints.has(ins.key)}
                    onChange={e => onToggleFootprint(ins.key, e.target.checked)}
                    style={{ accentColor: ins.color, width: 15, height: 15 }} />
                  <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: ins.color, flexShrink: 0 }} />
                  <span style={{ fontSize: "0.72rem", color: "var(--text)" }}>{ins.label}</span>
                </label>
              ))}
            </div>
          )}

          {anyOn && (
            <button
              onClick={onFitFootprints}
              className="mono"
              title="Zoom out so every enabled overlay (MSA field + checked instruments) fits — the JWST focal plane spans ~15′."
              style={{
                width: "100%", marginBottom: 9, background: "none",
                border: "1px solid var(--border-bright)", borderRadius: 5,
                color: "var(--text-muted)", cursor: "pointer", fontSize: "0.68rem", padding: "6px 10px",
              }}
            >
              ⤢ Zoom to fit all footprints
            </button>
          )}

          {/* In-MSA catalog readout + handoffs — shown only while the MSA-field overlay is on.
              The count updates live as the centre / PA change (project() re-collects each frame).
              CSV downloads id,ra,dec,za,mag; "table ↗" opens the matched objects on the Search
              page's sortable results table (new tab). Both are no-ops with an empty set. */}
          {msaFieldOn && (
            <div style={{ marginBottom: 9, paddingLeft: 23 }}>
              <div className="mono" style={{ fontSize: "0.66rem", color: "#f0b050", marginBottom: 6 }}>
                ⓘ {msaCount.toLocaleString()} source{msaCount === 1 ? "" : "s"} in MSA
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={onMsaCsv}
                  disabled={msaCount === 0}
                  className="mono"
                  title="Download the in-MSA catalog sources as CSV (id,ra,dec,za,mag)"
                  style={{
                    flex: 1, background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
                    color: msaCount === 0 ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: msaCount === 0 ? "default" : "pointer", opacity: msaCount === 0 ? 0.55 : 1,
                    fontSize: "0.66rem", padding: "5px 6px",
                  }}
                >
                  ⬇ CSV
                </button>
                <button
                  onClick={onMsaTable}
                  disabled={msaCount === 0}
                  className="mono"
                  title="Open these in-MSA sources in the Search results table (new tab)"
                  style={{
                    flex: 1, background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
                    color: msaCount === 0 ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: msaCount === 0 ? "default" : "pointer", opacity: msaCount === 0 ? 0.55 : 1,
                    fontSize: "0.66rem", padding: "5px 6px",
                  }}
                >
                  ▤ table ↗
                </button>
              </div>
            </div>
          )}

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
            {/* Live JWST V3PA at the NIRSpec pointing (V3PA = aperture PA − NIRSpec MSA V3IdlYAngle),
                shown to 2 decimals (0.1° ≈ 0.7″ at MIRI). The EXACT round-trip is to request the
                slider PA below as the APT Aperture PA (ORIENT); this V3PA uses the jwst_gtvt
                pointing convention and can differ from a V1-referenced V3PA by ~0.1–0.3°. */}
            <div className="mono" style={{ fontSize: "0.62rem", color: "var(--text-dim)", marginTop: 3 }}
              title="V3 position angle AT THE NIRSpec pointing (aperture PA − 138.5746°), jwst_gtvt convention — matches the achievability check below. For an exact overlay in APT, request the Aperture PA (the slider value) as the ORIENT special requirement; a V1-referenced V3PA can differ by up to ~0.3° (a few arcsec at MIRI).">
              V3PA ≈ <span style={{ color: "var(--accent2)" }}>{((((paDeg - NRS_MSA_V3IDLYANGLE) % 360) + 360) % 360).toFixed(2)}°</span>
              <span style={{ color: "var(--text-dim)" }}> (at pointing)</span>
            </div>
            <input
              type="number" aria-label="Position angle degrees" value={paDeg}
              onChange={e => onPa(Number(e.target.value))}
              style={{
                width: "100%", marginTop: 5, background: "var(--bg)",
                border: "1px solid var(--border-bright)", borderRadius: 5, color: "var(--text)",
                fontFamily: "'Space Mono', monospace", fontSize: "0.72rem", padding: "4px 7px",
              }}
            />
            <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 2 }}>east of north · this IS the Aperture PA — request it as the APT ORIENT</div>

            {/* Pivot for PA rotation: keep this point fixed on the sky as you roll. "View centre"
                (your target) is the default; a fixed slit keeps that slit pinned so a source stays
                in it while the rest of the mask swings; "MSA centre" pivots about the field centre. */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, fontSize: "0.62rem", color: "var(--text-muted)" }}>
              <span style={{ whiteSpace: "nowrap" }}>rotate about</span>
              <select
                value={rotateAbout}
                onChange={e => onRotateAbout(e.target.value)}
                aria-label="Rotate MSA about"
                style={{
                  flex: 1, background: "var(--bg)", border: "1px solid var(--border-bright)",
                  borderRadius: 5, color: "var(--text)", fontFamily: "'Space Mono', monospace",
                  fontSize: "0.66rem", padding: "3px 6px", cursor: "pointer",
                }}
              >
                <option value="view">View centre (target)</option>
                <option value="ref">MSA centre (field)</option>
                {MSA_SLITS_DS.map(sl => <option key={sl.label} value={sl.label}>{sl.label} slit</option>)}
              </select>
            </label>

            {/* Achievability of this PA at the field (from public/nirspec/v3pa/<id>.json,
                jwst_gtvt over 1 yr). Green = some observable date can roll to this APA;
                amber = out of range, with the nearest achievable APA as a one-click shortcut.
                Hidden entirely when no lookup is loaded for the field. */}
            {paAchieve && (
              <div className="mono" style={{
                marginTop: 7, padding: "6px 8px", borderRadius: 5, fontSize: "0.62rem", lineHeight: 1.4,
                background: paAchieve.achievable ? "rgba(60,180,120,0.12)" : "rgba(240,176,80,0.13)",
                border: `1px solid ${paAchieve.achievable ? "rgba(60,180,120,0.5)" : "rgba(240,176,80,0.55)"}`,
                color: paAchieve.achievable ? "#7fe0b0" : "#f0c070",
              }}>
                {paAchieve.achievable ? (
                  <>
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>✓ PA achievable</div>
                    <div style={{ color: "var(--text-muted)" }}>
                      observable{paAchieve.dates.length > 1 ? " windows" : ""}:{" "}
                      {paAchieve.dates.slice(0, 3).map(d => d.start === d.end ? d.start : `${d.start}→${d.end}`).join(", ")}
                      {paAchieve.dates.length > 3 ? " …" : ""}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>⚠ PA not achievable this year</div>
                    {paAchieve.nearestApa != null && (
                      <div style={{ color: "var(--text-muted)" }}>
                        nearest achievable PA:{" "}
                        <button
                          onClick={() => onPickPa(paAchieve.nearestApa!)}
                          className="mono"
                          title="Set the PA to the nearest achievable aperture PA"
                          style={{
                            background: "none", border: "none", padding: 0, cursor: "pointer",
                            color: "#f0c070", textDecoration: "underline", fontSize: "0.62rem",
                          }}
                        >{paAchieve.nearestApa.toFixed(1)}°</button>
                        {paAchieve.nearestDates.length > 0 && (
                          <> · {paAchieve.nearestDates.slice(0, 2).map(d => d.start === d.end ? d.start : `${d.start}→${d.end}`).join(", ")}</>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <button
            onClick={onTogglePin}
            className="mono"
            title={pinned
              ? "Locked in place — click to unlock, then drag the white handle to move the aperture"
              : "Drag the white handle to move the aperture. Click here to lock it so the map pans without moving it."}
            style={{
              width: "100%", background: pinned ? "var(--accent-dim)" : "none",
              border: "1px solid var(--border-bright)", borderRadius: 5,
              color: pinned ? "var(--accent)" : "var(--text-muted)", cursor: "pointer",
              fontSize: "0.68rem", padding: "6px 10px",
            }}
          >
            {pinned ? "🔒 Locked · click to move" : "⠿ Drag to move · click to lock"}
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
