"use client";
import { useState, useRef } from "react";

// Filter pivot wavelengths in microns
const FILTER_WAVES: Record<string, number> = {
  F435W:0.433, F606W:0.592, F814W:0.806,
  F090W:0.902, F115W:1.154, F150W:1.501, F200W:1.989,
  F277W:2.758, F356W:3.568, F410M:4.082, F444W:4.436, F470N:4.706,
};
const ACS_FILTERS  = new Set(["F435W","F606W","F814W"]);

type SearchMode = "id" | "radec" | "upload";
type ResultState = "idle" | "searching" | "found" | "notfound" | "multi";

interface SourceResult {
  field: string;
  row: Record<string, any>;
  pz: Record<string, any>;
  modelFluxes: Record<string, number>;
  zgrid: number[];
  pzArr: number[];
}

// ---- Corral data wiring ----------------------------------------------------
const VERSION = "0.97";
const CORRAL = "https://web.corral.tacc.utexas.edu/unicorn";

// Fields with a web search index live on Corral. Add entries as fields go live.
const SEARCH_FIELDS: { field: string; dir: string; prefix: string; available: boolean }[] = [
  { field: "CEERS-SPAM", dir: "CEERS-SPAM", prefix: "ceers-spam", available: true },
];

type FieldIndex = {
  field: string; version: string; n: number; filters: string[];
  id: number[]; ra: number[]; dec: number[]; za: number[];
};
type ZGrid = { zgrid: number[]; zgrid_lowz: number[] };

// Module-scoped caches: the index + grid for a field are fetched at most once per session.
const _indexCache: Record<string, FieldIndex> = {};
const _zgridCache: Record<string, ZGrid> = {};

async function loadField(fc: typeof SEARCH_FIELDS[0]): Promise<{ idx: FieldIndex; zg: ZGrid }> {
  if (!_indexCache[fc.field]) {
    const webBase = `${CORRAL}/${fc.dir}/web`;
    const [idx, zg] = await Promise.all([
      fetch(`${webBase}/${fc.prefix}_search_v${VERSION}.json`).then(r => r.json()),
      fetch(`${webBase}/${fc.prefix}_zgrid_v${VERSION}.json`).then(r => r.json()),
    ]);
    _indexCache[fc.field] = idx;
    _zgridCache[fc.field] = zg;
  }
  return { idx: _indexCache[fc.field], zg: _zgridCache[fc.field] };
}

