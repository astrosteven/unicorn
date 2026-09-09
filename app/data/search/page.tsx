"use client";
import { useState, useRef, useEffect, Fragment, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useRouter } from "next/navigation";
import JSZip from "jszip";
import { FITSGL_BASE, CAMPFIRE_TRILOGY } from "@/app/data/_card/FitsglCutout";  // fields with a fitsgl map + campfire stretch
// Shared object-card module (data wiring + card renderer), also used by the Explore/Map page.
import {
  FILTER_WAVES,
  SEARCH_FIELDS,
  loadField,
  loadFilters,
  loadSpecz,
  loadLabels,
  fetchObject,
  corralBase,
  angSep,
  campfireUrl,
  qualityColor,
  QUALITY,
  SEDPlot,
  PZPlot,
  ResultCard,
  type SourceResult,
  type SpeczRec,
  type ZGrid,
} from "@/app/data/_card/objectCard";

type SearchMode = "id" | "name" | "radec" | "upload" | "query";
type ResultState = "idle" | "searching" | "found" | "notfound" | "multi" | "table";
type QueryRow = { fc: typeof SEARCH_FIELDS[0]; id: number; za: number | null; m444: number | null; zspec: number | null; selected: number | null; cz: SpeczRec | null; extra: (number | string | null)[] };

// ---- SQL-style query over the search index ---------------------------------
type IdxRow = Record<string, number | string | null>;
// Numeric queryable columns (must exist in the index).
const QUERY_NUM = ["za", "zl68", "zu68", "z_lowz", "chia", "m277", "m444", "m1500", "m1300", "mabs", "beta", "zspec",
  "czspec", "czqual",
  "rh_277", "rh_444", "kron_radius", "a_image", "b_image", "x", "y", "depthtier",
  "ra", "dec", "selected", "inspected", "sample"];
const QUERY_STR = ["field", "detectcat", "tile"];

// Per-filter photometry is queryable too. The site stores NATIVE bare flux_<f> + fluxerr_<f>
// (nJy) in a separate lazy-loaded <prefix>_filters file, and derives these on the fly:
//   flux_<filt>  native catalog flux (nJy)          e.g.  flux_f150w > 100
//   mag_<filt>   AB mag = 31.4 − 2.5·log10(flux)     e.g.  mag_f277w < 28
//   snr_<filt>   S/N = flux / fluxerr                e.g.  snr_f444w > 5
//   <filtA>-<filtB>  color = −2.5·log10(fA/fB)       e.g.  f150w-f277w < 0.5
// Colors use a 1σ UPPER LIMIT (flux → fluxerr) for any band with S/N < 1, matching how
// a dropout is treated in the catalog. A field lacking a band yields no match for it.
const KNOWN_FILTERS = new Set(Object.keys(FILTER_WAVES).map(f => f.toLowerCase()));
const RE_MAGSNR = /^(mag|snr|flux)_([a-z0-9]+)$/;
const RE_COLOR  = /^([a-z][a-z0-9]*)-([a-z][a-z0-9]*)$/;
const LIMIT_SNR = 1;   // bands with S/N below this are treated as non-detections in colors

// Is `f` a queryable field name (built-in, per-filter, or color)?
function isKnownField(f: string): boolean {
  if (QUERY_NUM.includes(f) || QUERY_STR.includes(f)) return true;
  let m: RegExpMatchArray | null;
  if ((m = f.match(RE_MAGSNR))) return KNOWN_FILTERS.has(m[2]);
  if ((m = f.match(RE_COLOR)))  return KNOWN_FILTERS.has(m[1]) && KNOWN_FILTERS.has(m[2]);
  return false;
}
// The flux (nJy) to use for a band in a COLOR: the measured flux if S/N ≥ 1, else the
// 1σ upper limit (= fluxerr). Returns null if the band's flux/err aren't available.
function bandColorFlux(r: IdxRow, band: string): number | null {
  const f = r[`flux_${band}`], e = r[`fluxerr_${band}`];
  if (typeof f !== "number" || typeof e !== "number" || !(e > 0)) return null;
  const used = (f / e >= LIMIT_SNR) ? f : e;   // non-detection → 1σ limit
  return used > 0 ? used : null;
}
// A value-extractor for a column, all derived from the native stored flux_<f>/fluxerr_<f>.
function colGetter(col: string): (r: IdxRow) => number | string | null {
  let m: RegExpMatchArray | null;
  if ((m = col.match(/^flux_([a-z0-9]+)$/)) && KNOWN_FILTERS.has(m[1])) {
    const fc = `flux_${m[1]}`;
    return r => { const f = r[fc]; return typeof f === "number" ? f : null; };
  }
  if ((m = col.match(/^mag_([a-z0-9]+)$/)) && KNOWN_FILTERS.has(m[1])) {
    const fc = `flux_${m[1]}`;
    return r => { const f = r[fc]; return (typeof f === "number" && f > 0) ? 31.4 - 2.5 * Math.log10(f) : null; };
  }
  if ((m = col.match(/^snr_([a-z0-9]+)$/)) && KNOWN_FILTERS.has(m[1])) {
    const fc = `flux_${m[1]}`, ec = `fluxerr_${m[1]}`;
    return r => { const f = r[fc], e = r[ec]; return (typeof f === "number" && typeof e === "number" && e > 0) ? f / e : null; };
  }
  if ((m = col.match(RE_COLOR)) && KNOWN_FILTERS.has(m[1]) && KNOWN_FILTERS.has(m[2])) {
    const a = m[1], b = m[2];
    return r => { const fa = bandColorFlux(r, a), fb = bandColorFlux(r, b); return (fa != null && fb != null) ? -2.5 * Math.log10(fa / fb) : null; };
  }
  return r => r[col] ?? null;   // stored built-ins: QUERY_NUM/STR
}
// The raw index columns a query needs attached to each row: the native flux_<f>/fluxerr_<f>
// for every band its mag/snr/flux/color tokens reference (all derived quantities read these).
function neededIndexCols(query: string): string[] {
  const q = query.toLowerCase();
  const bands = new Set<string>();
  for (const m of q.matchAll(/\b(?:mag|snr|flux)_([a-z0-9]+)\b/g)) if (KNOWN_FILTERS.has(m[1])) bands.add(m[1]);
  for (const m of q.matchAll(/\b([a-z][a-z0-9]*)-([a-z][a-z0-9]*)\b/g)) {
    if (KNOWN_FILTERS.has(m[1])) bands.add(m[1]);
    if (KNOWN_FILTERS.has(m[2])) bands.add(m[2]);
  }
  const cols: string[] = [];
  for (const b of bands) cols.push(`flux_${b}`, `fluxerr_${b}`);
  return cols;
}

// Columns the results table always shows; other queried columns are added dynamically.
const TABLE_FIXED_COLS = new Set(["id", "za", "m444", "zspec", "selected"]);
const TABLE_CAP = 500;   // rows rendered in the results table (full set is retained separately)
// Which queryable columns a query references (as whole words), minus the fixed ones —
// these get added to the results table so you see what you filtered on. Includes the
// per-filter mag/snr/flux columns and color terms.
function queriedColumns(query: string): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  const add = (c: string) => { if (!TABLE_FIXED_COLS.has(c) && !out.includes(c)) out.push(c); };
  for (const c of [...QUERY_NUM, ...QUERY_STR]) if (new RegExp(`\\b${c}\\b`).test(q)) add(c);
  for (const m of q.matchAll(/\b(?:mag|snr|flux)_[a-z0-9]+\b/g)) { const c = m[0]; if (isKnownField(c)) add(c); }
  for (const m of q.matchAll(/\b[a-z][a-z0-9]*-[a-z][a-z0-9]*\b/g)) { const c = m[0]; if (isKnownField(c)) add(c); }
  return out;
}

// Compact cell formatter for the dynamic columns.
function fmtCell(v: number | string | null): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
  return String(v);
}

