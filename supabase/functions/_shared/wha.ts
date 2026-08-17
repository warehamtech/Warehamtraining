/**
 * Shared helpers for the WHA edge functions.
 *
 * The pattern every function follows:
 *   1. Read the caller's JWT from the Authorization header.
 *   2. Build a Supabase client that carries it, so RLS applies exactly as it
 *      would in the browser.
 *   3. Read the record through that client. If the caller may not see it, the
 *      read comes back empty and the function returns 403.
 *
 * The service-role key is only used where a function must write something the
 * caller legitimately cannot (caching a rendered certificate). It is never used
 * to decide whether the caller is allowed to be there.
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Set on the Supabase project so links in emails point at the live site. */
export const SITE_URL = Deno.env.get("WHA_SITE_URL") ?? "https://wha.co.za";

/**
 * Company, tax and banking details. These MUST be set as function secrets
 * before a live invoice is issued — the fallbacks are the same placeholders
 * the app has always carried, and they are not a real VAT number or bank
 * account.
 */
export const company = {
  legalName: "Wareham & Associates",
  addressLines: [
    "2 Thorpe Close",
    "Corner of Thorpe Close / Zwaanswyk Road",
    "Tokai",
    "7945",
  ],
  country: "South Africa",
  phone: "(021) 713-2380",
  email: "info1@wha.co.za",
  website: "wha.co.za",
  vatNumber: Deno.env.get("WHA_VAT_NUMBER") ?? "4XXXXXXXXX",
  registrationNumber: Deno.env.get("WHA_REG_NUMBER") ?? "XXXX/XXXXXX/XX",
};

export const banking = {
  bank: Deno.env.get("WHA_BANK_NAME") ?? "Standard Bank",
  accountName: Deno.env.get("WHA_BANK_ACCOUNT_NAME") ?? "Wareham & Associates",
  accountNumber: Deno.env.get("WHA_BANK_ACCOUNT_NUMBER") ?? "000 000 000",
  branchCode: Deno.env.get("WHA_BANK_BRANCH_CODE") ?? "051001",
  swift: Deno.env.get("WHA_BANK_SWIFT") ?? "SBZAZAJJ",
};

export const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("WHA_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

/**
 * A client acting AS THE CALLER. Every read through it is subject to the same
 * row level security the browser gets, which is what makes these functions
 * safe to expose.
 */
export function clientFor(request: Request): SupabaseClient | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client that bypasses RLS. Only for writes the caller cannot make itself. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Format integer cents as a ZAR amount — the port of formatMoney(). */
export function formatMoney(cents: number, withSymbol = true) {
  const amount = (Number(cents ?? 0) / 100).toFixed(2);
  const [whole, fraction] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const value = `${grouped}.${fraction}`;
  return withSymbol ? `R ${value}` : value;
}

export function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric", month: "long", year: "numeric",
  }).format(new Date(value));
}

/** Shared shell so every message looks like it came from the same company. */
export function emailLayout(opts: {
  heading: string;
  body: string;
  cta?: { label: string; url: string };
}) {
  const cta = opts.cta
    ? `<p style="margin:28px 0 0">
         <a href="${opts.cta.url}"
            style="background:#06479b;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:500">
           ${opts.cta.label}
         </a>
       </p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f7fafc;font-family:Roboto,Arial,sans-serif;color:#2c333f">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px">
    <tr><td style="padding:28px 32px">
      <p style="margin:0 0 20px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#06479b;font-weight:700">
        Wareham &amp; Associates
      </p>
      <h1 style="margin:0 0 14px;font-size:20px;font-weight:500;color:#2c333f">${opts.heading}</h1>
      <div style="font-size:15px;line-height:1.6;color:#4a5568">${opts.body}</div>
      ${cta}
    </td></tr>
    <tr><td style="padding:16px 32px 26px;border-top:1px solid #e2e8f0;font-size:12px;color:#718096">
      Wareham &amp; Associates · 2 Thorpe Close, Tokai 7945 · (021) 713-2380<br />
      <a href="${SITE_URL}" style="color:#06479b">${SITE_URL.replace(/^https?:\/\//, "")}</a>
    </td></tr>
  </table>
</body></html>`;
}

export type Attachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

/**
 * Send via Resend. Without RESEND_API_KEY the message is logged and reported
 * as skipped rather than failing the request — the portal must keep working
 * before the mail provider is wired up, exactly as the .eml fallback allowed
 * locally in the Next.js version.
 */
export async function sendMail(mail: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM") ?? "WHA Learning Portal <noreply@wha.co.za>";

  if (!apiKey) {
    console.info(`[email] RESEND_API_KEY unset — would send "${mail.subject}" to ${mail.to}`);
    return { sent: false, reason: "no-provider" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      attachments: mail.attachments?.map((a) => ({
        filename: a.filename,
        content: encodeBase64(a.content),
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`Email send failed (${response.status}): ${await response.text()}`);
  }
  return { sent: true };
}

export function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Escape text destined for an HTML email body. */
export function esc(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