async function fetchObject(fc: typeof SEARCH_FIELDS[0], id: number, zgrid: number[]): Promise<SourceResult | null> {
  try {
    const r = await fetch(`${CORRAL}/${fc.dir}/web/objects/${fc.prefix}_${id}.json`);
    if (!r.ok) return null;
    const o = await r.json();
    return { field: o.field, row: o.row, pz: o.pz, modelFluxes: o.modelFluxes, zgrid, pzArr: o.pzArr };
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

// Tiny inline SED plot using SVG
function SEDPlot({ src }: { src: SourceResult }) {
  const w = 320, h = 160, pad = { t:10, r:10, b:32, l:48 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  // Collect detections and upper limits
  const points: { wav: number; flux: number; err: number; isACS: boolean; isUL: boolean }[] = [];
  for (const [filt, wav] of Object.entries(FILTER_WAVES)) {
    const f = src.row[`FLUX_${filt}`];
    const e = src.row[`FLUXERR_${filt}`];
    if (f === undefined || e === undefined || e > 1e6) continue;
    points.push({ wav, flux: f, err: e, isACS: ACS_FILTERS.has(filt), isUL: f / e < 1 });
  }

  const modelPts: { wav: number; flux: number }[] = Object.entries(src.modelFluxes)
    .filter(([filt]) => FILTER_WAVES[filt])
    .map(([filt, flux]) => ({ wav: FILTER_WAVES[filt], flux }))
    .filter(p => p.flux > 0);

  const allFlux = points.filter(p => !p.isUL).map(p => p.flux);
  const ymax = allFlux.length ? Math.max(...allFlux) * 2.0 : 50;
  const ymin = -0.15 * ymax;
  const xmin = 0.3, xmax = 5.5;

  const cx = (wav: number) => pad.l + ((Math.log10(wav) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * pw;
  const cy = (flux: number) => pad.t + ph - ((flux - ymin) / (ymax - ymin)) * ph;

  const zaVal = src.pz["ZA"] ?? 0;

  return (
    <svg width={w} height={h} style={{ overflow: "visible" }}>
      {/* Zero line */}
      <line x1={pad.l} x2={pad.l+pw} y1={cy(0)} y2={cy(0)} stroke="rgba(176,124,198,0.3)" strokeWidth={0.8} strokeDasharray="3,3"/>
      {/* Model fluxes — filled squares */}
      {modelPts.map((p,i) => (
        <rect key={i} x={cx(p.wav)-4} y={cy(p.flux)-4} width={8} height={8} fill="#4a3a8a" opacity={0.9} />
      ))}
      {/* Detections */}
      {points.filter(p=>!p.isUL).map((p,i) => {
        const x = cx(p.wav), y = cy(p.flux);
        const ey = (p.err/(ymax-ymin))*ph;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y-ey} y2={y+ey} stroke={p.isACS?"#6b51a3":"#b07cc6"} strokeWidth={1.2}/>
            <circle cx={x} cy={y} r={4} fill={p.isACS?"#6b51a3":"#b07cc6"}/>
          </g>
        );
      })}
      {/* Upper limits */}
      {points.filter(p=>p.isUL).map((p,i) => {
        const x = cx(p.wav), y = cy(3*p.err);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y} y2={y+10} stroke={p.isACS?"#6b51a3":"#b07cc6"} strokeWidth={1.2} markerEnd="url(#arrow)"/>
          </g>
        );
      })}
      {/* X axis ticks */}
      {[0.5,1.0,2.0,3.0,4.0,5.0].map(v => (
        <g key={v}>
          <line x1={cx(v)} x2={cx(v)} y1={pad.t+ph} y2={pad.t+ph+4} stroke="var(--text-dim)" strokeWidth={0.8}/>
          <text x={cx(v)} y={pad.t+ph+14} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace">{v}</text>
        </g>
      ))}
      {/* Y axis label */}
      <text x={12} y={pad.t+ph/2} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace"
        transform={`rotate(-90,12,${pad.t+ph/2})`}>nJy</text>
      {/* X axis label */}
      <text x={pad.l+pw/2} y={h-2} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace">μm</text>
      {/* z_a label */}
      <text x={pad.l+pw-4} y={pad.t+10} textAnchor="end" fontSize={9} fill="var(--accent)" fontFamily="monospace">
        z={zaVal.toFixed(2)}
      </text>
      <defs>
        <marker id="arrow" markerWidth="4" markerHeight="4" refX="2" refY="4" orient="auto">
          <path d="M0,0 L2,4 L4,0" fill="none" stroke="var(--text-muted)" strokeWidth="1"/>
        </marker>
      </defs>
    </svg>
  );
}

// P(z) mini plot
function PZPlot({ zgrid, pz, za }: { zgrid: number[]; pz: number[]; za: number }) {
  const w = 180, h = 160, pad = { t:10, r:10, b:32, l:10 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (!pz.length) return null;

  const pzMax = Math.max(...pz);
  const zmax = 16;
  const cx = (z: number) => pad.l + (Math.min(z,zmax)/zmax)*pw;
  const cy = (p: number) => pad.t + ph - (p/pzMax)*ph;

  const pts = zgrid.map((z,i) => `${cx(z)},${cy(pz[i])}`).join(" ");
  const fill = zgrid.map((z,i) => `${cx(z)},${cy(pz[i])}`).join(" ") + ` ${cx(zgrid[zgrid.length-1])},${cy(0)} ${cx(zgrid[0])},${cy(0)}`;

  return (
    <svg width={w} height={h}>
      <polygon points={fill} fill="rgba(176,124,198,0.15)" />
      <polyline points={pts} fill="none" stroke="#b07cc6" strokeWidth={1.5}/>
      {/* z_a line */}
      <line x1={cx(za)} x2={cx(za)} y1={pad.t} y2={pad.t+ph} stroke="var(--accent2)" strokeWidth={1} strokeDasharray="3,2"/>
      {/* X axis */}
      {[0,4,8,12].map(v => (
        <g key={v}>
          <line x1={cx(v)} x2={cx(v)} y1={pad.t+ph} y2={pad.t+ph+4} stroke="var(--text-dim)" strokeWidth={0.8}/>
          <text x={cx(v)} y={pad.t+ph+14} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace">{v}</text>
        </g>
      ))}
      <text x={pad.l+pw/2} y={h-2} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace">z</text>
    </svg>
  );
}

function flux2mag(f: number): string {
  if (f <= 0) return "—";
  return (-2.5*Math.log10(f*1e-9)-48.6).toFixed(1);
}

function ResultCard({ src }: { src: SourceResult }) {
  const pz = src.pz;
  const za = pz["ZA"] ?? 0;
  const zm = pz["ZM"] ?? 0;
  const zl68 = pz["ZL68"] ?? 0;
  const zu68 = pz["ZU68"] ?? 0;
  const zlowz = pz["Z_LOWZ"] ?? 0;
  const f277 = src.row["FLUX_F277W"] ?? 0;
  const f444 = src.row["FLUX_F444W"] ?? 0;
  const rh277 = src.row["RH_F277W"] ?? 0;
  const rh444 = src.row["RH_F444W"] ?? 0;
  const tier = src.row["DEPTHTIER"] ?? 0;

  // Normalize P(z)
  const rawPz = src.pzArr;
  const norm = rawPz.reduce((s,v,i) => s + v*(src.zgrid[i+1]-src.zgrid[i] || 0.02), 0) || 1;
  const pzNorm = rawPz.map(v => v/norm);

  return (
    <div className="card-bright" style={{ padding: "1.25rem", marginBottom: "12px" }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem", flexWrap: "wrap", gap: "8px" }}>
        <div>
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
          <PZPlot zgrid={src.zgrid} pz={pzNorm} za={za} />
        </div>
        {/* Info table */}
        <div style={{ flex: 1, minWidth: "160px" }}>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "8px" }}>PROPERTIES</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <tbody>
              {[
                ["z_a",    za.toFixed(3)],
                ["z_m",    zm.toFixed(3)],
                ["68% CI", `${zl68.toFixed(2)} – ${zu68.toFixed(2)}`],
                ["z_lowz", zlowz.toFixed(3)],
                ["m₂₇₇",  flux2mag(f277)],
                ["m₄₄₄",  flux2mag(f444)],
                ["rh,277", rh277 > 0 ? `${rh277.toFixed(2)} pix` : "—"],
                ["rh,444", rh444 > 0 ? `${rh444.toFixed(2)} pix` : "—"],
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
  const [status, setStatus] = useState<ResultState>("idle");
  const [results, setResults] = useState<SourceResult[]>([]);
  const [matchSummary, setMatchSummary] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Fetches the per-field search index (once, cached) from Corral, matches the
  // query, then pulls per-object detail JSON for each hit to build a SourceResult.
  async function doSearch() {
    setStatus("searching");
    setResults([]);
    setMatchSummary("");
    const fields = SEARCH_FIELDS.filter(f => f.available);
    if (fields.length === 0) {
      setStatus("notfound");
      setMatchSummary("No fields are connected yet.");
      return;
    }

    try {
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
            const src = await fetchObject(fc, id, zg.zgrid);
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
        const cand: { fc: typeof fields[0]; id: number; sep: number; zgrid: number[] }[] = [];
        for (const fc of fields) {
          const { idx, zg } = await loadField(fc);
          for (let i = 0; i < idx.n; i++) {
            const sep = angSep(ra, dec, idx.ra[i], idx.dec[i]);
            if (sep <= radius) cand.push({ fc, id: idx.id[i], sep, zgrid: zg.zgrid });
          }
        }
        cand.sort((a, b) => a.sep - b.sep);
        for (const c of cand.slice(0, 50)) {
          const src = await fetchObject(c.fc, c.id, c.zgrid);
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
                const src = await fetchObject(L.fc, id, L.zg.zgrid);
                if (src) { found.push(src); break; }
              }
            }
          } else {
            const ra = parseFloat(parts[0]);
            const dec = parseFloat(parts[1]);
            if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
            let best: { fc: typeof fields[0]; id: number; sep: number; zgrid: number[] } | null = null;
            for (const L of loaded) {
              for (let i = 0; i < L.idx.n; i++) {
                const sep = angSep(ra, dec, L.idx.ra[i], L.idx.dec[i]);
                if (sep <= 0.5 && (!best || sep < best.sep)) {
                  best = { fc: L.fc, id: L.idx.id[i], sep, zgrid: L.zg.zgrid };
                }
              }
            }
            if (best) {
              const src = await fetchObject(best.fc, best.id, best.zgrid);
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
        <h1 className="mono" style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", marginBottom: "6px" }}>
          Search
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
          Search across all UNICORN fields by ID, position, or uploaded source list.
          Returns photometry, photo-z, and a bio plot for each match.
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

      {status === "found" && results.map((src, i) => (
        <ResultCard key={i} src={src} />
      ))}

      {status === "multi" && (
        <div>
          <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1rem", borderLeft: "3px solid var(--green)", background: "rgba(126,207,176,0.05)" }}>
            <span className="mono" style={{ color: "var(--green)", fontSize: "0.75rem", marginRight: "10px" }}>RESULTS</span>
            <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{matchSummary}</span>
          </div>
          {results.map((src, i) => <ResultCard key={i} src={src} />)}
        </div>
      )}
    </main>
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
