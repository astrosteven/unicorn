"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { login } from "@/lib/auth";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError]       = useState(false);
  const [loading, setLoading]   = useState(false);
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);
    setTimeout(() => {
      if (login(password)) {
        router.push("/data");
      } else {
        setError(true);
        setLoading(false);
        setPassword("");
      }
    }, 400);
  }

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "2rem",
    }}>
      <div style={{ width: "100%", maxWidth: "380px" }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "3rem" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "12px" }}>
            <Image src="/unicorn/logo.png" alt="UNICORN logo" width={72} height={72} style={{ objectFit: "contain" }} />
          </div>
          <div className="mono" style={{
            fontSize: "2rem",
            fontWeight: 700,
            letterSpacing: "0.1em",
            marginBottom: "6px",
            background: "linear-gradient(135deg, var(--purple) 0%, var(--lavender) 50%, var(--pink) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}>
            UNICORN
          </div>
          <p style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
            Enter your access password to continue
          </p>
        </div>

        <div className="card-bright" style={{ padding: "2rem" }}>
          <form onSubmit={handleSubmit}>
            <label style={{
              display: "block",
              fontSize: "0.72rem",
              color: "var(--text-muted)",
              fontFamily: "'Space Mono', monospace",
              letterSpacing: "0.12em",
              marginBottom: "8px",
            }}>
              PASSWORD
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoFocus
              style={{
                width: "100%",
                background: "var(--bg)",
                border: `1px solid ${error ? "var(--red)" : "var(--border-bright)"}`,
                borderRadius: "4px",
                padding: "10px 14px",
                color: "var(--text)",
                fontSize: "1rem",
                fontFamily: "'Space Mono', monospace",
                outline: "none",
                marginBottom: "14px",
              }}
            />

            {error && (
              <p style={{
                color: "var(--red)",
                fontSize: "0.78rem",
                marginBottom: "12px",
                fontFamily: "'Space Mono', monospace",
              }}>
                Incorrect password
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              style={{
                width: "100%",
                background: loading || !password
                  ? "var(--bg-card2)"
                  : "linear-gradient(135deg, var(--purple-mid), var(--lavender))",
                color: loading || !password ? "var(--text-dim)" : "var(--text)",
                border: "none",
                borderRadius: "4px",
                padding: "11px",
                fontFamily: "'Space Mono', monospace",
                fontSize: "0.875rem",
                fontWeight: 700,
                cursor: loading || !password ? "not-allowed" : "pointer",
                letterSpacing: "0.05em",
              }}
            >
              {loading ? "Checking..." : "Access Data →"}
            </button>
          </form>
        </div>

        <p style={{ textAlign: "center", marginTop: "1.5rem", fontSize: "0.78rem" }}>
          <a href="/unicorn" style={{ color: "var(--text-muted)", textDecoration: "none", fontFamily: "'Space Mono', monospace" }}>
            ← Back to home
          </a>
        </p>
      </div>
    </main>
  );
}
