"use client";
import { useState } from "react";
import AladinViewer from "./AladinViewer";

const FIELDS = [
  {
    id: "ceers",
    name: "CEERS-EGS",
    full: "Cosmic Evolution Early Release Science — Extended Groth Strip",
    ra: 214.825,
    dec: 52.825,
    fov: 0.25,
    area: "~100 arcmin²",
    imaging: "JWST NIRCam + HST ACS/WFC3",
    filters: ["F435W","F606W","F814W","F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W","F470N"],
    program: "CEERS (ERS 1345)",
    notes: "Custom UNICORN reduction",
  },
  {
    id: "goods-s",
    name: "GOODS-S",
    full: "Great Observatories Origins Deep Survey South",
    ra: 53.122,
    dec: -27.805,
    fov: 0.20,
    area: "~170 arcmin²",
    imaging: "JWST NIRCam + HST ACS/WFC3",
    filters: ["F435W","F606W","F775W","F814W","F850LP","F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W"],
    program: "JADES (GO 1180, 1210)",
    notes: "Uses JADES DR5 imaging",
  },
  {
    id: "goods-n",
    name: "GOODS-N",
    full: "Great Observatories Origins Deep Survey North",
    ra: 189.228,
    dec: 62.238,
    fov: 0.20,
    area: "~170 arcmin²",
    imaging: "JWST NIRCam + HST ACS/WFC3",
    filters: ["F435W","F606W","F775W","F814W","F850LP","F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W"],
    program: "JADES (GO 1180, 1210)",
    notes: "Uses JADES DR5 imaging",
  },
  {
    id: "primer-cosmos",
    name: "PRIMER-COSMOS",
    full: "Public Release IMaging for Extragalactic Research — COSMOS",
    ra: 150.119,
    dec: 2.206,
    fov: 0.30,
    area: "~200 arcmin²",
    imaging: "JWST NIRCam",
    filters: ["F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W"],
    program: "PRIMER (GO 1837)",
    notes: "Custom UNICORN reduction",
  },
  {
    id: "primer-uds",
    name: "PRIMER-UDS",
    full: "Public Release IMaging for Extragalactic Research — Ultra Deep Survey",
    ra: 34.406,
    dec: -5.189,
    fov: 0.30,
    area: "~200 arcmin²",
    imaging: "JWST NIRCam",
    filters: ["F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W"],
    program: "PRIMER (GO 1837)",
    notes: "Custom UNICORN reduction",
  },
  {
    id: "ngdeep",
    name: "NGDEEP",
    full: "Next Generation Deep Extragalactic Exploratory Public Survey",
    ra: 53.160,
    dec: -27.784,
    fov: 0.10,
    area: "~10 arcmin²",
    imaging: "JWST NIRCam",
    filters: ["F115W","F150W","F200W","F277W","F356W","F444W"],
    program: "NGDEEP (GO 2079)",
    notes: "Custom UNICORN reduction",
  },
  {
    id: "a2744",
    name: "Abell 2744",
    full: "Abell 2744 Galaxy Cluster",
    ra: 3.588,
    dec: -30.400,
    fov: 0.15,
    area: "~45 arcmin²",
    imaging: "JWST NIRCam",
    filters: ["F090W","F115W","F150W","F200W","F277W","F356W","F410M","F444W"],
    program: "UNCOVER (GO 2561)",
    notes: "Custom UNICORN reduction",
  },
  {
    id: "cosmos",
    name: "COSMOS",
    full: "Cosmic Evolution Survey",
    ra: 150.119,
    dec: 2.206,
    fov: 0.35,
    area: "~230 arcmin²",
    imaging: "JWST NIRCam",
    filters: ["F115W","F150W","F200W","F277W","F356W","F444W"],
    program: "COSMOS-Web (GO 1727)",
    notes: "Custom UNICORN reduction",
  },
];

// Accent colors cycling through the UNICORN palette
const FIELD_COLORS = [
  "#8e6bb8","#b07cc6","#d48ec9","#6b51a3",
  "#4a3a8a","#ef9fcd","#ffb3d9","#b07cc6",
];

export default function FieldsPage() {
  const [selected, setSelected] = useState(FIELDS[0].id);
  const field = FIELDS.find(f => f.id === selected)!;

  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "1100px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 className="mono" style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", marginBottom: "6px" }}>
          Survey Fields
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem" }}>
          UNICORN covers 8 legacy JWST fields. Select a field to view its sky coverage and properties.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "1.5rem", alignItems: "start" }}>

        {/* Field list */}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {FIELDS.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setSelected(f.id)}
              style={{
                background: selected === f.id ? "rgba(176,124,198,0.12)" : "var(--bg-card)",
                border: `1px solid ${selected === f.id ? "var(--border-bright)" : "var(--border)"}`,
                borderLeft: `3px solid ${selected === f.id ? FIELD_COLORS[i] : "transparent"}`,
                borderRadius: "6px",
                padding: "10px 14px",
                textAlign: "left",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <div className="mono" style={{
                fontSize: "0.88rem",
                fontWeight: 700,
                color: selected === f.id ? FIELD_COLORS[i] : "var(--text)",
              }}>
                {f.name}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: "2px" }}>
                {f.area}
              </div>
            </button>
          ))}
        </div>

        {/* Field detail */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

          {/* Sky viewer */}
          <div className="card" style={{ overflow: "hidden", borderRadius: "8px" }}>
            <AladinViewer ra={field.ra} dec={field.dec} fov={field.fov} name={field.name} />
          </div>

          {/* Metadata grid */}
          <div className="card" style={{ padding: "1.25rem" }}>
            <div style={{ marginBottom: "1rem" }}>
              <h2 className="mono" style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--accent)", marginBottom: "4px" }}>
                {field.name}
              </h2>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>{field.full}</p>
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: "12px 24px",
              fontSize: "0.83rem",
            }}>
              {[
                { label: "RA, Dec", value: `${field.ra.toFixed(3)}°, ${field.dec.toFixed(3)}°` },
                { label: "Area", value: field.area },
                { label: "Imaging", value: field.imaging },
                { label: "Program", value: field.program },
                { label: "Reduction", value: field.notes },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", marginBottom: "2px" }}>
                    {item.label.toUpperCase()}
                  </div>
                  <div style={{ color: "var(--text)" }}>{item.value}</div>
                </div>
              ))}
            </div>

            {/* Filter list */}
            <div style={{ marginTop: "1rem" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", letterSpacing: "0.08em", marginBottom: "6px" }}>
                FILTERS
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {field.filters.map(filt => (
                  <span key={filt} className="mono" style={{
                    fontSize: "0.72rem",
                    padding: "2px 8px",
                    borderRadius: "3px",
                    background: "var(--accent-dim)",
                    color: "var(--accent)",
                    border: "1px solid rgba(196,144,216,0.2)",
                  }}>
                    {filt}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
