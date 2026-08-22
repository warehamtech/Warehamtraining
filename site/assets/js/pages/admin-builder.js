import { el, mount, param, setTitle, formatBytes } from "../dom.js";
import { icon, blockIcon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, emptyState, field, progressBar,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc, signedUrl } from "../supabase.js";
import { formatMoney } from "../money.js";
import { uploadLessonMedia } from "../storage-upload.js";
import { makeSortable } from "../drag-reorder.js";
import { openLearnerPreview } from "../components/learner-preview.js";
import { renderBlock } from "../components/block-render.js";
import {
  BLOCK_LABEL, BLOCK_TYPES, blockFields, collectContent, hasContent, initialContent,
} from "../components/block-editors.js";
import { TYPE_CONFIG, buildTypeEditor, saveTypeData } from "../components/question-editors.js";

/**
 * Course Builder — the whole programme on one screen.
 *
 * Replaces the three-page authoring flow (programme → lesson → assessment)
 * that made every edit a full navigation. The outline on the left selects what
 * the canvas shows; a lesson's blocks are previewed with the same renderBlock()
 * the learner gets, so the canvas is what will ship rather than a form that
 * describes it. Clicking a block focuses it and docks its editor beside the
 * canvas.
 *
 * The old pages remain routed and functional — this is additive, and nothing
 * here changes what a learner sees or how progress is calculated.
 *
 * Mutations re-run render() rather than patching the DOM. That is the same
 * trade the rest of the admin area makes: a re-render costs one round trip and
 * removes a whole category of stale-view bug, and every edit here is behind an
 * explicit Save.
 */

/**
 * Survives re-renders (which rebuild the DOM from scratch), so the selected
 * lesson, focused block and collapsed courses persist across a save. Module
 * scope, not page scope: the router keeps this module in memory for the tab's
 * lifetime, so `programId` is what tells us a different programme was opened
 * and the rest has to be discarded.
 */
const state = {
  programId: null,
  view: "builder",
  viewport: "desktop",
  mode: "edit",
  selection: null,
  focusedBlockId: null,
  collapsed: new Set(),
  activeQuestion: 0,
};

let escapeBound = false;

/* --- Data ----------------------------------------------------------------- */

function loadProgram(programId) {
  return sb.from("programs")
    .select(`
      id, slug, title, summary, description, standard, price_cents,
      duration_hours, published,
      courses (
        id, title, summary, position,
        lessons (
          id, title, position, duration_minutes,
          lesson_blocks ( id, block_type, position, content )
        ),
        quizzes ( id, title, pass_mark_percent, max_attempts, questions ( id ) )
      ),
      program_downloads (
        id, course_id, title, file_key, original_name, content_type,
        size_bytes, required, position
      )
    `)
    .eq("id", programId)
    .maybeSingle()
    .then(unwrap);
}

