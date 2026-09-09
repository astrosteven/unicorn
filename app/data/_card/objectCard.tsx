"use client";
// Shared object-card module: the data-wiring layer (field registry, index/zgrid/
// per-object fetch with caching) plus the card renderer (SED + P(z) plots, cutout
// montages, ResultCard). Imported by BOTH the Search page and the Explore/Map page
// so a source looks identical however you reach it. Extracted verbatim from the
// original app/data/search/page.tsx — behavior is unchanged.
import { useState, type ReactNode, type CSSProperties } from "react";
import dynamic from "next/dynamic";

// On-the-fly WebGL color cutout (window + WebGL2), loaded client-only via next/dynamic
// with { ssr: false } — required by this static export, same pattern as the /data/map
// viewer. Replaces the retired pre-baked RGB PNG (RgbStamp) for fields with fitsgl tiles.
const FitsglCutout = dynamic(() => import("./FitsglCutout").then((m) => m.FitsglCutout), {
  ssr: false,
});
// Fields that have live fitsgl tiles (drives whether the card shows the on-the-fly
// cutout). Kept in sync with FITSGL_BASE in FitsglCutout.tsx.
const FITSGL_FIELDS = new Set(["CEERS"]);

// Filter pivot wavelengths in microns. Covers HST/ACS + the full JWST/NIRCam
// wide + medium band set used across UNICORN fields (incl. CEERS-SPAM medium bands).
export const FILTER_WAVES: Record<string, number> = {
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

export interface SourceResult {
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
  m1500?: number;
  m1300?: number;
  mabs?: number;
  beta?: number;
  aperflags?: number;
  neighbor?: { dClosest?: number; magClosest?: number; dBrightest?: number; magBrightest?: number };
  stampUrl?: string;
  rgbUrl?: string;
  selFail?: { det: boolean; pix: boolean; z: boolean; zsub: string[] };  // which selection groups/criteria fail
  czspec?: number;    // campfire spectroscopic redshift (if this object has a campfire spectrum)
  czqual?: number;    // campfire redshift quality flag 0-4 (see QUALITY)
  cfield?: string;    // campfire field slug, for the spectrum deep-link
  cid?: string;       // campfire object_id, for the spectrum deep-link
}

// Build the "why not selected" breakdown for object at index position `pos`.
export function selFailFromIndex(idx: FieldIndex, pos: number): SourceResult["selFail"] | undefined {
  if (pos < 0 || idx.detflag == null) return undefined;
  const det = idx.detflag?.[pos] === 0;
  const pix = idx.pixflag?.[pos] === 0;
  const z = idx.zflag?.[pos] === 0;
  const zsub: string[] = [];
  const bits = idx.zsubBits?.[pos] ?? 0;
  if (z && bits && idx.zsubCriteria) {
    idx.zsubCriteria.forEach((name, b) => { if (bits & (1 << b)) zsub.push(name); });
  }
  return { det, pix, z, zsub };
}

// Cutout-montage panel: loads the per-object stamp PNG from Corral on demand.
// Hidden gracefully if the image 404s (e.g. field without stamps yet).
export function StampMontage({ url }: { url: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <div style={{ width: "100%", marginTop: "1rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "4px" }}>
        CUTOUTS <span style={{ color: "var(--text-dim)" }}>(non-WFC3 filters + detection w/ Kron ellipse · each ≈1.5″×1.5″, 51 px @ 30 mas)</span>
      </div>
      <img
        src={url}
        alt="filter cutout montage"
        loading="lazy"
        onError={() => setOk(false)}
        style={{ width: "100%", maxWidth: "760px", border: "1px solid var(--border)", borderRadius: "6px", display: "block" }}
      />
    </div>
  );
}

// RETIRED: static pre-baked RGB PNG cutout. Superseded by <FitsglCutout>, which renders
// the color on the fly from the field's fitsgl tiles (same WebGL color as /data/map).
// Kept only as a reference/fallback; ResultCard no longer uses it. (rgbUrl in
// fetchObject is likewise vestigial — retained so nothing downstream breaks.)
export function RgbStamp({ url }: { url: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "4px" }}>
        COLOR <span style={{ color: "var(--text-dim)" }}>(NIRCam B:F090/115/150 · G:F200/277 · R:F356/410/444 · ≈2.4″, 30 mas)</span>
      </div>
      <img
        src={url}
        alt="RGB color cutout"
        loading="lazy"
        onError={() => setOk(false)}
        style={{ width: "100%", maxWidth: "240px", border: "1px solid var(--border)", borderRadius: "6px", display: "block", imageRendering: "pixelated" }}
      />
    </div>
  );
}

// ---- data wiring -----------------------------------------------------------
export const CORRAL_DEFAULT = "https://web.corral.tacc.utexas.edu/unicorn/Catalogs";
// The search index + zgrid are served from the site itself (GitHub Pages / Fastly
// CDN) — fast + edge-cached for everyone — while the 174k per-object files stay on
// Corral. Index files live in public/searchindex/ (see scripts/make_web_index.py).
export const INDEX_BASE = "/unicorn/searchindex";

// ---- campfire spec-z sidecar ----------------------------------------------
// A daily job (scripts/refresh_campfire_specz.py) cross-matches campfire's public
// spec-z catalog to each field and writes <prefix>_specz_v<ver>.json.gz sidecars
// alongside the index. Each matched object carries its spec-z, a quality flag, and
// the ids needed to deep-link to its spectrum page on campfire.
export const QUALITY: Record<number, string> = {
  0: "Not Inspected", 1: "Impossible", 2: "Tentative", 3: "Probable", 4: "Secure",
};
export function qualityColor(q: number | null | undefined): string {
  if (q == null) return "var(--text-muted)";
  if (q >= 4) return "var(--green)";      // Secure
  if (q === 3) return "var(--accent2)";   // Probable
  if (q === 2) return "var(--amber)";     // Tentative
  return "var(--text-dim)";               // Impossible / Not Inspected
}
// Deep-link to an object's spectrum page on campfire. We don't show the spectrum —
// the user clicks through and logs in on campfire if needed.
export function campfireUrl(cf: string, cid: string): string {
  return `https://campfire.hollisakins.com/nircam/${encodeURIComponent(cf)}?search=${encodeURIComponent(cid)}`;
}
export type SpeczRec = { z: number | null; q: number | null; cid: string; cf: string; sep: number };

// Raw `?data=<url>` override (local preview of a full web/ mirror), or null.
export function dataOverride(): string | null {
  if (typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("data");
    if (o) return o.replace(/\/$/, "");
  }
  return null;
}

// Base for per-object files: the ?data= override, else public Corral.
export function corralBase(): string {
  return dataOverride() ?? CORRAL_DEFAULT;
}

// Fields with a web search index. The index (+ zgrid) is served from the site CDN
// (public/searchindex/); per-object cards + stamps come from Corral (unicorn/<dir>/web/).
// Each field carries its own version — fields release on independent cadences.
// `available` gates a field in the UI; flip to true once its index is committed.
export const SEARCH_FIELDS: { field: string; dir: string; prefix: string; version: string; available: boolean }[] = [
  { field: "CEERS",         dir: "CEERS",         prefix: "ceers",        version: "0.98", available: true },
  { field: "GOODS-S",       dir: "GOODSS",        prefix: "goodss",       version: "0.95", available: true },
  { field: "GOODS-N",       dir: "GOODSN",        prefix: "goodsn",       version: "0.95", available: true },
  { field: "A2744",         dir: "A2744",         prefix: "a2744",        version: "0.98", available: true },
  { field: "NGDEEP",        dir: "NGDEEP",        prefix: "ngdeep",       version: "0.95", available: true },
  { field: "EGS",           dir: "EGS",           prefix: "egs",          version: "0.98", available: true },
  { field: "PRIMER-COSMOS", dir: "PRIMER-COSMOS", prefix: "primercosmos", version: "0.95", available: true },
  { field: "PRIMER-UDS",    dir: "PRIMER-UDS",    prefix: "primeruds",    version: "0.95", available: true },
  { field: "COSMOS",        dir: "COSMOS",        prefix: "cosmos",       version: "0.95", available: true },
];

export type FieldConfig = typeof SEARCH_FIELDS[0];

export type NumCol = (number | null)[] | null;
export type FieldIndex = {
  field: string; version: string; n: number; filters: string[];
  id: number[]; ra: number[]; dec: number[]; za: (number | null)[];
  m277: NumCol; m444: NumCol; m1500?: NumCol; m1300?: NumCol; mabs?: NumCol; beta?: NumCol;
  selected: NumCol; inspected: NumCol; sample: NumCol;
  zl68?: NumCol; zu68?: NumCol; z_lowz?: NumCol; chia?: NumCol; zspec?: NumCol;
  rh_277?: NumCol; rh_444?: NumCol; kron_radius?: NumCol; a_image?: NumCol; b_image?: NumCol; theta?: NumCol;
  x?: NumCol; y?: NumCol; depthtier?: NumCol; detectcat?: (string | null)[] | null; tile?: (string | null)[] | null;
  detflag?: NumCol; pixflag?: NumCol; zflag?: NumCol; zsubBits?: NumCol; zsubCriteria?: string[] | null;
};
export type ZGrid = { zgrid: number[]; zgridLowz: number[]; sedWave: number[] };

// Module-scoped caches: the index + grid for a field are fetched at most once per session.
const _indexCache: Record<string, FieldIndex> = {};
const _zgridCache: Record<string, ZGrid> = {};
const _indexPromise: Record<string, Promise<{ idx: FieldIndex; zg: ZGrid }>> = {};
// Per-filter flux table (native flux_<f>/fluxerr_<f>): lazy — fetched only when a query
// references a mag/snr/flux/color term, and cached per field for the session.
const _filtersCache: Record<string, Record<string, NumCol>> = {};
const _filtersPromise: Record<string, Promise<Record<string, NumCol>>> = {};

// Fetch a JSON file, transparently handling a gzipped (.json.gz) sibling. The
// large search index is served gzipped (~8x smaller) so it transfers reliably;
// prefer the .gz and decompress in-browser, falling back to plain .json.
async function fetchJsonMaybeGz(url: string): Promise<any> {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const r = await fetch(`${url}.gz`);
      if (r.ok && r.body) {
        const ds = new DecompressionStream("gzip");
        const text = await new Response(r.body.pipeThrough(ds)).text();
        return JSON.parse(text);
      }
    } catch { /* fall through to plain JSON */ }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.json();
}

