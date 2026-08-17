import { el } from "../dom.js";
import { icon } from "../icons.js";
import { badge } from "../ui.js";
import { formatMoney } from "../money.js";

/** Port of src/components/catalog/program-card.tsx. */
export function programCard(program) {
  return el("a", {
    href: `/programs/program.html?slug=${encodeURIComponent(program.slug)}`,
    class: "program-card",
  }, [
    program.standard ? badge(program.standard, "brand") : null,
    !program.published ? badge("Draft", "warn") : null,

    el("h3", { class: "program-card__title" }, program.title),
    el("p", { class: "program-card__summary" }, program.summary),

    el("dl", { class: "program-card__meta" }, [
      el("div", {}, [
        icon("bookOpen", 14),
        el("dt", { class: "sr-only" }, "Content"),
        el("dd", { class: "tabular" },
          `${program.courseCount} courses · ${program.lessonCount} lessons`),
      ]),
      program.durationHours
        ? el("div", {}, [
            icon("clock", 14),
            el("dt", { class: "sr-only" }, "Study time"),
            el("dd", { class: "tabular" }, `${program.durationHours} hours`),
          ])
        : null,
    ]),

    el("div", { class: "program-card__foot" }, [
      el("p", {}, [
        el("span", { class: "program-card__price tabular" }, formatMoney(program.priceCents)),
        el("span", {}, "per learner, excl. VAT"),
      ]),
      el("span", { class: "program-card__cta" }, ["View", icon("arrowRight", 16)]),
    ]),
  ]);
}
