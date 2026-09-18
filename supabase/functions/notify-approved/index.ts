// Supabase Edge Function: email a user that their UNICORN access was approved.
// Called by the admin page (setRole) on the pending → approved transition. Because it emails an
// address taken from the request, it is ADMIN-GUARDED: the caller's JWT is verified and their
// profiles.role must be 'admin' (checked with the service-role key) before anything is sent.
// Sends via Brevo (shares the notify-signup secrets).
// Secrets: BREVO_API_KEY, SENDER_EMAIL. (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
// are auto-injected into every Edge Function.)
//
// Deploy:  supabase functions deploy notify-approved
// (NOTE: no --no-verify-jwt — we require a real logged-in caller and then check admin ourselves.)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Include x-client-info / x-supabase-api-version — supabase-js's functions.invoke sends them and
  // the browser CORS preflight fails without them (the admin page .catch()es it, so it'd be silent).
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const key = Deno.env.get("BREVO_API_KEY");
    const sender = Deno.env.get("SENDER_EMAIL");
    if (!key || !sender) return json({ ok: false, error: "not configured (need BREVO_API_KEY, SENDER_EMAIL)" }, 500);

    // 1) Verify the caller is a signed-in admin.
    const authHeader = req.headers.get("Authorization") ?? "";
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await caller.auth.getUser();
    if (uErr || !user) return json({ ok: false, error: "unauthorized" }, 401);
    const admin = createClient(url, svc);
    const { data: prof } = await admin.from("profiles").select("role").eq("user_id", user.id).single();
    if (prof?.role !== "admin") return json({ ok: false, error: "forbidden (admin only)" }, 403);

    // 2) Send the welcome email.
    const { email } = await req.json();
    if (!email || typeof email !== "string") return json({ ok: false, error: "email required" }, 400);
    const site = "https://astrosteven.github.io/unicorn/data";
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "UNICORN", email: sender },
        to: [{ email }],
        subject: "Your UNICORN access is approved",
        htmlContent:
          `<p>Your request for access to the <b>UNICORN</b> JWST catalog site has been approved.</p>` +
          `<p>You can now sign in and explore the data: <a href="${site}">${site}</a></p>`,
      }),
    });
    const detail = res.ok ? undefined : (await res.text()).slice(0, 500);
    if (!res.ok) console.error("brevo send failed", res.status, detail);
    return json({ ok: res.ok, status: res.status, detail }, res.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 400);
  }
});
