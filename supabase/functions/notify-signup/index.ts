// Supabase Edge Function: email the site owner when someone requests UNICORN access.
// The registration form calls this (best-effort) right after inserting the pending profile.
// Sends via Brevo (https://brevo.com) — its free tier verifies a single sender ADDRESS (no domain
// needed), unlike Resend's sandbox which only delivered to the account owner.
// Secrets (Dashboard → Edge Functions → notify-signup → Secrets, or `supabase secrets set`):
//   BREVO_API_KEY  — Brevo → Settings → SMTP & API → API Keys (v3)
//   SENDER_EMAIL   — a Brevo-verified sender address (from:)
//   OWNER_EMAIL    — where the access-request ping goes (e.g. sf8542@eid.utexas.edu)
//   APPROVE_URL    — optional; defaults to the admin page
//
// Deploy:  supabase functions deploy notify-signup --no-verify-jwt
// (--no-verify-jwt so the just-signed-up client can call it. This function only ever emails
//  OWNER_EMAIL — never an address from the request — so it can't be abused to spam third parties.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const { email, justification } = await req.json();
    const key = Deno.env.get("BREVO_API_KEY");
    const owner = Deno.env.get("OWNER_EMAIL");
    const sender = Deno.env.get("SENDER_EMAIL");
    const approveUrl = Deno.env.get("APPROVE_URL") ?? "https://astrosteven.github.io/unicorn/data/admin";
    if (!key || !owner || !sender) {
      return new Response(JSON.stringify({ ok: false, error: "function not configured (need BREVO_API_KEY, SENDER_EMAIL, OWNER_EMAIL)" }), {
        status: 500, headers: { ...CORS, "content-type": "application/json" },
      });
    }
    const esc = (s: string) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "UNICORN", email: sender },
        to: [{ email: owner }],
        subject: `UNICORN access request: ${email}`,
        htmlContent:
          `<p><b>${esc(email)}</b> requested access to UNICORN.</p>` +
          `<p><b>Justification:</b><br>${esc(justification)}</p>` +
          `<p><a href="${approveUrl}">Review &amp; approve →</a></p>`,
      }),
    });
    // Surface Brevo's reason on failure (e.g. an unverified sender) so setup problems are diagnosable.
    const detail = res.ok ? undefined : (await res.text()).slice(0, 500);
    if (!res.ok) console.error("brevo send failed", res.status, detail);
    return new Response(JSON.stringify({ ok: res.ok, status: res.status, detail }), {
      status: res.ok ? 200 : 502, headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
