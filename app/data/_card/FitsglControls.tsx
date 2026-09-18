"use client";
// Shared "campfire-level" display-control panel for the fitsgl WebGL map viewers
// (the interactive /data/map viewer AND the per-field Fields-page viewer). Matches the
// control level at campfire.hollisakins.com/map:
//
//   1. VIEW MODE / FILTER selector — "RGB" (the trilogy colour composite the viewers
//      ship with) OR any single band from the field's own band list. Switching to a
//      single band swaps the render source to a SingleBandSource; RGB restores the
//      producer's trilogy composite.
//   2. RGB trilogy controls (RGB mode) — the four TrilogyParams campfire exposes
//      (noise floor / contrast / white point / black point) as live sliders, seeded
//      from CAMPFIRE_TRILOGY, with a stretch-curve selector + reset-to-default.
//   3. Single-band controls (single-band mode) — a StretchMode selector, a
//      black/white-point percentile control (auto via the viewer's visibleHistogram /
//      percentileRange), and a colormap picker.
//
// This component is PURE UI: it owns no viewer state. Each host drives its mounted
// <FitsViewer> imperatively through the FitsViewerHandle (see applyFitsglDisplay /
// buildRenderSource below), exactly mirroring FitsglCutout's applyTrilogy pattern, and
// feeds this panel the current selection + band list. That keeps a SINGLE control
// component across both viewers with no per-host duplication.
import { useCallback } from "react";
import type { FitsViewerHandle } from "@fitsgl/core/react";
import {
  type TrilogyParams,
  type TrilogyStats,
  type StretchMode,
  type RenderSource,
  type ViewerConfig,
  type ColormapName,
  COLORMAP_NAMES,
} from "@fitsgl/core";