/** Sort the nested tree once, and flatten each course's to-one quiz. */
function shapeCourses(program) {
  return [...(program.courses ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((course) => ({
      ...course,
      lessons: [...(course.lessons ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((lesson) => ({
          ...lesson,
          blocks: [...(lesson.lesson_blocks ?? [])].sort((a, b) => a.position - b.position),
        })),
      quiz: Array.isArray(course.quizzes) ? course.quizzes[0] ?? null : course.quizzes,
    }));
}

/**
 * Point the canvas at something that still exists. A lesson deleted out from
 * under the selection, or a first visit, both land on the first lesson.
 */
function ensureSelection(courses) {
  const sel = state.selection;
  if (sel) {
    const course = courses.find((c) => c.id === sel.courseId);
    if (course) {
      if (sel.kind === "lesson" && course.lessons.some((l) => l.id === sel.lessonId)) return;
      if (sel.kind === "quiz" && course.quiz) {
        state.selection = { kind: "quiz", courseId: course.id, quizId: course.quiz.id };
        return;
      }
    }
  }
  for (const course of courses) {
    if (course.lessons.length) {
      state.selection = { kind: "lesson", courseId: course.id, lessonId: course.lessons[0].id };
      return;
    }
  }
  state.selection = null;
}

const selectedCourse = (courses) =>
  courses.find((c) => c.id === state.selection?.courseId) ?? null;

const selectedLesson = (courses) => {
  if (state.selection?.kind !== "lesson") return null;
  return selectedCourse(courses)?.lessons.find((l) => l.id === state.selection.lessonId) ?? null;
};

/* --- Reordering ----------------------------------------------------------- */

async function reorder(table, orderedIds) {
  await Promise.all(orderedIds.map((id, i) =>
    sb.from(table).update({ position: i + 1 }).eq("id", id)));
  render();
}

async function moveBlock(blocks, block, direction) {
  const index = blocks.findIndex((b) => b.id === block.id);
  const swapWith = blocks[index + direction];
  if (!swapWith) return;
  await Promise.all([
    sb.from("lesson_blocks").update({ position: swapWith.position }).eq("id", block.id),
    sb.from("lesson_blocks").update({ position: block.position }).eq("id", swapWith.id),
  ]);
  render();
}

/* --- Top bar -------------------------------------------------------------- */

function segButton(label, iconName, isActive, onClick, extraClass = "") {
  const classes = ["builder-seg"];
  if (extraClass) classes.push(extraClass);
  if (isActive) classes.push("is-active");
  return el("button", {
    type: "button",
    class: classes.join(" "),
    "aria-pressed": isActive ? "true" : "false",
    onClick,
  }, [iconName ? icon(iconName, 15) : null, label]);
}

function topBar(program, courses, stats) {
  const publishBtn = el("button", {
    type: "button",
    class: program.published ? "btn btn--secondary btn--sm" : "btn btn--primary btn--sm",
  }, [
    icon(program.published ? "lock" : "sparkles", 14),
    program.published ? "Unpublish" : "Publish",
  ]);

  publishBtn.addEventListener("click", async () => {
    if (!program.published && !stats.canPublish) {
      alert("Add at least one course with a lesson before publishing.");
      return;
    }
    publishBtn.disabled = true;
    const { error } = await sb.from("programs").update({ published: !program.published }).eq("id", program.id);
    publishBtn.disabled = false;
    if (!error) render();
  });

  const switchView = (view) => {
    state.view = view;
    state.focusedBlockId = null;
    render();
  };

  const viewSwitcher = el("div", { class: "builder-seg-group" }, [
    segButton("Builder", "layers", state.view === "builder", () => switchView("builder")),
    segButton("Flow", "shuffle", state.view === "map", () => switchView("map")),
    segButton("Settings", "sliders", state.view === "settings", () => switchView("settings")),
    segButton("Handouts", "download", state.view === "downloads", () => switchView("downloads")),
  ]);

  const setViewport = (vp) => { state.viewport = vp; render(); };
  const viewportSwitcher = el("div", { class: "builder-seg-group" }, [
    segButton(null, "monitor", state.viewport === "desktop", () => setViewport("desktop"), "builder-seg--icon"),
    segButton(null, "tablet", state.viewport === "tablet", () => setViewport("tablet"), "builder-seg--icon"),
    segButton(null, "smartphone", state.viewport === "mobile", () => setViewport("mobile"), "builder-seg--icon"),
  ]);

  const setMode = (mode) => {
    state.mode = mode;
    state.focusedBlockId = null;
    render();
  };
  const modeSwitcher = el("div", { class: "builder-seg-group" }, [
    segButton("Edit", "edit", state.mode === "edit", () => setMode("edit")),
    segButton("Learner view", "eye", state.mode === "learner", () => setMode("learner"), "builder-seg--learner"),
  ]);

  return el("header", { class: "builder-topbar" }, [
    el("div", { class: "builder-topbar__brand" }, [
      el("img", { class: "builder-topbar__logo", src: "/assets/brand/wha-logo.png", alt: "WHA" }),
      el("div", { class: "builder-topbar__heading" }, [
        el("span", { class: "builder-topbar__title", title: program.title }, program.title),
        el("span", { class: "subtle t-xs" }, [
          program.published ? "Published" : "Draft",
          " · ",
          `${stats.lessonCount} lessons`,
        ]),
      ]),
    ]),
    viewSwitcher,
    el("div", { class: "builder-topbar__spacer" }),
    state.view === "builder" ? viewportSwitcher : null,
    state.view === "builder" ? modeSwitcher : null,
    buttonLink(icon("arrowLeft", 14), "/admin/programs.html", {
      variant: "ghost", size: "sm", "aria-label": "Back to programmes",
    }),
    publishBtn,
  ]);
}

/* --- Outline -------------------------------------------------------------- */

/**
 * A row that both selects and drags. A <div role="button"> rather than a real
 * <button> because native drag-and-drop on a <button> is unreliable across
 * browsers, and these rows are the drag targets for lesson reordering.
 */
function outlineRow(attrs, children, onActivate) {
  return el("div", {
    ...attrs,
    role: "button",
    tabindex: "0",
    onClick: onActivate,
    onKeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(event);
      }
    },
  }, children);
}

function select(selection) {
  state.selection = selection;
  state.focusedBlockId = null;
  state.activeQuestion = 0;
  state.view = "builder";
  render();
}

async function addLesson(course) {
  const title = prompt("Lesson title", `Lesson ${course.lessons.length + 1}`);
  if (!title?.trim()) return;
  const { data } = await sb.from("lessons").insert({
    course_id: course.id,
    title: title.trim(),
    position: course.lessons.length + 1,
    duration_minutes: 10,
  }).select("id").maybeSingle();
  if (data) state.selection = { kind: "lesson", courseId: course.id, lessonId: data.id };
  render();
}

async function addQuiz(course) {
  const { data } = await sb.from("quizzes").insert({ course_id: course.id }).select("id").maybeSingle();
  if (data) state.selection = { kind: "quiz", courseId: course.id, quizId: data.id };
  render();
}

function outlinePanel(program, courses, stats) {
  const body = el("div", { class: "builder-outline__body" });
  const lessonLists = [];

  courses.forEach((course, courseIndex) => {
    const isCollapsed = state.collapsed.has(course.id);

    const head = el("div", { class: "builder-course__head" }, [
      icon("gripVertical", 14, { class: "grip i-subtle" }),
      el("button", {
        type: "button",
        class: "builder-course__name",
        onClick: () => {
          if (isCollapsed) state.collapsed.delete(course.id);
          else state.collapsed.add(course.id);
          render();
        },
      }, [
        icon(isCollapsed ? "chevronRight" : "chevronDown", 12),
        ` ${courseIndex + 1}. ${course.title}`,
      ]),
      button(icon("trash", 12), {
        variant: "ghost", size: "sm", "aria-label": `Delete ${course.title}`,
        onClick: async () => {
          if (!confirm(`Delete "${course.title}" and all its lessons?`)) return;
          await sb.from("courses").delete().eq("id", course.id);
          render();
        },
      }),
    ]);

    const list = el("div", { class: "builder-course__list" });

    course.lessons.forEach((lesson, lessonIndex) => {
      const isActive = state.selection?.kind === "lesson" && state.selection.lessonId === lesson.id;
      list.append(outlineRow({
        class: isActive ? "builder-node is-active" : "builder-node",
        "data-sort-id": lesson.id,
      }, [
        icon("gripVertical", 12, { class: "grip i-subtle" }),
        icon("bookOpen", 13, { class: "builder-node__icon" }),
        el("span", { class: "builder-node__label" }, `${courseIndex + 1}.${lessonIndex + 1} ${lesson.title}`),
        el("span", { class: "builder-node__meta" }, `${lesson.blocks.length}`),
      ], () => select({ kind: "lesson", courseId: course.id, lessonId: lesson.id })));
    });

    if (course.quiz) {
      const isActive = state.selection?.kind === "quiz" && state.selection.courseId === course.id;
      list.append(outlineRow({
        class: isActive ? "builder-node builder-node--quiz is-active" : "builder-node builder-node--quiz",
      }, [
        el("span", { style: { width: "12px" } }),
        icon("award", 13, { class: "builder-node__icon" }),
        el("span", { class: "builder-node__label" }, course.quiz.title || "Assessment"),
        el("span", { class: "builder-node__meta" }, `${(course.quiz.questions ?? []).length}`),
      ], () => select({ kind: "quiz", courseId: course.id, quizId: course.quiz.id })));
    }

    list.append(outlineRow({ class: "builder-node builder-node--add" }, [
      el("span", { style: { width: "12px" } }),
      icon("plus", 13),
      el("span", { class: "builder-node__label" }, "Add lesson"),
    ], () => addLesson(course)));

    if (!course.quiz) {
      list.append(outlineRow({ class: "builder-node builder-node--add" }, [
        el("span", { style: { width: "12px" } }),
        icon("award", 13),
        el("span", { class: "builder-node__label" }, "Add assessment"),
      ], () => addQuiz(course)));
    }

    lessonLists.push(list);

    body.append(el("section", {
      class: "builder-course",
      "data-sort-id": course.id,
    }, [head, isCollapsed ? null : list]));
  });

  body.append(el("button", {
    type: "button",
    class: "builder-outline__add",
    onClick: async () => {
      const title = prompt("Module title", `Module ${courses.length + 1}`);
      if (!title?.trim()) return;
      await sb.from("courses").insert({
        program_id: program.id,
        title: title.trim(),
        position: courses.length + 1,
      });
      render();
    },
  }, [icon("folderPlus", 15), "Add module"]));

  makeSortable(body, ":scope > [data-sort-id]", ".grip", (ids) => reorder("courses", ids));
  for (const list of lessonLists) {
    makeSortable(list, ":scope > [data-sort-id]", ".grip", (ids) => reorder("lessons", ids));
  }

  return el("aside", { class: "builder-outline" }, [
    el("div", { class: "builder-outline__head" }, [
      icon("layers", 16, { class: "text-brand-600" }),
      el("strong", { class: "t-sm grow" }, "Course outline"),
      el("span", { class: "badge badge--brand t-xs" }, `${courses.length}`),
    ]),
    body,
    el("div", { class: "builder-outline__foot" }, [
      el("div", { class: "row row--between t-xs" }, [
        el("span", { class: "subtle" }, "Build progress"),
        el("strong", { style: { color: "var(--brand-700)" } }, `${stats.percent}%`),
      ]),
      progressBar(stats.percent, { size: "sm", label: `Programme ${stats.percent}% built` }),
    ]),
  ]);
}

/* --- Block chooser -------------------------------------------------------- */

function openBlockChooser(onPick) {
  const overlay = el("div", { class: "builder-modal", role: "dialog", "aria-modal": "true" });
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  overlay.append(el("div", { class: "builder-modal__panel" }, [
    el("div", { class: "builder-modal__head" }, [
      el("strong", {}, "Add a content block"),
      button(icon("x", 16), { variant: "ghost", size: "sm", "aria-label": "Close", onClick: close }),
    ]),
    el("div", { class: "builder-modal__body" }, [
      el("div", { class: "builder-chooser-grid" }, BLOCK_TYPES.map((entry) =>
        el("button", {
          type: "button",
          class: "builder-chooser-card",
          onClick: () => { close(); onPick(entry.type); },
        }, [
          el("span", { class: "builder-chooser-card__icon" }, icon(entry.icon, 18)),
          el("span", { class: "builder-chooser-card__text" }, [
            el("strong", {}, entry.label),
            el("span", {}, entry.hint),
          ]),
        ]))),
    ]),
  ]));

  document.body.append(overlay);
}

/* --- Block canvas --------------------------------------------------------- */

/**
 * Insert a block at `index` (0 = before the first). Written as "insert at the
 * end, then rewrite every position" rather than shifting the rows after the
 * insertion point: `position` carries no unique constraint, so one full
 * renumber is both simpler and impossible to leave half-applied.
 */
async function insertBlock(lesson, blocks, index, blockType) {
  const { data, error } = await sb.from("lesson_blocks").insert({
    lesson_id: lesson.id,
    block_type: blockType,
    position: blocks.length + 1,
    content: initialContent(blockType),
  }).select("id").maybeSingle();

  if (error) {
    alert(`Couldn't add that block: ${error.message}`);
    return;
  }

  if (data) {
    const ids = blocks.map((b) => b.id);
    ids.splice(index, 0, data.id);
    await Promise.all(ids.map((id, i) =>
      sb.from("lesson_blocks").update({ position: i + 1 }).eq("id", id)));
    state.focusedBlockId = data.id;
  }
  render();
}

async function duplicateBlock(lesson, blocks, block) {
  const { data } = await sb.from("lesson_blocks").insert({
    lesson_id: lesson.id,
    block_type: block.block_type,
    position: blocks.length + 1,
    content: block.content ?? {},
  }).select("id").maybeSingle();

  if (data) {
    const ids = blocks.map((b) => b.id);
    ids.splice(blocks.findIndex((b) => b.id === block.id) + 1, 0, data.id);
    await Promise.all(ids.map((id, i) =>
      sb.from("lesson_blocks").update({ position: i + 1 }).eq("id", id)));
    state.focusedBlockId = data.id;
  }
  render();
}

async function deleteBlock(block) {
  if (!confirm(`Delete this ${BLOCK_LABEL[block.block_type] ?? "content"} block?`)) return;
  await sb.from("lesson_blocks").delete().eq("id", block.id);
  if (state.focusedBlockId === block.id) state.focusedBlockId = null;
  render();
}

function inserter(lesson, blocks, index) {
  return el("div", { class: "builder-inserter" }, [
    el("button", {
      type: "button",
      class: "builder-inserter__btn",
      "aria-label": "Insert a block here",
      title: "Insert a block here",
      onClick: () => openBlockChooser((blockType) => insertBlock(lesson, blocks, index, blockType)),
    }, icon("plus", 14)),
  ]);
}

function blockCard(lesson, blocks, block, index, previewNode) {
  const focused = state.focusedBlockId === block.id;
  const stop = (fn) => (event) => { event.stopPropagation(); fn(); };

  const focusNav = focused
    ? el("div", { class: "builder-focus-nav" }, [
        el("button", {
          type: "button", class: "builder-focus-nav__btn",
          disabled: index === 0,
          onClick: stop(() => { state.focusedBlockId = blocks[index - 1]?.id ?? null; render(); }),
        }, [icon("arrowLeft", 12), "Prev"]),
        el("button", {
          type: "button", class: "builder-focus-nav__btn",
          onClick: stop(() => { state.focusedBlockId = null; render(); }),
        }, [icon("x", 12), "Done"]),
        el("button", {
          type: "button", class: "builder-focus-nav__btn",
          disabled: index === blocks.length - 1,
          onClick: stop(() => { state.focusedBlockId = blocks[index + 1]?.id ?? null; render(); }),
        }, ["Next", icon("arrowRight", 12)]),
      ])
    : null;

  const openFocus = () => {
    state.focusedBlockId = block.id;
    render();
  };

  return el("section", {
    class: focused ? "builder-block is-focused" : "builder-block",
    "data-sort-id": block.id,
  }, [
    focusNav,
    el("div", { class: "builder-block__head" }, [
      icon("gripVertical", 14, { class: "grip i-subtle" }),
      el("span", { class: "builder-block__type" }, [
        icon(blockIcon[block.block_type] ?? "layers", 13),
        BLOCK_LABEL[block.block_type] ?? block.block_type,
      ]),
      el("div", { class: "builder-block__bar" }, [
        button(icon("arrowUp", 13), {
          variant: "ghost", size: "sm", "aria-label": "Move up",
          disabled: index === 0,
          onClick: stop(() => moveBlock(blocks, block, -1)),
        }),
        button(icon("arrowDown", 13), {
          variant: "ghost", size: "sm", "aria-label": "Move down",
          disabled: index === blocks.length - 1,
          onClick: stop(() => moveBlock(blocks, block, 1)),
        }),
        button(icon("copy", 13), {
          variant: "ghost", size: "sm", "aria-label": "Duplicate",
          onClick: stop(() => duplicateBlock(lesson, blocks, block)),
        }),
        button(icon("trash", 13), {
          variant: "ghost", size: "sm", "aria-label": "Delete",
          onClick: stop(() => deleteBlock(block)),
        }),
      ]),
    ]),
    previewNode
      ? el("div", { class: "builder-block__preview", onClick: openFocus }, previewNode)
      : el("div", { class: "builder-block__hint", onClick: openFocus },
          `Empty ${BLOCK_LABEL[block.block_type] ?? "block"} — click to add its content.`),
  ]);
}

/* --- Focus dock ----------------------------------------------------------- */

function focusDock(lesson, blocks, block, imagePreviewUrl, programId) {
  const content = block.content ?? {};
  const index = blocks.findIndex((b) => b.id === block.id);
  let liveSlides = null;

  const form = el("form", { class: "stack--sm", novalidate: true }, [
    el("div", { "data-message": "" }),
    ...blockFields(block.block_type, content, {
      imagePreviewUrl,
      onSlidesChange: (slides) => { liveSlides = slides; },
    }),
    el("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Save block"),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);
    setPending(form, true);

    const result = await collectContent({
      form,
      blockType: block.block_type,
      content,
      upload: (file, prefix) => uploadLessonMedia(file, programId, prefix),
      liveSlides,
    });

    if (!result.ok) {
      setPending(form, false);
      return setFormMessage(form, result.error);
    }

    const { error } = await sb.from("lesson_blocks")
      .update({ content: result.content }).eq("id", block.id);
    setPending(form, false);
    if (error) return setFormMessage(form, error.message);
    render();
  });

  return el("aside", { class: "builder-dock" }, [
    el("div", { class: "builder-dock__head" }, [
      icon(blockIcon[block.block_type] ?? "layers", 16, { class: "text-brand-600" }),
      el("span", { class: "builder-dock__title" }, BLOCK_LABEL[block.block_type] ?? block.block_type),
      button(icon("x", 15), {
        variant: "ghost", size: "sm", "aria-label": "Close block editor",
        onClick: () => { state.focusedBlockId = null; render(); },
      }),
    ]),
    el("div", { class: "builder-dock__group" }, [
      el("span", { class: "builder-dock__legend" }, "Block actions"),
      el("div", { class: "builder-dock__actions" }, [
        button([icon("arrowUp", 12), "Up"], {
          variant: "secondary", size: "sm", disabled: index === 0,
          onClick: () => moveBlock(blocks, block, -1),
        }),
        button([icon("arrowDown", 12), "Down"], {
          variant: "secondary", size: "sm", disabled: index === blocks.length - 1,
          onClick: () => moveBlock(blocks, block, 1),
        }),
        button([icon("copy", 12), "Duplicate"], {
          variant: "secondary", size: "sm",
          onClick: () => duplicateBlock(lesson, blocks, block),
        }),
        button([icon("trash", 12), "Delete"], {
          variant: "ghost", size: "sm",
          onClick: () => deleteBlock(block),
        }),
      ]),
    ]),
    el("div", { class: "builder-dock__group" }, [
      el("span", { class: "builder-dock__legend" }, "Content"),
      form,
    ]),
  ]);
}

/* --- Lesson canvas -------------------------------------------------------- */

function lessonSettingsCard(lesson) {
  const form = el("form", { class: "card stack p-4 mb-4", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "grid grid--halves" }, [
      field({ label: "Lesson title", name: "title", required: true, value: lesson.title }),
      field({
        label: "Duration (minutes)", name: "durationMinutes", type: "number", min: 0,
        value: lesson.duration_minutes ?? 0,
      }),
    ]),
    el("div", { class: "row row--between" }, [
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Save lesson"),
      button([icon("trash", 13), "Delete lesson"], {
        variant: "ghost", size: "sm",
        onClick: async () => {
          if (!confirm(`Delete "${lesson.title}"? This cannot be undone.`)) return;
          await sb.from("lessons").delete().eq("id", lesson.id);
          state.selection = null;
          render();
        },
      }),
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setPending(form, true);
    const { error } = await sb.from("lessons").update({
      title: form.elements.title.value.trim(),
      duration_minutes: Number(form.elements.durationMinutes.value) || 0,
    }).eq("id", lesson.id);
    setPending(form, false);
    if (error) return setFormMessage(form, error.message);
    render();
  });

  return form;
}

async function lessonCanvas(course, lesson, programId) {
  const blocks = lesson.blocks;

  // Signed up front so the dock's editor can render synchronously.
  const imagePreviews = new Map();
  for (const block of blocks) {
    if (block.block_type === "IMAGE" && block.content?.file_key) {
      imagePreviews.set(block.id, await signedUrl("lesson-media", block.content.file_key, 3600));
    }
  }

  const previews = new Map();
  for (const block of blocks) {
    if (!hasContent(block.block_type, block.content ?? {})) continue;
    previews.set(block.id, await renderBlock(block, { title: lesson.title }));
  }

  if (state.mode === "learner") {
    const rendered = blocks.map((b) => previews.get(b.id)).filter(Boolean);
    return {
      canvas: el("div", { class: `builder-canvas builder-canvas--${state.viewport}` }, [
        el("div", { class: "stack" }, [
          el("div", { class: "page-head" }, el("div", {}, [
            el("span", { class: "badge badge--brand mb-2" }, course.title),
            el("h1", { class: "display" }, lesson.title),
            lesson.duration_minutes
              ? el("p", { class: "subtle t-sm" }, `Estimated time: ${lesson.duration_minutes} min`)
              : null,
          ])),
          rendered.length
            ? rendered
            : el("p", { class: "page-state" }, "This lesson has no content yet."),
          el("div", { class: "lesson__foot mt-4" },
            el("button", { class: "btn btn--primary", type: "button", disabled: true },
              [icon("check", 14), "Mark as complete"])),
        ]),
      ]),
      dock: null,
    };
  }

  const canvas = el("div", {
    class: `builder-canvas builder-canvas--${state.viewport}${state.focusedBlockId ? " has-focus" : ""}`,
  }, [
    el("div", { class: "builder-crumb" }, [
      el("span", {}, course.title),
      icon("chevronRight", 12),
      el("strong", { style: { color: "var(--brand-700)" } }, lesson.title),
    ]),
    lessonSettingsCard(lesson),
    inserter(lesson, blocks, 0),
  ]);

  blocks.forEach((block, index) => {
    canvas.append(blockCard(lesson, blocks, block, index, previews.get(block.id)));
    canvas.append(inserter(lesson, blocks, index + 1));
  });

  if (blocks.length === 0) {
    canvas.append(el("div", { class: "card p-6" }, emptyState({
      iconName: "sparkles",
      title: "No content blocks yet",
      description: "Add slides, video, audio, pictures or text to build this lesson.",
      action: button([icon("plus", 14), "Add the first block"], {
        onClick: () => openBlockChooser((type) => insertBlock(lesson, blocks, 0, type)),
      }),
    })));
  }

  makeSortable(canvas, ":scope > [data-sort-id]", ".grip", (ids) => reorder("lesson_blocks", ids));

  const focused = blocks.find((b) => b.id === state.focusedBlockId) ?? null;
  return {
    canvas,
    dock: focused
      ? focusDock(lesson, blocks, focused, imagePreviews.get(focused.id), programId)
      : null,
  };
}

/* --- Assessment canvas ---------------------------------------------------- */

async function quizCanvas(course, programId) {
  const quiz = await rpc("admin_quiz", { p_quiz_id: state.selection.quizId });
  if (!quiz || quiz.ok === false) {
    return el("div", { class: `builder-canvas builder-canvas--${state.viewport}` },
      el("div", { class: "card p-6" }, emptyState({
        iconName: "lock",
        title: "That assessment could not be loaded",
      })));
  }

  const questions = [...(quiz.questions ?? [])].sort((a, b) => a.position - b.position);
  if (state.activeQuestion >= questions.length) state.activeQuestion = Math.max(0, questions.length - 1);

  const settingsForm = el("form", { class: "card stack p-4 mb-4", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "grid grid--thirds" }, [
      field({ label: "Assessment title", name: "title", value: quiz.title ?? "", required: true }),
      field({ label: "Pass mark (%)", name: "passMark", type: "number", min: 1, max: 100, value: quiz.pass_mark_percent, required: true }),
      field({ label: "Max attempts", name: "maxAttempts", type: "number", min: 1, max: 10, value: quiz.max_attempts, required: true }),
    ]),
    el("div", { class: "row row--between" }, [
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Save rules"),
      el("div", { class: "row" }, [
        button([icon("eye", 13), "Preview"], {
          variant: "ghost", size: "sm",
          onClick: () => openLearnerPreview({
            title: `${course.title} · Assessment`,
            type: "quiz",
            data: { title: quiz.title, passMarkPercent: quiz.pass_mark_percent, questions },
          }),
        }),
        button([icon("trash", 13), "Delete"], {
          variant: "ghost", size: "sm",
          onClick: async () => {
            if (!confirm("Delete this assessment and all its questions? Learners' past attempts go with it.")) return;
            await sb.from("quizzes").delete().eq("id", quiz.id);
            state.selection = null;
            render();
          },
        }),
      ]),
    ]),
  ]);

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setPending(settingsForm, true);
    const { error } = await sb.from("quizzes").update({
      title: settingsForm.elements.title.value.trim(),
      pass_mark_percent: Number(settingsForm.elements.passMark.value),
      max_attempts: Number(settingsForm.elements.maxAttempts.value),
    }).eq("id", quiz.id);
    setPending(settingsForm, false);
    if (error) return setFormMessage(settingsForm, error.message);
    render();
  });

  const addQuestion = async () => {
    const { data } = await sb.from("questions").insert({
      quiz_id: quiz.id,
      prompt: "New question prompt",
      question_type: "MULTIPLE_CHOICE",
      position: questions.length + 1,
    }).select("id").maybeSingle();
    if (data) state.activeQuestion = questions.length;
    render();
  };

  const stepper = el("div", { class: "question-stepper mb-4" }, [
    ...questions.map((_, idx) =>
      el("button", {
        type: "button",
        class: idx === state.activeQuestion ? "question-step-btn is-active" : "question-step-btn",
        onClick: () => { state.activeQuestion = idx; render(); },
      }, [el("span", { class: "dot-status" }), `Q${idx + 1}`])),
    el("button", {
      type: "button",
      class: "question-step-btn",
      style: { borderStyle: "dashed" },
      onClick: addQuestion,
    }, [icon("plus", 13), "Add question"]),
  ]);

  const canvas = el("div", { class: `builder-canvas builder-canvas--${state.viewport}` }, [
    el("div", { class: "builder-crumb" }, [
      el("span", {}, course.title),
      icon("chevronRight", 12),
      el("strong", { style: { color: "var(--brand-700)" } }, quiz.title || "Assessment"),
    ]),
    settingsForm,
    stepper,
  ]);

  if (questions.length === 0) {
    canvas.append(el("div", { class: "card p-6" }, emptyState({
      iconName: "helpCircle",
      title: "No questions yet",
      description: "Add the first question to test what learners took from this module.",
      action: button("Add question", { onClick: addQuestion }),
    })));
    return canvas;
  }

  const question = questions[state.activeQuestion];
  let selectedType = question.question_type ?? "MULTIPLE_CHOICE";
  let editor = buildTypeEditor(selectedType, question);
  const editorSlot = el("div", {}, editor.node);

  const typePicker = el("div", { class: "question-type-picker" },
    Object.entries(TYPE_CONFIG).map(([typeKey, cfg]) => {
      const card = el("button", {
        type: "button",
        class: selectedType === typeKey ? "question-type-card is-active" : "question-type-card",
        onClick: () => {
          selectedType = typeKey;
          [...typePicker.children].forEach((c) => c.classList.remove("is-active"));
          card.classList.add("is-active");
          editor = buildTypeEditor(selectedType, question);
          editorSlot.replaceChildren(editor.node);
        },
      }, [
        el("div", { class: "question-type-card__icon" }, icon(cfg.icon, 18)),
        el("div", { class: "question-type-card__info" }, [
          el("strong", {}, cfg.label),
          el("span", {}, cfg.hint),
        ]),
      ]);
      return card;
    }));

  const form = el("form", { class: "card stack p-6", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "row row--between mb-4 pb-3", style: { borderBottom: "1px solid var(--line)" } }, [
      el("span", { class: "badge badge--brand" }, `Question ${state.activeQuestion + 1} of ${questions.length}`),
      button(icon("trash", 13), {
        variant: "ghost", size: "sm", "aria-label": "Delete question",
        onClick: async () => {
          if (!confirm(`Delete question ${state.activeQuestion + 1}?`)) return;
          await sb.from("questions").delete().eq("id", question.id);
          render();
        },
      }),
    ]),
    el("label", { class: "field__label" }, "Question type"),
    typePicker,
    field({
      label: "Question prompt", name: "prompt", as: "textarea", rows: 3,
      required: true, value: question.prompt ?? "",
    }),
    editorSlot,
    field({
      label: "Feedback shown after submission", name: "explanation", as: "textarea", rows: 2,
      value: question.explanation ?? "",
    }),
    el("div", { class: "row row--between pt-3", style: { borderTop: "1px solid var(--line)" } }, [
      el("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Save question"),
      el("div", { class: "row" }, [
        button(icon("arrowLeft", 13), {
          variant: "secondary", size: "sm", "aria-label": "Previous question",
          disabled: state.activeQuestion === 0,
          onClick: () => { state.activeQuestion -= 1; render(); },
        }),
        button(icon("arrowRight", 13), {
          variant: "secondary", size: "sm", "aria-label": "Next question",
          disabled: state.activeQuestion === questions.length - 1,
          onClick: () => { state.activeQuestion += 1; render(); },
        }),
      ]),
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const prompt = form.elements.prompt.value.trim();
    if (!prompt) return setFormMessage(form, "Write a prompt for this question.");

    const result = editor.collect();
    if (!result.ok) return setFormMessage(form, result.error);

    setPending(form, true);
    const { error } = await sb.from("questions").update({
      prompt,
      question_type: result.type,
      explanation: form.elements.explanation.value.trim() || null,
    }).eq("id", question.id);

    if (error) {
      setPending(form, false);
      return setFormMessage(form, error.message);
    }

    await saveTypeData(question.id, result);
    setPending(form, false);
    render();
  });

  canvas.append(form);
  return canvas;
}

