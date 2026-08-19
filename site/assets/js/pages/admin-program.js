import { el, mount, param, setTitle, formatMinutes, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { uploadLessonMedia } from "../storage-upload.js";
import { makeSortable } from "../drag-reorder.js";

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
        lessons ( id, title, position, duration_minutes, lesson_blocks ( id ) ),
        quizzes ( id, title, pass_mark_percent, questions ( id ) )
      ),
      program_downloads (
        id, course_id, title, file_key, original_name, content_type,
        size_bytes, required, position
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

  const allDownloads = [...(program.program_downloads ?? [])].sort((a, b) => a.position - b.position);
  const programDownloads = allDownloads.filter((d) => d.course_id === null);
  const courseDownloads = (courseId) => allDownloads.filter((d) => d.course_id === courseId);

  // Filled in once the page head below is built. A settings save patches
  // these directly instead of re-fetching and rebuilding the whole page.
  let pageTitleEl = null, pageMetaEl = null, viewLinkEl = null;

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

    const nextValues = {
      title: settings.elements.title.value.trim(),
      slug: settings.elements.slug.value.trim(),
      standard: settings.elements.standard.value.trim() || null,
      summary: settings.elements.summary.value.trim(),
      description: settings.elements.description.value.trim(),
      price_cents: Math.round(price * 100),
      duration_hours: settings.elements.durationHours.value
        ? Number(settings.elements.durationHours.value) : null,
    };

    setPending(settings, true);
    const { error } = await sb.from("programs").update(nextValues).eq("id", program.id);
    setPending(settings, false);

    if (error) {
      setFormMessage(settings,
        error.code === "23505" ? "That slug is already taken." : error.message);
      return;
    }

    // Nothing else on the page derives from these fields except the header —
    // patch it directly rather than re-fetching and rebuilding everything.
    Object.assign(program, nextValues);
    if (pageTitleEl) pageTitleEl.textContent = program.title;
    if (pageMetaEl) pageMetaEl.textContent = `${formatMoney(program.price_cents)} per seat · /${program.slug}`;
    if (viewLinkEl) viewLinkEl.href = `/programs/program.html?slug=${program.slug}`;
    setFormMessage(settings, "Saved.", "success");
  });

  /* --- Downloads -----------------------------------------------------------
   *
   * course_id === null → delivered before the whole programme; set → before
   * that specific course. Both scopes share the same row shape and controls.
   */

  const downloadRow = (download) =>
    el("li", { class: "row" }, [
      icon("download", 16, { class: "i-subtle" }),
      el("div", { class: "grow" }, [
        el("p", { class: "medium t-sm truncate" }, [
          download.title,
          !download.required ? el("span", { class: "subtle t-xs" }, "  ·  optional") : null,
        ]),
        el("p", { class: "subtle t-xs tabular" },
          `${download.original_name} · ${formatBytes(download.size_bytes)}`),
      ]),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove download",
        onClick: async () => {
          await sb.storage.from("lesson-media").remove([download.file_key]);
          await sb.from("program_downloads").delete().eq("id", download.id);
          render(admin);
        },
      }),
    ]);

  const downloadForm = (courseId, existing) => {
    const form = el("form", { class: "stack stack--sm", novalidate: true }, [
      el("div", { "data-message": "" }),
      el("div", { class: "row row--wrap" }, [
        el("input", { class: "control grow", name: "title", required: true,
          placeholder: courseId ? "Pre-course reading" : "Programme handbook" }),
        el("input", { class: "control", type: "file", name: "file", required: true }),
      ]),
      el("label", { class: "row t-sm" }, [
        el("input", { type: "checkbox", name: "required", checked: true }),
        "Required before continuing",
      ]),
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" },
        [icon("plus", 16), "Add download"]),
    ]);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = form.elements.file.files?.[0];
      const title = form.elements.title.value.trim();
      if (!file || !title) return setFormMessage(form, "Give it a title and choose a file.");

      setPending(form, true);
      const key = await uploadLessonMedia(file, program.id, "downloads");
      if (!key) {
        setPending(form, false);
        return setFormMessage(form, "That upload was refused.");
      }
      await sb.from("program_downloads").insert({
        program_id: program.id,
        course_id: courseId,
        title,
        file_key: key,
        original_name: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        required: form.elements.required.checked,
        position: existing.length + 1,
      });
      setPending(form, false);
      render(admin);
    });

    return form;
  };

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

  /** Drag-and-drop drop handler: the list is already in its new DOM order — persist it. */
  const reorderSiblings = async (kind, orderedIds) => {
    await Promise.all(orderedIds.map((id, i) =>
      sb.from(kind).update({ position: i + 1 }).eq("id", id)));
    render(admin);
  };

  /** Keyboard-operable pair alongside the drag handle — dragging isn't the only way in. */
  const moveButtons = (kind, row, siblings, index, label) =>
    el("span", { class: "row row--tight" }, [
      button(icon("chevronDown", 12, { class: "icon-flip" }), {
        variant: "ghost", size: "sm", "aria-label": `Move ${label} up`,
        disabled: index === 0,
        onClick: () => move(kind, row, -1, siblings),
      }),
      button(icon("chevronDown", 12), {
        variant: "ghost", size: "sm", "aria-label": `Move ${label} down`,
        disabled: index === siblings.length - 1,
        onClick: () => move(kind, row, 1, siblings),
      }),
    ]);

  const courseCard = (course, index) => {
    const addLesson = el("form", { class: "row row--wrap mt-3", novalidate: true }, [
      el("input", { class: "control grow", name: "title", required: true,
        placeholder: "New lesson title" }),
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Add"),
    ]);

    addLesson.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = addLesson.elements.title.value.trim();
      if (!title) return;
      // Created bare — the admin adds its first content block on the next
      // screen, in the lesson's own editor.
      const { data } = await sb.from("lessons").insert({
        course_id: course.id,
        title,
        position: course.lessons.length + 1,
      }).select("id").maybeSingle();
      if (data) location.href = `/admin/lesson.html?id=${program.id}&lessonId=${data.id}`;
    });

    const lessonList = course.lessons.length
      ? el("ul", { class: "admin-lessons" }, course.lessons.map((lesson, i) =>
          el("li", { class: "row", "data-sort-id": lesson.id }, [
            icon("gripVertical", 14, { class: "grip i-subtle" }),
            icon("layers", 16, { class: "i-subtle" }),
            el("a", {
              class: "link grow truncate",
              href: `/admin/lesson.html?id=${program.id}&lessonId=${lesson.id}`,
            }, lesson.title),
            el("span", { class: "subtle t-xs tabular" }, [
              String((lesson.lesson_blocks ?? []).length),
              (lesson.lesson_blocks ?? []).length === 1 ? " block" : " blocks",
            ]),
            lesson.duration_minutes > 0
              ? el("span", { class: "subtle t-xs tabular" },
                  formatMinutes(lesson.duration_minutes))
              : null,
            moveButtons("lessons", lesson, course.lessons, i, "lesson"),
          ])))
      : el("p", { class: "subtle t-sm" }, "No lessons yet.");

    if (course.lessons.length > 1) {
      makeSortable(lessonList, "li[data-sort-id]", ".grip",
        (orderedIds) => reorderSiblings("lessons", orderedIds));
    }

    return el("li", { "data-sort-id": course.id },
      card([
        el("div", { class: "card__header" }, [
          el("div", { class: "row" }, [
            icon("gripVertical", 16, { class: "grip i-subtle" }),
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
            moveButtons("courses", course, courses, index, "course"),
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
          lessonList,
          addLesson,
          el("div", { class: "stack--sm mt-4" }, [
            el("p", { class: "section-label t-xs" }, "Course downloads"),
            courseDownloads(course.id).length
              ? el("ul", { class: "divided" }, courseDownloads(course.id).map(downloadRow))
              : el("p", { class: "subtle t-xs" }, "None yet."),
            downloadForm(course.id, courseDownloads(course.id)),
          ]),
        ]),
      ]));
  };

  /* --- Publish-readiness checklist ----------------------------------------- */

  const checklistRow = (done, label) =>
    el("li", { class: "checklist-item" }, [
      done ? icon("checkCircle", 18, { class: "i-success" }) : el("span", { class: "checklist-dot" }),
      el("span", { class: done ? "t-sm" : "t-sm muted" }, label),
    ]);

  const checklist = !program.published
    ? card([
        cardHeader("Before you publish"),
        cardBody(el("ul", { class: "checklist" }, [
          checklistRow(courses.length > 0, "At least one course"),
          checklistRow(courses.length > 0 && lessonCount > 0, "Every course has a lesson"),
          checklistRow(courses.length > 0 && courses.every((c) => c.quiz),
            "Every course has an assessment"),
          checklistRow(allDownloads.length > 0, "A download is attached (optional)"),
        ])),
      ], { className: "mt-6" })
    : null;

  /* --- Starter template ----------------------------------------------------
   *
   * Opt-in: a concrete, fully editable/deletable starting point instead of a
   * blank curriculum tree. Manually adding a course is untouched.
   */

  const startTemplate = async () => {
    const { data: courseRow } = await sb.from("courses").insert({
      program_id: program.id, title: "Course 1", position: 1,
    }).select("id").maybeSingle();
    if (!courseRow) return;

    const [{ data: lessonRow }] = await Promise.all([
      sb.from("lessons").insert({ course_id: courseRow.id, title: "Lesson 1", position: 1 })
        .select("id").maybeSingle(),
      sb.from("quizzes").insert({ course_id: courseRow.id }),
    ]);
    if (lessonRow) {
      await sb.from("lesson_blocks").insert({
        lesson_id: lessonRow.id, block_type: "TEXT", position: 1, content: {},
      });
    }
    render(admin);
  };

  /* --- Page --------------------------------------------------------------- */

  pageTitleEl = el("h1", { class: "display mt-1" }, program.title);
  pageMetaEl = el("p", {}, `${formatMoney(program.price_cents)} per seat · /${program.slug}`);
  viewLinkEl = buttonLink([icon("externalLink", 14), "View"],
    `/programs/program.html?slug=${program.slug}`,
    { variant: "secondary", size: "sm", target: "_blank" });

  let courseList = null;
  const curriculum = courses.length
    ? (courseList = el("ol", { class: "stack mt-3" }, courses.map(courseCard)))
    : card(emptyState({
        iconName: "bookOpen",
        title: "No courses yet",
        description: "A programme is made of courses, each with lessons and one assessment.",
        action: button("Start with a template", { variant: "secondary", onClick: startTemplate }),
      }), { className: "mt-3" });

  if (courseList && courses.length > 1) {
    makeSortable(courseList, "li[data-sort-id]", ".grip",
      (orderedIds) => reorderSiblings("courses", orderedIds));
  }

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "link t-sm row", href: "/admin/programs.html" },
          [icon("arrowLeft", 14), "All programmes"]),
        pageTitleEl,
        pageMetaEl,
      ]),
      el("div", { class: "row" }, [
        program.published ? badge("Published", "success") : badge("Draft", "warn"),
        viewLinkEl,
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

    checklist,

    el("div", { class: "grid grid--detail mt-6" }, [
      el("section", {}, [
        el("div", { class: "row row--between row--wrap" }, [
          el("h2", { class: "section-label" }, "Curriculum"),
        ]),
        curriculum,
        card(cardBody(courseForm), { className: "mt-4" }),
      ]),

      el("aside", { class: "sticky-panel stack--lg" }, [
        card([cardHeader("Programme settings"), cardBody(settings)]),
        card([
          cardHeader("Programme downloads", {
            description: "Delivered before the whole programme.",
          }),
          programDownloads.length
            ? el("ul", { class: "divided" }, programDownloads.map(downloadRow))
            : null,
          cardBody(downloadForm(null, programDownloads)),
        ]),
      ]),
    ]));
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}
