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

export function logo({ variant = "colour", width = 168 } = {}) {
  return el("img", {
    src: variant === "white"
      ? "/assets/brand/wha-butterfly-white.png"
      : "/assets/brand/wha-logo.png",
    alt: "Wareham & Associates",
    width,
    height: Math.round(width * RATIO[variant]),
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
function navLink({ href, label, match = [] }) {
  const current = location.pathname;
  const base = href.replace(/\/index\.html$|\.html$/, "");
  const active = current === href
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
      el("a", { href: "/index.html", class: "nav-link" }, "Home"),
      el("a", { href: "/programs/index.html", class: "nav-link" }, "Catalogue"),
      el("a", { href: "/verify/index.html", class: "nav-link" }, "Verify"),
      ...(user
        ? [buttonLink(homeLabel(user.role), homeFor(user.role), { size: "sm" })]
        : [
            el("a", { href: "/login.html", class: "nav-link" }, "Sign in"),
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
  host.replaceChildren(publicHeaderNodes(user));
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
  );
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
        logo({ width: 150 }),
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