/* --- Flow map ------------------------------------------------------------- */

/**
 * A read-only picture of the route a learner takes: every lesson in order,
 * then the module's assessment, then the next module. Today that route is
 * always this linear one — courses by position, lessons by position, the quiz
 * last — which is exactly what progress.js enforces.
 */
function mapCanvas(courses) {
  const map = el("div", { class: "builder-map" });
  let first = true;

  const link = () => (first ? null : el("div", { class: "builder-map__link" }));

  courses.forEach((course, courseIndex) => {
    map.append(link());
    map.append(el("div", { class: "builder-map__node builder-map__node--course" }, [
      el("span", { class: "builder-map__label" }, `Module ${courseIndex + 1}`),
      el("strong", { class: "block t-sm" }, course.title),
    ]));
    first = false;

    course.lessons.forEach((lesson, lessonIndex) => {
      map.append(link());
      map.append(el("div", { class: "builder-map__node" }, [
        el("span", { class: "builder-map__label" }, `Lesson ${courseIndex + 1}.${lessonIndex + 1}`),
        el("strong", { class: "block t-sm" }, lesson.title),
        el("span", { class: "subtle t-xs" }, `${lesson.blocks.length} blocks`),
      ]));
    });

    if (course.quiz) {
      map.append(link());
      map.append(el("div", { class: "builder-map__node builder-map__node--quiz" }, [
        el("span", { class: "builder-map__label" }, "Assessment"),
        el("strong", { class: "block t-sm" }, course.quiz.title || "Course assessment"),
        el("span", { class: "subtle t-xs" },
          `Unlocks once every lesson above is complete · pass at ${course.quiz.pass_mark_percent}%`),
      ]));
    }
  });

  if (!courses.length) {
    map.append(el("div", { class: "card p-6" }, emptyState({
      iconName: "shuffle",
      title: "Nothing to map yet",
      description: "Add a module and some lessons to see the learner's route through this programme.",
    })));
  }

  return el("div", { class: "builder-canvas" }, [
    el("div", { class: "builder-crumb" }, [
      el("strong", { style: { color: "var(--brand-700)" } }, "Learner route"),
      el("span", { class: "subtle" }, "— the order a learner moves through this programme"),
    ]),
    map,
  ]);
}

