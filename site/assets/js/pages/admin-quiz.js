import { el, mount, param, page, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";

/**
 * Assessment editor. Port of the quiz half of admin/programs/[id]/courses/…
 * Extended for the four question types added in 0008_quiz_engine_v2.sql.
 *
 * Note the read path: `choices.is_correct` and the whole
 * `question_answer_keys` table are granted to no client role, so this page
 * CANNOT select them from their tables. It calls admin_quiz(), a
 * SECURITY DEFINER function that checks is_wha_admin() and returns the full
 * tree including every answer key. Writes go to the tables normally — the
 * write policies already restrict them to WHA staff.
 */

const TYPE_LABEL = {
  MULTIPLE_CHOICE: "Multiple choice",
  SHORT_TEXT: "Short text",
  MATCHING: "Matching",
  ORDERING: "Ordering",
};

/* --- Per-type editors -------------------------------------------------------
 *
 * Each returns { node, collect() }. collect() returns either
 * { ok: false, error } or { ok: true, type, ...typeData } — plain data, no DB
 * calls, so switching a question's type and back is just a fresh render, not
 * a partial save.
 */

function multipleChoiceEditor(question) {
  const rows = el("div", { class: "stack--sm" });
  const groupName = `correct-${question.id}`;

  const addRow = (choice = null) => {
    const row = el("div", { class: "row" }, [
      el("input", {
        type: "radio", name: groupName, "aria-label": "Correct answer",
        checked: choice?.is_correct ?? false,
      }),
      el("input", {
        class: "control grow", type: "text",
        value: choice?.text ?? "", placeholder: "Answer option",
      }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove option",
        onClick: () => row.remove(),
      }),
    ]);
    rows.append(row);
  };

  for (const choice of question.choices ?? []) addRow(choice);
  if (!(question.choices ?? []).length) { addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Answer options"),
    el("p", { class: "field__hint" },
      "Select the radio button beside the correct answer. Learners never receive this flag."),
    rows,
    el("div", { class: "row mt-2" }, [
      button([icon("plus", 14), "Add option"], {
        variant: "ghost", size: "sm", onClick: () => addRow(),
      }),
    ]),
  ]);

  return {
    node,
    collect() {
      const values = [...rows.children].map((row) => ({
        text: row.querySelector('input[type="text"]').value.trim(),
        isCorrect: row.querySelector('input[type="radio"]').checked,
      })).filter((choice) => choice.text);

      if (values.length < 2) {
        return { ok: false, error: "Give the question at least two answer options." };
      }
      if (!values.some((choice) => choice.isCorrect)) {
        return { ok: false, error: "Mark one option as the correct answer." };
      }
      return { ok: true, type: "MULTIPLE_CHOICE", choices: values };
    },
  };
}

function shortTextEditor(question) {
  const rows = el("div", { class: "stack--sm" });

  const addRow = (text = "") => {
    const row = el("div", { class: "row" }, [
      el("input", { class: "control grow", type: "text", value: text, placeholder: "Accepted answer" }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove", onClick: () => row.remove(),
      }),
    ]);
    rows.append(row);
  };

  const accepted = question.answer_key?.accepted ?? [];
  for (const text of accepted) addRow(text);
  if (!accepted.length) addRow();

  const caseCheckbox = el("input", {
    type: "checkbox", checked: question.answer_key?.case_sensitive ?? false,
  });

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Accepted answers"),
    el("p", { class: "field__hint" },
      "Any one of these matches, after trimming and (unless case-sensitive) lower-casing."),
    rows,
    el("div", { class: "row mt-2" }, [
      button([icon("plus", 14), "Add accepted answer"], {
        variant: "ghost", size: "sm", onClick: () => addRow(),
      }),
    ]),
    el("label", { class: "row t-sm mt-2" }, [caseCheckbox, "Case sensitive"]),
  ]);

  return {
    node,
    collect() {
      const values = [...rows.children]
        .map((row) => row.querySelector('input[type="text"]').value.trim())
        .filter(Boolean);
      if (!values.length) return { ok: false, error: "Add at least one accepted answer." };
      return { ok: true, type: "SHORT_TEXT", accepted: values, caseSensitive: caseCheckbox.checked };
    },
  };
}

