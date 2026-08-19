/**
 * The smallest DOM helpers the pages need. No framework — `el()` builds nodes,
 * `mount()` swaps them in, and everything user-supplied goes in as a text node
 * rather than as HTML.
 */

/**
 * Build an element.
 *
 *   el("p", { class: "muted" }, "Hello")
 *   el("a", { href: "/x", "data-id": id }, [icon, "Label"])
 *
 * Strings in `children` become text nodes, so nothing a user typed can turn
 * into markup. The one place raw HTML is legitimate — lesson bodies authored by
 * a WHA admin — uses `rawHtml()` explicitly, so it is greppable.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/**
 * Append children, flattening nested arrays so `[a, list.map(...), b]` works
 * without the caller having to spread. Null/undefined/false are skipped, which
 * is what makes `cond ? node : null` read cleanly inline.
 */
export function append(node, children) {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Insert trusted HTML. Only for lesson bodies, which are authored in the admin
 * area by WHA staff — the same trust boundary the Next.js version had when it
 * used dangerouslySetInnerHTML for `bodyHtml`.
 */
export function rawHtml(html, className) {
  const node = document.createElement("div");
  if (className) node.className = className;
  node.innerHTML = html ?? "";
  return node;
}

/** Replace the contents of a mount point. Accepts nodes, arrays, or both. */
export function mount(target, ...children) {
  const node = typeof target === "string" ? document.querySelector(target) : target;
  if (!node) return null;
  node.replaceChildren();
  append(node, children.flat(Infinity));
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Read a query-string parameter — how the dynamic pages get their id. */
export function param(name, search = location.search) {
  return new URLSearchParams(search).get(name);
}

/** Build a URL with query parameters, skipping empty ones. */
export function href(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/* --- Formatting ----------------------------------------------------------- */

const DATE = new Intl.DateTimeFormat("en-ZA", {
  day: "numeric", month: "short", year: "numeric",
});
const DATETIME = new Intl.DateTimeFormat("en-ZA", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export function formatDate(value) {
  if (!value) return "—";
  return DATE.format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return "—";
  return DATETIME.format(new Date(value));
}

/** "3 days ago" / "in 5 days", for invoice due dates and last-seen stamps. */
export function relativeDays(value) {
  if (!value) return "";
  const days = Math.round((new Date(value) - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  return rtf.format(days, "day");
}

export function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatMinutes(minutes) {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Initials for the avatar in the user menu. */
export function initials(name) {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "?";
}

/* --- Page state ----------------------------------------------------------- */

export function showLoading(target, message = "Loading…") {
  return mount(target, el("p", { class: "page-state" }, message));
}

export function showError(target, message) {
  return mount(target, el("p", { class: "page-state", role: "alert" }, message));
}

/**
 * Run a page's entry point so a thrown error becomes a readable message
 * instead of a blank screen and a console trace nobody sees. Called by
 * router.js — once for the page reached by the initial hard load, and again
 * for every client-side navigation after that — rather than by pages
 * themselves, so the same error boundary applies either way.
 */
export function runPage(fn) {
  const run = () =>
    Promise.resolve(fn()).catch((error) => {
      console.error(error);
      showError(
        "#app",
        error?.message ?? "Something went wrong loading this page. Please refresh.",
      );
    });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
}

/** Set the document title, keeping the site suffix consistent. */
export function setTitle(text) {
  document.title = text ? `${text} · WHA Learning Portal` : "WHA Learning Portal";
}
