import { el, initials } from "./dom.js";
import { icon } from "./icons.js";
import { buttonLink } from "./ui.js";
import { company, roleLabels } from "./config.js";
import { getUser, homeFor, signOut } from "./session.js";
import { track } from "./analytics.js";

/**
 * The page chrome: public header, app header, user menu and footer.
 * Ports src/components/shell/.
 *
 * Every page carries `<header id="site-header">` and `<footer id="site-footer">`
 * in its HTML; these functions fill them once the session is known.
 */

/* --- Logo ----------------------------------------------------------------- */

// Source assets: 374x146 (colour) and 1024x341 (white).
const RATIO = { colour: 146 / 374, white: 341 / 1024 };

export function logo({ variant = "colour", width = 168, loading } = {}) {
  return el("img", {
    src: variant === "white"
      ? "/assets/brand/wha-butterfly-white.png"
      : "/assets/brand/wha-logo.png",
    alt: "Wareham & Associates",
    width,
    height: Math.round(width * RATIO[variant]),
    decoding: "async",
    loading: loading ?? undefined,
    style: { width: `${width}px`, height: "auto" },
  });
}

export function logoLink({ href = "/", variant = "colour", width = 150 } = {}) {
  return el("a", {
    href,
    class: "site-header__logo",
    "aria-label": "Wareham & Associates — Learning Portal home",
  }, logo({ variant, width }));
}

/* --- Navigation ----------------------------------------------------------- */

/**
 * Where "back to my own area" goes, and what to call it. WHA staff administer
 * the portal rather than learn on it, so for them this is the admin dashboard,
 * not "My Courses".
 */
export function homeLabel(role) {
  return role === "WHA_ADMIN" ? "Admin dashboard" : "My Courses";
}

function navFor(role) {
  switch (role) {
    case "WHA_ADMIN":
      // No "Catalogue" here: for staff the public site is a separate place to
      // visit, not a section of the admin area, so it gets the View site
      // button in the bar instead.
      //
      // Orders and Invoices used to be two tabs over the same `orders` rows —
      // one tab now does both jobs, so the order detail page (/admin/order.html,
      // singular) is folded into its match list too.
      return [
        { href: "/admin/invoices.html", label: "Invoices", match: ["/admin/order"] },
        { href: "/admin/programs.html", label: "Programmes" },
        { href: "/admin/learners.html", label: "Learners" },
        { href: "/admin/stats.html", label: "Statistics" },
      ];
    case "ORG_ADMIN":
      return [
        { href: "/programs/index.html", label: "Catalogue" },
        { href: "/dashboard.html", label: "My Courses" },
        { href: "/team/index.html", label: "Team" },
        { href: "/invoices.html", label: "Payments and receipts", match: ["/orders/"] },
        { href: "/certificates.html", label: "Certificates" },
        { href: "/verify/index.html", label: "Verify" },
      ];
    default:
      return [
        { href: "/programs/index.html", label: "Catalogue" },
        { href: "/dashboard.html", label: "My Courses" },
        { href: "/invoices.html", label: "Payments and receipts", match: ["/orders/"] },
        { href: "/certificates.html", label: "Certificates" },
        { href: "/verify/index.html", label: "Verify" },
      ];
  }
}

/**
 * Mark the nav item for the section we are in, the way NavLink did.
 *
 * `match` covers pages a tab owns that don't share its URL prefix — the
 * order detail page lives at /admin/order.html (singular), which is not a
 * prefix match for the Invoices tab at /admin/invoices.html, so without this
 * it highlighted nothing at all.
 */
/**
 * `exact` is for links whose section root is "/" itself — Home, on the public
 * header. `base` would ordinarily become "/" too (stripping the .html suffix
 * leaves nothing), and current.startsWith("/") is true for every path on the
 * site, which would mark Home active everywhere rather than just at the root.
 * Listing "/" as an exact match instead of a prefix sidesteps that.
 */
function navLink({ href, label, match = [], exact = [] }) {
  const current = location.pathname;
  const base = href.replace(/\/index\.html$|\.html$/, "");
  const active = current === href
    || exact.includes(current)
    || (base && current.startsWith(base))
    || match.some((prefix) => current.startsWith(prefix));
  return el("a", {
    href,
    class: "nav-link",
    "aria-current": active ? "page" : null,
  }, label);
}

