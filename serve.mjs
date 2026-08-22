/**
 * Local preview server for site/.
 *
 *   node serve.mjs
 *
 * Serves the folder the way Netlify will for a real visitor: every route in
 * site/assets/js/routes.js (plus the old-bookmark redirects and the
 * draft-preview template) resolves to app.html, exactly like the
 * netlify.toml redirects + prerender-for-bots edge function do in
 * production. It does NOT reproduce the edge function's bot-vs-human fork —
 * there's no way to usefully fake "is this Googlebot" locally, so every
 * request here gets the human path. Verifying that the still-real generated
 * pages (site/index.html, site/programs/index.html,
 * site/programs/{slug}.html, site/verify/index.html) actually reach a
 * crawler needs a real Netlify deploy preview.
 *
 * Node is not otherwise needed: the site has no build step.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { resolveRoute } from "./site/assets/js/routes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "site");
const PORT = Number(process.env.PORT ?? 4321);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const STUB_REDIRECTS = {
  "/admin/orders.html": "/admin/invoices.html",
  "/team/billing.html": "/invoices.html",
};

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  // Route resolution happens against the raw, undecorated pathname — "/"
  // must stay "/" here, matching routes.js's own key, not get turned into
  // "/index.html" the way the static-file fallback below needs it to.
  const rawPathname = normalize(decodeURIComponent(url.pathname))
    .replace(/^(\.\.[/\\])+/, "").split("\\").join("/");

  if (STUB_REDIRECTS[rawPathname]) {
    response.writeHead(302, { Location: STUB_REDIRECTS[rawPathname] });
    response.end();
    return;
  }

  // Every app route, plus the draft-preview template (staff-only, no SEO
  // value, always redirected — see netlify.toml), serves the shell.
  if (rawPathname === "/programs/program.html" || resolveRoute(rawPathname)) {
    response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    response.end(await readFile(join(ROOT, "app.html")));
    return;
  }

  // Real static assets: fonts, CSS, JS, images, robots.txt, sitemap.xml,
  // and the handful of HTML files routes.js doesn't claim (the ones a
  // crawler is meant to see directly in production). Directory-style
  // requests resolve to their index.html only here, never for routing.
  let path = rawPathname;
  if (path.endsWith("/")) path = join(path, "index.html").split("\\").join("/");
  const pathname = path;

  const candidates = extname(pathname)
    ? [join(ROOT, pathname)]
    : [join(ROOT, `${pathname}.html`), join(ROOT, pathname, "index.html")];

  for (const candidate of candidates) {
    if (!candidate.startsWith(ROOT)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      response.writeHead(200, {
        "Content-Type": TYPES[extname(candidate)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(await readFile(candidate));
      return;
    } catch {
      /* try the next candidate */
    }
  }

  // Anything else — a genuinely unrecognized path — still gets the shell;
  // router.js resolves it to the styled not-found page client-side.
  response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
  response.end(await readFile(join(ROOT, "app.html")));
}).listen(PORT, () => {
  console.log(`WHA Learning Portal — http://localhost:${PORT}`);
  if (process.argv.includes("--open")) {
    const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} http://localhost:${PORT}`);
  }
});
