"use client";
// Bare pan/zoom fitsgl COLOR viewer for the PUBLIC Fields page — replaces the DSS/Aladin
// preview. Just the WebGL color mosaic with wheel-zoom + drag-pan; NO catalog overlays, no
// source index, none of the login-gated map machinery (this page is public). Loads the
// public color tiles at unicorn/fitsgl/<prefix>/ (same tiles the Explore map uses).
import { useEffect, useMemo, useState } from "react";
import {
  FitsViewer,
  deriveViewerConfig,
  explorerBandsFromConfig,
  defaultViewFromConfig,
  defaultExplorerState,
} from "@fitsgl/core/react";
import { loadFitsglConfig, type FitsglConfig, type ViewerConfig } from "@fitsgl/core";
import { CAMPFIRE_TRILOGY } from "@/app/data/_card/FitsglCutout";

const FITSGL_ROOT = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl";

export default function FieldFitsglViewer({
  prefix, name, height = 420,
}: { prefix: string; name: string; height?: number }) {
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setConfig(null); setFailed(false);
    loadFitsglConfig(`${FITSGL_ROOT}/${prefix}/fitsgl.json`)
      .then(cfg => { if (!cancelled) setConfig(cfg); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [prefix]);

  // Derive the bare-viewer config (bands + default RGB view), matching the card cutouts /
  // Explore map by starting from CAMPFIRE's scaling. No stats/scaling panel — view-only.
  const viewerConfig = useMemo<ViewerConfig | null>(() => {
    if (!config) return null;
    const bands = explorerBandsFromConfig(config);
    const st = defaultExplorerState(bands, defaultViewFromConfig(config));
    st.trilogyParams = { ...st.trilogyParams, ...CAMPFIRE_TRILOGY };
    return deriveViewerConfig(bands, st);
  }, [config]);

  return (
    <div style={{ position: "relative", width: "100%", height: `${height}px`, background: "#0d0a1a", borderRadius: 6, overflow: "hidden" }}>
      {viewerConfig ? (
        <FitsViewer config={viewerConfig} style={{ width: "100%", height: "100%" }} />
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
    </div>
  );
}
