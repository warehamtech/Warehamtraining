import { el, mount, page, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  card, cardBody, cardHeader, field,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb } from "../supabase.js";

/**
 * The quick-create step of the course-building flow: just enough to get a
 * draft `programs` row, then straight into the curriculum builder
 * (admin/program.html) to fill in the rest — settings, courses, lessons.
 */

const slugify = (value) =>
  value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

async function render(admin) {
  setTitle("Add course");

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
    el("button", { class: "btn btn--primary", type: "submit" },
      [icon("plus", 16), "Create and start building"]),
    el("p", { class: "subtle t-xs" },
      "You'll set the price, summary and curriculum next. New courses start " +
      "unpublished, so nothing appears in the public catalogue until you publish."),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const values = {
      title: form.elements.title.value.trim(),
      slug: slugify(form.elements.slug.value),
      standard: form.elements.standard.value.trim(),
    };

    const errors = {};
    if (values.title.length < 3) errors.title = "Enter a title";
    if (!values.slug) errors.slug = "Enter a URL slug";
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);

    const { data, error } = await sb.from("programs").insert({
      title: values.title,
      slug: values.slug,
      standard: values.standard || null,
      // Placeholders — filled in on the next screen's Programme settings form.
      summary: "",
      description: "",
      price_cents: 0,
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
        el("h1", { class: "display" }, "Add course"),
        el("p", {}, "Start with the basics — you'll build the curriculum next."),
      ])),

    card([
      cardHeader("Course details"),
      cardBody(form),
    ]),
  );
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
