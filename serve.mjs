/**
 * Local preview server for site/.
 *
 *   node serve.mjs
 *
 * Serves the folder the way Netlify will, including the extensionless URLs
 * that netlify.toml rewrites (/login → login.html) and the styled 404. It is
 * only for looking at the site locally — Netlify serves site/ directly and
 * this file is not deployed.
 *
 * Node is not otherwise needed: the site has no build step.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

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

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/") || path.endsWith("\\")) path = join(path, "index.html");

  // Extensionless URLs resolve to the .html file, matching the rewrites in
  // netlify.toml. A rewrite, not a redirect, so query strings survive.
  const candidates = extname(path)
    ? [join(ROOT, path)]
    : [join(ROOT, `${path}.html`), join(ROOT, path, "index.html")];

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

  response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  response.end(await readFile(join(ROOT, "404.html")).catch(() => "Not found"));
}).listen(PORT, () => {
  console.log(`WHA Learning Portal — http://localhost:${PORT}`);
});
