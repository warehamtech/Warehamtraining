/**
 * Supabase project connection.
 *
 * Both values below are PUBLIC by design. The anon key is meant to ship in the
 * browser — it identifies the project and nothing else, and every table it can
 * reach is protected by row level security (supabase/migrations/0002_rls.sql).
 * It is not a secret and does not need hiding.
 *
 * What must NEVER appear in this file, or anywhere under site/, is the
 * `service_role` key. That one bypasses RLS entirely. It belongs only in
 * Supabase Edge Function secrets.
 *
 * Fill these in from your project's Settings → API page.
 */
export const SUPABASE_URL = "https://clstncdtjehcbdxibwgp.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNsc3RuY2R0amVoY2JkeGlid2dwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NzM3MDAsImV4cCI6MjEwMjU0OTcwMH0" +
  ".NmY-q-eO00QO18K5v_9HtR22UJoXtqYUHbJk_lvIEBw";

/**
 * Absolute base URL of the deployed site. Used for the links in emails and the
 * certificate QR codes, so it must match the domain people actually visit.
 * Leave as-is to derive it from the browser, or hard-code the live domain.
 */
export const SITE_URL =
  typeof location !== "undefined" ? location.origin : "https://wha.co.za";

/** True until the placeholders above are replaced, so pages can say so plainly. */
export const CONFIGURED = !SUPABASE_URL.includes("YOUR-PROJECT-REF");
