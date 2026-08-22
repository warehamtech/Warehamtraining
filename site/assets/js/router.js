import { runPage, setTitle } from "./dom.js";
import { resolveRoute, NOT_FOUND_ROUTE, ROUTE_PRELOADS } from "./routes.js";

/**
 * The site's entire client-side router. Every route lives in routes.js —
 * there is no HTML document to fetch for any of them, `app.html` (the one
 * document this script ever runs in for a real visitor) already has
 * everything. A handful of pages still exist as separate static files
 * purely so crawlers/link-unfurlers see real content without running JS
 * (see netlify/edge-functions/prerender-for-bots.ts); a real visitor is
 * rewritten to app.html before that HTML ever reaches the browser, so this
 * file never needs to know those other documents exist.
 */

function warmModule(specifier) {
  import(specifier).catch(() => {}); // fire-and-forget; a real click will surface any error
}

/** Injects this route's own extra modulepreload hints, once, before import(). */
const preloaded = new Set();
function ensurePreloaded(pathname) {
  if (preloaded.has(pathname)) return;
  preloaded.add(pathname);
  for (const specifier of ROUTE_PRELOADS[pathname] ?? []) {
    if (document.querySelector(`link[rel="modulepreload"][href="${specifier}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = specifier;
    document.head.append(link);
  }
}

async function activateRoute(route, pathname, { push, url } = {}) {
  ensurePreloaded(pathname);

  const header = document.querySelector("#site-header");
  const main = document.querySelector("#app");
  header.className = route.header === "app" ? "site-header site-header--app" : "site-header";
  main.className = route.mainClass;
  setTitle(route.title);

  if (push) {
    history.pushState({}, "", url);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  return runPage(async () => {
    const mod = await import(route.module);
    if (typeof mod.init !== "function") {
      throw new Error(`${route.module} has no init() export.`);
    }
    return mod.init();
  });
}

function goTo(pathname, opts) {
  const route = resolveRoute(pathname) ?? NOT_FOUND_ROUTE;
  return activateRoute(route, pathname, opts);
}

// Prefetch internal pages on pointer hover or keyboard focus: warm the
// target route's module cache so the click, when it comes, is instant.
function prefetchTarget(event) {
  const link = event.target?.closest?.("a");
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  const route = resolveRoute(url.pathname);
  if (route) warmModule(route.module);
}
document.addEventListener("pointerenter", prefetchTarget, { passive: true, capture: true });
document.addEventListener("focusin", prefetchTarget, { passive: true });

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a");
  if (!link) return;
  if (link.target && link.target !== "_self") return;
  if (link.hasAttribute("download")) return;

  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname === location.pathname && url.hash) return; // same-page anchor

  const route = resolveRoute(url.pathname);
  // Not one of ours (a PDF, an image, anything else) — let the browser
  // handle it normally rather than guessing.
  if (!route) return;

  event.preventDefault();
  activateRoute(route, url.pathname, { push: true, url: url.href }).catch((error) => {
    console.error(error);
    location.href = url.href; // a real navigation always works
  });
});

window.addEventListener("popstate", () => {
  goTo(location.pathname, { push: false }).catch((error) => {
    console.error(error);
    location.reload();
  });
});

// The page reached by a real browser load.
goTo(location.pathname, { push: false }).catch((error) => console.error(error));
