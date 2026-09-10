"use client";
import { useState, useMemo, useRef } from "react";
import type { MatchEntry } from "./page";
import { colGetter } from "./page";

// ---- Interactive scatter of the FULL matched set ----------------------------
// A hand-rolled SVG scatter (no chart lib — static export) of queryAllRef's matches.
// Pick any two numeric columns for X/Y, set per-axis min/max (blank = auto from data)
// and a linear/log toggle each. Points are drawn in the UNICORN palette on the dark
// card; a log axis drops non-positive values (count noted). Capped at PLOT_CAP points.

const PLOT_CAP = 20000;   // max points rendered (full set is usually smaller)

// The numeric columns offered in the X/Y dropdowns. The standard queryable set
// (label → the colGetter key it reads off the index row), in a science-friendly order.
// Extra queried columns (per-filter mag/snr/flux/color etc.) are appended dynamically.
const AXIS_COLS: { key: string; label: string }[] = [
  { key: "za",          label: "za (photo-z)" },
  { key: "zspec",       label: "zspec" },
  { key: "czspec",      label: "campfire zspec" },
  { key: "z_lowz",      label: "z_lowz" },
  { key: "chia",        label: "chi2 (chia)" },
  { key: "m277",        label: "m277" },
  { key: "m444",        label: "m444" },
  { key: "mabs",        label: "M_UV (mabs)" },
  { key: "m1500",       label: "m1500" },
  { key: "m1300",       label: "m1300" },
  { key: "beta",        label: "beta" },
  { key: "mass",        label: "mass (log M*)" },
  { key: "av",          label: "av (A_V)" },
  { key: "sfr10",       label: "sfr10 (log)" },
  { key: "sfr100",      label: "sfr100 (log)" },
  { key: "rh_277",      label: "rh_277 (pix)" },
  { key: "rh_444",      label: "rh_444 (pix)" },
  { key: "kron_radius", label: "kron_radius" },
  { key: "a_image",     label: "a_image" },
  { key: "b_image",     label: "b_image" },
  { key: "ra",          label: "ra" },
  { key: "dec",         label: "dec" },
  { key: "depthtier",   label: "depthtier" },
  { key: "czqual",      label: "czqual" },
  { key: "selected",    label: "selected" },
];
const AXIS_LABEL = new Map(AXIS_COLS.map(c => [c.key, c.label]));

// One axis's user controls: which column, min/max (empty = auto), lin/log scale.
type AxisState = { col: string; min: string; max: string; log: boolean };

