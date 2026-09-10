"use client";
import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { supabase } from "@/lib/supabase";
import { useProfile, routeAllowed, type Role } from "@/lib/roles";

// Nav links + the minimum role that may see each. `null` → visible to everyone
// (including logged-out public viewers). Overview/Fields are always public.
const NAV_LINKS: { href: string; label: string; min: Role | null }[] = [
  { href: "/data",          label: "Overview", min: null },
  { href: "/data/fields",   label: "Fields",   min: null },
  { href: "/data/catalogs", label: "Catalogs", min: "general" },
  { href: "/data/map",      label: "Explore",  min: "general" },
  { href: "/data/search",   label: "Search",   min: "general" },
  { href: "/data/review",   label: "Review",   min: "key" },
  { href: "/data/inspect",  label: "Inspect",  min: "key" },
  { href: "/data/admin",    label: "Admin",    min: "admin" },
];

// Rank roles so a nav link shows when the user's role meets the link's minimum.
const RANK: Record<Role, number> = { pending: 0, general: 1, key: 2, admin: 3 };
function meets(role: Role | null, min: Role | null): boolean {
  if (min == null) return true;             // public link
  if (role == null) return false;           // not logged in
  return RANK[role] >= RANK[min];
}

export default function DataLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { session, role, loading } = useProfile();

  const allowed = routeAllowed(pathname, role);

  // Not logged in and on a gated route → send to the sign-in / register page.
  // (Public routes render for anon with no redirect.)
  useEffect(() => {
    if (!loading && !session && !allowed) {
      router.replace("/login");
    }
  }, [loading, session, allowed, router]);

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span className="mono" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Authenticating...</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{
        borderBottom: "1px solid var(--border)",
        padding: "0 clamp(1.25rem, 4vw, 2.5rem)",
        height: "64px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(11,8,23,0.72)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
          <Link href="/data" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "10px" }}>
            <Image src="/unicorn/logo.png" alt="UNICORN" width={30} height={30} style={{ objectFit: "contain" }} />
            <span className="mono" style={{
              fontSize: "1.05rem", fontWeight: 700, letterSpacing: "0.12em",
              background: "linear-gradient(135deg, var(--lavender), var(--pink))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              UNICORN
            </span>
          </Link>
          <div style={{ display: "flex", gap: "4px" }}>
            {NAV_LINKS.filter(link => meets(role, link.min)).map(link => {
              const active = pathname === link.href ||
                (link.href !== "/data" && pathname.startsWith(link.href));
              return (
                <Link key={link.href} href={link.href} className={active ? "navlink active" : "navlink"}>
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>
        {session ? (
          <button className="signout" onClick={async () => { await supabase.auth.signOut(); router.push("/"); }}>
            Sign out
          </button>
        ) : (
          <Link href="/login" className="signout" style={{ textDecoration: "none" }}>
            Sign in
          </Link>
        )}
      </nav>

      {/* Persistent development / authorized-use disclaimer for the protected area */}
      <div style={{
        display: "flex", alignItems: "center", gap: "10px",
        padding: "9px clamp(1.25rem, 4vw, 2.5rem)",
        background: "linear-gradient(90deg, rgba(240,192,112,0.13), rgba(240,192,112,0.06))",
        borderBottom: "1px solid rgba(240,192,112,0.35)",
        color: "var(--amber)",
        fontFamily: "'Space Mono', monospace", fontSize: "0.8rem", lineHeight: 1.5,
      }}>
        <span style={{ fontSize: "1rem", flexShrink: 0 }} aria-hidden>⚠️</span>
        <span style={{ color: "var(--text)" }}>
          <b style={{ color: "var(--amber)" }}>Disclaimer:</b> All catalogs are still in active development — this
          website is for use only by people authorized by Steven Finkelstein.
        </span>
      </div>

      <div style={{ flex: 1 }}>
        {allowed
          ? children
          : session
            ? (role === "pending"
                ? <AwaitingApproval />
                : <NeedsKeyAccess pathname={pathname} />)
            /* not logged in + gated route: redirect is firing above; show the splash */
            : <RedirectSplash />}
      </div>

      <footer style={{ borderTop: "1px solid var(--border)", padding: "1.5rem 2rem", textAlign: "center" }}>
        <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
          UNICORN — Finkelstein et al. — UT Austin
          {" · "}
          <a href="mailto:sf8542@eid.utexas.edu?subject=UNICORN%20site%20feedback"
             style={{ color: "var(--accent2)", textDecoration: "none" }}>Feedback</a>
        </p>
      </footer>
    </div>
  );
}

// ---- Gate panels -----------------------------------------------------------

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: "560px", margin: "0 auto", padding: "5rem 2rem", textAlign: "center" }}>
      <div className="card-bright" style={{ padding: "2.5rem 2rem" }}>{children}</div>
    </main>
  );
}

// Logged in but role is still `pending` — friendly "we'll review it" screen.
function AwaitingApproval() {
  return (
    <Panel>
      <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }} aria-hidden>⏳</div>
      <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "0.75rem" }}>
        Access requested — awaiting approval
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "1.5rem" }}>
        Thanks for registering. Your request has been received and Steven Finkelstein will review it
        shortly. You&rsquo;ll get access to the catalogs and tools once it&rsquo;s approved — no need
        to sign up again.
      </p>
      <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </Panel>
  );
}

// Logged in with a valid but insufficient role (e.g. general on /data/inspect).
function NeedsKeyAccess({ pathname }: { pathname: string }) {
  return (
    <Panel>
      <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }} aria-hidden>🔑</div>
      <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "0.75rem" }}>
        This needs key access
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "1.5rem" }}>
        <span className="mono" style={{ color: "var(--text-dim)" }}>{pathname}</span> is limited to key
        collaborators. Your account doesn&rsquo;t have that level yet — contact Steven Finkelstein if you
        believe you should.
      </p>
      <Link href="/data" className="signout" style={{ textDecoration: "none" }}>← Back to Overview</Link>
    </Panel>
  );
}

// Brief placeholder while the redirect-to-login effect runs (anon on a gated route).
function RedirectSplash() {
  return (
    <div style={{ minHeight: "40vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span className="mono" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Redirecting to sign in…</span>
    </div>
  );
}
