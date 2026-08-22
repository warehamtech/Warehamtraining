import { el, mount, setTitle } from "../dom.js";
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

    const titleVal = form.elements.title.value.trim();
    const slugVal = slugify(form.elements.slug.value || titleVal);
    const standardVal = form.elements.standard?.value?.trim() || "";

    const errors = {};
    if (titleVal.length < 3) errors.title = "Enter a title (at least 3 characters)";
    if (!slugVal) errors.slug = "Enter a URL slug";
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);

    try {
      const { data: prog, error } = await sb.from("programs").insert({
        title: titleVal,
        slug: slugVal,
        standard: standardVal || null,
        summary: `Comprehensive training programme for ${titleVal}.`,
        description: `In this programme, learners master the principles, requirements, and best practices of ${titleVal}.`,
        price_cents: 0,
        published: false,
      }).select("id").maybeSingle();

      if (error || !prog) {
        setPending(form, false);
        setFormMessage(form,
          error?.code === "23505"
            ? "A programme already uses that slug. Please enter a different title or slug."
            : (error?.message || "Could not create programme. Please check your admin session."));
        return;
      }

      // Auto-create starter module and lesson so the studio is ready to build immediately
      try {
        const { data: course, error: courseErr } = await sb.from("courses").insert({
          program_id: prog.id,
          title: "Module 1: Introduction & Principles",
          position: 1,
        }).select("id").maybeSingle();
        if (courseErr) throw courseErr;

        if (course) {
          const { data: lesson, error: lessonErr } = await sb.from("lessons").insert({
            course_id: course.id,
            title: "Lesson 1: Overview & Scope",
            position: 1,
            duration_minutes: 15,
          }).select("id").maybeSingle();
          if (lessonErr) throw lessonErr;

          if (lesson) {
            const { error: blockErr } = await sb.from("lesson_blocks").insert({
              lesson_id: lesson.id,
              block_type: "SLIDES",
              position: 1,
              content: {
                slides: [
                  {
                    id: "s1",
                    title: `${titleVal} — Overview`,
                    subtitle: "Introduction & Scope",
                    bullets: [
                      "Key objectives and training outcomes",
                      "Core standards, requirements, and principles",
                      "Practical application and workplace compliance",
                    ],
                    notes: "Welcome learners and introduce the key learning outcomes.",
                  },
                ],
              },
            });
            if (blockErr) throw blockErr;
          }
        }
      } catch (innerErr) {
        // Genuinely non-blocking: the programme itself was already created
        // above, and a failed starter-content step just means the admin
        // lands on an emptier curriculum than intended, not a broken one —
        // so this still redirects rather than showing a form error. But
        // `sb.from(...).insert()` doesn't throw on a database-reported
        // error (only on a network-level failure), which is exactly why the
        // three inserts above check `error` explicitly and throw it here:
        // a plain try/catch around unchecked inserts would never actually
        // catch a real Postgres error, only network exceptions — logging it
        // is the difference between a real problem staying visible and it
        // vanishing the way it used to.
        console.error("Starter content for the new programme failed:", innerErr);
      }

      setPending(form, false);
      location.href = `/admin/program.html?id=${prog.id}`;
    } catch (err) {
      console.error("Program creation error:", err);
      setPending(form, false);
      setFormMessage(form, err?.message || "An unexpected error occurred. Please try again.");
    }
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

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}