/* --- Settings ------------------------------------------------------------- */

function settingsCanvas(program) {
  const form = el("form", { class: "card stack p-6", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Programme information & pricing"),
    el("div", { class: "grid grid--halves" }, [
      field({ label: "Programme title", name: "title", required: true, value: program.title }),
      field({ label: "URL slug", name: "slug", required: true, value: program.slug }),
    ]),
    field({ label: "Standard / category", name: "standard", value: program.standard ?? "", placeholder: "e.g. ISO 9001:2015" }),
    field({ label: "Short summary", name: "summary", as: "textarea", rows: 2, required: true, value: program.summary ?? "" }),
    field({ label: "Full description", name: "description", as: "textarea", rows: 6, required: true, value: program.description ?? "" }),
    el("div", { class: "grid grid--halves" }, [
      field({
        label: "Price per seat (Rand, excl. VAT)", name: "price", type: "number",
        min: 0, step: "0.01", required: true, value: (program.price_cents / 100).toFixed(2),
      }),
      field({
        label: "Estimated study time (hours)", name: "durationHours", type: "number",
        min: 0, value: program.duration_hours ?? "",
      }),
    ]),
    el("button", { class: "btn btn--primary push", type: "submit" }, "Save changes"),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const price = Number(form.elements.price.value);
    const errors = {};
    if (!Number.isFinite(price) || price < 0) errors.price = "Enter the price per seat";
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);
    const { error } = await sb.from("programs").update({
      title: form.elements.title.value.trim(),
      slug: form.elements.slug.value.trim(),
      standard: form.elements.standard.value.trim() || null,
      summary: form.elements.summary.value.trim(),
      description: form.elements.description.value.trim(),
      price_cents: Math.round(price * 100),
      duration_hours: form.elements.durationHours.value ? Number(form.elements.durationHours.value) : null,
    }).eq("id", program.id);
    setPending(form, false);

    if (error) {
      return setFormMessage(form, error.code === "23505" ? "That slug is already taken." : error.message);
    }
    setFormMessage(form, "Saved.", "success");
  });

  return el("div", { class: "builder-canvas" }, form);
}