export async function loadField(fc: FieldConfig): Promise<{ idx: FieldIndex; zg: ZGrid }> {
  // Dedupe concurrent loads (e.g. an "all fields" search) onto one in-flight fetch.
  if (fc.field in _indexCache) return { idx: _indexCache[fc.field], zg: _zgridCache[fc.field] };
  if (fc.field in _indexPromise) return _indexPromise[fc.field];
  _indexPromise[fc.field] = (async () => {
    // Index + zgrid: from the ?data= mirror if set, else the site CDN (fast), with a
    // Corral fallback if the site copy is missing (e.g. mid version-bump).
    const override = dataOverride();
    const idxName = `${fc.prefix}_search_v${fc.version}.json`;
    const zgName = `${fc.prefix}_zgrid_v${fc.version}.json`;
    const primary = override ? `${override}/${fc.dir}/web` : INDEX_BASE;
    const load = async (base: string) => Promise.all([
      fetchJsonMaybeGz(`${base}/${idxName}`),
      fetchJsonMaybeGz(`${base}/${zgName}`),
    ]);
    let idx, zg;
    try {
      [idx, zg] = await load(primary);
    } catch (e) {
      if (override) throw e;  // explicit override: don't silently fall back
      [idx, zg] = await load(`${CORRAL_DEFAULT}/${fc.dir}/web`);
    }
    _indexCache[fc.field] = idx;
    _zgridCache[fc.field] = zg;
    return { idx, zg };
  })();
  try {
    return await _indexPromise[fc.field];
  } catch (e) {
    delete _indexPromise[fc.field];  // allow retry on next search
    throw e;
  }
}

