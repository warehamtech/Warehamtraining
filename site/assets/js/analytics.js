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

/**
 * The last path counted. The header renderers call track(), and shell.js now
 * redraws the header when a background profile refresh finds something
 * changed — without this, that redraw would book a second view of a page
 * nobody navigated to twice. Storing only the most recent path means a real
 * A → B → A still counts two views of A, since B clears it in between.
 */
let lastTracked = null;

/** Record a page view. Never throws — must not be able to block or break render. */
export function track() {
  const path = location.pathname + location.search;
  if (path === lastTracked) return;
  lastTracked = path;

  sb.from("page_views")
    .insert({
      path: location.pathname,
      slug: new URLSearchParams(location.search).get("slug"),
      session_id: sessionId(),
    })
    .then(() => {}, () => {});
}
