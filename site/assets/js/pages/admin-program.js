import { el, mount, param, page, setTitle, formatMinutes } from "../dom.js";
import { icon, lessonIcon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";

/**
 * Programme editor: settings, publish toggle, and the course/lesson tree.
 * Port of src/app/(app)/admin/programs/[id]/page.tsx and program-forms.tsx.
 */

async function render(admin) {
  const programId = param("id");
  if (!programId) {
    location.replace("/admin/programs.html");
    return;
  }

  const program = await sb.from("programs")
    .select(`
      id, slug, title, summary, description, standard, price_cents,
      duration_hours, published,
      courses (
        id, title, summary, position,
        lessons ( id, title, position, type, duration_minutes ),
        quizzes ( id, title, pass_mark_percent, questions ( id ) )
      )
    `)
    .eq("id", programId)
    .maybeSingle()
    .then(unwrap);

  if (!program) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Programme not found",
      action: buttonLink("Back to programmes", "/admin/programs.html"),
    }));
    return;
  }

  setTitle(`${program.title} — admin`);

  const courses = [...(program.courses ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((course) => ({
      ...course,
      lessons: [...(course.lessons ?? [])].sort((a, b) => a.position - b.position),
      quiz: Array.isArray(course.quizzes) ? course.quizzes[0] ?? null : course.quizzes,
    }));

  const lessonCount = courses.reduce((total, c) => total + c.lessons.length, 0);
  const canPublish = courses.length > 0 && lessonCount > 0;

  /* --- Settings ----------------------------------------------------------- */

  const settings = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({ label: "Title", name: "title", required: true, value: program.title }),
    field({ label: "URL slug", name: "slug", required: true, value: program.slug }),
    field({ label: "Standard", name: "standard", value: program.standard ?? "" }),
    field({ label: "Summary", name: "summary", as: "textarea", rows: 2, required: true,
      value: program.summary }),
    field({ label: "Description", name: "description", as: "textarea", rows: 6,
      required: true, value: program.description }),
    el("div", { class: "grid grid--halves" }, [
      field({
        label: "Price per seat (Rand, excl. VAT)", name: "price", type: "number",
        min: 0, step: "0.01", required: true, value: (program.price_cents / 100).toFixed(2),
      }),
      field({ label: "Study time (hours)", name: "durationHours", type: "number",
        min: 0, value: program.duration_hours ?? "" }),
    ]),
    el("button", { class: "btn btn--primary", type: "submit" }, "Save changes"),
  ]);

  settings.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(settings, null);

    const price = Number(settings.elements.price.value);
    const errors = {};
    if (!Number.isFinite(price) || price < 0) errors.price = "Enter the price per seat";
    setFieldErrors(settings, errors);
    if (Object.keys(errors).length) return;

    setPending(settings, true);
    const { error } = await sb.from("programs").update({
      title: settings.elements.title.value.trim(),
      slug: settings.elements.slug.value.trim(),
      standard: settings.elements.standard.value.trim() || null,
      summary: settings.elements.summary.value.trim(),
      description: settings.elements.description.value.trim(),
      price_cents: Math.round(price * 100),
      duration_hours: settings.elements.durationHours.value
        ? Number(settings.elements.durationHours.value) : null,
    }).eq("id", program.id);
    setPending(settings, false);

    if (error) {
      setFormMessage(settings,
        error.code === "23505" ? "That slug is already taken." : error.message);
      return;
    }
    setFormMessage(settings, "Saved.", "success");
    setTimeout(() => render(admin), 800);
  });

  /* --- Add course --------------------------------------------------------- */

  const courseForm = el("form", { class: "row row--wrap", novalidate: true }, [
    el("input", { class: "control grow", name: "title", required: true,
      placeholder: "New course title" }),
    el("button", { class: "btn btn--secondary", type: "submit" },
      [icon("plus", 16), "Add course"]),
  ]);

  courseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = courseForm.elements.title.value.trim();
    if (!title) return;
    await sb.from("courses").insert({
      program_id: program.id,
      title,
      position: courses.length + 1,
    });
    render(admin);
  });

  /* --- Course tree -------------------------------------------------------- */

  const move = async (kind, row, direction, siblings) => {
    const index = siblings.findIndex((s) => s.id === row.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;
    // Swap positions rather than renumbering the whole list.
    await Promise.all([
      sb.from(kind).update({ position: swapWith.position }).eq("id", row.id),
      sb.from(kind).update({ position: row.position }).eq("id", swapWith.id),
    ]);
    render(admin);
  };

  const courseCard = (course, index) => {
    const addLesson = el("form", { class: "row row--wrap mt-3", novalidate: true }, [
      el("input", { class: "control grow", name: "title", required: true,
        placeholder: "New lesson title" }),
      el("select", { class: "control", name: "type", style: { width: "auto" } }, [
        el("option", { value: "TEXT" }, "Written"),
        el("option", { value: "VIDEO" }, "Video"),
        el("option", { value: "PDF" }, "PDF"),
      ]),
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Add"),
    ]);

    addLesson.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = addLesson.elements.title.value.trim();
      if (!title) return;
      const { data } = await sb.from("lessons").insert({
        course_id: course.id,
        title,
        type: addLesson.elements.type.value,
        position: course.lessons.length + 1,
      }).select("id").maybeSingle();
      if (data) location.href = `/admin/lesson.html?id=${program.id}&lessonId=${data.id}`;
    });

    return el("li", {},
      card([
        el("div", { class: "card__header" }, [
          el("div", { class: "row" }, [
            el("span", { class: "course-number" }, String(index + 1).padStart(2, "0")),
            el("div", {}, [
              el("h2", {}, course.title),
              el("p", {},
                `${course.lessons.length} lessons` +
                (course.quiz
                  ? ` · assessment with ${(course.quiz.questions ?? []).length} questions`
                  : " · no assessment yet")),
            ]),
          ]),
          el("div", { class: "row" }, [
            button(icon("chevronDown", 14), {
              variant: "ghost", size: "sm", "aria-label": "Move course down",
              disabled: index === courses.length - 1,
              onClick: () => move("courses", course, 1, courses),
            }),
            buttonLink("Assessment",
              `/admin/quiz.html?id=${program.id}&courseId=${course.id}`,
              { variant: "secondary", size: "sm" }),
            button(icon("trash", 14), {
              variant: "ghost", size: "sm", "aria-label": "Delete course",
              onClick: async () => {
                if (!confirm(
                  `Delete "${course.title}" and all ${course.lessons.length} of its lessons? This cannot be undone.`
                )) return;
                await sb.from("courses").delete().eq("id", course.id);
                render(admin);
              },
            }),
          ]),
        ]),
        cardBody([
          course.lessons.length
            ? el("ul", { class: "admin-lessons" }, course.lessons.map((lesson, i) =>
                el("li", { class: "row" }, [
                  icon(lessonIcon[lesson.type], 16, { class: "i-subtle" }),
                  el("a", {
                    class: "link grow truncate",
                    href: `/admin/lesson.html?id=${program.id}&lessonId=${lesson.id}`,
                  }, lesson.title),
                  lesson.duration_minutes > 0
                    ? el("span", { class: "subtle t-xs tabular" },
                        formatMinutes(lesson.duration_minutes))
                    : null,
                  button(icon("chevronDown", 14), {
                    variant: "ghost", size: "sm", "aria-label": "Move lesson down",
                    disabled: i === course.lessons.length - 1,
                    onClick: () => move("lessons", lesson, 1, course.lessons),
                  }),
                ])))
            : el("p", { class: "subtle t-sm" }, "No lessons yet."),
          addLesson,
        ]),
      ]));
  };

  /* --- Page --------------------------------------------------------------- */

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "link t-sm row", href: "/admin/programs.html" },
          [icon("arrowLeft", 14), "All programmes"]),
        el("h1", { class: "display mt-1" }, program.title),
        el("p", {}, `${formatMoney(program.price_cents)} per seat · /${program.slug}`),
      ]),
      el("div", { class: "row" }, [
        program.published ? badge("Published", "success") : badge("Draft", "warn"),
        buttonLink([icon("externalLink", 14), "View"],
          `/programs/program.html?slug=${program.slug}`,
          { variant: "secondary", size: "sm", target: "_blank" }),
        button(program.published ? "Unpublish" : "Publish", {
          variant: program.published ? "secondary" : "primary",
          disabled: !program.published && !canPublish,
          title: !canPublish && !program.published
            ? "Add at least one course with a lesson before publishing"
            : null,
          onClick: async () => {
            await sb.from("programs")
              .update({ published: !program.published }).eq("id", program.id);
            render(admin);
          },
        }),
      ]),
    ]),

    !canPublish && !program.published
      ? el("div", { class: "notice notice--info" }, [
          icon("info", 20, { class: "i-brand" }),
          el("p", { class: "t-sm muted" },
            "Add at least one course with a lesson before this programme can be published."),
        ])
      : null,

    el("div", { class: "grid grid--detail mt-6" }, [
      el("section", {}, [
        el("div", { class: "row row--between row--wrap" }, [
          el("h2", { class: "section-label" }, "Curriculum"),
        ]),
        courses.length
          ? el("ol", { class: "stack mt-3" }, courses.map(courseCard))
          : card(emptyState({
              iconName: "bookOpen",
              title: "No courses yet",
              description: "A programme is made of courses, each with lessons and one assessment.",
            }), { className: "mt-3" }),
        card(cardBody(courseForm), { className: "mt-4" }),
      ]),

      el("aside", { class: "sticky-panel" },
        card([cardHeader("Programme settings"), cardBody(settings)])),
    ]));
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