// Fetch a field's per-filter flux table (<prefix>_filters_v<ver>.json[.gz]) on demand.
// Returns null (and leaves filter columns unmatched) if the file is missing.
export async function loadFilters(fc: FieldConfig): Promise<Record<string, NumCol> | null> {
  if (fc.field in _filtersCache) return _filtersCache[fc.field];
  if (fc.field in _filtersPromise) return _filtersPromise[fc.field];
  _filtersPromise[fc.field] = (async () => {
    const override = dataOverride();
    const name = `${fc.prefix}_filters_v${fc.version}.json`;
    const primary = override ? `${override}/${fc.dir}/web` : INDEX_BASE;
    try {
      return await fetchJsonMaybeGz(`${primary}/${name}`);
    } catch (e) {
      if (override) throw e;
      return await fetchJsonMaybeGz(`${CORRAL_DEFAULT}/${fc.dir}/web/${name}`);
    }
  })();
  try {
    const fx = await _filtersPromise[fc.field];
    _filtersCache[fc.field] = fx;
    return fx;
  } catch {
    delete _filtersPromise[fc.field];  // allow retry on next search
    return null;
  }
}

// Per-field campfire spec-z sidecar (<prefix>_specz_v<ver>.json[.gz]): a map obj_id ->
// {z,q,cid,cf,sep}, lazy + cached. Absence (field with no spectra / sidecar not yet
// deployed) resolves to an empty map, so callers just see "no spec-z".
const _speczCache: Record<string, Record<string, SpeczRec>> = {};
const _speczPromise: Record<string, Promise<Record<string, SpeczRec>>> = {};
export async function loadSpecz(fc: FieldConfig): Promise<Record<string, SpeczRec>> {
  if (fc.field in _speczCache) return _speczCache[fc.field];
  if (fc.field in _speczPromise) return _speczPromise[fc.field];
  _speczPromise[fc.field] = (async () => {
    const override = dataOverride();
    const name = `${fc.prefix}_specz_v${fc.version}.json`;
    const primary = override ? `${override}/${fc.dir}/web` : INDEX_BASE;
    try {
      const data = await fetchJsonMaybeGz(`${primary}/${name}`);
      return (data && data.objects) || {};
    } catch {
      if (!override) {
        try {
          const d = await fetchJsonMaybeGz(`${CORRAL_DEFAULT}/${fc.dir}/web/${name}`);
          return (d && d.objects) || {};
        } catch { /* fall through */ }
      }
      return {};
    }
  })();
  const m = await _speczPromise[fc.field];
  _speczCache[fc.field] = m;
  return m;
}

