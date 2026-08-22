/**
 * The site's entire routing table — every URL that used to be a physical
 * HTML file is a key here instead. router.js looks a pathname up, sets the
 * header variant / <main> class / tab title synchronously, then dynamically
 * imports the module.
 *
 * A few of these (/, /programs/index.html, /programs/{slug}.html,
 * /verify/index.html) are ALSO still real, separate files build/prerender.mjs
 * fills in — being a key here is what makes navigating to one of them from
 * elsewhere in the app instant, without affecting what a direct load of the
 * URL gets (that's netlify.toml/serve.mjs's job: those specific paths are
 * deliberately left unredirected, so Netlify serves the real file). Their
 * own page modules (home.js, programs.js, verify.js) check for the
 * prerendered scaffold and hydrate it if present, building the page fresh
 * only when it isn't.
 *
 * Keyed by the FULL pathname, not the basename — /admin/order.html and
 * /orders/order.html are two different routes to two different modules;
 * anything that strips directories before matching would collide them.
 *
 * `title` feeds dom.js's setTitle() format ("<title> · WHA Learning
 * Portal"). Pages that call setTitle() themselves once their data loads
 * (most dynamic ones) only show this for the instant before that happens;
 * pages that never call it (dashboard, certificates, the admin list pages,
 * etc.) show it permanently, so it's this route's one true title. `null`
 * falls back to the shell's own default, "WHA Learning Portal".
 *
 * `header` is not cosmetic: layout.css sizes the two-row mobile nav
 * differently for site-header--app, and setting the wrong one for even one
 * frame is a layout shift. "app" pages call appChrome() and expect a
 * signed-in user; "public" pages call publicChrome()/autoChrome() and may
 * or may not have one.
 *
 * `preload` is filled in by build/preloads.mjs (see ROUTE_PRELOADS below) —
 * each route's own module graph minus the shared core already preloaded by
 * app.html itself.
 */
// shell.js's own "Home" nav link points at /index.html, not / (navLink's
// active-state check uses "/" via its `exact` list, but the href itself is
// the literal filename) — both need to resolve to the same route, or
// clicking Home from a page that doesn't intercept an unrecognized path
// falls through to a real reload that then 404s client-side on boot.
const HOME_ROUTE = {
  module: "/assets/js/pages/home.js",
  mainClass: "",
  header: "public",
  title: null,
};

