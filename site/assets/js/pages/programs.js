import { el, mount } from "../dom.js";
import { autoChrome } from "../shell.js";
import { emptyState, buttonLink } from "../ui.js";
import { listPrograms } from "../catalog.js";
import { programCard } from "../components/program-card.js";

/** Port of src/app/(public)/programs/page.tsx. */

/**
 * The catalogue grid, or the "nothing here yet" panel. Pure — see the note in
 * home.js; build/prerender.mjs renders this into programs/index.html at
 * generate time and init() renders the same thing in the browser.
 */
export function catalogueNodes(programs) {
  return programs.length
    ? el("div", { class: "grid grid--cards" }, programs.map(programCard))
    : emptyState({
        iconName: "bookOpen",
        title: "The catalogue is being prepared",
        description:
          "New programmes are added as they are published. Please check back shortly, or call us to discuss what your team needs.",
        action: buttonLink("Talk to us", "tel:0217132380", { variant: "secondary" }),
      });
}

export async function init() {
  autoChrome();

  let catalogue;
  try {
    catalogue = catalogueNodes(await listPrograms());
  } catch (error) {
    console.error(error);
    catalogue = emptyState({
      iconName: "alert",
      title: "The catalogue could not be loaded",
      description: "Please refresh the page, or call us on (021) 713-2380.",
    });
  }

  // #app itself already carries the "shell section" class (routes.js's
  // mainClass for this route), matching the hand-authored markup
  // build/prerender.mjs splices into for the static crawler-facing copy.
  mount("#app", [
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "Training programmes"),
        el("p", {},
          "Each programme bundles several courses, ending in an assessment. Buy a " +
          "single seat or several for your team on one invoice."),
      ])),
    catalogue,
  ]);
}
