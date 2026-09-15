"use client";
// Master README / catalog guide. Hand-rendered from MASTER_README_DRAFT.md (the content
// source, kept at repo root) in the site's dark theme. The "Fields in this release" table
// is rendered from the canonical FIELDS registry in ../page.tsx — so a version bump there
// (Steve's normal push) auto-updates the version/source columns here on the same deploy.
// Everything else on this page is static documentation of the shared data model.
import Link from "next/link";
import { FIELDS } from "../page";

// ---- Small presentational helpers (match the catalogs/fields pages) --------

function SectionRule({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "2.75rem 0 1.25rem" }}>
      <div style={{ width: "24px", height: "1px", background: "var(--accent2)" }} />
      <span className="mono" style={{ color: "var(--accent2)", fontSize: "0.72rem", letterSpacing: "0.15em" }}>
        {label}
      </span>
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="page-title" style={{ fontSize: "1.4rem", color: "var(--text)", margin: "2.5rem 0 0.75rem" }}>
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mono" style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--accent)", margin: "1.5rem 0 0.6rem", letterSpacing: "0.02em" }}>
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", lineHeight: 1.7, margin: "0 0 0.9rem" }}>{children}</p>;
}

// Inline monospace code chip
function C({ children }: { children: React.ReactNode }) {
  return <code className="mono" style={{ fontSize: "0.82rem", color: "var(--accent-bright)", background: "rgba(255,255,255,0.03)", padding: "1px 5px", borderRadius: "3px" }}>{children}</code>;
}

// Bulleted list of column-group entries: <term> — <definition>
function DefList({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem", display: "flex", flexDirection: "column", gap: "6px" }}>
      {items.map((it, i) => (
        <li key={i} style={{ fontSize: "0.86rem", color: "var(--text-muted)", lineHeight: 1.6, paddingLeft: "14px", borderLeft: "2px solid var(--border)" }}>
          {it[0]} — {it[1]}
        </li>
      ))}
    </ul>
  );
}

const th: React.CSSProperties = {
  textAlign: "left", padding: "8px 12px", fontFamily: "'Space Mono', monospace",
  fontSize: "0.68rem", letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--text-dim)", borderBottom: "1px solid var(--border-bright)", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "8px 12px", fontSize: "0.82rem", color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)", verticalAlign: "top",
};

