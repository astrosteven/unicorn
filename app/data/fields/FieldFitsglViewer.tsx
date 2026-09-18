"use client";
// Bare pan/zoom fitsgl COLOR viewer for the PUBLIC Fields page — replaces the DSS/Aladin
// preview. The WebGL colour mosaic with wheel-zoom + drag-pan; NO catalog overlays, no
// source index, none of the login-gated map machinery (this page is public). Loads the
// public color tiles at unicorn/fitsgl/<prefix>/ (same tiles the Explore map uses).
//
// It carries the SAME "campfire-level" display controls as the /data/map viewer, via the
// shared <FitsglControls> panel: RGB-weighted composite (the ship default, with a per-band
// WEIGHTS grid + rainbow), simple 3-band RGB, or any single band, plus live trilogy knobs,
// a stretch-curve selector, and single-band colormap + percentile controls. The mounted
// <FitsViewer> is driven imperatively through its handle (mirroring FitsglCutout / MapViewer),
// so on load it renders exactly today's CAMPFIRE_TRILOGY weighted-composite view.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FitsViewer,
  type FitsViewerHandle,
  deriveViewerConfig,
  explorerBandsFromConfig,
  defaultViewFromConfig,
  defaultExplorerState,
} from "@fitsgl/core/react";
import {
  loadFitsglConfig,
  DEFAULT_TRILOGY_PARAMS,
  type FitsglConfig,
  type ViewerConfig,
  type TrilogyParams,
  type TrilogyStats,
  type StretchMode,
  type ColormapName,
} from "@fitsgl/core";
import { CAMPFIRE_TRILOGY } from "@/app/data/_card/FitsglCutout";
import FitsglControls, {
  RGB_WEIGHTED,
  RGB_SIMPLE,
  DEFAULT_STRETCH_MODE,
  applyFitsglDisplay,
  singleBandSource,
  simpleRgbSource,
  weightedSource,
  weightsEqual,
  TRILOGY_KNOBS,
  type ViewSel,
  type ControlBand,
  type Weights,
} from "@/app/data/_card/FitsglControls";

const FITSGL_ROOT = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl";

// The campfire trilogy params as a full TrilogyParams (CAMPFIRE_TRILOGY is a partial override).
const CAMPFIRE_PARAMS: TrilogyParams = { ...DEFAULT_TRILOGY_PARAMS, ...CAMPFIRE_TRILOGY };