// ---- Trilogy knob model (shared) -------------------------------------------
// The four trilogy params that actually change the look (see @fitsgl/core TrilogyParams
// docs) — the same set campfire's map exposes:
//  noiselum   — output luminance the noise floor maps to (noise-floor brightness)
//  noisesig   — where the noise level is anchored: x1 = mean + noisesig*sigma (contrast)
//  satpercent — % of pixels allowed to saturate; the white point (log-ish → a log slider)
//  noisesig0  — black point below the sky: x0 = mean - noisesig0*sigma
export type TrilogyKnob = {
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
// via applyTrilogy — the multiband shader then applies the SELECTED transfer curve over
// that interval. So noisesig/satpercent/noisesig0 shape the levels for EVERY mode;
// noiselum only solves the trilogy softening K, so it is trilogy-only.
export const TRILOGY_KNOBS: TrilogyKnob[] = [
  { key: "noiselum", label: "Noise floor", hint: "brightness of the sky/noise (trilogy)", min: 0, max: 0.4, step: 0.005, trilogyOnly: true },
  { key: "noisesig", label: "Contrast", hint: "noise anchor · mean + n·σ", min: 0.5, max: 4, step: 0.05 },
  { key: "satpercent", label: "White point", hint: "% pixels saturated", min: 0.001, max: 1, step: 0.001, log: true },
  { key: "noisesig0", label: "Black point", hint: "sky floor · mean − n·σ", min: 1, max: 3, step: 0.05 },
];

// Every transfer curve @fitsgl/core supports (StretchMode). trilogy is the campfire
// default; the others reuse the same per-band black/white points and just swap the curve.
export const STRETCH_MODE_OPTS: { mode: StretchMode; label: string; hint: string }[] = [
  { mode: "trilogy", label: "Trilogy", hint: "Coe faithful log (campfire default)" },
  { mode: "log",     label: "Log",     hint: "astropy LogStretch (a=1000)" },
  { mode: "asinh",   label: "Asinh",   hint: "astropy AsinhStretch (a=0.1)" },
  { mode: "sqrt",    label: "Sqrt",    hint: "square-root" },
  { mode: "linear",  label: "Linear",  hint: "identity" },
];
export const DEFAULT_STRETCH_MODE: StretchMode = "trilogy";

// ---- View-mode model -------------------------------------------------------
// The panel's "view" is either the RGB composite (a sentinel) or one specific band by
// name. Kept as a string so the <select> round-trips it cleanly.
export const RGB_VIEW = "__rgb__";
export type ViewSel = typeof RGB_VIEW | string;   // RGB_VIEW | band name

// A band the selector offers: its stable name + a human label + (optional) precomputed
// trilogy stats (single-band trilogy needs them; percentile fallback used when absent).
export type ControlBand = { name: string; label: string; trilogy?: TrilogyStats };

// ---- Imperative driving (shared across both hosts) -------------------------
// The RGB render source the viewer opened with — the producer's trilogy composite, kept
// so switching back from a single band is a faithful restore (no re-derive drift). Held
// by the host and passed in; we rebuild the SingleBandSource here.

// Build a SingleBandSource for `bandName` from the viewer's loaded pyramids (all bands are
// loaded up front by the config loader, so this is a cheap in-memory swap — no round-trip).
// Returns null if the pyramid isn't resident yet (viewer not ready).
export function singleBandSource(h: FitsViewerHandle, bandName: string): RenderSource | null {
  const pyramids = h.getPyramids();
  const pyramid = pyramids?.get(bandName);
  return pyramid ? { kind: "single", pyramid } : null;
}

// Apply the full display state to a live viewer through the handle, mirroring the
// FitsExplorer / FitsglCutout imperative path. NEVER touches the camera or overlays.
//
//  - RGB mode: (re-)apply the faithful trilogy from the per-band stats + params, then the
//    chosen transfer curve. `rgbStats` is the per-band stats in render-source order; when
//    it's null we can't re-derive levels, so we only set the curve.
//  - single-band mode: set the colormap, then the transfer curve; levels come from the
//    band's trilogy stats when available (applyTrilogy with one stats object), else from a
//    percentile auto-stretch over the data in view.
//
// Returns true once the intended source mode has settled and the display was applied.
export function applyFitsglDisplay(
  h: FitsViewerHandle,
  opts: {
    view: ViewSel;
    trilogy: TrilogyParams;
    stretchMode: StretchMode;
    // RGB: per-band trilogy stats in render-source order (or single stats for a 1-band RGB
    // composite). Single-band: the picked band's stats (or null → percentile auto-stretch).
    stats: TrilogyStats[] | TrilogyStats | null;
    // multiband composite vs a single-pyramid RGB? (affects applyTrilogy's arg shape)
    rgbSingle?: boolean;
    colormap?: ColormapName;
    // Percentile black/white points for single-band auto (0..100); when set, overrides the
    // trilogy-stats path so the user's slider wins.
    percentile?: { lo: number; hi: number } | null;
  },
): boolean {
  const viewer = h.getViewer();
  if (!viewer) return false;
  const single = opts.view !== RGB_VIEW;
  const expectedMode = single ? "single" : opts.rgbSingle ? "single" : "multiband";
  if (viewer.sourceMode !== expectedMode) return false;

  if (single) {
    if (opts.colormap) viewer.setColormap(opts.colormap);
    if (opts.percentile) {
      // User-chosen percentile window over the data in view (async, cache-hit tiles).
      void viewer.autoStretch(opts.percentile.lo, opts.percentile.hi);
      viewer.setStretchMode(opts.stretchMode);
    } else {
      const s = opts.stats;
      const one = Array.isArray(s) ? s[0] : s;
      if (one) {
        viewer.applyTrilogy(one, opts.trilogy);
        viewer.setStretchMode(opts.stretchMode);
      } else {
        // No precomputed stats — fall back to a robust percentile auto-stretch.
        void viewer.autoStretch(1, 99.5);
        viewer.setStretchMode(opts.stretchMode);
      }
    }
    return true;
  }

  // RGB composite.
  const s = opts.stats;
  if (s) {
    viewer.applyTrilogy(opts.rgbSingle && Array.isArray(s) ? s[0] : s, opts.trilogy);
  }
  viewer.setStretchMode(opts.stretchMode);
  return true;
}

// The RGB view descriptor + its per-band stats, derived once by the host from the
// producer config. `restore` is the ViewerView the host rebuilds the RGB RenderSource from
// (via renderSourceForView) when switching back to RGB.
export type RgbPrep = {
  view: ViewerConfig["view"];
  stats: TrilogyStats[] | null;
  single: boolean;   // is the composite backed by a single pyramid (mode 'single')?
};

// ---- The shared panel component --------------------------------------------
export type FitsglControlsProps = {
  bands: ControlBand[];
  view: ViewSel;
  onViewChange: (v: ViewSel) => void;
  // RGB trilogy state.
  params: TrilogyParams;
  onParamsChange: (patch: Partial<TrilogyParams>) => void;
  // Selected transfer curve (shared by both modes).
  mode: StretchMode;
  onModeChange: (m: StretchMode) => void;
  // Single-band-only controls.
  colormap: ColormapName;
  onColormapChange: (c: ColormapName) => void;
  percentile: { lo: number; hi: number } | null;
  onPercentileChange: (p: { lo: number; hi: number } | null) => void;
  // Reset the whole panel to the campfire default look (RGB + campfire trilogy).
  onReset: () => void;
  isDefault: boolean;
  // Collapse.
  open: boolean;
  onToggle: () => void;
  // Panel title (defaults to "DISPLAY").
  title?: string;
};

export default function FitsglControls({
  bands, view, onViewChange,
  params, onParamsChange,
  mode, onModeChange,
  colormap, onColormapChange,
  percentile, onPercentileChange,
  onReset, isDefault,
  open, onToggle,
  title = "DISPLAY",
}: FitsglControlsProps) {
  const single = view !== RGB_VIEW;
  // noiselum only shapes the trilogy curve; hide it for the other transfer functions.
  const knobs = TRILOGY_KNOBS.filter(k => !k.trilogyOnly || mode === "trilogy");

  const onSlider = useCallback(
    (k: TrilogyKnob, raw: number) => {
      const v = k.log
        ? Math.pow(10, Math.log10(k.min) + (raw / 1000) * (Math.log10(k.max) - Math.log10(k.min)))
        : raw;
      onParamsChange({ [k.key]: v } as Partial<TrilogyParams>);
    },
    [onParamsChange],
  );

  // Live percentile window in single-band mode; default [1, 99.5] until the user drags.
  const pct = percentile ?? { lo: 1, hi: 99.5 };

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
        <span
          style={{
            transform: open ? "rotate(90deg)" : "none",
            display: "inline-block", fontSize: "0.7rem",
          }}
          className="fitsgl-caret"
        >▸</span>
        {title}
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px" }}>
          {/* VIEW / FILTER selector: RGB composite or any single band. */}
          <div style={{ marginBottom: 12 }}>
            <div style={fieldLabel}>View</div>
            <select
              aria-label="View mode / filter"
              value={view}
              onChange={e => onViewChange(e.target.value)}
              className="mono"
              style={selectStyle}
            >
              <option value={RGB_VIEW}>RGB (colour)</option>
              {bands.map(b => (
                <option key={b.name} value={b.name}>{b.label}</option>
              ))}
            </select>
            <div style={hintStyle}>
              {single ? "single band · grayscale/colormap" : "trilogy colour composite"}
            </div>
          </div>

          {/* Transfer-curve (stretch-mode) selector — shared by both modes. */}
          <div style={{ marginBottom: 12 }}>
            <div style={fieldLabel}>Stretch</div>
            <select
              aria-label="Stretch mode"
              value={mode}
              onChange={e => onModeChange(e.target.value as StretchMode)}
              className="mono"
              style={selectStyle}
            >
              {STRETCH_MODE_OPTS.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
            </select>
            <div style={hintStyle}>{STRETCH_MODE_OPTS.find(o => o.mode === mode)?.hint}</div>
          </div>

          {/* RGB mode → trilogy knobs. Single-band mode → colormap + percentile window. */}
          {!single ? (
            knobs.map(k => {
              const val = params[k.key];
              const toPos = (v: number) =>
                k.log ? ((Math.log10(v) - Math.log10(k.min)) / (Math.log10(k.max) - Math.log10(k.min))) * 1000 : v;
              return (
                <div key={k.key} style={{ marginBottom: 12 }}>
                  <div style={rowBetween}>
                    <span style={fieldLabel}>{k.label}</span>
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
                    onChange={e => onSlider(k, Number(e.target.value))}
                    style={rangeStyle}
                  />
                  <div style={hintStyle}>{k.hint}</div>
                </div>
              );
            })
          ) : (
            <>
              {/* Colormap picker (single-band). */}
              <div style={{ marginBottom: 12 }}>
                <div style={fieldLabel}>Colormap</div>
                <select
                  aria-label="Colormap"
                  value={colormap}
                  onChange={e => onColormapChange(e.target.value as ColormapName)}
                  className="mono"
                  style={selectStyle}
                >
                  {COLORMAP_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Percentile black/white window (single-band). Dragging either handle sets a
                  user window that overrides the trilogy-stats levels; Auto clears it. */}
              <div style={{ marginBottom: 10 }}>
                <div style={rowBetween}>
                  <span style={fieldLabel}>Black point</span>
                  <span className="mono" style={{ fontSize: "0.68rem", color: "var(--accent)" }}>{pct.lo.toFixed(1)}%</span>
                </div>
                <input
                  type="range" aria-label="Black point percentile"
                  min={0} max={50} step={0.1}
                  value={pct.lo}
                  onChange={e => onPercentileChange({ lo: Math.min(Number(e.target.value), pct.hi - 0.1), hi: pct.hi })}
                  style={rangeStyle}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={rowBetween}>
                  <span style={fieldLabel}>White point</span>
                  <span className="mono" style={{ fontSize: "0.68rem", color: "var(--accent)" }}>{pct.hi.toFixed(1)}%</span>
                </div>
                <input
                  type="range" aria-label="White point percentile"
                  min={50} max={100} step={0.05}
                  value={pct.hi}
                  onChange={e => onPercentileChange({ lo: pct.lo, hi: Math.max(Number(e.target.value), pct.lo + 0.1) })}
                  style={rangeStyle}
                />
                <div style={hintStyle}>
                  {percentile ? "custom · click Auto to reset" : "auto (band stats)"}
                </div>
              </div>
              {percentile && (
                <button
                  onClick={() => onPercentileChange(null)}
                  className="mono"
                  style={{ ...resetBtn, marginBottom: 6, color: "var(--text-muted)", opacity: 1, cursor: "pointer" }}
                >
                  Auto stretch
                </button>
              )}
            </>
          )}

          <button
            onClick={onReset}
            disabled={isDefault}
            className="mono"
            style={{
              ...resetBtn,
              color: isDefault ? "var(--text-dim)" : "var(--text-muted)",
              cursor: isDefault ? "default" : "pointer", opacity: isDefault ? 0.55 : 1,
            }}
          >
            Reset to default
          </button>
        </div>
      )}
      {/* Respect prefers-reduced-motion for the caret rotation. */}
      <style>{`
        .fitsgl-caret { transition: transform 0.15s; }
        @media (prefers-reduced-motion: reduce) { .fitsgl-caret { transition: none; } }
      `}</style>
    </div>
  );
}

// ---- shared inline styles --------------------------------------------------
const fieldLabel: React.CSSProperties = { fontSize: "0.68rem", color: "var(--text)", fontWeight: 600, marginBottom: 3 };
const hintStyle: React.CSSProperties = { fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 2 };
const rowBetween: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 };
const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
  borderRadius: 5, color: "var(--accent)", fontSize: "0.7rem", padding: "5px 7px", cursor: "pointer",
};
const rangeStyle: React.CSSProperties = { width: "100%", accentColor: "var(--accent)", cursor: "pointer", height: 4 };
const resetBtn: React.CSSProperties = {
  width: "100%", marginTop: 2,
  background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
  fontSize: "0.68rem", padding: "6px 10px",
};
