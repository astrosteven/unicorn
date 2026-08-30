"use client";
import { useState, useRef, type ReactNode, type CSSProperties } from "react";

// Filter pivot wavelengths in microns. Covers HST/ACS + the full JWST/NIRCam
// wide + medium band set used across UNICORN fields (incl. CEERS-SPAM medium bands).
const FILTER_WAVES: Record<string, number> = {
  // HST/ACS
  F435W:0.433, F606W:0.592, F814W:0.806,
  // NIRCam wide + medium
  F070W:0.704, F090W:0.902, F115W:1.154, F140M:1.404, F150W:1.501, F162M:1.626,
  F182M:1.845, F200W:1.989, F210M:2.093, F250M:2.503, F277W:2.758, F300M:2.996,
  F335M:3.365, F356W:3.568, F360M:3.624, F410M:4.082, F430M:4.281, F444W:4.436,
  F460M:4.630, F470N:4.706, F480M:4.815,
};
const ACS_FILTERS  = new Set(["F435W","F606W","F814W"]);
// Medium/narrow bands render smaller so they don't crowd the broad-band points.
const MEDIUM_FILTERS = new Set(
  Object.keys(FILTER_WAVES).filter(f => f.endsWith("M") || f.endsWith("N"))
);

type SearchMode = "id" | "radec" | "upload" | "query";
type ResultState = "idle" | "searching" | "found" | "notfound" | "multi" | "table";
type QueryRow = { fc: typeof SEARCH_FIELDS[0]; id: number; za: number | null; m444: number | null; selected: number | null };

interface SourceResult {
  field: string;
  row: Record<string, any>;
  pz: Record<string, any>;
  modelFluxes: Record<string, number>;
  zgrid: number[];
  pzArr: number[];
  zgridLowz?: number[];
  pzArrLowz?: number[];
  sedWave?: number[];
  sed?: number[];
  sedLowz?: number[];
  selected?: number | null;
  inspected?: number | null;
  sample?: number | null;
  interestLabel?: string;
  zspec?: number;
  zaCirc?: number;
  dchi2?: number;
  aperflags?: number;
  neighbor?: { dClosest?: number; magClosest?: number; dBrightest?: number; magBrightest?: number };
}

// ---- Corral data wiring ----------------------------------------------------
const VERSION = "0.98";
const CORRAL_DEFAULT = "https://web.corral.tacc.utexas.edu/unicorn/Catalogs";

// Data source root. Defaults to public Corral, but a `?data=<url>` query param can
// point it elsewhere (e.g. a local server) for previewing not-yet-uploaded data.
function corralBase(): string {
  if (typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("data");
    if (o) return o.replace(/\/$/, "");
  }
  return CORRAL_DEFAULT;
}

// Fields with a web search index live on Corral. Add entries as fields go live.
const SEARCH_FIELDS: { field: string; dir: string; prefix: string; available: boolean }[] = [
  { field: "CEERS", dir: "CEERS", prefix: "ceers", available: true },
];

type NumCol = (number | null)[] | null;
type FieldIndex = {
  field: string; version: string; n: number; filters: string[];
  id: number[]; ra: number[]; dec: number[]; za: (number | null)[];
  m277: NumCol; m444: NumCol;
  selected: NumCol; inspected: NumCol; sample: NumCol;
  zl68?: NumCol; zu68?: NumCol; z_lowz?: NumCol; chia?: NumCol; zspec?: NumCol;
  rh_277?: NumCol; rh_444?: NumCol; kron_radius?: NumCol; a_image?: NumCol; b_image?: NumCol;
  x?: NumCol; y?: NumCol; depthtier?: NumCol; detectcat?: (string | null)[] | null;
};
type ZGrid = { zgrid: number[]; zgridLowz: number[]; sedWave: number[] };

// Module-scoped caches: the index + grid for a field are fetched at most once per session.
const _indexCache: Record<string, FieldIndex> = {};
const _zgridCache: Record<string, ZGrid> = {};

async function loadField(fc: typeof SEARCH_FIELDS[0]): Promise<{ idx: FieldIndex; zg: ZGrid }> {
  if (!_indexCache[fc.field]) {
    const webBase = `${corralBase()}/${fc.dir}/web`;
    const [idx, zg] = await Promise.all([
      fetch(`${webBase}/${fc.prefix}_search_v${VERSION}.json`).then(r => r.json()),
      fetch(`${webBase}/${fc.prefix}_zgrid_v${VERSION}.json`).then(r => r.json()),
    ]);
    _indexCache[fc.field] = idx;
    _zgridCache[fc.field] = zg;
  }
  return { idx: _indexCache[fc.field], zg: _zgridCache[fc.field] };
}

