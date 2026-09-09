"use client";
// Visual-inspection tool. A fast, keyboard-driven queue for the PI to triage high-z
// candidates keep/undecided/remove/not-inspected, persisting each decision to Supabase
// (public.inspections, one row per field+obj_id). Gated by Supabase Auth exactly like
// /data/review. Two panes: a sortable/searchable/filterable queue table on the left, and
// the selected object's full ResultCard (SED / P(z) / cutouts) + a decision bar on the
// right. Advancing is instant because the next few rows' cards are prefetched in the
// background; decisions update the left dot optimistically and sync to Supabase off the
// render path. Replaces the old desktop "inspector" app.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Inspection, type InspectDecision } from "@/lib/supabase";
import {
  SEARCH_FIELDS, loadField, fetchObject, SEDPlot, PZPlot, StampMontage,
  type SourceResult, type FieldConfig, type FieldIndex,
} from "@/app/data/_card/objectCard";

// On-the-fly WebGL color cutout (client-only), same as the card uses.
const FitsglCutout = dynamic(() => import("@/app/data/_card/FitsglCutout").then(m => m.FitsglCutout), { ssr: false });
// Inspection color cutout: 1.5" on a side, stretched hard (bring up faint flux) so it
// works as a quick "is this real?" check. Tunable.
const INSPECT_FOV = 1.5;
const INSPECT_TRILOGY = { noiselum: 0.32, noisesig: 1.0, noisesig0: 1.0 };

// ---------------------------------------------------------------------------
export default function InspectPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <Centered>Checking session…</Centered>;
  if (!session) return <LoginForm />;
  return <Inspector email={session.user.email ?? ""} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)", fontFamily: "'Space Mono', monospace", fontSize: "0.9rem" }}>
      {children}
    </main>
  );
}

// ---- Supabase Auth login (identical gate to /data/review) ------------------
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
      <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "4px" }}>Inspection queue</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginBottom: "1.5rem" }}>
        Inspector sign-in (Supabase). Only authorized users can triage candidates.
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

// ---------------------------------------------------------------------------
// Queue model. IDs are NOT unique across fields (CEERS 100 ≠ EGS 100), so every row is
// identified by the composite key `${field}:${id}` — never a bare id.
type QueueRow = {
  field: string;
  id: number;
  ra: number | null;
  dec: number | null;
  za: number | null;
  mabs: number | null;
  decision: InspectDecision;   // resumed from Supabase, else "not_inspected"
  notes: string;
};
// The composite identity of a row.
const rowKey = (r: QueueRow) => `${r.field}:${r.id}`;

type SortKey = "field" | "id" | "ra" | "dec" | "za" | "mabs" | "decision";
type SaveState = "idle" | "saving" | "saved" | "error";

const DECISIONS: { key: InspectDecision; label: string; color: string; hot: string }[] = [
  { key: "not_inspected", label: "Not Inspected", color: "var(--text-dim)", hot: "n" },
  { key: "keep",          label: "Keep",          color: "var(--green)",    hot: "k" },
  { key: "undecided",     label: "Undecided",     color: "var(--amber)",    hot: "u" },
  { key: "remove",        label: "Remove",        color: "var(--red)",      hot: "r" },
];
function decColor(d: InspectDecision): string {
  return DECISIONS.find(x => x.key === d)?.color ?? "var(--text-dim)";
}

// Availability-gated field list (default CEERS first).
const FIELDS = SEARCH_FIELDS.filter(f => f.available);