/* --- User menu ------------------------------------------------------------ */

// renderAppHeader() runs once per client-side navigation now (router.js keeps
// the page alive instead of reloading it), and each call rebuilds a fresh
// menu with fresh document-level listeners below. Without aborting the
// previous render's listeners first, they'd pile up for the life of the tab —
// harmless individually (they just no-op against a detached `wrap`), but an
// unbounded leak all the same.
let menuAbort;

function userMenu(user) {
  menuAbort?.abort();
  menuAbort = new AbortController();
  const { signal } = menuAbort;

  const isStaff = user.role === "WHA_ADMIN";

  const panel = el("div", {
    class: "user-menu__panel",
    hidden: true,
    role: "menu",
  }, [
    el("div", { class: "user-menu__identity" }, [
      el("strong", {}, user.name),
      el("span", {}, user.email),
      el("span", { class: isStaff ? "user-menu__role" : null }, [
        roleLabels[user.role],
        user.organizationName ? ` · ${user.organizationName}` : null,
      ]),
    ]),

    // Two options, the same two for everyone. My Courses and My certificates
    // used to live here as well, but both are tabs in the bar already for the
    // roles that have them, and staff — who hold no seats and earn no
    // certificates — were left with a menu containing nothing but Sign out.
    el("a", { class: "user-menu__item", href: "/account.html", role: "menuitem" },
      "My details"),

    el("button", {
      class: "user-menu__item",
      type: "button",
      role: "menuitem",
      onClick: () => signOut(),
    }, "Log out"),
  ]);

  const trigger = el("button", {
    class: "user-menu__trigger",
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
  }, [
    el("span", { class: "avatar" }, initials(user.name)),
    el("span", { class: "user-menu__name" }, user.name),
    icon("chevronDown", 14),
  ]);

  const wrap = el("div", { class: "user-menu" }, [trigger, panel]);

  const close = () => {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) close();
  }, { signal });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  }, { signal });

  return wrap;
}

/* --- The active-tab indicator ----------------------------------------------
 *
 * .nav-indicator (layout.css) is the coloured folder-tab shape that sits
 * behind whichever .nav-link currently carries aria-current="page". Moving
 * it between renders — rather than just recolouring the new active link — is
 * what makes switching tabs read as travel instead of a snap.
 *
 * It is a SINGLE PERSISTENT element (getIndicator(), below), created once and
 * moved — never recreated — into each fresh header render. This matters more
 * than it looks: a CSS transition animates a change from an element's own
 * previously-painted style, and a brand-new element has no such history, so
 * the first style ever applied to one never animates. Recreating the
 * indicator fresh on every render (the first version of this did) meant
 * every single "move" was actually a new element's first-ever placement —
 * confirmed by instrumenting an actual navigation: the position changed
 * correctly, but never animated, no matter how carefully the "jump to the
 * old spot, then animate to the new one" sequencing was done. Keeping the
 * same element sidesteps the problem instead of fighting it: its current
 * position already IS the true previous state, so simply setting a new
 * target (transition left on) is enough.
 *
 * A direct child of #site-header rather than of whichever row (.site-nav /
 * .app-nav--inline / .app-nav--stacked) currently owns the active tab — see
 * the long comment on .nav-indicator in layout.css for why: those rows can
 * clip it. Only one row is ever visible at a time (CSS media queries, not
 * JS, decide that), so one indicator, repositioned against whichever row
 * currently has a visible active tab, is enough — findActiveTab() below is
 * what does that search.
 */

let indicatorEl = null;

/** The one indicator, created the first time anything asks for it. */
function getIndicator() {
  indicatorEl ??= el("div", { class: "nav-indicator", hidden: true });
  return indicatorEl;
}

/**
 * Whichever row currently has a visible active tab, or null. Only one ever
 * does: the app header's two rows are mutually exclusive via the 1024px
 * breakpoint, and a row hidden by that breakpoint has zero size, which is
 * what the width/height check below is for.
 */