function matchingEditor(question) {
  const leftItems = (question.items ?? []).filter((i) => i.side === "LEFT");
  const rightItems = (question.items ?? []).filter((i) => i.side === "RIGHT");
  const pairedRightId = new Map((question.answer_key?.pairs ?? []).map(([l, r]) => [l, r]));

  const leftRows = el("div", { class: "stack--sm" });
  const rightRows = el("div", { class: "stack--sm" });
  const pairSelects = [];

  function rightLabels() {
    return [...rightRows.children].map((row) =>
      row.querySelector('input[type="text"]').value || "(untitled)");
  }

  function refreshPairSelects() {
    const labels = rightLabels();
    for (const select of pairSelects) {
      const current = select.value;
      select.replaceChildren(...labels.map((label, i) =>
        el("option", { value: String(i) }, `Pairs with: ${label}`)));
      if (current !== "" && Number(current) < labels.length) select.value = current;
    }
  }

  const addRightRow = (label = "") => {
    const input = el("input", {
      class: "control grow", type: "text", value: label, placeholder: "Right-hand item",
    });
    input.addEventListener("input", refreshPairSelects);
    const row = el("div", { class: "row" }, [
      input,
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove",
        onClick: () => { row.remove(); refreshPairSelects(); },
      }),
    ]);
    rightRows.append(row);
    refreshPairSelects();
  };

  const addLeftRow = (label = "", pairedIndex = null) => {
    const pairSelect = el("select", { class: "control", style: { width: "auto" } });
    pairSelects.push(pairSelect);
    const row = el("div", { class: "row" }, [
      el("input", {
        class: "control grow", type: "text", value: label, placeholder: "Left-hand item",
      }),
      pairSelect,
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove",
        onClick: () => { row.remove(); pairSelects.splice(pairSelects.indexOf(pairSelect), 1); },
      }),
    ]);
    leftRows.append(row);
    refreshPairSelects();
    if (pairedIndex !== null && pairedIndex >= 0) pairSelect.value = String(pairedIndex);
  };

  // Right rows first — the left rows' pairing selects read from them.
  if (rightItems.length) rightItems.forEach((item) => addRightRow(item.label));
  else { addRightRow(); addRightRow(); }

  if (leftItems.length) {
    leftItems.forEach((item) => {
      const pairedId = pairedRightId.get(item.id);
      addLeftRow(item.label, rightItems.findIndex((r) => r.id === pairedId));
    });
  } else {
    addLeftRow();
    addLeftRow();
  }

  const node = el("div", { class: "grid grid--halves" }, [
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Left-hand items"),
      leftRows,
      el("div", { class: "row mt-2" }, [
        button([icon("plus", 14), "Add item"], { variant: "ghost", size: "sm", onClick: () => addLeftRow() }),
      ]),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Right-hand items"),
      rightRows,
      el("div", { class: "row mt-2" }, [
        button([icon("plus", 14), "Add item"], { variant: "ghost", size: "sm", onClick: () => addRightRow() }),
      ]),
    ]),
  ]);

  return {
    node,
    collect() {
      const left = [...leftRows.children].map((row) => row.querySelector('input[type="text"]').value.trim());
      const right = [...rightRows.children].map((row) => row.querySelector('input[type="text"]').value.trim());
      const selects = [...leftRows.children].map((row) => row.querySelector("select"));

      if (left.some((t) => !t) || right.some((t) => !t)) {
        return { ok: false, error: "Give every item a label." };
      }
      if (left.length < 2 || right.length < 2) {
        return { ok: false, error: "Add at least two items on each side." };
      }
      const rightIndexes = selects.map((select) => Number(select.value));
      if (rightIndexes.some((i) => Number.isNaN(i))) {
        return { ok: false, error: "Pair every left-hand item with a right-hand item." };
      }
      return {
        ok: true, type: "MATCHING", left, right,
        pairs: rightIndexes.map((ri, li) => [li, ri]),
      };
    },
  };
}

function orderingEditor(question) {
  const labelById = new Map((question.items ?? []).map((i) => [i.id, i.label]));
  const order = question.answer_key?.order ?? [];
  const initial = order.length
    ? order.map((id) => labelById.get(id)).filter((label) => label !== undefined)
    : (question.items ?? []).map((i) => i.label);

  const rows = el("div", { class: "stack--sm" });

  const addRow = (label = "") => {
    const row = el("div", { class: "row" }, [
      el("input", { class: "control grow", type: "text", value: label, placeholder: "Step" }),
      button(icon("chevronDown", 14), {
        variant: "ghost", size: "sm", "aria-label": "Move down",
        onClick: () => {
          const next = row.nextElementSibling;
          if (next) rows.insertBefore(next, row);
        },
      }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove", onClick: () => row.remove(),
      }),
    ]);
    rows.append(row);
  };

  if (initial.length) initial.forEach((label) => addRow(label));
  else { addRow(); addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Steps, in the correct order"),
    el("p", { class: "field__hint" },
      "Top to bottom is the correct sequence. Learners see them shuffled and reorder to match."),
    rows,
    el("div", { class: "row mt-2" }, [
      button([icon("plus", 14), "Add step"], { variant: "ghost", size: "sm", onClick: () => addRow() }),
    ]),
  ]);

  return {
    node,
    collect() {
      const items = [...rows.children]
        .map((row) => row.querySelector('input[type="text"]').value.trim())
        .filter(Boolean);
      if (items.length < 2) return { ok: false, error: "Add at least two steps." };
      return { ok: true, type: "ORDERING", items };
    },
  };
}