async function fetchObject(fc: typeof SEARCH_FIELDS[0], id: number, zg: ZGrid): Promise<SourceResult | null> {
  try {
    const r = await fetch(`${corralBase()}/${fc.dir}/web/objects/${fc.prefix}_${id}.json`);
    if (!r.ok) return null;
    const o = await r.json();
    return {
      field: o.field, row: o.row, pz: o.pz, modelFluxes: o.modelFluxes,
      zgrid: zg.zgrid, pzArr: o.pzArr,
      zgridLowz: zg.zgridLowz, pzArrLowz: o.pzArrLowz,
      sedWave: zg.sedWave, sed: o.sed, sedLowz: o.sedLowz,
      selected: o.selected, inspected: o.inspected, sample: o.sample,
      interestLabel: o.interestLabel, zspec: o.zspec,
      zaCirc: o.zaCirc, dchi2: o.dchi2, aperflags: o.aperflags, neighbor: o.neighbor,
    };
  } catch {
    return null;
  }
}

// Angular separation in arcsec (small-angle, cos-dec corrected).
function angSep(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const dra = (ra2 - ra1) * Math.cos(((dec1 + dec2) / 2) * d2r);
  const dde = dec2 - dec1;
  return Math.sqrt(dra * dra + dde * dde) * 3600;
}

// ---- SQL-style query over the search index ---------------------------------
type IdxRow = Record<string, number | string | null>;
// Numeric queryable columns (must exist in the index).
const QUERY_NUM = ["za", "zl68", "zu68", "z_lowz", "chia", "m277", "m444", "zspec",
  "rh_277", "rh_444", "kron_radius", "a_image", "b_image", "x", "y", "depthtier",
  "ra", "dec", "selected", "inspected", "sample"];
const QUERY_STR = ["field", "detectcat"];

// Parse a WHERE-style expression into a predicate. Numeric fields support
// > < >= <= = != and `between a and b`; string fields (field, detectcat) support = / !=.
// A single connector level (all AND or all OR).
function makePredicate(query: string): ((r: IdxRow) => boolean) | { error: string } {
  let q = query.trim().toLowerCase();
  if (!q) return { error: "Type a condition, e.g.  za > 9 and m444 < 28" };
  q = q.replace(/between\s+(-?[\d.]+)\s+and\s+(-?[\d.]+)/g, "between $1 :and: $2");
  const connectors: string[] = q.match(/\b(and|or)\b/g) ?? [];
  const useOr = connectors.includes("or");
  if (useOr && connectors.includes("and")) return { error: "Mixing AND and OR isn't supported — use one." };
  const parts = q.split(/\b(?:and|or)\b/).map(s => s.replace(/:and:/g, "and").trim()).filter(Boolean);

  const conds: ((r: IdxRow) => boolean)[] = [];
  for (const part of parts) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^(\w+)\s+between\s+(-?[\d.]+)\s+and\s+(-?[\d.]+)$/))) {
      const f = m[1], lo = parseFloat(m[2]), hi = parseFloat(m[3]);
      if (!QUERY_NUM.includes(f)) return { error: `"${f}" can't use between (unknown or non-numeric)` };
      conds.push(r => { const v = r[f]; return typeof v === "number" && v >= lo && v <= hi; });
    } else if ((m = part.match(/^(\w+)\s*(>=|<=|!=|==|=|>|<)\s*(.+)$/))) {
      const f = m[1], op = m[2], valraw = m[3].trim().replace(/^['"]|['"]$/g, "");
      if (QUERY_STR.includes(f)) {
        if (op !== "=" && op !== "==" && op !== "!=") return { error: `use = or != on "${f}"` };
        conds.push(r => { const v = r[f]; if (v == null) return false; const eq = String(v).toLowerCase() === valraw; return op === "!=" ? !eq : eq; });
      } else if (QUERY_NUM.includes(f)) {
        const x = parseFloat(valraw);
        if (!Number.isFinite(x)) return { error: `"${valraw}" is not a number` };
        conds.push(r => {
          const v = r[f];
          if (typeof v !== "number" || !Number.isFinite(v)) return false;
          switch (op) {
            case ">": return v > x; case "<": return v < x;
            case ">=": return v >= x; case "<=": return v <= x;
            case "!=": return v !== x; default: return v === x;
          }
        });
      } else {
        return { error: `Unknown field "${f}"` };
      }
    } else {
      return { error: `Could not parse "${part}". Try  field op value  (e.g. za > 9).` };
    }
  }
  return (r: IdxRow) => useOr ? conds.some(c => c(r)) : conds.every(c => c(r));
}

