import { el, mount, param, setTitle, formatMinutes } from "../dom.js";
import { icon, lessonIcon } from "../icons.js";
import { publicChrome } from "../shell.js";
import { badge, buttonLink, card, cardBody, emptyState } from "../ui.js";
import { getProgramBySlug } from "../catalog.js";
import { formatMoney, calculateTotals } from "../money.js";
import { billing } from "../config.js";

/** Port of src/app/(public)/programs/[slug]/page.tsx. */

const benefits = [
  ["users", "Buy multiple seats for your team on one invoice"],
  ["monitorPlay", "Video, written and downloadable material"],
  ["award", "Verifiable certificate on completion"],
];

function purchasePanel(program) {
  const totals = calculateTotals(program.priceCents, 1);

  return el("aside", { class: "sticky-panel" },
    card(cardBody([
      el("p", { class: "price" }, formatMoney(program.priceCents)),
      el("p", { class: "subtle t-sm mt-1" }, "per learner, excluding VAT"),
      el("p", { class: "subtle t-xs tabular mt-1" },
        `${formatMoney(totals.totalCents)} incl. ${billing.vatRate * 100}% VAT`),

      buttonLink("Enrol now", `/checkout.html?slug=${encodeURIComponent(program.slug)}`, {
        variant: "accent",
        size: "lg",
        className: "btn--block mt-4",
      }),

      el("p", { class: "subtle t-xs center mt-3" },
        "Invoice issued immediately · pay by EFT"),

      el("ul", { class: "feature-list feature-list--divided" },
        benefits.map(([name, text]) =>
          el("li", {}, [icon(name, 16, { class: "i-brand" }), text]))),
    ])));
}

function courseCard(course, index) {
  return el("li", {},
    card(cardBody([
      el("div", { class: "row", style: { alignItems: "baseline" } }, [
        el("span", { class: "course-number" }, String(index + 1).padStart(2, "0")),
        el("div", {}, [
          el("h3", { class: "medium" }, course.title),
          course.summary ? el("p", { class: "muted t-sm mt-1" }, course.summary) : null,
        ]),
      ]),

      el("ul", { class: "curriculum-preview" }, [
        ...course.lessons.map((lesson) =>
          el("li", {}, [
            icon(lessonIcon[lesson.type], 16, { class: "i-subtle" }),
            el("span", { class: "grow truncate" }, lesson.title),
            lesson.duration_minutes > 0
              ? el("span", { class: "tabular subtle t-xs nowrap" },
                  formatMinutes(lesson.duration_minutes))
              : null,
          ])),

        course.quiz
          ? el("li", { class: "is-quiz" }, [
              icon("graduationCap", 16, { class: "i-accent" }),
              el("span", { class: "grow truncate medium" }, course.quiz.title),
              el("span", { class: "tabular subtle t-xs nowrap" },
                `${course.quiz.pass_mark_percent}% to pass`),
            ])
          : null,
      ]),
    ])));
}

export async function init() {
  publicChrome();

  const slug = param("slug");
  if (!slug) {
    mount("#app", emptyState({
      iconName: "search",
      title: "No programme specified",
      action: buttonLink("Browse the catalogue", "/programs/index.html"),
    }));
    return;
  }

  const program = await getProgramBySlug(slug);
  if (!program) {
    // RLS returns nothing for an unpublished programme, so "not found" and
    // "not published" look the same from here — which is the intent.
    mount("#app", emptyState({
      iconName: "search",
      title: "That programme isn't available",
      description: "It may have been withdrawn, or the link may be out of date.",
      action: buttonLink("Browse the catalogue", "/programs/index.html"),
    }));
    return;
  }

  setTitle(program.title);
  document.querySelector('meta[name="description"]')?.setAttribute("content", program.summary);

  const assessmentCount = program.courses.filter((c) => c.quiz).length;

  mount("#app",
    el("section", { class: "section--band" },
      el("div", { class: "shell grid grid--detail section" }, [
        el("div", {}, [
          program.standard ? badge(program.standard, "brand") : null,
          !program.published ? badge("Draft — visible to WHA staff only", "warn") : null,

          el("h1", { class: "display t-3xl mt-3" }, program.title),
          el("p", { class: "muted t-lg measure mt-3" }, program.summary),

          el("dl", { class: "row row--wrap muted t-sm mt-6", style: { gap: "0.75rem 1.5rem" } }, [
            el("div", { class: "row" }, [
              icon("bookOpen", 16, { class: "i-brand" }),
              el("dt", { class: "sr-only" }, "Courses"),
              el("dd", { class: "tabular" },
                `${program.courseCount} courses · ${program.lessonCount} lessons`),
            ]),
            el("div", { class: "row" }, [
              icon("graduationCap", 16, { class: "i-brand" }),
              el("dt", { class: "sr-only" }, "Assessments"),
              el("dd", { class: "tabular" }, `${assessmentCount} assessments`),
            ]),
            program.durationHours
              ? el("div", { class: "row" }, [
                  icon("clock", 16, { class: "i-brand" }),
                  el("dt", { class: "sr-only" }, "Study time"),
                  el("dd", { class: "tabular" }, `approx. ${program.durationHours} hours`),
                ])
              : null,
          ]),

          // Blank-line-separated paragraphs, as the text column stores them.
          el("div", { class: "muted stack measure mt-8" },
            program.description.split(/\n\s*\n/).map((p) => el("p", {}, p))),
        ]),

        purchasePanel(program),
      ])),

    el("section", { class: "shell section" }, [
      el("h2", { class: "display t-2xl" }, "What you will cover"),
      el("p", { class: "subtle t-sm mt-1" },
        `${program.courseCount} courses, each ending in an assessment you must pass to complete the programme.`),
      el("ol", { class: "stack mt-6", style: { maxWidth: "48rem" } },
        program.courses.map(courseCard)),
    ]));
}