function buildTypeEditor(type, question) {
  if (type === "SHORT_TEXT") return shortTextEditor(question);
  if (type === "MATCHING") return matchingEditor(question);
  if (type === "ORDERING") return orderingEditor(question);
  return multipleChoiceEditor(question);
}

/**
 * Persists whatever a type editor's collect() returned. Always clears every
 * type's tables first — replace-wholesale, the same approach this page
 * already used for `choices` alone, just extended to cover the new tables so
 * switching a question's type never leaves stale cross-type rows behind.
 *
 * MATCHING/ORDERING items get client-generated ids so the answer key can
 * reference them directly, rather than depending on the order Supabase
 * happens to return freshly-inserted rows in.
 */
async function saveTypeData(questionId, data) {
  await sb.from("choices").delete().eq("question_id", questionId);
  await sb.from("question_items").delete().eq("question_id", questionId);
  await sb.from("question_answer_keys").delete().eq("question_id", questionId);

  if (data.type === "MULTIPLE_CHOICE") {
    await sb.from("choices").insert(data.choices.map((choice, i) => ({
      question_id: questionId, text: choice.text, is_correct: choice.isCorrect, position: i + 1,
    })));
  } else if (data.type === "SHORT_TEXT") {
    await sb.from("question_answer_keys").insert({
      question_id: questionId,
      key: { accepted: data.accepted, case_sensitive: data.caseSensitive },
    });
  } else if (data.type === "MATCHING") {
    const leftIds = data.left.map(() => crypto.randomUUID());
    const rightIds = data.right.map(() => crypto.randomUUID());
    await sb.from("question_items").insert([
      ...data.left.map((label, i) => ({ id: leftIds[i], question_id: questionId, side: "LEFT", label })),
      ...data.right.map((label, i) => ({ id: rightIds[i], question_id: questionId, side: "RIGHT", label })),
    ]);
    await sb.from("question_answer_keys").insert({
      question_id: questionId,
      key: { pairs: data.pairs.map(([li, ri]) => [leftIds[li], rightIds[ri]]) },
    });
  } else if (data.type === "ORDERING") {
    const ids = data.items.map(() => crypto.randomUUID());
    await sb.from("question_items").insert(
      data.items.map((label, i) => ({ id: ids[i], question_id: questionId, label })));
    await sb.from("question_answer_keys").insert({ question_id: questionId, key: { order: ids } });
  }
}

