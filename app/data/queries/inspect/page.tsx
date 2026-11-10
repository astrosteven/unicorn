"use client";
// Per-query PRIVATE inspector (?id=<saved_query>). Builds a queue from the query's snapshot
// obj_ids and lets the user mark Keep / Undecided / Remove — persisted to public.query_inspections
// (per-user, RLS-scoped). This NEVER touches the catalog `selected` flag or the global
// `inspections` table — it's a personal workspace. Reuses the inspector's <InspectCard> for an
// identical card (SED / P(z) / cutout + overlay), has a sortable queue table (like the default
// inspector), and CSV export of the decisions.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase, type SavedQuery, type InspectDecision } from "@/lib/supabase";
import { SEARCH_FIELDS, loadField, loadDb, fetchObject, cachedIndex, type SourceResult } from "@/app/data/_card/objectCard";
import { InspectCard } from "@/app/data/inspect/page";

type Row = {
  field: string; id: number; decision: InspectDecision; notes: string;
  ra: number | null; dec: number | null; za: number | null; mabs: number | null; mstar: number | null;
};
type SortKey = "field" | "id" | "ra" | "dec" | "za" | "mabs" | "mstar" | "decision";
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
  const [sortKey, setSortKey] = useState<SortKey>("za");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);   // default: brightest/highest-z first
  const cardCache = useRef(new Map<string, SourceResult | null>());

  // Load the saved query, build the queue, resume prior decisions, then enrich rows with
  // ra/dec/za/M_UV/M* (from each field's index + db sidecar) so the table can sort on them.
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
      for (const [f, ids] of Object.entries(oi)) for (const id of ids as number[])
        base.push({ field: f, id, decision: "not_inspected", notes: "", ra: null, dec: null, za: null, mabs: null, mstar: null });
      const { data: dec } = await supabase.from("query_inspections").select("field,obj_id,decision,notes").eq("query_id", qid);
      if (cancel) return;
      const m = new Map<string, { decision: InspectDecision; notes: string }>();
      for (const d of (dec ?? []) as { field: string; obj_id: number; decision: InspectDecision; notes: string | null }[])
        m.set(`${d.field}:${d.obj_id}`, { decision: d.decision, notes: d.notes ?? "" });
      for (const r of base) { const x = m.get(rowKey(r)); if (x) { r.decision = x.decision; r.notes = x.notes; } }
      setRows(base);                             // show fast (field/id/decision)…
      if (base.length) setSelKey(rowKey(base[0]));
      // …then enrich with sortable quantities from each field's index + db.
      const fields = [...new Set(base.map(r => r.field))];
      for (const f of fields) {
        const fc = SEARCH_FIELDS.find(x => x.field === f);
        if (!fc) continue;
        await loadField(fc);
        const dbmass = (await loadDb(fc).catch(() => null))?.mass ?? null;
        if (cancel) return;
        const idx = cachedIndex(f);
        if (!idx) continue;
        const pos = new Map<number, number>();
        for (let i = 0; i < idx.n; i++) pos.set(idx.id[i], i);
        for (const r of base) if (r.field === f) {
          const i = pos.get(r.id);
          if (i != null) { r.ra = idx.ra[i] ?? null; r.dec = idx.dec[i] ?? null; r.za = idx.za?.[i] ?? null; r.mabs = idx.mabs?.[i] ?? null; r.mstar = dbmass?.[i] ?? null; }
        }
      }
      if (!cancel) setRows([...base]);           // re-set with enriched values
    })();
    return () => { cancel = true; };
  }, [session, qid]);

  // Sorted view (the queue order the user sees + navigates).
  const view = useMemo(() => {
    if (!rows) return [];
    const get = (r: Row): number | string =>
      sortKey === "field" ? r.field : sortKey === "decision" ? r.decision
        : (r[sortKey] ?? (sortDir === 1 ? Infinity : -Infinity));
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return a.id - b.id;
    });
  }, [rows, sortKey, sortDir]);
  const toggleSort = (k: SortKey) => { if (k === sortKey) setSortDir(d => (d === 1 ? -1 : 1)); else { setSortKey(k); setSortDir(1); } };

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
    const i = view.findIndex(r => rowKey(r) === selKey);   // auto-advance in sorted order
    if (i >= 0 && i + 1 < view.length) setSelKey(rowKey(view[i + 1]));
    const { error } = await supabase.from("query_inspections").upsert(
      { user_id: session.user.id, query_id: qid, field: row.field, obj_id: row.id, decision: d, notes: row.notes || null },
      { onConflict: "query_id,field,obj_id" });
    if (error) console.error("query_inspection save failed:", error.message);
  }, [selKey, rows, view, session, qid]);

  const nav = useCallback((delta: number) => {
    if (!view.length || !selKey) return;
    const i = view.findIndex(r => rowKey(r) === selKey);
    const j = i + delta;
    if (j >= 0 && j < view.length) setSelKey(rowKey(view[j]));
  }, [view, selKey]);
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

  // CSV export of the user's decisions (field, id, ra, dec, decision, notes).
  function exportCsv() {
    if (!rows || !query || query === "notfound") return;
    const lines = ["field,obj_id,ra,dec,decision,notes"];
    for (const r of rows) lines.push(`${r.field},${r.id},${r.ra ?? ""},${r.dec ?? ""},${r.decision},"${(r.notes || "").replace(/"/g, '""')}"`);
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
  const fmt = (v: number | null, d = 2) => v == null ? "—" : v.toFixed(d);

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

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: "1rem", alignItems: "start" }}>
        {/* sortable queue table */}
        <div className="card" style={{ padding: 0, maxHeight: "calc(100vh - 170px)", overflow: "auto", position: "sticky", top: "84px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
              <tr>
                {([["", "decision"], ["field", "field"], ["ID", "id"], ["RA", "ra"], ["Dec", "dec"], ["z_a", "za"], ["M_UV", "mabs"], ["M*", "mstar"]] as [string, SortKey][]).map(([label, key]) => (
                  <th key={key} onClick={() => toggleSort(key)}
                    style={{ padding: "7px 7px", textAlign: key === "decision" ? "center" : key === "field" ? "left" : "right", color: sortKey === key ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", userSelect: "none" }}>
                    {label}{sortKey === key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows == null && <tr><td colSpan={8} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-dim)" }}>loading…</td></tr>}
              {rows && view.length === 0 && <tr><td colSpan={8} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)" }}>No sources in this saved query.</td></tr>}
              {view.map(r => {
                const active = rowKey(r) === selKey;
                return (
                  <tr key={rowKey(r)} onClick={() => setSelKey(rowKey(r))}
                    style={{ cursor: "pointer", background: active ? "rgba(196,144,216,0.16)" : "transparent", borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent" }}>
                    <td style={{ padding: "5px 7px", textAlign: "center" }}>
                      <span title={r.decision} style={{ display: "inline-block", width: "9px", height: "9px", borderRadius: "50%", background: decColor(r.decision), verticalAlign: "middle" }} />
                    </td>
                    <td style={{ padding: "5px 7px", textAlign: "left", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.field}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--accent)", fontWeight: 700 }}>{r.id}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.ra, 5)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.dec, 5)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text)" }}>{fmt(r.za)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.mabs)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.mstar)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