export default function FieldFitsglViewer({
  prefix, name, height = 420,
}: { prefix: string; name: string; height?: number }) {
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // Display-control state (mirrors MapViewer). Defaults = today's CAMPFIRE weighted look.
  const [view, setView] = useState<ViewSel>(RGB_WEIGHTED);
  const [trilogy, setTrilogy] = useState<TrilogyParams>(CAMPFIRE_PARAMS);
  const [stretchMode, setStretchMode] = useState<StretchMode>(DEFAULT_STRETCH_MODE);
  const [colormap, setColormap] = useState<ColormapName>("gray");
  const [percentile, setPercentile] = useState<{ lo: number; hi: number } | null>(null);
  const [weights, setWeights] = useState<Weights>({ bands: [], map: {} });
  const [panelOpen, setPanelOpen] = useState(true);

  const handleRef = useRef<FitsViewerHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConfig(null); setFailed(false); setReady(false);
    loadFitsglConfig(`${FITSGL_ROOT}/${prefix}/fitsgl.json`)
      .then(cfg => { if (!cancelled) setConfig(cfg); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [prefix]);

  // Derive the bare-viewer config + per-band stats + band list + producer default weights +
  // the simple-RGB triple, starting from CAMPFIRE's scaling. Same transform MapViewer does.
  const prep = useMemo(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    st.trilogyParams = { ...st.trilogyParams, ...CAMPFIRE_TRILOGY };
    const viewer: ViewerConfig = deriveViewerConfig(bands, st);
    const bandStats: Record<string, TrilogyStats | undefined> = {};
    for (const b of bands) bandStats[b.name] = b.trilogy;
    const controlBands: ControlBand[] = bands.map(b => ({
      name: b.name, label: b.label ?? b.name, trilogy: b.trilogy, wavelengthMicron: b.wavelengthMicron,
    }));
    const rgbTriple = { r: st.rgb.r, g: st.rgb.g, b: st.rgb.b };
    const defaultWeights: Weights = st.weightBands.length
      ? { bands: [...st.weightBands], map: { ...st.weights } }
      : { bands: [rgbTriple.r, rgbTriple.g, rgbTriple.b], map: { [rgbTriple.r]: [1, 0, 0], [rgbTriple.g]: [0, 1, 0], [rgbTriple.b]: [0, 0, 1] } };
    return { viewer, bands: controlBands, bandStats, defaultWeights, rgbTriple };
  }, [config]);
  const viewerConfig = prep?.viewer ?? null;
  const controlBands = prep?.bands ?? [];

  // Seed the weighted-composite weights from the producer default once prep loads / field
  // changes — so the viewer opens on the exact ship colour. Also seed appliedBandsRef.
  useEffect(() => {
    if (!prep) return;
    setWeights(prep.defaultWeights);
    appliedBandsRef.current = [...prep.defaultWeights.bands];
  }, [prep]);

  // Refs for the imperative path (read at call time so callbacks stay stable).
  const prepRef = useRef(prep); prepRef.current = prep;
  const viewRef = useRef<ViewSel>(view); viewRef.current = view;
  const trilogyRef = useRef(trilogy); trilogyRef.current = trilogy;
  const stretchRef = useRef(stretchMode); stretchRef.current = stretchMode;
  const colormapRef = useRef(colormap); colormapRef.current = colormap;
  const percentileRef = useRef(percentile); percentileRef.current = percentile;
  const weightsRef = useRef(weights); weightsRef.current = weights;
  // Band order currently loaded in the multiband source (for setBandWeights + stats order).
  const appliedBandsRef = useRef<string[]>([]);

  // Per-band trilogy stats in a given band order (for applyTrilogy). Missing stats ⇒ null.
  const orderedStats = useCallback((names: string[]): TrilogyStats[] | null => {
    const p = prepRef.current;
    if (!p) return null;
    const out: TrilogyStats[] = [];
    for (const n of names) {
      const s = p.bandStats[n];
      if (!s) return null;
      out.push(s);
    }
    return out.length ? out : null;
  }, []);

  // Apply the current display over the mounted viewer (never touches the camera).
  const applyDisplay = useCallback((viewSel?: ViewSel): boolean => {
    const h = handleRef.current;
    const p = prepRef.current;
    if (!h || !p) return false;
    const v = viewSel ?? viewRef.current;
    if (v === RGB_WEIGHTED) {
      return applyFitsglDisplay(h, { view: RGB_WEIGHTED, trilogy: trilogyRef.current, stretchMode: stretchRef.current, stats: orderedStats(appliedBandsRef.current) });
    }
    if (v === RGB_SIMPLE) {
      const t = p.rgbTriple;
      return applyFitsglDisplay(h, { view: RGB_SIMPLE, trilogy: trilogyRef.current, stretchMode: stretchRef.current, stats: orderedStats([t.r, t.g, t.b]) });
    }
    return applyFitsglDisplay(h, {
      view: v, trilogy: trilogyRef.current, stretchMode: stretchRef.current,
      stats: p.bandStats[v] ?? null, colormap: colormapRef.current, percentile: percentileRef.current,
    });
  }, [orderedStats]);

  // Swap the render source when the view changes (weighted / simple RGB / single band).
  const switchSource = useCallback((v: ViewSel) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    const p = prepRef.current;
    if (!h || !viewer || !p) return;
    try {
      if (v === RGB_WEIGHTED) {
        const applied: string[] = [];
        const src = weightedSource(h, weightsRef.current, applied);
        if (!src) return;
        viewer.setSource(src); appliedBandsRef.current = applied;
      } else if (v === RGB_SIMPLE) {
        const t = p.rgbTriple;
        const src = simpleRgbSource(h, t.r, t.g, t.b);
        if (!src) return;
        viewer.setSource(src); appliedBandsRef.current = [t.r, t.g, t.b];
      } else {
        const src = singleBandSource(h, v);
        if (!src) return;
        viewer.setSource(src); appliedBandsRef.current = [v];
      }
    } catch (err) {
      console.error("[field-viewer] setSource failed:", err);
      return;
    }
    applyDisplay(v);
  }, [applyDisplay]);

  // Apply a weights change to the live weighted composite (fast setBandWeights when the band
  // SET is unchanged; else a full rebuild via switchSource). Only in RGB-weighted mode.
  const applyWeights = useCallback((w: Weights) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    if (!h || !viewer || viewRef.current !== RGB_WEIGHTED) return;
    const applied = appliedBandsRef.current;
    const sameSet = applied.length === w.bands.length && applied.every((b, i) => b === w.bands[i]);
    if (sameSet && viewer.sourceMode === "multiband") {
      try { viewer.setBandWeights(applied.map(b => w.map[b] ?? [0, 0, 0])); }
      catch (err) { console.error("[field-viewer] setBandWeights failed:", err); }
    } else {
      switchSource(RGB_WEIGHTED);
    }
  }, [switchSource]);

  // Live re-apply on panel edits (viewer already up).
  useEffect(() => { applyDisplay(); }, [trilogy, stretchMode, colormap, percentile, applyDisplay]);
  // Swap source on view change.
  useEffect(() => { switchSource(view); }, [view, switchSource]);
  // Push weight edits to the live composite.
  useEffect(() => { applyWeights(weights); }, [weights, applyWeights]);

  const onReady = useCallback((h: FitsViewerHandle) => {
    handleRef.current = h;
    // A fresh viewer opens in the producer default composite; re-assert the current view +
    // weights (idempotent + cheap).
    switchSource(viewRef.current);
    applyDisplay();
  }, [applyDisplay, switchSource]);

  // The producer's construction fitToImage runs before onReady; re-assert the display until
  // the first frame paints with the source mode settled (mirrors FitsglCutout), then reveal
  // the panel. After that, panel edits drive applyDisplay via the effects above.
  const placedRef = useRef(false);
  const onFrame = useCallback(() => {
    if (placedRef.current) return;
    if (applyDisplay()) { placedRef.current = true; setReady(true); }
  }, [applyDisplay]);

  // Reset config-load state when the field changes (placedRef so onFrame re-reveals).
  useEffect(() => { placedRef.current = false; }, [prefix]);

  const isDefaultLook =
    view === RGB_WEIGHTED && stretchMode === DEFAULT_STRETCH_MODE &&
    TRILOGY_KNOBS.every(k => trilogy[k.key] === CAMPFIRE_PARAMS[k.key]) &&
    (prep ? weightsEqual(weights, prep.defaultWeights) : true);

  return (
    <div style={{ position: "relative", width: "100%", height: `${height}px`, background: "#0d0a1a", borderRadius: 6, overflow: "hidden" }}>
      {viewerConfig ? (
        <FitsViewer
          ref={handleRef}
          config={viewerConfig}
          onReady={onReady}
          onFrame={onFrame}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "'Space Mono', monospace", fontSize: "0.8rem", color: "var(--text-dim)",
        }}>
          {failed ? "Color map unavailable" : "Loading color map…"}
        </div>
      )}
      <div style={{
        position: "absolute", top: 10, left: 10, background: "rgba(13,10,26,0.75)", backdropFilter: "blur(6px)",
        borderRadius: 4, padding: "4px 10px", fontFamily: "'Space Mono', monospace", fontSize: "0.75rem",
        color: "var(--accent)", pointerEvents: "none", zIndex: 10,
      }}>
        {name}
      </div>

      {/* Shared campfire-level display controls, top-right. Shown once the viewer is up so it
          never overlays the loading/error message. */}
      {viewerConfig && ready && (
        <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20 }}>
          <FitsglControls
            title="DISPLAY"
            bands={controlBands}
            view={view}
            onViewChange={setView}
            params={trilogy}
            onParamsChange={patch => setTrilogy(p => ({ ...p, ...patch }))}
            weights={weights}
            onWeightsChange={setWeights}
            mode={stretchMode}
            onModeChange={setStretchMode}
            colormap={colormap}
            onColormapChange={setColormap}
            percentile={percentile}
            onPercentileChange={setPercentile}
            isDefault={isDefaultLook}
            onReset={() => {
              setView(RGB_WEIGHTED); setTrilogy(CAMPFIRE_PARAMS); setStretchMode(DEFAULT_STRETCH_MODE);
              setColormap("gray"); setPercentile(null);
              if (prep) setWeights(prep.defaultWeights);
            }}
            open={panelOpen}
            onToggle={() => setPanelOpen(o => !o)}
          />
        </div>
      )}
    </div>
  );
}
