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
  m277: number | null; m444: number | null;
};
type SortKey = "field" | "id" | "ra" | "dec" | "za" | "mabs" | "mstar" | "m277" | "m444" | "decision";
const rowKey = (r: { field: string; id: number }) => `${r.field}:${r.id}`;
const DECS: { key: InspectDecision; label: string; color: string; hot: string }[] = [
  { key: "not_inspected", label: "Not Inspected", color: "var(--text-dim)", hot: "n" },
  { key: "keep",          label: "Keep",          color: "var(--green)",    hot: "k" },
  { key: "undecided",     label: "Undecided",     color: "var(--amber)",    hot: "u" },
  { key: "remove",        label: "Remove",        color: "var(--red)",      hot: "r" },
];
const decColor = (d: InspectDecision) => DECS.find(x => x.key === d)?.color ?? "var(--text-dim)";

// ---- cross-match against an uploaded RA/Dec list ---------------------------
const DEG = Math.PI / 180;
const XM_RA_NAMES = new Set(["ra", "raj2000", "radeg", "ra2000", "alpha", "alphaj2000", "rightascension", "raj", "cra"]);
const XM_DEC_NAMES = new Set(["dec", "de", "decj2000", "decdeg", "dec2000", "delta", "deltaj2000", "declination", "cdec"]);
// Parse a pasted/uploaded list into [ra,dec] pairs (deg). Mirrors the Search page's upload parser:
// optional header row (named RA/Dec columns), else first two numeric columns; '#' comments skipped.
// `bad` = data lines that had no parseable RA/Dec pair.
function parseUploadList(text: string): { coords: [number, number][]; bad: number } {
  const split = (l: string) => l.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { coords: [], bad: 0 };
  let raCol = -1, decCol = -1, hdr = false;
  const head = split(lines[0].replace(/^#+\s*/, ""));
  if (head.length && head.every(t => !Number.isFinite(parseFloat(t)))) {
    head.forEach((t, i) => {
      const k = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (raCol < 0 && XM_RA_NAMES.has(k)) raCol = i;
      else if (decCol < 0 && XM_DEC_NAMES.has(k)) decCol = i;
    });
    hdr = true;
  }
  const data = (hdr ? lines.slice(1) : lines).filter(l => !l.startsWith("#"));
  const coords: [number, number][] = []; let bad = 0;
  for (const line of data) {
    const p = split(line);
    const ra = raCol >= 0 && decCol >= 0 ? parseFloat(p[raCol]) : (p.length >= 2 ? parseFloat(p[0]) : NaN);
    const dec = raCol >= 0 && decCol >= 0 ? parseFloat(p[decCol]) : (p.length >= 2 ? parseFloat(p[1]) : NaN);
    if (Number.isFinite(ra) && Number.isFinite(dec)) coords.push([ra, dec]); else bad++;
  }
  return { coords, bad };
}

type XmResult = {
  matched: Set<string>;   // rowKeys of query sources with ≥1 upload counterpart within radius
  qWithCoords: number; qMatched: number;
  uTotal: number; uMatched: number; uBad: number; radius: number;
};
// Two-sided positional cross-match: query rows (that have ra/dec) vs uploaded coords, within
// radiusArcsec. O(N+M) via an angular grid (RA scaled by cos(dec) so cells are ~square on sky).
function crossMatchUpload(rows: Row[], ups: [number, number][], radiusArcsec: number): Omit<XmResult, "uBad"> {
  const cell = radiusArcsec / 3600;                     // deg
  const toX = (ra: number, dec: number) => ra * Math.cos(dec * DEG);
  const q = rows.filter(r => r.ra != null && r.dec != null) as (Row & { ra: number; dec: number })[];
  const grid = new Map<string, number[]>();
  q.forEach((r, i) => {
    const k = `${Math.floor(toX(r.ra, r.dec) / cell)}:${Math.floor(r.dec / cell)}`;
    const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]);
  });
  const matched = new Set<string>();
  let uMatched = 0;
  for (const [ra, dec] of ups) {
    const cx = Math.floor(toX(ra, dec) / cell), cy = Math.floor(dec / cell);
    let hit = false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = grid.get(`${cx + dx}:${cy + dy}`); if (!a) continue;
      for (const i of a) {
        const r = q[i];
        const ddec = r.dec - dec;
        const dra = (r.ra - ra) * Math.cos(((r.dec + dec) / 2) * DEG);
        if (Math.sqrt(dra * dra + ddec * ddec) * 3600 <= radiusArcsec) { matched.add(rowKey(r)); hit = true; }
      }
    }
    if (hit) uMatched++;
  }
  return { matched, qWithCoords: q.length, qMatched: matched.size, uTotal: ups.length, uMatched, radius: radiusArcsec };
}

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
  // Cross-match against an uploaded RA/Dec list (exploration aid; never persisted / never touches the catalog).
  const [xmText, setXmText] = useState("");
  const [xmRadius, setXmRadius] = useState("0.5");
  const [xmOpen, setXmOpen] = useState(false);
  const [xm, setXm] = useState<XmResult | null>(null);
  const [xmFilter, setXmFilter] = useState<"all" | "in" | "out">("all");

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
        base.push({ field: f, id, decision: "not_inspected", notes: "", ra: null, dec: null, za: null, mabs: null, mstar: null, m277: null, m444: null });
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
          if (i != null) { r.ra = idx.ra[i] ?? null; r.dec = idx.dec[i] ?? null; r.za = idx.za?.[i] ?? null; r.mabs = idx.mabs?.[i] ?? null; r.mstar = dbmass?.[i] ?? null; r.m277 = idx.m277?.[i] ?? null; r.m444 = idx.m444?.[i] ?? null; }
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

  // The cross-match filter sits on top of the sorted view → what the table shows and nav/decide walk.
  const shown = useMemo(() => {
    if (!xm || xmFilter === "all") return view;
    return view.filter(r => (xmFilter === "in") === xm.matched.has(rowKey(r)));
  }, [view, xm, xmFilter]);

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
    const i = shown.findIndex(r => rowKey(r) === selKey);   // auto-advance in the current (filtered) order
    if (i >= 0 && i + 1 < shown.length) setSelKey(rowKey(shown[i + 1]));
    const { error } = await supabase.from("query_inspections").upsert(
      { user_id: session.user.id, query_id: qid, field: row.field, obj_id: row.id, decision: d, notes: row.notes || null },
      { onConflict: "query_id,field,obj_id" });
    if (error) console.error("query_inspection save failed:", error.message);
  }, [selKey, rows, shown, session, qid]);

  const nav = useCallback((delta: number) => {
    if (!shown.length || !selKey) return;
    const i = shown.findIndex(r => rowKey(r) === selKey);
    const j = i + delta;
    if (j >= 0 && j < shown.length) setSelKey(rowKey(shown[j]));
  }, [shown, selKey]);
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

  function runXmatch() {
    if (!rows) return;
    const { coords, bad } = parseUploadList(xmText);
    setXm({ ...crossMatchUpload(rows, coords, parseFloat(xmRadius) || 0.5), uBad: bad });
    setXmFilter("all");
  }
  function clearXmatch() { setXm(null); setXmFilter("all"); }
  function onXmFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader(); rd.onload = ev => setXmText((ev.target?.result as string) ?? ""); rd.readAsText(f);
  }

  // CSV export of the user's decisions (field, id, ra, dec, decision, notes; + in_upload if cross-matched).
  function exportCsv() {
    if (!rows || !query || query === "notfound") return;
    const hasXm = !!xm;
    const lines = ["field,obj_id,ra,dec,za,m277,m444,decision,notes" + (hasXm ? ",in_upload" : "")];
    for (const r of rows) {
      const inUp = hasXm ? (xm!.matched.has(rowKey(r)) ? ",1" : ",0") : "";
      lines.push(`${r.field},${r.id},${r.ra ?? ""},${r.dec ?? ""},${r.za ?? ""},${r.m277 ?? ""},${r.m444 ?? ""},${r.decision},"${(r.notes || "").replace(/"/g, '""')}"${inUp}`);
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
  const fmt = (v: number | null, d = 2) => v == null ? "—" : v.toFixed(d);

  return (
    <main style={{ padding: "1.5rem 2rem", maxWidth: "1400px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "10px", marginBottom: "4px" }}>
        <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)" }}>{query?.name ?? "…"}</h1>
        <span className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>
          <Link href="/data/queries" style={{ color: "var(--accent)", textDecoration: "none" }}>← My Queries</Link>
          {query && query.where_expr && !query.where_expr.startsWith("[") && (
            <>  ·  <Link href={`/data/search?q=${encodeURIComponent(query.where_expr)}`} title="Open this query in Search to edit or re-run it"
              style={{ color: "var(--accent)", textDecoration: "none" }}>↻ open in Search</Link></>
          )}
          {query && <>  ·  v{query.catalog_version} · {(query.n_results ?? 0).toLocaleString()} sources</>}
          {prog && <>  ·  inspected {prog.total}/{rows!.length}  (<span style={{ color: "var(--green)" }}>{prog.keep}k</span>/<span style={{ color: "var(--amber)" }}>{prog.undecided}u</span>/<span style={{ color: "var(--red)" }}>{prog.remove}r</span>)</>}
          {"  ·  "}
          <button onClick={exportCsv} className="mono" style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.72rem", padding: 0 }}>↓ export CSV</button>
        </span>
      </div>
      <p className="mono" style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginBottom: "12px" }}>
        private workspace — these decisions never change the catalog · keys: k keep · u undecided · r remove · n reset · ↑/↓ nav
      </p>

      {/* Cross-match this query against an uploaded RA/Dec list (exploration aid — never persisted) */}
      <div className="card" style={{ padding: "0.6rem 1rem", marginBottom: "12px", borderLeft: "3px solid var(--purple)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button onClick={() => setXmOpen(o => !o)} className="mono" style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.8rem", padding: 0 }}>
            {xmOpen ? "▾" : "▸"} cross-match vs upload list
          </button>
          {xm && (
            <span className="mono" style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              query <b style={{ color: "var(--green)" }}>{xm.qMatched.toLocaleString()}</b>/{xm.qWithCoords.toLocaleString()} matched ({xm.qWithCoords ? Math.round(100 * xm.qMatched / xm.qWithCoords) : 0}%)
              {"  ·  "}upload <b style={{ color: "var(--green)" }}>{xm.uMatched.toLocaleString()}</b>/{xm.uTotal.toLocaleString()} matched, <b style={{ color: "var(--amber)" }}>{(xm.uTotal - xm.uMatched).toLocaleString()}</b> not in query
              {xm.uBad > 0 && <>  ·  <span style={{ color: "var(--red)" }}>{xm.uBad} unparsed</span></>}
              {"  ·  "}r={xm.radius}&Prime;
            </span>
          )}
          <span style={{ flex: 1 }} />
          {xm && (
            <span className="mono" style={{ fontSize: "0.72rem", display: "flex", gap: "6px", alignItems: "center" }}>
              <span style={{ color: "var(--text-dim)" }}>show:</span>
              {(["all", "in", "out"] as const).map(v => (
                <button key={v} onClick={() => setXmFilter(v)}
                  style={{ background: xmFilter === v ? "var(--accent-dim)" : "transparent", color: xmFilter === v ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--border)", borderRadius: "4px", padding: "2px 8px", cursor: "pointer", fontFamily: "inherit", fontSize: "0.7rem" }}>
                  {v === "all" ? "all" : v === "in" ? "in upload" : "not in upload"}
                </button>
              ))}
              <button onClick={clearXmatch} title="clear cross-match" style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "0.8rem" }}>✕</button>
            </span>
          )}
        </div>
        {xmOpen && (
          <div style={{ marginTop: "10px", display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-start" }}>
            <textarea value={xmText} onChange={e => setXmText(e.target.value)} spellCheck={false}
              placeholder={"Paste RA Dec per line (deg). Optional header row (ra,dec); # comments ignored.\n214.9106 52.8821\n214.9231, 52.9004"}
              style={{ flex: "1 1 320px", minHeight: "76px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "5px", padding: "7px 9px", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem", resize: "vertical" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "7px", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem" }}>
              <label style={{ color: "var(--text-dim)" }}>radius (&Prime;)
                <input value={xmRadius} onChange={e => setXmRadius(e.target.value)} inputMode="decimal"
                  style={{ width: "58px", marginLeft: "6px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "4px", padding: "3px 6px", fontFamily: "inherit", fontSize: "0.72rem" }} />
              </label>
              <label className="mono" style={{ color: "var(--accent)", cursor: "pointer" }}>
                ↑ load file
                <input type="file" accept=".txt,.csv,.dat,.tsv" onChange={onXmFile} style={{ display: "none" }} />
              </label>
              <button onClick={runXmatch} disabled={!xmText.trim()}
                style={{ background: xmText.trim() ? "linear-gradient(135deg, var(--purple-mid), var(--lavender))" : "var(--bg-card2)", color: xmText.trim() ? "var(--text)" : "var(--text-dim)", border: "none", borderRadius: "4px", padding: "6px 14px", cursor: xmText.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: "0.74rem" }}>
                cross-match
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: "1rem", alignItems: "start" }}>
        {/* sortable queue table */}
        <div className="card" style={{ padding: 0, maxHeight: "calc(100vh - 170px)", overflow: "auto", position: "sticky", top: "84px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
              <tr>
                {xm && <th title="in upload list" style={{ padding: "7px 5px", textAlign: "center", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>⊕</th>}
                {([["", "decision"], ["field", "field"], ["ID", "id"], ["RA", "ra"], ["Dec", "dec"], ["z_a", "za"], ["M_UV", "mabs"], ["m277", "m277"], ["m444", "m444"], ["M*", "mstar"]] as [string, SortKey][]).map(([label, key]) => (
                  <th key={key} onClick={() => toggleSort(key)}
                    style={{ padding: "7px 7px", textAlign: key === "decision" ? "center" : key === "field" ? "left" : "right", color: sortKey === key ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", userSelect: "none" }}>
                    {label}{sortKey === key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows == null && <tr><td colSpan={10 + (xm ? 1 : 0)} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-dim)" }}>loading…</td></tr>}
              {rows && view.length === 0 && <tr><td colSpan={10 + (xm ? 1 : 0)} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)" }}>No sources in this saved query.</td></tr>}
              {rows && view.length > 0 && shown.length === 0 && <tr><td colSpan={10 + (xm ? 1 : 0)} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)" }}>No sources {xmFilter === "in" ? "matched in the upload list" : "outside the upload list"}.</td></tr>}
              {shown.map(r => {
                const active = rowKey(r) === selKey;
                return (
                  <tr key={rowKey(r)} onClick={() => setSelKey(rowKey(r))}
                    style={{ cursor: "pointer", background: active ? "rgba(196,144,216,0.16)" : "transparent", borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent" }}>
                    {xm && <td style={{ padding: "5px 5px", textAlign: "center" }}>{xm.matched.has(rowKey(r)) ? <span title="in upload list" style={{ color: "#56c7d6", fontWeight: 700 }}>⊕</span> : <span style={{ color: "var(--text-dim)", opacity: 0.4 }}>·</span>}</td>}
                    <td style={{ padding: "5px 7px", textAlign: "center" }}>
                      <span title={r.decision} style={{ display: "inline-block", width: "9px", height: "9px", borderRadius: "50%", background: decColor(r.decision), verticalAlign: "middle" }} />
                    </td>
                    <td style={{ padding: "5px 7px", textAlign: "left", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.field}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--accent)", fontWeight: 700 }}>{r.id}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.ra, 5)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.dec, 5)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text)" }}>{fmt(r.za)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.mabs)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.m277)}</td>
                    <td style={{ padding: "5px 7px", textAlign: "right", color: "var(--text-muted)" }}>{fmt(r.m444)}</td>
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