/* --- Handouts ------------------------------------------------------------- */

function downloadRow(download) {
  return el("li", { class: "card row p-3" }, [
    icon("download", 15, { class: "i-subtle" }),
    el("div", { class: "grow truncate" }, [
      el("p", { class: "font-medium t-sm truncate" }, [
        download.title,
        download.required ? el("span", { class: "badge badge--warn t-xs ml-2" }, "Required") : null,
      ]),
      el("p", { class: "subtle t-xs tabular" },
        `${download.original_name} · ${formatBytes(download.size_bytes)}`),
    ]),
    button(icon("trash", 13), {
      variant: "ghost", size: "sm", "aria-label": "Remove handout",
      onClick: async () => {
        await sb.storage.from("lesson-media").remove([download.file_key]);
        await sb.from("program_downloads").delete().eq("id", download.id);
        render();
      },
    }),
  ]);
}

/**
 * `courseId` null gates the whole programme; a course's id gates just that
 * module. Both scopes share this form — only the target and the list used to
 * number the new row differ.
 */
function downloadForm(program, courseId, existing) {
  const form = el("form", { class: "card stack p-4 mt-3", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "grid grid--halves" }, [
      el("input", { class: "control", name: "title", required: true, placeholder: "Handout title" }),
      el("input", { class: "control", type: "file", name: "file", required: true }),
    ]),
    el("label", { class: "row t-sm" }, [
      el("input", { type: "checkbox", name: "required", checked: true }),
      "Learners must download this before the assessment unlocks",
    ]),
    el("button", { class: "btn btn--secondary btn--sm push", type: "submit" }, [icon("plus", 13), "Upload"]),
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
    render();
  });

  return form;
}

