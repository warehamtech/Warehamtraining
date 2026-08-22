import { runPage } from "./dom.js";

/**
 * Turbo/htmx-style partial navigation: intercept same-origin link clicks,
 * fetch the target page's HTML, swap `#app` in place, and hand off to that
 * page's own `init()` — instead of a full browser reload. Keeps the header,
 * footer, vendored Supabase library and the in-memory session cache
 * (session.js) alive for the whole tab, which is where the real cost of
 * "moving between pages feels slow" lived.
 *
 * Every page still carries its own `<script type="module" src=".../pages/X.js">`
 * tag unchanged — the browser's native handling of that tag is what fetches,
 * parses and caches the module, so the dynamic `import()` below (both for the
 * very first page and for every navigation after it) resolves against that
 * same cache instead of costing a second network round trip.
 */

/**
 * Run the page module a fetched (or the live) document declares, if any.
 *
 * Everything here is inside the error boundary on purpose. A page's `#app`
 * ships a "Loading…" placeholder that only its own `init()` ever clears, so
 * anything that throws before `init()` runs — a module that fails to parse,
 * a missing export — would otherwise leave that placeholder on screen with
 * no error anywhere the reader can see it, which reads as the site hanging
 * rather than as a page that broke.
 */
async function activate(doc) {
  const script = doc.querySelector('script[type="module"][src^="/assets/js/pages/"]');
  if (!script) return; // e.g. the meta-refresh bookmark-redirect stub pages
  const src = script.getAttribute("src");
  if (!src) return;
  return runPage(async () => {
    const mod = await import(src);
    if (typeof mod.init !== "function") {
      throw new Error(`${src} has no init() export.`);
    }
    return mod.init();
  });
}

/**
 * `learn.css` is the one stylesheet not every page carries (only
 * learn/index, learn/lesson, learn/quiz, learn/download-gate). Add it when
 * navigating in; there's no need to remove it navigating back out.
 */
function syncLearnStylesheet(doc) {
  const learn = doc.querySelector('link[href="/assets/css/learn.css"]');
  if (learn && !document.querySelector('link[href="/assets/css/learn.css"]')) {
    document.head.append(learn.cloneNode());
  }
}

let inFlight = 0;
const htmlCache = new Map();

/** Prefetch a page HTML into cache ahead of user click. */
function prefetch(url) {
  if (htmlCache.has(url)) return;
  const promise = fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .catch((err) => {
      htmlCache.delete(url);
      throw err;
    });
  htmlCache.set(url, promise);
}

async function navigate(url, { push = true } = {}) {
  const token = ++inFlight;
  let htmlText;
  try {
    if (htmlCache.has(url)) {
      htmlText = await htmlCache.get(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        location.href = url; // e.g. Netlify's 404 rewrite — land on the real page
        return;
      }
      htmlText = await response.text();
    }
  } catch {
    location.href = url; // offline/network failure — fall back to a real load
    return;
  }

  const doc = new DOMParser().parseFromString(htmlText, "text/html");

  // A newer navigation started while this fetch was in flight — drop this one.
  if (token !== inFlight) return;

  const newMain = doc.querySelector("#app");
  const currentMain = document.querySelector("#app");
  // Covers the two meta-refresh redirect stubs (admin/orders.html,
  // team/billing.html), which have neither #app nor a page script, and
  // anything else unexpected — a real navigation is always correct here.
  if (doc.querySelector('meta[http-equiv="refresh" i]') || !newMain || !currentMain) {
    location.href = url;
    return;
  }

  syncLearnStylesheet(doc);
  document.title = doc.title;
  currentMain.className = newMain.className;
  currentMain.replaceChildren(...newMain.childNodes);

  // The URL must be live before the page module runs: several pages read
  // query params (dom.js's param()) at init() time from live location.search,
  // and would otherwise see the previous page's URL.
  if (push) {
    history.pushState({}, "", url);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }

  await activate(doc);
}

// Prefetch internal pages on pointer hover or keyboard focus
document.addEventListener("pointerenter", (event) => {
  const link = event.target?.closest?.("a");
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
  const url = new URL(link.href, location.href);
  if (url.origin === location.origin && url.pathname !== location.pathname) {
    prefetch(url.href);
  }
}, { passive: true, capture: true });

document.addEventListener("focusin", (event) => {
  const link = event.target?.closest?.("a");
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
  const url = new URL(link.href, location.href);
  if (url.origin === location.origin && url.pathname !== location.pathname) {
    prefetch(url.href);
  }
}, { passive: true });

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

  event.preventDefault();
  // Anything unforeseen between here and the swap should still get the reader
  // to the page they asked for: a real navigation always works, and is much
  // better than an intercepted click that silently does nothing.
  navigate(url.href).catch((error) => {
    console.error(error);
    location.href = url.href;
  });
});

window.addEventListener("popstate", () => {
  navigate(location.href, { push: false }).catch((error) => {
    console.error(error);
    location.reload();
  });
});

// The page reached by a real browser load. `activate` carries its own error
// boundary, so this cannot reject; the guard is here so that a future change
// to it can't quietly turn back into an unhandled rejection.
activate(document).catch((error) => console.error(error));
