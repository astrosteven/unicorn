"use client";
import { useState, useEffect } from "react";

const BASE_URL = "https://web.corral.tacc.utexas.edu/unicorn/Catalogs";  // public Corral HTTPS root (catalog data)

// Photo-z variants. The FITS filename is identical in every variant dir
// (<prefix>_photz_v<ver>.fits); only the Corral SUBDIRECTORY changes.
const PZ_VARIANTS = [
  { key: "fiducial", label: "Photo-z — Fiducial",  dir: "Photoz",         desc: "Fiducial photometric redshifts (LAZY, SFHZ + Larson22 templates)" },
  { key: "eelg",     label: "Photo-z — EELG",      dir: "Photoz_eelg",    desc: "Photo-z with extreme-emission-line-galaxy template set" },
  { key: "circles",  label: "Photo-z — Circles",   dir: "Photoz_Circles", desc: "Photo-z using circular-aperture photometry" },
  { key: "bbonly",   label: "Photo-z — Broadband", dir: "Photoz_BBonly",  desc: "Photo-z using broad-band filters only (medium bands excluded)" },
  { key: "wfc3",     label: "Photo-z — WFC3",      dir: "Photoz_WFC3",    desc: "Photo-z including HST WFC3 aperture photometry" },
];
// Per-field photo-z variant sets (verified against the public Corral tree — every
// field has fiducial/eelg/circles; bbonly + wfc3 vary by field).
const ALL_PZ    = ["fiducial", "eelg", "circles", "bbonly", "wfc3"];  // CEERS, EGS
const WFC3_NOBB = ["fiducial", "eelg", "circles", "wfc3"];            // GOODS-S
const NO_WFC3   = ["fiducial", "eelg", "circles", "bbonly"];          // PRIMER-UDS, A2744
const BASE_PZ   = ["fiducial", "eelg", "circles"];                    // GOODS-N, NGDEEP, PRIMER-COSMOS, COSMOS

type Field = {
  id: string;
  name: string;
  dir: string;         // Corral subdirectory
  prefix: string;      // filename prefix
  version: string;     // per-field release version
  available: boolean;  // true once files are live on Corral
  variants: string[];  // PZ_VARIANTS keys present for this field
  programs?: string[]; // JWST programs whose imaging is included
};

// All nine fields are live on the public Corral tree (unicorn/Catalogs/<DIR>/).
const FIELDS: Field[] = [
  { id: "ceers",         name: "CEERS",         dir: "CEERS",         prefix: "ceers",        version: "0.98", available: true, variants: ALL_PZ, programs: ["CEERS", "SPAM", "MINERVA", "CAPERS"] },
  { id: "egs",           name: "EGS",           dir: "EGS",           prefix: "egs",          version: "0.98", available: true, variants: ALL_PZ, programs: ["CEERS", "SPAM", "MINERVA", "CAPERS"] },
  { id: "goods-s",       name: "GOODS-S",       dir: "GOODSS",        prefix: "goodss",       version: "0.95", available: true, variants: WFC3_NOBB },
  { id: "goods-n",       name: "GOODS-N",       dir: "GOODSN",        prefix: "goodsn",       version: "0.95", available: true, variants: BASE_PZ },
  { id: "primer-cosmos", name: "PRIMER-COSMOS", dir: "PRIMER-COSMOS", prefix: "primercosmos", version: "0.95", available: true, variants: BASE_PZ },
  { id: "primer-uds",    name: "PRIMER-UDS",    dir: "PRIMER-UDS",    prefix: "primeruds",    version: "0.95", available: true, variants: NO_WFC3 },
  { id: "ngdeep",        name: "NGDEEP",        dir: "NGDEEP",        prefix: "ngdeep",       version: "0.95", available: true, variants: BASE_PZ },
  { id: "a2744",         name: "A2744",         dir: "A2744",         prefix: "a2744",        version: "0.98", available: true, variants: NO_WFC3 },
  { id: "cosmos",        name: "COSMOS",        dir: "COSMOS",        prefix: "cosmos",       version: "0.95", available: true, variants: BASE_PZ },
];

