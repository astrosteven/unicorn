"use client";
// The map's PHOTOMETRY panel (top-right, its own collapsible section beside SCALING and
// NIRSpec). It holds the ⬤ Measure-photometry toggle, a Clear button, a Download button,
// and — below — the accumulated results: an overplotted SED (one coloured series per
// aperture), a colour→aperture legend, and each aperture's per-band table (flux/err/S/N/AB).
//
// Measurements ACCUMULATE: drawing a new circle appends a MeasuredAperture (each with a
// distinct palette colour) rather than replacing the last; Clear wipes them all. This panel
// is presentational — MapViewer owns the aperture list, the draw tool, and the map circles;
// it passes the list + colours here and gets toggle/clear/download callbacks back.
import { abMagFromNJy, type PhotometryResult } from "@/lib/photometry";
import PhotometrySED, { type SEDSeries, sedPointsFromBands } from "./PhotometrySED";

// One measured (or measuring) aperture in the accumulated list. `n` is its 1-based index
// (shown in the legend + map), `color` its palette colour (shared with its map circle and
// SED series). `state` tracks the in-flight request → result / error.
export type MeasuredAperture = {
  n: number;
  color: string;
  ra: number;
  dec: number;
  radiusArcsec: number;
  state:
    | { kind: "measuring" }
    | { kind: "done"; result: PhotometryResult }
    | { kind: "error"; message: string };
};

