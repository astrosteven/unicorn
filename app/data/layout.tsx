"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { checkAuth, logout } from "@/lib/auth";

const NAV_LINKS = [
  { href: "/data",          label: "Overview" },
  { href: "/data/catalogs", label: "Catalogs" },
  { href: "/data/fields",   label: "Fields" },
  { href: "/data/search",   label: "Search" },
];

export default function DataLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!checkAuth()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, []);

  if (!ready) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span className="mono" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Authenticating...</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{
        borderBottom: "1px solid var(--border)",
        padding: "0 2rem",
        height: "56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(13,10,26,0.92)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
          <Link href="/data" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "8px" }}>
            <Image src="/unicorn/logo.png" alt="UNICORN" width={28} height={28} style={{ objectFit: "contain" }} />
            <span className="mono" style={{
              fontSize: "1rem", fontWeight: 700, letterSpacing: "0.1em",
              background: "linear-gradient(135deg, var(--purple), var(--pink))",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>
              UNICORN
            </span>
          </Link>
          <div style={{ display: "flex", gap: "2px" }}>
            {NAV_LINKS.map(link => {
              const active = pathname === link.href ||
                (link.href !== "/data" && pathname.startsWith(link.href));
              return (
                <Link key={link.href} href={link.href} style={{
                  padding: "6px 14px",
                  borderRadius: "4px",
                  fontSize: "0.83rem",
                  textDecoration: "none",
                  color: active ? "var(--lavender)" : "var(--text-muted)",
                  background: active ? "rgba(176,124,198,0.12)" : "transparent",
                  fontFamily: "'Space Mono', monospace",
                  border: active ? "1px solid rgba(176,124,198,0.25)" : "1px solid transparent",
                }}>
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>
        <button
          onClick={() => { logout(); router.push("/"); }}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            padding: "6px 14px",
            color: "var(--text-dim)",
            fontSize: "0.78rem",
            fontFamily: "'Space Mono', monospace",
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </nav>

      <div style={{ flex: 1 }}>{children}</div>

      <footer style={{ borderTop: "1px solid var(--border)", padding: "1.5rem 2rem", textAlign: "center" }}>
        <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace" }}>
          UNICORN — Finkelstein et al. — UT Austin
        </p>
      </footer>
    </div>
  );
}
