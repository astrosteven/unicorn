"use client";
// Sign in / Register page. Replaces the old shared-password gate (lib/auth.ts) with
// Supabase Auth accounts. Two modes toggle in place:
//   • Sign in  — email + password → signInWithPassword → redirect to /data.
//   • Register — email + password + a REQUIRED justification. On sign-up we insert a
//     `pending` row into public.profiles and best-effort ping the owner via the
//     notify-signup Edge Function, then show a "request submitted" confirmation.
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabase";

// The justification prompt must read exactly like this (per site owner).
const JUSTIFICATION_LABEL =
  "UNICORN is currently open only for known collaborators of the UT Finkelstein Research Group. Please provide a short justification here:";

// Cloudflare Turnstile site key (PUBLIC — safe in the client). Supabase Auth has Captcha
// protection enabled, so every signup/signin must carry a fresh Turnstile token.
const TURNSTILE_SITE_KEY = "0x4AAAAAAEvfQRgVzVqy1YJy";
type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
};
const getTurnstile = () => (window as unknown as { turnstile?: Turnstile }).turnstile;

type Mode = "signin" | "register";

export default function LoginPage() {
  const [mode, setMode]           = useState<Mode>("signin");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [justification, setJust]  = useState("");
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [submitted, setSubmitted] = useState(false); // register confirmation
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaErr, setCaptchaErr]     = useState("");
  const captchaBox = useRef<HTMLDivElement>(null);
  const captchaId  = useRef<string | null>(null);
  const router = useRouter();

  // Load Turnstile once and render the widget; its callback supplies the token Supabase needs.
  useEffect(() => {
    const API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    const render = () => {
      const ts = getTurnstile();
      if (!ts || !captchaBox.current || captchaId.current !== null) return;
      captchaId.current = ts.render(captchaBox.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
        appearance: "always",              // always show the widget (never invisible)
        callback: (t: string) => { setCaptchaToken(t); setCaptchaErr(""); },
        "expired-callback": () => setCaptchaToken(""),
        "error-callback": (code: string) => {
          setCaptchaToken("");
          // Surface Cloudflare's code so a misconfig (e.g. this domain not on the widget's
          // hostname allowlist → 110200) is diagnosable instead of showing a blank box.
          setCaptchaErr(`Verification couldn't load (Turnstile ${code || "error"}). The site's domain may not be allowed for this Turnstile widget.`);
          return true;
        },
      });
    };
    if (!document.querySelector(`script[src^="${API.split("?")[0]}"]`)) {
      const s = document.createElement("script");
      s.src = API; s.async = true; s.defer = true;
      s.onerror = () => setCaptchaErr("Couldn't reach Cloudflare Turnstile (network or ad-blocker?).");
      document.head.appendChild(s);
    }
    const iv = setInterval(() => { if (getTurnstile()) { clearInterval(iv); render(); } }, 150);
    return () => clearInterval(iv);
  }, []);

  // Turnstile tokens are single-use — reset the widget after each attempt so a retry gets a new one.
  const resetCaptcha = () => {
    const ts = getTurnstile();
    if (ts && captchaId.current !== null) ts.reset(captchaId.current);
    setCaptchaToken("");
  };

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken } });
    setLoading(false);
    if (error) { setError(error.message); resetCaptcha(); return; }
    router.push("/data");
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!justification.trim()) return;
    setError(""); setLoading(true);

    const { data, error } = await supabase.auth.signUp({ email, password, options: { captchaToken } });
    if (error) { setLoading(false); setError(error.message); resetCaptcha(); return; }

    // If email confirmation is OFF a session is returned immediately and we can insert
    // the profile row now. If it's ON there's no session yet (the row is inserted on
    // first sign-in via the layout's default-to-pending path); either way we show the
    // same confirmation copy below.
    const session = data.session;
    if (session) {
      await supabase.from("profiles").insert({
        user_id: session.user.id,
        email,
        role: "pending",
        justification: justification.trim(),
      });
    }
    // Best-effort owner notification — never block or fail the flow on it.
    supabase.functions
      .invoke("notify-signup", { body: { email, justification: justification.trim() } })
      .catch(() => {});

    setLoading(false);
    setSubmitted(true);
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg)",
    border: "1px solid var(--border-bright)",
    borderRadius: "4px",
    padding: "10px 14px",
    color: "var(--text)",
    fontSize: "0.95rem",
    fontFamily: "'Space Mono', monospace",
    outline: "none",
    marginBottom: "14px",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    fontFamily: "'Space Mono', monospace",
    letterSpacing: "0.12em",
    marginBottom: "8px",
  };
  const registerReady = mode === "register" && justification.trim().length > 0 && !!email && !!password;
  const signinReady   = mode === "signin" && !!email && !!password;
  const canSubmit     = (mode === "signin" ? signinReady : registerReady) && !!captchaToken;

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "2rem",
    }}>
      <div style={{ width: "100%", maxWidth: "440px" }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "2.25rem" }}>
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
            {mode === "signin" ? "Sign in to continue" : "Request access to the catalogs"}
          </p>
        </div>

        <div className="card-bright" style={{ padding: "2rem" }}>

          {submitted ? (
            // ---- Registration confirmation -------------------------------------
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.75rem", marginBottom: "0.75rem" }} aria-hidden>✅</div>
              <h2 className="page-title" style={{ fontSize: "1.25rem", color: "var(--text)", marginBottom: "0.6rem" }}>
                Request submitted
              </h2>
              <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", lineHeight: 1.6, marginBottom: "1.25rem" }}>
                Thanks — you&rsquo;ll get access once your request is approved. If email confirmation is
                required for your account, please confirm your address first.
              </p>
              <button
                type="button"
                onClick={() => { setSubmitted(false); setMode("signin"); setPassword(""); setJust(""); }}
                className="signout"
                style={{ textDecoration: "none" }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <>
              {/* Mode toggle */}
              <div style={{ display: "flex", gap: "6px", marginBottom: "1.5rem" }}>
                {(["signin", "register"] as Mode[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setMode(m); setError(""); }}
                    className="mono"
                    style={{
                      flex: 1,
                      padding: "8px",
                      borderRadius: "4px",
                      fontSize: "0.78rem",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      cursor: "pointer",
                      border: mode === m ? "1px solid rgba(207,158,224,0.32)" : "1px solid var(--border)",
                      background: mode === m ? "var(--accent-dim)" : "transparent",
                      color: mode === m ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {m === "signin" ? "Sign in" : "Register"}
                  </button>
                ))}
              </div>

              <form onSubmit={mode === "signin" ? handleSignIn : handleRegister}>
                <label style={labelStyle}>EMAIL</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@institution.edu"
                  autoFocus
                  style={inputStyle}
                />

                <label style={labelStyle}>PASSWORD</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  style={inputStyle}
                />

                {mode === "register" && (
                  <>
                    <label style={{ ...labelStyle, letterSpacing: "0.02em", textTransform: "none", lineHeight: 1.5 }}>
                      {JUSTIFICATION_LABEL}
                    </label>
                    <textarea
                      value={justification}
                      onChange={e => setJust(e.target.value)}
                      required
                      rows={4}
                      placeholder="How you collaborate with the group…"
                      style={{ ...inputStyle, resize: "vertical", minHeight: "80px" }}
                    />
                  </>
                )}

                {/* Cloudflare Turnstile challenge — its token is required by Supabase Auth. */}
                <div ref={captchaBox} style={{ marginBottom: captchaErr ? "6px" : "14px", minHeight: "65px" }} />
                {captchaErr && (
                  <p style={{ color: "var(--red)", fontSize: "0.72rem", marginBottom: "12px", lineHeight: 1.5, fontFamily: "'Space Mono', monospace" }}>
                    {captchaErr}
                  </p>
                )}

                {error && (
                  <p style={{
                    color: "var(--red)",
                    fontSize: "0.78rem",
                    marginBottom: "12px",
                    fontFamily: "'Space Mono', monospace",
                  }}>
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !canSubmit}
                  style={{
                    width: "100%",
                    background: loading || !canSubmit
                      ? "var(--bg-card2)"
                      : "linear-gradient(135deg, var(--purple-mid), var(--lavender))",
                    color: loading || !canSubmit ? "var(--text-dim)" : "var(--text)",
                    border: "none",
                    borderRadius: "4px",
                    padding: "11px",
                    fontFamily: "'Space Mono', monospace",
                    fontSize: "0.875rem",
                    fontWeight: 700,
                    cursor: loading || !canSubmit ? "not-allowed" : "pointer",
                    letterSpacing: "0.05em",
                  }}
                >
                  {loading
                    ? (mode === "signin" ? "Signing in..." : "Submitting...")
                    : (mode === "signin" ? "Sign in →" : "Submit request →")}
                </button>
              </form>
            </>
          )}
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