function downloadsCanvas(program, courses) {
  const all = [...(program.program_downloads ?? [])].sort((a, b) => a.position - b.position);
  const forProgram = all.filter((d) => d.course_id === null);
  const forCourse = (courseId) => all.filter((d) => d.course_id === courseId);

  return el("div", { class: "builder-canvas stack" }, [
    el("section", { class: "card stack p-6" }, [
      el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Programme handouts"),
      el("p", { class: "subtle t-sm" },
        "Handbooks, standards and templates. Required files must be downloaded before a learner can sit an assessment."),
      forProgram.length
        ? el("ul", { class: "stack--sm" }, forProgram.map(downloadRow))
        : el("p", { class: "subtle t-sm center p-4", style: { border: "1px dashed var(--line)", borderRadius: "var(--radius-md)" } },
            "No programme-wide handouts yet."),
      downloadForm(program, null, forProgram),
    ]),
    ...courses.map((course) =>
      el("section", { class: "card stack p-6" }, [
        el("h3", { class: "font-semibold t-sm" }, `Handouts gating ${course.title}`),
        forCourse(course.id).length
          ? el("ul", { class: "stack--sm" }, forCourse(course.id).map(downloadRow))
          : el("p", { class: "subtle t-xs" }, "None — only the programme-wide handouts above apply."),
        downloadForm(program, course.id, forCourse(course.id)),
      ])),
  ]);
}