async function render(admin) {
  const programId = param("id");
  const courseId = param("courseId");

  if (!programId || !courseId) {
    location.replace("/admin/programs.html");
    return;
  }

  const course = await sb.from("courses")
    .select("id, title, program_id, quizzes ( id )")
    .eq("id", courseId)
    .maybeSingle()
    .then(unwrap);

  if (!course) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Course not found",
      action: buttonLink("Back to the programme", `/admin/program.html?id=${programId}`),
    }));
    return;
  }

  setTitle(`Assessment — ${course.title}`);

  const existing = Array.isArray(course.quizzes) ? course.quizzes[0] : course.quizzes;

  const back = el("a", {
    class: "link t-sm row",
    href: `/admin/program.html?id=${programId}`,
  }, [icon("arrowLeft", 14), course.title]);

  /* --- No assessment yet -------------------------------------------------- */

  if (!existing) {
    mount("#app",
      el("div", { class: "page-head" }, el("div", {}, [back, el("h1", { class: "display mt-1" }, "Assessment")])),
      card(emptyState({
        iconName: "graduationCap",
        title: "No assessment on this course yet",
        description:
          "Every course ends in one assessment. Learners must pass it before the course counts as complete.",
        action: button("Create the assessment", {
          onClick: async () => {
            await sb.from("quizzes").insert({ course_id: course.id });
            render(admin);
          },
        }),
      })));
    return;
  }

  // The one legitimate read of every answer key.
  const quiz = await rpc("admin_quiz", { p_quiz_id: existing.id });
  if (!quiz || quiz.ok === false) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "That assessment could not be loaded",
      action: buttonLink("Back to the programme", `/admin/program.html?id=${programId}`),
    }));
    return;
  }

  /* --- Settings ----------------------------------------------------------- */

  const settings = el("form", { class: "row row--wrap", novalidate: true }, [
    el("div", { "data-message": "", style: { width: "100%" } }),
    field({ label: "Title", name: "title", value: quiz.title, required: true }),
    field({
      label: "Pass mark (%)", name: "passMark", type: "number",
      min: 1, max: 100, value: quiz.pass_mark_percent, required: true,
    }),
    field({
      label: "Max attempts", name: "maxAttempts", type: "number",
      min: 1, max: 10, value: quiz.max_attempts, required: true,
    }),
    el("button", { class: "btn btn--secondary", type: "submit" }, "Save"),
  ]);

  settings.addEventListener("submit", async (event) => {
    event.preventDefault();
    setPending(settings, true);
    const { error } = await sb.from("quizzes").update({
      title: settings.elements.title.value.trim(),
      pass_mark_percent: Number(settings.elements.passMark.value),
      max_attempts: Number(settings.elements.maxAttempts.value),
    }).eq("id", quiz.id);
    setPending(settings, false);
    if (error) return setFormMessage(settings, error.message);
    setFormMessage(settings, "Saved.", "success");
  });

  /* --- Question editor ---------------------------------------------------- */

  function questionCard(question, index) {
    const typeSelect = el("select", { class: "control", style: { width: "auto" } }, [
      el("option", { value: "MULTIPLE_CHOICE", selected: question.question_type === "MULTIPLE_CHOICE" }, "Multiple choice"),
      el("option", { value: "SHORT_TEXT", selected: question.question_type === "SHORT_TEXT" }, "Short text"),
      el("option", { value: "MATCHING", selected: question.question_type === "MATCHING" }, "Matching"),
      el("option", { value: "ORDERING", selected: question.question_type === "ORDERING" }, "Ordering"),
    ]);

    const typeFieldsSlot = el("div", { class: "mt-2" });
    let editor = buildTypeEditor(question.question_type, question);
    typeFieldsSlot.replaceChildren(editor.node);

    typeSelect.addEventListener("change", () => {
      editor = buildTypeEditor(typeSelect.value, question);
      typeFieldsSlot.replaceChildren(editor.node);
    });

    const form = el("form", { class: "stack", novalidate: true }, [
      el("div", { "data-message": "" }),
      field({
        label: "Question", name: "prompt", as: "textarea", rows: 2,
        required: true, value: question.prompt,
      }),
      el("div", { class: "field" }, [
        el("label", { class: "field__label" }, "Question type"),
        typeSelect,
      ]),
      typeFieldsSlot,
      field({
        label: "Explanation", name: "explanation", as: "textarea", rows: 2,
        value: question.explanation ?? "",
        hint: "Optional. Shown on the results screen after submission.",
      }),
      el("div", { class: "row" }, [
        el("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Save question"),
        button([icon("trash", 14), "Delete"], {
          variant: "ghost", size: "sm", className: "push",
          onClick: async () => {
            if (!confirm("Delete this question?")) return;
            await sb.from("questions").delete().eq("id", question.id);
            render(admin);
          },
        }),
      ]),
    ]);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setFormMessage(form, null);

      const result = editor.collect();
      if (!result.ok) return setFormMessage(form, result.error);

      setPending(form, true);

      await sb.from("questions").update({
        prompt: form.elements.prompt.value.trim(),
        explanation: form.elements.explanation.value.trim() || null,
        question_type: typeSelect.value,
      }).eq("id", question.id);

      await saveTypeData(question.id, result);

      setPending(form, false);
      render(admin);
    });

    return el("li", {},
      card([
        cardHeader(`Question ${index + 1}`, { action: badge(TYPE_LABEL[question.question_type]) }),
        cardBody(form),
      ]));
  }

  /* --- Page --------------------------------------------------------------- */

  const addQuestion = button([icon("plus", 16), "Add a question"], {
    onClick: async () => {
      const { data } = await sb.from("questions").insert({
        quiz_id: quiz.id,
        prompt: "New question",
        position: quiz.questions.length + 1,
      }).select("id").maybeSingle();
      if (data) {
        await sb.from("choices").insert([
          { question_id: data.id, text: "", is_correct: true, position: 1 },
          { question_id: data.id, text: "", is_correct: false, position: 2 },
        ]);
      }
      render(admin);
    },
  });

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        back,
        el("h1", { class: "display mt-1" }, quiz.title),
        el("p", {},
          `${quiz.questions.length} questions · ${quiz.pass_mark_percent}% to pass · ` +
          `${quiz.max_attempts} attempts`),
      ]),
      button([icon("trash", 14), "Delete assessment"], {
        variant: "ghost",
        onClick: async () => {
          if (!confirm(
            "Delete this assessment and all its questions? Learners' past attempts go with it."
          )) return;
          await sb.from("quizzes").delete().eq("id", quiz.id);
          location.href = `/admin/program.html?id=${programId}`;
        },
      }),
    ]),

    card([cardHeader("Settings"), cardBody(settings)], { className: "mt-4" }),

    quiz.questions.length
      ? el("ol", { class: "stack mt-6" }, quiz.questions.map(questionCard))
      : card(emptyState({
          iconName: "graduationCap",
          title: "No questions yet",
          description: "Add the first one below.",
        }), { className: "mt-6" }),

    el("div", { class: "row mt-4" }, addQuestion));
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
