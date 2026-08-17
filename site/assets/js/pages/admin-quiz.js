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
 *
 * Note the read path: `choices.is_correct` is granted to no client role, so
 * this page CANNOT select it from the table. It calls admin_quiz(), a
 * SECURITY DEFINER function that checks is_wha_admin() and returns the tree
 * with the answer key. Writes go to the table normally — the write policy
 * already restricts them to WHA staff.
 */

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

  // The one legitimate read of the answer key.
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
    const choiceRows = el("div", { class: "stack--sm" });

    const addChoiceRow = (choice = null) => {
      const id = `correct-${question.id}`;
      const row = el("div", { class: "row" }, [
        el("input", {
          type: "radio", name: id, "aria-label": "Correct answer",
          checked: choice?.is_correct ?? false,
        }),
        el("input", {
          class: "control grow", type: "text", name: "choiceText",
          value: choice?.text ?? "", placeholder: "Answer option",
        }),
        button(icon("trash", 14), {
          variant: "ghost", size: "sm", "aria-label": "Remove option",
          onClick: () => row.remove(),
        }),
      ]);
      row.dataset.choiceId = choice?.id ?? "";
      choiceRows.append(row);
      return row;
    };

    for (const choice of question.choices) addChoiceRow(choice);
    if (!question.choices.length) { addChoiceRow(); addChoiceRow(); }

    const form = el("form", { class: "stack", novalidate: true }, [
      el("div", { "data-message": "" }),
      field({
        label: "Question", name: "prompt", as: "textarea", rows: 2,
        required: true, value: question.prompt,
      }),
      el("div", { class: "field" }, [
        el("label", { class: "field__label" }, "Answer options"),
        el("p", { class: "field__hint" },
          "Select the radio button beside the correct answer. Learners never receive this flag."),
        choiceRows,
        el("div", { class: "row mt-2" }, [
          button([icon("plus", 14), "Add option"], {
            variant: "ghost", size: "sm", onClick: () => addChoiceRow(),
          }),
        ]),
      ]),
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

      const rows = [...choiceRows.children];
      const values = rows.map((row) => ({
        id: row.dataset.choiceId || null,
        text: row.querySelector('input[type="text"]').value.trim(),
        isCorrect: row.querySelector('input[type="radio"]').checked,
      })).filter((choice) => choice.text);

      if (values.length < 2) {
        return setFormMessage(form, "Give the question at least two answer options.");
      }
      if (!values.some((choice) => choice.isCorrect)) {
        return setFormMessage(form, "Mark one option as the correct answer.");
      }

      setPending(form, true);

      await sb.from("questions").update({
        prompt: form.elements.prompt.value.trim(),
        explanation: form.elements.explanation.value.trim() || null,
      }).eq("id", question.id);

      // Replace the option set wholesale: simpler than diffing, and an
      // assessment's options are a small list.
      await sb.from("choices").delete().eq("question_id", question.id);
      await sb.from("choices").insert(values.map((choice, i) => ({
        question_id: question.id,
        text: choice.text,
        is_correct: choice.isCorrect,
        position: i + 1,
      })));

      setPending(form, false);
      render(admin);
    });

    return el("li", {},
      card([
        cardHeader(`Question ${index + 1}`, {
          action: badge(`${question.choices.length} options`),
        }),
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