// The loaded index for a field, if it has been fetched this session (used to attach
// the selection-failure breakdown to a freshly-fetched object).
export function cachedIndex(field: string): FieldIndex | undefined {
  return _indexCache[field];
}

export async function fetchObject(fc: FieldConfig, id: number, zg: ZGrid): Promise<SourceResult | null> {
  try {
    // Per-object cards live under web/cards/; older uploads used web/objects/ — try
    // the current path first, fall back to the legacy one so a field mid-migration
    // (e.g. CEERS before its rename) keeps working.
    const objBase = `${corralBase()}/${fc.dir}/web`;
    let r = await fetch(`${objBase}/cards/${fc.prefix}_${id}.json`);
    if (!r.ok) r = await fetch(`${objBase}/objects/${fc.prefix}_${id}.json`);
    if (!r.ok) return null;
    const o = await r.json();
    let selFail: SourceResult["selFail"] | undefined;
    const cIdx = cachedIndex(fc.field);
    if (cIdx) selFail = selFailFromIndex(cIdx, cIdx.id.indexOf(id));
    const cf = (await loadSpecz(fc))[String(id)];   // campfire spec-z match, if any
    return {
      field: o.field, row: o.row, pz: o.pz, modelFluxes: o.modelFluxes,
      zgrid: zg.zgrid, pzArr: o.pzArr,
      zgridLowz: zg.zgridLowz, pzArrLowz: o.pzArrLowz,
      sedWave: zg.sedWave, sed: o.sed, sedLowz: o.sedLowz,
      selected: o.selected, inspected: o.inspected, sample: o.sample,
      interestLabel: o.interestLabel, zspec: o.zspec,
      zaCirc: o.zaCirc, dchi2: o.dchi2, m1500: o.m1500, m1300: o.m1300, mabs: o.mabs, beta: o.beta,
      aperflags: o.aperflags, neighbor: o.neighbor,
      stampUrl: `${corralBase()}/${fc.dir}/web/stamps/${fc.prefix}_${id}.png`,
      rgbUrl: `${corralBase()}/${fc.dir}/web/rgb/${fc.prefix}_${id}.png`,
      selFail,
      czspec: cf?.z ?? undefined, czqual: cf?.q ?? undefined, cfield: cf?.cf, cid: cf?.cid,
    };
  } catch {
    return null;
  }
}

// Angular separation in arcsec (small-angle, cos-dec corrected).
export function angSep(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const dra = (ra2 - ra1) * Math.cos(((dec1 + dec2) / 2) * d2r);
  const dde = dec2 - dec1;
  return Math.sqrt(dra * dra + dde * dde) * 3600;
}

// Instrument / marker colors, shared with the legend.
const HST_COLOR = "#3f8fd0";    // HST/ACS detections (blue — distinct from JWST)
const JWST_COLOR = "#c490d8";   // JWST/NIRCam detections (purple)
const MODEL_COLOR = "#f0c070";  // best-fit model (fluxes + fiducial SED curve)
const LOWZ_COLOR = "#ef9fcd";   // low-z (z<7) alternative model

