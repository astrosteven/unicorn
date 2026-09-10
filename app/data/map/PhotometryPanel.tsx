"use client";
// Floating results panel for the custom-aperture photometry draw tool. Given a finished
// PhotometryResult from the Cloudflare Worker (via lib/photometry's measureAperture), it
// renders the aperture's centre + radius and a per-band table (flux/err/S/N/AB). While the
// request is in flight it shows a spinner; on failure it shows the thrown message. A close
// button clears the panel AND the drawn aperture (handled by the parent) so the user can
// draw another. Styled to match the map's other floating cards (top-right panels).
import { abMagFromNJy, type PhotometryResult } from "@/lib/photometry";

// The panel's state, owned by MapViewer: measuring (spinner), a finished result, or an
// error. `centre`/`radius` are the drawn aperture geometry, shown even before results land.
export type PhotState =
  | { kind: "idle" }
  | { kind: "measuring"; ra: number; dec: number; radiusArcsec: number }
  | { kind: "done"; ra: number; dec: number; radiusArcsec: number; result: PhotometryResult }
  | { kind: "error"; ra: number; dec: number; radiusArcsec: number; message: string };

export default function PhotometryPanel({ state, onClose }: { state: PhotState; onClose: () => void }) {
  if (state.kind === "idle") return null;
  const { ra, dec, radiusArcsec } = state;

  return (
    <div
      data-overlay="photometry"
      style={{
        position: "absolute", left: 14, bottom: 44, zIndex: 22, width: 320, maxWidth: "80vw",
        background: "rgba(13,10,26,0.92)", backdropFilter: "blur(6px)",
        border: "1px solid var(--border-bright)", borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)", overflow: "hidden",
      }}
    >
      {/* Header: title + centre/radius + close. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 11px", borderBottom: "1px solid var(--border)" }}>
        <span className="mono" style={{ fontSize: "0.72rem", color: "#38d0f0", letterSpacing: "0.06em" }}>⬤ PHOTOMETRY</span>
        <button
          onClick={onClose}
          aria-label="Close photometry"
          className="mono"
          style={{ background: "none", border: "1px solid var(--border-bright)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: "0.7rem", padding: "3px 8px" }}
        >
          ✕ clear
        </button>
      </div>

      <div style={{ padding: "9px 11px" }}>
        <div className="mono" style={{ fontSize: "0.68rem", color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.6 }}>
          {ra.toFixed(6)}, {dec.toFixed(6)}
          <br />
          r = {radiusArcsec.toFixed(3)}″
        </div>

        {state.kind === "measuring" && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--text-muted)", fontSize: "0.78rem", padding: "6px 0" }}>
            <span style={{
              width: 15, height: 15, borderRadius: "50%",
              border: "2px solid rgba(56,208,240,0.25)", borderTopColor: "#38d0f0",
              animation: "unicorn-spin 0.9s linear infinite", display: "inline-block",
            }} />
            measuring…
            <style>{`@keyframes unicorn-spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {state.kind === "error" && (
          <div className="mono" style={{ fontSize: "0.72rem", color: "var(--red)", lineHeight: 1.6, padding: "2px 0" }}>
            {state.message}
          </div>
        )}

        {state.kind === "done" && <ResultTable result={state.result} />}
      </div>
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
