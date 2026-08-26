"use client";

const VERSION = "0.97";

const FIELDS = [
  { name: "CEERS-SPAM",    sources: "—", color: "#b07cc6", available: true  },
  { name: "CEERS-EGS",     sources: "—", color: "#8e6bb8", available: false },
  { name: "PRIMER-UDS",    sources: "—", color: "#b07cc6", available: false },
  { name: "PRIMER-COSMOS", sources: "—", color: "#d48ec9", available: false },
  { name: "GOODS-S",       sources: "—", color: "#6b51a3", available: false },
  { name: "GOODS-N",       sources: "—", color: "#4a3a8a", available: false },
  { name: "NGDEEP",        sources: "—", color: "#ef9fcd", available: false },
  { name: "Abell 2744",    sources: "—", color: "#ffb3d9", available: false },
  { name: "COSMOS",        sources: "—", color: "#b07cc6", available: false },
];

export default function DataOverview() {
  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "920px", margin: "0 auto" }}>

      <div style={{ marginBottom: "3rem" }}>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "8px" }}>
          Data Overview
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
          Welcome. Select a field or use the navigation above to access catalogs and data products.
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: "10px",
        marginBottom: "3rem",
      }}>
        {FIELDS.map(field => (
          <div key={field.name} className="card" style={{
            padding: "1.25rem 1.5rem",
            borderLeft: `3px solid ${field.color}`,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
              <span className="mono" style={{ fontSize: "0.88rem", fontWeight: 700, color: field.color }}>
                {field.name}
              </span>
              <span style={{
                fontSize: "0.62rem",
                fontFamily: "'Space Mono', monospace",
                color: field.available ? "var(--accent)" : "var(--amber)",
                background: field.available ? "var(--accent-dim)" : "rgba(240,192,112,0.1)",
                border: `1px solid ${field.available ? "rgba(196,144,216,0.3)" : "rgba(240,192,112,0.2)"}`,
                borderRadius: "3px",
                padding: "2px 6px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
              }}>
                {field.available ? `v${VERSION}` : "coming soon"}
              </span>
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Sources: <span className="mono" style={{ color: "var(--text)" }}>{field.sources}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{
        padding: "1.5rem",
        borderLeft: "3px solid var(--purple)",
        background: "rgba(142,107,184,0.05)",
      }}>
        <p className="mono" style={{ fontSize: "0.75rem", color: "var(--accent)", marginBottom: "5px", letterSpacing: "0.08em" }}>
          FIRST DATA RELEASE
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
          CEERS-SPAM (v{VERSION}) catalogs are now available on the{" "}
          <span className="mono" style={{ color: "var(--accent)" }}>Catalogs</span> page.
          The remaining fields are being prepared — check back for downloadable catalogs, field maps, and object pages.
        </p>
      </div>

    </main>
  );
}
