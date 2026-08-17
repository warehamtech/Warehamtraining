import { el, mount, page } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFieldErrors, setFormMessage, setPending, table,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { listPrograms } from "../catalog.js";
import { formatMoney } from "../money.js";

/** Port of src/app/(app)/admin/programs/page.tsx + the create half of program-forms.tsx. */

const slugify = (value) =>
  value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

async function render(admin) {
  const programs = await listPrograms();

  const titleField = field({
    label: "Title", name: "title", required: true,
    placeholder: "ISO 9001:2015 Foundation Programme",
  });
  const slugField = field({
    label: "URL slug", name: "slug", required: true,
    hint: "Appears in the address. Lower case, words separated by hyphens.",
  });

  // Suggest a slug from the title until the slug is edited by hand.
  let slugTouched = false;
  slugField.querySelector("input").addEventListener("input", () => { slugTouched = true; });
  titleField.querySelector("input").addEventListener("input", (event) => {
    if (!slugTouched) slugField.querySelector("input").value = slugify(event.target.value);
  });

  const form = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    titleField,
    slugField,
    field({
      label: "Standard", name: "standard",
      hint: "Optional eyebrow label on the card, e.g. \"ISO 9001\".",
    }),
    field({
      label: "Summary", name: "summary", as: "textarea", rows: 2, required: true,
      hint: "One line, shown on catalogue cards.",
    }),
    field({
      label: "Description", name: "description", as: "textarea", rows: 5, required: true,
      hint: "Longer copy for the detail page. Leave a blank line between paragraphs.",
    }),
    el("div", { class: "grid grid--halves" }, [
      field({
        label: "Price per seat (Rand, excl. VAT)", name: "price", type: "number",
        min: 0, step: "0.01", required: true, placeholder: "4500.00",
      }),
      field({
        label: "Study time (hours)", name: "durationHours", type: "number", min: 0,
        hint: "Optional.",
      }),
    ]),
    el("button", { class: "btn btn--primary", type: "submit" },
      [icon("plus", 16), "Create programme"]),
    el("p", { class: "subtle t-xs" },
      "New programmes start unpublished, so nothing appears in the public catalogue " +
      "until you have added its courses and lessons."),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const values = {
      title: form.elements.title.value.trim(),
      slug: slugify(form.elements.slug.value),
      standard: form.elements.standard.value.trim(),
      summary: form.elements.summary.value.trim(),
      description: form.elements.description.value.trim(),
      price: Number(form.elements.price.value),
      durationHours: form.elements.durationHours.value,
    };

    const errors = {};
    if (values.title.length < 3) errors.title = "Enter a title";
    if (!values.slug) errors.slug = "Enter a URL slug";
    if (!values.summary) errors.summary = "Enter a one-line summary";
    if (!values.description) errors.description = "Enter a description";
    if (!Number.isFinite(values.price) || values.price < 0) {
      errors.price = "Enter the price per seat";
    }
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);

    const { data, error } = await sb.from("programs").insert({
      title: values.title,
      slug: values.slug,
      standard: values.standard || null,
      summary: values.summary,
      description: values.description,
      // Money is integer cents throughout; never floats.
      price_cents: Math.round(values.price * 100),
      duration_hours: values.durationHours ? Number(values.durationHours) : null,
      published: false,
    }).select("id").maybeSingle();

    setPending(form, false);

    if (error) {
      setFormMessage(form,
        error.code === "23505"
          ? "A programme already uses that slug. Choose another."
          : error.message);
      return;
    }

    location.href = `/admin/program.html?id=${data.id}`;
  });

  mount("#app",
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "Programmes"),
        el("p", {}, "The catalogue, including drafts that are not publicly visible."),
      ])),

    el("div", { class: "grid grid--detail" }, [
      programs.length
        ? card([
            cardHeader("All programmes", {
              description: `${programs.length} total · ` +
                `${programs.filter((p) => p.published).length} published`,
            }),
            table(
              ["Programme", "Content", "Price", "Status"],
              programs.map((program) =>
                el("tr", {}, [
                  el("td", {}, [
                    el("a", {
                      class: "link medium",
                      href: `/admin/program.html?id=${program.id}`,
                    }, program.title),
                    el("p", { class: "subtle t-xs" }, `/${program.slug}`),
                  ]),
                  el("td", { class: "tabular subtle t-xs" },
                    `${program.courseCount} courses · ${program.lessonCount} lessons`),
                  el("td", { class: "tabular" }, formatMoney(program.priceCents)),
                  el("td", {}, program.published
                    ? badge("Published", "success")
                    : badge("Draft", "warn")),
                ]))),
          ])
        : card(emptyState({
            iconName: "bookOpen",
            title: "No programmes yet",
            description: "Create the first one with the form beside this.",
          })),

      el("aside", {}, card([
        cardHeader("New programme"),
        cardBody(form),
      ])),
    ]));
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