export const ROUTES = {
  "/": HOME_ROUTE,
  "/index.html": HOME_ROUTE,
  "/account.html": {
    module: "/assets/js/pages/account.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "My details",
  },
  // The unified course builder. Full-bleed, not the usual centred shell — it
  // owns the viewport below the header and scrolls its two panes itself.
  "/admin/builder.html": {
    module: "/assets/js/pages/admin-builder.js",
    mainClass: "builder-main",
    header: "app",
    title: "Course Builder",
  },
  "/admin/invoices.html": {
    module: "/assets/js/pages/admin-invoices.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Invoices",
  },
  "/admin/learners.html": {
    module: "/assets/js/pages/admin-learners.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Learners",
  },
  "/admin/lesson.html": {
    module: "/assets/js/pages/admin-lesson.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Lesson",
  },
  "/admin/order.html": {
    module: "/assets/js/pages/admin-order.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Order",
  },
  "/admin/program-new.html": {
    module: "/assets/js/pages/admin-program-new.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Add course",
  },
  "/admin/program.html": {
    module: "/assets/js/pages/admin-program.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Programme",
  },
  "/admin/programs.html": {
    module: "/assets/js/pages/admin-programs.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Programmes",
  },
  "/admin/quiz.html": {
    module: "/assets/js/pages/admin-quiz.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Assessment",
  },
  "/admin/stats.html": {
    module: "/assets/js/pages/admin-stats.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Statistics",
  },
  "/certificates.html": {
    module: "/assets/js/pages/certificates.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "My certificates",
  },
  "/checkout.html": {
    module: "/assets/js/pages/checkout.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Enrol",
  },
  "/dashboard.html": {
    module: "/assets/js/pages/dashboard.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "My Courses",
  },
  "/invite.html": {
    module: "/assets/js/pages/invite.js",
    mainClass: "shell auth-page",
    header: "public",
    title: "Accept your invitation",
  },
  "/invoices.html": {
    module: "/assets/js/pages/invoices.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Payments and receipts",
  },
  "/learn/download-gate.html": {
    module: "/assets/js/pages/download-gate.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Before you continue",
  },
  "/learn/index.html": {
    module: "/assets/js/pages/learn.js",
    mainClass: "shell",
    header: "app",
    title: "Programme",
  },
  "/learn/lesson.html": {
    module: "/assets/js/pages/lesson.js",
    mainClass: "shell",
    header: "app",
    title: "Lesson",
  },
  "/learn/quiz.html": {
    module: "/assets/js/pages/quiz.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Assessment",
  },
  "/login.html": {
    module: "/assets/js/pages/login.js",
    mainClass: "shell auth-page",
    header: "public",
    title: "Sign in",
  },
  "/orders/order.html": {
    module: "/assets/js/pages/order.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Order",
  },
  "/programs/index.html": {
    module: "/assets/js/pages/programs.js",
    mainClass: "shell section",
    header: "public",
    title: null,
  },
  "/programs/program.html": {
    module: "/assets/js/pages/program.js",
    mainClass: "",
    header: "public",
    title: "Programme",
  },
  "/register.html": {
    module: "/assets/js/pages/register.js",
    mainClass: "shell auth-page",
    header: "public",
    title: "Create an account",
  },
  "/team/index.html": {
    module: "/assets/js/pages/team.js",
    mainClass: "shell section--tight",
    header: "app",
    title: "Team",
  },
  "/verify/certificate.html": {
    module: "/assets/js/pages/certificate-verify.js",
    mainClass: "shell shell--mid section",
    header: "public",
    title: "Certificate verification",
  },
  "/verify/index.html": {
    module: "/assets/js/pages/verify.js",
    mainClass: "shell shell--narrow section",
    header: "public",
    title: null,
  },
};

/**
 * The one route that varies by path segment rather than being a fixed
 * string: /programs/{slug}.html for a published programme. Checked only
 * when an exact ROUTES lookup misses. Mirrors program.js's own
 * currentSlug() parsing (the "index"/"program" exclusions match the
 * literal filenames that are ROUTES entries in their own right).
 */
const SLUG_ROUTE = /^\/programs\/([^/]+)\.html$/;
const SLUG_EXCLUDED = new Set(["index", "program"]);

export function matchProgramSlug(pathname) {
  const match = SLUG_ROUTE.exec(pathname);
  if (!match || SLUG_EXCLUDED.has(match[1])) return null;
  return {
    module: "/assets/js/pages/program.js",
    mainClass: "",
    header: "public",
    title: null,
  };
}

export const NOT_FOUND_ROUTE = {
  module: "/assets/js/pages/not-found.js",
  mainClass: "shell shell--narrow section center",
  header: "public",
  title: "Page not found",
};

/**
 * Resolve a pathname to a route, or null if it isn't one — callers fall
 * back to NOT_FOUND_ROUTE in that case.
 */
export function resolveRoute(pathname) {
  return ROUTES[pathname] ?? matchProgramSlug(pathname) ?? null;
}