/* --- Empty programme ------------------------------------------------------ */

function onboardingCanvas(program) {
  return el("div", { class: "builder-canvas" },
    el("div", { class: "card p-8" }, emptyState({
      iconName: "sparkles",
      title: "Let's build this curriculum",
      description: "Modules group lessons and one assessment. Start with the first module and its opening lesson.",
      action: button([icon("plus", 15), "Create the first module"], {
        onClick: async () => {
          const { data: course } = await sb.from("courses").insert({
            program_id: program.id,
            title: "Module 1: Introduction & Scope",
            position: 1,
          }).select("id").maybeSingle();
          if (!course) return render();

          const [{ data: lesson }] = await Promise.all([
            sb.from("lessons").insert({
              course_id: course.id,
              title: "Lesson 1: Overview",
              position: 1,
              duration_minutes: 15,
            }).select("id").maybeSingle(),
            sb.from("quizzes").insert({ course_id: course.id }),
          ]);

          if (lesson) {
            await sb.from("lesson_blocks").insert({
              lesson_id: lesson.id,
              block_type: "SLIDES",
              position: 1,
              content: initialContent("SLIDES"),
            });
            state.selection = { kind: "lesson", courseId: course.id, lessonId: lesson.id };
          }
          render();
        },
      }),
    })));
}

