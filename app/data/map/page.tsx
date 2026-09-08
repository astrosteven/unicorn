"use client";
// Explore — an interactive fitsgl WebGL color map of CEERS. Pan/zoom the NIRCam
// RGB mosaic; every catalog source is a clickable Kron-ellipse (or colored circle)
// overlay — GREEN if selected, YELLOW if not — that opens the SAME SED / P(z)
// ResultCard used by the Search page (shared app/data/_card module). A sidebar
// filters the shown set live (selected-only, redshift range, magnitude range).
//
// The WebGL viewer (window + WebGL2) is loaded client-only via next/dynamic with
// { ssr: false }, as required by this Next 16 static export (output: "export").
import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import {
  SEARCH_FIELDS,
  loadField,
  fetchObject,
  ResultCard,
  type SourceResult,
} from "@/app/data/_card/objectCard";
import { type MapFilters, DEFAULT_FILTERS } from "./MapViewer";

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

// Bands offered in the magnitude-filter dropdown. F277W/F444W come straight from the
// base index; the rest resolve from the lazy per-band filters file on demand.
const MAG_BANDS = [
  "F277W", "F444W", "F090W", "F115W", "F150W", "F200W", "F356W", "F410M",
];

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
  const [configUrl] = useState<string>(() => `${tileBase()}/fitsgl.json`);
  const [panel, setPanel] = useState<PanelState>({ kind: "hidden" });
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [shown, setShown] = useState<number | null>(null);

  const openSource = useCallback(async (id: number) => {
    setPanel({ kind: "loading", id });
    try {
      const { zg } = await loadField(CEERS);
      const src = await fetchObject(CEERS, id, zg);
      setPanel(prev => {
        if (prev.kind === "hidden" || prev.id !== id) return prev;
        return src ? { kind: "found", id, src } : { kind: "notfound", id };
      });
    } catch {
      setPanel(prev => (prev.kind !== "hidden" && prev.id === id ? { kind: "notfound", id } : prev));
    }
  }, []);

  const panelOpen = panel.kind !== "hidden";

  return (
    <main style={{ height: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }}>
      {/* Header strip */}
      <div style={{ padding: "1rem 1.5rem 0.75rem", borderBottom: "1px solid var(--border)" }}>
        <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "2px" }}>
          Explore — CEERS
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Interactive NIRCam color map. Pan and zoom the mosaic; click a source (green = selected,
          yellow = not) to open its SED and P(z). Filter the shown set at left.
        </p>
      </div>

      {/* Sidebar + viewer + card panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        <FilterSidebar filters={filters} setFilters={setFilters} shown={shown} />

        <div style={{ flex: 1, minWidth: 0, position: "relative", background: "#0d0a1a" }}>
          <MapViewer
            configUrl={configUrl}
            filters={filters}
            onSourceClick={openSource}
            onCount={setShown}
          />
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

// ---- Filter sidebar --------------------------------------------------------
function FilterSidebar({
  filters, setFilters, shown,
}: {
  filters: MapFilters;
  setFilters: React.Dispatch<React.SetStateAction<MapFilters>>;
  shown: number | null;
}) {
  const num = (s: string): number | null => (s.trim() === "" ? null : (Number.isFinite(+s) ? +s : null));
  const patch = (p: Partial<MapFilters>) => setFilters(f => ({ ...f, ...p }));

  const labelStyle: React.CSSProperties = { fontSize: "0.68rem", color: "var(--text-dim)", letterSpacing: "0.04em", marginBottom: "4px", textTransform: "uppercase" };
  const inputStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
    color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem", padding: "6px 8px",
  };

  return (
    <aside style={{
      width: "220px", flexShrink: 0, borderRight: "1px solid var(--border)",
      background: "var(--bg)", overflowY: "auto", padding: "1rem 0.9rem",
    }}>
      <div className="mono" style={{ fontSize: "0.72rem", color: "var(--accent)", letterSpacing: "0.08em", marginBottom: "1rem" }}>
        FILTERS
      </div>

      {/* Selected toggle */}
      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", marginBottom: "1.1rem" }}>
        <input
          type="checkbox"
          checked={filters.selectedOnly}
          onChange={e => patch({ selectedOnly: e.target.checked })}
          style={{ accentColor: "#43d17a", width: "15px", height: "15px" }}
        />
        <span style={{ fontSize: "0.8rem", color: "var(--text)" }}>Selected only</span>
      </label>

      {/* Redshift range */}
      <div style={{ marginBottom: "1.1rem" }}>
        <div style={labelStyle}>Redshift z_a</div>
        <div style={{ display: "flex", gap: "6px" }}>
          <input style={inputStyle} inputMode="decimal" placeholder="min"
            defaultValue={filters.zMin ?? ""} onBlur={e => patch({ zMin: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ zMin: num((e.target as HTMLInputElement).value) }); }} />
          <input style={inputStyle} inputMode="decimal" placeholder="max"
            defaultValue={filters.zMax ?? ""} onBlur={e => patch({ zMax: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ zMax: num((e.target as HTMLInputElement).value) }); }} />
        </div>
      </div>

      {/* Magnitude range + band dropdown */}
      <div style={{ marginBottom: "1.1rem" }}>
        <div style={labelStyle}>Magnitude (AB)</div>
        <select
          value={filters.magFilter}
          onChange={e => patch({ magFilter: e.target.value })}
          style={{ ...inputStyle, marginBottom: "6px", cursor: "pointer" }}
        >
          {MAG_BANDS.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <div style={{ display: "flex", gap: "6px" }}>
          <input style={inputStyle} inputMode="decimal" placeholder="min"
            defaultValue={filters.magMin ?? ""} onBlur={e => patch({ magMin: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ magMin: num((e.target as HTMLInputElement).value) }); }} />
          <input style={inputStyle} inputMode="decimal" placeholder="max"
            defaultValue={filters.magMax ?? ""} onBlur={e => patch({ magMax: num(e.target.value) })}
            onKeyDown={e => { if (e.key === "Enter") patch({ magMax: num((e.target as HTMLInputElement).value) }); }} />
        </div>
      </div>

      <button
        onClick={() => setFilters(DEFAULT_FILTERS)}
        className="mono"
        style={{
          background: "none", border: "1px solid var(--border-bright)", borderRadius: "5px",
          color: "var(--text-muted)", cursor: "pointer", fontSize: "0.72rem", padding: "6px 10px", width: "100%",
        }}
      >
        Reset
      </button>

      {/* Legend + count */}
      <div style={{ marginTop: "1.4rem", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid #43d17a", display: "inline-block" }} />
          selected
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
          <span style={{ width: "11px", height: "11px", borderRadius: "50%", border: "2px solid #f2d43a", display: "inline-block" }} />
          not selected
        </div>
        {shown != null && (
          <div className="mono" style={{ marginTop: "10px", color: "var(--text-dim)" }}>
            {shown.toLocaleString()} shown
          </div>
        )}
      </div>
    </aside>
  );
}
