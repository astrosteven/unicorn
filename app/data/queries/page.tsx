"use client";
// "My Queries" — each logged-in user's private list of saved queries (public.saved_queries,
// RLS-scoped to auth.uid()). From here they open a query's personal inspector (Keep / Undecided
// / Remove, written to public.query_inspections). NONE of this touches the catalog `selected`
// flag or anyone else's data — it's a private workspace. The route is gated to "general"+ in
// lib/roles.ts; this page also self-checks the session.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { supabase, type SavedQuery } from "@/lib/supabase";

type Prog = { keep: number; remove: number; undecided: number; total: number };
type Row = SavedQuery & { id: string; created_at: string; _prog?: Prog };

export default function MyQueriesPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setErr("");
    const { data, error } = await supabase.from("saved_queries")
      .select("id,name,fields,where_expr,catalog_version,n_results,created_at")
      .order("created_at", { ascending: false });
    if (error) { setErr(error.message); setRows([]); return; }
    const base = (data ?? []) as Row[];
    // Per-query decision progress (N+1, fine for a personal list).
    for (const q of base) {
      const { data: d } = await supabase.from("query_inspections").select("decision").eq("query_id", q.id);
      const c: Prog = { keep: 0, remove: 0, undecided: 0, total: d?.length ?? 0 };
      for (const x of (d ?? []) as { decision: string }[]) {
        if (x.decision === "keep") c.keep++; else if (x.decision === "remove") c.remove++;
        else if (x.decision === "undecided") c.undecided++;
      }
      q._prog = c;
    }
    setRows(base);
  }, []);
  useEffect(() => { if (session) load(); }, [session, load]);

  async function rename(q: Row) {
    const name = window.prompt("Rename this query:", q.name);
    if (!name || name === q.name) return;
    const { error } = await supabase.from("saved_queries").update({ name }).eq("id", q.id);
    if (error) { window.alert("Rename failed: " + error.message); return; }
    load();
  }
  async function del(q: Row) {
    if (!window.confirm(`Delete "${q.name}"? This also removes your Keep/Remove decisions for it. (The catalog is unaffected.)`)) return;
    const { error } = await supabase.from("saved_queries").delete().eq("id", q.id);
    if (error) { window.alert("Delete failed: " + error.message); return; }
    load();
  }

  if (checking) return <Centered>Checking session…</Centered>;
  if (!session) return <Centered>Please sign in (Access Data) to see your saved queries.</Centered>;

  return (
    <main style={{ padding: "3rem 2rem", maxWidth: "920px", margin: "0 auto" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 className="page-title" style={{ fontSize: "2rem", color: "var(--text)", marginBottom: "8px" }}>My Queries</h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.92rem", lineHeight: 1.6 }}>
          Queries you&apos;ve saved from the <Link href="/data/search" className="mono" style={{ color: "var(--accent)" }}>Search</Link> page.
          Open one to inspect its sources privately — mark each <b style={{ color: "var(--green)" }}>Keep</b> /{" "}
          <b style={{ color: "var(--amber)" }}>Undecided</b> / <b style={{ color: "var(--red)" }}>Remove</b>. These decisions
          are yours alone and <b>never change the catalog</b> or the selected sample.
        </p>
      </div>

      {err && <div className="mono" style={{ color: "var(--red)", fontSize: "0.8rem", marginBottom: "1rem" }}>{err}</div>}
      {rows == null && <div style={{ color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.85rem" }}>loading…</div>}
      {rows && rows.length === 0 && (
        <div className="card" style={{ padding: "1.5rem", borderLeft: "3px solid var(--purple)", background: "rgba(142,107,184,0.05)" }}>
          <p style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
            No saved queries yet. Run a query on the <Link href="/data/search" style={{ color: "var(--accent)" }}>Search</Link> page
            and click <span className="mono" style={{ color: "var(--amber)" }}>★ save query</span>.
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {rows?.map(q => (
          <div key={q.id} className="card" style={{ padding: "1.1rem 1.4rem", borderLeft: "3px solid var(--accent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px" }}>
              <span style={{ fontFamily: "var(--serif)", fontSize: "1.1rem", fontWeight: 600, color: "var(--text)" }}>{q.name}</span>
              <span className="mono" style={{ fontSize: "0.68rem", color: "var(--text-dim)" }}>
                v{q.catalog_version} · {(q.n_results ?? 0).toLocaleString()} sources · {q.created_at.slice(0, 10)}
              </span>
            </div>
            {q.where_expr && (
              <div className="mono" style={{ fontSize: "0.74rem", color: "var(--text-muted)", marginTop: "5px", wordBreak: "break-word" }}>
                {q.where_expr}{q.fields?.length ? `  ·  ${q.fields.join(", ")}` : ""}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", marginTop: "10px" }}>
              <span className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>
                inspected {q._prog?.total ?? 0}/{(q.n_results ?? 0).toLocaleString()}
                {q._prog && q._prog.total > 0 && (
                  <>  ·  <span style={{ color: "var(--green)" }}>{q._prog.keep} keep</span>
                  {" "}· <span style={{ color: "var(--amber)" }}>{q._prog.undecided} und.</span>
                  {" "}· <span style={{ color: "var(--red)" }}>{q._prog.remove} rem.</span></>
                )}
              </span>
              <span style={{ flex: 1 }} />
              <Link href={`/data/queries/inspect?id=${q.id}`} className="mono"
                style={{ textDecoration: "none", background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid rgba(196,144,216,0.35)", borderRadius: "5px", padding: "5px 14px", fontSize: "0.76rem" }}>
                inspect →
              </Link>
              <button onClick={() => rename(q)} className="mono" style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.72rem", cursor: "pointer" }}>rename</button>
              <button onClick={() => del(q)} className="mono" style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "0.72rem", cursor: "pointer" }}>delete</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem" }}>
      {children}
    </main>
  );
}
