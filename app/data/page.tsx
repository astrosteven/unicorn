"use client";
import Link from "next/link";

// Canonical field registry — the single source of truth the version-bumps edit.
// `version`/`sources`/`available` are the live per-release values; `provenance`
// (imaging programs, kept in sync with unicorn_field_params.pro readme_provenance),
// `geometry`, and `region` are the static per-field facts. The master README page
// (/data/readme) renders its "Fields in this release" table by importing this array,
// so bumping a version here auto-updates the README on the same deploy.
export type Field = {
  name: string;
  version: string;
  sources: string;
  color: string;
  available: boolean;
  region: string;        // short region / notes blurb
  geometry: "single-tile" | "tiled";
  provenance: string;    // imaging + program list
};

export const FIELDS: Field[] = [
  { name: "CEERS",         version: "0.98", sources: "174,454", color: "#b07cc6", available: true,
    region: "Extended Groth Strip (single-tile UNICORN reduction)", geometry: "single-tile",
    provenance: "JWST NIRCam + HST ACS/WFC3 from CEERS (ERS 1345), MINERVA (GO 7814), SPAM (GO 8559)" },
  { name: "GOODS-S",       version: "0.95", sources: "343,147", color: "#6b51a3", available: true,
    region: "Great Observatories Origins Deep Survey South", geometry: "single-tile",
    provenance: "JWST NIRCam + HST ACS/WFC3 from JADES (GO 1180, 1210); JADES DR5 imaging" },
  { name: "GOODS-N",       version: "0.95", sources: "223,092", color: "#4a3a8a", available: true,
    region: "Great Observatories Origins Deep Survey North", geometry: "single-tile",
    provenance: "JWST NIRCam + HST ACS/WFC3 from JADES (GO 1180, 1210); JADES DR5 imaging" },
  { name: "A2744",         version: "0.98", sources: "107,015", color: "#ffb3d9", available: true,
    region: "Abell 2744 galaxy cluster (VENUS reduction, V. Kokorev)", geometry: "single-tile",
    provenance: "JWST NIRCam from UNCOVER (GO 2561), GLASS (ERS 1324), MegaScience (GO 4111), ALT (GO 3516), DDT (GO 2756)" },
  { name: "NGDEEP",        version: "0.95", sources: "29,955",  color: "#ef9fcd", available: true,
    region: "Next Generation Deep Extragalactic Exploratory Public Survey", geometry: "single-tile",
    provenance: "JWST NIRCam from NGDEEP (GO 2079), MIDIS (GTO 1283); custom UNICORN reduction" },
  { name: "PRIMER-COSMOS", version: "0.95", sources: "413,936", color: "#d48ec9", available: true,
    region: "Public Release IMaging for Extragalactic Research, COSMOS", geometry: "single-tile",
    provenance: "JWST NIRCam from PRIMER (GO 1837), COSMOS-Web (GO 1727), MINERVA (GO 7814), COSMOS-3D (GO 5893)" },
  { name: "PRIMER-UDS",    version: "0.95", sources: "366,679",   color: "#b07cc6", available: true,
    region: "Public Release IMaging for Extragalactic Research, Ultra Deep Survey", geometry: "single-tile",
    provenance: "JWST NIRCam from PRIMER (GO 1837), MINERVA (GO 7814)" },
  { name: "COSMOS",        version: "0.95", sources: "1,466,817", color: "#b07cc6", available: true,
    region: "Cosmic Evolution Survey (merged tiles)", geometry: "tiled",
    provenance: "JWST NIRCam from COSMOS-Web (GO 1727), COSMOS-3D (GO 5893); custom UNICORN reduction" },
  { name: "EGS",           version: "0.98", sources: "264,916",   color: "#8e6bb8", available: true,
    region: "Extended Groth Strip (tiled UNICORN reduction)", geometry: "tiled",
    provenance: "JWST NIRCam + HST ACS/WFC3 from CEERS (ERS 1345), MINERVA (GO 7814), SPAM (GO 8559)" },
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
        {FIELDS.map(field => {
          const inner = (
          <div className="card" style={{
            padding: "1.25rem 1.5rem",
            borderLeft: `3px solid ${field.color}`,
            height: "100%",
            cursor: field.available ? "pointer" : "default",
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
          );
          return field.available ? (
            <Link key={field.name} href={`/data/catalogs?field=${field.name.toLowerCase()}`} style={{ textDecoration: "none" }}>
              {inner}
            </Link>
          ) : (
            <div key={field.name}>{inner}</div>
          );
        })}
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
          All nine fields — CEERS, EGS, GOODS-S, GOODS-N, A2744, NGDEEP, COSMOS, PRIMER-COSMOS, and PRIMER-UDS — are now live and searchable via the{" "}
          <span className="mono" style={{ color: "var(--accent)" }}>Query</span> page.
          The remaining fields are being prepared — check back for downloadable catalogs, field maps, and object pages.
        </p>
      </div>

    </main>
  );
}