// Inline SED plot (SVG), log flux axis. Circle size encodes bandwidth (large = wide,
// small = medium/narrow); color encodes instrument (purple HST, lavender JWST). The
// reconstructed best-fit (amber) and low-z (pink dashed) model spectra overlay the points.
export function SEDPlot({ src }: { src: SourceResult }) {
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
export function PZPlot({ zgrid, pz, za, zgridLowz, pzLowz }: {
  zgrid: number[]; pz: number[]; za: number;
  zgridLowz?: number[]; pzLowz?: number[];
}) {
  const w = 268, h = 300, pad = { t:20, r:14, b:44, l:40 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (!pz.length) return null;

  const lowzOk = !!(zgridLowz && pzLowz && pzLowz.length === zgridLowz.length && pzLowz.length);
  // y-axis top = 1.1x the FIDUCIAL peak (a taller low-z solution may clip at the top).
  const pzMax = 1.1 * (Math.max(...pz) || 1);
  const zmax = 16;
  const cx = (z: number) => pad.l + (Math.min(z,zmax)/zmax)*pw;
  const cy = (p: number) => Math.max(pad.t, Math.min(pad.t + ph, pad.t + ph - (p/pzMax)*ph));

  const pts = zgrid.map((z,i) => `${cx(z)},${cy(pz[i])}`).join(" ");
  const fill = pts + ` ${cx(zgrid[zgrid.length-1])},${cy(0)} ${cx(zgrid[0])},${cy(0)}`;
  const lowzPts = lowzOk ? zgridLowz!.map((z,i) => `${cx(z)},${cy(pzLowz![i])}`).join(" ") : "";

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: w, display: "block" }}>
      <polygon points={fill} fill="rgba(196,144,216,0.18)" />
      {lowzOk && <polyline points={lowzPts} fill="none" stroke={LOWZ_COLOR} strokeWidth={1.5} strokeDasharray="4,3"/>}
      <polyline points={pts} fill="none" stroke="#c490d8" strokeWidth={1.8}/>
      {/* z_a line — label flips to the left of the line near the right edge so it stays on-screen */}
      <line x1={cx(za)} x2={cx(za)} y1={pad.t} y2={pad.t+ph} stroke="var(--accent2)" strokeWidth={1.2} strokeDasharray="3,2"/>
      {(() => {
        const zaX = cx(za), flip = zaX > pad.l + pw * 0.6;
        return <text x={flip ? zaX - 4 : zaX + 4} y={pad.t + 12} textAnchor={flip ? "end" : "start"} fontSize={11} fill="var(--accent2)" fontFamily="monospace">z_a</text>;
      })()}
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
      {/* Low-z legend hint — second row so it never collides with the z_a label */}
      {lowzOk && <text x={pad.l+pw-4} y={pad.t+26} textAnchor="end" fontSize={9} fill={LOWZ_COLOR} fontFamily="monospace">z&lt;7 alt</text>}
    </svg>
  );
}

// AB magnitude from flux in nJy:  m_AB = 31.40 − 2.5·log10(F / nJy)
function flux2mag(f: number): string {
  if (f <= 0) return "—";
  return (31.4 - 2.5 * Math.log10(f)).toFixed(2);
}

