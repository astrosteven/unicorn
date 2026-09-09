import { createClient } from "@supabase/supabase-js";

// Supabase project backing the spurious-source flag queue. The anon key is PUBLIC by
// design — Row-Level Security on `public.flags` restricts anonymous users to INSERT only
// (they can file a flag but can't read or change the queue). Reading/triaging the queue
// requires an authenticated login (the /data/review page). See the flags table schema.
const SUPABASE_URL = "https://nutjfdfklbetjzbtulbv.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im51dGpmZGZrbGJldGp6YnR1bGJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MDI0MDgsImV4cCI6MjEwNDQ3ODQwOH0.8y7qGdGnwdFhG559LoUCApykeLaf82FC2kQeWUUT-YQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type FlagStatus = "pending" | "confirmed" | "dismissed" | "applied";
export type Flag = {
  id: string;
  field: string;
  obj_id: number;
  ra: number | null;
  dec: number | null;
  reason: string | null;
  status: FlagStatus;
  created_at: string;
  reviewed_at: string | null;
};

// Visual-inspection queue (public.inspections): the /data/inspect tool persists a
// keep/undecided/remove decision (+ optional notes) per (field, obj_id) here. RLS is
// authenticated-only for select/insert/update, so only signed-in inspectors touch it.
export type InspectDecision = "not_inspected" | "keep" | "undecided" | "remove";
export type Inspection = {
  id?: string;
  field: string;
  obj_id: number;
  ra: number | null;
  dec: number | null;
  version: string | null;
  z: number | null;
  decision: InspectDecision;
  notes: string | null;
  inspector: string | null;
  updated_at?: string;
};
