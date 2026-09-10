"use client";
// Small self-contained SED plot for the custom-aperture photometry tool: overplots the
// per-band flux (nJy, log y) vs pivot wavelength (µm, log x) of EVERY accumulated aperture
// on one set of axes, each aperture in its own colour with a connected line + error bars.
// The visual style (log flux vs log observed wavelength, axis labels/fonts/colours, decade
// gridlines) mirrors the card's SEDPlot in app/data/_card/objectCard.tsx — but this one is
// standalone (not tied to a SourceResult), taking just {colour, points} per aperture.
//
// x = FILTER_WAVES[band] (µm); y = flux_nJy; error bar = ±err_nJy. Bands missing from
// FILTER_WAVES or with non-finite flux are skipped by the caller. Non-positive fluxes can't
// sit on a log axis, so they're clamped to the plot floor and drawn as a downward arrow (an
// upper-limit glyph), the same convention the card SED uses for its non-detections.
import { FILTER_WAVES } from "@/app/data/_card/objectCard";

// One aperture's SED: its legend/stroke colour plus the measured per-band fluxes. Each
// point already carries the pivot wavelength (µm) resolved from FILTER_WAVES by the caller.
export type SEDSeries = {
  color: string;
  points: { wav: number; flux: number; err: number }[];
};

export default function PhotometrySED({ series }: { series: SEDSeries[] }) {
  const w = 300, h = 200, pad = { t: 14, r: 12, b: 34, l: 44 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  // X range: fixed to the full filter set so apertures share a common wavelength axis and
  // the plot doesn't jump as bands drop in/out. Matches the card SED's observed-frame span.
  const xmin = 0.3, xmax = 5.5;

  // Y range from every plotted aperture's detections (flux>0) and 3σ upper limits, padded a
  // factor of 3 each way — same recipe as the card SED so the look matches.
  const vals: number[] = [];
  for (const s of series) {
    for (const p of s.points) {
      if (p.flux > 0) vals.push(p.flux);
      else if (p.err > 0) vals.push(3 * p.err);   // 3σ upper limit for the non-detection
    }
  }
  const dataMax = vals.length ? Math.max(...vals) : 50;
  const dataMin = vals.length ? Math.min(...vals) : 1;
  const yTop = dataMax * 3;
  const yBot = Math.max(0.15, dataMin / 3);
  const lTop = Math.log10(yTop), lBot = Math.log10(yBot);

  const cx = (wav: number) => pad.l + ((Math.log10(wav) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * pw;
  const cyRaw = (flux: number) => pad.t + ph - ((Math.log10(flux <= 0 ? yBot : flux) - lBot) / (lTop - lBot)) * ph;
  const cy = (flux: number) => Math.max(pad.t - 3, Math.min(pad.t + ph + 3, cyRaw(flux)));

  // Decade y-ticks across the visible range.
  const decades: number[] = [];
  for (let k = Math.ceil(lBot); k <= Math.floor(lTop); k++) decades.push(k);

  return (
    <div style={{ width: "100%" }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible", display: "block" }}>
        {/* Plot frame */}
        <rect x={pad.l} y={pad.t} width={pw} height={ph} fill="none" stroke="var(--border-bright)" strokeWidth={1} />
        {/* Y decade gridlines + ticks */}
        {decades.map(k => (
          <g key={k}>
            <line x1={pad.l} x2={pad.l + pw} y1={cy(10 ** k)} y2={cy(10 ** k)} stroke="rgba(120,90,170,0.16)" strokeWidth={0.8} />
            <line x1={pad.l} x2={pad.l - 4} y1={cy(10 ** k)} y2={cy(10 ** k)} stroke="var(--text-dim)" strokeWidth={0.8} />
            <text x={pad.l - 7} y={cy(10 ** k) + 3.5} textAnchor="end" fontSize={9} fill="var(--text-dim)" fontFamily="monospace">{10 ** k}</text>
          </g>
        ))}
        {/* Each aperture's SED: connected polyline through its detections + per-point error
            bars; non-positive fluxes clamp to the floor and get a down-arrow (upper limit). */}
        {series.map((s, si) => {
          const dets = s.points.filter(p => p.flux > 0).sort((a, b) => a.wav - b.wav);
          const poly = dets.map(p => `${cx(p.wav).toFixed(1)},${cy(p.flux).toFixed(1)}`).join(" ");
          return (
            <g key={si}>
              {poly && <polyline points={poly} fill="none" stroke={s.color} strokeWidth={1.3} opacity={0.9} />}
              {s.points.map((p, i) => {
                if (p.flux > 0) {
                  const x = cx(p.wav), y = cy(p.flux);
                  return (
                    <g key={i}>
                      <line x1={x} x2={x} y1={cy(p.flux + p.err)} y2={cy(Math.max(p.flux - p.err, yBot * 0.7))} stroke={s.color} strokeWidth={1.1} />
                      <circle cx={x} cy={y} r={3} fill={s.color} />
                    </g>
                  );
                }
                // Non-detection (flux ≤ 0): draw a 3σ down-arrow upper limit if we have an err.
                if (!(p.err > 0)) return null;
                const x = cx(p.wav), y = cy(3 * p.err);
                return (
                  <g key={i}>
                    <line x1={x} x2={x} y1={y} y2={y + 12} stroke={s.color} strokeWidth={1.2} />
                    <path d={`M${x - 3.5},${y + 9} L${x},${y + 14} L${x + 3.5},${y + 9} Z`} fill={s.color} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {/* X axis ticks */}
        {[0.5, 1.0, 2.0, 3.0, 4.0, 5.0].map(v => (
          <g key={v}>
            <line x1={cx(v)} x2={cx(v)} y1={pad.t + ph} y2={pad.t + ph + 5} stroke="var(--text-dim)" strokeWidth={0.8} />
            <text x={cx(v)} y={pad.t + ph + 16} textAnchor="middle" fontSize={9} fill="var(--text-muted)" fontFamily="monospace">{v}</text>
          </g>
        ))}
        {/* Y axis label */}
        <text x={11} y={pad.t + ph / 2} textAnchor="middle" fontSize={9.5} fill="var(--text-muted)" fontFamily="monospace"
          transform={`rotate(-90,11,${pad.t + ph / 2})`}>flux (nJy)</text>
        {/* X axis label */}
        <text x={pad.l + pw / 2} y={h - 4} textAnchor="middle" fontSize={9.5} fill="var(--text-muted)" fontFamily="monospace">observed wavelength (μm)</text>
      </svg>
    </div>
  );
}

// Resolve a measured aperture's per-band fluxes into plottable SED points: x from
// FILTER_WAVES (µm), y = flux_nJy, err = err_nJy. Bands missing from FILTER_WAVES or with a
// non-finite flux are dropped (they can't be placed on the wavelength axis). Exported so the
// caller can build a SEDSeries[] straight from PhotometryResult.results.
export function sedPointsFromBands(
  bands: { band: string; flux_nJy: number; err_nJy: number }[],
): { wav: number; flux: number; err: number }[] {
  const out: { wav: number; flux: number; err: number }[] = [];
  for (const b of bands) {
    // Worker returns lowercase band names (f115w); FILTER_WAVES keys are uppercase.
    const wav = FILTER_WAVES[b.band.toUpperCase()];
    if (wav === undefined || !Number.isFinite(b.flux_nJy)) continue;
    out.push({ wav, flux: b.flux_nJy, err: Number.isFinite(b.err_nJy) ? b.err_nJy : 0 });
  }
  return out;
}