function findActiveTab(host) {
  for (const selector of [".site-nav", ".app-nav--inline", ".app-nav--stacked"]) {
    const row = host.querySelector(selector);
    const active = row?.querySelector('.nav-link[aria-current="page"]');
    if (!active) continue;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.width === 0 || rowRect.height === 0) continue; // hidden by the breakpoint
    return { row, active };
  }
  return null;
}

/** The active tab's position within `host` (#site-header), or null if there
 *  isn't one to find. */
function measureActiveRect(host) {
  const found = findActiveTab(host);
  if (!found) return null;
  const hostRect = host.getBoundingClientRect();
  const rowRect = found.row.getBoundingClientRect();
  const activeRect = found.active.getBoundingClientRect();
  return {
    left: activeRect.left - hostRect.left,
    width: activeRect.width,
    // The row's own top, not the link's: the indicator spans the row's full
    // height, the same shape a border-background trick would have given a
    // link stretched to fill its row.
    top: rowRect.top - hostRect.top,
  };
}

/** Which header variant the indicator was last positioned for — "public" or
 *  "app". Switching between them means a different DOM and a different nav
 *  array, so there is nothing meaningful to travel from; see instant below. */
let indicatorKind = null;

/**
 * Move the shared indicator onto whichever tab in `host` is currently active.
 *
 * `instant` skips the transition — used for a viewport resize and the
 * font-settle correction below, where "jump silently to the correct spot" is
 * right and "visibly travel there" is not. It's also forced automatically the
 * first time a given header `kind` ("public" or "app") is positioned: on the
 * very first header of the session there is nothing to travel from yet, and
 * switching between the public and app header is a DOM swap, not a
 * navigation between two tabs of the same bar.
 */
function positionIndicator(host, kind, { instant: forceInstant = false } = {}) {
  const indicator = getIndicator();
  const target = measureActiveRect(host);
  if (!target) {
    indicator.hidden = true;
    indicatorKind = kind;
    return;
  }

  indicator.hidden = false;
  const instant = forceInstant || indicatorKind !== kind;
  indicatorKind = kind;

  if (instant) indicator.style.transition = "none";
  indicator.style.top = `${target.top}px`;
  indicator.style.width = `${target.width}px`;
  indicator.style.transform = `translateX(${target.left}px)`;
  if (instant) {
    indicator.getBoundingClientRect(); // flush the jump before the transition comes back on
    indicator.style.transition = "";
  }
}

/**
 * Keeps the indicator glued to its tab across a viewport resize. Without
 * this, resizing past the 1024px breakpoint that swaps .app-nav--inline for
 * .app-nav--stacked (or just reflow from a font/zoom change) leaves it sized
 * for a layout that no longer applies, until the next navigation happens to
 * rebuild the header.
 */
let indicatorResizeAbort;

function watchIndicatorOnResize(host) {
  indicatorResizeAbort?.abort();
  indicatorResizeAbort = new AbortController();
  window.addEventListener("resize", () => {
    positionIndicator(host, indicatorKind, { instant: true });
  }, { signal: indicatorResizeAbort.signal });
}

/**
 * base.css loads Roboto with font-display: swap, so the very first render of
 * a header can measure and place the indicator against fallback-font text
 * metrics moments before the real font swaps in and reflows that same text —
 * confirmed: a fresh re-measurement minutes later, with the font long
 * settled, found a materially different position than what actually got
 * painted at load. document.fonts.ready fires once the swap is done, so this
 * corrects it. Not awaited — chrome rendering shouldn't wait on font loading.
 *
 * Registered at most once per tab, not once per render: past the first
 * header, document.fonts.ready is already resolved, so a .then() on it fires
 * on the very next microtask — confirmed, this was overriding every ordinary
 * navigation's animated move with an instant snap moments after it started,
 * because every render was re-registering the correction and immediately
 * triggering it. Fonts only ever need to settle once for the life of a tab.
 */
let fontsSettleRegistered = false;

function resyncIndicatorOnceFontsSettle(host) {
  if (fontsSettleRegistered) return;
  fontsSettleRegistered = true;
  document.fonts.ready.then(() => positionIndicator(host, indicatorKind, { instant: true }));
}

