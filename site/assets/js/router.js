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

/** Run the page module a fetched (or the live) document declares, if any. */
async function activate(doc) {
  const script = doc.querySelector('script[type="module"][src^="/assets/js/pages/"]');
  if (!script) return; // e.g. the meta-refresh bookmark-redirect stub pages
  const mod = await import(script.src);
  return runPage(mod.init);
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

async function navigate(url, { push = true } = {}) {
  const token = ++inFlight;
  let response;
  try {
    response = await fetch(url);
  } catch {
    location.href = url; // offline/network failure — fall back to a real load
    return;
  }
  if (!response.ok) {
    location.href = url; // e.g. Netlify's 404 rewrite — land on the real page
    return;
  }

  const doc = new DOMParser().parseFromString(await response.text(), "text/html");

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
    window.scrollTo(0, 0);
  }

  await activate(doc);
}

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
  navigate(url.href);
});

window.addEventListener("popstate", () => navigate(location.href, { push: false }));

activate(document);