// Instrument / marker colors, shared with the legend.
const HST_COLOR = "#8e6bb8";    // HST/ACS detections
const JWST_COLOR = "#c490d8";   // JWST/NIRCam detections
const MODEL_COLOR = "#f0c070";  // best-fit model (fluxes + fiducial SED curve)
const LOWZ_COLOR = "#ef9fcd";   // low-z (z<7) alternative model

// Inline SED plot (SVG), log flux axis. Circle size encodes bandwidth (large = wide,
// small = medium/narrow); color encodes instrument (purple HST, lavender JWST). The
// reconstructed best-fit (amber) and low-z (pink dashed) model spectra overlay the points.
function SEDPlot({ src }: { src: SourceResult }) {
  const w = 480, h = 300, pad = { t: 20, r: 18, b: 44, l: 58 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const xmin = 0.3, xmax = 5.5;

  // Collect detections and upper limits
  const points: { wav: number; flux: number; err: number; isACS: boolean; isMedium: boolean; isUL: boolean }[] = [];
  for (const [filt, wav] of Object.entries(FILTER_WAVES)) {
    const f = src.row[`FLUX_${filt}`];
    const e = src.row[`FLUXERR_${filt}`];
    if (f === undefined || e === undefined || e > 1e6) continue;
    points.push({ wav, flux: f, err: e, isACS: ACS_FILTERS.has(filt), isMedium: MEDIUM_FILTERS.has(filt), isUL: f / e < 1 });
  }

  const modelPts: { wav: number; flux: number }[] = Object.entries(src.modelFluxes)
    .filter(([filt]) => FILTER_WAVES[filt])
    .map(([filt, flux]) => ({ wav: FILTER_WAVES[filt], flux }))
    .filter(p => p.flux > 0);

  // Log flux range from the data (detections + 3σ upper limits)
  const vals = [
    ...points.filter(p => !p.isUL).map(p => p.flux).filter(f => f > 0),
    ...points.filter(p => p.isUL).map(p => 3 * p.err).filter(f => f > 0),
  ];
  const dataMax = vals.length ? Math.max(...vals) : 50;
  const dataMin = vals.length ? Math.min(...vals) : 1;
  const yTop = dataMax * 3;
  const yBot = Math.max(0.15, dataMin / 3);
  const lTop = Math.log10(yTop), lBot = Math.log10(yBot);

  const cx = (wav: number) => pad.l + ((Math.log10(wav) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * pw;
  const cyRaw = (flux: number) => pad.t + ph - ((Math.log10(flux <= 0 ? yBot : flux) - lBot) / (lTop - lBot)) * ph;
  const cy = (flux: number) => Math.max(pad.t - 3, Math.min(pad.t + ph + 3, cyRaw(flux)));

  const zaVal = src.pz["ZA"] ?? 0;
  const lyaWav = 0.12157 * (1 + zaVal);  // observed Lyα, microns

  // Decade y-ticks
  const decades: number[] = [];
  for (let k = Math.ceil(lBot); k <= Math.floor(lTop); k++) decades.push(k);

  // Build a model-spectrum polyline (clamped so the Lyman break drops to the floor)
  const sedPoly = (sed?: number[]) => {
    if (!sed || !src.sedWave) return "";
    const out: string[] = [];
    for (let i = 0; i < sed.length; i++) {
      const wv = src.sedWave[i];
      if (wv < xmin || wv > xmax) continue;
      out.push(`${cx(wv).toFixed(1)},${cy(Math.max(sed[i], yBot * 0.7)).toFixed(1)}`);
    }
    return out.join(" ");
  };
  const fidPoly = sedPoly(src.sed);
  const lowzPoly = sedPoly(src.sedLowz);

  return (
    <div style={{ width: "100%", maxWidth: w }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible", display: "block" }}>
        {/* Plot frame */}
        <rect x={pad.l} y={pad.t} width={pw} height={ph} fill="none" stroke="var(--border-bright)" strokeWidth={1}/>
        {/* Y decade gridlines + ticks */}
        {decades.map(k => (
          <g key={k}>
            <line x1={pad.l} x2={pad.l+pw} y1={cy(10**k)} y2={cy(10**k)} stroke="rgba(120,90,170,0.16)" strokeWidth={0.8}/>
            <line x1={pad.l} x2={pad.l-4} y1={cy(10**k)} y2={cy(10**k)} stroke="var(--text-dim)" strokeWidth={0.8}/>
            <text x={pad.l-7} y={cy(10**k)+3.5} textAnchor="end" fontSize={10} fill="var(--text-dim)" fontFamily="monospace">{10**k}</text>
          </g>
        ))}
        {/* Lyα marker */}
        {lyaWav >= xmin && lyaWav <= xmax && (
          <g>
            <line x1={cx(lyaWav)} x2={cx(lyaWav)} y1={pad.t} y2={pad.t+ph} stroke="var(--text-dim)" strokeWidth={0.8} strokeDasharray="2,3"/>
            <text x={cx(lyaWav)+3} y={pad.t+ph-4} fontSize={9} fill="var(--text-dim)" fontFamily="monospace">Lyα</text>
          </g>
        )}
        {/* Model spectra (behind points) */}
        {lowzPoly && <polyline points={lowzPoly} fill="none" stroke={LOWZ_COLOR} strokeWidth={1.3} strokeDasharray="4,3" opacity={0.85}/>}
        {fidPoly && <polyline points={fidPoly} fill="none" stroke={MODEL_COLOR} strokeWidth={1.6} opacity={0.95}/>}
        {/* Model band fluxes — open squares */}
        {modelPts.map((p,i) => (
          <rect key={i} x={cx(p.wav)-5} y={cy(p.flux)-5} width={10} height={10} fill="none" stroke={MODEL_COLOR} strokeWidth={1.6} />
        ))}
        {/* Detections */}
        {points.filter(p=>!p.isUL).map((p,i) => {
          const x = cx(p.wav), y = cy(p.flux);
          const color = p.isACS ? HST_COLOR : JWST_COLOR;
          const r = p.isMedium ? 3 : 5.5;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={cy(p.flux+p.err)} y2={cy(Math.max(p.flux-p.err, yBot*0.7))} stroke={color} strokeWidth={1.3}/>
              <circle cx={x} cy={y} r={r} fill={color}/>
            </g>
          );
        })}
        {/* Upper limits — downward arrow at 3σ */}
        {points.filter(p=>p.isUL).map((p,i) => {
          const x = cx(p.wav), y = cy(3*p.err);
          const color = p.isACS ? HST_COLOR : JWST_COLOR;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={y} y2={y+16} stroke={color} strokeWidth={1.4}/>
              <path d={`M${x-4.5},${y+12} L${x},${y+19} L${x+4.5},${y+12} Z`} fill={color}/>
            </g>
          );
        })}
        {/* X axis ticks */}
        {[0.5,1.0,2.0,3.0,4.0,5.0].map(v => (
          <g key={v}>
            <line x1={cx(v)} x2={cx(v)} y1={pad.t+ph} y2={pad.t+ph+5} stroke="var(--text-dim)" strokeWidth={0.8}/>
            <text x={cx(v)} y={pad.t+ph+18} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace">{v}</text>
          </g>
        ))}
        {/* Y axis label */}
        <text x={14} y={pad.t+ph/2} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace"
          transform={`rotate(-90,14,${pad.t+ph/2})`}>flux (nJy)</text>
        {/* X axis label */}
        <text x={pad.l+pw/2} y={h-6} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace">observed wavelength (μm)</text>
        {/* z_a label */}
        <text x={pad.l+pw-6} y={pad.t+12} textAnchor="end" fontSize={13} fill="var(--accent)" fontFamily="monospace">
          z = {zaVal.toFixed(2)}
        </text>
      </svg>
      <SEDLegend hasLowz={!!lowzPoly} />
    </div>
  );
}

// Legend explaining the SED markers.
function SEDLegend({ hasLowz }: { hasLowz: boolean }) {
  const item = (glyph: ReactNode, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
      <svg width={18} height={14} style={{ overflow: "visible" }}>{glyph}</svg>{label}
    </span>
  );
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: "8px",
      fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace",
    }}>
      {item(<circle cx={8} cy={7} r={5.5} fill={HST_COLOR} />, "HST wide")}
      {item(<circle cx={8} cy={7} r={5.5} fill={JWST_COLOR} />, "JWST wide")}
      {item(<circle cx={8} cy={7} r={3} fill={JWST_COLOR} />, "medium / narrow")}
      {item(<g><line x1={0} x2={18} y1={7} y2={7} stroke={MODEL_COLOR} strokeWidth={1.8}/></g>, "best-fit model")}
      {hasLowz && item(<g><line x1={0} x2={18} y1={7} y2={7} stroke={LOWZ_COLOR} strokeWidth={1.6} strokeDasharray="4,3"/></g>, "low-z (z<7)")}
      {item(<rect x={4} y={2} width={10} height={10} fill="none" stroke={MODEL_COLOR} strokeWidth={1.6} />, "model flux")}
      {item(<g><line x1={9} x2={9} y1={0} y2={9} stroke={JWST_COLOR} strokeWidth={1.4} /><path d="M5,6 L9,13 L13,6 Z" fill={JWST_COLOR} /></g>, "3σ upper limit")}
    </div>
  );
}

