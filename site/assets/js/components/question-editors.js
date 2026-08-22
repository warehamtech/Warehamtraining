import { el } from "../dom.js";
import { icon } from "../icons.js";
import { button } from "../ui.js";
import { sb } from "../supabase.js";

/**
 * Authoring UI for the four question types the quiz engine marks
 * (supabase/migrations/0008_quiz_engine_v2.sql).
 *
 * Each editor returns `{ node, collect() }`. `collect()` validates and hands
 * back a normalised shape, or `{ ok: false, error }` — no editor writes to the
 * database itself, so the caller owns the whole save in one place and can put
 * a failure in its own message slot.
 */

export const TYPE_CONFIG = {
  MULTIPLE_CHOICE: {
    label: "Multiple choice",
    hint: "One correct answer from a list",
    icon: "helpCircle",
  },
  SHORT_TEXT: {
    label: "Short text answer",
    hint: "Learners type a keyword or phrase",
    icon: "fileText",
  },
  MATCHING: {
    label: "Matching pairs",
    hint: "Connect items on the left with items on the right",
    icon: "shuffle",
  },
  ORDERING: {
    label: "Sequence ordering",
    hint: "Learners arrange steps into the correct order",
    icon: "listOrdered",
  },
};

/* --- Multiple choice ------------------------------------------------------ */

function multipleChoiceEditor(question) {
  const rows = el("div", { class: "stack--sm" });
  const groupName = `correct-${question.id || "new"}`;

  const addRow = (choice = null) => {
    const row = el("div", {
      class: "row p-2",
      style: {
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)",
        background: "var(--white)",
      },
    }, [
      el("input", {
        type: "radio",
        name: groupName,
        checked: choice?.is_correct ?? false,
        style: { width: "1.25rem", height: "1.25rem", accentColor: "var(--success)" },
      }),
      el("input", {
        class: "control grow", type: "text",
        value: choice?.text ?? "",
        placeholder: "Choice text",
      }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove choice",
        onClick: () => {
          if (rows.children.length > 2) row.remove();
          else alert("Multiple choice questions need at least two choices.");
        },
      }),
    ]);
    rows.append(row);
  };

  for (const choice of question.choices ?? []) addRow(choice);
  if (!(question.choices ?? []).length) { addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Answer choices"),
    el("p", { class: "field__hint mb-2" }, "Select the radio button beside the correct answer."),
    rows,
    el("div", { class: "row mt-3" }, button([icon("plus", 14), "Add option"], {
      variant: "secondary", size: "sm", onClick: () => addRow(),
    })),
  ]);

  return {
    node,
    collect() {
      const values = [...rows.children].map((row) => ({
        text: row.querySelector('input[type="text"]').value.trim(),
        isCorrect: row.querySelector('input[type="radio"]').checked,
      })).filter((choice) => choice.text);

      if (values.length < 2) return { ok: false, error: "Give the question at least two answer choices." };
      if (!values.some((c) => c.isCorrect)) return { ok: false, error: "Mark one option as the correct answer." };
      return { ok: true, type: "MULTIPLE_CHOICE", choices: values };
    },
  };
}

/* --- Short text ----------------------------------------------------------- */

function shortTextEditor(question) {
  const rows = el("div", { class: "stack--sm" });

  const addRow = (text = "") => {
    const row = el("div", { class: "row" }, [
      el("input", { class: "control grow", type: "text", value: text, placeholder: "Accepted answer" }),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm", "aria-label": "Remove",
        onClick: () => { if (rows.children.length > 1) row.remove(); },
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
    el("label", { class: "field__label" }, "Accepted answers"),
    el("p", { class: "field__hint mb-2" }, "A learner's answer is correct if it matches any of these."),
    rows,
    el("div", { class: "row mt-3" }, button([icon("plus", 14), "Add accepted answer"], {
      variant: "secondary", size: "sm", onClick: () => addRow(),
    })),
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

/* --- Matching ------------------------------------------------------------- */

function matchingEditor(question) {
  const leftItems = (question.items ?? []).filter((i) => i.side === "LEFT");
  const rightItems = (question.items ?? []).filter((i) => i.side === "RIGHT");
  const pairedRightId = new Map((question.answer_key?.pairs ?? []).map(([l, r]) => [l, r]));

  const leftRows = el("div", { class: "stack--sm" });
  const rightRows = el("div", { class: "stack--sm" });
  const pairSelects = [];

  const rightLabels = () =>
    [...rightRows.children].map((row) => row.querySelector('input[type="text"]').value || "(untitled)");

  // Every left row's dropdown lists the right-hand items by their CURRENT
  // labels, so renaming a right item is reflected everywhere it is referenced
  // rather than leaving stale text behind in the pair pickers.
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
      class: "control grow", type: "text", value: label, placeholder: "Definition / match",
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
      el("input", { class: "control grow", type: "text", value: label, placeholder: "Term" }),
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
      el("label", { class: "field__label" }, "Left terms"),
      leftRows,
      el("div", { class: "row mt-2" }, button([icon("plus", 14), "Add left item"], {
        variant: "secondary", size: "sm", onClick: () => addLeftRow(),
      })),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Right definitions"),
      rightRows,
      el("div", { class: "row mt-2" }, button([icon("plus", 14), "Add right item"], {
        variant: "secondary", size: "sm", onClick: () => addRightRow(),
      })),
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
      return { ok: true, type: "MATCHING", left, right, pairs: rightIndexes.map((ri, li) => [li, ri]) };
    },
  };
}

/* --- Ordering ------------------------------------------------------------- */

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
        onClick: () => { if (rows.children.length > 2) row.remove(); },
      }),
    ]);
    rows.append(row);
  };

  if (initial.length) initial.forEach((label) => addRow(label));
  else { addRow(); addRow(); addRow(); }

  const node = el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Steps in the correct order"),
    el("p", { class: "field__hint mb-2" }, "Top to bottom is correct. The player shuffles them for learners."),
    rows,
    el("div", { class: "row mt-3" }, button([icon("plus", 14), "Add step"], {
      variant: "secondary", size: "sm", onClick: () => addRow(),
    })),
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

export function buildTypeEditor(type, question) {
  if (type === "SHORT_TEXT") return shortTextEditor(question);
  if (type === "MATCHING") return matchingEditor(question);
  if (type === "ORDERING") return orderingEditor(question);
  return multipleChoiceEditor(question);
}

/**
 * Persist whatever `collect()` returned.
 *
 * Deliberately destructive: the child rows are deleted and reinserted rather
 * than diffed. Matching and ordering answer keys reference item ids, so a
 * partial update risks a key pointing at an item that no longer exists —
 * whereas rewriting the set keeps items and key consistent by construction.
 * The cost is that item ids are not stable across saves, which nothing depends
 * on (attempts store the graded outcome, not references to these rows).
 */
export async function saveTypeData(questionId, data) {
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
