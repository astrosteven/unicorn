import Link from "next/link";
import Image from "next/image";

const FIELDS = [
  { name: "CEERS-EGS",      full: "Cosmic Evolution Early Release Science — Extended Groth Strip" },
  { name: "PRIMER-UDS",     full: "Public Release IMaging for Extragalactic Research — Ultra Deep Survey" },
  { name: "PRIMER-COSMOS",  full: "Public Release IMaging for Extragalactic Research — COSMOS" },
  { name: "GOODS-S",        full: "Great Observatories Origins Deep Survey South (JADES DR5)" },
  { name: "GOODS-N",        full: "Great Observatories Origins Deep Survey North (JADES DR5)" },
  { name: "NGDEEP",         full: "Next Generation Deep Extragalactic Exploratory Public Survey" },
  { name: "Abell 2744",     full: "Abell 2744 Galaxy Cluster" },
  { name: "COSMOS",         full: "Cosmic Evolution Survey" },
];

// Assign brand colors across the palette
const FIELD_ACCENTS = [
  "#8e6bb8", "#b07cc6", "#d48ec9", "#6b51a3",
  "#4a3a8a", "#ef9fcd", "#ffb3d9", "#b07cc6",
];

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>

      {/* Nav */}
      <nav style={{
        borderBottom: "1px solid var(--border)",
        padding: "0 2rem",
        height: "56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(13,10,26,0.85)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="mono" style={{ color: "var(--accent)", fontSize: "1rem", fontWeight: 700, letterSpacing: "0.1em" }}>
            UNICORN
          </span>
        </div>
        <Link href="/login" className="btn btn-primary" style={{ padding: "7px 18px", fontSize: "0.78rem" }}>
          Access Data →
        </Link>
      </nav>

      {/* Hero */}
      <section style={{ padding: "8rem 2rem 5rem", maxWidth: "880px", margin: "0 auto", width: "100%" }}>

        {/* Logo + Title side by side */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "2rem",
          flexWrap: "wrap",
          marginBottom: "0.5rem",
        }}>
          <Image
            src="/unicorn/logo.png"
            alt="UNICORN logo"
            width={130}
            height={130}
            style={{ objectFit: "contain", flexShrink: 0 }}
          />
          <div>
            <h1 className="mono" style={{
              fontSize: "clamp(2.8rem, 9vw, 5.5rem)",
              fontWeight: 700,
              lineHeight: 1.02,
              letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, var(--purple) 0%, var(--lavender) 40%, var(--pink) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              UNICORN
            </h1>
            <p className="mono" style={{
              fontSize: "0.75rem",
              color: "var(--text-dim)",
              letterSpacing: "0.08em",
              marginTop: "6px",
            }}>
              Uniform Near-Infrared CatalOgs from Robust imaging
            </p>
          </div>
        </div>

        <p style={{
          fontSize: "1.15rem",
          color: "var(--text-muted)",
          maxWidth: "640px",
          lineHeight: 1.75,
          marginBottom: "2.5rem",
          marginTop: "2rem",
          fontWeight: 300,
        }}>
          The UNICORN Project provides robust photometric catalogs and photometric
          redshifts from the most highly observed legacy fields from{" "}
          <span style={{ color: "var(--text)" }}>JWST</span>. These catalogs are
          based on new custom, highly-robust reduced imaging — with the exception
          of <span style={{ color: "var(--text)" }}>GOODS S+N</span>, where we use{" "}
          <span style={{ color: "var(--text)" }}>JADES DR5</span>.
        </p>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Link href="/login" className="btn btn-primary" style={{ padding: "12px 28px", fontSize: "0.9rem" }}>
            Access Catalogs
          </Link>
          <a href="#fields" className="btn btn-ghost" style={{ padding: "12px 28px", fontSize: "0.9rem" }}>
            Survey Fields ↓
          </a>
        </div>
      </section>

      {/* Stats */}
      <section style={{
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        padding: "2.5rem 2rem",
        background: "rgba(19,15,34,0.7)",
      }}>
        <div style={{
          maxWidth: "880px",
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "2rem",
        }}>
          {[
            { label: "Survey Fields", value: "8" },
            { label: "Total Sources",  value: "—" },
            { label: "Redshift Range", value: "0 – 12+" },
            { label: "Telescope",      value: "JWST" },
          ].map(s => (
            <div key={s.label}>
              <div className="mono" style={{
                fontSize: "2rem", fontWeight: 700, lineHeight: 1,
                background: "linear-gradient(135deg, var(--lavender), var(--pink))",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}>
                {s.value}
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "5px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Fields grid */}
      <section id="fields" style={{ padding: "5rem 2rem", maxWidth: "880px", margin: "0 auto", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "2.5rem" }}>
          <div style={{ width: "32px", height: "1px", background: "linear-gradient(90deg, var(--pink-purple), var(--pink-light))" }} />
          <span className="mono" style={{ color: "var(--accent2)", fontSize: "0.72rem", letterSpacing: "0.18em" }}>
            SURVEY FIELDS
          </span>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
          gap: "10px",
        }}>
          {FIELDS.map((field, i) => (
            <div key={field.name} className="card" style={{
              padding: "1.25rem 1.5rem",
              borderLeft: `3px solid ${FIELD_ACCENTS[i % FIELD_ACCENTS.length]}`,
            }}>
              <div className="mono" style={{ fontSize: "0.9rem", fontWeight: 700, color: FIELD_ACCENTS[i % FIELD_ACCENTS.length], marginBottom: "5px" }}>
                {field.name}
              </div>
              <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
                {field.full}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{
        marginTop: "auto",
        borderTop: "1px solid var(--border)",
        padding: "2rem",
        textAlign: "center",
      }}>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
          Finkelstein et al. — University of Texas at Austin — Cosmic Frontier Center
        </p>
      </footer>

    </main>
  );
}
