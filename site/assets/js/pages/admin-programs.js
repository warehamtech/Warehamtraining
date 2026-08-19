import { el, mount } from "../dom.js";
import { appChrome } from "../shell.js";
import { card, emptyState } from "../ui.js";
import { requireRole } from "../session.js";
import { listPrograms } from "../catalog.js";
import { programCard, programCardCta } from "../components/program-card.js";

/**
 * The admin catalogue. A card grid — same cards the public catalogue uses,
 * plus an "Add Course" tile that launches the quick-create step of the
 * course-building flow (admin-program-new.js → admin-program.js).
 */

async function render(admin) {
  const programs = await listPrograms();

  mount("#app",
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "Programmes"),
        el("p", {}, "The catalogue, including drafts that are not publicly visible."),
      ])),

    el("div", { class: "grid grid--cards" }, [
      programCardCta("/admin/program-new.html"),
      ...programs.map((program) => programCard(program, { admin: true })),
    ]),

    !programs.length
      ? card(emptyState({
          iconName: "bookOpen",
          title: "No programmes yet",
          description: "Create the first one with the Add Course tile above.",
        }))
      : null,
  );
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}
