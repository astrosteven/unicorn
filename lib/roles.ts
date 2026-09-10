"use client";
// Role-based access for the protected /data area. Replaces the old shared-password
// gate (lib/auth.ts). Every logged-in user has a row in public.profiles with a `role`:
//
//   pending  — logged in, awaiting owner approval (no gated content)
//   general  — Catalogs / Explore / Search
//   key      — + Inspect / Review (and the app-level key features)
//   admin    — everything + the /data/admin approval page
//
// Anonymous (not logged in) users may still see the PUBLIC_ROUTES below.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type Role = "pending" | "general" | "key" | "admin";

// Routes any visitor can see with NO login (and therefore no redirect). These are
// PREFIX-matched via under(), so the overview "/data" must NOT go here — it would
// prefix-match every /data/* route and make the whole site public. The overview is
// exact-matched separately in routeAllowed().
export const PUBLIC_ROUTES = ["/data/fields"];

// General tier adds these; key adds the two after; admin gets its own page too.
const GENERAL_ROUTES = ["/data/catalogs", "/data/map", "/data/search"];
const KEY_ROUTES     = ["/data/inspect", "/data/review"];
const ADMIN_ROUTES   = ["/data/admin"];

// Does `pathname` fall under `base` (exact, or a nested sub-route)?
function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + "/");
}

// Tier table. `role === null` means not logged in → public routes only.
// Higher tiers inherit everything the lower tiers can see; admin sees all.
export function routeAllowed(pathname: string, role: Role | null): boolean {
  if (pathname === "/data") return true;               // overview landing — EXACT (not a prefix)
  if (PUBLIC_ROUTES.some(r => under(pathname, r))) return true;  // /data/fields (+ sub-routes)
  if (role == null) return false;              // anon: only public routes
  if (role === "admin") return true;           // admin: everything

  if (GENERAL_ROUTES.some(r => under(pathname, r))) {
    return role === "general" || role === "key"; // admin handled above
  }
  if (KEY_ROUTES.some(r => under(pathname, r))) {
    return role === "key";                       // admin handled above
  }
  if (ADMIN_ROUTES.some(r => under(pathname, r))) {
    return false;                                // only admin, handled above
  }
  // Unknown gated route under /data — be conservative, require admin.
  return false;
}

// Subscribes to Supabase auth and resolves the caller's role from public.profiles.
// On any error or missing row for a logged-in user we default to "pending" — never a
// higher tier (fail-closed), and never lock the user out of the login flow itself.
export function useProfile(): { session: Session | null; role: Role | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole]       = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function resolve(s: Session | null) {
      if (!alive) return;
      setSession(s);
      if (!s) { setRole(null); setLoading(false); return; }
      // Logged in — look up the profile row. Default to "pending" on error/absence.
      const { data, error } = await supabase
        .from("profiles").select("role").eq("user_id", s.user.id).maybeSingle();
      if (!alive) return;
      const r = (!error && data?.role) ? (data.role as Role) : "pending";
      setRole(r);
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setLoading(true);
      resolve(s);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  return { session, role, loading };
}
