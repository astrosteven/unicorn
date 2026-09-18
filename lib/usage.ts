"use client";
// Fire-and-forget per-user activity logging. Writes to public.usage_events (see supabase/usage.sql).
// The table's user_id DEFAULTs to auth.uid() and RLS only allows a user to insert their own rows,
// so anonymous/logged-out calls are silently rejected and nothing here ever blocks or throws to the
// UI. The admin page reads the aggregates via the admin_user_activity() RPC.
import { supabase } from "./supabase";

export function logUsage(event: string, meta?: Record<string, unknown>): void {
  try {
    void supabase.from("usage_events").insert({ event, meta: meta ?? null }).then(
      () => {},
      () => {},
    );
  } catch {
    /* best-effort: never surface a tracking failure */
  }
}
