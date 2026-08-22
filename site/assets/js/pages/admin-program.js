import { el, mount, param, setTitle, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, emptyState, field,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";
import { formatMoney } from "../money.js";

import { uploadLessonMedia } from "../storage-upload.js";
import { makeSortable } from "../drag-reorder.js";
import { openLearnerPreview } from "../components/learner-preview.js";

/**
 * Course Builder Studio: unified curriculum studio with sticky Side Tracker,
 * multi-media lesson manager, live publish health checklist, and instant
 * "Review as Learner" preview mode.
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
        lessons ( id, title, position, duration_minutes, lesson_blocks ( id, block_type, content ) ),
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

  setTitle(`${program.title} — Course Studio`);

  const courses = [...(program.courses ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((course) => ({
      ...course,
      lessons: [...(course.lessons ?? [])].sort((a, b) => a.position - b.position),
      quiz: Array.isArray(course.quizzes) ? course.quizzes[0] ?? null : course.quizzes,
    }));

  const lessonCount = courses.reduce((total, c) => total + c.lessons.length, 0);
  const quizCount = courses.filter((c) => c.quiz).length;
  const totalMinutes = courses.reduce(
    (total, c) => total + c.lessons.reduce((sum, l) => sum + (l.duration_minutes ?? 0), 0),
    0,
  );
  const canPublish = courses.length > 0 && lessonCount > 0;

  const allDownloads = [...(program.program_downloads ?? [])].sort((a, b) => a.position - b.position);
  const programDownloads = allDownloads.filter((d) => d.course_id === null);
  const courseDownloads = (courseId) => allDownloads.filter((d) => d.course_id === courseId);

  let activeTab = "curriculum"; // "curriculum" | "settings" | "downloads"

  // ---------------------------------------------------------------------------
  // Top Studio Header Bar
  // ---------------------------------------------------------------------------

  const publishBtn = el("button", {
    type: "button",
    class: program.published ? "btn btn--secondary btn--sm" : "btn btn--primary btn--sm",
  }, [
    icon(program.published ? "lock" : "sparkles", 14),
    program.published ? "Unpublish" : "Publish programme",
  ]);

  publishBtn.addEventListener("click", async () => {
    if (!program.published && !canPublish) {
      alert("Add at least one course with a lesson before publishing.");
      return;
    }
    const target = !program.published;
    publishBtn.disabled = true;
    const { error } = await sb.from("programs").update({ published: target }).eq("id", program.id);
    publishBtn.disabled = false;
    if (!error) {
      program.published = target;
      render(admin);
    }
  });

  const previewBtn = el("button", {
    class: "btn btn--accent btn--sm",
    type: "button",
  }, [icon("eye", 16), "Review as Learner"]);

  previewBtn.addEventListener("click", () => {
    const firstCourse = courses[0];
    const firstLesson = firstCourse?.lessons[0];
    if (!firstLesson) {
      alert("Add a course and lesson first to preview the learner experience.");
      return;
    }
    openLearnerPreview({
      title: `${program.title} · ${firstLesson.title}`,
      type: "lesson",
      data: {
        title: firstLesson.title,
        courseTitle: firstCourse.title,
        durationMinutes: firstLesson.duration_minutes,
        blocks: firstLesson.lesson_blocks ?? [],
      },
    });
  });

  const headerBanner = el("div", { class: "studio-banner mb-6" }, [
    el("div", { class: "stack stack--sm" }, [
      el("div", { class: "row row--wrap" }, [
        el("a", { class: "link t-sm subtle", href: "/admin/programs.html" }, "← Programmes"),
        el("span", { class: "subtle t-xs" }, "/"),
        el("span", { class: "badge badge--brand" }, program.standard || "Custom Standard"),
        program.published
          ? el("span", { class: "badge badge--success" }, "Published Live")
          : el("span", { class: "badge badge--warn" }, "Draft in Progress"),
      ]),
      el("h1", { class: "display", style: { fontSize: "1.75rem" } }, program.title),
      el("p", { class: "subtle t-sm" }, [
        `${courses.length} courses · ${lessonCount} lessons · ${quizCount} assessments · ${formatMoney(program.price_cents)} per seat`,
      ]),
    ]),
    el("div", { class: "row row--wrap" }, [
      previewBtn,
      publishBtn,
    ]),
  ]);

  // Tab switch buttons
  const tabBtn = (id, label, iconName, count = null) => {
    const isActive = activeTab === id;
    return el("button", {
      type: "button",
      class: isActive ? "nav-link is-active" : "nav-link",
      style: {
        borderRadius: "var(--radius-lg)",
        padding: "0.5rem 0.875rem",
        backgroundColor: isActive ? "var(--brand-50)" : "transparent",
        color: isActive ? "var(--brand-700)" : "var(--ink-muted)",
        fontWeight: isActive ? "600" : "500",
        border: isActive ? "1px solid var(--brand-200)" : "1px solid transparent",
      },
      onClick: () => {
        activeTab = id;
        renderCanvas();
      },
    }, [
      icon(iconName, 16),
      label,
      count !== null ? el("span", { class: "badge t-xs ml-1" }, String(count)) : null,
    ]);
  };

  const navRow = el("div", {
    class: "row row--wrap mb-6",
    style: { borderBottom: "1px solid var(--line)", paddingBottom: "0.75rem", gap: "0.5rem" },
  }, [
    tabBtn("curriculum", "Curriculum Studio", "layers", lessonCount),
    tabBtn("settings", "Programme Settings", "sliders"),
    tabBtn("downloads", "Handouts & Gateways", "download", allDownloads.length),
  ]);

  // ---------------------------------------------------------------------------
  // Left Side Progress Tracker
  // ---------------------------------------------------------------------------

  const trackerHealthList = [
    { label: "Programme details", done: Boolean(program.title && program.summary && program.description) },
    { label: "At least 1 course", done: courses.length > 0 },
    { label: "At least 1 lesson", done: lessonCount > 0 },
    { label: "Pricing configured", done: Number.isFinite(program.price_cents) && program.price_cents >= 0 },
    { label: "Every course has an assessment", done: courses.length > 0 && courses.every((c) => c.quiz) },
    { label: "A download is attached", done: allDownloads.length > 0 },
  ];

  const trackerHealthNodes = trackerHealthList.map((item) =>
    el("li", { class: "checklist-item t-sm" }, [
      el("span", { class: item.done ? "checklist-dot checklist-dot--done" : "checklist-dot" },
        item.done ? icon("check", 10, { strokeWidth: 4 }) : ""),
      el("span", { style: { color: item.done ? "var(--ink)" : "var(--ink-subtle)" } }, item.label),
    ]));

  const sideTrackerTree = el("div", { class: "studio-tree" });

  courses.forEach((c, idx) => {
    const courseItem = el("a", {
      class: "studio-tree__item",
      href: `#course-${c.id}`,
    }, [
      el("span", { class: "studio-tree__icon" }, icon("bookOpen", 16)),
      el("div", { class: "grow truncate" }, [
        el("strong", { class: "block truncate" }, `${idx + 1}. ${c.title}`),
        el("span", { class: "subtle t-xs" }, `${c.lessons.length} lessons · ${c.quiz ? "Assessment ready" : "No quiz"}`),
      ]),
    ]);
    sideTrackerTree.append(courseItem);
  });

  const sideTracker = el("aside", { class: "studio-sidebar" }, [
    el("div", { class: "studio-tracker-card" }, [
      el("div", { class: "studio-tracker-header" }, [
        el("h2", { class: "t-sm font-semibold", style: { color: "var(--ink)" } }, "Side Tracker"),
        el("p", { class: "subtle t-xs" }, "Curriculum completion & health"),
      ]),
      el("div", { style: { padding: "1rem" } }, [
        el("ul", { class: "checklist" }, trackerHealthNodes),
        el("hr", { style: { margin: "1rem 0", borderColor: "var(--line)" } }),
        el("div", { class: "row row--between mb-2" }, [
          el("span", { class: "t-xs font-medium uppercase subtle tracking-wider" }, "Course Outline"),
          el("span", { class: "badge badge--brand t-xs" }, `${courses.length} courses`),
        ]),
        sideTrackerTree,
      ]),
    ]),
  ]);

  // ---------------------------------------------------------------------------
  // Canvas: Curriculum Studio View
  // ---------------------------------------------------------------------------

  const move = async (kind, row, direction, siblings) => {
    const index = siblings.findIndex((s) => s.id === row.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;
    await Promise.all([
      sb.from(kind).update({ position: swapWith.position }).eq("id", row.id),
      sb.from(kind).update({ position: row.position }).eq("id", swapWith.id),
    ]);
    render(admin);
  };

  const reorderSiblings = async (kind, orderedIds) => {
    await Promise.all(orderedIds.map((id, i) =>
      sb.from(kind).update({ position: i + 1 }).eq("id", id)));
    render(admin);
  };

  const courseCard = (course, index) => {
    const addLessonForm = el("form", { class: "row row--wrap mt-4", novalidate: true }, [
      el("input", {
        class: "control grow", name: "title", required: true,
        placeholder: "New lesson title (e.g. Introduction & Scope)",
      }),
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, [
        icon("plus", 14), "Add Lesson",
      ]),
    ]);

    addLessonForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = addLessonForm.elements.title.value.trim();
      if (!title) return;
      const { data } = await sb.from("lessons").insert({
        course_id: course.id,
        title,
        position: course.lessons.length + 1,
      }).select("id").maybeSingle();
      if (data) location.href = `/admin/lesson.html?id=${program.id}&lessonId=${data.id}`;
    });

    const lessonList = course.lessons.length
      ? el("ul", { class: "admin-lessons stack--sm" }, course.lessons.map((lesson, i) => {
          const blocks = lesson.lesson_blocks ?? [];
          const hasSlides = blocks.some((b) => b.block_type === "SLIDES");
          const hasVideo = blocks.some((b) => b.block_type === "VIDEO");
          const hasAudio = blocks.some((b) => b.block_type === "AUDIO");
          const hasImage = blocks.some((b) => b.block_type === "IMAGE");

          return el("li", {
            class: "studio-card row p-3",
            "data-sort-id": lesson.id,
            style: { cursor: "grab", transition: "transform 150ms" },
          }, [
            icon("gripVertical", 16, { class: "grip i-subtle" }),
            el("div", { class: "row row--tight" }, [
              hasSlides ? el("span", { class: "badge badge--brand t-xs" }, [icon("presentation", 12), "Slides"]) : null,
              hasVideo ? el("span", { class: "badge badge--brand t-xs" }, [icon("monitorPlay", 12), "Video"]) : null,
              hasAudio ? el("span", { class: "badge badge--brand t-xs" }, [icon("volume2", 12), "Audio"]) : null,
              hasImage ? el("span", { class: "badge badge--brand t-xs" }, [icon("image", 12), "Images"]) : null,
            ]),
            el("a", {
              class: "link grow truncate font-medium",
              href: `/admin/lesson.html?id=${program.id}&lessonId=${lesson.id}`,
            }, lesson.title),
            el("span", { class: "subtle t-xs tabular" }, `${blocks.length} blocks`),
            lesson.duration_minutes > 0
              ? el("span", { class: "subtle t-xs tabular" }, `${lesson.duration_minutes} min`)
              : null,
            button(icon("eye", 14), {
              variant: "ghost", size: "sm", "aria-label": "Preview lesson",
              onClick: () => {
                openLearnerPreview({
                  title: `${course.title} · ${lesson.title}`,
                  type: "lesson",
                  data: {
                    title: lesson.title,
                    courseTitle: course.title,
                    durationMinutes: lesson.duration_minutes,
                    blocks: lesson.lesson_blocks ?? [],
                  },
                });
              },
            }),
            buttonLink([icon("edit", 14), "Edit Content & Media"], `/admin/lesson.html?id=${program.id}&lessonId=${lesson.id}`, {
              variant: "secondary", size: "sm",
            }),
            button(icon("trash", 14), {
              variant: "ghost", size: "sm", "aria-label": "Delete lesson",
              onClick: async () => {
                if (confirm(`Delete "${lesson.title}"?`)) {
                  await sb.from("lessons").delete().eq("id", lesson.id);
                  render(admin);
                }
              },
            }),
          ]);
        }))
      : el("p", { class: "subtle t-sm p-4 center border-dashed", style: { border: "1px dashed var(--line)", borderRadius: "var(--radius-md)" } },
          "No lessons in this course yet. Add your first lesson below.");

    // Quiz Tile
    const quizTile = course.quiz
      ? el("div", {
          class: "row row--between p-3 mt-4",
          style: {
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--brand-200)",
            background: "linear-gradient(135deg, var(--white) 0%, var(--tint) 100%)",
          },
        }, [
          el("div", { class: "row" }, [
            icon("award", 20, { class: "text-brand-600" }),
            el("div", {}, [
              el("strong", { class: "block t-sm" }, course.quiz.title || "Course Assessment"),
              el("span", { class: "subtle t-xs" },
                `${(course.quiz.questions ?? []).length} questions · Pass mark: ${course.quiz.pass_mark_percent}%`),
            ]),
          ]),
          el("div", { class: "row" }, [
            button(icon("eye", 14), {
              variant: "ghost", size: "sm", "aria-label": "Preview assessment",
              onClick: async () => {
                const quizData = await rpc("admin_quiz", { p_quiz_id: course.quiz.id });
                if (quizData && quizData.ok !== false) {
                  openLearnerPreview({
                    title: quizData.title || "Course Assessment",
                    type: "quiz",
                    data: {
                      title: quizData.title,
                      passMarkPercent: quizData.pass_mark_percent,
                      questions: quizData.questions ?? [],
                    },
                  });
                }
              },
            }),

            buttonLink("Edit Assessment", `/admin/quiz.html?id=${program.id}&courseId=${course.id}`, {
              variant: "secondary", size: "sm",
            }),
          ]),
        ])
      : el("div", {
          class: "row row--between p-3 mt-4",
          style: { borderRadius: "var(--radius-md)", border: "1px dashed var(--line)", background: "var(--surface)" },
        }, [
          el("div", { class: "row" }, [
            icon("award", 18, { class: "i-subtle" }),
            el("span", { class: "subtle t-sm" }, "No assessment configured for this course module."),
          ]),
          buttonLink([icon("plus", 14), "Add Assessment"], `/admin/quiz.html?id=${program.id}&courseId=${course.id}`, {
            variant: "ghost", size: "sm",
          }),
        ]);

    return el("section", {
      id: `course-${course.id}`,
      class: "card studio-card",
      "data-sort-id": course.id,
      style: { padding: "1.5rem" },
    }, [
      el("div", { class: "row row--between mb-4 pb-3", style: { borderBottom: "1px solid var(--line)" } }, [
        el("div", { class: "row" }, [
          icon("gripVertical", 18, { class: "grip i-subtle" }),
          el("span", { class: "badge badge--brand font-semibold" }, `Course Module ${index + 1}`),
          el("h2", { class: "display", style: { fontSize: "1.25rem", margin: 0 } }, course.title),
        ]),
        el("div", { class: "row" }, [
          button(icon("trash", 14), {
            variant: "ghost", size: "sm", "aria-label": "Delete course",
            onClick: async () => {
              if (confirm(`Delete course "${course.title}" and all its lessons?`)) {
                await sb.from("courses").delete().eq("id", course.id);
                render(admin);
              }
            },
          }),
        ]),
      ]),
      lessonList,
      quizTile,
      addLessonForm,
      el("div", { class: "mt-6 pt-4", style: { borderTop: "1px solid var(--line)" } }, [
        el("h3", { class: "font-semibold t-sm mb-2" }, "Handouts gating this course"),
        courseDownloads(course.id).length
          ? el("ul", { class: "stack--sm mb-2" }, courseDownloads(course.id).map(downloadRow))
          : el("p", { class: "subtle t-xs mb-2" }, "None — learners only see the programme-wide handouts above."),
        downloadForm(course.id, courseDownloads(course.id)),
      ]),
    ]);
  };

  const emptyCourseOnboarding = el("div", {
    class: "card studio-card stack p-8 center",
    style: { border: "2px dashed var(--brand-300)", background: "linear-gradient(135deg, var(--white) 0%, var(--surface) 100%)" },
  }, [
    el("div", { class: "row justify-center" }, icon("sparkles", 32, { class: "text-brand-600" })),
    el("h2", { class: "display", style: { fontSize: "1.5rem" } }, "Let's build your course curriculum!"),
    el("p", { class: "subtle t-sm mb-4", style: { maxWidth: "30rem", marginInline: "auto" } },
      "Start by creating your first course module. Modules group lessons, presentation slides, video guides, and assessments together."),
    el("div", { class: "row justify-center" }, [
      button([icon("plus", 16), "Add Module 1 & Start Building Lessons"], {
        variant: "primary",
        onClick: async () => {
          const { data: newCourse } = await sb.from("courses").insert({
            program_id: program.id,
            title: "Module 1: Introduction & Scope",
            position: 1,
          }).select("id").maybeSingle();
          if (newCourse) {
            const [{ data: newLesson }] = await Promise.all([
              sb.from("lessons").insert({
                course_id: newCourse.id,
                title: "Lesson 1: Overview",
                position: 1,
                duration_minutes: 15,
              }).select("id").maybeSingle(),
              // So "Every course has an assessment" on the side tracker
              // isn't immediately false the moment a course exists.
              sb.from("quizzes").insert({ course_id: newCourse.id }),
            ]);
            if (newLesson) {
              // An empty starting block, not an empty editor — matches what
              // "Add Block" would leave you looking at anyway.
              await sb.from("lesson_blocks").insert({
                lesson_id: newLesson.id, block_type: "TEXT", position: 1, content: {},
              });
              location.href = `/admin/lesson.html?id=${program.id}&lessonId=${newLesson.id}`;
              return;
            }
          }
          render(admin);
        },
      }),
    ]),
  ]);

  const addCourseForm = el("form", {
    class: "card studio-card row p-4",
    style: { borderStyle: "dashed", background: "var(--surface)" },
    novalidate: true,
  }, [
    icon("folderPlus", 22, { class: "i-subtle" }),
    el("input", {
      class: "control grow", name: "title", required: true,
      placeholder: "New course module title (e.g. Module 2: Quality Management Principles)",
    }),
    el("button", { class: "btn btn--primary", type: "submit" }, [
      icon("plus", 16), "Add Course Module",
    ]),
  ]);

  addCourseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = addCourseForm.elements.title.value.trim();
    if (!title) return;
    await sb.from("courses").insert({
      program_id: program.id,
      title,
      position: courses.length + 1,
    });
    render(admin);
  });

  // ---------------------------------------------------------------------------
  // Canvas: Settings View
  // ---------------------------------------------------------------------------

  const settingsForm = el("form", { class: "card studio-card stack p-6", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Programme Information & Pricing"),
    el("div", { class: "grid grid--halves" }, [
      field({ label: "Programme Title", name: "title", required: true, value: program.title }),
      field({ label: "URL Slug", name: "slug", required: true, value: program.slug }),
    ]),
    field({ label: "Standard / Category", name: "standard", value: program.standard ?? "", placeholder: "e.g. ISO 9001:2015" }),
    field({ label: "Short Summary", name: "summary", as: "textarea", rows: 2, required: true, value: program.summary }),
    field({ label: "Full Description (Curriculum Overview)", name: "description", as: "textarea", rows: 6, required: true, value: program.description }),
    el("div", { class: "grid grid--halves" }, [
      field({
        label: "Price per seat (Rand, excl. VAT)", name: "price", type: "number",
        min: 0, step: "0.01", required: true, value: (program.price_cents / 100).toFixed(2),
      }),
      field({
        label: "Estimated Study Time (hours)", name: "durationHours", type: "number",
        min: 0, value: program.duration_hours ?? "",
      }),
    ]),
    el("button", { class: "btn btn--primary push", type: "submit" }, "Save Changes"),
  ]);

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(settingsForm, null);

    const price = Number(settingsForm.elements.price.value);
    const errors = {};
    if (!Number.isFinite(price) || price < 0) errors.price = "Enter the price per seat";
    setFieldErrors(settingsForm, errors);
    if (Object.keys(errors).length) return;

    const nextValues = {
      title: settingsForm.elements.title.value.trim(),
      slug: settingsForm.elements.slug.value.trim(),
      standard: settingsForm.elements.standard.value.trim() || null,
      summary: settingsForm.elements.summary.value.trim(),
      description: settingsForm.elements.description.value.trim(),
      price_cents: Math.round(price * 100),
      duration_hours: settingsForm.elements.durationHours.value
        ? Number(settingsForm.elements.durationHours.value) : null,
    };

    setPending(settingsForm, true);
    const { error } = await sb.from("programs").update(nextValues).eq("id", program.id);
    setPending(settingsForm, false);

    if (error) {
      setFormMessage(settingsForm, error.code === "23505" ? "That slug is already taken." : error.message);
      return;
    }

    Object.assign(program, nextValues);
    setFormMessage(settingsForm, "Saved successfully.", "success");
  });

  // ---------------------------------------------------------------------------
  // Canvas: Handouts & Gateways View
  // ---------------------------------------------------------------------------

  const downloadRow = (download) =>
    el("li", { class: "studio-card row p-3" }, [
      icon("download", 16, { class: "i-subtle" }),
      el("div", { class: "grow truncate" }, [
        el("p", { class: "font-medium t-sm truncate" }, [
          download.title,
          download.required ? el("span", { class: "badge badge--warn t-xs ml-2" }, "Required") : null,
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

  const downloadsContainer = el("div", { class: "card studio-card stack p-6" }, [
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Programme Handouts & Gating Documents"),
    el("p", { class: "subtle t-sm" },
      "Upload PDF handbooks, standard guides, or templates. Required files must be downloaded by learners before taking assessments."),
    programDownloads.length
      ? el("ul", { class: "stack--sm" }, programDownloads.map(downloadRow))
      : el("p", { class: "subtle t-sm center p-4", style: { border: "1px dashed var(--line)", borderRadius: "var(--radius-md)" } },
          "No programme-wide handouts uploaded yet."),
  ]);

  /**
   * `courseId` — null gates before the whole programme, a course's own id
   * gates before that specific course. Both scopes share this one form and
   * `downloadRow` above; only the target `course_id` and the "existing"
   * list used to number new uploads differ.
   */
  const downloadForm = (courseId, existing) => {
    const form = el("form", { class: "card studio-card stack p-6 mt-4", novalidate: true }, [
      el("div", { "data-message": "" }),
      el("h3", { class: "font-semibold t-sm" }, courseId ? "Add Course Handout" : "Add Programme Handout"),
      el("div", { class: "grid grid--halves" }, [
        el("input", { class: "control", name: "title", required: true,
          placeholder: courseId ? "Pre-course reading" : "Handout title (e.g. ISO Standard Checklist)" }),
        el("input", { class: "control", type: "file", name: "file", required: true }),
      ]),
      el("label", { class: "row t-sm" }, [
        el("input", { type: "checkbox", name: "required", checked: true }),
        "Mark as mandatory download gate",
      ]),
      el("button", { class: "btn btn--primary push", type: "submit" }, [icon("plus", 14), "Upload Document"]),
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
        return setFormMessage(form, "Upload refused.");
      }
      const { error } = await sb.from("program_downloads").insert({
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
      if (error) return setFormMessage(form, error.message);
      render(admin);
    });

    return form;
  };

  const addDownloadForm = downloadForm(null, programDownloads);

  // ---------------------------------------------------------------------------
  // Canvas Switcher
  // ---------------------------------------------------------------------------

  const canvasHost = el("div", { class: "studio-canvas" });

  function renderCanvas() {
    // Refresh tab buttons state
    [...navRow.children].forEach((btn, idx) => {
      const ids = ["curriculum", "settings", "downloads"];
      const isAct = activeTab === ids[idx];
      btn.style.backgroundColor = isAct ? "var(--brand-50)" : "transparent";
      btn.style.color = isAct ? "var(--brand-700)" : "var(--ink-muted)";
      btn.style.fontWeight = isAct ? "600" : "500";
      btn.style.borderColor = isAct ? "var(--brand-200)" : "transparent";
    });

    if (activeTab === "curriculum") {
      if (courses.length === 0) {
        canvasHost.replaceChildren(emptyCourseOnboarding, addCourseForm);
      } else {
        canvasHost.replaceChildren(
          ...courses.map(courseCard),
          addCourseForm,
        );
        // Make courses sortable. `:scope >`, not a bare attribute selector:
        // each course section has its own lessons nested inside it, each
        // carrying the same [data-sort-id] marker, and querySelectorAll
        // searches all descendants — an unscoped selector here would also
        // pick up every lesson, colliding with the lesson-level sortable set
        // up right below.
        makeSortable(canvasHost, ":scope > [data-sort-id]", ".grip", (ids) => reorderSiblings("courses", ids));
        // Make lessons sortable within each course
        canvasHost.querySelectorAll(".admin-lessons").forEach((list) => {
          makeSortable(list, ":scope > [data-sort-id]", ".grip", (ids) => reorderSiblings("lessons", ids));
        });
      }
    } else if (activeTab === "settings") {
      canvasHost.replaceChildren(settingsForm);
    } else if (activeTab === "downloads") {
      canvasHost.replaceChildren(downloadsContainer, addDownloadForm);
    }
  }

  renderCanvas();

  const studioContainer = el("div", { class: "studio-container" }, [
    sideTracker,
    canvasHost,
  ]);

  mount("#app", headerBanner, navRow, studioContainer);
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}