/* --- Headers -------------------------------------------------------------- */

/**
 * Marketing header. Shows "My Courses" to someone already signed in, so a
 * returning visitor is one click from their dashboard.
 *
 * Only pages that are purely public use this — anything a signed-in reader
 * also has a tab for goes through autoChrome() instead, so the app header
 * follows them there.
 */
/**
 * The public header's contents, as nodes.
 *
 * Pure on purpose: no session read, no DOM lookup, no analytics. Everything
 * that decides how the header *looks* lives here; everything that makes it
 * *happen* lives in renderPublicHeader below. That split is what lets
 * build/prerender.mjs draw this exact header at generate time from Node —
 * rather than keeping a second copy of the markup that would quietly drift
 * away from this one.
 */
export function publicHeaderNodes(user = null) {
  return el("div", { class: "shell site-header__bar" }, [
    logoLink({ href: "/", width: 140 }),
    el("nav", { class: "site-nav", "aria-label": "Main" }, [
      // navLink(), not a plain <a>, so Home/Catalogue/Verify carry
      // aria-current — the folder-tab indicator (layout.css,
      // positionIndicator() above) has nothing to attach to otherwise. The
      // indicator itself is NOT built here: it's a persistent, JS-owned
      // element (getIndicator()) with no meaning outside a real browser, so
      // it stays out of this function's pure, prerender-safe output.
      navLink({ href: "/index.html", label: "Home", exact: ["/"] }),
      navLink({ href: "/programs/index.html", label: "Catalogue" }),
      navLink({ href: "/verify/index.html", label: "Verify" }),
      ...(user
        ? [buttonLink(homeLabel(user.role), homeFor(user.role), { size: "sm" })]
        : [
            navLink({ href: "/login.html", label: "Sign in" }),
            buttonLink("Create account", "/register.html", { size: "sm" }),
          ]),
    ]),
  ]);
}

/** The class shell.js puts on the host. The generator writes it into the HTML. */
export const PUBLIC_HEADER_CLASS = "site-header";

export async function renderPublicHeader(target = "#site-header") {
  const host = document.querySelector(target);
  if (!host) return;

  track();
  const user = await getUser({ allowStale: true });

  host.className = PUBLIC_HEADER_CLASS;
  host.replaceChildren(publicHeaderNodes(user), getIndicator());

  positionIndicator(host, "public");
  watchIndicatorOnResize(host);
  resyncIndicatorOnceFontsSettle(host);
}

/**
 * Signed-in header. The nav sits inline on desktop and wraps to its own
 * scrollable row on small screens, so a WHA admin's four items still fit.
 */
export async function renderAppHeader(user, target = "#site-header") {
  const host = document.querySelector(target);
  if (!host) return;

  track();
  const items = navFor(user.role);
  const isStaff = user.role === "WHA_ADMIN";

  // On a phone the bar has no room for the pill or the button, so View site
  // rides along in the stacked nav row instead.
  const stackedItems = isStaff
    ? [...items, { href: "/index.html", label: "View site" }]
    : items;

  host.className = isStaff ? "site-header site-header--admin" : "site-header";
  host.replaceChildren(
    el("div", { class: "shell site-header__bar" }, [
      logoLink({ href: homeFor(user.role), width: 132 }),
      isStaff
        ? el("span", { class: "role-pill", title: roleLabels[user.role] },
            [icon("shieldCheck", 13), "Admin"])
        : null,
      el("nav", { class: "app-nav--inline scroll-x", "aria-label": "Main" },
        items.map(navLink)),
      isStaff
        ? buttonLink([icon("externalLink", 14), "View site"], "/index.html",
            { variant: "secondary", size: "sm", className: "view-site" })
        : null,
      userMenu(user),
    ]),
    el("nav", { class: "app-nav--stacked scroll-x", "aria-label": "Main" },
      stackedItems.map(navLink)),
    getIndicator(),
  );

  // Only one row (inline or stacked) is ever visible at a time — see
  // findActiveTab() — so one indicator, repositioned against whichever one
  // that is, covers both.
  positionIndicator(host, "app");
  watchIndicatorOnResize(host);
  resyncIndicatorOnceFontsSettle(host);
}

