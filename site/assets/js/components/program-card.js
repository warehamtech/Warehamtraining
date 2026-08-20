import { el } from "../dom.js";
import { icon } from "../icons.js";
import { badge } from "../ui.js";
import { formatMoney } from "../money.js";

/**
 * Port of src/components/catalog/program-card.tsx.
 *
 * `{ admin: true }` renders the same card linked into the curriculum builder
 * instead of the public sales page, for the admin catalogue grid.
 */
/**
 * Where a card points on the public catalogue.
 *
 * A published programme has a file of its own, written by build/prerender.mjs
 * — a real URL with its own title and link preview, which is the whole point of
 * generating them. A draft has no such file: the generator runs as anon and row
 * level security does not show it one. WHA staff *can* see drafts in this grid,
 * so their cards keep the original query-string page, which renders any
 * programme the reader is allowed to read.
 */
function publicHref(program) {
  return program.published
    ? `/programs/${encodeURIComponent(program.slug)}.html`
    : `/programs/program.html?slug=${encodeURIComponent(program.slug)}`;
}

export function programCard(program, { admin = false } = {}) {
  return el("a", {
    href: admin ? `/admin/program.html?id=${program.id}` : publicHref(program),
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
      el("span", { class: "program-card__cta" },
        [admin ? "Edit" : "View", icon("arrowRight", 16)]),
    ]),
  ]);
}

/** The admin catalogue's "Add Course" tile — same box as a programme card. */
export function programCardCta(href) {
  return el("a", { href, class: "program-card program-card--cta" }, [
    el("span", { class: "program-card--cta__icon" }, icon("plus", 20)),
    el("span", { class: "program-card--cta__label" }, "Add Course"),
  ]);
}