// ---- The inspector (two panes) ---------------------------------------------
function Inspector({ email }: { email: string }) {
  // A one-time "send to inspector" handoff from the search page (else null → normal mode).
  const [external] = useState<ExternalQueue | null>(() => readHandoff());
  // Fields in play: the handoff's fields, or all available fields.
  const fields = useMemo(() => (external ? externalFields(external) : FIELDS), [external]);
  // The field selector: "all" (default) merges every field's queue into one, else a
  // single field name. IDs collide across fields, so rows carry their field.
  const [fieldSel, setFieldSel] = useState<string>("all");
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [minZa, setMinZa] = useState(7);
  const [selectedOnly, setSelectedOnly] = useState(true);   // only inspect selected=1 objects
  const [search, setSearch] = useState("");
  const [decFilter, setDecFilter] = useState<"all" | InspectDecision>("all");
  const [sortKey, setSortKey] = useState<SortKey>("za");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);   // za desc by default (highest-z first)
  const [selKey, setSelKey] = useState<string | null>(null);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // SourceResult cache keyed by `${field}:${id}` — powers instant advance via prefetch.
  const cardCache = useRef<Map<string, SourceResult | null>>(new Map());
  // In-flight card fetches, so prefetch + the active load don't double-fetch.
  const inflight = useRef<Map<string, Promise<SourceResult | null>>>(new Map());

  // The currently-shown card (looked up / fetched from the cache).
  const [card, setCard] = useState<SourceResult | null | "loading" | "notfound">(null);

  // -- load one or all fields: build each queue from its index, resume decisions from
  // Supabase, and reveal fields progressively (setRows after each field completes) so
  // the user can start triaging CEERS while COSMOS's big index is still downloading. --
  const load = useCallback(async (fSel: string, minz: number, selOnly: boolean) => {
    setRows(null); setLoadErr(""); setSelKey(null); setCard(null);
    cardCache.current.clear(); inflight.current.clear();

    const targets = (external ? externalFields(external) : FIELDS)
      .filter(f => fSel === "all" || f.field === fSel);

    // Fetch ALL inspections once (no field filter) → map by `${field}:${obj_id}`.
    // Best-effort: table may be empty/absent → degrade to all-not_inspected.
    const byKey = new Map<string, Inspection>();
    try {
      const { data, error } = await supabase.from("inspections").select("*");
      if (!error && data) for (const r of data as Inspection[]) byKey.set(`${r.field}:${r.obj_id}`, r);
    } catch { /* table missing / offline */ }

    const acc: QueueRow[] = [];
    try {
      for (const f of targets) {
        const { idx } = await loadField(f);
        const built = external
          ? external.objects.filter(o => o.field === f.field).map(extToRow)
          : buildQueue(idx, f.field, minz, selOnly);
        for (const row of built) {
          const rec = byKey.get(rowKey(row));
          if (rec) { row.decision = rec.decision; row.notes = rec.notes ?? ""; }
        }
        acc.push(...built);
        setRows([...acc]);   // progressive: reveal this field's rows now
      }
      if (!targets.length) setRows([]);   // nothing selected → empty queue
    } catch (e: any) {
      setLoadErr(`Could not load queue: ${e?.message ?? e}`);
      setRows([...acc]);   // keep whatever loaded before the error
    }
  }, [external]);

  // One effect: (re)load whenever the field selection or the queue filters change.
  useEffect(() => { load(fieldSel, minZa, selectedOnly); }, [fieldSel, minZa, selectedOnly, load]);

  // -- derived: filtered + sorted view of the queue --
  const view = useMemo(() => {
    if (!rows) return [];
    let v = rows;
    if (decFilter !== "all") v = v.filter(r => r.decision === decFilter);
    const q = search.trim();
    if (q) v = v.filter(r => String(r.id).includes(q));
    const get = (r: QueueRow): number | string => {
      if (sortKey === "decision") return r.decision;
      if (sortKey === "field") return r.field;
      const val = r[sortKey];
      return val == null ? (sortDir === 1 ? Infinity : -Infinity) : val;
    };
    return [...v].sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      // stable tiebreak on composite identity
      if (a.field !== b.field) return a.field < b.field ? -1 : 1;
      return a.id - b.id;
    });
  }, [rows, decFilter, search, sortKey, sortDir]);

  // Keep a ref to the current view for keyboard nav without stale closures.
  const viewRef = useRef(view); viewRef.current = view;
  const selKeyRef = useRef(selKey); selKeyRef.current = selKey;

  // -- fetch (or hit cache for) a single row's card. Resolves the row's field config and
  // its (cached) zgrid, so this works across fields in the merged "all" queue. --
  const getCard = useCallback((row: QueueRow): Promise<SourceResult | null> => {
    const key = rowKey(row);
    if (cardCache.current.has(key)) return Promise.resolve(cardCache.current.get(key)!);
    const existing = inflight.current.get(key);
    if (existing) return existing;
    const fc = SEARCH_FIELDS.find(f => f.field === row.field);
    const p = (async () => {
      if (!fc) return null;
      const { zg } = await loadField(fc);   // cached per field → fast after first load
      const s = await fetchObject(fc, row.id, zg);
      cardCache.current.set(key, s);
      inflight.current.delete(key);
      return s;
    })();
    inflight.current.set(key, p);
    return p;
  }, []);

  // -- prefetch the next N rows (cards + stamp images) so advancing is instant --
  const prefetchAround = useCallback((key: string) => {
    const v = viewRef.current;
    const pos = v.findIndex(r => rowKey(r) === key);
    if (pos < 0) return;
    for (let k = 1; k <= 3; k++) {
      const nxt = v[pos + k];
      if (!nxt) break;
      getCard(nxt).then(src => {
        // Warm the stamp montage image too, so the montage paints instantly.
        if (src?.stampUrl && typeof Image !== "undefined") { const im = new Image(); im.src = src.stampUrl; }
      });
    }
  }, [getCard]);

  // -- select a row: show its card (from cache if warm), then prefetch ahead --
  const selectRow = useCallback((row: QueueRow) => {
    const key = rowKey(row);
    setSelKey(key);
    if (cardCache.current.has(key)) {
      setCard(cardCache.current.get(key) ?? "notfound");
    } else {
      setCard("loading");
      getCard(row).then(src => {
        // Only apply if this row is still the selected one.
        if (selKeyRef.current === key) setCard(src ?? "notfound");
      });
    }
    prefetchAround(key);
  }, [getCard, prefetchAround]);

  // Auto-select the first row once the view is ready and nothing is selected.
  useEffect(() => {
    if (selKey == null && view.length) selectRow(view[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.length]);

  // -- navigation within the current (filtered/sorted) view --
  const step = useCallback((delta: number) => {
    const v = viewRef.current;
    if (!v.length) return;
    const cur = selKeyRef.current;
    const pos = cur == null ? -1 : v.findIndex(r => rowKey(r) === cur);
    const next = v[Math.max(0, Math.min(v.length - 1, pos + delta))];
    if (next) selectRow(next);
  }, [selectRow]);

  // -- record a decision: optimistic local update + background Supabase upsert --
  const decide = useCallback((decision: InspectDecision, notesOverride?: string) => {
    const key = selKeyRef.current;
    if (key == null) return;
    let saved: QueueRow | undefined;
    setRows(prev => {
      if (!prev) return prev;
      return prev.map(r => {
        if (rowKey(r) !== key) return r;
        saved = { ...r, decision, notes: notesOverride ?? r.notes };
        return saved;
      });
    });
    if (!saved) return;
    // Fire-and-forget upsert (do NOT block UI). onConflict keeps one row per field+obj.
    void upsert(saved, email, setSaveState);
    // Auto-advance after a decision (not for a bare notes edit).
    if (autoAdvance && notesOverride === undefined) step(1);
  }, [email, autoAdvance, step]);

  // Debounced notes save (500ms) — edits the selected row's notes, then upserts.
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editNotes = useCallback((text: string) => {
    const key = selKeyRef.current;
    if (key == null) return;
    let saved: QueueRow | undefined;
    setRows(prev => prev?.map(r => (rowKey(r) === key ? (saved = { ...r, notes: text }) : r)) ?? prev);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    setSaveState("saving");
    notesTimer.current = setTimeout(() => {
      if (saved) void upsert(saved, email, setSaveState);
    }, 500);
  }, [email]);

  // -- keyboard: letters = decisions, arrows = nav (also ⌘K/⌘U/⌘R from the desktop app) --
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // ⌘/Ctrl shortcuts work even while typing in notes (mirrors the desktop inspector).
      if (e.metaKey || e.ctrlKey) {
        const map: Record<string, InspectDecision> = { k: "keep", u: "undecided", r: "remove", n: "not_inspected" };
        const d = map[e.key.toLowerCase()];
        if (d) { e.preventDefault(); decide(d); }
        return;
      }
      if (typing) return;   // don't hijack plain letters while editing notes
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); step(-1); return; }
      const d = DECISIONS.find(x => x.hot === e.key.toLowerCase());
      if (d) { e.preventDefault(); decide(d.key); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, step]);

  const sel = rows?.find(r => rowKey(r) === selKey) ?? null;
  const counts = useMemo(() => {
    const c: Record<string, number> = { keep: 0, undecided: 0, remove: 0, not_inspected: 0 };
    for (const r of rows ?? []) c[r.decision]++;
    return c;
  }, [rows]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(k === "id" ? 1 : -1); }
  };

  return (
    <main style={{ padding: "1.25rem clamp(1rem, 3vw, 2rem)", maxWidth: "1500px", margin: "0 auto" }}>
      {/* Header + toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "0.9rem" }}>
        <div>
          <h1 className="page-title" style={{ fontSize: "1.5rem", color: "var(--text)", marginBottom: "2px" }}>Visual inspection</h1>
          <p className="mono" style={{ color: "var(--text-muted)", fontSize: "0.74rem" }}>
            <span style={{ color: "var(--green)" }}>{counts.keep} keep</span>{" · "}
            <span style={{ color: "var(--amber)" }}>{counts.undecided} undecided</span>{" · "}
            <span style={{ color: "var(--red)" }}>{counts.remove} remove</span>{" · "}
            <span style={{ color: "var(--text-dim)" }}>{counts.not_inspected} untouched</span>
            {rows && <> · {rows.length} in queue</>}
            {external && <span style={{ color: "var(--accent2)" }}>{" · "}from query{external.label ? `: ${external.label}` : ""}</span>}
          </p>
        </div>
        <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: "10px" }}>
          <SaveIndicator state={saveState} />
          <span>{email}</span>
          <button onClick={() => supabase.auth.signOut()} style={btn("var(--text-muted)")}>sign out</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 12px", alignItems: "center", marginBottom: "0.9rem" }}>
        <label className="mono" style={lbl}>Field
          <select value={fieldSel} onChange={e => setFieldSel(e.target.value)} style={ctrl}>
            <option value="all">all</option>
            {fields.map(f => <option key={f.field} value={f.field}>{f.field}</option>)}
          </select>
        </label>
        <label className="mono" style={lbl}>Decision
          <select value={decFilter} onChange={e => setDecFilter(e.target.value as any)} style={ctrl}>
            <option value="all">all</option>
            <option value="not_inspected">not inspected</option>
            <option value="keep">keep</option>
            <option value="undecided">undecided</option>
            <option value="remove">remove</option>
          </select>
        </label>
        {!external && (
          <>
            <label className="mono" style={lbl}>min z<sub>a</sub>
              <input type="number" step={0.5} value={minZa}
                onChange={e => setMinZa(Number(e.target.value) || 0)} style={{ ...ctrl, width: "72px" }} />
            </label>
            <label className="mono" style={{ ...lbl, cursor: "pointer" }} title="Only show objects with selected=1 (doselect sample)">
              <input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} />
              selected only
            </label>
          </>
        )}
        <label className="mono" style={lbl}>ID
          <input type="text" placeholder="search id" value={search}
            onChange={e => setSearch(e.target.value)} style={{ ...ctrl, width: "110px" }} />
        </label>
        <label className="mono" style={{ ...lbl, cursor: "pointer" }}>
          <input type="checkbox" checked={autoAdvance} onChange={e => setAutoAdvance(e.target.checked)} />
          auto-advance
        </label>
        <span className="mono" style={{ fontSize: "0.66rem", color: "var(--text-dim)" }}>
          keys: k keep · u undecided · r remove · n not-insp · ↑/↓ or j nav
        </span>
      </div>

      {loadErr && <div className="mono" style={{ color: "var(--red)", fontSize: "0.78rem", marginBottom: "0.8rem" }}>{loadErr}</div>}

      {/* Two panes */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 460px) 1fr", gap: "1.25rem", alignItems: "start" }}>
        {/* LEFT: queue table */}
        <div className="card" style={{ padding: 0, maxHeight: "calc(100vh - 220px)", overflow: "auto", position: "sticky", top: "84px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Space Mono', monospace", fontSize: "0.72rem" }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg-elev, #16112a)", zIndex: 1 }}>
              <tr>
                {([
                  ["", "decision"], ["field", "field"], ["ID", "id"], ["RA", "ra"], ["Dec", "dec"], ["z_a", "za"], ["M_UV", "mabs"],
                ] as [string, SortKey][]).map(([label, key]) => (
                  <th key={key} onClick={() => toggleSort(key)}
                    style={{ padding: "7px 8px", textAlign: key === "decision" ? "center" : key === "field" ? "left" : "right", color: sortKey === key ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", userSelect: "none" }}>
                    {label}{sortKey === key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows == null && <tr><td colSpan={7} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-dim)" }}>loading queue…</td></tr>}
              {rows != null && view.length === 0 && <tr><td colSpan={7} style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-muted)" }}>no rows match</td></tr>}
              {view.map(r => {
                const active = selKey === rowKey(r);
                return (
                  <tr key={rowKey(r)} onClick={() => selectRow(r)}
                    style={{ cursor: "pointer", background: active ? "rgba(196,144,216,0.16)" : "transparent", borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent" }}>
                    <td style={{ padding: "5px 8px", textAlign: "center" }}>
                      <span title={r.decision} style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: decColor(r.decision), verticalAlign: "middle" }} />
                    </td>
                    <td style={{ padding: "5px 8px", textAlign: "left", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.field}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: "var(--accent)", fontWeight: 700 }}>{r.id}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: "var(--text-muted)" }}>{r.ra != null ? r.ra.toFixed(5) : "—"}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: "var(--text-muted)" }}>{r.dec != null ? r.dec.toFixed(5) : "—"}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: "var(--text)" }}>{r.za != null ? r.za.toFixed(2) : "—"}</td>
                    <td style={{ padding: "5px 8px", textAlign: "right", color: "var(--text-muted)" }}>{r.mabs != null ? r.mabs.toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* RIGHT: decision bar + selected object's card */}
        <div style={{ minWidth: 0 }}>
          {sel && (
            <div className="card" style={{ padding: "0.85rem 1rem", marginBottom: "12px", position: "sticky", top: "84px", zIndex: 2 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "0.6rem" }}>
                <span className="mono" style={{ fontSize: "0.8rem", color: "var(--accent)", fontWeight: 700, marginRight: "6px" }}>
                  {sel.field} · ID {sel.id}
                </span>
                {DECISIONS.map(d => {
                  const on = sel.decision === d.key;
                  return (
                    <button key={d.key} onClick={() => decide(d.key)} className="mono"
                      title={`${d.label} (${d.hot})`}
                      style={{
                        background: on ? `${d.color}22` : "none",
                        color: on ? d.color : "var(--text-muted)",
                        border: `1px solid ${on ? d.color : "var(--border-bright)"}`,
                        borderRadius: "5px", padding: "6px 11px", cursor: "pointer", fontSize: "0.74rem",
                        fontWeight: on ? 700 : 400,
                      }}>
                      {d.label} <span style={{ opacity: 0.6 }}>{d.hot}</span>
                    </button>
                  );
                })}
              </div>
              <textarea
                value={sel.notes}
                onChange={e => editNotes(e.target.value)}
                placeholder="notes (saved automatically)…"
                rows={2}
                style={{
                  width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
                  color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.78rem", padding: "7px 9px", resize: "vertical",
                }} />
            </div>
          )}
          {card === "loading" && <div className="card" style={{ padding: "1.5rem", color: "var(--text-dim)", fontFamily: "'Space Mono', monospace", fontSize: "0.8rem" }}>loading card…</div>}
          {card === "notfound" && <div className="card" style={{ padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>No card available for this source (field/ID not found on Corral).</div>}
          {card == null && !sel && <div className="card" style={{ padding: "1.5rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>Select a row to inspect.</div>}
          {card && card !== "loading" && card !== "notfound" && <InspectCard src={card} />}
        </div>
      </div>
    </main>
  );
}

// Compact object view for inspection: everything on one screen — a one-line header,
// the "why not selected" reasons, then SED + P(z) + the hard-stretched 1.5" color in a
// single row, with the filter-stamp montage below. No properties grid / flag button.
function InspectCard({ src }: { src: SourceResult }) {
  const za = src.pz["ZA"] ?? 0;
  const normalize = (arr: number[] | undefined, grid: number[] | undefined) => {
    if (!arr || !grid || arr.length !== grid.length) return undefined;
    const nrm = arr.reduce((s, v, i) => s + v * (grid[i + 1] - grid[i] || 0.02), 0) || 1;
    return arr.map(v => v / nrm);
  };
  const pzNorm = normalize(src.pzArr, src.zgrid) ?? src.pzArr;
  const pzLowzNorm = normalize(src.pzArrLowz, src.zgridLowz);
  const ra = src.row["RA"], dec = src.row["DEC"];
  const fails = src.selected === 0 && src.selFail
    ? [src.selFail.det ? "detection" : null, src.selFail.pix ? "image" : null,
       src.selFail.z ? (src.selFail.zsub.length ? `photo-z (${src.selFail.zsub.join(", ")})` : "photo-z") : null].filter(Boolean)
    : [];
  return (
    <div className="card" style={{ padding: "0.8rem 1rem" }}>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 12px", fontSize: "0.76rem", marginBottom: fails.length ? "4px" : "8px" }}>
        <span>
          <b style={{ color: "var(--accent)" }}>ID {src.row["ID"]}</b>
          <span style={{ color: "var(--text-muted)" }}> · {src.field} · tier{src.row["DEPTHTIER"] ?? "—"}</span>
          <span style={{ color: "var(--text)" }}> · z_a={za.toFixed(2)}</span>
          {src.mabs != null && <span style={{ color: "var(--text-muted)" }}> · M_UV={src.mabs.toFixed(2)}</span>}
          {src.beta != null && <span style={{ color: "var(--text-muted)" }}> · β={src.beta.toFixed(2)}</span>}
          {src.selected === 1 && <span style={{ color: "var(--amber)" }}> · ★selected</span>}
        </span>
        <span style={{ color: "var(--text-muted)" }}>{ra != null ? Number(ra).toFixed(5) : "—"}, {dec != null ? Number(dec).toFixed(5) : "—"}</span>
      </div>
      {fails.length > 0 && (
        <div className="mono" style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: "8px" }}>
          <span style={{ color: "var(--red)" }}>Fails:</span> {fails.join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", gap: "0.9rem", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 320px", minWidth: 0 }}><SEDPlot src={src} /></div>
        <div style={{ flex: "1 1 190px", minWidth: 0 }}>
          <PZPlot zgrid={src.zgrid} pz={pzNorm} za={za} zgridLowz={src.zgridLowz} pzLowz={pzLowzNorm} />
        </div>
        {ra != null && dec != null && (
          <div style={{ flexShrink: 0 }}>
            <FitsglCutout field={(src.field ?? "").toUpperCase()} ra={Number(ra)} dec={Number(dec)} fovArcsec={INSPECT_FOV} trilogy={INSPECT_TRILOGY} />
          </div>
        )}
      </div>
      {src.stampUrl && <StampMontage url={src.stampUrl} />}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------
// A "send to inspector" handoff from the search page (via sessionStorage).
type ExtObj = { field: string; id: number; ra: number | null; dec: number | null; za: number | null; mabs: number | null };
type ExternalQueue = { label: string; objects: ExtObj[] };
function readHandoff(): ExternalQueue | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("inspectQueue");
    if (!raw) return null;
    sessionStorage.removeItem("inspectQueue");   // consume once
    const q = JSON.parse(raw) as ExternalQueue;
    return q && Array.isArray(q.objects) && q.objects.length ? q : null;
  } catch { return null; }
}
// The distinct fields present in a handoff, as FieldConfigs.
function externalFields(q: ExternalQueue): FieldConfig[] {
  const names = new Set(q.objects.map(o => o.field));
  return SEARCH_FIELDS.filter(f => names.has(f.field));
}
function extToRow(o: ExtObj): QueueRow {
  return { field: o.field, id: o.id, ra: o.ra, dec: o.dec, za: o.za, mabs: o.mabs, decision: "not_inspected", notes: "" };
}

function buildQueue(idx: FieldIndex, fieldName: string, minZa: number, selectedOnly: boolean): QueueRow[] {
  const out: QueueRow[] = [];
  for (let i = 0; i < idx.n; i++) {
    const za = idx.za[i];
    if (za == null || za < minZa) continue;
    if (selectedOnly && idx.selected?.[i] !== 1) continue;   // only doselect-selected objects
    out.push({
      field: fieldName,
      id: idx.id[i],
      ra: idx.ra[i] ?? null,
      dec: idx.dec[i] ?? null,
      za,
      mabs: idx.mabs?.[i] ?? null,
      decision: "not_inspected",
      notes: "",
    });
  }
  return out;
}

// The exact Supabase upsert: one row per (field, obj_id), conflict-merged on that key.
// Resolves the row's field config so the merged "all" queue writes the right version.
async function upsert(row: QueueRow, inspector: string, setState: (s: SaveState) => void) {
  setState("saving");
  const fc = SEARCH_FIELDS.find(f => f.field === row.field);
  const payload: Inspection = {
    field: row.field,
    obj_id: row.id,
    ra: row.ra,
    dec: row.dec,
    version: fc?.version ?? null,
    z: row.za,
    decision: row.decision,
    notes: row.notes || null,
    inspector,
  };
  const { error } = await supabase.from("inspections").upsert(payload, { onConflict: "field,obj_id" });
  setState(error ? "error" : "saved");
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") return <span style={{ color: "var(--amber)" }}>saving…</span>;
  if (state === "error") return <span style={{ color: "var(--red)" }}>save failed</span>;
  if (state === "saved") return <span style={{ color: "var(--green)" }}>All changes saved</span>;
  return <span style={{ color: "var(--text-dim)" }}>—</span>;
}

const lbl: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px",
  fontSize: "0.72rem", color: "var(--text-muted)",
};
const ctrl: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--border-bright)", borderRadius: "5px",
  color: "var(--text)", fontFamily: "'Space Mono', monospace", fontSize: "0.74rem", padding: "5px 8px",
};
function btn(color: string): React.CSSProperties {
  return { background: "none", border: "1px solid var(--border-bright)", borderRadius: "4px", color, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: "0.7rem", padding: "4px 9px" };
}
