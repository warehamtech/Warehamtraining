import { runPage, setTitle } from "./dom.js";
import { resolveRoute, NOT_FOUND_ROUTE, ROUTE_PRELOADS } from "./routes.js";
import { markLoaded } from "./nav-state.js";

/**
 * The site's entire client-side router. Every collapsed route lives in
 * routes.js and resolves against whatever document is currently loaded —
 * usually app.html, the single shell — with no HTML to fetch: just a
 * synchronous header/title/class swap and a dynamic import().
 *
 * A handful of pages (/, /programs/index.html, /programs/{slug}.html,
 * /verify/index.html) are still real, separate static files
 * build/prerender.mjs fills in, so a direct load of one of them gets real
 * content instantly instead of the blank shell. This file doesn't need to
 * know that: those paths are ROUTES entries too, and every document — the
 * shell or one of these — carries the same #site-header/#app/#site-footer
 * IDs and this same script, so navigating away from one of them (or back to
 * one, client-side) works exactly like navigating anywhere else.
 *
 * home.js/programs.js/verify.js need to know whether #app still holds their
 * page's own real, on-disk content or needs building from scratch — that
 * flag (nav-state.js's isFirstLoad) has to live in its own tiny module
 * rather than here: this file self-runs a real-browser-only bootstrap the
 * moment it's imported (the listeners and the goTo() call at the bottom),
 * and build/prerender.mjs imports those three page modules directly under
 * Node, with no real DOM — importing this file from any of them, even only
 * for an export, would run that bootstrap there too and crash.
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
  // A null title means "leave it alone" — the still-real prerendered pages
  // (/, /programs/index.html, /programs/{slug}.html, /verify/index.html)
  // already carry the correct one when reached by a direct load, and their
  // own page module sets an appropriate one itself when it isn't (reached
  // via client-side nav instead, with no prerendered document to read a
  // title from). Every other route sets one unconditionally.
  if (route.title !== null) setTitle(route.title);

  if (push) {
    history.pushState({}, "", url);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  return runPage(async () => {
    const mod = await import(route.module);
    if (typeof mod.init !== "function") {
      throw new Error(`${route.module} has no init() export.`);
    }
    // Flips only after init() genuinely settles, not after this activation
    // merely starts — runPage() doesn't expose fn()'s completion to its
    // caller (it's fire-and-forget outside its own error boundary), so
    // there's no other point that reliably fires exactly once, after this
    // one specific init() call, and not a moment sooner.
    try {
      return await mod.init();
    } finally {
      markLoaded();
    }
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
