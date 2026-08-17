import { sb } from "./supabase.js";

/**
 * Fire-and-forget page-view tracking against public.page_views
 * (supabase/migrations/0005_analytics.sql).
 *
 * `session_id` approximates a "visit" (unique tab-session) without cookies or
 * fingerprinting — minted once per browser tab into sessionStorage, so a whole
 * session of page loads counts as one visit but views are still counted
 * individually. Called from renderPublicHeader()/renderAppHeader() in
 * shell.js, which between them cover every page in the site.
 */

const SESSION_KEY = "wha_session_id";

function sessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** Record a page view. Never throws — must not be able to block or break render. */
export function track() {
  sb.from("page_views")
    .insert({
      path: location.pathname,
      slug: new URLSearchParams(location.search).get("slug"),
      session_id: sessionId(),
    })
    .then(() => {}, () => {});
}