// Numeric value of a column on a match entry (via the page's shared colGetter).
function numAt(m: MatchEntry, col: string): number | null {
  const v = colGetter(col)(m.r);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// A "nice" axis-tick step near `raw` (1/2/5 × 10ⁿ), for linear axes.
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
// Linear ticks spanning [lo, hi] (≤ ~8 of them).
function linTicks(lo: number, hi: number): number[] {
  if (!(hi > lo)) return [lo];
  const step = niceStep((hi - lo) / 6);
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(+t.toFixed(8));
  return out.length ? out : [lo, hi];
}
// Log (base-10) ticks at powers of ten spanning [lo, hi] (lo, hi already >0).
function logTicks(lo: number, hi: number): number[] {
  const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
  const out: number[] = [];
  for (let e = a; e <= b; e++) { const v = Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
  return out.length ? out : [lo, hi];
}
// Compact tick label.
function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (v === 0) return "0";
  if (a >= 1e4 || a < 1e-2) return v.toExponential(0).replace("e+", "e");
  return String(+v.toFixed(a < 1 ? 3 : a < 10 ? 2 : a < 100 ? 1 : 0));
}

export default function ScatterPlot({ matches, queryCols }: { matches: MatchEntry[]; queryCols: string[] }) {
  // Column menu = the standard axis set + any queried columns not already there (mag/snr/
  // flux/color and physical props like mass/av/sfr the query pulled), de-duplicated.
  const cols = useMemo(() => {
    const seen = new Set(AXIS_COLS.map(c => c.key));
    const extra = queryCols.filter(c => !seen.has(c)).map(c => ({ key: c, label: c }));
    return [...AXIS_COLS, ...extra];
  }, [queryCols]);

  // Sensible defaults: X = za, Y = the first magnitude present in the menu (else the 2nd col).
  const yDefault = cols.find(c => c.key === "m444") ? "m444" : (cols[1]?.key ?? cols[0]?.key ?? "za");
  const [xa, setXa] = useState<AxisState>({ col: "za", min: "", max: "", log: false });
  const [ya, setYa] = useState<AxisState>({ col: yDefault, min: "", max: "", log: false });
  const [hover, setHover] = useState<{ px: number; py: number; label: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Pull (x, y, id, field) for every match with both columns finite; cap the count.
  // A log axis additionally requires the value > 0 there — count how many that drops.
  const { pts, capped, dropX, dropY, total } = useMemo(() => {
    const gx = xa.col, gy = ya.col;
    const arr: { x: number; y: number; id: number; field: string }[] = [];
    let dropX = 0, dropY = 0;
    const n = Math.min(matches.length, PLOT_CAP);
    for (let i = 0; i < n; i++) {
      const m = matches[i];
      const x = numAt(m, gx), y = numAt(m, gy);
      if (x == null || y == null) continue;
      if (xa.log && !(x > 0)) { dropX++; continue; }
      if (ya.log && !(y > 0)) { dropY++; continue; }
      arr.push({ x, y, id: m.id, field: m.fc.field });
    }
    return { pts: arr, capped: matches.length > PLOT_CAP, dropX, dropY, total: matches.length };
  }, [matches, xa.col, ya.col, xa.log, ya.log]);

  // Data extent → [lo, hi] domain per axis, honouring the user's min/max overrides
  // (blank = auto). Log axes work in log10 space. A degenerate span is padded.
  function domain(vals: number[], ax: AxisState): [number, number] {
    const umin = ax.min.trim() === "" ? null : parseFloat(ax.min);
    const umax = ax.max.trim() === "" ? null : parseFloat(ax.max);
    let lo = vals.length ? Math.min(...vals) : 0;
    let hi = vals.length ? Math.max(...vals) : 1;
    if (umin != null && Number.isFinite(umin)) lo = umin;
    if (umax != null && Number.isFinite(umax)) hi = umax;
    if (ax.log) { lo = lo > 0 ? lo : 1e-3; hi = hi > lo ? hi : lo * 10; }
    if (!(hi > lo)) { const c = lo || 1; lo = c - Math.abs(c) * 0.5 - 0.5; hi = c + Math.abs(c) * 0.5 + 0.5; }
    return [lo, hi];
  }
  const [xlo, xhi] = domain(pts.map(p => p.x), xa);
  const [ylo, yhi] = domain(pts.map(p => p.y), ya);

  // Plot geometry (viewBox units == px in the on-page SVG).
  const W = 640, H = 440, mL = 62, mR = 16, mT = 18, mB = 52;
  const iw = W - mL - mR, ih = H - mT - mB;
  const tx = (x: number) => { const a = xa.log ? Math.log10(x) : x, lo = xa.log ? Math.log10(xlo) : xlo, hi = xa.log ? Math.log10(xhi) : xhi; return mL + ((a - lo) / (hi - lo || 1)) * iw; };
  const ty = (y: number) => { const a = ya.log ? Math.log10(y) : y, lo = ya.log ? Math.log10(ylo) : ylo, hi = ya.log ? Math.log10(yhi) : yhi; return mT + ih - ((a - lo) / (hi - lo || 1)) * ih; };
  const xticks = xa.log ? logTicks(xlo, xhi) : linTicks(xlo, xhi);
  const yticks = ya.log ? logTicks(ylo, yhi) : linTicks(ylo, yhi);

  // Save the plot as a PNG (rasterize the live SVG, dark card background baked in).
  function downloadPNG() {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(W));
    clone.setAttribute("height", String(H));
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%");
    bg.setAttribute("fill", getComputedStyle(document.body).backgroundColor || "#100b24");
    clone.insertBefore(bg, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = W * 2; cv.height = H * 2;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      cv.toBlob(b => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = `unicorn_scatter_${xa.col}_vs_${ya.col}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, "image/png");
    };
    img.src = url;
  }

  // Compact palette-matched styles reused across the two axis control blocks.
  const labelCss: React.CSSProperties = { display: "block", fontSize: "0.68rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", marginBottom: "4px" };
  const inputCss: React.CSSProperties = { width: "70px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "4px", padding: "5px 8px", color: "var(--text)", fontSize: "0.78rem", fontFamily: "'Space Mono', monospace", outline: "none" };
  const selectCss: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "4px", padding: "5px 8px", color: "var(--text)", fontSize: "0.8rem", fontFamily: "'Space Mono', monospace", outline: "none" };

  // One axis's controls: column dropdown + min/max + lin/log toggle.
  const AxisControls = ({ tag, ax, set }: { tag: string; ax: AxisState; set: (a: AxisState) => void }) => (
    <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
      <div>
        <label style={labelCss}>{tag} COLUMN</label>
        <select value={ax.col} onChange={e => set({ ...ax, col: e.target.value })} style={selectCss}>
          {cols.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>
      <div>
        <label style={labelCss}>{tag} MIN</label>
        <input value={ax.min} onChange={e => set({ ...ax, min: e.target.value })} placeholder="auto" style={inputCss} />
      </div>
      <div>
        <label style={labelCss}>{tag} MAX</label>
        <input value={ax.max} onChange={e => set({ ...ax, max: e.target.value })} placeholder="auto" style={inputCss} />
      </div>
      <button onClick={() => set({ ...ax, log: !ax.log })} className="mono"
        title={`Toggle ${tag} axis linear / log (log drops ≤0 values)`}
        style={{ background: ax.log ? "rgba(196,144,216,0.16)" : "transparent", color: ax.log ? "var(--accent)" : "var(--text-muted)",
          border: `1px solid ${ax.log ? "var(--border-bright)" : "var(--border)"}`, borderRadius: "4px", padding: "6px 12px", fontSize: "0.75rem", cursor: "pointer" }}>
        {ax.log ? "log" : "linear"}
      </button>
    </div>
  );

  const dropNote = [dropX ? `${dropX} dropped (x≤0 on log)` : "", dropY ? `${dropY} dropped (y≤0 on log)` : ""].filter(Boolean).join(" · ");

  return (
    <div className="card" style={{ padding: "1.25rem" }}>
      {/* Axis controls */}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "1rem" }}>
        <AxisControls tag="X" ax={xa} set={setXa} />
        <AxisControls tag="Y" ax={ya} set={setYa} />
      </div>

      {/* Point-count / cap / drop summary */}
      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", marginBottom: "0.75rem", display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "center" }}>
        <span>{pts.length.toLocaleString()} point{pts.length === 1 ? "" : "s"} plotted{capped ? ` — capped at ${PLOT_CAP.toLocaleString()} of ${total.toLocaleString()}` : ""}</span>
        {dropNote && <span style={{ color: "var(--amber)" }}>{dropNote}</span>}
        <button onClick={downloadPNG} className="mono"
          title="Download this plot as a PNG"
          style={{ marginLeft: "auto", background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.3)", borderRadius: "5px", padding: "5px 12px", fontSize: "0.72rem", cursor: "pointer" }}>
          ↓ PNG
        </button>
      </div>

      {/* Scatter */}
      <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: `${W}px`, display: "block" }}
          onMouseLeave={() => setHover(null)}>
          {/* Plot frame */}
          <rect x={mL} y={mT} width={iw} height={ih} fill="none" stroke="var(--border)" strokeWidth={1} />
          {/* X ticks + gridlines + labels */}
          {xticks.map((t, i) => {
            const px = tx(t);
            if (px < mL - 0.5 || px > W - mR + 0.5) return null;
            return (
              <g key={`x${i}`}>
                <line x1={px} y1={mT} x2={px} y2={mT + ih} stroke="var(--border)" strokeWidth={0.5} strokeOpacity={0.4} />
                <line x1={px} y1={mT + ih} x2={px} y2={mT + ih + 5} stroke="var(--text-dim)" strokeWidth={1} />
                <text x={px} y={mT + ih + 18} textAnchor="middle" fontSize={11} fill="var(--text-dim)" fontFamily="'Space Mono', monospace">{fmtTick(t)}</text>
              </g>
            );
          })}
          {/* Y ticks + gridlines + labels */}
          {yticks.map((t, i) => {
            const py = ty(t);
            if (py < mT - 0.5 || py > mT + ih + 0.5) return null;
            return (
              <g key={`y${i}`}>
                <line x1={mL} y1={py} x2={mL + iw} y2={py} stroke="var(--border)" strokeWidth={0.5} strokeOpacity={0.4} />
                <line x1={mL - 5} y1={py} x2={mL} y2={py} stroke="var(--text-dim)" strokeWidth={1} />
                <text x={mL - 9} y={py + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)" fontFamily="'Space Mono', monospace">{fmtTick(t)}</text>
              </g>
            );
          })}
          {/* Points (accent, slight transparency so density reads) */}
          {pts.map((p, i) => (
            <circle key={i} cx={tx(p.x)} cy={ty(p.y)} r={2} fill="var(--accent)" fillOpacity={0.5}
              onMouseEnter={() => setHover({ px: tx(p.x), py: ty(p.y), label: `${p.field} ${p.id}` })} />
          ))}
          {/* Hover marker */}
          {hover && <circle cx={hover.px} cy={hover.py} r={4} fill="none" stroke="var(--accent2)" strokeWidth={1.5} />}
          {/* Axis titles */}
          <text x={mL + iw / 2} y={H - 6} textAnchor="middle" fontSize={12} fill="var(--text-muted)" fontFamily="'Space Mono', monospace">
            {AXIS_LABEL.get(xa.col) ?? xa.col}{xa.log ? " (log)" : ""}
          </text>
          <text x={14} y={mT + ih / 2} textAnchor="middle" fontSize={12} fill="var(--text-muted)" fontFamily="'Space Mono', monospace"
            transform={`rotate(-90 14 ${mT + ih / 2})`}>
            {AXIS_LABEL.get(ya.col) ?? ya.col}{ya.log ? " (log)" : ""}
          </text>
        </svg>
        {/* Hover tooltip (id) */}
        {hover && (
          <div style={{ position: "absolute", left: `min(${(hover.px / W) * 100}%, calc(100% - 90px))`, top: `${(hover.py / H) * 100}%`,
            transform: "translate(8px, -50%)", pointerEvents: "none",
            background: "var(--bg-card2)", border: "1px solid var(--border-bright)", borderRadius: "4px",
            padding: "3px 8px", fontSize: "0.72rem", color: "var(--text)", fontFamily: "'Space Mono', monospace", whiteSpace: "nowrap" }}>
            {hover.label}
          </div>
        )}
      </div>
    </div>
  );
}
