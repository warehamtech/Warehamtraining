import { sb } from "./supabase.js";
import { SUPABASE_URL } from "./env.js";

/**
 * Ask the send-mail Edge Function to send one of the portal's transactional
 * messages.
 *
 * The browser names the message and the record it concerns — never the
 * recipient, the subject or the body. The function re-reads the row itself,
 * checks the caller may see it, and builds the message from that. So this
 * cannot be used to send arbitrary mail from the WHA domain, and a tampered
 * client can at worst re-send a message someone was already entitled to.
 *
 * Kinds: "invoice" | "proof_received" | "activated" | "invite" | "seat_assigned"
 *        | "certificate"
 */
export async function sendMail(kind, payload) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { ok: false, error: "Not signed in." };

  const response = await fetch(`${SUPABASE_URL}/functions/v1/send-mail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind, ...payload }),
  });

  if (!response.ok) {
    return { ok: false, error: await response.text().catch(() => "Send failed.") };
  }
  return { ok: true };
}