// Real file sizes for the live CEERS v0.98 release, keyed by row key.
const CEERS_SIZES: Record<string, string> = {
  readme: "24 KB",
  photom: "2.4 GB",
  selected: "4.7 MB",
  detflags: "5.3 MB",
  selflags: "21 MB",
  segmap: "13 MB",
  psfs: "2.0 MB",
  depths: "4 KB",
  area: "4 KB",
  completeness: "32 KB",
  pz_fiducial: "2.6 GB",
  pz_eelg: "2.6 GB",
  pz_circles: "2.6 GB",
  pz_bbonly: "2.6 GB",
  pz_wfc3: "2.6 GB",
};

// Project-wide files. Templates currently live inside the CEERS-SPAM directory on
// Corral (unversioned filenames); repoint if a shared location is created later.
const PROJECT_FILES = [
  {
    label: "Tutorial Notebook",
    desc: "Jupyter notebook: reading catalogs, plotting photometry, SED reconstruction, P(z)",
    href: `/unicorn/unicorn_example.ipynb`,
    size: "~36 KB",
  },
  {
    label: "Templates — Fiducial",
    desc: "LAZY SED template library used for fiducial photo-z fits",
    href: `${BASE_URL}/CEERS/unicorn_templates_fiducial.fits`,
    size: "1.2 GB",
  },
  {
    label: "Templates — EELG",
    desc: "LAZY SED template library for the EELG photo-z variant",
    href: `${BASE_URL}/CEERS/unicorn_templates_eelg.fits`,
    size: "1.3 GB",
  },
  {
    label: "Templates — LRD",
    desc: "LAZY SED template library for the LRD photo-z variant",
    href: `${BASE_URL}/CEERS/unicorn_templates_lrd.fits`,
    size: "1.4 GB",
  },
];

type FileRow = {
  label: string;
  desc: string;
  file: string;      // display filename
  href: string;      // download URL (only used when the field is available)
  size: string;
  ext?: number;      // number of FITS extensions, if applicable
};

