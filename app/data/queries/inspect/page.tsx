"use client";
// Per-query PRIVATE inspector (?id=<saved_query>). Builds a queue from the query's snapshot
// obj_ids and lets the user mark Keep / Undecided / Remove — persisted to public.query_inspections
// (per-user, RLS-scoped). This NEVER touches the catalog `selected` flag or the global
// `inspections` table — it's a personal workspace. Reuses the inspector's <InspectCard> for an
// identical card (SED / P(z) / cutout + overlay), plus CSV export of the decisions.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase, type SavedQuery, type InspectDecision } from "@/lib/supabase";
import { SEARCH_FIELDS, loadField, fetchObject, cachedIndex, type SourceResult } from "@/app/data/_card/objectCard";
import { InspectCard } from "@/app/data/inspect/page";

type Row = { field: string; id: number; decision: InspectDecision; notes: string };
const rowKey = (r: { field: string; id: number }) => `${r.field}:${r.id}`;
const DECS: { key: InspectDecision; label: string; color: string; hot: string }[] = [
  { key: "not_inspected", label: "Not Inspected", color: "var(--text-dim)", hot: "n" },
  { key: "keep",          label: "Keep",          color: "var(--green)",    hot: "k" },
  { key: "undecided",     label: "Undecided",     color: "var(--amber)",    hot: "u" },
  { key: "remove",        label: "Remove",        color: "var(--red)",      hot: "r" },
];
const decColor = (d: InspectDecision) => DECS.find(x => x.key === d)?.color ?? "var(--text-dim)";

export default function Page() {
  return <Suspense fallback={<Centered>Loading…</Centered>}><Inner /></Suspense>;
}