// ---- Sortable results table -------------------------------------------------
// One entry of the FULL retained match set (queryAllRef): field cfg + index row + campfire.
type MatchEntry = { fc: typeof SEARCH_FIELDS[0]; id: number; r: IdxRow; cz: SpeczRec | null };
type SortState = { col: string | null; dir: "asc" | "desc" };
// Value-extractor for a sortable column, keyed by the header label / dynamic queryCol name.
// Fixed columns read the fixed fields; dynamic queryCols use colGetter on the index row.
function sortValueGetter(col: string): (m: MatchEntry) => number | string | null {
  switch (col) {
    case "ID":       return m => m.id;
    case "field":    return m => m.fc.field;
    case "z_a":      return m => (typeof m.r.za === "number" ? m.r.za : null);
    case "m₄₄₄":     return m => (typeof m.r.m444 === "number" ? m.r.m444 : null);
    case "zspec":    return m => (typeof m.r.zspec === "number" && m.r.zspec > 0 ? m.r.zspec : null);
    case "campfire": return m => (m.cz && typeof m.cz.z === "number" ? m.cz.z : null);
    case "selected": return m => (typeof m.r.selected === "number" ? m.r.selected : null);
    default: { const g = colGetter(col); return m => g(m.r); }   // dynamic queryCol
  }
}
// Non-sortable header labels (links / expand arrow — no meaningful order).
const UNSORTABLE_COLS = new Set(["", "map"]);
// Sort a copy of the full match set by `col`/`dir`; nulls always sort to the END.
function sortMatches(all: MatchEntry[], col: string, dir: "asc" | "desc"): MatchEntry[] {
  const get = sortValueGetter(col);
  const sign = dir === "asc" ? 1 : -1;
  const keyed = all.map(m => ({ m, v: get(m) }));
  keyed.sort((a, b) => {
    const av = a.v, bv = b.v;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;    // nulls last, both directions
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
  return keyed.map(k => k.m);
}

// Parse a WHERE-style expression into a predicate + the raw index columns it needs attached.
// Supports AND/OR with parentheses for grouping (AND binds tighter than OR, standard),
// e.g.  za > 12 and selected = 1 and (snr_f277w >= 10 or snr_f356w >= 10). Leaf conditions:
// numeric fields > < >= <= = != and `between a and b`; string fields (field, detectcat, tile)
// = / !=; `= none` tests a missing value. Per-filter mag_/snr_/flux_ and colors <a>-<b>.
type Pred = (r: IdxRow) => boolean;
function makePredicate(query: string): { test: Pred; need: string[] } | { error: string } {
  let q = query.trim().toLowerCase();
  if (!q) return { error: "Type a condition, e.g.  za > 9 and m444 < 28" };
  // Protect the "and" inside `between a and b` so tokenizing on AND/OR won't split it.
  // "__and__" has no \band\b boundary (underscores are word chars), so the tokenizer skips it.
  q = q.replace(/between\s+(-?[\d.]+)\s+and\s+(-?[\d.]+)/g, "between $1 __and__ $2");

  const FIELD = "([a-z][\\w]*(?:-[a-z0-9]+)?)";
  // Parse ONE leaf condition -> predicate (or an error).
  function parseLeaf(raw: string): Pred | { error: string } {
    const part = raw.replace(/__and__/g, "and").trim();
    let m: RegExpMatchArray | null;
    if ((m = part.match(new RegExp(`^${FIELD}\\s+between\\s+(-?[\\d.]+)\\s+and\\s+(-?[\\d.]+)$`)))) {
      const f = m[1], lo = parseFloat(m[2]), hi = parseFloat(m[3]);
      if (!isKnownField(f)) return { error: `Unknown field "${f}"` };
      if (QUERY_STR.includes(f)) return { error: `"${f}" can't use between (not numeric)` };
      const get = colGetter(f);
      return r => { const v = get(r); return typeof v === "number" && v >= lo && v <= hi; };
    }
    if ((m = part.match(new RegExp(`^${FIELD}\\s*(>=|<=|!=|==|=|>|<)\\s*(.+)$`)))) {
      const f = m[1], op = m[2], valraw = m[3].trim().replace(/^['"]|['"]$/g, "");
      if (!isKnownField(f)) return { error: `Unknown field "${f}"` };
      if (QUERY_STR.includes(f)) {
        if (op !== "=" && op !== "==" && op !== "!=") return { error: `use = or != on "${f}"` };
        return r => { const v = r[f]; if (v == null) return false; const eq = String(v).toLowerCase() === valraw; return op === "!=" ? !eq : eq; };
      }
      if (valraw === "none" || valraw === "null") {   // missing-value test, e.g. czspec = none
        if (op !== "=" && op !== "==" && op !== "!=") return { error: `use = or != with "none"` };
        const get = colGetter(f);
        return r => { const v = get(r); const missing = v == null || (typeof v === "number" && !Number.isFinite(v)); return op === "!=" ? !missing : missing; };
      }
      const x = parseFloat(valraw);
      if (!Number.isFinite(x)) return { error: `"${valraw}" is not a number` };
      const get = colGetter(f);
      return r => {
        const v = get(r);
        if (typeof v !== "number" || !Number.isFinite(v)) return false;
        switch (op) {
          case ">": return v > x; case "<": return v < x;
          case ">=": return v >= x; case "<=": return v <= x;
          case "!=": return v !== x; default: return v === x;
        }
      };
    }
    return { error: `Could not parse "${part}". Try  field op value  (e.g. za > 9).` };
  }

  // Tokenize into ( ) and or, plus condition strings between them.
  type Tok = { t: "(" | ")" | "and" | "or" } | { t: "cond"; v: string };
  const toks: Tok[] = [];
  const re = /(\()|(\))|\b(and)\b|\b(or)\b/g;
  let last = 0, mm: RegExpExecArray | null;
  while ((mm = re.exec(q)) !== null) {
    const c = q.slice(last, mm.index).trim();
    if (c) toks.push({ t: "cond", v: c });
    toks.push({ t: (mm[1] ? "(" : mm[2] ? ")" : mm[3] ? "and" : "or") } as Tok);
    last = re.lastIndex;
  }
  const tail = q.slice(last).trim();
  if (tail) toks.push({ t: "cond", v: tail });

  // Recursive descent:  or := and (or and)* ;  and := factor (and factor)* ;  factor := ( or ) | cond
  let pos = 0, parseErr: string | null = null;
  const peek = () => toks[pos];
  function parseOr(): Pred | null {
    const first = parseAnd(); if (!first) return null;
    let node: Pred = first;
    while (peek()?.t === "or") { pos++; const rhs = parseAnd(); if (!rhs) return null; const l: Pred = node; node = r => l(r) || rhs(r); }
    return node;
  }
  function parseAnd(): Pred | null {
    const first = parseFactor(); if (!first) return null;
    let node: Pred = first;
    while (peek()?.t === "and") { pos++; const rhs = parseFactor(); if (!rhs) return null; const l: Pred = node; node = r => l(r) && rhs(r); }
    return node;
  }
  function parseFactor(): Pred | null {
    const tk = peek();
    if (!tk) { parseErr = "Unexpected end of query."; return null; }
    if (tk.t === "(") {
      pos++;
      const inner = parseOr(); if (!inner) return null;
      if (peek()?.t !== ")") { parseErr = "Missing ')'."; return null; }
      pos++;
      return inner;
    }
    if (tk.t === "cond") {
      pos++;
      const leaf = parseLeaf(tk.v);
      if (typeof leaf !== "function") { parseErr = leaf.error; return null; }
      return leaf;
    }
    parseErr = `Unexpected "${tk.t}".`;
    return null;
  }

  const tree = parseOr();
  if (!tree) return { error: parseErr ?? "Could not parse the query." };
  if (pos !== toks.length) return { error: "Unbalanced parentheses in the query." };
  return { test: tree, need: neededIndexCols(query) };
}

// Rasterize a live on-page <svg> (with CSS-variable colors resolved via getComputedStyle)
// to a PNG blob, for bundling plots into the results download. No external refs → no taint.
async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const live = svg.querySelectorAll("*");
  const cl = clone.querySelectorAll("*");
  const inline = (l: Element, c: Element) => {
    const cs = getComputedStyle(l);
    (["fill", "stroke", "color", "stop-color"] as const).forEach(p => {
      const v = cs.getPropertyValue(p);
      if (v && v !== "none" && !v.includes("var(")) c.setAttribute(p, v);
    });
  };
  inline(svg, clone);
  live.forEach((n, i) => { if (cl[i]) inline(n, cl[i]); });
  const vb = svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : (svg.clientWidth || 480);
  const h = vb && vb.height ? vb.height : (svg.clientHeight || 300);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
  bg.setAttribute("fill", getComputedStyle(document.body).backgroundColor || "#0b0817");
  clone.insertBefore(bg, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  const img = new Image();
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = url; });
  } catch { return null; }
  const cv = document.createElement("canvas");
  cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return await new Promise<Blob | null>(res => cv.toBlob(b => res(b), "image/png"));
}

// Load a Blob into an <img> (for canvas compositing).
function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = e => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

// Compose ONE image per object: a header line, SED + P(z) (+ the on-the-fly color
// cutout) side-by-side, and the stamp montage below — so the card download is one
// self-describing file per source.
async function composeCardImage(src: SourceResult, sed: HTMLImageElement | null, pz: HTMLImageElement | null, stamp: HTMLImageElement | null, color: HTMLImageElement | null): Promise<Blob | null> {
  const pad = 16, gap = 14, headerH = 34;
  // The color cutout renders alongside the plots in the top row. Match its drawn
  // height to the taller of the two plots so the row lines up; keep it square.
  const plotsH = Math.max(sed?.height ?? 0, pz?.height ?? 0);
  const colLabelH = color ? 16 : 0;
  const colSide = color ? (plotsH > 0 ? plotsH - colLabelH : color.height) : 0;
  const topH = Math.max(plotsH, colLabelH + colSide);
  const topW = (sed?.width ?? 0)
    + (pz ? (sed ? gap : 0) + pz.width : 0)
    + (color ? ((sed || pz) ? gap : 0) + colSide : 0);
  const stampW = stamp?.width ?? 0, stampH = stamp?.height ?? 0;
  const contentW = Math.max(topW, stampW);
  const W = contentW + pad * 2;
  const H = pad + headerH + topH + (stamp ? gap + stampH : 0) + pad;
  if (contentW < 10 || H < 60) return null;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const cs = getComputedStyle(document.body);
  ctx.fillStyle = cs.backgroundColor || "#0b0817";
  ctx.fillRect(0, 0, W, H);
  // Header
  const za = src.pz?.["ZA"], ra = src.row?.["RA"], dec = src.row?.["DEC"];
  const hdr = `ID ${src.row?.["ID"]} · ${src.field}`
    + (za != null ? ` · z_a=${Number(za).toFixed(2)}` : "")
    + (src.mabs != null ? ` · M_UV=${Number(src.mabs).toFixed(2)}` : "")
    + (ra != null && dec != null ? `   ${Number(ra).toFixed(5)}, ${Number(dec).toFixed(5)}` : "");
  ctx.fillStyle = cs.color || "#e8e2f2";
  ctx.font = "bold 15px 'Space Mono', monospace";
  ctx.textBaseline = "top";
  ctx.fillText(hdr, pad, pad);
  // Plots row
  const topY = pad + headerH;
  if (sed) ctx.drawImage(sed, pad, topY);
  if (pz) ctx.drawImage(pz, pad + (sed ? sed.width + gap : 0), topY);
  // Color cutout, drawn square to the right of the plots with a small label.
  if (color && colSide > 0) {
    const colX = pad + (sed?.width ?? 0) + (pz ? (sed ? gap : 0) + pz.width : 0) + ((sed || pz) ? gap : 0);
    ctx.fillStyle = cs.color || "#e8e2f2";
    ctx.font = "11px 'Space Mono', monospace";
    ctx.fillText("COLOR", colX, topY);
    ctx.drawImage(color, colX, topY + colLabelH, colSide, colSide);
  }
  // Stamp montage
  if (stamp) ctx.drawImage(stamp, pad, topY + topH + gap);
  return await new Promise<Blob | null>(res => cv.toBlob(b => res(b), "image/png"));
}

// The SED + P(z) plots for one object, rendered off-screen so the download can rasterize
// them. Mirrors ResultCard's P(z) normalization.
function CardPlots({ src }: { src: SourceResult }) {
  const za = src.pz["ZA"] ?? 0;
  const normalize = (arr: number[] | undefined, grid: number[] | undefined) => {
    if (!arr || !grid || arr.length !== grid.length) return undefined;
    const nrm = arr.reduce((s, v, i) => s + v * (grid[i + 1] - grid[i] || 0.02), 0) || 1;
    return arr.map(v => v / nrm);
  };
  const pzNorm = normalize(src.pzArr, src.zgrid) ?? src.pzArr;
  const pzLowzNorm = normalize(src.pzArrLowz, src.zgridLowz);
  return (
    <div style={{ width: 500 }}>
      {/* data-plot wrappers so the download grabs the MAIN plot svg, not the SED legend's glyph svgs */}
      <div data-plot="sed"><SEDPlot src={src} /></div>
      <div data-plot="pz"><PZPlot zgrid={src.zgrid} pz={pzNorm} za={za} zgridLowz={src.zgridLowz} pzLowz={pzLowzNorm} /></div>
    </div>
  );
}

// ---- On-the-fly color cutout capture (for the download) ---------------------
// The card's color panel is a live WebGL viewer (@fitsgl/core FitsViewer) with NO
// pre-baked PNG for most fields. To fold that color into the composed download image
// we render a throwaway off-screen FitsViewer at the object's sky position, apply the
// SAME campfire trilogy the /data/map + card use, wait for the first correctly-placed
// frame, then grab a PNG via the core viewer's exportPNG(). exportPNG() forces a
// synchronous draw()+readPixels() in one task BEFORE the browser composites, so it
// returns a real (non-blank) image even though the viewer's WebGL2 context is created
// WITHOUT preserveDrawingBuffer — a naive canvas.toDataURL() here would read blank.
//
// Everything is loaded lazily (dynamic import inside the click handler) so the WebGL
// bundle never touches page prerender and only loads when a download is requested.

// The @fitsgl/core pieces we need, resolved once per download run via dynamic import.
type FitsglMod = {
  FitsViewer: ComponentType<any>;
  loadFitsglConfig: (url: string) => Promise<any>;
  skyToPix: (wcs: any, ra: number, dec: number) => { x: number; y: number };
  DEFAULT_TRILOGY_PARAMS: any;
  explorerBandsFromConfig: (c: any) => any;
  defaultViewFromConfig: (c: any) => any;
  defaultExplorerState: (eb: any, view: any) => any;
  deriveViewerConfig: (eb: any, state: any) => any;
};
async function loadFitsgl(): Promise<FitsglMod> {
  const [core, react] = await Promise.all([import("@fitsgl/core"), import("@fitsgl/core/react")]);
  return {
    FitsViewer: react.FitsViewer as unknown as ComponentType<any>,
    loadFitsglConfig: core.loadFitsglConfig,
    skyToPix: core.skyToPix,
    DEFAULT_TRILOGY_PARAMS: core.DEFAULT_TRILOGY_PARAMS,
    explorerBandsFromConfig: react.explorerBandsFromConfig,
    defaultViewFromConfig: react.defaultViewFromConfig,
    defaultExplorerState: react.defaultExplorerState,
    deriveViewerConfig: react.deriveViewerConfig,
  };
}

// A field's derived ViewerConfig + campfire trilogy params + per-band stats, cached for
// the run (mirrors FitsglCutout.prepare, so one field is set up at most once per zip).
type ColorPrep = { viewer: any; params: any; single: boolean; stats: any[] | null; pixelScale: number };
async function prepareColor(mod: FitsglMod, base: string): Promise<ColorPrep> {
  const fitsgl = await mod.loadFitsglConfig(`${base}/fitsgl.json`);
  const eb = mod.explorerBandsFromConfig(fitsgl);
  const state = mod.defaultExplorerState(eb, mod.defaultViewFromConfig(fitsgl));
  const viewer = mod.deriveViewerConfig(eb, state);
  const params = { ...mod.DEFAULT_TRILOGY_PARAMS, ...state.trilogyParams, ...CAMPFIRE_TRILOGY };
  const v = viewer.view;
  const names: string[] =
    v.mode === "single" ? [v.band] : v.mode === "rgb" ? [v.r, v.g, v.b] : v.bands.map((b: any) => b.band);
  const raw = names.map((n) => eb.find((b: any) => b.name === n)?.trilogy);
  const stats = raw.every((s: any) => s !== undefined) ? raw : null;
  const g = fitsgl.dataset.bands[0]?.grid?.pixelScaleArcsec;
  return { viewer, params, single: v.mode === "single", stats, pixelScale: g && g > 0 ? g : 0.03 };
}

// Reproduce FitsExplorer's applyTrilogyFromStats on the bare core viewer.
function applyColorTrilogy(viewer: any, prep: ColorPrep): boolean {
  if (prep.stats === null) return false;
  const expectedMode = prep.single ? "single" : "multiband";
  if (viewer.sourceMode !== expectedMode) return false;
  viewer.applyTrilogy(prep.single ? prep.stats[0] : prep.stats, prep.params);
  viewer.setStretchMode("trilogy");
  return true;
}

const COLOR_CAPTURE_PX = 200;      // backing size of the throwaway viewer (CSS px)
const COLOR_FOV_ARCSEC = 2.4;      // matches the card / retired static RGB stamp

// One throwaway off-screen viewer that renders the object's color, then hands its PNG
// data URL back via onDone (exactly once — captured or, on prop-driven timeout, null).
// Rendered into the shared holder root, one object at a time (serial), so we never
// exceed the browser's WebGL context cap.
function ColorCapture({ mod, prep, ra, dec, onDone }: {
  mod: FitsglMod; prep: ColorPrep; ra: number; dec: number; onDone: (url: string | null) => void;
}) {
  const handleRef = useRef<any>(null);
  const doneRef = useRef(false);
  const placedRef = useRef(false);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finish = (url: string | null) => {
    if (settleRef.current) { clearTimeout(settleRef.current); settleRef.current = null; }
    if (!doneRef.current) { doneRef.current = true; onDone(url); }
  };
  useEffect(() => () => { if (settleRef.current) clearTimeout(settleRef.current); }, []);

  // Center on the target and zoom to COLOR_FOV_ARCSEC across COLOR_CAPTURE_PX. Same math
  // as FitsglCutout.placeCamera. Returns false until wcs is available.
  const place = (): boolean => {
    const h = handleRef.current;
    if (!h) return false;
    const viewer = h.getViewer?.();
    if (!viewer) return false;
    const wcs = viewer.getWcs?.();
    if (!wcs) return false;
    const px = mod.skyToPix(wcs, ra, dec);
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return false;
    h.setCenter(px.x, px.y);
    const nativeAcross = COLOR_FOV_ARCSEC / prep.pixelScale;
    if (nativeAcross > 0) h.setZoom(COLOR_CAPTURE_PX / nativeAcross);
    return true;
  };

  const onReady = (h: any) => {
    handleRef.current = h;
    const viewer = h.getViewer?.();
    if (viewer) applyColorTrilogy(viewer, prep);
    place();
  };

  // Grab the PNG synchronously (exportPNG forces draw()+readPixels() in one task, so the
  // drawing buffer is valid without preserveDrawingBuffer).
  const grab = () => {
    if (doneRef.current) return;
    try {
      const url = handleRef.current?.exportPNG?.() ?? null;
      finish(url);   // even a partial paint beats no color; null is handled upstream
    } catch { finish(null); }
  };

  // On the first correctly-placed frame, arm a short settle so the newly-centered tiles
  // have time to stream in before we read the buffer, then capture. (Well within the
  // per-object timeout enforced by the caller.)
  const onFrame = () => {
    if (doneRef.current) return;
    if (!placedRef.current) {
      const viewer = handleRef.current?.getViewer?.();
      if (viewer) applyColorTrilogy(viewer, prep);
      if (place()) {
        placedRef.current = true;
        settleRef.current = setTimeout(grab, 700);
      }
    }
  };

  const FitsViewer = mod.FitsViewer;
  return (
    <FitsViewer
      config={prep.viewer}
      onReady={onReady}
      onFrame={onFrame}
      onError={() => finish(null)}
      style={{ width: COLOR_CAPTURE_PX, height: COLOR_CAPTURE_PX, pointerEvents: "none" }}
    />
  );
}

export default function SearchPage() {
  const [mode, setMode] = useState<SearchMode>("id");
  const [idInput, setIdInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [raInput, setRaInput] = useState("");
  const [decInput, setDecInput] = useState("");
  const [radiusInput, setRadiusInput] = useState("0.2");
  const [uploadText, setUploadText] = useState("");
  const [queryInput, setQueryInput] = useState("za > 9 and m444 < 28 and selected = 1");
  const [viewColsInput, setViewColsInput] = useState("");   // extra columns to SHOW (not filter on)
  const [queryRows, setQueryRows] = useState<QueryRow[]>([]);
  const [queryCols, setQueryCols] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ col: null, dir: "asc" });
  const [defsOpen, setDefsOpen] = useState(false);
  const [zipping, setZipping] = useState<string | null>(null);

  // Bundle a "result card" per shown row into one zip: the stamp montage (from Corral),
  // the SED and P(z) plots rasterized to PNG, and the on-the-fly WebGL color cutout.
  // Per-object detail is fetched concurrently; the plots are rendered off-screen and
  // rasterized serially (shared React root), and the color is captured serially in the
  // same root (one WebGL context at a time). Runs over the FULL matched set.
  async function downloadResultStamps() {
    if (!queryAllRef.current.length || zipping) return;
    const zip = new JSZip();
    // FULL matched set (every object, not just the ≤500 rendered in the table).
    const rows = queryAllRef.current.map(m => ({ fc: m.fc, id: m.id }));
    const total = rows.length;
    setZipping(`0/${total}`);

    // 1) Fetch per-object detail concurrently.
    const srcs: (SourceResult | null)[] = new Array(total).fill(null);
    const queue = rows.map((_, i) => i);
    let fetched = 0;
    async function fetchWorker() {
      while (queue.length) {
        const i = queue.shift()!;
        try {
          const { zg } = await loadField(rows[i].fc);
          srcs[i] = await fetchObject(rows[i].fc, rows[i].id, zg);
        } catch { /* skip */ }
        fetched++; if (fetched % 5 === 0 || fetched === total) setZipping(`fetch ${fetched}/${total}`);
      }
    }
    await Promise.all(Array.from({ length: 6 }, fetchWorker));

    // 1b) Color-cutout setup. Only if some matched field has fitsgl tiles. Load the WebGL
    // bundle once, and prepare (derive ViewerConfig + trilogy stats) each such field once.
    // Any failure here degrades gracefully — the cards just compose without color.
    const wantColor = rows.some(r => FITSGL_BASE[r.fc.field]);
    let fitsglMod: FitsglMod | null = null;
    const prepCache = new Map<string, ColorPrep | null>();   // field → prep (null = unavailable)
    if (wantColor) {
      try { fitsglMod = await loadFitsgl(); } catch { fitsglMod = null; }
    }
    async function getPrep(field: string): Promise<ColorPrep | null> {
      if (!fitsglMod) return null;
      const base = FITSGL_BASE[field];
      if (!base) return null;
      if (prepCache.has(field)) return prepCache.get(field)!;
      let p: ColorPrep | null = null;
      try { p = await prepareColor(fitsglMod, base); } catch { p = null; }
      prepCache.set(field, p);
      return p;
    }

    // 2) Compose ONE image per object: header + SED + P(z) + color + stamp montage (serial).
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-99999px;top:0;width:520px;pointer-events:none;";
    document.body.appendChild(holder);
    const root = createRoot(holder);
    const COLOR_TIMEOUT_MS = 2500;   // per-object cap so one slow cutout can't stall the zip

    // Capture the color for one object into `imgOut`, rendered in the shared root. Resolves
    // to an <img> (or null) within COLOR_TIMEOUT_MS. Fast-path: a pre-baked static RGB PNG
    // (CEERS only) is fetched directly; otherwise render a throwaway FitsViewer + exportPNG().
    async function captureColor(src: SourceResult, fc: typeof rows[0]["fc"]): Promise<HTMLImageElement | null> {
      const id = Number(src.row["ID"]);
      const ra = Number(src.row["RA"]), dec = Number(src.row["DEC"]);
      // Fast path: pre-baked static RGB PNG. Only CEERS has these baked (verified 200 for
      // CEERS, 404 elsewhere), so we only probe it there — cheap fetch → image.
      if (fc.field === "CEERS") {
        const rgbUrl = src.rgbUrl ?? `${corralBase()}/${fc.dir}/web/rgb/${fc.prefix}_${id}.png`;
        try {
          const resp = await fetch(rgbUrl);
          if (resp.ok) { const b = await resp.blob(); if (b.size > 0) return await blobToImage(b); }
        } catch { /* fall through to WebGL */ }
      }
      // WebGL path.
      if (!fitsglMod || !Number.isFinite(ra) || !Number.isFinite(dec)) return null;
      const prep = await getPrep(fc.field);
      if (!prep) return null;
      const mod = fitsglMod;
      const url = await new Promise<string | null>((resolve) => {
        let settled = false;
        const done = (u: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(u); } };
        const timer = setTimeout(() => done(null), COLOR_TIMEOUT_MS);
        flushSync(() => root.render(
          <ColorCapture mod={mod} prep={prep} ra={ra} dec={dec} onDone={done} />
        ));
      });
      // Unmount the viewer (render an empty slot) so its WebGL context is freed before the
      // next object mounts a new one — browsers cap live contexts.
      flushSync(() => root.render(<Fragment />));
      if (!url) return null;
      try { return await blobToImage(await (await fetch(url)).blob()); } catch { return null; }
    }

    let ok = 0;
    for (let i = 0; i < total; i++) {
      const src = srcs[i]; const r = rows[i];
      if (src) {
        const base = `${r.fc.field}_${r.id}`;
        let stampImg: HTMLImageElement | null = null;
        try {
          const resp = await fetch(src.stampUrl ?? `${corralBase()}/${r.fc.dir}/web/stamps/${r.fc.prefix}_${r.id}.png`);
          if (resp.ok) stampImg = await blobToImage(await resp.blob());
        } catch { /* field w/o stamps: skip */ }
        let sedImg: HTMLImageElement | null = null, pzImg: HTMLImageElement | null = null;
        try {
          flushSync(() => root.render(<CardPlots src={src} />));
          // The MAIN svg per wrapper (not the SED legend's small glyph svgs).
          const sedSvg = holder.querySelector('[data-plot="sed"] svg') as SVGSVGElement | null;
          const pzSvg  = holder.querySelector('[data-plot="pz"] svg')  as SVGSVGElement | null;
          if (sedSvg) { const b = await svgToPngBlob(sedSvg); if (b) sedImg = await blobToImage(b); }
          if (pzSvg)  { const b = await svgToPngBlob(pzSvg);  if (b) pzImg = await blobToImage(b); }
        } catch { /* rasterize failure: skip plots */ }
        // Color cutout (fast-path RGB, else WebGL capture; capped per object).
        let colorImg: HTMLImageElement | null = null;
        if (wantColor) { try { colorImg = await captureColor(src, r.fc); } catch { colorImg = null; } }
        const png = await composeCardImage(src, sedImg, pzImg, stampImg, colorImg);
        if (png) { zip.file(`${base}.png`, png); ok++; }
      }
      if (i % 3 === 0 || i === total - 1) setZipping(`render${wantColor ? "+color" : ""} ${i + 1}/${total}`);
    }
    root.unmount();
    holder.remove();

    if (ok === 0) { setZipping(null); return; }
    setZipping("zipping…");
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `unicorn_cards_${ok}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setZipping(null);
  }
  const [queryTotal, setQueryTotal] = useState(0);
  const [queryCard, setQueryCard] = useState<SourceResult | null>(null);
  const [queryCardId, setQueryCardId] = useState<number | null>(null);
  const [searchField, setSearchField] = useState<string>("all");
  const [status, setStatus] = useState<ResultState>("idle");
  const [results, setResults] = useState<SourceResult[]>([]);
  const [matchSummary, setMatchSummary] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLTableRowElement>(null);
  // Every matched object (index row + campfire match), retained for the FULL-list
  // download — not just the ≤500 rendered in the table.
  const queryAllRef = useRef<MatchEntry[]>([]);
  const router = useRouter();

  // Hand the current query's matched objects to the visual inspector (via sessionStorage).
  const INSPECT_HANDOFF_CAP = 10000;
  function sendToInspector() {
    const objs = queryAllRef.current.slice(0, INSPECT_HANDOFF_CAP).map(m => ({
      field: m.fc.field, id: m.id,
      ra: typeof m.r.ra === "number" ? m.r.ra : null,
      dec: typeof m.r.dec === "number" ? m.r.dec : null,
      za: typeof m.r.za === "number" ? m.r.za : null,
      mabs: typeof m.r.mabs === "number" ? m.r.mabs : null,
    }));
    if (!objs.length) return;
    try { sessionStorage.setItem("inspectQueue", JSON.stringify({ label: queryInput, objects: objs })); } catch { /* quota */ }
    router.push("/data/inspect");
  }

  // Download a DS9 region file for the matched objects: a 0.5" green circle per source
  // in fk5 (ra,dec), width 2, labelled with the object ID.
  function downloadRegion() {
    const lines = [
      "# Region file format: DS9 version 4.1",
      'global color=green dashlist=8 3 width=2 font="helvetica 10 normal roman" select=1 highlite=1 dash=0 fixed=0 edit=1 move=1 delete=1 include=1 source=1',
      "fk5",
    ];
    let n = 0;
    for (const m of queryAllRef.current) {
      const ra = m.r.ra, dec = m.r.dec;
      if (typeof ra === "number" && typeof dec === "number") {
        lines.push(`circle(${ra},${dec},0.5") # text={${m.fc.field} ${m.id}}`);
        n++;
      }
    }
    if (!n) return;
    downloadText(lines.join("\n") + "\n", `unicorn_regions_${n}.reg`);
  }

  // Build one displayed table row from a full-match entry — same shape the query loop produces.
  function displayRow(m: MatchEntry, cols: string[]): QueryRow {
    return {
      fc: m.fc, id: m.id,
      za: (typeof m.r.za === "number" ? m.r.za : null),
      m444: (typeof m.r.m444 === "number" ? m.r.m444 : null),
      zspec: (typeof m.r.zspec === "number" ? m.r.zspec : null),
      selected: (typeof m.r.selected === "number" ? m.r.selected : null),
      cz: m.cz,
      extra: cols.map(c => colGetter(c)(m.r)),
    };
  }

  // Toggle sort on a header click and rebuild the displayed rows from the FULL match set:
  // sort queryAllRef (all matches, not just the visible 500) → take the top CAP. A third
  // click on the active column clears the sort back to match order.
  function onSortClick(col: string) {
    if (UNSORTABLE_COLS.has(col)) return;
    let next: SortState;
    if (sort.col !== col) next = { col, dir: "asc" };
    else if (sort.dir === "asc") next = { col, dir: "desc" };
    else next = { col: null, dir: "asc" };   // third click → clear
    setSort(next);
    const all = queryAllRef.current;
    const ordered = next.col ? sortMatches(all, next.col, next.dir) : all;
    setQueryRows(ordered.slice(0, TABLE_CAP).map(m => displayRow(m, queryCols)));
  }

  async function viewQueryRow(fc: typeof SEARCH_FIELDS[0], id: number) {
    if (queryCardId === id) { setQueryCard(null); setQueryCardId(null); return; }  // toggle off
    setQueryCard(null); setQueryCardId(id);   // show a loading slot immediately under the row
    const { zg } = await loadField(fc);
    const src = await fetchObject(fc, id, zg);
    if (src) {
      setQueryCard(src);
      requestAnimationFrame(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  // Build a SourceResult from an index row alone (no per-object fetch) so the FULL
  // matched set is downloadable. Covers every scalar column; m277/m444 carry a flux
  // recovered from the index mag so the existing getters work unchanged. Per-filter
  // flux GROUPS (kron/aper/fwhm) need real detail — see resolveQueryRows(needDetail).
  function idxToSource(m: { fc: typeof SEARCH_FIELDS[0]; id: number; r: IdxRow; cz: SpeczRec | null }): SourceResult {
    const r = m.r;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const fluxOfMag = (mag: unknown) => (typeof mag === "number" && Number.isFinite(mag) ? Math.pow(10, (31.4 - mag) / 2.5) : undefined);
    return {
      field: (typeof r.field === "string" ? r.field : m.fc.field),
      row: {
        ID: m.id, RA: n(r.ra), DEC: n(r.dec), X: n(r.x), Y: n(r.y), TILE: s(r.tile),
        FLUX_F277W: fluxOfMag(r.m277), FLUX_F444W: fluxOfMag(r.m444),
        RH_F277W: n(r.rh_277), RH_F444W: n(r.rh_444), DEPTHTIER: n(r.depthtier),
        KRON_RADIUS: n(r.kron_radius), A_IMAGE: n(r.a_image), B_IMAGE: n(r.b_image), DETECTCAT: s(r.detectcat),
      },
      pz: { ZA: n(r.za), ZL68: n(r.zl68), ZU68: n(r.zu68), Z_LOWZ: n(r.z_lowz), CHIA: n(r.chia) },
      modelFluxes: {}, zgrid: [], pzArr: [],
      mabs: n(r.mabs), m1500: n(r.m1500), m1300: n(r.m1300), beta: n(r.beta),
      selected: n(r.selected) ?? null, sample: n(r.sample) ?? null, zspec: n(r.zspec),
      czspec: n(r.czspec), czqual: n(r.czqual),
    };
  }

  // Resolve the FULL matched set for download. Without a per-filter flux group, build
  // straight from the retained index rows (instant, any size). With a flux group,
  // fetch per-object detail for the whole set (slower) to get the real per-filter fluxes.
  async function resolveQueryRows(needDetail: boolean): Promise<SourceResult[]> {
    const all = queryAllRef.current;
    if (!needDetail) return all.map(idxToSource);
    const out: SourceResult[] = [];
    const CH = 24;
    for (let i = 0; i < all.length; i += CH) {
      const chunk = all.slice(i, i + CH);
      const res = await Promise.all(chunk.map(m => loadField(m.fc).then(({ zg }) => fetchObject(m.fc, m.id, zg))));
      for (const s of res) if (s) out.push(s);
    }
    return out;
  }

  // Assemble one index row (the shape MatchEntry.r / the query loop's `r`) from a
  // loaded field index at position `i`, plus this object's campfire spec-z. Same
  // columns the query loop fills — shared by query mode and the upload → table path.
  // (Per-filter flux_<f>/fluxerr_<f> are attached separately, only when a query needs them.)
  function indexRowAt(idx: Awaited<ReturnType<typeof loadField>>["idx"], i: number, cz: SpeczRec | null): IdxRow {
    return {
      field: idx.field, za: idx.za[i], ra: idx.ra[i], dec: idx.dec[i],
      m277: idx.m277?.[i] ?? null, m444: idx.m444?.[i] ?? null,
      m1500: idx.m1500?.[i] ?? null, m1300: idx.m1300?.[i] ?? null, mabs: idx.mabs?.[i] ?? null, beta: idx.beta?.[i] ?? null,
      zl68: idx.zl68?.[i] ?? null, zu68: idx.zu68?.[i] ?? null, z_lowz: idx.z_lowz?.[i] ?? null,
      chia: idx.chia?.[i] ?? null, zspec: idx.zspec?.[i] ?? null,
      czspec: cz?.z ?? null, czqual: cz?.q ?? null,
      rh_277: idx.rh_277?.[i] ?? null, rh_444: idx.rh_444?.[i] ?? null,
      kron_radius: idx.kron_radius?.[i] ?? null, a_image: idx.a_image?.[i] ?? null, b_image: idx.b_image?.[i] ?? null,
      x: idx.x?.[i] ?? null, y: idx.y?.[i] ?? null, depthtier: idx.depthtier?.[i] ?? null,
      detectcat: idx.detectcat?.[i] ?? null, tile: idx.tile?.[i] ?? null,
      selected: idx.selected?.[i] ?? null, inspected: idx.inspected?.[i] ?? null,
      sample: idx.sample?.[i] ?? null,
    };
  }
  // Build a displayed table row from an index row `r`, evaluating the dynamic columns
  // via their getters. Same fixed fields the query loop / displayRow produce.
  function toQueryRow(fc: typeof SEARCH_FIELDS[0], id: number, r: IdxRow, cz: SpeczRec | null, getters: ((r: IdxRow) => number | string | null)[]): QueryRow {
    return {
      fc, id,
      za: (typeof r.za === "number" ? r.za : null),
      m444: (typeof r.m444 === "number" ? r.m444 : null),
      zspec: (typeof r.zspec === "number" ? r.zspec : null),
      selected: (typeof r.selected === "number" ? r.selected : null),
      cz, extra: getters.map(g => g(r)),
    };
  }

  // Fetches the per-field search index (once, cached) from Corral, matches the
  // query, then pulls per-object detail JSON for each hit to build a SourceResult.
  async function doSearch() {
    setStatus("searching");
    setResults([]);
    setMatchSummary("");
    const avail = SEARCH_FIELDS.filter(f => f.available);
    const fields = searchField === "all" ? avail : avail.filter(f => f.field === searchField);
    if (fields.length === 0) {
      setStatus("notfound");
      setMatchSummary("No fields are connected yet.");
      return;
    }

    try {
      // Query mode: filter the index by a WHERE-style expression → results table
      if (mode === "query") {
        const pred = makePredicate(queryInput);
        if ("error" in pred) { setStatus("notfound"); setMatchSummary(pred.error); return; }
        // Columns to SHOW without filtering on them (e.g. flux/mag values a colleague
        // wants to eyeball). Same tokens as query fields; unioned into the table columns.
        const viewCols = viewColsInput.split(/[,\s]+/).map(s => s.trim().toLowerCase())
          .filter(Boolean).filter(c => isKnownField(c) && !TABLE_FIXED_COLS.has(c));
        const cols = [...new Set([...queriedColumns(queryInput), ...viewCols])];
        const need = [...new Set([...pred.need, ...neededIndexCols(viewCols.join(" "))])];  // flux cols to attach
        const getters = cols.map(c => colGetter(c));   // value-extractors for the dynamic table cols
        const CAP = TABLE_CAP;        // rows rendered in the table
        const DL_CAP = 100000;        // rows retained for the full-list download
        const rows: QueryRow[] = [];
        const all: { fc: typeof SEARCH_FIELDS[0]; id: number; r: IdxRow; cz: SpeczRec | null }[] = [];
        let total = 0;
        for (const fc of fields) {
          const { idx } = await loadField(fc);
          // Only fetch the (larger) per-filter flux table when the query needs it.
          const fx = need.length ? await loadFilters(fc) : null;
          // campfire spec-z sidecar (small, cached) — so czspec/czqual are queryable and
          // each row carries its campfire match for the results table.
          const sz = await loadSpecz(fc);
          for (let i = 0; i < idx.n; i++) {
            const cz = sz[String(idx.id[i])] ?? null;
            const r = indexRowAt(idx, i, cz);
            if (fx) for (const c of need) r[c] = fx[c]?.[i] ?? null;   // native flux/fluxerr for this query
            if (pred.test(r)) {
              total++;
              const id = idx.id[i];
              if (rows.length < CAP) rows.push(toQueryRow(fc, id, r, cz, getters));
              if (all.length < DL_CAP) all.push({ fc, id, r, cz });
            }
          }
        }
        queryAllRef.current = all;
        setSort({ col: null, dir: "asc" });   // fresh search starts in match order
        setResults([]); setQueryCard(null); setQueryRows(rows); setQueryCols(cols); setQueryTotal(total);
        if (total === 0) { setStatus("notfound"); setMatchSummary("No sources match that query."); }
        else {
          setStatus("table");
          setMatchSummary(`${total.toLocaleString()} source${total === 1 ? "" : "s"} match${total > CAP ? ` — showing first ${CAP}` : ""}.`);
        }
        return;
      }

      // Name mode: match the typed text against the curated famous-object labels.
      if (mode === "name") {
        const q = nameInput.trim().toLowerCase();
        if (!q) { setStatus("notfound"); setMatchSummary("Type a name, e.g. Maisie or GN-z11."); return; }
        const labels = await loadLabels();
        const hits = labels.filter(l =>
          l.name.toLowerCase().includes(q) || (l.aka ?? []).some(a => a.toLowerCase().includes(q)));
        const named: SourceResult[] = [];
        for (const l of hits) {
          const fc = avail.find(f => f.field === l.field);
          if (!fc) continue;
          const { zg } = await loadField(fc);
          const src = await fetchObject(fc, l.id, zg);
          if (src) named.push(src);
        }
        if (named.length === 0) { setStatus("notfound"); setMatchSummary(`No named object matches "${nameInput.trim()}".`); return; }
        setResults(named);
        if (named.length === 1) setStatus("found");
        else { setStatus("multi"); setMatchSummary(`${named.length} named matches.`); }
        return;
      }

      const found: SourceResult[] = [];
      let requested = 1;

      if (mode === "id") {
        const id = parseInt(idInput.trim(), 10);
        if (!Number.isFinite(id)) {
          setStatus("notfound");
          setMatchSummary("Enter a numeric object ID.");
          return;
        }
        for (const fc of fields) {
          const { idx, zg } = await loadField(fc);
          if (idx.id.includes(id)) {
            const src = await fetchObject(fc, id, zg);
            if (src) found.push(src);
          }
        }
      } else if (mode === "radec") {
        const ra = parseFloat(raInput);
        const dec = parseFloat(decInput);
        const radius = parseFloat(radiusInput) || 0.2;
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
          setStatus("notfound");
          setMatchSummary("Enter numeric RA and Dec in degrees.");
          return;
        }
        const cand: { fc: typeof fields[0]; id: number; sep: number; zg: ZGrid }[] = [];
        for (const fc of fields) {
          const { idx, zg } = await loadField(fc);
          for (let i = 0; i < idx.n; i++) {
            const sep = angSep(ra, dec, idx.ra[i], idx.dec[i]);
            if (sep <= radius) cand.push({ fc, id: idx.id[i], sep, zg });
          }
        }
        cand.sort((a, b) => a.sep - b.sep);
        for (const c of cand.slice(0, 50)) {
          const src = await fetchObject(c.fc, c.id, c.zg);
          if (src) found.push(src);
        }
      } else {
        // upload: one entry per line, either "ID" or "RA Dec". Resolve each entry to a
        // matched (field, index-position) pair, then render the SAME sortable results
        // table Query mode uses (map↗ links, sorting, click-a-row card, downloads,
        // "inspect these"). Upload order is preserved — the user can sort in the table.
        const lines = uploadText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        requested = lines.length;
        const loaded = await Promise.all(fields.map(async fc => ({ fc, ...(await loadField(fc)) })));
        const speczByField = new Map<string, Awaited<ReturnType<typeof loadSpecz>>>();
        for (const L of loaded) speczByField.set(L.fc.field, await loadSpecz(L.fc));

        const CAP = TABLE_CAP;
        const rows: QueryRow[] = [];
        const all: MatchEntry[] = [];
        let total = 0;
        // Resolve one matched (field index L, position i) → a table row + full match entry.
        const pushMatch = (L: typeof loaded[0], i: number) => {
          const id = L.idx.id[i];
          const cz = speczByField.get(L.fc.field)?.[String(id)] ?? null;
          const r = indexRowAt(L.idx, i, cz);
          total++;
          if (rows.length < CAP) rows.push(toQueryRow(L.fc, id, r, cz, []));
          all.push({ fc: L.fc, id, r, cz });
        };
        for (const line of lines) {
          const parts = line.split(/[\s,]+/);
          if (parts.length === 1) {
            const id = parseInt(parts[0], 10);
            if (!Number.isFinite(id)) continue;
            for (const L of loaded) {
              const i = L.idx.id.indexOf(id);
              if (i >= 0) { pushMatch(L, i); break; }
            }
          } else {
            const ra = parseFloat(parts[0]);
            const dec = parseFloat(parts[1]);
            if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
            let best: { L: typeof loaded[0]; i: number; sep: number } | null = null;
            for (const L of loaded) {
              for (let i = 0; i < L.idx.n; i++) {
                const sep = angSep(ra, dec, L.idx.ra[i], L.idx.dec[i]);
                if (sep <= 0.5 && (!best || sep < best.sep)) best = { L, i, sep };
              }
            }
            if (best) pushMatch(best.L, best.i);
          }
        }

        if (total === 0) {
          setStatus("notfound");
          setMatchSummary(`No matches among ${requested} entries.`);
          return;
        }
        queryAllRef.current = all;
        setSort({ col: null, dir: "asc" });   // fresh search starts in upload order
        setResults([]); setQueryCard(null); setQueryCardId(null);
        setQueryRows(rows); setQueryCols([]); setQueryTotal(total);
        setStatus("table");
        setMatchSummary(`${total.toLocaleString()} match${total === 1 ? "" : "es"} from ${requested} entr${requested === 1 ? "y" : "ies"}${total > CAP ? ` — showing first ${CAP}` : ""}.`);
        return;
      }

      const matched = found.length;
      if (matched === 0) {
        setStatus("notfound");
        setMatchSummary(requested > 1 ? `No matches among ${requested} entries.` : "No source found for that query.");
        return;
      }
      setResults(found);
      if (matched === 1 && requested <= 1) {
        setStatus("found");
      } else {
        setStatus("multi");
        const frac = requested > 1 ? ` from ${requested} entries` : "";
        setMatchSummary(`${matched} match${matched === 1 ? "" : "es"}${frac}.`);
      }
    } catch {
      setStatus("notfound");
      setMatchSummary("Could not load the catalog index. Please try again.");
    }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setUploadText(ev.target?.result as string ?? "");
    reader.readAsText(file);
  }

  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "960px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "6px" }}>
          Search
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
          Search across all UNICORN fields by ID, position, uploaded source list, or a
          SQL-style query on redshift and magnitude. Each match shows photometry, photo-z,
          and a bio plot with the best-fit and low-z model spectra.
        </p>
        <p style={{ color: "var(--text-dim)", fontSize: "0.8rem", marginTop: "10px", lineHeight: 1.7 }}>
          <span style={{ color: "var(--amber)", fontWeight: 700 }}>Note on precision:</span> query values are rounded
          for fast in-browser search — per-filter queries use the native catalog flux to 4 significant figures
          (derived mag/S/N/color match the catalog to ≲10⁻³; colors use a 1σ upper limit where S/N&lt;1); redshifts,
          M_UV, β and sizes to 3–4 decimals. For full-precision, science-grade values use the FITS catalogs on the{" "}
          <a href="/data/catalogs" style={{ color: "var(--accent2)" }}>Catalogs</a> page. See “Field Search Options”
          below for the per-quantity detail.
        </p>
      </div>

      {/* Search card */}
      <div className="card-bright" style={{ padding: "1.5rem", marginBottom: "2rem" }}>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "1.5rem" }}>
          {([
            { key: "id",     label: "By ID" },
            { key: "name",   label: "By Name" },
            { key: "radec",  label: "By RA/Dec" },
            { key: "upload", label: "Upload List" },
            { key: "query",  label: "Query" },
          ] as const).map(tab => (
            <button key={tab.key} onClick={() => setMode(tab.key)} style={{
              padding: "7px 18px",
              borderRadius: "4px",
              border: `1px solid ${mode === tab.key ? "var(--border-bright)" : "var(--border)"}`,
              background: mode === tab.key ? "rgba(176,124,198,0.12)" : "transparent",
              color: mode === tab.key ? "var(--accent)" : "var(--text-muted)",
              fontFamily: "'Space Mono', monospace",
              fontSize: "0.8rem",
              cursor: "pointer",
            }}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ID input */}
        {mode === "id" && (
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <FieldSelect value={searchField} onChange={setSearchField} includeAll={true} />
            <div style={{ flex: 1, minWidth: "200px" }}>
              <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", marginBottom: "6px" }}>
                OBJECT ID
              </label>
              <input
                type="text"
                value={idInput}
                onChange={e => setIdInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && doSearch()}
                placeholder="e.g. 6613"
                style={{
                  width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
                  borderRadius: "4px", padding: "9px 12px", color: "var(--text)",
                  fontSize: "0.95rem", fontFamily: "'Space Mono', monospace", outline: "none",
                }}
              />
            </div>
            <SearchButton onClick={doSearch} loading={status === "searching"} />
          </div>
        )}

        {/* Name input — famous named objects (Maisie's Galaxy, GN-z11, …) */}
        {mode === "name" && (
          <div>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "220px" }}>
                <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", marginBottom: "6px" }}>
                  OBJECT NAME
                </label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && doSearch()}
                  placeholder="e.g. Maisie, GN-z11, MoM-z14"
                  style={{
                    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
                    borderRadius: "4px", padding: "9px 12px", color: "var(--text)",
                    fontSize: "0.95rem", fontFamily: "'Space Mono', monospace", outline: "none",
                  }}
                />
              </div>
              <SearchButton onClick={doSearch} loading={status === "searching"} />
            </div>
            <p style={{ marginTop: "10px", fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
              Searches a curated list of famous objects across the fields by nickname / alias.
            </p>
          </div>
        )}

        {/* RA/Dec input */}
        {mode === "radec" && (
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
            <FieldSelect value={searchField} onChange={setSearchField} includeAll={true} />
            {[
              { label: "RA (deg)", val: raInput,     set: setRaInput,     ph: "e.g. 214.943" },
              { label: "Dec (deg)", val: decInput,   set: setDecInput,    ph: "e.g. 52.942" },
              { label: "Radius (\")", val: radiusInput, set: setRadiusInput, ph: "0.2" },
            ].map(field => (
              <div key={field.label} style={{ flex: 1, minWidth: "130px" }}>
                <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", marginBottom: "6px" }}>
                  {field.label.toUpperCase()}
                </label>
                <input
                  type="text"
                  value={field.val}
                  onChange={e => field.set(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && doSearch()}
                  placeholder={field.ph}
                  style={{
                    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
                    borderRadius: "4px", padding: "9px 12px", color: "var(--text)",
                    fontSize: "0.95rem", fontFamily: "'Space Mono', monospace", outline: "none",
                  }}
                />
              </div>
            ))}
            <SearchButton onClick={doSearch} loading={status === "searching"} />
          </div>
        )}

        {/* Upload list */}
        {mode === "upload" && (
          <div>
            <p style={{ fontSize: "0.83rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
              Upload a text file with one entry per line. Accepted formats:
            </p>
            <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", fontSize: "0.8rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
              <span>• ID list: <span style={{ color: "var(--text-muted)" }}>6613</span></span>
              <span>• RA/Dec: <span style={{ color: "var(--text-muted)" }}>214.943 52.942</span></span>
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <input ref={fileRef} type="file" accept=".txt,.csv,.cat" onChange={handleUpload} style={{ display: "none" }} />
              <button onClick={() => fileRef.current?.click()} style={{
                background: "var(--accent-dim)", color: "var(--accent)",
                border: "1px solid rgba(196,144,216,0.3)", borderRadius: "4px",
                padding: "9px 18px", fontFamily: "'Space Mono', monospace",
                fontSize: "0.8rem", cursor: "pointer",
              }}>
                Choose File
              </button>
              {uploadText && (
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace" }}>
                  {uploadText.trim().split("\n").length} entries loaded
                </span>
              )}
              <SearchButton onClick={doSearch} loading={status === "searching"} />
            </div>
          </div>
        )}

        {/* Query */}
        {mode === "query" && (
          <div>
            <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", marginBottom: "6px" }}>
              WHERE
            </label>
            <input
              type="text"
              value={queryInput}
              onChange={e => setQueryInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doSearch()}
              placeholder="za > 9 and m444 < 28"
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
                borderRadius: "4px", padding: "10px 12px", color: "var(--text)",
                fontSize: "0.95rem", fontFamily: "'Space Mono', monospace", outline: "none",
              }}
            />
            {/* Extra columns to display in the results table (no filtering) — see the values in-browser without downloading. */}
            <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", margin: "12px 0 6px" }}>
              ALSO SHOW COLUMNS <span style={{ color: "var(--text-dim)", letterSpacing: 0, textTransform: "none" }}>(optional — displayed in the table, not filtered)</span>
            </label>
            <input
              type="text"
              value={viewColsInput}
              onChange={e => setViewColsInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doSearch()}
              placeholder="e.g. mag_f150w, flux_f277w, snr_f444w, f150w-f277w, beta"
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: "4px", padding: "8px 12px", color: "var(--text)",
                fontSize: "0.85rem", fontFamily: "'Space Mono', monospace", outline: "none",
              }}
            />
            <div style={{ marginTop: "10px", fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", lineHeight: 1.9 }}>
              <div style={{ marginBottom: "6px" }}>
                ops: <span style={{ color: "var(--text-muted)" }}>&gt; &lt; &gt;= &lt;= = != between…and</span> · combine with <span style={{ color: "var(--text-muted)" }}>and</span> / <span style={{ color: "var(--text-muted)" }}>or</span> · <span style={{ color: "var(--text-muted)" }}>= none</span> tests a missing value (e.g. <span style={{ color: "var(--text-muted)" }}>czspec = none</span>)
              </div>
              <div style={{ background: "rgba(176,124,198,0.07)", border: "1px solid var(--border)", borderRadius: "6px", padding: "7px 12px" }}>
              <button onClick={() => setDefsOpen(o => !o)} style={{ background: "none", border: "none", padding: "2px 0", color: "var(--accent2)", fontFamily: "'Space Mono', monospace", fontSize: "0.82rem", fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em", display: "flex", alignItems: "center", gap: "8px", width: "100%", textAlign: "left" }}>
                <span style={{ fontSize: "1.05rem", lineHeight: 1 }}>{defsOpen ? "▾" : "▸"}</span> Field Search Options
              </button>
              {defsOpen && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "1px 16px", color: "var(--text-muted)", marginTop: "8px" }}>
                {([
                  ["za", "photometric redshift (best fit)"],
                  ["zl68 / zu68", "68% credible interval on za"],
                  ["z_lowz", "best z of the low-z (z<7) solution"],
                  ["chia", "χ² of the best fit"],
                  ["m277 / m444", "AB mag, F277W / F444W (Kron)"],
                  ["mabs", "absolute UV magnitude M_UV (rest 1500 Å)"],
                  ["m1500 / m1300", "apparent AB mag at rest 1500 / 1300 Å"],
                  ["beta", "rest-UV continuum slope β"],
                  ["zspec", "spectroscopic redshift (>0 if known)"],
                  ["czspec", "campfire spec-z (has a campfire spectrum)"],
                  ["czqual", "campfire z quality 0–4 (4=Secure, 3=Probable)"],
                  ["rh_277 / rh_444", "half-light radius (pixels)"],
                  ["kron_radius", "Kron radius (pixels)"],
                  ["a_image / b_image", "major / minor axis (pixels)"],
                  ["ra / dec", "J2000, decimal degrees"],
                  ["x / y", "pixel position on the mosaic"],
                  ["depthtier", "imaging depth tier (integer)"],
                  ["selected / inspected / sample", "flags (0 or 1)"],
                  ["field", "field name, e.g. CEERS"],
                  ["detectcat", "detection catalog: cold / hot"],
                  ["tile", "mosaic tile (COSMOS, EGS), e.g. A1 / NE"],
                  ["flux_<filt>", "native flux (nJy) in any filter"],
                  ["mag_<filt>", "AB mag = 31.4 − 2.5·log(flux), e.g. mag_f277w"],
                  ["snr_<filt>", "S/N = flux / fluxerr in any filter"],
                  ["<filtA>-<filtB>", "color −2.5·log(fA/fB); 1σ limit if S/N<1"],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k}><span style={{ color: "var(--accent)" }}>{k}</span> — {v}</div>
                ))}
              </div>
              )}
              {defsOpen && (
                <div style={{ marginTop: "8px", color: "var(--text-dim)", fontSize: "0.72rem", lineHeight: 1.7 }}>
                  Per-filter names use the filter&apos;s lowercase label — HST/ACS (f435w, f606w, f814w) and
                  NIRCam wide/medium bands (f090w, f115w, f150w, f200w, f277w, f356w, f410m, f444w, …). A field
                  that lacks a band simply returns no match for it. (The per-filter flux table loads on demand
                  the first time you run a filter/color query.)
                </div>
              )}
              {defsOpen && (
                <div style={{ marginTop: "8px", padding: "7px 10px", background: "rgba(196,144,216,0.06)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text-dim)", fontSize: "0.72rem", lineHeight: 1.7 }}>
                  <span style={{ color: "var(--accent)", fontWeight: 700 }}>Colors &amp; upper limits.</span>{" "}
                  A color <span className="mono">fA-fB</span> is <span className="mono">−2.5·log₁₀(fluxA / fluxB)</span>,
                  computed from the native catalog fluxes. When a band has <span className="mono">S/N &lt; 1</span> (a
                  non-detection / dropout), its flux is replaced by the <b>1σ upper limit</b> (= that band&apos;s
                  <span className="mono"> FLUXERR</span>) before the color is formed — so e.g. a source undetected in
                  F444W gives a proper limiting color rather than a noise-driven value. For detected bands the color
                  equals the magnitude difference <span className="mono">magA − magB</span>. S/N is
                  <span className="mono"> flux/fluxerr</span> on the same native fluxes.
                </div>
              )}
              {defsOpen && (
                <div style={{ marginTop: "8px", padding: "7px 10px", background: "rgba(240,192,112,0.06)", border: "1px solid rgba(240,192,112,0.22)", borderRadius: "6px", color: "var(--text-dim)", fontSize: "0.72rem", lineHeight: 1.7 }}>
                  <span style={{ color: "var(--amber)", fontWeight: 700 }}>Precision:</span> per-filter queries use the
                  native catalog flux (bare <span className="mono">FLUX_&lt;f&gt;</span>/<span className="mono">FLUXERR</span>),
                  stored to 4 significant figures — derived mag/S/N/color match the catalog to ≲10⁻³. Redshifts, M_UV,
                  β, sizes and positions are stored to 3–4 decimals. Colors use a 1σ upper limit for any band with
                  S/N&lt;1. For full-precision values use the FITS catalogs on the{" "}
                  <a href="/data/catalogs" style={{ color: "var(--accent2)" }}>Catalogs</a> page.
                </div>
              )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                {[
                  "za > 9",
                  "za between 8 and 12",
                  "m444 < 27 and za > 6",
                  "selected = 1 and za > 8",
                  "detectcat = cold and zspec > 0",
                  "czqual >= 3 and za > 5",
                  "czspec = none and za > 9",
                  "mag_f277w < 28 and snr_f277w > 5",
                  "f150w-f277w < 0.5 and za > 6",
                ].map(ex => (
                  <button key={ex} onClick={() => setQueryInput(ex)} style={{
                    background: "var(--accent-dim)", color: "var(--accent)",
                    border: "1px solid rgba(196,144,216,0.25)", borderRadius: "999px",
                    padding: "4px 12px", fontFamily: "'Space Mono', monospace",
                    fontSize: "0.72rem", cursor: "pointer",
                  }}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <SearchButton onClick={doSearch} loading={status === "searching"} />
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      {status === "searching" && (
        <div style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.85rem" }}>
          Searching all fields...
        </div>
      )}

      {status === "notfound" && (
        <div className="card" style={{
          padding: "1.25rem", borderLeft: "3px solid var(--amber)",
          background: "rgba(240,192,112,0.05)", color: "var(--text-muted)", fontSize: "0.85rem",
        }}>
          <span className="mono" style={{ color: "var(--amber)", marginRight: "10px", fontSize: "0.75rem" }}>NO MATCH</span>
          {matchSummary}
        </div>
      )}

      {status === "found" && (
        <>
          <DownloadControls resolveRows={async () => results} count={results.length} />
          {results.map((src, i) => <ResultCard key={i} src={src} />)}
        </>
      )}

      {status === "multi" && (
        <div>
          <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1rem", borderLeft: "3px solid var(--green)", background: "rgba(126,207,176,0.05)" }}>
            <span className="mono" style={{ color: "var(--green)", fontSize: "0.75rem", marginRight: "10px" }}>RESULTS</span>
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{matchSummary}</span>
          </div>
          <DownloadControls resolveRows={async () => results} count={results.length} />
          {results.map((src, i) => <ResultCard key={i} src={src} />)}
        </div>
      )}

      {status === "table" && (
        <div>
          <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1rem", borderLeft: "3px solid var(--green)", background: "rgba(126,207,176,0.05)" }}>
            <span className="mono" style={{ color: "var(--green)", fontSize: "0.75rem", marginRight: "10px" }}>QUERY</span>
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              {sort.col
                ? `${queryTotal.toLocaleString()} source${queryTotal === 1 ? "" : "s"} match — sorted by ${sort.col} ${sort.dir === "asc" ? "▲" : "▼"}${queryTotal > queryRows.length ? ` — showing top ${queryRows.length}` : ""}. `
                : `${matchSummary} `}
              Click a column header to sort; click a row to view its bio plot.
            </span>
          </div>

          <DownloadControls
            resolveRows={resolveQueryRows}
            count={queryTotal}
            note={queryTotal > queryRows.length ? `full list — all ${queryTotal.toLocaleString()} matches (table shows first ${queryRows.length})` : undefined}
          />

          <div style={{ margin: "-0.25rem 0 1rem" }}>
            <button onClick={downloadResultStamps} disabled={!!zipping} className="mono"
              title="Download a zip of result cards — ONE combined image per object (stamp montage + SED + P(z))"
              style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.3)", borderRadius: "5px", padding: "7px 14px", fontSize: "0.75rem", cursor: zipping ? "wait" : "pointer" }}>
              {zipping ? `${zipping}…` : `↓ download result cards — 1 image / object (${queryTotal.toLocaleString()})`}
            </button>
            <button onClick={sendToInspector} className="mono"
              title="Open these matched objects in the visual inspector"
              style={{ marginLeft: "8px", background: "var(--accent-dim)", color: "var(--accent2)", border: "1px solid rgba(239,159,205,0.3)", borderRadius: "5px", padding: "7px 14px", fontSize: "0.75rem", cursor: "pointer" }}>
              ⇢ inspect these ({Math.min(queryTotal, INSPECT_HANDOFF_CAP).toLocaleString()})
            </button>
            <button onClick={downloadRegion} className="mono"
              title="Download a DS9 region file (.reg) — 0.5″ fk5 circles for the full matched list"
              style={{ marginLeft: "8px", background: "var(--accent-dim)", color: "var(--green)", border: "1px solid rgba(126,207,176,0.3)", borderRadius: "5px", padding: "7px 14px", fontSize: "0.75rem", cursor: "pointer" }}>
              ⬡ region file (.reg) ({Math.min(queryTotal, 100000).toLocaleString()})
            </button>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ background: "rgba(176,124,198,0.08)" }}>
                  {["ID", "field", "z_a", "m₄₄₄", "zspec", "campfire", ...queryCols, "selected", "", "map"].map((h, i) => {
                    const sortable = !UNSORTABLE_COLS.has(h);
                    const active = sort.col === h && sortable;
                    return (
                    <th key={i} onClick={sortable ? () => onSortClick(h) : undefined}
                      title={sortable ? "Sort by this column (sorts all matches)" : undefined}
                      style={{ textAlign: i === 0 ? "left" : "right", padding: "8px 14px",
                        color: active ? "var(--accent)" : "var(--text-dim)", fontWeight: 400, fontSize: "0.72rem",
                        letterSpacing: "0.06em", cursor: sortable ? "pointer" : "default",
                        userSelect: "none", whiteSpace: "nowrap" }}>
                      {h}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {queryRows.map((r, i) => {
                  const open = queryCardId === r.id;
                  return (
                  <Fragment key={i}>
                  <tr
                    onClick={() => viewQueryRow(r.fc, r.id)}
                    style={{ borderTop: "1px solid var(--border)", cursor: "pointer", background: open ? "rgba(176,124,198,0.10)" : "transparent" }}
                    onMouseEnter={e => { if (!open) e.currentTarget.style.background = "rgba(176,124,198,0.06)"; }}
                    onMouseLeave={e => { if (!open) e.currentTarget.style.background = "transparent"; }}
                  >
                    <td style={{ padding: "7px 14px", color: "var(--accent)" }}>{r.id}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text-muted)", fontSize: "0.72rem" }}>{r.fc.field}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text)" }}>{r.za != null ? r.za.toFixed(3) : "—"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text-muted)" }}>{r.m444 != null ? r.m444.toFixed(2) : "—"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text-muted)" }}>{r.zspec != null && r.zspec > 0 ? r.zspec.toFixed(3) : "—"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", fontSize: "0.72rem" }} onClick={e => e.stopPropagation()}>
                      {r.cz && r.cz.z != null
                        ? <a href={campfireUrl(r.cz.cid)} target="_blank" rel="noopener noreferrer"
                            title={`campfire spec-z ${r.cz.z} — ${QUALITY[r.cz.q ?? -1] ?? "?"} (q${r.cz.q ?? "?"}) · opens this object's spectrum on campfire`}
                            style={{ color: qualityColor(r.cz.q), textDecoration: "none", whiteSpace: "nowrap" }}>
                            {r.cz.z.toFixed(3)} ↗
                          </a>
                        : <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                    {r.extra.map((v, j) => (
                      <td key={j} style={{ padding: "7px 14px", textAlign: "right", color: "var(--text-muted)" }}>{fmtCell(v)}</td>
                    ))}
                    <td style={{ padding: "7px 14px", textAlign: "right", color: r.selected ? "var(--amber)" : "var(--text-dim)" }}>{r.selected == null ? "—" : r.selected ? "★" : "·"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--accent2)", fontSize: "0.72rem" }}>{open ? "▾ close" : "view →"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", fontSize: "0.72rem" }} onClick={e => e.stopPropagation()}>
                      {FITSGL_BASE[r.fc.field]
                        ? <a href={`/unicorn/data/map?field=${encodeURIComponent(r.fc.field)}&id=${r.id}`} title="Open in the color map (new tab)"
                            target="_blank" rel="noopener"
                            style={{ color: "var(--accent)", textDecoration: "none" }}>map ↗</a>
                        : <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                  </tr>
                  {open && (
                    <tr ref={cardRef}>
                      <td colSpan={9 + queryCols.length} style={{ padding: "0.5rem 0.75rem 1rem", background: "rgba(176,124,198,0.04)" }}>
                        {queryCard && queryCard.row["ID"] === r.id
                          ? <ResultCard src={queryCard} />
                          : <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>Loading…</div>}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

// ---- CSV download ----------------------------------------------------------
function magOr(f: unknown): string {
  const x = Number(f);
  return Number.isFinite(x) && x > 0 ? (31.4 - 2.5 * Math.log10(x)).toFixed(2) : "";
}

// Scalar (non-photometry) columns available for download.
const DL_COLS: { key: string; label: string; get: (s: SourceResult) => unknown }[] = [
  { key: "ID",        label: "ID",       get: s => s.row["ID"] },
  { key: "field",     label: "field",    get: s => s.field },
  { key: "RA",        label: "RA",       get: s => s.row["RA"] },
  { key: "DEC",       label: "DEC",      get: s => s.row["DEC"] },
  { key: "X",         label: "x",        get: s => s.row["X"] },
  { key: "Y",         label: "y",        get: s => s.row["Y"] },
  { key: "ZA",        label: "z_a",      get: s => s.pz["ZA"] },
  { key: "ZL68",      label: "z_l68",    get: s => s.pz["ZL68"] },
  { key: "ZU68",      label: "z_u68",    get: s => s.pz["ZU68"] },
  { key: "Z_LOWZ",    label: "z_lowz",   get: s => s.pz["Z_LOWZ"] },
  { key: "CHIA",      label: "chi2",     get: s => s.pz["CHIA"] },
  { key: "m277",      label: "m277",     get: s => magOr(s.row["FLUX_F277W"]) },
  { key: "m444",      label: "m444",     get: s => magOr(s.row["FLUX_F444W"]) },
  { key: "mabs",      label: "M_UV",     get: s => s.mabs },
  { key: "m1500",     label: "m1500",    get: s => s.m1500 },
  { key: "m1300",     label: "m1300",    get: s => s.m1300 },
  { key: "beta",      label: "beta",     get: s => s.beta },
  { key: "TILE",      label: "tile",     get: s => s.row["TILE"] },
  { key: "RH_F277W",  label: "rh277",    get: s => s.row["RH_F277W"] },
  { key: "RH_F444W",  label: "rh444",    get: s => s.row["RH_F444W"] },
  { key: "DEPTHTIER", label: "depthtier",get: s => s.row["DEPTHTIER"] },
  { key: "selected",  label: "selected", get: s => s.selected },
  { key: "sample",    label: "sample",   get: s => s.sample },
  { key: "zspec",     label: "zspec",    get: s => s.zspec },
  { key: "czspec",    label: "campfire_zspec", get: s => s.czspec },
  { key: "czqual",    label: "campfire_zqual", get: s => s.czqual },
  { key: "KRON_RADIUS", label: "kron_radius", get: s => s.row["KRON_RADIUS"] },
  { key: "A_IMAGE",     label: "a_image",     get: s => s.row["A_IMAGE"] },
  { key: "B_IMAGE",     label: "b_image",     get: s => s.row["B_IMAGE"] },
  { key: "DETECTCAT",   label: "detectcat",   get: s => s.row["DETECTCAT"] },
];
// All scalar columns selected by default. (Per-filter flux groups below stay opt-in.)
const DL_DEFAULT = new Set(DL_COLS.map(c => c.key));

function csvCell(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type FluxGroups = { kron: boolean; aper: boolean; fwhm: boolean };

// Filters present across rows, ordered by pivot wavelength.
function orderedFilters(rows: SourceResult[]): string[] {
  const set = new Set<string>();
  for (const s of rows) for (const k of Object.keys(s.row)) {
    const m = k.match(/^FLUX_(F\d{3}[WMN])$/);
    if (m) set.add(m[1]);
  }
  return [...set].sort((a, b) => (FILTER_WAVES[a] ?? 99) - (FILTER_WAVES[b] ?? 99) || a.localeCompare(b));
}

// Per-filter photometry columns, interleaved flux,fluxerr per filter in wavelength order.
function photColumns(rows: SourceResult[], g: FluxGroups): string[] {
  const present = new Set<string>();
  for (const s of rows) for (const k of Object.keys(s.row)) present.add(k);
  const out: string[] = [];
  for (const f of orderedFilters(rows)) {
    if (g.kron) { if (present.has(`FLUX_${f}`)) out.push(`FLUX_${f}`); if (present.has(`FLUXERR_${f}`)) out.push(`FLUXERR_${f}`); }
    if (g.aper) { if (present.has(`FLUX_APER_${f}`)) out.push(`FLUX_APER_${f}`); if (present.has(`FLUXERR_APER_${f}`)) out.push(`FLUXERR_APER_${f}`); }
    if (g.fwhm) { if (present.has(`FWHM_${f}`)) out.push(`FWHM_${f}`); }
  }
  return out;
}

function buildCSV(rows: SourceResult[], keys: Set<string>, groups: FluxGroups): string {
  const cols = DL_COLS.filter(c => keys.has(c.key));
  const photCols = photColumns(rows, groups);
  const header = [...cols.map(c => c.label), ...photCols];
  const lines = [header.join(",")];
  for (const s of rows) {
    lines.push([...cols.map(c => csvCell(c.get(s))), ...photCols.map(k => csvCell(s.row[k]))].join(","));
  }
  return lines.join("\n");
}

function downloadText(text: string, filename: string) {
  downloadBlob(new Blob([text], { type: "text/csv" }), filename);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- FITS binary-table writer (client-side, astropy-readable) ---------------
// Emits a single merged BINTABLE (photometry + photo-z columns in one table).
function fitsType(key: string): string {
  if (key === "field") return "16A";
  if (key === "DETECTCAT") return "20A";                                 // string
  if (key === "RA" || key === "DEC") return "D";                         // float64
  if (["ID", "selected", "sample", "inspected", "DEPTHTIER"].includes(key)) return "J"; // int32
  return "E";                                                            // float32
}
function fitsCard(s: string): string { return s.length > 80 ? s.slice(0, 80) : s.padEnd(80); }
function fitsKV(key: string, val: string | number, comment?: string): string {
  const field = typeof val === "string" ? `'${val.padEnd(8)}'`.padEnd(20) : String(val).padStart(20);
  return fitsCard(key.padEnd(8) + "= " + field + (comment ? " / " + comment : ""));
}
function headerBytes(cards: string[]): Uint8Array {
  let s = cards.join("");
  s += " ".repeat((2880 - (s.length % 2880)) % 2880);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
  return b;
}
function buildFITS(rows: SourceResult[], keys: Set<string>, groups: FluxGroups): Uint8Array {
  type FC = { name: string; key: string; get: (s: SourceResult) => unknown };
  const specs: FC[] = DL_COLS.filter(c => keys.has(c.key)).map(c => ({ name: c.label, key: c.key, get: c.get }));
  for (const k of photColumns(rows, groups)) specs.push({ name: k, key: "__flux__", get: s => s.row[k] });
  const cols = specs.map(sp => {
    const t = fitsType(sp.key);
    const w = t.endsWith("A") ? parseInt(t) : t === "D" ? 8 : 4;
    return { ...sp, t: t.endsWith("A") ? "A" : t, form: t.endsWith("A") ? t : "1" + t, width: w, alen: t.endsWith("A") ? parseInt(t) : 0 };
  });
  const rowBytes = cols.reduce((a, c) => a + c.width, 0);
  const nrows = rows.length;
  const data = new Uint8Array(nrows * rowBytes);
  const dv = new DataView(data.buffer);
  rows.forEach((s, ri) => {
    let off = ri * rowBytes;
    for (const c of cols) {
      const raw = c.get(s);
      if (c.t === "A") {
        const str = String(raw ?? "").slice(0, c.alen).padEnd(c.alen);
        for (let j = 0; j < c.alen; j++) data[off + j] = str.charCodeAt(j) & 0x7f;
      } else {
        const num = Number(raw);
        if (c.t === "J") dv.setInt32(off, Number.isFinite(num) ? Math.round(num) : -99, false);
        else if (c.t === "D") dv.setFloat64(off, Number.isFinite(num) ? num : NaN, false);
        else dv.setFloat32(off, Number.isFinite(num) ? num : NaN, false);
      }
      off += c.width;
    }
  });
  const primary = [
    fitsCard("SIMPLE  = " + "T".padStart(20) + " / conforms to FITS standard"),
    fitsKV("BITPIX", 8), fitsKV("NAXIS", 0),
    fitsCard("EXTEND  = " + "T".padStart(20)), fitsCard("END"),
  ];
  const table = [
    fitsKV("XTENSION", "BINTABLE"), fitsKV("BITPIX", 8), fitsKV("NAXIS", 2),
    fitsKV("NAXIS1", rowBytes, "bytes per row"), fitsKV("NAXIS2", nrows, "number of rows"),
    fitsKV("PCOUNT", 0), fitsKV("GCOUNT", 1), fitsKV("TFIELDS", cols.length),
    ...cols.flatMap((c, i) => [fitsKV(`TTYPE${i + 1}`, c.name), fitsKV(`TFORM${i + 1}`, c.form)]),
    fitsCard("COMMENT  UNICORN web search subset (photometry + photo-z merged)"),
    fitsCard("COMMENT  fluxes in nJy; magnitudes AB; see catalog page for full FITS"),
    fitsCard("END"),
  ];
  const dataPadded = new Uint8Array(data.length + ((2880 - (data.length % 2880)) % 2880));
  dataPadded.set(data);
  const parts = [headerBytes(primary), headerBytes(table), dataPadded];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function DownloadControls({ resolveRows, count, note }: {
  resolveRows: (needDetail: boolean) => Promise<SourceResult[]>; count: number; note?: string;
}) {
  const [keys, setKeys] = useState<Set<string>>(new Set(DL_DEFAULT));
  const [groups, setGroups] = useState<FluxGroups>({ kron: false, aper: false, fwhm: false });
  const [fmt, setFmt] = useState<"csv" | "fits">("csv");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setKeys(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  async function onDownload() {
    setBusy(true);
    try {
      // Per-filter flux columns require real per-object detail; scalar columns come
      // straight from the retained index (so the full list downloads instantly).
      const needDetail = groups.kron || groups.aper || groups.fwhm;
      const rows = await resolveRows(needDetail);
      if (!rows.length) return;
      if (fmt === "fits") downloadBlob(new Blob([buildFITS(rows, keys, groups) as BlobPart], { type: "application/fits" }), `unicorn_search_${rows.length}.fits`);
      else downloadText(buildCSV(rows, keys, groups), `unicorn_search_${rows.length}.csv`);
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: "0.85rem 1.1rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={onDownload} disabled={busy || count === 0} className="btn btn-primary" style={{ padding: "8px 18px", fontSize: "0.8rem" }}>
          {busy ? "Preparing…" : `⬇ Download ${fmt.toUpperCase()} (${count})`}
        </button>
        {/* Format toggle */}
        <div style={{ display: "inline-flex", border: "1px solid var(--border-bright)", borderRadius: "999px", overflow: "hidden", fontFamily: "'Space Mono', monospace", fontSize: "0.75rem" }}>
          {(["csv", "fits"] as const).map(f => (
            <button key={f} onClick={() => setFmt(f)} style={{
              padding: "7px 14px", border: "none", cursor: "pointer",
              background: fmt === f ? "var(--accent-dim)" : "transparent",
              color: fmt === f ? "var(--accent)" : "var(--text-muted)",
            }}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <button onClick={() => setOpen(!open)} className="btn btn-ghost" style={{ padding: "8px 16px", fontSize: "0.78rem" }}>
          Columns {open ? "▴" : "▾"}
        </button>
        {note && <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>{note}</span>}
      </div>
      {open && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: "0.9rem", fontSize: "0.78rem", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace" }}>
          {DL_COLS.map(c => (
            <label key={c.key} style={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" }}>
              <input type="checkbox" checked={keys.has(c.key)} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
          {([
            ["kron", "Kron fluxes (nJy)"],
            ["aper", "0.2″ aperture fluxes (nJy)"],
            ["fwhm", "FWHM, all filters (px)"],
          ] as const).map(([g, label]) => (
            <label key={g} style={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer", color: "var(--accent2)" }}>
              <input type="checkbox" checked={groups[g]} onChange={e => setGroups(prev => ({ ...prev, [g]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldSelect({ value, onChange, includeAll }: { value: string; onChange: (v: string) => void; includeAll: boolean }) {
  const avail = SEARCH_FIELDS.filter(f => f.available);
  return (
    <div style={{ minWidth: "150px" }}>
      <label style={{ display: "block", fontSize: "0.72rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.1em", marginBottom: "6px" }}>
        FIELD
      </label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
        borderRadius: "4px", padding: "9px 12px", color: "var(--text)",
        fontSize: "0.9rem", fontFamily: "'Space Mono', monospace", outline: "none", cursor: "pointer",
      }}>
        {includeAll && <option value="all">All fields</option>}
        {avail.map(f => <option key={f.field} value={f.field}>{f.field}</option>)}
      </select>
    </div>
  );
}

function SearchButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button onClick={onClick} disabled={loading} style={{
      background: loading ? "var(--bg-card2)" : "linear-gradient(135deg, var(--purple-mid), var(--lavender))",
      color: loading ? "var(--text-dim)" : "var(--text)",
      border: "none", borderRadius: "4px",
      padding: "9px 24px",
      fontFamily: "'Space Mono', monospace",
      fontSize: "0.85rem", fontWeight: 700,
      cursor: loading ? "not-allowed" : "pointer",
      whiteSpace: "nowrap",
    }}>
      {loading ? "Searching..." : "Search →"}
    </button>
  );
}