function fieldFiles(field: Field): FileRow[] {
  const { dir, prefix: f, available } = field;
  const v = field.version;
  const base = `${BASE_URL}/${dir}`;
  // Real byte sizes are only tabulated for CEERS; other fields show "—" (file still downloads).
  const size = (key: string) => (available && field.id === "ceers" ? CEERS_SIZES[key] ?? "—" : "—");

  // COSMOS is the no-VIS release (the site serves the no-VIS solution): selected/flags carry
  // the _novis suffix and the photo-z variants live in Photoz*_novis dirs. Segmap/PSFs/depths
  // aren't on the public tree for COSMOS, so they're omitted.
  if (field.id === "cosmos") {
    return [
      { label: "README", desc: "Column descriptions, data model, selection criteria", file: `${f}_unicorn.readme`, href: `${base}/${f}_unicorn.readme`, size: "—" },
      { label: "Photometry", desc: "Source positions, morphology, fluxes in all filters (Kron + circular apertures; ext 2 = aperture diameters)", file: `${f}_photom_v${v}.fits`, href: `${base}/${f}_photom_v${v}.fits`, size: "—", ext: 2 },
      { label: "Photo-z — Fiducial (no-VIS)", desc: "Fiducial photo-z, Euclid VIS excluded (the COSMOS default)", file: `Photoz_novis/${f}_photz_v${v}.fits`, href: `${base}/Photoz_novis/${f}_photz_v${v}.fits`, size: "—", ext: 4 },
      { label: "Photo-z — EELG (no-VIS)", desc: "EELG template set, no-VIS", file: `Photoz_eelg_novis/${f}_photz_v${v}.fits`, href: `${base}/Photoz_eelg_novis/${f}_photz_v${v}.fits`, size: "—", ext: 4 },
      { label: "Photo-z — Circles (no-VIS)", desc: "Circular-aperture photometry, no-VIS", file: `Photoz_Circles_Novis/${f}_photz_v${v}.fits`, href: `${base}/Photoz_Circles_Novis/${f}_photz_v${v}.fits`, size: "—", ext: 4 },
      { label: "Selected Sample", desc: "High-confidence galaxy sample with inspection flags and redshift assignments", file: `${f}_selected_v${v}_novis.fits`, href: `${base}/${f}_selected_v${v}_novis.fits`, size: "—", ext: 1 },
      { label: "Detection Flags", desc: "Per-source detection criteria (SNR, Lyman-break, error-map, edge)", file: `Flags/${f}_detectionflags_v${v}_novis.fits`, href: `${base}/Flags/${f}_detectionflags_v${v}_novis.fits`, size: "—", ext: 1 },
      { label: "Selection Flags", desc: "Per-source photo-z selection criteria (int P(z), za, chi², dchi², sample)", file: `Flags/${f}_selectionflags_v${v}_novis.fits`, href: `${base}/Flags/${f}_selectionflags_v${v}_novis.fits`, size: "—", ext: 1 },
    ];
  }

  const files: FileRow[] = [
    {
      label: "README",
      desc: "Column descriptions, data model, selection criteria, and version history",
      file: `${f}_unicorn.readme`,
      href: `${base}/${f}_unicorn.readme`,
      size: size("readme"),
    },
    {
      label: "Photometry",
      desc: "Source positions, morphology, fluxes in all filters (Kron + 12 circular apertures; ext 2 lists aperture diameters)",
      file: `${f}_photom_v${v}.fits`,
      href: `${base}/${f}_photom_v${v}.fits`,
      size: size("photom"),
      ext: 2,
    },
  ];

  for (const key of field.variants) {
    const variant = PZ_VARIANTS.find(pv => pv.key === key)!;
    files.push({
      label: variant.label,
      desc: variant.desc,
      file: `${variant.dir}/${f}_photz_v${v}.fits`,
      href: `${base}/${variant.dir}/${f}_photz_v${v}.fits`,
      size: size(`pz_${key}`),
      ext: 4,
    });
  }

  files.push(
    {
      label: "Selected Sample",
      desc: "High-confidence galaxy sample with inspection flags and redshift assignments",
      file: `${f}_selected_v${v}.fits`,
      href: `${base}/${f}_selected_v${v}.fits`,
      size: size("selected"),
      ext: 1,
    },
    {
      label: "Detection Flags",
      desc: "Per-source detection criteria (SNR, Lyman-break, error-map, edge)",
      file: `Flags/${f}_detectionflags_v${v}.fits`,
      href: `${base}/Flags/${f}_detectionflags_v${v}.fits`,
      size: size("detflags"),
      ext: 1,
    },
    {
      label: "Selection Flags",
      desc: "Per-source photo-z selection criteria (int P(z), za, chi², dchi², sample)",
      file: `Flags/${f}_selectionflags_v${v}.fits`,
      href: `${base}/Flags/${f}_selectionflags_v${v}.fits`,
      size: size("selflags"),
      ext: 1,
    },
    {
      label: "Segmentation Map",
      desc: "Source-Extractor segmentation map (gzipped FITS image)",
      file: `segmap_${f}_v${v}.fits.gz`,
      href: `${base}/segmap_${f}_v${v}.fits.gz`,
      size: size("segmap"),
    },
    {
      label: "PSFs",
      desc: "Empirical point-spread functions per filter (tar.gz)",
      file: `${f}_psfs_v${v}.tar.gz`,
      href: `${base}/${f}_psfs_v${v}.tar.gz`,
      size: size("psfs"),
    },
    {
      label: "5σ Depths",
      desc: "Per-filter 5σ point-source depths",
      file: `${f}_5sig-depths_v${v}.txt`,
      href: `${base}/${f}_5sig-depths_v${v}.txt`,
      size: size("depths"),
    },
    {
      label: "Survey Area",
      desc: "Effective survey area per filter (arcmin²)",
      file: `${f}_area.txt`,
      href: `${base}/${f}_area.txt`,
      size: size("area"),
    },
    {
      label: "Completeness",
      desc: "Point-source completeness vs. magnitude, per depth tier",
      file: `${f}_pointsource_completeness_v${v}.txt`,
      href: `${base}/${f}_pointsource_completeness_v${v}.txt`,
      size: size("completeness"),
    },
  );
  return files;
}