function Inner() {
  const qid = useSearchParams().get("id");
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const [query, setQuery] = useState<SavedQuery | null | "notfound">(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [card, setCard] = useState<SourceResult | null | "loading" | "notfound">(null);
  const cardCache = useRef(new Map<string, SourceResult | null>());

  // Load the saved query + build the queue from its snapshot + resume prior decisions.
  useEffect(() => {
    if (!session || !qid) return;
    let cancel = false;
    (async () => {
      const { data, error } = await supabase.from("saved_queries").select("*").eq("id", qid).single();
      if (cancel) return;
      if (error || !data) { setQuery("notfound"); return; }
      setQuery(data as SavedQuery);
      const oi = (data as SavedQuery).obj_ids || {};
      const base: Row[] = [];
      for (const [f, ids] of Object.entries(oi)) for (const id of ids as number[]) base.push({ field: f, id, decision: "not_inspected", notes: "" });
      const { data: dec } = await supabase.from("query_inspections").select("field,obj_id,decision,notes").eq("query_id", qid);
      if (cancel) return;
      const m = new Map<string, { decision: InspectDecision; notes: string }>();
      for (const d of (dec ?? []) as { field: string; obj_id: number; decision: InspectDecision; notes: string | null }[])
        m.set(`${d.field}:${d.obj_id}`, { decision: d.decision, notes: d.notes ?? "" });
      for (const r of base) { const x = m.get(rowKey(r)); if (x) { r.decision = x.decision; r.notes = x.notes; } }
      setRows(base);
      if (base.length) setSelKey(rowKey(base[0]));
    })();
    return () => { cancel = true; };
  }, [session, qid]);

  // Load the selected object's card (cached per row).
  useEffect(() => {
    if (!selKey || !rows) return;
    const row = rows.find(r => rowKey(r) === selKey);
    if (!row) return;
    const cached = cardCache.current.get(selKey);
    if (cached !== undefined) { setCard(cached ?? "notfound"); return; }
    setCard("loading");
    const fc = SEARCH_FIELDS.find(f => f.field === row.field);
    if (!fc) { setCard("notfound"); return; }
    let cancel = false;
    (async () => {
      const { zg } = await loadField(fc);
      const s = await fetchObject(fc, row.id, zg);
      if (cancel) return;
      cardCache.current.set(selKey, s);
      setCard(s ?? "notfound");
    })();
    return () => { cancel = true; };
  }, [selKey, rows]);

  const sel = useMemo(() => rows?.find(r => rowKey(r) === selKey) ?? null, [rows, selKey]);

  const decide = useCallback(async (d: InspectDecision) => {
    if (!selKey || !rows || !session || !qid) return;
    const row = rows.find(r => rowKey(r) === selKey);
    if (!row) return;
    setRows(rs => rs!.map(r => rowKey(r) === selKey ? { ...r, decision: d } : r));
    const i = rows.findIndex(r => rowKey(r) === selKey);
    if (i >= 0 && i + 1 < rows.length) setSelKey(rowKey(rows[i + 1]));   // auto-advance
    const { error } = await supabase.from("query_inspections").upsert(
      { user_id: session.user.id, query_id: qid, field: row.field, obj_id: row.id, decision: d, notes: row.notes || null },
      { onConflict: "query_id,field,obj_id" });
    if (error) console.error("query_inspection save failed:", error.message);
  }, [selKey, rows, session, qid]);

  // Keyboard: k/u/r/n decide + auto-advance; ↓/j and ↑ navigate.
  const nav = useCallback((delta: number) => {
    if (!rows || !selKey) return;
    const i = rows.findIndex(r => rowKey(r) === selKey);
    const j = i + delta;
    if (j >= 0 && j < rows.length) setSelKey(rowKey(rows[j]));
  }, [rows, selKey]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === "k") decide("keep");
      else if (k === "u") decide("undecided");
      else if (k === "r") decide("remove");
      else if (k === "n") decide("not_inspected");
      else if (k === "arrowdown" || k === "j") { nav(1); e.preventDefault(); }
      else if (k === "arrowup") { nav(-1); e.preventDefault(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [decide, nav]);

  // CSV export of the user's decisions (field, id, ra, dec via the loaded index, decision, notes).
  async function exportCsv() {
    if (!rows || !query || query === "notfound") return;
    const fields = [...new Set(rows.map(r => r.field))];
    for (const f of fields) { const fc = SEARCH_FIELDS.find(x => x.field === f); if (fc) await loadField(fc); }
    const pos: Record<string, Map<number, number>> = {};
    for (const f of fields) { const idx = cachedIndex(f); if (idx) { const m = new Map<number, number>(); for (let i = 0; i < idx.n; i++) m.set(idx.id[i], i); pos[f] = m; } }
    const lines = ["field,obj_id,ra,dec,decision,notes"];
    for (const r of rows) {
      const idx = cachedIndex(r.field); const p = pos[r.field]?.get(r.id);
      const ra = idx && p != null ? idx.ra[p] : "", dec = idx && p != null ? idx.dec[p] : "";
      lines.push(`${r.field},${r.id},${ra},${dec},${r.decision},"${(r.notes || "").replace(/"/g, '""')}"`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(query.name || "query").replace(/[^a-z0-9]+/gi, "_")}_decisions.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (checking) return <Centered>Checking session…</Centered>;
  if (!session) return <Centered>Please sign in to inspect your saved queries.</Centered>;
  if (!qid || query === "notfound") return <Centered>Query not found. <Link href="/data/queries" style={{ color: "var(--accent)" }}>← My Queries</Link></Centered>;

  const prog = rows ? { total: rows.filter(r => r.decision !== "not_inspected").length, keep: rows.filter(r => r.decision === "keep").length, remove: rows.filter(r => r.decision === "remove").length, undecided: rows.filter(r => r.decision === "undecided").length } : null;

  return (
    <main style={{ padding: "1.5rem 2rem", maxWidth: "1400px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "10px", marginBottom: "4px" }}>
        <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)" }}>{query?.name ?? "…"}</h1>
        <span className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>
          <Link href="/data/queries" style={{ color: "var(--accent)", textDecoration: "none" }}>← My Queries</Link>
          {query && <>  ·  v{query.catalog_version} · {(query.n_results ?? 0).toLocaleString()} sources</>}
          {prog && <>  ·  inspected {prog.total}/{rows!.length}  (<span style={{ color: "var(--green)" }}>{prog.keep}k</span>/<span style={{ color: "var(--amber)" }}>{prog.undecided}u</span>/<span style={{ color: "var(--red)" }}>{prog.remove}r</span>)</>}
          {"  ·  "}
          <button onClick={exportCsv} className="mono" style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.72rem", padding: 0 }}>↓ export CSV</button>
        </span>
      </div>
      <p className="mono" style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginBottom: "12px" }}>
        private workspace — these decisions never change the catalog · keys: k keep · u undecided · r remove · n reset · ↑/↓ nav
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: "1rem", alignItems: "start" }}>
        {/* queue */}
        <div className="card" style={{ padding: 0, maxHeight: "calc(100vh - 170px)", overflow: "auto", position: "sticky", top: "84px" }}>
          {rows == null && <div style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-dim)" }}>loading…</div>}
          {rows && rows.length === 0 && <div style={{ padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>No sources in this saved query.</div>}
          {rows?.map(r => {
            const active = rowKey(r) === selKey;
            return (
              <div key={rowKey(r)} onClick={() => setSelKey(rowKey(r))}
                style={{ cursor: "pointer", padding: "6px 10px", display: "flex", alignItems: "center", gap: "8px", background: active ? "rgba(196,144,216,0.16)" : "transparent", borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent", borderBottom: "1px solid var(--border)" }}>
                <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: decColor(r.decision), flexShrink: 0 }} />
                <span className="mono" style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{r.field}</span>
                <span className="mono" style={{ fontSize: "0.72rem", color: "var(--accent)", fontWeight: 700, marginLeft: "auto" }}>{r.id}</span>
              </div>
            );
          })}
        </div>

        {/* card + decision bar */}
        <div style={{ minWidth: 0 }}>
          {sel && (
            <div className="card" style={{ padding: "0.7rem 1rem", marginBottom: "10px", position: "sticky", top: "84px", zIndex: 2, display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: "0.8rem", color: "var(--accent)", fontWeight: 700, marginRight: "6px" }}>{sel.field} · ID {sel.id}</span>
              {DECS.map(d => (
                <button key={d.key} onClick={() => decide(d.key)}
                  style={{ background: sel.decision === d.key ? d.color : "transparent", color: sel.decision === d.key ? "#0d0a1a" : d.color, border: `1px solid ${d.color}`, borderRadius: "5px", padding: "5px 12px", cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "0.78rem", fontWeight: sel.decision === d.key ? 700 : 400 }}>
                  {d.label} <span style={{ opacity: 0.6 }}>{d.hot}</span>
                </button>
              ))}
            </div>
          )}
          {card === "loading" && <div className="card" style={{ padding: "1.5rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>loading card…</div>}
          {card === "notfound" && <div className="card" style={{ padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>No card available for this source.</div>}
          {card == null && !sel && <div className="card" style={{ padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>Select a source to inspect.</div>}
          {card && card !== "loading" && card !== "notfound" && <InspectCard src={card} />}
        </div>
      </div>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem" }}>{children}</main>;
}
