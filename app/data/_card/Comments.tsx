"use client";
// Per-object comments section for the shared ResultCard. Persistent notes keyed by
// (field, obj_id) in Supabase public.comments. Private by default (only the author
// sees them via RLS: SELECT returns `private = false OR user_id = auth.uid()`), with
// an optional Public toggle so a note is visible to everyone. Logged-in users get an
// add form + delete on their own rows; signed-out users see only public comments (RLS
// returns those for anon) and a muted "sign in to comment" note. Auth follows the same
// getSession + onAuthStateChange pattern as AddNameControl / /data/review. Collapsed by
// default so it never disrupts the card layout. Uses the anon supabase client — the
// logged-in JWT satisfies the insert/update/delete-your-own-rows policies.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { supabase } from "@/lib/supabase";

type CommentRow = {
  id: string;
  field: string;
  obj_id: number;
  body: string;
  private: boolean;
  user_id: string | null;
  author_email: string | null;
  created_at: string;
};

// Compact relative-time formatter (e.g. "3m ago", "2d ago"), no external deps.
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function Comments({ field, objId, ra, dec }: {
  field: string; objId: number | string; ra: number; dec: number;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [rows, setRows] = useState<CommentRow[] | null>(null);   // null = not yet loaded
  const [body, setBody] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);              // Private by default
  const [state, setState] = useState<"idle" | "saving">("idle");
  const [err, setErr] = useState("");

  // Auth: mirror the AddNameControl / review pattern.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? null);
      setUserId(data.session?.user.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setEmail(s?.user.email ?? null);
      setUserId(s?.user.id ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Fetch this object's comments. RLS already limits the result to the user's own rows
  // plus any public ones, so no extra client-side filtering is needed.
  const load = useCallback(async () => {
    setErr("");
    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("field", field)
      .eq("obj_id", Number(objId))
      .order("created_at", { ascending: true });
    if (error) { setErr(error.message); return; }
    setRows((data ?? []) as CommentRow[]);
  }, [field, objId]);

  // (Re)load on expand and whenever the object changes while open.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const post = async () => {
    const text = body.trim();
    if (!text) { setErr("Write something first."); return; }
    setErr(""); setState("saving");
    const { error } = await supabase.from("comments").insert({
      field,
      obj_id: Number(objId),
      ra,
      dec,
      body: text,
      private: isPrivate,
      author_email: email,   // user_id defaults to auth.uid() server-side
    });
    setState("idle");
    if (error) { setErr(error.message); return; }
    setBody("");
    load();
  };

  const remove = async (id: string) => {
    setErr("");
    const { error } = await supabase.from("comments").delete().eq("id", id);
    if (error) { setErr(error.message); return; }
    load();
  };

  const inputStyle: CSSProperties = {
    width: "100%", background: "var(--bg)", border: "1px solid var(--border-bright)",
    borderRadius: "4px", color: "var(--text)", fontFamily: "'Space Mono', monospace",
    fontSize: "0.75rem", padding: "7px 9px", resize: "vertical", minHeight: "56px",
  };

  const count = rows?.length ?? 0;

  return (
    <div style={{ marginTop: "1.25rem" }}>
      {/* Collapsible header — 💬 Comments (n) */}
      <button onClick={() => setOpen(o => !o)} className="mono"
        title="Per-object comments — private by default, or public for everyone"
        style={{
          background: "none", border: "none", cursor: "pointer", padding: 0,
          color: "var(--text-dim)", fontSize: "0.7rem", letterSpacing: "0.04em",
          fontFamily: "'Space Mono', monospace",
        }}>
        {open ? "▾" : "▸"} 💬 COMMENTS{count ? ` (${count})` : ""}
      </button>

      {open && (
        <div style={{ marginTop: "10px" }}>
          {/* Existing comments */}
          {rows == null ? (
            <div className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)" }}>loading…</div>
          ) : rows.length === 0 ? (
            <div className="mono" style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginBottom: "8px" }}>
              No comments yet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "10px" }}>
              {rows.map(c => {
                const mine = !!(userId && c.user_id === userId);
                return (
                  <div key={c.id} style={{
                    border: "1px solid var(--border)", borderRadius: "5px",
                    padding: "7px 9px", background: "rgba(255,255,255,0.02)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                      <span className="mono" style={{
                        fontSize: "0.6rem", padding: "1px 7px", borderRadius: "999px",
                        color: c.private ? "var(--text-muted)" : "var(--green)",
                        border: `1px solid ${c.private ? "var(--border-bright)" : "var(--green)"}55`,
                      }}>
                        {c.private ? "private" : "public"}
                      </span>
                      <span className="mono" style={{ fontSize: "0.65rem", color: "var(--text-dim)" }}>
                        {mine ? "you" : (c.author_email || "someone")}
                      </span>
                      <span className="mono" style={{ fontSize: "0.65rem", color: "var(--text-dim)" }}>
                        · {relTime(c.created_at)}
                      </span>
                      {mine && (
                        <button onClick={() => remove(c.id)} title="Delete this comment" className="mono"
                          style={{
                            marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
                            color: "var(--text-dim)", fontSize: "0.72rem", padding: "0 2px",
                          }}>
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: "0.76rem", color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {c.body}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add form (logged in) or sign-in hint (logged out) */}
          {email ? (
            <div>
              <textarea style={inputStyle} placeholder="add a comment…" value={body}
                onChange={e => setBody(e.target.value)} />
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "6px", flexWrap: "wrap" }}>
                {/* Private / Public toggle — default Private. */}
                <div className="mono" style={{ display: "inline-flex", border: "1px solid var(--border-bright)", borderRadius: "4px", overflow: "hidden" }}>
                  {([["Private", true], ["Public", false]] as [string, boolean][]).map(([label, val]) => (
                    <button key={label} onClick={() => setIsPrivate(val)}
                      style={{
                        background: isPrivate === val ? "var(--accent-dim)" : "none",
                        color: isPrivate === val ? "var(--accent)" : "var(--text-muted)",
                        border: "none", cursor: "pointer", fontFamily: "'Space Mono', monospace",
                        fontSize: "0.68rem", padding: "4px 10px",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={post} disabled={state === "saving"} className="mono"
                  style={{
                    background: "var(--accent-dim)", color: "var(--accent)",
                    border: "1px solid rgba(196,144,216,0.35)", borderRadius: "4px",
                    padding: "5px 13px", cursor: state === "saving" ? "wait" : "pointer", fontSize: "0.7rem",
                  }}>
                  {state === "saving" ? "posting…" : "Post"}
                </button>
                <span className="mono" style={{ fontSize: "0.62rem", color: "var(--text-dim)" }}>
                  {isPrivate ? "only you will see this" : "visible to everyone"}
                </span>
              </div>
            </div>
          ) : (
            <div className="mono" style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>
              Sign in to comment.
            </div>
          )}

          {err && <div className="mono" style={{ color: "var(--red)", fontSize: "0.68rem", marginTop: "8px" }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