function DownloadButton({ href, available }: { href: string; available: boolean }) {
  if (!available) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          background: "transparent",
          color: "var(--text-dim)",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          padding: "5px 12px",
          fontSize: "0.75rem",
          fontFamily: "'Space Mono', monospace",
          whiteSpace: "nowrap",
        }}
      >
        soon
      </span>
    );
  }
  return (
    <a
      href={href}
      download
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        background: "var(--accent-dim)",
        color: "var(--accent)",
        border: "1px solid rgba(196,144,216,0.3)",
        borderRadius: "4px",
        padding: "5px 12px",
        fontSize: "0.75rem",
        fontFamily: "'Space Mono', monospace",
        textDecoration: "none",
        whiteSpace: "nowrap",
        transition: "background 0.15s",
      }}
    >
      ↓ Download
    </a>
  );
}

export default function CatalogsPage() {
  const [openField, setOpenField] = useState<string | null>("ceers");

  // Deep-link from the overview field cards: /data/catalogs?field=<id> opens that field.
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get("field");
    if (f && FIELDS.some(x => x.id === f)) setOpenField(f);
  }, []);

  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "960px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "6px" }}>
          Catalogs
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", maxWidth: "640px" }}>
          All UNICORN data products are FITS binary tables with embedded column descriptions
          and units (per-field versions <span className="mono" style={{ color: "var(--accent)" }}>v0.95–v0.98</span>).
          See the README for full documentation.
        </p>
      </div>

      {/* Citation notice */}
      <div className="card" style={{
        padding: "1rem 1.25rem",
        marginBottom: "2.5rem",
        borderLeft: "3px solid var(--accent)",
        background: "var(--accent-dim)",
        fontSize: "0.85rem",
        color: "var(--text-muted)",
      }}>
        <span style={{ color: "var(--accent)", fontFamily: "'Space Mono', monospace", fontSize: "0.75rem" }}>
          CITATION
        </span>
        <span style={{ marginLeft: "12px" }}>
          If you use UNICORN data products, please cite{" "}
          <span style={{ color: "var(--text)" }}>Finkelstein et al. (in prep)</span>.
        </span>
      </div>

      {/* Project-wide files */}
      <section style={{ marginBottom: "3rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "1rem" }}>
          <div style={{ width: "24px", height: "1px", background: "var(--accent2)" }} />
          <span className="mono" style={{ color: "var(--accent2)", fontSize: "0.72rem", letterSpacing: "0.15em" }}>
            PROJECT-WIDE FILES
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {PROJECT_FILES.map(f => (
            <div key={f.href} className="card" style={{
              padding: "0.9rem 1.25rem",
              display: "grid",
              gridTemplateColumns: "180px 1fr auto",
              alignItems: "center",
              gap: "1rem",
            }}>
              <span className="mono" style={{ fontSize: "0.82rem", color: "var(--accent)", fontWeight: 700 }}>
                {f.label}
              </span>
              <span style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                {f.desc}
              </span>
              <DownloadButton href={f.href} available={true} />
            </div>
          ))}
        </div>
      </section>

      {/* Per-field files */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "1.5rem" }}>
          <div style={{ width: "24px", height: "1px", background: "var(--accent2)" }} />
          <span className="mono" style={{ color: "var(--accent2)", fontSize: "0.72rem", letterSpacing: "0.15em" }}>
            PER-FIELD CATALOGS
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {FIELDS.map(field => {
            const isOpen = openField === field.id;
            const files = fieldFiles(field);
            return (
              <div key={field.id} className="card" style={{
                overflow: "hidden",
                borderColor: isOpen ? "var(--border-bright)" : "var(--border)",
                transition: "border-color 0.15s",
              }}>
                {/* Field header — click to expand */}
                <button
                  onClick={() => setOpenField(isOpen ? null : field.id)}
                  style={{
                    width: "100%",
                    background: isOpen ? "rgba(196,144,216,0.06)" : "transparent",
                    border: "none",
                    padding: "1rem 1.25rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                    <span className="mono" style={{
                      fontSize: "1rem",
                      fontWeight: 700,
                      color: isOpen ? "var(--accent)" : "var(--text)",
                    }}>
                      {field.name}
                    </span>
                    <span style={{
                      fontSize: "0.72rem",
                      color: "var(--text-muted)",
                      fontFamily: "'Space Mono', monospace",
                    }}>
                      {files.length} files
                    </span>
                    <span className="mono" style={{
                      fontSize: "0.62rem",
                      letterSpacing: "0.08em",
                      padding: "2px 8px",
                      borderRadius: "999px",
                      color: field.available ? "var(--accent)" : "var(--text-dim)",
                      background: field.available ? "var(--accent-dim)" : "transparent",
                      border: `1px solid ${field.available ? "rgba(196,144,216,0.3)" : "var(--border)"}`,
                    }}>
                      {field.available ? `v${field.version}` : "COMING SOON"}
                    </span>
                  </div>
                  <span style={{
                    color: "var(--text-dim)",
                    fontSize: "0.85rem",
                    transition: "transform 0.2s",
                    display: "inline-block",
                    transform: isOpen ? "rotate(180deg)" : "none",
                  }}>
                    ▾
                  </span>
                </button>

                {/* File list */}
                {isOpen && (
                  <div style={{
                    borderTop: "1px solid var(--border)",
                    padding: "0.5rem 0",
                  }}>
                    {field.programs && field.programs.length > 0 && (
                      <div style={{
                        display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px",
                        padding: "0.6rem 1.25rem 0.8rem",
                        borderBottom: "1px solid var(--border)",
                      }}>
                        <span className="mono" style={{ fontSize: "0.68rem", color: "var(--text-dim)", letterSpacing: "0.1em" }}>
                          PROGRAMS INCLUDED
                        </span>
                        {field.programs.map(p => (
                          <span key={p} className="mono" style={{
                            fontSize: "0.72rem", padding: "2px 9px", borderRadius: "999px",
                            background: "var(--accent-dim)", color: "var(--accent)",
                            border: "1px solid rgba(196,144,216,0.25)",
                          }}>
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                    {files.map((f, idx) => (
                      <div key={f.file} style={{
                        padding: "0.7rem 1.25rem",
                        display: "grid",
                        gridTemplateColumns: "200px 1fr 80px auto",
                        alignItems: "center",
                        gap: "1rem",
                        borderBottom: idx < files.length - 1 ? "1px solid var(--border)" : "none",
                        background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                      }}>
                        <span className="mono" style={{ fontSize: "0.82rem", color: "var(--accent-bright)", fontWeight: 700 }}>
                          {f.label}
                        </span>
                        <div>
                          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                            {f.desc}
                          </div>
                          <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: "2px" }}>
                            {f.file}
                            {f.ext && <span style={{ color: "var(--accent-dim)", marginLeft: "8px" }}>{f.ext} ext</span>}
                          </div>
                        </div>
                        <span className="mono" style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                          {f.size}
                        </span>
                        <DownloadButton href={f.href} available={field.available} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* FITS structure note */}
      <div className="card" style={{
        marginTop: "3rem",
        padding: "1.25rem",
        borderLeft: "3px solid var(--purple)",
        background: "rgba(142,107,184,0.05)",
      }}>
        <p className="mono" style={{ fontSize: "0.75rem", color: "var(--accent)", marginBottom: "8px", letterSpacing: "0.08em" }}>
          PHOTO-Z FILE STRUCTURE
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "4px 16px", fontSize: "0.82rem", color: "var(--text-muted)" }}>
          {[
            ["Ext 1", "Single-value quantities: ZA, ZM, confidence intervals, integrated P(z), COEFFS"],
            ["Ext 2", "Best-fit model fluxes per filter (nJy) from Lazy.jl at z_a"],
            ["Ext 3", "Full P(z): ZGRID (1751 pts), PZ, CHI2"],
            ["Ext 4", "Low-z P(z): ZGRID_LOWZ (351 pts, z<7), PZ_LOWZ"],
          ].map(([ext, desc]) => (
            <>
              <span key={ext} className="mono" style={{ color: "var(--lavender)", fontWeight: 700 }}>{ext}</span>
              <span key={desc}>{desc}</span>
            </>
          ))}
        </div>
      </div>

    </main>
  );
}
