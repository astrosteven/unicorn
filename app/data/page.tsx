"use client";

const FIELDS = [
  { name: "CEERS",         version: "0.98", sources: "174,454", color: "#b07cc6", available: true  },
  { name: "GOODS-S",       version: "0.95", sources: "343,147", color: "#6b51a3", available: true  },
  { name: "GOODS-N",       version: "0.95", sources: "223,092", color: "#4a3a8a", available: true  },
  { name: "A2744",         version: "0.98", sources: "107,015", color: "#ffb3d9", available: true  },
  { name: "NGDEEP",        version: "0.95", sources: "29,955",  color: "#ef9fcd", available: true  },
  { name: "PRIMER-COSMOS", version: "0.95", sources: "413,936", color: "#d48ec9", available: true  },
  { name: "PRIMER-UDS",    version: "0.95", sources: "366,679", color: "#b07cc6", available: false },
  { name: "COSMOS",        version: "0.95", sources: "—", color: "#b07cc6", available: false },
  { name: "EGS",           version: "0.98", sources: "—", color: "#8e6bb8", available: false },
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
                {field.available ? `v${field.version}` : "coming soon"}
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
          Six fields — CEERS, GOODS-S, GOODS-N, A2744, NGDEEP, and PRIMER-COSMOS — are now live and searchable via the{" "}
          <span className="mono" style={{ color: "var(--accent)" }}>Query</span> page.
          The remaining fields are being prepared — check back for downloadable catalogs, field maps, and object pages.
        </p>
      </div>

    </main>
  );
}
