"use client";
// Explore — an interactive fitsgl WebGL color map of CEERS. Pan/zoom the NIRCam
// RGB mosaic; every catalog source is a clickable marker that opens the SAME
// SED / P(z) ResultCard used by the Search page (shared app/data/_card module).
//
// The WebGL viewer (window + WebGL2) is loaded client-only via next/dynamic with
// { ssr: false }, as required by this Next 16 static export (output: "export").
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  SEARCH_FIELDS,
  loadField,
  fetchObject,
  ResultCard,
  type SourceResult,
} from "@/app/data/_card/objectCard";

// The viewer touches WebGL/window on import — must never render on the server.
const MapViewer = dynamic(() => import("./MapViewer"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0d0a1a" }}>
      <span className="mono" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Loading viewer…</span>
    </div>
  ),
});

// Production tile location on Corral. `dist_full/ceers/` (fitsgl.json + band dirs +
// catalog.csv) is uploaded here; the config lives at `<base>/fitsgl.json`.
const CORRAL_TILES = "https://web.corral.tacc.utexas.edu/unicorn/fitsgl/ceers";

// This map shows CEERS.
const CEERS = SEARCH_FIELDS.find(f => f.field === "CEERS")!;

// Tile/config base: `?data=<baseUrl>` override (e.g. a local `fitsgl serve`), else
// Corral. Mirrors the Search page's dataOverride() pattern; the config is at
// `<base>/fitsgl.json`. NOTE: when `?data=` is set it also redirects the shared
// card fetch (corralBase()) — expected for local testing, where cards may 404 and
// the panel shows "not found". In production (no `?data=`) tiles come from Corral
// and cards from the normal Catalogs path.
function tileBase(): string {
  if (typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("data");
    if (o) return o.replace(/\/$/, "");
  }
  return CORRAL_TILES;
}

type PanelState =
  | { kind: "hidden" }
  | { kind: "loading"; id: number }
  | { kind: "found"; id: number; src: SourceResult }
  | { kind: "notfound"; id: number };

export default function MapPage() {
  // Resolved once, lazily: tileBase() reads window for the ?data= override (safe —
  // returns the Corral default on the server). The WebGL viewer is client-only
  // (dynamic ssr:false), so this value is only ever consumed after hydration.
  const [configUrl] = useState<string>(() => `${tileBase()}/fitsgl.json`);
  const [panel, setPanel] = useState<PanelState>({ kind: "hidden" });

  async function openSource(id: number) {
    setPanel({ kind: "loading", id });
    try {
      const { zg } = await loadField(CEERS);
      const src = await fetchObject(CEERS, id, zg);
      // Ignore a stale result if the user clicked another marker meanwhile.
      setPanel(prev => {
        if (prev.kind === "hidden" || prev.id !== id) return prev;
        return src ? { kind: "found", id, src } : { kind: "notfound", id };
      });
    } catch {
      setPanel(prev => (prev.kind !== "hidden" && prev.id === id ? { kind: "notfound", id } : prev));
    }
  }

  const panelOpen = panel.kind !== "hidden";

  // Memoized so re-renders (panel open/close) never remount the WebGL viewer.
  const viewer = useMemo(
    () => <MapViewer configUrl={configUrl} onSourceClick={openSource} />,
    [configUrl]
  );

  return (
    <main style={{ height: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }}>
      {/* Header strip */}
      <div style={{ padding: "1rem 1.5rem 0.75rem", borderBottom: "1px solid var(--border)" }}>
        <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "2px" }}>
          Explore — CEERS
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Interactive NIRCam color map. Pan and zoom the mosaic; click a source marker to open its SED and P(z).
        </p>
      </div>

      {/* Viewer + side panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative", background: "#0d0a1a" }}>
          {viewer}
        </div>

        {/* Source card side panel — slides in over the map's right edge. */}
        {panelOpen && (
          <aside style={{
            width: "min(520px, 92vw)",
            flexShrink: 0,
            borderLeft: "1px solid var(--border)",
            background: "var(--bg)",
            overflowY: "auto",
            position: "absolute", right: 0, top: 0, bottom: 0,
            boxShadow: "-12px 0 40px rgba(0,0,0,0.45)",
            zIndex: 20,
          }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)",
              position: "sticky", top: 0, background: "var(--bg)", zIndex: 1,
            }}>
              <span className="mono" style={{ fontSize: "0.8rem", color: "var(--accent)", letterSpacing: "0.06em" }}>
                CEERS · ID {panel.id}
              </span>
              <button
                onClick={() => setPanel({ kind: "hidden" })}
                aria-label="Close"
                style={{
                  background: "none", border: "1px solid var(--border-bright)", borderRadius: "5px",
                  color: "var(--text-muted)", cursor: "pointer", fontSize: "0.9rem",
                  lineHeight: 1, padding: "5px 10px",
                }}
              >
                ✕ Close
              </button>
            </div>

            <div style={{ padding: "1rem" }}>
              {panel.kind === "loading" && (
                <div style={{ padding: "2.5rem 1rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.85rem" }}>
                  Loading source {panel.id}…
                </div>
              )}
              {panel.kind === "notfound" && (
                <div className="card" style={{
                  padding: "1.25rem", borderLeft: "3px solid var(--amber)",
                  background: "rgba(240,192,112,0.05)", color: "var(--text-muted)", fontSize: "0.85rem",
                }}>
                  <span className="mono" style={{ color: "var(--amber)", marginRight: "10px", fontSize: "0.75rem" }}>NO CARD</span>
                  No object card is available for CEERS ID {panel.id}. (Per-object cards are served from Corral;
                  when previewing a local tile server with <code>?data=</code>, cards may be unavailable.)
                </div>
              )}
              {panel.kind === "found" && <ResultCard src={panel.src} />}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
