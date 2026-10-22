"use client";
import { useState, useEffect } from "react";

const BASE_URL = "https://web.corral.tacc.utexas.edu/unicorn/Catalogs";  // public Corral HTTPS root (catalog data)
// 2026-09: the pre-AS1063 fields moved under Catalogs/Legacy/; AS1063 (+ future fields) stay at the
// Catalogs/ top level. To REVERT the Corral move, set LEGACY_PARENT = "".
const LEGACY_PARENT = "Legacy/";
// New fields (post-Legacy-move) stay at the top level; add their ids here. (as1063 was here
// but was pulled from the site 2026-09-17 pending fixes.)
const TOP_LEVEL_FIELD_IDS = new Set<string>([]);
const catBase = (field: { id: string; dir: string }) =>
  `${BASE_URL}/${TOP_LEVEL_FIELD_IDS.has(field.id) ? "" : LEGACY_PARENT}${field.dir}`;

// Photo-z variants. The FITS filename is identical in every variant dir
// (<prefix>_photz_v<ver>.fits); only the Corral SUBDIRECTORY changes.
const PZ_VARIANTS = [
  { key: "fiducial", label: "Photo-z — Fiducial",  dir: "Photoz",         desc: "Fiducial photometric redshifts (LAZY, SFHZ + Larson22 templates)" },
  { key: "eelg",     label: "Photo-z — EELG",      dir: "Photoz_eelg",    desc: "Photo-z with extreme-emission-line-galaxy template set" },
  { key: "circles",  label: "Photo-z — Circles",   dir: "Photoz_Circles", desc: "Photo-z using circular-aperture photometry" },
  { key: "bbonly",   label: "Photo-z — Broadband", dir: "Photoz_BBonly",  desc: "Photo-z using broad-band filters only (medium bands excluded)" },
  { key: "wfc3",     label: "Photo-z — WFC3",      dir: "Photoz_WFC3",    desc: "Photo-z including HST WFC3 aperture photometry" },
  { key: "lrd",      label: "Photo-z — LRD",       dir: "Photoz_lrd",     desc: "Photo-z with the little-red-dot (LRD / AGN) template set" },
];
// Per-field photo-z variant sets (verified against the public Corral tree — every
// field has fiducial/eelg/circles; bbonly + wfc3 vary by field).
// Verified against the public Corral tree at v0.99 (per-field Photoz* dir probe).
const WITH_WFC3 = ["fiducial", "eelg", "circles", "bbonly", "wfc3", "lrd"]; // CEERS, EGS, GOODS-S, PRIMER-COSMOS
const NO_WFC3   = ["fiducial", "eelg", "circles", "bbonly", "lrd"];         // GOODS-N, NGDEEP, PRIMER-UDS, A2744, COSMOS

type Field = {
  id: string;
  name: string;
  dir: string;         // Corral subdirectory
  prefix: string;      // filename prefix
  version: string;     // per-field release version
  available: boolean;  // true once files are live on Corral
  variants: string[];  // PZ_VARIANTS keys present for this field
  programs?: string[]; // JWST programs whose imaging is included
  ancillary?: boolean;      // segmap/PSFs/depths/area/completeness on the public tree (default true)
  ancillaryTiles?: string[]; // tiled fields with PER-TILE ancillary products (e.g. EGS: ["ne","sw"]); no segmap
};

// All nine fields are live on the public Corral tree (unicorn/Catalogs/<DIR>/).
const FIELDS: Field[] = [
  { id: "ceers",         name: "CEERS",         dir: "CEERS",         prefix: "ceers",        version: "0.99", available: true, variants: WITH_WFC3, programs: ["CEERS", "SPAM", "MINERVA", "CAPERS"] },
  { id: "egs",           name: "EGS",           dir: "EGS",           prefix: "egs",          version: "0.99", available: true, variants: WITH_WFC3, programs: ["CEERS", "SPAM", "MINERVA", "CAPERS"], ancillaryTiles: ["ne", "sw"] },
  { id: "goods-s",       name: "GOODS-S",       dir: "GOODSS",        prefix: "goodss",       version: "0.99", available: true, variants: WITH_WFC3 },
  { id: "goods-n",       name: "GOODS-N",       dir: "GOODSN",        prefix: "goodsn",       version: "0.99", available: true, variants: NO_WFC3 },
  { id: "primer-cosmos", name: "PRIMER-COSMOS", dir: "PRIMER-COSMOS", prefix: "primercosmos", version: "0.99", available: true, variants: WITH_WFC3 },
  { id: "primer-uds",    name: "PRIMER-UDS",    dir: "PRIMER-UDS",    prefix: "primeruds",    version: "0.99", available: true, variants: NO_WFC3 },
  { id: "ngdeep",        name: "NGDEEP",        dir: "NGDEEP",        prefix: "ngdeep",       version: "0.99", available: true, variants: NO_WFC3 },
  { id: "a2744",         name: "A2744",         dir: "A2744",         prefix: "a2744",        version: "0.99", available: true, variants: NO_WFC3 },
  { id: "cosmos",        name: "COSMOS",        dir: "COSMOS",        prefix: "cosmos",       version: "0.99", available: true, variants: NO_WFC3, ancillary: false },
];

