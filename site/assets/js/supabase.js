import { SUPABASE_URL, SUPABASE_ANON_KEY, CONFIGURED } from "./env.js";

/**
 * The one Supabase client the site uses.
 *
 * The library itself is vendored at assets/vendor/supabase.js and loaded by a
 * plain <script> tag ahead of the page module, which puts `createClient` on
 * `window.supabase`. That build is a self-contained IIFE, so the site pulls
 * nothing from a CDN at runtime and works from a file:// copy.
 */
if (!globalThis.supabase?.createClient) {
  throw new Error(
    "The Supabase library did not load. Every page needs " +
      '<script defer src="/assets/vendor/supabase.js"></script> before its module script.',
  );
}

if (!CONFIGURED) {
  console.warn(
    "[wha] assets/js/env.js still holds placeholder values — set SUPABASE_URL " +
      "and SUPABASE_ANON_KEY from your project's Settings → API page.",
  );
}

export const sb = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The site has no /auth/callback page; magic links and recovery arrive on
    // the page that asked for them.
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

/**
 * Unwrap a PostgREST result, turning an error into a thrown Error so page
 * modules can rely on `page()` to render it.
 */
export function unwrap({ data, error }) {
  if (error) throw new Error(friendly(error));
  return data;
}

/**
 * Call a database function. Every RPC in 0003_functions.sql returns a jsonb
 * envelope of `{ ok: true, ... }` or `{ ok: false, error }`, so this returns
 * the envelope rather than throwing — the caller shows the message in the form.
 */
export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) return { ok: false, error: friendly(error) };
  return data ?? { ok: false, error: "No response from the server." };
}

/**
 * Postgres error codes, in the words a learner or an administrator would use.
 * 42501 is what row level security and the column grant on `choices.is_correct`
 * both raise, and it is much more often "you may not" than a bug.
 */
function friendly(error) {
  if (error.code === "42501" || error.code === "PGRST301") {
    return "You don't have access to that.";
  }
  if (error.code === "23505") return "That already exists.";
  if (error.code === "PGRST116") return "Not found.";
  if (error.message?.includes("Failed to fetch")) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return error.message ?? "Something went wrong.";
}

/**
 * A short-lived signed URL for a private storage object. Nothing in the three
 * buckets is public, so this is the only way to reach a file, and the storage
 * policies decide whether the caller gets one.
 */
export async function signedUrl(bucket, key, seconds = 300) {
  if (!key) return null;
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(key, seconds);
  if (error) return null;
  return data.signedUrl;
}
