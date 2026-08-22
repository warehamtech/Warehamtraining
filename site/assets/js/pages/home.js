import { el, mount } from "../dom.js";
import { icon } from "../icons.js";
import { publicChrome } from "../shell.js";
import { emptyState } from "../ui.js";
import { listPrograms } from "../catalog.js";
import { programCard } from "../components/program-card.js";

/** Port of src/app/(public)/page.tsx. */

const trust = [
  {
    iconName: "shieldCheck",
    title: "ISO 9001 certified",
    body: "Our own management system is certified to the standard we train you on.",
  },
  {
    iconName: "award",
    title: "Approved BRCGS Training Partner",
    body: "Our Director of Food Safety is an approved BRCGS training partner.",
  },
  {
    iconName: "checkCircle",
    title: "100% certification success rate",
    body: "Every client we have guided through certification has achieved it.",
  },
];

const steps = [
  {
    iconName: "monitorPlay",
    title: "Choose a programme",
    body: "Browse the catalogue and pick the standard your team needs — for one learner or for a whole site.",
  },
  {
    iconName: "receipt",
    title: "Get an invoice",
    body: "Check out and a VAT invoice is issued immediately. Pay by EFT and upload your proof of payment.",
  },
  {
    iconName: "checkCircle",
    title: "Learn at your pace",
    body: "We activate your seats. Work through video, written and downloadable material, ticking off lessons as you go.",
  },
  {
    iconName: "award",
    title: "Earn your certificate",
    body: "Pass each course assessment and download a verifiable certificate of completion.",
  },
];

/* --- Render ---------------------------------------------------------------
 *
 * These are pure: given their inputs they return nodes, and they read
 * neither the session nor the network. build/prerender.mjs calls trustNodes/
 * stepsNodes/catalogueNodes at generate time, splicing each into its own
 * fixed spot in site/index.html's hand-authored hero/trust/catalogue/steps/
 * quote markup — so that a visitor (and a crawler, and a link unfurler)
 * gets the page without waiting on JavaScript. init() below reconstructs
 * that same surrounding markup and calls the same node-builders, which is
 * what keeps the generated copy and the live one from drifting apart.
 */

export function heroNodes() {
  return el("section", { class: "hero" },
    el("div", { class: "shell hero__inner" },
      el("div", { class: "hero__content" }, [
        el("img", {
          src: "/assets/brand/wha-butterfly-white.png", alt: "Wareham & Associates",
          width: "230", height: "77", fetchpriority: "high", decoding: "async",
        }),
        el("p", { class: "hero__eyebrow" }, "Learning Portal"),
        el("h1", { class: "display" }, "Compliance training that builds lasting capability."),
        el("p", { class: "hero__lede" },
          "World-class online training in international standards, led by subject " +
          "matter experts. Trusted by blue-chip manufacturers and service " +
          "providers across Africa."),
        el("div", { class: "hero__actions" }, [
          el("a", { class: "btn btn--accent btn--lg", href: "/programs/index.html" }, "Browse the catalogue"),
          el("a", { class: "btn btn--on-dark btn--lg", href: "/login.html" }, "Sign in to your learning"),
        ]),
      ])));
}

export function quoteNodes() {
  return el("figure", { class: "quote" }, [
    el("blockquote", { class: "display" },
      "“We believe that the cost of compliance should be zero — our " +
      "team of experts work closely with your management team to deliver " +
      "measurable benefits while meeting your market, legal and regulatory " +
      "requirements.”"),
    el("figcaption", {}, [
      el("strong", {}, "Grant Wareham"),
      " · Managing Director, Wareham & Associates",
    ]),
  ]);
}

export function trustNodes() {
  return trust.map((item) =>
    el("li", {}, [
      icon(item.iconName, 20),
      el("div", {}, [
        el("strong", {}, item.title),
        el("span", {}, item.body),
      ]),
    ]));
}

export function stepsNodes() {
  return steps.map((step, index) =>
    el("li", { class: "step" }, [
      el("div", { class: "step__head" }, [
        el("span", { class: "step__num tabular" }, String(index + 1)),
        icon(step.iconName, 20),
      ]),
      el("h3", {}, step.title),
      el("p", {}, step.body),
    ]));
}

export function catalogueNodes(programs) {
  return programs.length
    ? el("div", { class: "grid grid--cards" }, programs.map(programCard))
    : el("p", { class: "empty--dashed", style: { padding: "2.5rem 1.25rem", textAlign: "center" } },
        "The catalogue is being prepared. Please check back shortly.");
}

/** How many programmes the landing page previews. The generator matches it. */
export const PREVIEW_LIMIT = 6;

export async function init() {
  publicChrome();

  // Only the catalogue needs the database; everything else renders instantly.
  let catalogue;
  try {
    catalogue = catalogueNodes(await listPrograms(PREVIEW_LIMIT));
  } catch (error) {
    console.error(error);
    catalogue = emptyState({
      iconName: "alert",
      title: "The catalogue could not be loaded",
      description: "Please refresh the page, or call us on (021) 713-2380.",
    });
  }

  mount("#app", [
    heroNodes(),
    el("section", { class: "section--band" },
      el("ul", { class: "shell trust" }, trustNodes())),
    el("section", { class: "shell section" }, [
      el("div", { class: "page-head" }, [
        el("div", {}, [
          el("h2", { class: "display" }, "Training programmes"),
          el("p", {},
            "Each programme bundles several courses. Work through them in your own " +
            "time and earn a certificate on completion."),
        ]),
        el("a", { class: "link", href: "/programs/index.html" }, "View all programmes"),
      ]),
      catalogue,
    ]),
    el("section", { class: "section--band" },
      el("div", { class: "shell section" }, [
        el("h2", { class: "display" }, "How it works"),
        el("ol", { class: "steps" }, stepsNodes()),
      ])),
    el("section", { class: "shell section" }, quoteNodes()),
  ]);
}
