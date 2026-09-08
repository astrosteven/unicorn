"use client";
// Spurious-flag REVIEW queue. Gated by Supabase Auth (Steven's login) on top of the
// site password — anonymous users can file flags (see flagSpurious) but only an
// authenticated reviewer can read + triage them here. Each pending flag shows the
// object's full ResultCard (SED / P(z) / color cutout) so it can be validated by eye;
// "Confirm spurious" / "Dismiss" set the row status. Confirmed rows feed the local
// catalog-update script (scripts/apply_flags.py) which sets inspected=0, selected=0.
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Flag } from "@/lib/supabase";
import {
  SEARCH_FIELDS, loadField, fetchObject, ResultCard, type SourceResult,
} from "@/app/data/_card/objectCard";

export default function ReviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <Centered>Checking session…</Centered>;
  if (!session) return <LoginForm />;
  return <Queue email={session.user.email ?? ""} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem" }}>
      {children}
    </main>
  );
}

// ---- Supabase Auth login ---------------------------------------------------
function LoginForm() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(""); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    setBusy(false);
    if (error) setErr(error.message);
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
    color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem", padding: "9px 11px", marginBottom: "10px",
  };
  return (
    <main style={{ maxWidth: "360px", margin: "0 auto", padding: "4rem 2rem" }}>
      <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "4px" }}>Review queue</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginBottom: "1.5rem" }}>
        Reviewer sign-in (Supabase). Only authorized reviewers can triage flagged sources.
      </p>
      <input style={inputStyle} type="email" placeholder="email" value={email}
        onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
      <input style={inputStyle} type="password" placeholder="password" value={pw}
        onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
      {err && <div className="mono" style={{ color: "var(--red)", fontSize: "0.75rem", marginBottom: "10px" }}>{err}</div>}
      <button onClick={submit} disabled={busy} className="mono"
        style={{ width: "100%", background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.35)", borderRadius: "5px", padding: "9px 12px", cursor: busy ? "wait" : "pointer", fontSize: "0.85rem" }}>
        {busy ? "signing in…" : "Sign in"}
      </button>
    </main>
  );
}

// ---- The queue -------------------------------------------------------------
function Queue({ email }: { email: string }) {
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    const { data, error } = await supabase
      .from("flags").select("*").eq("status", "pending").order("created_at", { ascending: true });
    if (error) { setErr(error.message); return; }
    setFlags((data ?? []) as Flag[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (flag: Flag, status: "confirmed" | "dismissed") => {
    // Optimistic: drop it from the list immediately.
    setFlags(f => (f ?? []).filter(x => x.id !== flag.id));
    const { error } = await supabase.from("flags")
      .update({ status, reviewed_at: new Date().toISOString() }).eq("id", flag.id);
    if (error) { setErr(`Update failed: ${error.message}`); load(); }
  };

  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <h1 className="page-title" style={{ fontSize: "1.7rem", color: "var(--text)", marginBottom: "2px" }}>Review queue</h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            {flags == null ? "loading…" : `${flags.length} pending flag${flags.length === 1 ? "" : "s"}`}
            {" · "}Confirm → the source is set inspected=0, selected=0 by scripts/apply_flags.py on your next catalog update.
          </p>
        </div>
        <div className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: "10px" }}>
          <span>{email}</span>
          <button onClick={() => load()} style={btn("var(--accent2)")}>↻ refresh</button>
          <button onClick={() => supabase.auth.signOut()} style={btn("var(--text-muted)")}>sign out</button>
        </div>
      </div>

      {err && <div className="mono" style={{ color: "var(--red)", fontSize: "0.8rem", marginBottom: "1rem" }}>{err}</div>}
      {flags != null && flags.length === 0 && (
        <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.9rem" }}>
          🎉 No pending flags. The queue is clear.
        </div>
      )}
      {flags?.map(flag => <FlagRow key={flag.id} flag={flag} onDecide={decide} />)}
    </main>
  );
}

function btn(color: string): React.CSSProperties {
  return { background: "none", border: "1px solid var(--border-bright)", borderRadius: "4px", color, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "0.7rem", padding: "4px 9px" };
}

// ---- One flagged source: its card + decide buttons -------------------------
function FlagRow({ flag, onDecide }: { flag: Flag; onDecide: (f: Flag, s: "confirmed" | "dismissed") => void }) {
  const [src, setSrc] = useState<SourceResult | null | "loading" | "notfound">("loading");

  useEffect(() => {
    let cancelled = false;
    const fc = SEARCH_FIELDS.find(f => f.field === flag.field);
    if (!fc) { setSrc("notfound"); return; }
    (async () => {
      try {
        const { zg } = await loadField(fc);
        const s = await fetchObject(fc, flag.obj_id, zg);
        if (!cancelled) setSrc(s ?? "notfound");
      } catch { if (!cancelled) setSrc("notfound"); }
    })();
    return () => { cancelled = true; };
  }, [flag.field, flag.obj_id]);

  return (
    <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "1.25rem", borderLeft: "3px solid var(--amber)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <div className="mono" style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>{flag.field} · ID {flag.obj_id}</span>
          {flag.ra != null && <span> · {flag.ra.toFixed(5)}, {flag.dec?.toFixed(5)}</span>}
          {flag.reason && <div style={{ color: "var(--text)", marginTop: "4px", fontStyle: "italic" }}>“{flag.reason}”</div>}
          <div style={{ color: "var(--text-dim)", fontSize: "0.68rem", marginTop: "2px" }}>flagged {new Date(flag.created_at).toLocaleString()}</div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
          <button onClick={() => onDecide(flag, "confirmed")} className="mono"
            style={{ background: "rgba(224,80,80,0.12)", color: "var(--red)", border: "1px solid rgba(224,80,80,0.4)", borderRadius: "5px", padding: "7px 12px", cursor: "pointer", fontSize: "0.75rem", fontWeight: 700 }}>
            ✓ Confirm spurious
          </button>
          <button onClick={() => onDecide(flag, "dismissed")} className="mono"
            style={{ background: "none", color: "var(--text-muted)", border: "1px solid var(--border-bright)", borderRadius: "5px", padding: "7px 12px", cursor: "pointer", fontSize: "0.75rem" }}>
            Dismiss
          </button>
        </div>
      </div>
      {src === "loading" && <div style={{ padding: "1.5rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>loading card…</div>}
      {src === "notfound" && <div style={{ padding: "1rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>No card available for this source (field/ID not found).</div>}
      {src && src !== "loading" && src !== "notfound" && <ResultCard src={src} />}
    </div>
  );
}
