"use client";
// Admin approval page. Admin-only (the layout also gates /data/admin to admins, but we
// re-check here as the inner guard). Lists every public.profiles row — pending first —
// and lets the owner set each user's role via the admin-only approve_user RPC:
//   Approve → general · Grant key · Set pending
// The site-owner has role='admin' and reaches this via the Admin nav link.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useProfile, type Role } from "@/lib/roles";

type Profile = {
  user_id: string;
  email: string | null;
  role: Role;
  justification: string | null;
  created_at: string;
  // Activity fields — present only when the admin_user_activity RPC is installed (supabase/usage.sql).
  last_sign_in_at?: string | null;
  n_events?: number | null;
  last_event_at?: string | null;
  n_inspections?: number | null;
};

// pending first, then the rest by newest-registered.
const ROLE_ORDER: Record<string, number> = { pending: 0, general: 1, key: 2, admin: 3 };

export default function AdminPage() {
  const { role, loading } = useProfile();
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [err, setErr]   = useState("");
  const [busy, setBusy] = useState<string | null>(null); // user_id currently updating

  const [hasActivity, setHasActivity] = useState(false);
  const load = useCallback(async () => {
    setErr("");
    // Prefer the enriched activity rollup (last sign-in + per-user counts); fall back to the plain
    // profiles select if the RPC isn't installed yet (supabase/usage.sql not run).
    const rpc = await supabase.rpc("admin_user_activity");
    let data = rpc.data as Profile[] | null;
    if (!rpc.error && data) { setHasActivity(true); }
    else {
      setHasActivity(false);
      const sel = await supabase.from("profiles").select("user_id, email, role, justification, created_at");
      if (sel.error) { setErr(sel.error.message); return; }
      data = sel.data as Profile[];
    }
    const sorted = ([...(data ?? [])] as Profile[]).sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 9, rb = ROLE_ORDER[b.role] ?? 9;
      if (ra !== rb) return ra - rb;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    setRows(sorted);
  }, []);

  useEffect(() => { if (role === "admin") load(); }, [role, load]);

  const setRole = async (target: string, new_role: Role, email?: string | null, wasPending?: boolean) => {
    setBusy(target); setErr("");
    const { error } = await supabase.rpc("approve_user", { target, new_role });
    setBusy(null);
    if (error) { setErr(`Update failed: ${error.message}`); return; }
    // On the pending → approved transition, send the user a "you're in" email (best-effort;
    // notify-approved verifies the caller is an admin server-side, so it can't be abused).
    if (wasPending && new_role !== "pending" && email) {
      supabase.functions.invoke("notify-approved", { body: { email } }).catch(() => { /* email is best-effort */ });
    }
    load();
  };

  // Reject / delete a request outright — removes the auth user (cascades to the profile), so the
  // row disappears and they'd have to register again. Uses the admin-only delete_user RPC.
  const deleteReq = async (target: string, email?: string | null) => {
    if (!window.confirm(`Reject and permanently delete this request${email ? ` (${email})` : ""}? They can register again later.`)) return;
    setBusy(target); setErr("");
    const { error } = await supabase.rpc("delete_user", { target });
    setBusy(null);
    if (error) { setErr(`Delete failed: ${error.message}`); return; }
    load();
  };

  if (loading) return <Centered>Checking access…</Centered>;
  if (role !== "admin") return <Centered>Not authorized.</Centered>;

  return (
    <main style={{ maxWidth: "1040px", margin: "0 auto", padding: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <h1 className="page-title" style={{ fontSize: "1.7rem", color: "var(--text)", marginBottom: "2px" }}>
            Access requests
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            {rows == null ? "loading…" : `${rows.length} account${rows.length === 1 ? "" : "s"}`}
            {" · "}Approve grants access; pending accounts see only the public pages.
          </p>
        </div>
        <button onClick={() => load()} className="mono" style={btn("var(--accent2)")}>↻ refresh</button>
      </div>

      {err && <div className="mono" style={{ color: "var(--red)", fontSize: "0.8rem", marginBottom: "1rem" }}>{err}</div>}

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem", letterSpacing: "0.08em" }}>
              <th style={th}>EMAIL</th>
              <th style={th}>ROLE</th>
              <th style={th}>JUSTIFICATION</th>
              <th style={th}>REGISTERED</th>
              {hasActivity && <th style={th}>LAST SIGN-IN</th>}
              {hasActivity && <th style={th}>ACTIVITY</th>}
              <th style={th}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map(p => (
              <tr key={p.user_id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={td}>{p.email ?? <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                <td style={td}><RoleBadge role={p.role} /></td>
                <td style={{ ...td, maxWidth: "320px", color: "var(--text-muted)" }}>
                  {p.justification || <span style={{ color: "var(--text-dim)" }}>—</span>}
                </td>
                <td style={{ ...td, color: "var(--text-dim)", whiteSpace: "nowrap" }} className="mono">
                  {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
                </td>
                {hasActivity && (
                  <td style={{ ...td, color: "var(--text-dim)", whiteSpace: "nowrap" }} className="mono">
                    {p.last_sign_in_at ? new Date(p.last_sign_in_at).toLocaleDateString() : <span style={{ color: "var(--text-dim)" }}>never</span>}
                  </td>
                )}
                {hasActivity && (
                  <td style={{ ...td, color: "var(--text-muted)", whiteSpace: "nowrap", fontSize: "0.78rem" }} className="mono"
                    title={p.last_event_at ? `last active ${new Date(p.last_event_at).toLocaleString()}` : "no tracked events yet"}>
                    {(p.n_events ?? 0)} evt · {(p.n_inspections ?? 0)} insp
                  </td>
                )}
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button disabled={busy === p.user_id} onClick={() => setRole(p.user_id, "general", p.email, p.role === "pending")} style={btn("var(--green)")}>Approve → general</button>
                    <button disabled={busy === p.user_id} onClick={() => setRole(p.user_id, "key", p.email, p.role === "pending")}     style={btn("var(--accent)")}>Grant key</button>
                    <button disabled={busy === p.user_id} onClick={() => setRole(p.user_id, "pending")} style={btn("var(--text-muted)")}>Set pending</button>
                    <button disabled={busy === p.user_id} onClick={() => deleteReq(p.user_id, p.email)} style={btn("var(--red)")}>Reject / delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {rows != null && rows.length === 0 && (
              <tr><td colSpan={hasActivity ? 7 : 5} style={{ ...td, textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>No accounts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function RoleBadge({ role }: { role: Role }) {
  const color =
    role === "admin"   ? "var(--amber)" :
    role === "key"     ? "var(--accent)" :
    role === "general" ? "var(--green)" :
                         "var(--text-dim)";
  return (
    <span className="mono" style={{
      color, border: `1px solid ${color}`, borderRadius: "999px",
      padding: "2px 9px", fontSize: "0.7rem", letterSpacing: "0.04em",
    }}>
      {role}
    </span>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem" }}>
      {children}
    </main>
  );
}

const th: React.CSSProperties = { padding: "12px 14px", fontWeight: 400 };
const td: React.CSSProperties = { padding: "12px 14px", verticalAlign: "top", color: "var(--text)" };

function btn(color: string): React.CSSProperties {
  return {
    background: "transparent", border: "1px solid var(--border-bright)", borderRadius: "5px",
    padding: "5px 10px", color, cursor: "pointer",
    fontFamily: "'Space Mono', monospace", fontSize: "0.72rem",
  };
}
