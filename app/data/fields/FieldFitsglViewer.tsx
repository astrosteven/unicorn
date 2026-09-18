"use client";
// Bare pan/zoom fitsgl COLOR viewer for the PUBLIC Fields page — replaces the DSS/Aladin
// preview. The WebGL colour mosaic with wheel-zoom + drag-pan; NO catalog overlays, no
// source index, none of the login-gated map machinery (this page is public). Loads the
// public color tiles at unicorn/fitsgl/<prefix>/ (same tiles the Explore map uses).
//
// It now carries the SAME "campfire-level" display controls as the /data/map viewer, via
// the shared <FitsglControls> panel: RGB (the trilogy composite it ships with) vs any single
// band, live trilogy knobs, a stretch-curve selector, and single-band colormap + percentile
// controls. The mounted <FitsViewer> is driven imperatively through its handle (mirroring
// FitsglCutout), so on load it renders exactly today's CAMPFIRE_TRILOGY RGB view.
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
  renderSourceForView,
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
  RGB_VIEW,
  DEFAULT_STRETCH_MODE,
  applyFitsglDisplay,
  singleBandSource,
  TRILOGY_KNOBS,
  type ViewSel,
  type ControlBand,
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

  // Display-control state (mirrors MapViewer). Defaults = today's CAMPFIRE RGB trilogy look.
  const [view, setView] = useState<ViewSel>(RGB_VIEW);
  const [trilogy, setTrilogy] = useState<TrilogyParams>(CAMPFIRE_PARAMS);
  const [stretchMode, setStretchMode] = useState<StretchMode>(DEFAULT_STRETCH_MODE);
  const [colormap, setColormap] = useState<ColormapName>("gray");
  const [percentile, setPercentile] = useState<{ lo: number; hi: number } | null>(null);
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

  // Derive the bare-viewer config (bands + default RGB view) + the per-band trilogy stats
  // and the band list the selector offers, starting from CAMPFIRE's scaling — matching the
  // card cutouts / Explore map. Same transform <FitsExplorer> / MapViewer do.
  const prep = useMemo(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    st.trilogyParams = { ...st.trilogyParams, ...CAMPFIRE_TRILOGY };
    const viewer: ViewerConfig = deriveViewerConfig(bands, st);
    const v = viewer.view;
    const names = v.mode === "single" ? [v.band] : v.mode === "rgb" ? [v.r, v.g, v.b] : v.bands.map(b => b.band);
    const raw = names.map(n => bands.find(b => b.name === n)?.trilogy);
    const stats = raw.every(s => s !== undefined) ? (raw as TrilogyStats[]) : null;
    const bandStats: Record<string, TrilogyStats | undefined> = {};
    for (const b of bands) bandStats[b.name] = b.trilogy;
    const controlBands: ControlBand[] = bands.map(b => ({ name: b.name, label: b.label ?? b.name, trilogy: b.trilogy }));
    return { viewer, stats, single: v.mode === "single", bands: controlBands, bandStats };
  }, [config]);
  const viewerConfig = prep?.viewer ?? null;
  const controlBands = prep?.bands ?? [];

  // Refs for the imperative path (read at call time so callbacks stay stable).
  const prepRef = useRef(prep);
  prepRef.current = prep;
  const viewRef = useRef<ViewSel>(view); viewRef.current = view;
  const trilogyRef = useRef(trilogy); trilogyRef.current = trilogy;
  const stretchRef = useRef(stretchMode); stretchRef.current = stretchMode;
  const colormapRef = useRef(colormap); colormapRef.current = colormap;
  const percentileRef = useRef(percentile); percentileRef.current = percentile;

  // Apply the current display over the mounted viewer (never touches the camera). Mirrors
  // MapViewer.applyScaling → the shared applyFitsglDisplay helper.
  const applyDisplay = useCallback((viewSel?: ViewSel): boolean => {
    const h = handleRef.current;
    const p = prepRef.current;
    if (!h || !p) return false;
    const v = viewSel ?? viewRef.current;
    if (v === RGB_VIEW) {
      return applyFitsglDisplay(h, { view: RGB_VIEW, trilogy: trilogyRef.current, stretchMode: stretchRef.current, stats: p.stats, rgbSingle: p.single });
    }
    return applyFitsglDisplay(h, {
      view: v, trilogy: trilogyRef.current, stretchMode: stretchRef.current,
      stats: p.bandStats[v] ?? null, colormap: colormapRef.current, percentile: percentileRef.current,
    });
  }, []);

  // Swap the render source when the view/filter changes (SingleBandSource ↔ producer RGB).
  const switchSource = useCallback((v: ViewSel) => {
    const h = handleRef.current;
    const viewer = h?.getViewer();
    const p = prepRef.current;
    if (!h || !viewer || !p) return;
    try {
      if (v === RGB_VIEW) {
        const pyr = h.getPyramids();
        if (pyr) viewer.setSource(renderSourceForView(p.viewer.view, pyr));
      } else {
        const src = singleBandSource(h, v);
        if (src) viewer.setSource(src);
      }
    } catch (err) {
      console.error("[field-viewer] setSource failed:", err);
      return;
    }
    applyDisplay(v);
  }, [applyDisplay]);

  // Live re-apply on panel edits (viewer already up).
  useEffect(() => { applyDisplay(); }, [trilogy, stretchMode, colormap, percentile, applyDisplay]);
  // Swap source on view change.
  useEffect(() => { switchSource(view); }, [view, switchSource]);

  const onReady = useCallback((h: FitsViewerHandle) => {
    handleRef.current = h;
    if (viewRef.current !== RGB_VIEW) switchSource(viewRef.current);
    applyDisplay();
  }, [applyDisplay, switchSource]);

  // The producer's construction fitToImage runs before onReady; re-assert the display until
  // the first frame paints with the source mode settled (mirrors FitsglCutout), then reveal
  // the panel controls. After that, panel edits drive applyDisplay via the effect above — no
  // need to re-derive the stretch on every pan/zoom frame.
  const placedRef = useRef(false);
  const onFrame = useCallback(() => {
    if (placedRef.current) return;
    // Only settle once the display actually applied (viewer source mode has resolved).
    if (applyDisplay()) { placedRef.current = true; setReady(true); }
  }, [applyDisplay]);

  // Reset config-load state when the field changes (placedRef so onFrame re-reveals).
  useEffect(() => { placedRef.current = false; }, [prefix]);

  const isDefaultLook =
    view === RGB_VIEW && stretchMode === DEFAULT_STRETCH_MODE &&
    TRILOGY_KNOBS.every(k => trilogy[k.key] === CAMPFIRE_PARAMS[k.key]);

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

      {/* Shared campfire-level display controls, top-right. Only shown once the viewer is up
          so it never overlays the loading/error message. */}
      {viewerConfig && ready && (
        <div style={{ position: "absolute", top: 10, right: 10, zIndex: 20 }}>
          <FitsglControls
            title="DISPLAY"
            bands={controlBands}
            view={view}
            onViewChange={setView}
            params={trilogy}
            onParamsChange={patch => setTrilogy(p => ({ ...p, ...patch }))}
            mode={stretchMode}
            onModeChange={setStretchMode}
            colormap={colormap}
            onColormapChange={setColormap}
            percentile={percentile}
            onPercentileChange={setPercentile}
            isDefault={isDefaultLook}
            onReset={() => {
              setView(RGB_VIEW); setTrilogy(CAMPFIRE_PARAMS); setStretchMode(DEFAULT_STRETCH_MODE);
              setColormap("gray"); setPercentile(null);
            }}
            open={panelOpen}
            onToggle={() => setPanelOpen(o => !o)}
          />
        </div>
      )}
    </div>
  );
}