// -- route preloads: generated by build/preloads.mjs --
export const ROUTE_PRELOADS = {
  "/": [
    "/assets/js/catalog.js",
    "/assets/js/components/program-card.js",
    "/assets/js/money.js",
    "/assets/js/nav-state.js",
    "/assets/js/pages/home.js"
  ],
  "/index.html": [
    "/assets/js/catalog.js",
    "/assets/js/components/program-card.js",
    "/assets/js/money.js",
    "/assets/js/nav-state.js",
    "/assets/js/pages/home.js"
  ],
  "/account.html": [
    "/assets/js/pages/account.js"
  ],
  "/admin/builder.html": [
    "/assets/js/components/block-editors.js",
    "/assets/js/components/block-render.js",
    "/assets/js/components/learner-preview.js",
    "/assets/js/components/question-editors.js",
    "/assets/js/drag-reorder.js",
    "/assets/js/money.js",
    "/assets/js/pages/admin-builder.js",
    "/assets/js/storage-upload.js"
  ],
  "/admin/invoices.html": [
    "/assets/js/invoices.js",
    "/assets/js/money.js",
    "/assets/js/pages/admin-invoices.js"
  ],
  "/admin/learners.html": [
    "/assets/js/pages/admin-learners.js",
    "/assets/js/progress.js"
  ],
  "/admin/lesson.html": [
    "/assets/js/components/block-render.js",
    "/assets/js/components/learner-preview.js",
    "/assets/js/drag-reorder.js",
    "/assets/js/pages/admin-lesson.js",
    "/assets/js/storage-upload.js"
  ],
  "/admin/order.html": [
    "/assets/js/mail.js",
    "/assets/js/money.js",
    "/assets/js/pages/admin-order.js",
    "/assets/js/pdf.js"
  ],
  "/admin/program-new.html": [
    "/assets/js/pages/admin-program-new.js"
  ],
  "/admin/program.html": [
    "/assets/js/components/block-render.js",
    "/assets/js/components/learner-preview.js",
    "/assets/js/drag-reorder.js",
    "/assets/js/money.js",
    "/assets/js/pages/admin-program.js",
    "/assets/js/storage-upload.js"
  ],
  "/admin/programs.html": [
    "/assets/js/catalog.js",
    "/assets/js/components/program-card.js",
    "/assets/js/money.js",
    "/assets/js/pages/admin-programs.js"
  ],
  "/admin/quiz.html": [
    "/assets/js/components/block-render.js",
    "/assets/js/components/learner-preview.js",
    "/assets/js/pages/admin-quiz.js"
  ],
  "/admin/stats.html": [
    "/assets/js/money.js",
    "/assets/js/pages/admin-stats.js"
  ],
  "/certificates.html": [
    "/assets/js/pages/certificates.js",
    "/assets/js/pdf.js",
    "/assets/js/progress.js"
  ],
  "/checkout.html": [
    "/assets/js/catalog.js",
    "/assets/js/mail.js",
    "/assets/js/money.js",
    "/assets/js/pages/checkout.js"
  ],
  "/dashboard.html": [
    "/assets/js/money.js",
    "/assets/js/pages/dashboard.js",
    "/assets/js/progress.js"
  ],
  "/invite.html": [
    "/assets/js/pages/invite.js"
  ],
  "/invoices.html": [
    "/assets/js/invoices.js",
    "/assets/js/money.js",
    "/assets/js/pages/invoices.js",
    "/assets/js/pdf.js"
  ],
  "/learn/download-gate.html": [
    "/assets/js/pages/download-gate.js"
  ],
  "/learn/index.html": [
    "/assets/js/components/curriculum.js",
    "/assets/js/pages/learn.js",
    "/assets/js/progress.js"
  ],
  "/learn/lesson.html": [
    "/assets/js/components/block-render.js",
    "/assets/js/components/curriculum.js",
    "/assets/js/pages/lesson.js",
    "/assets/js/progress.js"
  ],
  "/learn/quiz.html": [
    "/assets/js/pages/quiz.js",
    "/assets/js/progress.js"
  ],
  "/login.html": [
    "/assets/js/pages/login.js"
  ],
  "/orders/order.html": [
    "/assets/js/image-compress.js",
    "/assets/js/mail.js",
    "/assets/js/money.js",
    "/assets/js/pages/order.js",
    "/assets/js/pdf.js"
  ],
  "/programs/index.html": [
    "/assets/js/catalog.js",
    "/assets/js/components/program-card.js",
    "/assets/js/money.js",
    "/assets/js/nav-state.js",
    "/assets/js/pages/programs.js"
  ],
  "/programs/program.html": [
    "/assets/js/catalog.js",
    "/assets/js/money.js",
    "/assets/js/pages/program.js"
  ],
  "/register.html": [
    "/assets/js/pages/register.js"
  ],
  "/team/index.html": [
    "/assets/js/mail.js",
    "/assets/js/pages/team.js",
    "/assets/js/progress.js"
  ],
  "/verify/certificate.html": [
    "/assets/js/pages/certificate-verify.js"
  ],
  "/verify/index.html": [
    "/assets/js/nav-state.js",
    "/assets/js/pages/verify.js"
  ]
};
// -- end route preloads --