/* --- Footer --------------------------------------------------------------- */

/**
 * `user` decides one link: the Portal column offered "Sign in" to everybody,
 * including people who were already signed in and reading it from inside
 * their own account. Signed in, that slot points back at their own area
 * instead.
 */
export const FOOTER_CLASS = "site-footer";

/** The footer's contents, as nodes. Pure, for the same reason as the header. */
export function footerNodes(user = null) {
  return [
    el("div", { class: "shell site-footer__cols" }, [
      el("div", {}, [
        logo({ width: 150, loading: "lazy" }),
        el("p", { class: "site-footer__blurb" },
          "International standards and compliance consulting, training and facilitation."),
      ]),
      el("div", {}, [
        el("h2", {}, "Portal"),
        el("ul", {}, [
          el("li", {}, el("a", { href: "/programs/index.html" }, "Training catalogue")),
          el("li", {}, user
            ? el("a", { href: homeFor(user.role) }, homeLabel(user.role))
            : el("a", { href: "/login.html" }, "Sign in")),
          el("li", {}, el("a", { href: "/verify/index.html" }, "Verify a certificate")),
        ]),
      ]),
      el("div", {}, [
        el("h2", {}, "Contact"),
        el("address", {}, [
          ...company.addressLines.map((line) => el("p", {}, line)),
          el("p", { style: { paddingTop: "0.5rem" } },
            el("a", { href: `tel:${company.phone.replace(/[^\d+]/g, "")}` }, company.phone)),
          el("p", {}, el("a", { href: `mailto:${company.email}` }, company.email)),
        ]),
      ]),
    ]),
    el("div", { class: "site-footer__legal" },
      el("div", { class: "shell" },
        el("p", {}, `© ${new Date().getFullYear()} ${company.legalName}. All rights reserved.`))),
  ];
}

export function renderFooter(user = null, target = "#site-footer") {
  const host = document.querySelector(target);
  if (!host) return;

  host.className = FOOTER_CLASS;
  host.replaceChildren(...footerNodes(user));
}

/* --- Correcting a stale header -------------------------------------------- */

/**
 * Which chrome this page drew, so a background profile refresh can redraw the
 * same one. The three entry points below take the profile from session.js's
 * stale-while-revalidate path, which means the first paint may be built from a
 * cached copy — the right trade for a header, but only because it corrects
 * itself when the real read lands.
 *
 * Nothing here re-reads the network: session.js stores the new profile before
 * it dispatches, so the getUser() calls inside these are in-memory.
 */
let lastChrome = null;

window.addEventListener("wha:profilechange", (event) => {
  if (lastChrome === "app") appChrome(event.detail);
  else if (lastChrome === "auto") autoChrome();
  else if (lastChrome === "public") publicChrome();
});

/**
 * Chrome for a marketing page: public header + footer.
 * Returns the signed-in user, if there is one.
 */
export async function publicChrome() {
  lastChrome = "public";
  const user = await getUser({ allowStale: true });
  renderFooter(user);
  await renderPublicHeader();
  return user;
}

/**
 * Chrome for a signed-in page. Guards the route first, so an anonymous visitor
 * is redirected before anything renders.
 */
export async function appChrome(user) {
  lastChrome = "app";
  renderFooter(user);
  await renderAppHeader(user);
  return user;
}

/**
 * Chrome for a page that anyone may read but that also sits in a signed-in
 * user's own navigation — the catalogue, a programme, the verify pages.
 *
 * These used to take publicChrome() unconditionally, which meant a learner
 * who clicked "Catalogue" in their own header watched it turn back into the
 * marketing header, complete with a Sign in link, and had no way back to
 * their courses except the one button. It read as being signed out. Which
 * header to draw is a question about the reader, not about the page.
 *
 * Returns the signed-in user, or null — same shape publicChrome() returns,
 * so callers swapping between them need no other change.
 */
export async function autoChrome() {
  lastChrome = "auto";
  const user = await getUser({ allowStale: true });
  renderFooter(user);
  if (user) await renderAppHeader(user);
  else await renderPublicHeader();
  return user;
}