// P(z) plot — fiducial (solid) with the low-z (z<7) alternative overlaid (dashed pink).
function PZPlot({ zgrid, pz, za, zgridLowz, pzLowz }: {
  zgrid: number[]; pz: number[]; za: number;
  zgridLowz?: number[]; pzLowz?: number[];
}) {
  const w = 268, h = 300, pad = { t:20, r:14, b:44, l:40 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (!pz.length) return null;

  const lowzOk = !!(zgridLowz && pzLowz && pzLowz.length === zgridLowz.length && pzLowz.length);
  const pzMax = Math.max(Math.max(...pz), lowzOk ? Math.max(...pzLowz!) : 0) || 1;
  const zmax = 16;
  const cx = (z: number) => pad.l + (Math.min(z,zmax)/zmax)*pw;
  const cy = (p: number) => pad.t + ph - (p/pzMax)*ph;

  const pts = zgrid.map((z,i) => `${cx(z)},${cy(pz[i])}`).join(" ");
  const fill = pts + ` ${cx(zgrid[zgrid.length-1])},${cy(0)} ${cx(zgrid[0])},${cy(0)}`;
  const lowzPts = lowzOk ? zgridLowz!.map((z,i) => `${cx(z)},${cy(pzLowz![i])}`).join(" ") : "";

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: w, display: "block" }}>
      <polygon points={fill} fill="rgba(196,144,216,0.18)" />
      {lowzOk && <polyline points={lowzPts} fill="none" stroke={LOWZ_COLOR} strokeWidth={1.5} strokeDasharray="4,3"/>}
      <polyline points={pts} fill="none" stroke="#c490d8" strokeWidth={1.8}/>
      {/* z_a line */}
      <line x1={cx(za)} x2={cx(za)} y1={pad.t} y2={pad.t+ph} stroke="var(--accent2)" strokeWidth={1.2} strokeDasharray="3,2"/>
      <text x={cx(za)+4} y={pad.t+12} textAnchor="start" fontSize={11} fill="var(--accent2)" fontFamily="monospace">z_a</text>
      {/* Plot frame + Y ticks */}
      <rect x={pad.l} y={pad.t} width={pw} height={ph} fill="none" stroke="var(--border-bright)" strokeWidth={1}/>
      {[0, 0.25, 0.5, 0.75, 1].map(fr => {
        const val = pzMax * fr, y = cy(val);
        return (
          <g key={fr}>
            <line x1={pad.l} x2={pad.l-4} y1={y} y2={y} stroke="var(--text-dim)" strokeWidth={0.8}/>
            <text x={pad.l-6} y={y+3.5} textAnchor="end" fontSize={9} fill="var(--text-dim)" fontFamily="monospace">{val.toFixed(pzMax >= 1 ? 1 : 2)}</text>
          </g>
        );
      })}
      {/* X axis */}
      {[0,4,8,12,16].map(v => (
        <g key={v}>
          <line x1={cx(v)} x2={cx(v)} y1={pad.t+ph} y2={pad.t+ph+5} stroke="var(--text-dim)" strokeWidth={0.8}/>
          <text x={cx(v)} y={pad.t+ph+18} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace">{v}</text>
        </g>
      ))}
      <text x={pad.l+pw/2} y={h-6} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace">redshift z</text>
      {/* Y axis label */}
      <text x={12} y={pad.t+ph/2} textAnchor="middle" fontSize={11} fill="var(--text-muted)" fontFamily="monospace"
        transform={`rotate(-90,12,${pad.t+ph/2})`}>P(z)</text>
      {/* Low-z legend hint */}
      {lowzOk && <text x={pad.l+pw-4} y={pad.t+12} textAnchor="end" fontSize={9} fill={LOWZ_COLOR} fontFamily="monospace">z&lt;7 alt</text>}
    </svg>
  );
}

