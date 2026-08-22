// Serves real visitors the single-page-app shell, while leaving crawlers
// and link-unfurlers (Google, WhatsApp, LinkedIn, Slack, ...) alone to see
// the real static HTML build/prerender.mjs already generates at these
// exact paths — the only reason those generated files still exist as
// separate documents. Everything else in the site collapses to app.html
// unconditionally via plain redirects in netlify.toml; this function only
// covers the handful of paths that carry real SEO/preview value.
//
// Registered in netlify.toml's [[edge_functions]] blocks, scoped to:
// "/", "/programs/index.html", "/programs/*.html" (which also catches
// every published programme's generated page), and "/verify/index.html".
//
// NOTE for whoever deploys this first: `context.rewrite()` is the current
// Netlify Edge Functions API for "serve different content, keep the URL
// bar" — confirm the exact method name/signature against Netlify's docs at
// deploy time, and confirm edge functions run before the redirect engine
// (so this fires ahead of the /programs/program.html force-redirect and
// the generic /* catch-all). Both were true as of when this was written,
// but neither this codebase nor its dev server can exercise this file
// locally — it needs a real Netlify deploy (or `netlify dev`) to verify.

const BOT_UA = new RegExp(
  [
    "googlebot", "bingbot", "slurp", "duckduckbot", "baiduspider",
    "yandex", "sogou", "exabot", "facebookexternalhit", "facebot",
    "twitterbot", "linkedinbot", "whatsapp", "telegrambot", "discordbot",
    "slackbot", "redditbot", "pinterest", "applebot", "ia_archiver",
    "semrushbot", "ahrefsbot", "mj12bot", "dotbot", "petalbot",
    "bot", "spider", "crawl", "preview",
  ].join("|"),
  "i",
);

import type { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  const ua = request.headers.get("user-agent") ?? "";
  if (BOT_UA.test(ua)) return; // fall through: serve the real static file

  const url = new URL(request.url);
  // The draft-preview template has no SEO value (RLS-gated, staff-only)
  // and is already force-redirected unconditionally in netlify.toml — skip
  // it here so that redirect, not this function, is the one source of
  // truth for it.
  if (url.pathname === "/programs/program.html") return;

  // Keeps the address bar on the real URL while serving app.html's bytes —
  // NOT a 3xx redirect, which would change what the visitor sees in the
  // URL bar and break bookmarking/sharing the original link.
  return context.rewrite(new URL("/app.html", url));
};

export const config = {
  path: ["/", "/programs/*", "/verify/index.html"],
};