export default function ReadmePage() {
  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "920px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <p className="mono" style={{ fontSize: "0.7rem", color: "var(--accent2)", letterSpacing: "0.18em", marginBottom: "8px" }}>
          CATALOG GUIDE
        </p>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "10px" }}>
          UNICORN Photometry &amp; Photometric-Redshift Catalogs
        </h1>
        <P>
          <b style={{ color: "var(--text)" }}>UNICORN</b> — <b style={{ color: "var(--text)" }}>Uni</b>form{" "}
          <b style={{ color: "var(--text)" }}>N</b>ear-<b style={{ color: "var(--text)" }}>I</b>nfrared{" "}
          <b style={{ color: "var(--text)" }}>C</b>atal<b style={{ color: "var(--text)" }}>O</b>g from{" "}
          <b style={{ color: "var(--text)" }}>R</b>obust imagi<b style={{ color: "var(--text)" }}>N</b>g —
          is a set of JWST/NIRCam (+ HST ACS/WFC3, where available) photometric and photometric-redshift
          catalogs across the major extragalactic legacy fields, produced with a single uniform pipeline.
        </P>
      </div>

      {/* Key facts card */}
      <div className="card" style={{ padding: "1.25rem 1.5rem", borderLeft: "3px solid var(--accent)", marginBottom: "1rem" }}>
        <DefList items={[
          [<b key="c" style={{ color: "var(--text)" }}>Contact</b>, <>Steve Finkelstein — <a href="mailto:stevenf@astro.as.utexas.edu" style={{ color: "var(--accent2)", textDecoration: "none" }}>stevenf@astro.as.utexas.edu</a></>],
          [<b key="m" style={{ color: "var(--text)" }}>Method paper</b>, <>Finkelstein et al. 2024, ApJL, 969, L2 — <a href="https://ui.adsabs.harvard.edu/abs/2024ApJ...969L...2F/abstract" target="_blank" rel="noreferrer" style={{ color: "var(--accent2)", textDecoration: "none" }}>ADS</a></>],
          [<b key="u" style={{ color: "var(--text)" }}>Photometry units</b>, <>nanojanskys (nJy) throughout.</>],
          [<b key="z" style={{ color: "var(--text)" }}>Photometric redshifts</b>, <>computed with <b style={{ color: "var(--text)" }}>LAZY</b> (Asada et al. implementation of the CEERS Key Paper I method) using an <b style={{ color: "var(--text)" }}>SFHZ + Larson et al. 2022</b> template set, optimized against ~10,000 spec-confirmed galaxies with per-band zero-point offsets applied.</>],
        ]} />
      </div>
      <P>
        Every field is reduced identically, so the data model documented below (columns, flags, photo-z
        file structure) is <b style={{ color: "var(--text)" }}>the same for all fields</b>. Only the imaging
        provenance and field geometry differ.
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="FIELDS IN THIS RELEASE" />
      <P>
        Version and source counts are the live values from the site registry — this table is rendered from
        that registry, so it stays current automatically as fields are re-run. All fields listed are
        currently public.
      </P>
      <div style={{ overflowX: "auto" }} className="card">
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "760px" }}>
          <thead>
            <tr>
              <th style={th}>Field</th>
              <th style={th}>Region / notes</th>
              <th style={th}>Geometry</th>
              <th style={th}>Imaging provenance (programs)</th>
              <th style={th}>Version</th>
              <th style={{ ...th, textAlign: "right" }}>Sources</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(f => (
              <tr key={f.name}>
                <td style={{ ...td }}>
                  <span className="mono" style={{ fontWeight: 700, color: f.color }}>{f.name}</span>
                </td>
                <td style={td}>{f.region}</td>
                <td style={td}><span className="mono" style={{ fontSize: "0.76rem", color: "var(--text-dim)" }}>{f.geometry}</span></td>
                <td style={td}>{f.provenance}</td>
                <td style={td}><span className="mono" style={{ color: "var(--accent)" }}>v{f.version}</span></td>
                <td style={{ ...td, textAlign: "right" }}><span className="mono" style={{ color: "var(--text)" }}>{f.sources}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        <i>Note on tiled fields:</i> multi-tile fields (EGS, COSMOS) are merged into a single catalog and
        carry three extra tile-provenance columns at the front of the photometry table (<C>TILE</C>,{" "}
        <C>TILE_ID</C>, <C>COORDID</C>); single-tile fields do not.
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="WHAT YOU GET FOR EACH FIELD" />
      <P>A field/version folder contains:</P>
      <DefList items={[
        [<C key="p">{"<field>_photom_v<ver>.fits"}</C>, "the photometry catalog (main table in ext 1; shared aperture-diameter vector in ext 2)."],
        [<C key="a">{"<field>_area.txt"}</C>, "area in sq. arcmin, tabulated per depth tier (SW+LW area from 115+150+200+277+356; LW-only from 277+356)."],
        [<C key="d">{"<field>_5sig-depths_v<ver>.txt"}</C>, "estimated 5σ point-source depths per filter, per depth tier (99 = no valid data in that tier)."],
        [<C key="f">Flags/</C>, <><C>{"<field>_detectionflags_v<ver>.fits"}</C> and <C>{"<field>_selectionflags_v<ver>.fits"}</C>.</>],
        [<C key="s">{"<field>_selected_v<ver>.fits"}</C>, "the ready-made “UNICORN-selected” high-z sample (see below)."],
        [<span key="pz" style={{ color: "var(--text)" }}>Photo-z runs</span>, <>five directories, each with one 4-extension FITS file: <C>Photoz/</C>, <C>Photoz_Circles/</C>, <C>Photoz_eelg/</C>, <C>Photoz_BBonly/</C>, <C>Photoz_WFC3/</C>.</>],
        [<C key="t">{"<field>_v<ver>.tar.gz"}</C>, <>bundles everything above <i>except</i> the large shared template files. <b style={{ color: "var(--text)" }}>Most users should start here.</b></>],
        [<span key="tb" style={{ color: "var(--text)" }}>Shared template bases</span>, <>(once per project, not per field): <C>unicorn_templates_fiducial.fits</C>, <C>unicorn_templates_eelg.fits</C>, <C>unicorn_templates_lrd.fits</C>.</>],
      ]} />

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="THE PHOTOMETRY CATALOG" />
      <P>
        <C>{"<field>_photom_v<ver>.fits"}</C>
      </P>

      <H3>Extension 1 — main table (one row per source)</H3>

      <H3>Identity &amp; astrometry</H3>
      <DefList items={[
        [<C key="id">ID</C>, "running Source Extractor ID (cold objects first, then new IDs for hot objects)."],
        [<C key="co">COORDID</C>, "IAU-style coordinate string."],
        [<C key="rd">RA, DEC</C>, "J2000, measured in the detection image."],
        [<C key="dc">DETECTCAT</C>, "which catalog the source came from: cold-fiducial, hot-fiducial, or F444W-selected."],
        [<C key="xy">X, Y, XMIN, XMAX, YMIN, YMAX</C>, "detection-image pixel coordinates / Source Extractor bounds."],
      ]} />

      <H3>Shape &amp; aperture</H3>
      <DefList items={[
        [<C key="k">KRON_RADIUS, A_IMAGE, B_IMAGE, THETA_IMAGE</C>, "fiducial small-Kron aperture geometry (semi-major = A_IMAGE × KRON_RADIUS)."],
        [<C key="ac">APCORR</C>, "aperture correction for the fiducial Kron apertures."],
        [<C key="aca">APCORR_APER</C>, "12-element aperture-correction vector for the circular apertures."],
        [<C key="acw">APCORR_WINGS</C>, "residual (large-scale) aperture correction, already folded into APCORR / APCORR_APER."],
      ]} />

      <H3>Quality / classification</H3>
      <DefList items={[
        [<C key="se">SE_FLAGS</C>, "Source Extractor bit flags."],
        [<C key="st">STELLARITY</C>, "SE star/galaxy separator (1 = star, 0 = galaxy)."],
        [<C key="is">ISOAREA_IMAGE</C>, "segmentation-map area (pixels)."],
        [<C key="sf">STARFLAGS</C>, "1 if the central pixel is in the star mask (mask unavailable in most fields → 0 for all)."],
        [<C key="dt">DEPTHTIER</C>, "integer depth-tier label for fields with non-uniform depth (0/single where uniform); indexes the per-tier area and depth tables."],
        [<C key="af">APERFLAGS, SCALE_KRON, SCALE_MODEL</C>, "Kron-aperture-correction screening (see below)."],
      ]} />

      <H3>Derived (from the LAZY best-fit model)</H3>
      <DefList items={[
        [<C key="mabs">MABS_1500</C>, "absolute UV magnitude at rest-frame 1500 Å (99 = undefined)."],
        [<C key="beta">BETA</C>, "UV continuum slope (f_λ ∝ λ^β), measured over the Calzetti windows (NaN if too few covered)."],
      ]} />

      <H3>Spec-z &amp; sources of interest</H3>
      <P>(matched from curated master lists; sentinels if none)</P>
      <DefList items={[
        [<C key="zs">ZSPEC, ZSPEC_QUAL, ZSPEC_PROGRAM, ZSPEC_GRATING</C>, "matched spectroscopic redshift and provenance."],
        [<C key="in">INTEREST_SOURCE, INTEREST_LABEL</C>, "curated source-of-interest tag and label."],
      ]} />

      <H3>Per-filter columns (repeated for each filter FXXXX)</H3>
      <DefList items={[
        [<C key="fx">FLUX_FXXXX / FLUXERR_FXXXX</C>, "fiducial small-Kron flux (PSF-corrected, full aperture correction, Kron-screening applied) and its empirical error."],
        [<C key="kr">FLUX_KRON_FXXXX / FLUXERR_KRON_FXXXX</C>, "same, without the (sometimes inaccurate) Kron correction."],
        [<C key="ap">FLUX_APER_FXXXX, FLUX_APER_NATIVE_FXXXX, FLUXERR_APER_FXXXX</C>, "the 12 circular apertures (PSF-matched and native), with empirical errors."],
        [<C key="at">FLUX_APERTOT_FXXXX / FLUXERR_APERTOT_FXXXX</C>, "circular apertures corrected to total."],
        [<C key="rh">RH_FXXXX, FWHM_FXXXX</C>, "half-light radius and FWHM (native resolution)."],
        [<C key="ed">EDGEFLAGS_51PIX_FXXXX, EDGEFLAGS_21PIX_FXXXX</C>, "edge proximity (1 if >10% of a 51×51 / 21×21 box is NaN)."],
      ]} />

      <H3>Neighbors</H3>
      <DefList items={[
        [<C key="nc">NEIGHBOR_D_CLOSEST, NEIGHBOR_MAG_CLOSEST</C>, "distance and F444W mag of the closest source."],
        [<C key="nb">NEIGHBOR_D_BRIGHTEST_4ARCSEC, NEIGHBOR_MAG_BRIGHTEST_4ARCSEC</C>, "distance / F444W mag of the brightest source within 4″."],
      ]} />
      <P>
        <b style={{ color: "var(--text)" }}>Multi-tile fields only:</b> <C>TILE</C>, <C>TILE_ID</C>,{" "}
        <C>COORDID</C> appear at the front of the table.
      </P>

      <H3>Extension 2 — APER_DIAMETER_ARCSEC</H3>
      <P>
        A single 12-element vector giving the circular-aperture diameters (arcsec) used by all{" "}
        <C>FLUX_APER_*</C> / <C>FLUX_APERTOT_*</C> columns (the 12 apertures with diameter ≤ 1.0″).
        Stored once here rather than per object.
      </P>

      <H3>Kron-aperture screening (APERFLAGS)</H3>
      <P>
        Occasionally (usually a bright neighbor) the Kron aperture is drawn too large. A ratio{" "}
        <C>aperrat</C> = Kron area / area of a 0.2″ circle triggers a correction when:
      </P>
      <ol style={{ color: "var(--text-muted)", fontSize: "0.86rem", lineHeight: 1.7, paddingLeft: "1.25rem", margin: "0 0 0.9rem" }}>
        <li><C>aperrat</C> &gt; 10 <b style={{ color: "var(--text)" }}>and</b> m_F444W &gt; 25 → <b style={{ color: "var(--text)" }}>APERFLAG = 1</b>; or</li>
        <li>3 &lt; <C>aperrat</C> &lt; 10 <b style={{ color: "var(--text)" }}>and</b> a bright-neighbor condition is met (brightest neighbor within 4″/1.5″/0.5″/1″ passes the respective magnitude test) <b style={{ color: "var(--text)" }}>and</b> za &gt; 7 → <b style={{ color: "var(--text)" }}>APERFLAG = 2</b>.</li>
      </ol>
      <P>
        <C>SCALE_KRON</C> / <C>SCALE_MODEL</C> let you back out the correction or rescale the fiducial
        model (e.g. for SED plots / the circular templates).
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="FLAGS & THE SELECTED SAMPLE" />

      <H3>Flags/{"<field>"}_detectionflags_v{"<ver>"}.fits (detection-based, 0/1)</H3>
      <P>
        <C>snr_detect</C> (≥2 bands SNR&gt;5.3 or ≥3 bands SNR&gt;4.3, native 0.2″), <C>snr_break</C> and{" "}
        <C>snr_break_circ</C> (no significant flux below the Lyα break), <C>err</C> (central errmap OK in
        F115W/F150W/F277W/F444W — excludes SW chip gaps), <C>stars</C>, <C>edge</C>, <C>edge_sw</C>,{" "}
        <C>edge_lw</C>.
      </P>

      <H3>Flags/{"<field>"}_selectionflags_v{"<ver>"}.fits (photo-z-based, 0/1)</H3>
      <P>
        Uses <C>z_sample = [3,4,5,6,7,8,9,10.75,13.5,17.5]</C>, <C>dz = [1,1,1,1,1,1,1,2.5,3,5]</C>:{" "}
        <C>intpz</C> (chosen P(z) integral ≥ 0.7), <C>za</C>, <C>chia</C> (χ² at za ≤ 60), <C>sample</C>{" "}
        (plurality redshift bin equals <C>z_sample</C>), <C>dz_circ</C> (fiducial vs circular photo-z
        agree), <C>dchi2</C> (low-z solution disfavored for za&gt;7), <C>rh</C> (reject bad LW pixels
        mimicking very high-z), <C>eelg</C> (EELG-recovery branch), plus <C>inspect</C>, <C>mag</C>,{" "}
        <C>aperrat</C>. Each also comes in <C>*_circ</C> (circular-aperture run) and <C>*_kron</C>{" "}
        (un-aperture-corrected run) variants. <b style={{ color: "var(--text)" }}>Deprecated:</b>{" "}
        <C>snr_local_*</C> — do not use.
      </P>

      <H3>{"<field>"}_selected_v{"<ver>"}.fits (the ready-made high-z sample)</H3>
      <DefList items={[
        [<C key="sel">selected</C>, "1 if all UNICORN selection criteria are met."],
        [<C key="sam">sample</C>, "integer redshift sample (Δz=1 bin holding the plurality of P(z), 1–19); 0 if not selected."],
        [<C key="ins">inspected</C>, "−1 (not inspected) / 1 (validated) / 0 (spurious)."],
        [<C key="gate">detflag, pixflag, zflag</C>, "the detection / image / photo-z gate values (0 = that gate failed)."],
        [<C key="eelg">eelg_recovered</C>, "1 if the object was selected only via the EELG-template recovery branch; for these, the reported photo-z is swapped to the EELG fit."],
      ]} />
      <P>
        To reproduce a &ldquo;selected&rdquo; sample, require: <C>snr_detect, err, intpz, chia, za, sample,
        snr_break, dchi2, edge, stars, rh, eelg</C>.
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="PHOTOMETRIC REDSHIFTS" />
      <P>
        Five runs, each producing one multi-extension FITS file <C>{"<field>_photz_v<ver>.fits"}</C>:
      </P>
      <div style={{ overflowX: "auto" }} className="card">
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "560px" }}>
          <thead>
            <tr>
              <th style={th}>Directory</th>
              <th style={th}>What it fits</th>
            </tr>
          </thead>
          <tbody>
            {([
              ["Photoz/", <><b style={{ color: "var(--text)" }}>Fiducial</b> — small-Kron, PSF- &amp; aperture-corrected fluxes, z = 0–20.</>],
              ["Photoz_Circles/", <>0.2″-diameter circular-aperture fluxes (<C>FLUX_APERTOT</C>).</>],
              ["Photoz_eelg/", <>Fiducial fluxes fit with an <b style={{ color: "var(--text)" }}>EELG</b> (extreme emission-line galaxy) template set.</>],
              ["Photoz_BBonly/", <>Fiducial fluxes, <b style={{ color: "var(--text)" }}>broadband filters only</b> (no medium bands).</>],
              ["Photoz_WFC3/", <>Fiducial + WFC3 fluxes.</>],
            ] as [string, React.ReactNode][]).map(([dir, what]) => (
              <tr key={dir}>
                <td style={td}><C>{dir}</C></td>
                <td style={td}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H3>FITS structure (4 extensions)</H3>
      <DefList items={[
        [<b key="e1" style={{ color: "var(--text)" }}>Ext 1 — scalar quantities</b>, <>(one row/object): <C>za</C> (best-fit z), <C>zm</C> (P(z)-weighted z), <C>chia</C> (χ² at za), <C>z_lowz</C> / <C>chia_lowz</C> (best z &lt; 7 solution), <C>zl68/zu68/zl95/zu95</C>, <C>int_cen</C>, <C>int_pzX</C> (Δz=1 windows), <C>int_pzX_Y</C>, <C>int_zgtX</C>, <C>int_zgtza_2</C>, <C>sample_integer</C>, <C>sample_jwst</C>, <C>coeffs</C> / <C>coeffs_lowz</C>, <C>m1300</C> / <C>m1500</C>, <C>id</C> (matches photom ID).</>],
        [<b key="e2" style={{ color: "var(--text)" }}>Ext 2 — best-fit model fluxes</b>, "(bandpass-integrated flux of the best-fit model, one column per filter)."],
        [<b key="e3" style={{ color: "var(--text)" }}>Ext 3 — full P(z)</b>, <><C>ZGRID</C>, <C>PZ</C> (normalized to unit integral), <C>CHI2</C> (χ²(z)).</>],
        [<b key="e4" style={{ color: "var(--text)" }}>Ext 4 — low-z P(z)</b>, <><C>ZGRID_LOWZ</C>, <C>PZ_LOWZ</C> (restricted to z &lt; 7).</>],
      ]} />

      <H3>Reconstructing a best-fit model</H3>
      <P>
        Multiply the shared template basis (<C>unicorn_templates_{"{fiducial,eelg,lrd}"}.fits</C>) by an
        object&rsquo;s <C>COEFFS</C> (ext 1 of the matching run) and redshift by (1+z).
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="ACCESSING THE CATALOGS" />
      <DefList items={[
        [<b key="w" style={{ color: "var(--text)" }}>Browse &amp; query on the website</b>, <>search by position, redshift, magnitude, and catalog columns; view per-object SED + P(z) cards on the <Link href="/data/search" style={{ color: "var(--accent2)", textDecoration: "none" }}>Search</Link> and <Link href="/data/map" style={{ color: "var(--accent2)", textDecoration: "none" }}>Explore</Link> pages, or download bundles from <Link href="/data/catalogs" style={{ color: "var(--accent2)", textDecoration: "none" }}>Catalogs</Link>.</>],
        [<b key="d" style={{ color: "var(--text)" }}>Direct download from TACC Corral</b>, <>public HTTPS at <a href="https://web.corral.tacc.utexas.edu/unicorn/" target="_blank" rel="noreferrer" style={{ color: "var(--accent2)", textDecoration: "none" }}>web.corral.tacc.utexas.edu/unicorn/</a> (catalogs under <C>.../unicorn/Catalogs/{"<FIELD>"}/</C>). Start with the per-field <C>{"<field>_v<ver>.tar.gz"}</C>.</>],
        [<b key="c" style={{ color: "var(--text)" }}>Citation</b>, "please cite Finkelstein et al. 2024 (ApJL 969, L2)."],
      ]} />

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="PIPELINE SUMMARY" />
      <P>
        PSFs of all ACS bands and NIRCam bands bluer than F277W are matched to F277W; larger-PSF bands
        (redder NIRCam, WFC3) get convolution-derived correction factors. Photometry uses Source Extractor
        v2.25.0 in two-image mode on a weighted native-resolution F277W+F356W detection image, run in both{" "}
        <b style={{ color: "var(--text)" }}>hot</b> (DETECT_THRESH=1.75, MINAREA=5) and{" "}
        <b style={{ color: "var(--text)" }}>cold</b> (3.5, 40) modes and merged (all cold objects, then hot
        objects outside the dilated cold segmap). Flux errors are empirical, from random empty-aperture NMAD
        vs. aperture area. Fiducial fluxes use small Kron apertures with two aperture corrections (MAG_AUTO
        ratio + a source-injection-calibrated large-scale correction, ~1.02 at m=24 rising to ~1.10 at m=28,
        capped at 1.20). Photo-z via LAZY with the optimized SFHZ+Larson22 templates and per-band zero-point
        offsets. Full details: Finkelstein et al. 2024.
      </P>

      {/* ------------------------------------------------------------------ */}
      <SectionRule label="VERSION HISTORY (ABRIDGED)" />
      <DefList items={[
        [<C key="v1">v0.1–0.2</C>, "initial pipeline (follows Finkelstein+2023), hot+cold step added; fiducial photo-z moved to WFC3-free; per-field area + 5σ depths added."],
        [<C key="v5">v0.5/0.6</C>, "F444W-selection tweaks; detection/selection flags added."],
        [<C key="v9">v0.9</C>, "cold-mode MINAREA 50→40; hot+cold merge fixes; switched EAZY → LAZY."],
        [<C key="v91">v0.91</C>, "fixed first-1000 hot-catalog merge bug."],
        [<C key="v94">v0.94</C>, "GOODS-N/S → JADES DR5; hot+cold+f444 segmap subregion 100→600 px; photo-z → SFHZ+Larson22 with measured zero-point offsets and the LAZY Asada CGM implementation."],
        [<C key="v95">v0.95–v0.97</C>, "photo-z outputs consolidated into a single 4-ext FITS per run; shared template bases; D_APER moved to photom ext 2; added EELG and BBonly runs + EELG recovery branch; added spec-z / source-of-interest / MABS_1500 / BETA columns; multi-tile support with tile-provenance columns."],
        [<C key="v98">v0.98</C>, "file prefix standardized (e.g. ceers_*); CEERS/EGS/A2744 live; COSMOS being re-run as a tiled reduction."],
      ]} />

    </main>
  );
}