// AB magnitude from flux in nJy:  m_AB = 31.40 − 2.5·log10(F / nJy)
function flux2mag(f: number): string {
  if (f <= 0) return "—";
  return (31.4 - 2.5 * Math.log10(f)).toFixed(2);
}

function ResultCard({ src }: { src: SourceResult }) {
  const pz = src.pz;
  const za = pz["ZA"] ?? 0;
  const zl68 = pz["ZL68"] ?? 0;
  const zu68 = pz["ZU68"] ?? 0;
  const f277 = src.row["FLUX_F277W"] ?? 0;
  const f444 = src.row["FLUX_F444W"] ?? 0;
  const rh277 = src.row["RH_F277W"] ?? 0;
  const rh444 = src.row["RH_F444W"] ?? 0;
  const tier = src.row["DEPTHTIER"] ?? 0;

  // Normalize P(z) (fiducial + low-z) to unit integral for display
  const normalize = (arr: number[] | undefined, grid: number[] | undefined) => {
    if (!arr || !grid || arr.length !== grid.length) return undefined;
    const nrm = arr.reduce((s, v, i) => s + v * (grid[i + 1] - grid[i] || 0.02), 0) || 1;
    return arr.map(v => v / nrm);
  };
  const pzNorm = normalize(src.pzArr, src.zgrid) ?? src.pzArr;
  const pzLowzNorm = normalize(src.pzArrLowz, src.zgridLowz);

  const chip = (color: string): CSSProperties => ({
    fontSize: "0.68rem", padding: "2px 9px", borderRadius: "999px",
    color, background: "rgba(255,255,255,0.03)", border: `1px solid ${color}55`,
  });

  return (
    <div className="card-bright" style={{ padding: "1.25rem", marginBottom: "12px" }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem", flexWrap: "wrap", gap: "8px" }}>
        <div>
          {src.interestLabel && (
            <span className="mono" style={{ fontSize: "1rem", fontWeight: 700, color: "var(--accent-bright)", marginRight: "10px" }}>
              {src.interestLabel}
            </span>
          )}
          <span className="mono" style={{ fontSize: "1rem", fontWeight: 700, color: "var(--accent)" }}>
            ID {src.row["ID"]}
          </span>
          <span className="mono" style={{
            marginLeft: "12px", fontSize: "0.72rem",
            background: "var(--accent-dim)", color: "var(--accent2)",
            border: "1px solid rgba(239,159,205,0.2)",
            padding: "2px 8px", borderRadius: "3px",
          }}>
            {src.field.toUpperCase()}
          </span>
          {tier > 0 && (
            <span className="mono" style={{
              marginLeft: "6px", fontSize: "0.72rem",
              color: "var(--text-dim)", padding: "2px 8px",
            }}>
              tier{tier}
            </span>
          )}
        </div>
        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace" }}>
          {Number(src.row["RA"]).toFixed(5)}, {Number(src.row["DEC"]).toFixed(5)}
        </span>
      </div>

      {/* Status badges */}
      {(src.selected != null || (src.inspected != null && src.inspected > 0) || (src.sample != null && src.sample >= 0) || src.zspec != null || (src.aperflags != null && src.aperflags > 0)) && (
        <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "1rem", marginTop: "-4px" }}>
          {src.selected != null && (
            <span style={chip(src.selected ? "var(--amber)" : "var(--text-dim)")}>
              {src.selected ? "★ Selected" : "not selected"}
            </span>
          )}
          {src.sample != null && src.sample >= 0 && (
            <span style={chip("var(--accent)")}>z-sample {src.sample}</span>
          )}
          {src.inspected != null && src.inspected > 0 && (
            <span style={chip("var(--green)")}>inspected</span>
          )}
          {src.zspec != null && (
            <span style={chip("var(--pink)")}>z-spec {src.zspec.toFixed(3)}</span>
          )}
          {src.aperflags != null && src.aperflags > 0 && (
            <span style={chip("var(--red)")}>aper-flag {src.aperflags}</span>
          )}
        </div>
      )}

      {/* Plots + info */}
      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* SED */}
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "4px" }}>SED</div>
          <SEDPlot src={src} />
        </div>
        {/* P(z) */}
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "4px" }}>P(z)</div>
          <PZPlot zgrid={src.zgrid} pz={pzNorm} za={za} zgridLowz={src.zgridLowz} pzLowz={pzLowzNorm} />
        </div>
        {/* Info table */}
        <div style={{ flex: 1, minWidth: "160px" }}>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "8px" }}>PROPERTIES</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <tbody>
              {[
                ["Field",  src.field],
                ["ID",     String(src.row["ID"])],
                ["z_a",    za.toFixed(3)],
                ["68% CI", `${zl68.toFixed(2)} – ${zu68.toFixed(2)}`],
                ["z_circ", src.zaCirc != null ? src.zaCirc.toFixed(3) : "—"],
                ["z_lowz", src.pz["Z_LOWZ"] != null ? Number(src.pz["Z_LOWZ"]).toFixed(3) : "—"],
                ["Δχ²",   src.dchi2 != null ? src.dchi2.toFixed(1) : "—"],
                ["m₂₇₇",  flux2mag(f277)],
                ["m₄₄₄",  flux2mag(f444)],
                ["rh,277", rh277 > 0 ? `${rh277.toFixed(2)} pix` : "—"],
                ["rh,444", rh444 > 0 ? `${rh444.toFixed(2)} pix` : "—"],
                ...(src.neighbor?.dClosest != null ? [["nbr (near)", `${src.neighbor.magClosest?.toFixed(1) ?? "?"} @ ${src.neighbor.dClosest.toFixed(2)}"`]] : []),
                ...(src.neighbor?.dBrightest != null ? [["nbr (bright)", `${src.neighbor.magBrightest?.toFixed(1) ?? "?"} @ ${src.neighbor.dBrightest.toFixed(2)}"`]] : []),
              ].map(([label, val]) => (
                <tr key={label} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "3px 0", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.75rem", paddingRight: "12px" }}>{label}</td>
                  <td style={{ padding: "3px 0", color: "var(--text)", fontFamily: "'Space Mono', monospace" }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function SearchPage() {
  const [mode, setMode] = useState<SearchMode>("id");
  const [idInput, setIdInput] = useState("");
  const [raInput, setRaInput] = useState("");
  const [decInput, setDecInput] = useState("");
  const [radiusInput, setRadiusInput] = useState("0.2");
  const [uploadText, setUploadText] = useState("");
  const [queryInput, setQueryInput] = useState("za > 9 and m444 < 28");
  const [queryRows, setQueryRows] = useState<QueryRow[]>([]);
  const [queryTotal, setQueryTotal] = useState(0);
  const [queryCard, setQueryCard] = useState<SourceResult | null>(null);
  const [searchField, setSearchField] = useState<string>("all");
  const [status, setStatus] = useState<ResultState>("idle");
  const [results, setResults] = useState<SourceResult[]>([]);
  const [matchSummary, setMatchSummary] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function viewQueryRow(fc: typeof SEARCH_FIELDS[0], id: number) {
    const { zg } = await loadField(fc);
    const src = await fetchObject(fc, id, zg);
    if (src) setQueryCard(src);
  }

  // Fetch full per-object detail for the listed query rows (for CSV download).
  async function fetchQueryObjects(): Promise<SourceResult[]> {
    const out: SourceResult[] = [];
    const CH = 24;
    for (let i = 0; i < queryRows.length; i += CH) {
      const chunk = queryRows.slice(i, i + CH);
      const res = await Promise.all(chunk.map(r => loadField(r.fc).then(({ zg }) => fetchObject(r.fc, r.id, zg))));
      for (const s of res) if (s) out.push(s);
    }
    return out;
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
        const CAP = 500;
        const rows: QueryRow[] = [];
        let total = 0;
        for (const fc of fields) {
          const { idx } = await loadField(fc);
          for (let i = 0; i < idx.n; i++) {
            const r: IdxRow = {
              field: idx.field, za: idx.za[i], ra: idx.ra[i], dec: idx.dec[i],
              m277: idx.m277?.[i] ?? null, m444: idx.m444?.[i] ?? null,
              zl68: idx.zl68?.[i] ?? null, zu68: idx.zu68?.[i] ?? null, z_lowz: idx.z_lowz?.[i] ?? null,
              chia: idx.chia?.[i] ?? null, zspec: idx.zspec?.[i] ?? null,
              rh_277: idx.rh_277?.[i] ?? null, rh_444: idx.rh_444?.[i] ?? null,
              kron_radius: idx.kron_radius?.[i] ?? null, a_image: idx.a_image?.[i] ?? null, b_image: idx.b_image?.[i] ?? null,
              x: idx.x?.[i] ?? null, y: idx.y?.[i] ?? null, depthtier: idx.depthtier?.[i] ?? null,
              detectcat: idx.detectcat?.[i] ?? null,
              selected: idx.selected?.[i] ?? null, inspected: idx.inspected?.[i] ?? null,
              sample: idx.sample?.[i] ?? null,
            };
            if (pred(r)) {
              total++;
              if (rows.length < CAP) rows.push({ fc, id: idx.id[i], za: idx.za[i], m444: idx.m444?.[i] ?? null, selected: idx.selected?.[i] ?? null });
            }
          }
        }
        setResults([]); setQueryCard(null); setQueryRows(rows); setQueryTotal(total);
        if (total === 0) { setStatus("notfound"); setMatchSummary("No sources match that query."); }
        else {
          setStatus("table");
          setMatchSummary(`${total.toLocaleString()} source${total === 1 ? "" : "s"} match${total > CAP ? ` — showing first ${CAP}` : ""}.`);
        }
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
        // upload: one entry per line, either "ID" or "RA Dec"
        const lines = uploadText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
        requested = lines.length;
        const loaded = await Promise.all(fields.map(async fc => ({ fc, ...(await loadField(fc)) })));
        for (const line of lines) {
          const parts = line.split(/[\s,]+/);
          if (parts.length === 1) {
            const id = parseInt(parts[0], 10);
            if (!Number.isFinite(id)) continue;
            for (const L of loaded) {
              if (L.idx.id.includes(id)) {
                const src = await fetchObject(L.fc, id, L.zg);
                if (src) { found.push(src); break; }
              }
            }
          } else {
            const ra = parseFloat(parts[0]);
            const dec = parseFloat(parts[1]);
            if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
            let best: { fc: typeof fields[0]; id: number; sep: number; zg: ZGrid } | null = null;
            for (const L of loaded) {
              for (let i = 0; i < L.idx.n; i++) {
                const sep = angSep(ra, dec, L.idx.ra[i], L.idx.dec[i]);
                if (sep <= 0.5 && (!best || sep < best.sep)) {
                  best = { fc: L.fc, id: L.idx.id[i], sep, zg: L.zg };
                }
              }
            }
            if (best) {
              const src = await fetchObject(best.fc, best.id, best.zg);
              if (src) found.push(src);
            }
          }
        }
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
      </div>

      {/* Search card */}
      <div className="card-bright" style={{ padding: "1.5rem", marginBottom: "2rem" }}>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "1.5rem" }}>
          {([
            { key: "id",     label: "By ID" },
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
            <div style={{ marginTop: "10px", fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", lineHeight: 1.9 }}>
              fields: <span style={{ color: "var(--text-muted)" }}>za, zl68, zu68, z_lowz, chia, m277, m444, zspec, rh_277, rh_444, kron_radius, a_image, b_image, x, y, depthtier, selected, inspected, sample, field, detectcat</span> · ops: <span style={{ color: "var(--text-muted)" }}>&gt; &lt; &gt;= &lt;= = != between…and</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                {[
                  "za > 9",
                  "za between 8 and 12",
                  "m444 < 27 and za > 6",
                  "selected = 1 and za > 8",
                  "detectcat = cold and zspec > 0",
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
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{matchSummary} Click a row to view its bio plot.</span>
          </div>

          <DownloadControls
            resolveRows={fetchQueryObjects}
            count={queryRows.length}
            note={queryTotal > queryRows.length ? `first ${queryRows.length} of ${queryTotal.toLocaleString()}` : undefined}
          />

          {queryCard && <ResultCard src={queryCard} />}

          <div className="card" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ background: "rgba(176,124,198,0.08)" }}>
                  {["ID", "z_a", "m₄₄₄", "selected", ""].map((h, i) => (
                    <th key={i} style={{ textAlign: i === 0 ? "left" : "right", padding: "8px 14px", color: "var(--text-dim)", fontWeight: 400, fontSize: "0.72rem", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queryRows.map((r, i) => (
                  <tr key={i}
                    onClick={() => viewQueryRow(r.fc, r.id)}
                    style={{ borderTop: "1px solid var(--border)", cursor: "pointer" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(176,124,198,0.06)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "7px 14px", color: "var(--accent)" }}>{r.id}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text)" }}>{r.za != null ? r.za.toFixed(3) : "—"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--text-muted)" }}>{r.m444 != null ? r.m444.toFixed(2) : "—"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: r.selected ? "var(--amber)" : "var(--text-dim)" }}>{r.selected == null ? "—" : r.selected ? "★" : "·"}</td>
                    <td style={{ padding: "7px 14px", textAlign: "right", color: "var(--accent2)", fontSize: "0.72rem" }}>view →</td>
                  </tr>
                ))}
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
  { key: "RH_F277W",  label: "rh277",    get: s => s.row["RH_F277W"] },
  { key: "RH_F444W",  label: "rh444",    get: s => s.row["RH_F444W"] },
  { key: "DEPTHTIER", label: "depthtier",get: s => s.row["DEPTHTIER"] },
  { key: "selected",  label: "selected", get: s => s.selected },
  { key: "sample",    label: "sample",   get: s => s.sample },
  { key: "zspec",     label: "zspec",    get: s => s.zspec },
  { key: "KRON_RADIUS", label: "kron_radius", get: s => s.row["KRON_RADIUS"] },
  { key: "A_IMAGE",     label: "a_image",     get: s => s.row["A_IMAGE"] },
  { key: "B_IMAGE",     label: "b_image",     get: s => s.row["B_IMAGE"] },
  { key: "DETECTCAT",   label: "detectcat",   get: s => s.row["DETECTCAT"] },
];
const DL_DEFAULT = new Set(["ID", "RA", "DEC", "ZA", "ZL68", "ZU68", "Z_LOWZ", "m444", "selected", "sample"]);

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
  resolveRows: () => Promise<SourceResult[]>; count: number; note?: string;
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
      const rows = await resolveRows();
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
