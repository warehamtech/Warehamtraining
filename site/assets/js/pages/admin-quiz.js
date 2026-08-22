import { el, mount, param, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, card, emptyState, field,
  setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";
import { openLearnerPreview } from "../components/learner-preview.js";

/**
 * Assessment & Quiz Studio: interactive question stepper, visual type selector,
 * live question test simulator, and instant learner assessment preview.
 */

const TYPE_CONFIG = {
  MULTIPLE_CHOICE: {
    label: "Multiple Choice",
    hint: "Standard multiple-choice with radio selection",
    icon: "helpCircle",
  },
  SHORT_TEXT: {
    label: "Short Text Answer",
    hint: "Learners type a keyword or phrase",
    icon: "fileText",
  },
  MATCHING: {
    label: "Matching Pairs",
    hint: "Connect items on the left with items on the right",
    icon: "shuffle",
  },
  ORDERING: {
    label: "Sequence Ordering",
    hint: "Learners arrange steps in the correct chronological order",
    icon: "listOrdered",
  },
};

/* --- Type Editors --------------------------------------------------------- */

function multipleChoiceEditor(question) {
  const rows = el("div", { class: "stack--sm" });
  const groupName = `correct-${question.id || "new"}`;

  const addRow = (choice = null) => {
    const isChecked = choice?.is_correct ?? false;
    const radio = el("input", {
      type: "radio",
      name: groupName,
      checked: isChecked,
      style: { width: "1.25rem", height: "1.25rem", accentColor: "var(--success)" },
    });

    const textInput = el("input", {
      class: "control grow",
      type: "text",
      value: choice?.text ?? "",
      placeholder: "Choice text (e.g. ISO 9001 Clause 4.1)",
    });

    const row = el("div", {
      class: "row p-2",
      style: {
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)",
        background: "var(--white)",
        transition: "border-color 150ms",
      },
    }, [
      radio,
      textInput,
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove choice",
        onClick: () => {
          if (rows.children.length > 2) row.remove();
          else alert("Multiple choice questions require at least 2 choices.");
        },
      }),
    ]);

    rows.append(row);
  };

  for (const choice of question.choices ?? []) addRow(choice);
  if (!(question.choices ?? []).length) { addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Answer Choices"),
    el("p", { class: "field__hint mb-2" }, "Select the radio button beside the correct answer."),
    rows,
    el("div", { class: "row mt-3" }, [
      button([icon("plus", 14), "Add Option"], {
        variant: "secondary", size: "sm", onClick: () => addRow(),
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
        return { ok: false, error: "Give the question at least two answer choices." };
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
      el("input", { class: "control grow", type: "text", value: text, placeholder: "Accepted exact phrase" }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove",
        onClick: () => {
          if (rows.children.length > 1) row.remove();
        },
      }),
    ]);
    rows.append(row);
  };

  const accepted = question.answer_key?.accepted ?? [];
  for (const text of accepted) addRow(text);
  if (!accepted.length) addRow();

  const caseCheckbox = el("input", {
    type: "checkbox",
    checked: question.answer_key?.case_sensitive ?? false,
  });

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Accepted Correct Answers"),
    el("p", { class: "field__hint mb-2" }, "Learner input will match if it equals any of these values."),
    rows,
    el("div", { class: "row mt-3" }, [
      button([icon("plus", 14), "Add Accepted Keyword / Synonym"], {
        variant: "secondary", size: "sm", onClick: () => addRow(),
      }),
    ]),
    el("label", { class: "row t-sm mt-3" }, [caseCheckbox, "Require exact case matching"]),
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
      class: "control grow", type: "text", value: label, placeholder: "Right item (definition/match)",
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
        class: "control grow", type: "text", value: label, placeholder: "Left item (term)",
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
      el("label", { class: "field__label" }, "Left Terms"),
      leftRows,
      el("div", { class: "row mt-2" }, [
        button([icon("plus", 14), "Add Left Item"], { variant: "secondary", size: "sm", onClick: () => addLeftRow() }),
      ]),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Right Definitions / Targets"),
      rightRows,
      el("div", { class: "row mt-2" }, [
        button([icon("plus", 14), "Add Right Item"], { variant: "secondary", size: "sm", onClick: () => addRightRow() }),
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
      el("span", { class: "badge badge--brand t-xs" }, "Step"),
      el("input", { class: "control grow", type: "text", value: label, placeholder: "Describe this step" }),
      button(icon("arrowUp", 14), {
        variant: "ghost", size: "sm", "aria-label": "Move up",
        onClick: () => {
          const prev = row.previousElementSibling;
          if (prev) rows.insertBefore(row, prev);
        },
      }),
      button(icon("arrowDown", 14), {
        variant: "ghost", size: "sm", "aria-label": "Move down",
        onClick: () => {
          const next = row.nextElementSibling;
          if (next) rows.insertBefore(next, row);
        },
      }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove",
        onClick: () => {
          if (rows.children.length > 2) row.remove();
        },
      }),
    ]);
    rows.append(row);
  };

  if (initial.length) initial.forEach((label) => addRow(label));
  else { addRow(); addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Steps in Correct Chronological Order"),
    el("p", { class: "field__hint mb-2" }, "Top to bottom is the correct sequence. The player will shuffle them for learners."),
    rows,
    el("div", { class: "row mt-3" }, [
      button([icon("plus", 14), "Add Sequence Step"], { variant: "secondary", size: "sm", onClick: () => addRow() }),
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

  setTitle(`Assessment Studio — ${course.title}`);

  const existing = Array.isArray(course.quizzes) ? course.quizzes[0] : course.quizzes;

  if (!existing) {
    mount("#app",
      card(emptyState({
        iconName: "graduationCap",
        title: "No assessment on this course yet",
        description: "Every course ends in one assessment. Learners must pass it before the course counts as complete.",
        action: button("Create Assessment", {
          onClick: async () => {
            await sb.from("quizzes").insert({ course_id: course.id });
            render(admin);
          },
        }),
      })));
    return;
  }

  const quiz = await rpc("admin_quiz", { p_quiz_id: existing.id });
  if (!quiz || quiz.ok === false) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "Assessment could not be loaded",
      action: buttonLink("Back to the programme", `/admin/program.html?id=${programId}`),
    }));
    return;
  }

  const questions = [...(quiz.questions ?? [])].sort((a, b) => a.position - b.position);
  let activeQuestionIndex = 0;

  // ---------------------------------------------------------------------------
  // Studio Top Bar & Learner Preview
  // ---------------------------------------------------------------------------

  const previewBtn = el("button", {
    class: "btn btn--accent btn--sm",
    type: "button",
  }, [icon("eye", 16), "Review Assessment as Learner"]);

  previewBtn.addEventListener("click", () => {
    openLearnerPreview({
      title: `${course.title} · Assessment`,
      type: "quiz",
      data: {
        title: quiz.title || "Course Assessment",
        passMarkPercent: quiz.pass_mark_percent,
        questions,
      },
    });
  });

  const headerBanner = el("div", { class: "studio-banner mb-6" }, [
    el("div", { class: "stack stack--sm" }, [
      el("div", { class: "row row--wrap" }, [
        el("a", { class: "link t-sm subtle", href: `/admin/program.html?id=${programId}` }, `← ${course.title}`),
        el("span", { class: "subtle t-xs" }, "/"),
        el("span", { class: "badge badge--brand" }, "Assessment Studio"),
      ]),
      el("h1", { class: "display", style: { fontSize: "1.75rem" } }, quiz.title || "Course Assessment"),
      el("p", { class: "subtle t-sm" }, [
        `${questions.length} questions · Pass Mark: ${quiz.pass_mark_percent}% · Max attempts: ${quiz.max_attempts}`,
      ]),
    ]),
    el("div", { class: "row" }, [
      previewBtn,
      buttonLink("Back to Course", `/admin/program.html?id=${programId}`, { variant: "secondary", size: "sm" }),
      button([icon("trash", 14), "Delete assessment"], {
        variant: "ghost", size: "sm",
        onClick: async () => {
          if (!confirm(
            "Delete this assessment and all its questions? Learners' past attempts go with it."
          )) return;
          await sb.from("quizzes").delete().eq("id", quiz.id);
          location.href = `/admin/program.html?id=${programId}`;
        },
      }),
    ]),
  ]);

  // ---------------------------------------------------------------------------
  // Assessment Global Settings Form
  // ---------------------------------------------------------------------------

  const settingsForm = el("form", { class: "card studio-card stack p-6 mb-6", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Assessment Scoring & Rules"),
    el("div", { class: "grid grid--thirds" }, [
      field({ label: "Assessment Title", name: "title", value: quiz.title, required: true }),
      field({
        label: "Pass Mark (%)", name: "passMark", type: "number",
        min: 1, max: 100, value: quiz.pass_mark_percent, required: true,
      }),
      field({
        label: "Max Allowed Attempts", name: "maxAttempts", type: "number",
        min: 1, max: 10, value: quiz.max_attempts, required: true,
      }),
    ]),
    el("button", { class: "btn btn--primary push", type: "submit" }, "Save Rules"),
  ]);

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextValues = {
      title: settingsForm.elements.title.value.trim(),
      pass_mark_percent: Number(settingsForm.elements.passMark.value),
      max_attempts: Number(settingsForm.elements.maxAttempts.value),
    };
    setPending(settingsForm, true);
    const { error } = await sb.from("quizzes").update(nextValues).eq("id", quiz.id);
    setPending(settingsForm, false);
    if (error) return setFormMessage(settingsForm, error.message);
    Object.assign(quiz, nextValues);
    setFormMessage(settingsForm, "Assessment settings saved.", "success");
  });

  // ---------------------------------------------------------------------------
  // Question Stepper Bar & Question Workspace
  // ---------------------------------------------------------------------------

  const questionHost = el("div", { class: "stack" });
  const stepperBar = el("div", { class: "question-stepper mb-6" });

  const renderStepper = () => {
    stepperBar.replaceChildren(
      ...questions.map((q, idx) => {
        const isActive = idx === activeQuestionIndex;
        const btn = el("button", {
          type: "button",
          class: isActive ? "question-step-btn is-active" : "question-step-btn",
          onClick: () => {
            activeQuestionIndex = idx;
            renderStepper();
            renderActiveQuestion();
          },
        }, [
          el("span", { class: "dot-status" }),
          `Q${idx + 1}`,
        ]);
        return btn;
      }),
      el("button", {
        type: "button",
        class: "question-step-btn",
        style: { borderStyle: "dashed" },
        onClick: async () => {
          const { data } = await sb.from("questions").insert({
            quiz_id: quiz.id,
            prompt: "New question prompt",
            question_type: "MULTIPLE_CHOICE",
            position: questions.length + 1,
          }).select("id").maybeSingle();
          if (data) {
            render(admin);
          }
        },
      }, [icon("plus", 14), "Add Question"]),
    );
  };

  const renderActiveQuestion = () => {
    if (questions.length === 0) {
      questionHost.replaceChildren(
        card(emptyState({
          iconName: "helpCircle",
          title: "No questions in this assessment",
          description: "Add your first question to test learner mastery.",
          action: button("Add Question", {
            onClick: async () => {
              await sb.from("questions").insert({
                quiz_id: quiz.id,
                prompt: "First question prompt",
                question_type: "MULTIPLE_CHOICE",
                position: 1,
              });
              render(admin);
            },
          }),
        })),
      );
      return;
    }

    const question = questions[activeQuestionIndex];
    let selectedType = question.question_type ?? "MULTIPLE_CHOICE";
    let editor = buildTypeEditor(selectedType, question);

    // Type picker cards
    const typePicker = el("div", { class: "question-type-picker" },
      Object.entries(TYPE_CONFIG).map(([typeKey, cfg]) => {
        const isSelected = selectedType === typeKey;
        const typeCard = el("button", {
          type: "button",
          class: isSelected ? "question-type-card is-active" : "question-type-card",
          onClick: () => {
            selectedType = typeKey;
            [...typePicker.children].forEach((c) => c.classList.remove("is-active"));
            typeCard.classList.add("is-active");
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
        return typeCard;
      }),
    );

    const editorSlot = el("div", {}, editor.node);

    const form = el("form", { class: "card studio-card stack p-6", novalidate: true }, [
      el("div", { "data-message": "" }),
      el("div", { class: "row row--between mb-4 pb-3", style: { borderBottom: "1px solid var(--line)" } }, [
        el("div", { class: "row" }, [
          el("span", { class: "badge badge--brand font-semibold" }, `Question ${activeQuestionIndex + 1} of ${questions.length}`),
          el("span", { class: "subtle t-xs" }, TYPE_CONFIG[selectedType]?.label),
        ]),
        el("div", { class: "row" }, [
          button(icon("trash", 14), {
            variant: "ghost", size: "sm", "aria-label": "Delete question",
            onClick: async () => {
              if (confirm(`Delete Question ${activeQuestionIndex + 1}?`)) {
                await sb.from("questions").delete().eq("id", question.id);
                render(admin);
              }
            },
          }),
        ]),
      ]),
      el("label", { class: "field__label" }, "Select Question Type"),
      typePicker,
      field({
        label: "Question Prompt / Stem", name: "prompt", as: "textarea", rows: 3,
        required: true, value: question.prompt,
        placeholder: "e.g. Which of the following is a mandatory requirement under Clause 5.2?",
      }),
      editorSlot,
      field({
        label: "Feedback & Explanation (shown after assessment submission)", name: "explanation",
        as: "textarea", rows: 2, value: question.explanation ?? "",
        placeholder: "e.g. Clause 5.2 explicitly requires top management to establish a quality policy.",
      }),
      el("div", { class: "row row--between pt-4", style: { borderTop: "1px solid var(--line)" } }, [
        el("button", { class: "btn btn--primary", type: "submit" }, "Save Question"),
        el("div", { class: "row" }, [
          button(icon("arrowLeft", 14), {
            variant: "secondary", size: "sm", disabled: activeQuestionIndex === 0,
            onClick: () => { activeQuestionIndex--; renderStepper(); renderActiveQuestion(); },
          }),
          button(icon("arrowRight", 14), {
            variant: "secondary", size: "sm", disabled: activeQuestionIndex === questions.length - 1,
            onClick: () => { activeQuestionIndex++; renderStepper(); renderActiveQuestion(); },
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
      setFormMessage(form, "Question saved successfully.", "success");
    });

    questionHost.replaceChildren(form);
  };

  renderStepper();
  renderActiveQuestion();

  mount("#app", el("div", { class: "shell section--tight" }, [
    headerBanner,
    settingsForm,
    el("h2", { class: "display mb-3", style: { fontSize: "1.25rem" } }, "Question Builder"),
    stepperBar,
    questionHost,
  ]));
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}


