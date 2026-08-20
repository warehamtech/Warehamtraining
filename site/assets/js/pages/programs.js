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
  mount("#catalogue", catalogueNodes(await listPrograms()));
}
