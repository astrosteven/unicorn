// Supabase Edge Function: email the site owner when someone requests UNICORN access.
// The registration form calls this (best-effort) right after inserting the pending profile.
// Secrets (Dashboard → Edge Functions → notify-signup → Secrets, or `supabase secrets set`):
//   RESEND_API_KEY  — from https://resend.com (free tier)
//   OWNER_EMAIL     — where the approval ping goes (e.g. sf8542@eid.utexas.edu)
//   APPROVE_URL     — optional; defaults to the admin page
//
// Deploy:  supabase functions deploy notify-signup --no-verify-jwt
// (--no-verify-jwt so the just-signed-up client can call it; it sends no secrets back.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const { email, justification } = await req.json();
    const key = Deno.env.get("RESEND_API_KEY");
    const owner = Deno.env.get("OWNER_EMAIL");
    const approveUrl = Deno.env.get("APPROVE_URL") ?? "https://astrosteven.github.io/unicorn/data/admin";
    if (!key || !owner) {
      return new Response(JSON.stringify({ ok: false, error: "function not configured" }), {
        status: 500, headers: { ...CORS, "content-type": "application/json" },
      });
    }
    const esc = (s: string) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "UNICORN <onboarding@resend.dev>",   // swap for a verified-domain sender if you set one up
        to: [owner],
        subject: `UNICORN access request: ${email}`,
        html:
          `<p><b>${esc(email)}</b> requested access to UNICORN.</p>` +
          `<p><b>Justification:</b><br>${esc(justification)}</p>` +
          `<p><a href="${approveUrl}">Review &amp; approve →</a></p>`,
      }),
    });
    return new Response(JSON.stringify({ ok: res.ok }), {
      status: res.ok ? 200 : 502, headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
