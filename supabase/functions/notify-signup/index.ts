// Supabase Edge Function: email the site owner when someone requests UNICORN access.
// The registration form calls this (best-effort) right after inserting the pending profile.
//
// Uses Resend from its own authenticated sender `onboarding@resend.dev` — which passes SPF/DKIM/
// DMARC and actually delivers, unlike trying to send "from" a domain you don't control (Brevo
// rejected stevenf@astro.as.utexas.edu as "not a valid sender", and Gmail/UT reject it on DMARC).
// Resend's free SANDBOX delivers `onboarding@resend.dev` mail ONLY to your Resend-ACCOUNT email —
// which is fine here because this only ever emails OWNER_EMAIL (you). So set OWNER_EMAIL to the
// address your Resend account is registered under (slfinkel@gmail.com). To later email arbitrary
// users (the approval note), verify a real domain in Resend and swap the `from` + drop the sandbox.
//
// Secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   RESEND_API_KEY — from https://resend.com (free tier)
//   OWNER_EMAIL    — MUST be your Resend-account email for sandbox delivery (e.g. slfinkel@gmail.com)
//   APPROVE_URL    — optional; defaults to the admin page
//
// Deploy:  supabase functions deploy notify-signup --no-verify-jwt
// (--no-verify-jwt so the just-signed-up client can call it; it only ever emails OWNER_EMAIL.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Must include x-client-info (+ x-supabase-api-version) — supabase-js's functions.invoke sends
  // them, and a browser CORS preflight fails (silently, since the caller .catch()es it) if they're
  // not allowed. That's why direct curl worked but the /login form's call didn't.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const { email, justification } = await req.json();
    const key = Deno.env.get("RESEND_API_KEY");
    const owner = Deno.env.get("OWNER_EMAIL");
    const approveUrl = Deno.env.get("APPROVE_URL") ?? "https://astrosteven.github.io/unicorn/data/admin";
    if (!key || !owner) {
      return new Response(JSON.stringify({ ok: false, error: "function not configured (need RESEND_API_KEY, OWNER_EMAIL)" }), {
        status: 500, headers: { ...CORS, "content-type": "application/json" },
      });
    }
    const esc = (s: string) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "UNICORN <onboarding@resend.dev>",   // Resend's authenticated sandbox sender
        to: [owner],
        subject: `UNICORN access request: ${email}`,
        html:
          `<p><b>${esc(email)}</b> requested access to UNICORN.</p>` +
          `<p><b>Justification:</b><br>${esc(justification)}</p>` +
          `<p><a href="${approveUrl}">Review &amp; approve →</a></p>`,
      }),
    });
    // Surface Resend's reason on failure (e.g. sandbox only sends to the account email until you
    // verify a domain), so setup problems are diagnosable in the response + function logs.
    const detail = res.ok ? undefined : (await res.text()).slice(0, 500);
    if (!res.ok) console.error("resend send failed", res.status, detail);
    return new Response(JSON.stringify({ ok: res.ok, status: res.status, detail }), {
      status: res.ok ? 200 : 502, headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