/* --- Render --------------------------------------------------------------- */

/**
 * How far along the build is, as a fraction of the things that have to be true
 * before this programme can go live: its own details, a price, and then every
 * lesson holding content and every module ending in a real assessment.
 */
function buildStats(program, courses) {
  const lessonCount = courses.reduce((n, c) => n + c.lessons.length, 0);

  const checks = [
    Boolean(program.title && program.summary && program.description),
    Number.isFinite(program.price_cents) && program.price_cents >= 0,
    courses.length > 0,
    lessonCount > 0,
    ...courses.flatMap((c) => c.lessons.map((l) => l.blocks.length > 0)),
    ...courses.map((c) => (c.quiz?.questions ?? []).length > 0),
  ];

  const done = checks.filter(Boolean).length;
  return {
    lessonCount,
    canPublish: courses.length > 0 && lessonCount > 0,
    percent: checks.length ? Math.round((done / checks.length) * 100) : 0,
  };
}

async function render() {
  const program = await loadProgram(state.programId);

  if (!program) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Programme not found",
      action: buttonLink("Back to programmes", "/admin/programs.html"),
    }));
    return;
  }

  setTitle(`${program.title} — Course Builder`);

  const courses = shapeCourses(program);
  const stats = buildStats(program, courses);
  ensureSelection(courses);

  let canvas;
  let dock = null;

  if (state.view === "settings") {
    canvas = settingsCanvas(program);
  } else if (state.view === "downloads") {
    canvas = downloadsCanvas(program, courses);
  } else if (state.view === "map") {
    canvas = mapCanvas(courses);
  } else if (courses.length === 0) {
    canvas = onboardingCanvas(program);
  } else if (state.selection?.kind === "quiz") {
    canvas = await quizCanvas(selectedCourse(courses), program.id);
  } else {
    const lesson = selectedLesson(courses);
    if (lesson) {
      const built = await lessonCanvas(selectedCourse(courses), lesson, program.id);
      canvas = built.canvas;
      dock = built.dock;
    } else {
      canvas = el("div", { class: "builder-canvas" },
        el("div", { class: "card p-8" }, emptyState({
          iconName: "bookOpen",
          title: "This module has no lessons yet",
          description: "Add one from the outline on the left to start building.",
        })));
    }
  }

  mount("#app", el("div", { class: "builder-shell" }, [
    topBar(program, courses, stats),
    el("div", { class: "builder-body" }, [
      outlinePanel(program, courses, stats),
      el("div", { class: "builder-canvas-wrap" }, canvas),
    ]),
    dock,
  ]));
}

export async function init() {
  const programId = param("id");
  if (!programId) {
    location.replace("/admin/programs.html");
    return;
  }

  // A different programme means the remembered selection belongs to a tree
  // that is no longer on screen.
  if (state.programId !== programId) {
    state.programId = programId;
    state.view = "builder";
    state.mode = "edit";
    state.selection = null;
    state.focusedBlockId = null;
    state.collapsed = new Set();
    state.activeQuestion = 0;
  }

  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  // Bound once for the module's lifetime, not per render — every render
  // rebuilds the DOM, and a listener added there would accumulate one copy per
  // edit for as long as the tab stays open.
  if (!escapeBound) {
    escapeBound = true;
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!state.focusedBlockId) return;
      if (!document.querySelector(".builder-shell")) return;
      state.focusedBlockId = null;
      render();
    });
  }

  await render();
}
