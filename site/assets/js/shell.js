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

function navFor(role) {
  switch (role) {
    case "WHA_ADMIN":
      return [
        { href: "/admin/orders.html", label: "Orders" },
        { href: "/admin/invoices.html", label: "Invoices" },
        { href: "/admin/programs.html", label: "Programmes" },
        { href: "/admin/learners.html", label: "Learners" },
        { href: "/admin/stats.html", label: "Statistics" },
        { href: "/programs/index.html", label: "Catalogue" },
      ];
    case "ORG_ADMIN":
      return [
        { href: "/dashboard.html", label: "My learning" },
        { href: "/team/index.html", label: "Team" },
        { href: "/team/billing.html", label: "Billing" },
        { href: "/programs/index.html", label: "Catalogue" },
      ];
    default:
      return [
        { href: "/dashboard.html", label: "My learning" },
        { href: "/programs/index.html", label: "Catalogue" },
        { href: "/certificates.html", label: "Certificates" },
      ];
  }
}

/** Mark the nav item for the section we are in, the way NavLink did. */
function navLink({ href, label }) {
  const current = location.pathname;
  const base = href.replace(/\/index\.html$|\.html$/, "");
  const active = current === href || (base && current.startsWith(base));
  return el("a", {
    href,
    class: "nav-link",
    "aria-current": active ? "page" : null,
  }, label);
}

/* --- User menu ------------------------------------------------------------ */

function userMenu(user) {
  const panel = el("div", {
    class: "user-menu__panel",
    hidden: true,
    role: "menu",
  }, [
    el("div", { class: "user-menu__identity" }, [
      el("strong", {}, user.name),
      el("span", {}, user.email),
      el("span", {}, [
        roleLabels[user.role],
        user.organizationName ? ` · ${user.organizationName}` : null,
      ]),
    ]),
    el("a", { class: "user-menu__item", href: homeFor(user.role), role: "menuitem" },
      "My learning"),
    el("a", { class: "user-menu__item", href: "/certificates.html", role: "menuitem" },
      "My certificates"),
    el("button", {
      class: "user-menu__item",
      type: "button",
      role: "menuitem",
      onClick: () => signOut(),
    }, "Sign out"),
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
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return wrap;
}

/* --- Headers -------------------------------------------------------------- */

/**
 * Marketing header. Shows "My learning" to someone already signed in, so a
 * returning visitor is one click from their dashboard.
 */
export async function renderPublicHeader(target = "#site-header") {
  const host = document.querySelector(target);
  if (!host) return;

  track();
  const user = await getUser();
  host.className = "site-header";
  host.replaceChildren(
    el("div", { class: "shell site-header__bar" }, [
      logoLink({ href: "/", width: 140 }),
      el("nav", { class: "site-nav", "aria-label": "Main" }, [
        el("a", { href: "/programs/index.html", class: "nav-link" }, "Catalogue"),
        el("a", { href: "/verify/index.html", class: "nav-link" }, "Verify"),
        ...(user
          ? [buttonLink("My learning", homeFor(user.role), { size: "sm" })]
          : [
              el("a", { href: "/login.html", class: "nav-link" }, "Sign in"),
              buttonLink("Create account", "/register.html", { size: "sm" }),
            ]),
      ]),
    ]),
  );
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
  host.className = "site-header";
  host.replaceChildren(
    el("div", { class: "shell site-header__bar" }, [
      logoLink({ href: homeFor(user.role), width: 132 }),
      el("nav", { class: "app-nav--inline scroll-x", "aria-label": "Main" },
        items.map(navLink)),
      userMenu(user),
    ]),
    el("nav", { class: "app-nav--stacked scroll-x", "aria-label": "Main" },
      items.map(navLink)),
  );
}

/* --- Footer --------------------------------------------------------------- */

export function renderFooter(target = "#site-footer") {
  const host = document.querySelector(target);
  if (!host) return;

  host.className = "site-footer";
  host.replaceChildren(
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
          el("li", {}, el("a", { href: "/login.html" }, "Sign in")),
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
  );
}

/**
 * Chrome for a marketing page: public header + footer.
 * Returns the signed-in user, if there is one.
 */
export async function publicChrome() {
  renderFooter();
  await renderPublicHeader();
  return getUser();
}

/**
 * Chrome for a signed-in page. Guards the route first, so an anonymous visitor
 * is redirected before anything renders.
 */
export async function appChrome(user) {
  renderFooter();
  await renderAppHeader(user);
  return user;
}