export default function PhotometryPanel({
  open,
  apertures,
  photoTool,
  photoEnabled,
  photoHint,
  onToggleOpen,
  onPhotoTool,
  onClear,
  onDownload,
}: {
  open: boolean;
  /** The accumulated apertures (measuring / done / error), each with its palette colour. */
  apertures: MeasuredAperture[];
  /** Custom-aperture draw tool: current on/off, whether it's usable, and a muted reason. */
  photoTool: boolean;
  photoEnabled: boolean;
  photoHint: string;
  onToggleOpen: () => void;
  onPhotoTool: () => void;
  onClear: () => void;
  onDownload: () => void;
}) {
  const hasAny = apertures.length > 0;
  // Only finished measurements contribute a plotted SED series; measuring/errored ones still
  // show in the legend + tables so the user sees them accumulate.
  const series: SEDSeries[] = apertures
    .filter(a => a.state.kind === "done")
    .map(a => ({
      color: a.color,
      points: sedPointsFromBands((a.state as { result: PhotometryResult }).result.results),
    }));

  return (
    <div
      data-overlay="photometry"
      style={{
        width: open ? 300 : undefined, maxWidth: "86vw",
        background: "rgba(13,10,26,0.86)", backdropFilter: "blur(6px)",
        border: "1px solid var(--border-bright)", borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)", overflow: "hidden",
      }}
    >
      <button
        onClick={onToggleOpen}
        className="mono"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          color: photoTool ? "#38d0f0" : hasAny ? "#38d0f0" : "var(--accent)",
          fontSize: "0.72rem", letterSpacing: "0.08em", padding: "9px 11px",
        }}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", fontSize: "0.7rem" }}>▸</span>
        PHOTOMETRY{photoTool ? " ●" : hasAny ? ` · ${apertures.length}` : ""}
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px" }}>
          {/* Draw tool toggle. Enabled only when signed in + on CEERS (Worker is CEERS-only);
              otherwise a muted button + hint (same gating as before). */}
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
                ? "drag on the map to draw a circular aperture · they accumulate"
                : "custom circular-aperture flux (CEERS)"}
          </div>

          {/* Clear + Download — act on the whole accumulated set. */}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={onClear}
              disabled={!hasAny}
              className="mono"
              style={{
                flex: 1, background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
                color: hasAny ? "var(--text-muted)" : "var(--text-dim)",
                cursor: hasAny ? "pointer" : "default", opacity: hasAny ? 1 : 0.55,
                fontSize: "0.68rem", padding: "6px 10px",
              }}
            >
              ✕ Clear
            </button>
            <button
              onClick={onDownload}
              disabled={!hasAny}
              className="mono"
              style={{
                flex: 1, background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
                color: hasAny ? "var(--text-muted)" : "var(--text-dim)",
                cursor: hasAny ? "pointer" : "default", opacity: hasAny ? 1 : 0.55,
                fontSize: "0.68rem", padding: "6px 10px",
              }}
            >
              ↓ Download
            </button>
          </div>

          {hasAny && (
            <div style={{ marginTop: 12 }}>
              {/* Overplotted SED — one coloured series per finished aperture. */}
              {series.length > 0 && <PhotometrySED series={series} />}

              {/* Legend: colour → aperture (index · radius · centre). */}
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {apertures.map(a => (
                  <div key={a.n} className="mono" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.62rem", color: "var(--text-muted)" }}>
                    <span style={{ width: 11, height: 11, borderRadius: "50%", background: a.color, flex: "0 0 auto", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }} />
                    <span style={{ whiteSpace: "nowrap" }}>
                      #{a.n}&nbsp; r={a.radiusArcsec.toFixed(2)}″&nbsp; {a.ra.toFixed(3)},{a.dec.toFixed(3)}
                      {a.state.kind === "measuring" && " · measuring…"}
                      {a.state.kind === "error" && " · failed"}
                    </span>
                  </div>
                ))}
              </div>

              {/* Per-aperture result tables (only finished ones). */}
              {apertures.map(a => {
                if (a.state.kind === "measuring") return null;
                return (
                  <div key={a.n} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div className="mono" style={{ fontSize: "0.64rem", color: a.color, marginBottom: 5 }}>
                      #{a.n} · r = {a.radiusArcsec.toFixed(3)}″ · {a.ra.toFixed(6)}, {a.dec.toFixed(6)}
                    </div>
                    {a.state.kind === "error" ? (
                      <div className="mono" style={{ fontSize: "0.7rem", color: "var(--red)", lineHeight: 1.6 }}>{a.state.message}</div>
                    ) : (
                      <ResultTable result={a.state.result} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-band table: band · flux (nJy) · err (nJy) · S/N · AB. Plus the "measured by" +
// native-aperture-sum caveat as fine print.
function ResultTable({ result }: { result: PhotometryResult }) {
  const cell: React.CSSProperties = { padding: "3px 6px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, color: "var(--text-dim)", fontWeight: 700, borderBottom: "1px solid var(--border)" };
  return (
    <>
      <div style={{ overflowX: "auto", marginBottom: 8 }}>
        <table className="mono" style={{ borderCollapse: "collapse", fontSize: "0.68rem", color: "var(--text)", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left" }}>band</th>
              <th style={head}>flux</th>
              <th style={head}>err</th>
              <th style={head}>S/N</th>
              <th style={head}>AB</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map(b => {
              const snr = b.err_nJy > 0 ? b.flux_nJy / b.err_nJy : null;
              const ab = abMagFromNJy(b.flux_nJy);
              return (
                <tr key={b.band}>
                  <td style={{ ...cell, textAlign: "left", color: "var(--accent)" }}>{b.band}</td>
                  <td style={cell}>{fmt(b.flux_nJy)}</td>
                  <td style={cell}>{fmt(b.err_nJy)}</td>
                  <td style={cell}>{snr == null ? "—" : snr.toFixed(1)}</td>
                  <td style={cell}>{ab == null ? "—" : ab.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.errors && result.errors.length > 0 && (
        <div className="mono" style={{ fontSize: "0.62rem", color: "var(--amber)", marginBottom: 6, lineHeight: 1.5 }}>
          {result.errors.map(e => <div key={e.band}>{e.band}: {e.error}</div>)}
        </div>
      )}

      <div style={{ fontSize: "0.58rem", color: "var(--text-dim)", lineHeight: 1.6 }}>
        flux/err in nJy · measured by {result.user}
        {result.meta?.note && <><br />{result.meta.note}</>}
      </div>
    </>
  );
}

// Flux formatting: 3 sig figs for readability, with a compact form for tiny/huge values.
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1e5)) return v.toExponential(2);
  return v.toPrecision(3);
}
