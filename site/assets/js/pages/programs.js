import { el, mount } from "../dom.js";
import { publicChrome } from "../shell.js";
import { emptyState, buttonLink } from "../ui.js";
import { listPrograms } from "../catalog.js";
import { programCard } from "../components/program-card.js";

/** Port of src/app/(public)/programs/page.tsx. */

export async function init() {
  publicChrome();

  const programs = await listPrograms();

  mount("#catalogue",
    programs.length
      ? el("div", { class: "grid grid--cards" }, programs.map(programCard))
      : emptyState({
          iconName: "bookOpen",
          title: "The catalogue is being prepared",
          description:
            "New programmes are added as they are published. Please check back shortly, or call us to discuss what your team needs.",
          action: buttonLink("Talk to us", "tel:0217132380", { variant: "secondary" }),
        }));
}
