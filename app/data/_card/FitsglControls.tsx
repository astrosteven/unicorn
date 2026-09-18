"use client";
// Shared "campfire-level" display-control panel for the fitsgl WebGL map viewers
// (the interactive /data/map viewer AND the per-field Fields-page viewer). Matches the
// control level at campfire.hollisakins.com/map:
//
//   1. VIEW selector — three modes:
//        · RGB-weighted (default): the faithful weighted-trilogy composite, every band
//          blended into R/G/B by its own (r,g,b) weight — the producer's real "trilogy"
//          look (richer than a fixed 3-band RGB). This is what the viewers ship with.
//        · Simple RGB: a fixed three-band r/g/b composite.
//        · Single band: any one band, grayscale or colormapped.
//   2. Trilogy sliders (both RGB modes) — the four TrilogyParams campfire exposes
//      (noise floor / contrast / white point / black point), seeded from CAMPFIRE_TRILOGY.
//   3. WEIGHTS grid (RGB-weighted mode) — per-band three dials (R,G,B, 0–100) setting that
//      band's contribution to each output channel, a "✨ rainbow" preset that spreads the
//      bands across R→G→B by wavelength, and per-band add/remove. Drives a weighted
//      MultiBandSource; changing a weight updates live (debounced by the host).
//   4. Stretch-curve selector + single-band colormap + percentile black/white window.
//
// This component is PURE UI: it owns no viewer state. Each host drives its mounted
// <FitsViewer> imperatively through the FitsViewerHandle (see the driving helpers below),
// mirroring FitsglCutout's applyTrilogy pattern, and feeds this panel the current selection
// + band list + weights. One control component across both viewers, no per-host duplication.
import { useCallback, useRef } from "react";
import type { FitsViewerHandle } from "@fitsgl/core/react";
import {
  type TrilogyParams,
  type TrilogyStats,
  type StretchMode,
  type RenderSource,
  type ColormapName,
  type BandWeight,
  COLORMAP_NAMES,
  MAX_BANDS,
  rainbowWeights,
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
// The panel's "view" is one of two composite sentinels or a specific band name. Kept as a
// string so the <select> round-trips cleanly.
export const RGB_WEIGHTED = "__rgbw__";   // faithful weighted-trilogy composite (default)
export const RGB_SIMPLE = "__rgb__";      // fixed 3-band r/g/b composite
// Back-compat alias: the pre-WEIGHTS code called the composite RGB_VIEW; keep it pointing at
// the weighted composite so any external reference still resolves to the default look.
export const RGB_VIEW = RGB_WEIGHTED;
export type ViewSel = typeof RGB_WEIGHTED | typeof RGB_SIMPLE | string;  // sentinel | band name
export function isRgbView(v: ViewSel): boolean { return v === RGB_WEIGHTED || v === RGB_SIMPLE; }

// A band the selector offers: its stable name + a human label + (optional) precomputed
// trilogy stats (trilogy needs them; percentile fallback used when absent) + wavelength
// (microns; used to order bands blue→red for the rainbow preset).
export type ControlBand = { name: string; label: string; trilogy?: TrilogyStats; wavelengthMicron?: number };

// Per-band (R,G,B) weight map (each channel 0..1) + the ordered participating band list.
// Mirrors @fitsgl/core ExplorerState.weights / weightBands.
export type WeightMap = Record<string, BandWeight>;
export type Weights = { bands: string[]; map: WeightMap };

// Value-equality of two weight sets (order-sensitive band list + per-band r/g/b). Used to
// tell whether the current weights match the ship default (drives "Reset to default").
export function weightsEqual(a: Weights, b: Weights): boolean {
  if (a.bands.length !== b.bands.length) return false;
  for (let i = 0; i < a.bands.length; i++) {
    const n = a.bands[i];
    if (n !== b.bands[i]) return false;
    const wa = a.map[n] ?? [0, 0, 0], wb = b.map[n] ?? [0, 0, 0];
    if (wa[0] !== wb[0] || wa[1] !== wb[1] || wa[2] !== wb[2]) return false;
  }
  return true;
}

// ---- Imperative driving (shared across both hosts) -------------------------

// Build a SingleBandSource for `bandName` from the viewer's loaded pyramids (all bands are
// loaded up front by the config loader, so this is a cheap in-memory swap — no round-trip).
// Returns null if the pyramid isn't resident yet (viewer not ready).
export function singleBandSource(h: FitsViewerHandle, bandName: string): RenderSource | null {
  const pyramid = h.getPyramids()?.get(bandName);
  return pyramid ? { kind: "single", pyramid } : null;
}

// Build a fixed 3-band RgbSource from three band names.
export function simpleRgbSource(h: FitsViewerHandle, r: string, g: string, b: string): RenderSource | null {
  const pyr = h.getPyramids();
  const rp = pyr?.get(r), gp = pyr?.get(g), bp = pyr?.get(b);
  return rp && gp && bp ? { kind: "rgb", r: rp, g: gp, b: bp } : null;
}

// Build a weighted MultiBandSource from the ordered participating bands + their (r,g,b)
// weights. Bands with no resident pyramid are skipped. Returns null if fewer than one band
// resolves. `outBands` (if given) is filled with the band names actually included, IN ORDER
// — so the caller can build a matching per-band stats array for applyTrilogy.
export function weightedSource(
  h: FitsViewerHandle, weights: Weights, outBands?: string[],
): RenderSource | null {
  const pyr = h.getPyramids();
  if (!pyr) return null;
  const bands: { pyramid: import("@fitsgl/core").TilePyramid; weight: BandWeight }[] = [];
  for (const name of weights.bands.slice(0, MAX_BANDS)) {
    const p = pyr.get(name);
    if (!p) continue;
    bands.push({ pyramid: p, weight: weights.map[name] ?? [0, 0, 0] });
    outBands?.push(name);
  }
  return bands.length ? { kind: "multiband", bands } : null;
}

// Apply the full display state to a live viewer through the handle, mirroring the
// FitsExplorer / FitsglCutout imperative path. NEVER touches the camera or overlays.
//
//  - weighted / simple RGB: (re-)apply the faithful trilogy from the per-band stats + params
//    (order MUST match the source's band order), then the chosen transfer curve.
//  - single band: set the colormap, then the transfer curve; levels come from the band's
//    trilogy stats when available, else a percentile auto-stretch over the data in view.
//
// Returns true once the intended source mode has settled and the display was applied.
export function applyFitsglDisplay(
  h: FitsViewerHandle,
  opts: {
    view: ViewSel;
    trilogy: TrilogyParams;
    stretchMode: StretchMode;
    // RGB: per-band trilogy stats IN THE SOURCE'S BAND ORDER. Single-band: the picked band's
    // stats (or null → percentile auto-stretch). Weighted/simple both use the array form.
    stats: TrilogyStats[] | TrilogyStats | null;
    colormap?: ColormapName;
    // Percentile black/white points for single-band auto (0..100); when set, overrides the
    // trilogy-stats path so the user's slider wins.
    percentile?: { lo: number; hi: number } | null;
  },
): boolean {
  const viewer = h.getViewer();
  if (!viewer) return false;
  const single = !isRgbView(opts.view);
  const expectedMode = single ? "single" : opts.view === RGB_SIMPLE ? "rgb" : "multiband";
  if (viewer.sourceMode !== expectedMode) return false;

  if (single) {
    if (opts.colormap) viewer.setColormap(opts.colormap);
    if (opts.percentile) {
      void viewer.autoStretch(opts.percentile.lo, opts.percentile.hi);
      viewer.setStretchMode(opts.stretchMode);
    } else {
      const one = Array.isArray(opts.stats) ? opts.stats[0] : opts.stats;
      if (one) {
        viewer.applyTrilogy(one, opts.trilogy);
        viewer.setStretchMode(opts.stretchMode);
      } else {
        void viewer.autoStretch(1, 99.5);
        viewer.setStretchMode(opts.stretchMode);
      }
    }
    return true;
  }

  // RGB composite (weighted multiband OR simple 3-band): applyTrilogy wants an array of
  // per-band stats (rgb → [r,g,b]; multiband → one per source band, same order).
  const s = opts.stats;
  if (Array.isArray(s) && s.length) {
    try { viewer.applyTrilogy(s, opts.trilogy); }
    catch (err) { console.error("[fitsgl] applyTrilogy failed:", err); }
  }
  viewer.setStretchMode(opts.stretchMode);
  return true;
}

// Rainbow preset: order `bands` by wavelength (bluest first; no-wavelength sorts last in
// declaration order), cap to MAX_BANDS (keeping the blue/red ends), and assign
// rainbowWeights(n)[i] — spreads them across the hue circle blue(240°)→red(0°). Mirrors the
// producer's default weighting, so on a full band set it reproduces the ship default colour.
export function rainbowPreset(bands: readonly ControlBand[]): Weights {
  const sorted = [...bands].sort((a, b) => {
    const aw = a.wavelengthMicron, bw = b.wavelengthMicron;
    if (aw == null && bw == null) return 0;
    if (aw == null) return 1;
    if (bw == null) return -1;
    return aw - bw;
  });
  // Cap to MAX_BANDS keeping the blue and red ends (drop from the middle).
  let picked = sorted;
  if (sorted.length > MAX_BANDS) {
    const head = Math.ceil(MAX_BANDS / 2), tail = MAX_BANDS - head;
    picked = [...sorted.slice(0, head), ...sorted.slice(sorted.length - tail)];
  }
  const w = rainbowWeights(picked.length);
  const map: WeightMap = {};
  picked.forEach((b, i) => { map[b.name] = w[i]; });
  return { bands: picked.map(b => b.name), map };
}

// ---- The shared panel component --------------------------------------------
export type FitsglControlsProps = {
  bands: ControlBand[];
  view: ViewSel;
  onViewChange: (v: ViewSel) => void;
  // Trilogy state (both RGB modes).
  params: TrilogyParams;
  onParamsChange: (patch: Partial<TrilogyParams>) => void;
  // Weighted-composite state (RGB-weighted mode).
  weights: Weights;
  onWeightsChange: (w: Weights) => void;
  // Selected transfer curve (shared by all modes).
  mode: StretchMode;
  onModeChange: (m: StretchMode) => void;
  // Single-band-only controls.
  colormap: ColormapName;
  onColormapChange: (c: ColormapName) => void;
  percentile: { lo: number; hi: number } | null;
  onPercentileChange: (p: { lo: number; hi: number } | null) => void;
  // Reset the whole panel to the campfire default look.
  onReset: () => void;
  isDefault: boolean;
  // Collapse.
  open: boolean;
  onToggle: () => void;
  title?: string;
};

export default function FitsglControls({
  bands, view, onViewChange,
  params, onParamsChange,
  weights, onWeightsChange,
  mode, onModeChange,
  colormap, onColormapChange,
  percentile, onPercentileChange,
  onReset, isDefault,
  open, onToggle,
  title = "DISPLAY",
}: FitsglControlsProps) {
  const single = !isRgbView(view);
  const weighted = view === RGB_WEIGHTED;
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

  // Set one channel of one band's weight (channel 0/1/2 = R/G/B; value 0..1).
  const setWeightChannel = useCallback((band: string, ch: 0 | 1 | 2, val: number) => {
    const cur = weights.map[band] ?? [0, 0, 0];
    const c = Math.max(0, Math.min(1, val));
    const next: BandWeight = [
      ch === 0 ? c : cur[0],
      ch === 1 ? c : cur[1],
      ch === 2 ? c : cur[2],
    ];
    onWeightsChange({ bands: weights.bands, map: { ...weights.map, [band]: next } });
  }, [weights, onWeightsChange]);

  // Add the next unused band to the weighted composite (black weights until the user sets it).
  const addBand = useCallback(() => {
    const used = new Set(weights.bands);
    const next = bands.find(b => !used.has(b.name));
    if (!next || weights.bands.length >= MAX_BANDS) return;
    onWeightsChange({ bands: [...weights.bands, next.name], map: { ...weights.map, [next.name]: [0, 0, 0] } });
  }, [bands, weights, onWeightsChange]);

  const removeBand = useCallback((band: string) => {
    const rest: WeightMap = {};
    for (const [k, v] of Object.entries(weights.map)) if (k !== band) rest[k] = v;
    onWeightsChange({ bands: weights.bands.filter(b => b !== band), map: rest });
  }, [weights, onWeightsChange]);

  const canAdd = weights.bands.length < Math.min(bands.length, MAX_BANDS);
  const labelOf = (name: string) => bands.find(b => b.name === name)?.label ?? name;
  const pct = percentile ?? { lo: 1, hi: 99.5 };

  return (
    <div
      style={{
        width: open ? 236 : undefined,
        background: "rgba(13,10,26,0.86)", backdropFilter: "blur(6px)",
        border: "1px solid var(--border-bright)", borderRadius: 8,
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)", overflow: "hidden",
      }}
    >
      <button
        onClick={onToggle} className="mono" aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          color: "var(--accent)", fontSize: "0.72rem", letterSpacing: "0.08em", padding: "9px 11px",
        }}
      >
        <span className="fitsgl-caret" style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", fontSize: "0.7rem" }}>▸</span>
        {title}
      </button>

      {open && (
        <div style={{ padding: "2px 12px 12px", maxHeight: "min(78vh, 640px)", overflowY: "auto" }}>
          {/* VIEW selector: weighted composite / simple RGB / any single band. */}
          <div style={{ marginBottom: 12 }}>
            <div style={fieldLabel}>View</div>
            <select
              aria-label="View mode" value={view} className="mono" style={selectStyle}
              onChange={e => onViewChange(e.target.value)}
            >
              <option value={RGB_WEIGHTED}>RGB — weighted</option>
              <option value={RGB_SIMPLE}>RGB — simple 3-band</option>
              {bands.map(b => <option key={b.name} value={b.name}>{b.label}</option>)}
            </select>
            <div style={hintStyle}>
              {weighted ? "all bands blended into R/G/B" : single ? "single band · grayscale/colormap" : "fixed 3-band composite"}
            </div>
          </div>

          {/* Transfer-curve (stretch-mode) selector — shared by all modes. */}
          <div style={{ marginBottom: 12 }}>
            <div style={fieldLabel}>Stretch</div>
            <select
              aria-label="Stretch mode" value={mode} className="mono" style={selectStyle}
              onChange={e => onModeChange(e.target.value as StretchMode)}
            >
              {STRETCH_MODE_OPTS.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
            </select>
            <div style={hintStyle}>{STRETCH_MODE_OPTS.find(o => o.mode === mode)?.hint}</div>
          </div>

          {/* Trilogy knobs (both RGB modes) OR single-band colormap+percentile. */}
          {!single ? (
            knobs.map(k => {
              const val = params[k.key];
              const toPos = (v: number) =>
                k.log ? ((Math.log10(v) - Math.log10(k.min)) / (Math.log10(k.max) - Math.log10(k.min))) * 1000 : v;
              return (
                <div key={k.key} style={{ marginBottom: 12 }}>
                  <div style={rowBetween}>
                    <span style={fieldLabel}>{k.label}</span>
                    <span className="mono" style={valStyle}>{k.log ? val.toFixed(3) : val.toFixed(k.step < 0.01 ? 3 : 2)}</span>
                  </div>
                  <input
                    type="range" aria-label={k.label}
                    min={k.log ? 0 : k.min} max={k.log ? 1000 : k.max} step={k.log ? 1 : k.step}
                    value={toPos(val)} onChange={e => onSlider(k, Number(e.target.value))}
                    style={rangeStyle}
                  />
                  <div style={hintStyle}>{k.hint}</div>
                </div>
              );
            })
          ) : (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={fieldLabel}>Colormap</div>
                <select
                  aria-label="Colormap" value={colormap} className="mono" style={selectStyle}
                  onChange={e => onColormapChange(e.target.value as ColormapName)}
                >
                  {COLORMAP_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={rowBetween}>
                  <span style={fieldLabel}>Black point</span>
                  <span className="mono" style={valStyle}>{pct.lo.toFixed(1)}%</span>
                </div>
                <input
                  type="range" aria-label="Black point percentile" min={0} max={50} step={0.1}
                  value={pct.lo}
                  onChange={e => onPercentileChange({ lo: Math.min(Number(e.target.value), pct.hi - 0.1), hi: pct.hi })}
                  style={rangeStyle}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={rowBetween}>
                  <span style={fieldLabel}>White point</span>
                  <span className="mono" style={valStyle}>{pct.hi.toFixed(1)}%</span>
                </div>
                <input
                  type="range" aria-label="White point percentile" min={50} max={100} step={0.05}
                  value={pct.hi}
                  onChange={e => onPercentileChange({ lo: pct.lo, hi: Math.max(Number(e.target.value), pct.lo + 0.1) })}
                  style={rangeStyle}
                />
                <div style={hintStyle}>{percentile ? "custom · click Auto to reset" : "auto (band stats)"}</div>
              </div>
              {percentile && (
                <button onClick={() => onPercentileChange(null)} className="mono"
                  style={{ ...resetBtn, marginBottom: 6, color: "var(--text-muted)", opacity: 1, cursor: "pointer" }}>
                  Auto stretch
                </button>
              )}
            </>
          )}

          {/* WEIGHTS grid — RGB-weighted mode only. Per-band R/G/B dials + rainbow + add. */}
          {weighted && (
            <div style={{ marginTop: 4, borderTop: "1px solid var(--border-bright)", paddingTop: 10 }}>
              <div style={{ ...rowBetween, marginBottom: 8 }}>
                <span style={{ ...fieldLabel, marginBottom: 0, letterSpacing: "0.06em" }}>WEIGHTS</span>
                <button
                  onClick={() => onWeightsChange(rainbowPreset(bands))} className="mono"
                  title="Spread bands across R→G→B by wavelength"
                  style={{
                    background: "none", border: "1px solid var(--border-bright)", borderRadius: 5,
                    color: "var(--accent)", fontSize: "0.62rem", padding: "3px 7px", cursor: "pointer",
                  }}
                >
                  ✨ rainbow
                </button>
              </div>
              {/* Column headers (R/G/B), coloured. */}
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr 14px", gap: 4, alignItems: "center", marginBottom: 4 }}>
                <span />
                <span style={{ ...chHead, color: CH_COLOR[0] }}>R</span>
                <span style={{ ...chHead, color: CH_COLOR[1] }}>G</span>
                <span style={{ ...chHead, color: CH_COLOR[2] }}>B</span>
                <span />
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 2 }}>
                {weights.bands.length === 0 && (
                  <div style={{ ...hintStyle, marginTop: 0, marginBottom: 6 }}>No bands — add one or hit rainbow.</div>
                )}
                {weights.bands.map(name => {
                  const w = weights.map[name] ?? [0, 0, 0];
                  return (
                    <div key={name} style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr 14px", gap: 4, alignItems: "center", marginBottom: 6 }}>
                      <span className="mono" style={{ fontSize: "0.6rem", color: "var(--text-muted)", width: 42, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {labelOf(name)}
                      </span>
                      {([0, 1, 2] as const).map(ch => (
                        <WeightDial
                          key={ch}
                          value={w[ch]} color={CH_COLOR[ch]} label={`${labelOf(name)} ${CH_NAME[ch]}`}
                          onChange={v => setWeightChannel(name, ch, v)}
                        />
                      ))}
                      <button
                        onClick={() => removeBand(name)} title={`Remove ${labelOf(name)}`}
                        aria-label={`Remove ${labelOf(name)}`}
                        style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "0.75rem", padding: 0, lineHeight: 1 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
              {canAdd && (
                <button onClick={addBand} className="mono"
                  style={{ ...resetBtn, marginTop: 4, marginBottom: 0, color: "var(--text-muted)", opacity: 1, cursor: "pointer", padding: "4px 10px" }}>
                  + add band
                </button>
              )}
            </div>
          )}

          <button
            onClick={onReset} disabled={isDefault} className="mono"
            style={{
              ...resetBtn, marginTop: 10,
              color: isDefault ? "var(--text-dim)" : "var(--text-muted)",
              cursor: isDefault ? "default" : "pointer", opacity: isDefault ? 0.55 : 1,
            }}
          >
            Reset to default
          </button>
        </div>
      )}
      <style>{`
        .fitsgl-caret { transition: transform 0.15s; }
        .fitsgl-dial-fill { transition: d 0.08s linear; }
        .fitsgl-dial:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
        @media (prefers-reduced-motion: reduce) {
          .fitsgl-caret, .fitsgl-dial-fill { transition: none; }
        }
      `}</style>
    </div>
  );
}

// ---- WeightDial: a compact draggable rotary knob (0..1, shown 0..100) ------
// Faithful to campfire's rotary knobs: an SVG arc dial you drag vertically (up = more) or
// nudge with arrow keys; the coloured arc fills with the value. Accessible (role=slider,
// aria-valuenow, keyboard) and honours prefers-reduced-motion (no transition on the arc).
function WeightDial({
  value, color, label, onChange,
}: { value: number; color: string; label: string; onChange: (v: number) => void }) {
  const dragRef = useRef<{ startY: number; startV: number } | null>(null);
  const R = 9, C = 11, STROKE = 2.5;
  // Arc from -135° to +135° (270° sweep), value 0..1 fills it clockwise from the bottom-left.
  const A0 = -135, SWEEP = 270;
  const pct = Math.max(0, Math.min(1, value));
  const polar = (deg: number) => {
    const r = (deg - 90) * Math.PI / 180;
    return { x: C + R * Math.cos(r), y: C + R * Math.sin(r) };
  };
  const arcPath = (fromDeg: number, toDeg: number) => {
    const a = polar(fromDeg), b = polar(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  };
  const track = arcPath(A0, A0 + SWEEP);
  const fill = pct > 0.001 ? arcPath(A0, A0 + SWEEP * pct) : "";

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startV: value };
  }, [value]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 140px of vertical travel spans the full 0..1 range; up increases.
    onChange(Math.max(0, Math.min(1, d.startV + (d.startY - e.clientY) / 140)));
  }, [onChange]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.05;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { onChange(Math.min(1, value + step)); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { onChange(Math.max(0, value - step)); e.preventDefault(); }
    else if (e.key === "Home") { onChange(0); e.preventDefault(); }
    else if (e.key === "End") { onChange(1); e.preventDefault(); }
  }, [value, onChange]);

  return (
    <div
      role="slider" tabIndex={0}
      aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}
      title={`${label}: ${Math.round(pct * 100)}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      className="fitsgl-dial"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", cursor: "ns-resize", touchAction: "none", outlineOffset: 2 }}
    >
      <svg width={C * 2} height={C * 2} aria-hidden="true">
        <path d={track} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={STROKE} strokeLinecap="round" />
        {fill && <path className="fitsgl-dial-fill" d={fill} fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />}
      </svg>
      <span className="mono" style={{ fontSize: "0.52rem", color: "var(--text-dim)", marginTop: -2 }}>{Math.round(pct * 100)}</span>
    </div>
  );
}

// R/G/B accent colours + names for the WEIGHTS grid.
const CH_COLOR = ["#e0503a", "#43d17a", "#5aa9f0"] as const;   // R red, G green, B blue
const CH_NAME = ["R", "G", "B"] as const;

// ---- shared inline styles --------------------------------------------------
const fieldLabel: React.CSSProperties = { fontSize: "0.68rem", color: "var(--text)", fontWeight: 600, marginBottom: 3 };
const hintStyle: React.CSSProperties = { fontSize: "0.58rem", color: "var(--text-dim)", marginTop: 2 };
const rowBetween: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 };
const valStyle: React.CSSProperties = { fontSize: "0.68rem", color: "var(--accent)" };
const chHead: React.CSSProperties = { fontSize: "0.58rem", fontWeight: 700, textAlign: "center" };
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