export function ResultCard({ src }: { src: SourceResult }) {
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
      {(src.selected != null || (src.inspected != null && src.inspected > 0) || (src.sample != null && src.sample >= 0) || src.zspec != null || src.czspec != null || (src.aperflags != null && src.aperflags > 0)) && (
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
          {/* campfire spec-z — a clickable chip that opens the spectrum on campfire (log in there). */}
          {src.czspec != null && src.cid && src.cfield && (
            <a href={campfireUrl(src.cfield, src.cid)} target="_blank" rel="noopener noreferrer"
              title="Open this object's spectrum on campfire (log in on campfire if needed)"
              style={{ ...chip(qualityColor(src.czqual)), textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "5px" }}>
              🔥 campfire z-spec {src.czspec.toFixed(3)}
              {src.czqual != null && <span style={{ opacity: 0.8 }}>· {QUALITY[src.czqual] ?? `q${src.czqual}`}</span>} ↗
            </a>
          )}
          {src.aperflags != null && src.aperflags > 0 && (
            <span style={chip("var(--red)")}>aper-flag {src.aperflags}</span>
          )}
        </div>
      )}

      {/* Why-not-selected breakdown (mirrors the bioplot "Not Selected: ..." line) */}
      {src.selected === 0 && src.selFail && (src.selFail.det || src.selFail.pix || src.selFail.z) && (
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "1rem", marginTop: "-4px" }}>
          <span style={{ color: "var(--red)" }}>Fails:</span>{" "}
          {[
            src.selFail.det ? "detection" : null,
            src.selFail.pix ? "image" : null,
            src.selFail.z ? (src.selFail.zsub.length ? `photo-z (${src.selFail.zsub.join(", ")})` : "photo-z") : null,
          ].filter(Boolean).join(" · ")}
        </div>
      )}

      {/* Plots — SED + P(z) shrink together so they stay side-by-side well below the
          SED+P(z) natural width (the SVGs scale via viewBox); wrap only on very narrow screens. */}
      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 300px", minWidth: 0 }}>
          <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginBottom: "4px" }}>SED</div>
          <SEDPlot src={src} />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginBottom: "4px" }}>P(z)</div>
          <PZPlot zgrid={src.zgrid} pz={pzNorm} za={za} zgridLowz={src.zgridLowz} pzLowz={pzLowzNorm} />
        </div>
      </div>

      {/* On-the-fly color cutout — rendered live from the field's fitsgl tiles (same
          WebGL trilogy color as /data/map), NOT a pre-baked PNG. Only for fields with
          fitsgl tiles online; others show nothing. */}
      {FITSGL_FIELDS.has(src.field?.toUpperCase?.() ?? "") && src.row["RA"] != null && src.row["DEC"] != null && (
        <FitsglCutout
          field={src.field.toUpperCase()}
          ra={Number(src.row["RA"])}
          dec={Number(src.row["DEC"])}
        />
      )}
      {src.stampUrl && <StampMontage url={src.stampUrl} />}

      {/* Properties — slim multi-column strip */}
      <div style={{ marginTop: "1.25rem" }}>
        <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginBottom: "8px" }}>PROPERTIES</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: "10px 18px" }}>
          {[
            ["Field",  src.field],
            ...(src.row["TILE"] ? [["Tile", String(src.row["TILE"])]] : []),
            ["ID",     String(src.row["ID"])],
            ["RA",     src.row["RA"] != null ? Number(src.row["RA"]).toFixed(6) : "—"],
            ["Dec",    src.row["DEC"] != null ? Number(src.row["DEC"]).toFixed(6) : "—"],
            ["z_a",    za.toFixed(3)],
            ["68% CI", `${zl68.toFixed(2)}–${zu68.toFixed(2)}`],
            ["Δχ²",   src.dchi2 != null ? src.dchi2.toFixed(1) : "—"],
            ["m₂₇₇",  flux2mag(f277)],
            ["m₄₄₄",  flux2mag(f444)],
            ["M_UV",   src.mabs != null ? src.mabs.toFixed(2) : "—"],
            ["β",      src.beta != null ? src.beta.toFixed(2) : "—"],
            ["rh,277", rh277 > 0 ? `${rh277.toFixed(2)}px` : "—"],
            ["rh,444", rh444 > 0 ? `${rh444.toFixed(2)}px` : "—"],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="mono" style={{ fontSize: "0.6rem", color: "var(--text-dim)", letterSpacing: "0.04em", marginBottom: "2px" }}>{label}</div>
              <div className="mono" style={{ fontSize: "0.8rem", color: "var(--text)" }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: "10px", textAlign: "right" }}>
        <button onClick={() => flagSpurious(src)} className="mono" title="Report this source as spurious / an artifact"
          style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.68rem", cursor: "pointer", letterSpacing: "0.03em" }}>
          ⚑ flag as spurious
        </button>
      </div>
    </div>
  );
}

// Flag a source as spurious: file it into the Supabase `flags` queue (status 'pending')
// for Steven to triage on /data/review. No email. Anonymous callers can insert only.
export async function flagSpurious(src: SourceResult) {
  const id = Number(src.row["ID"]);
  const ra = src.row["RA"] != null ? Number(src.row["RA"]) : null;
  const dec = src.row["DEC"] != null ? Number(src.row["DEC"]) : null;
  const reason = window.prompt(
    `Flag ${src.field} ${id} as spurious?\nOptionally, why does it look wrong? (OK to submit, Cancel to abort)`,
    "",
  );
  if (reason === null) return;  // cancelled
  const { supabase } = await import("@/lib/supabase");
  const { error } = await supabase.from("flags").insert({
    field: src.field, obj_id: id, ra, dec, reason: reason.trim() || null,
  });
  if (error) { window.alert(`Could not submit the flag: ${error.message}`); return; }
  window.alert(`Flagged ${src.field} ${id} for review — thank you!`);
}