// Real file sizes for the live CEERS v0.99 release, keyed by row key.
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
    href: `${BASE_URL}/Legacy/CEERS/unicorn_templates_fiducial.fits`,
    size: "1.2 GB",
  },
  {
    label: "Templates — EELG",
    desc: "LAZY SED template library for the EELG photo-z variant",
    href: `${BASE_URL}/Legacy/CEERS/unicorn_templates_eelg.fits`,
    size: "1.3 GB",
  },
  {
    label: "Templates — LRD",
    desc: "LAZY SED template library for the LRD photo-z variant",
    href: `${BASE_URL}/Legacy/CEERS/unicorn_templates_lrd.fits`,
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
  const { prefix: f, available } = field;
  const v = field.version;
  const base = catBase(field);
  // Real byte sizes are only tabulated for CEERS; other fields show "—" (file still downloads).
  const size = (key: string) => (available && field.id === "ceers" ? CEERS_SIZES[key] ?? "—" : "—");

  // COSMOS note: the site serves the no-VIS solution, but at v0.99 the files no longer carry a
  // _novis suffix (no-VIS IS the default naming). COSMOS is tiled and has no segmap/PSFs/depths/
  // area/completeness on the public tree (ancillary:false), so it flows through the generic path.
  const files: FileRow[] = [
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
  );

  // Ancillary products (segmap / PSFs / depths / area / completeness). COSMOS (tiled) has none on
  // the public tree (ancillary:false). EGS (tiled) has PER-TILE products (egs-ne_*, egs-sw_*) and
  // no segmap, so it emits per-tile rows via ancillaryTiles; single-mosaic fields use the default.
  if (field.ancillaryTiles) {
    for (const t of field.ancillaryTiles) {
      const T = t.toUpperCase();
      files.push(
        { label: `PSFs (${T})`,        desc: `Empirical point-spread functions per filter, ${T} tile (tar.gz)`, file: `${f}-${t}_psfs_v${v}.tar.gz`,                       href: `${base}/${f}-${t}_psfs_v${v}.tar.gz`,                       size: "—" },
        { label: `5σ Depths (${T})`,   desc: `Per-filter 5σ point-source depths, ${T} tile`,                     file: `${f}-${t}_5sig-depths_v${v}.txt`,                      href: `${base}/${f}-${t}_5sig-depths_v${v}.txt`,                      size: "—" },
        { label: `Survey Area (${T})`, desc: `Effective survey area per filter (arcmin²), ${T} tile`,            file: `${f}-${t}_area.txt`,                                   href: `${base}/${f}-${t}_area.txt`,                                   size: "—" },
        { label: `Completeness (${T})`, desc: `Point-source completeness vs. magnitude, ${T} tile`,              file: `${f}-${t}_pointsource_completeness_v${v}.txt`,         href: `${base}/${f}-${t}_pointsource_completeness_v${v}.txt`,         size: "—" },
      );
    }
  } else if (field.ancillary !== false) files.push(
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

  // Build + download a curl script. Paths are prefixed with the field dir so the
  // per-field and all-fields scripts drop files into a clean <FIELD>/... layout.
  function makeScript(rows: { file: string; href: string }[], name: string) {
    const lines = ["#!/bin/bash", `# UNICORN catalog download — ${name}`,
      "# Preserves the <FIELD>/Photoz*/ and <FIELD>/Flags/ subdirectory layout.", "set -e", ""];
    for (const r of rows) lines.push(`curl -fL --create-dirs -o "${r.file}" "${r.href}"`);
    lines.push("");
    const blob = new Blob([lines.join("\n")], { type: "text/x-shellscript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `download_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.sh`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const withDir = (field: Field) => fieldFiles(field).map(f => ({ file: `${field.dir}/${f.file}`, href: f.href }));
  const fieldScript = (field: Field) => makeScript(withDir(field), field.name);
  const allScript = () => makeScript(FIELDS.filter(f => f.available).flatMap(withDir), "all fields");

  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "960px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "2.5rem" }}>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "6px" }}>
          Catalogs
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", maxWidth: "640px" }}>
          All UNICORN data products are FITS binary tables with embedded column descriptions
          and units (all fields now at <span className="mono" style={{ color: "var(--accent)" }}>v0.99</span>).
          See the <a href="/unicorn/data/readme" style={{ color: "var(--accent2)", textDecoration: "none" }}>Catalog Guide</a> for
          full column &amp; format documentation (always current).
        </p>
        <button onClick={allScript} className="mono" style={{ marginTop: "14px", background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.35)", borderRadius: "5px", padding: "9px 16px", fontSize: "0.8rem", cursor: "pointer" }}>
          ↓ Download script — all fields
        </button>
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
                    <span style={{
                      fontFamily: "var(--serif)",
                      fontSize: "1.15rem",
                      fontWeight: 600,
                      letterSpacing: "-0.015em",
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
                    {field.available && (
                      <div style={{ padding: "0.5rem 1.25rem", borderBottom: "1px solid var(--border)" }}>
                        <button onClick={() => fieldScript(field)} className="mono" style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.3)", borderRadius: "5px", padding: "6px 12px", fontSize: "0.72rem", cursor: "pointer" }}>
                          ↓ download script — {field.name}
                        </button>
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
