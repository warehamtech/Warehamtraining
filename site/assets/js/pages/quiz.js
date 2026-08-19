import { el, mount, param, page, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, emptyState, formError, progressBar,
} from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";
import { getEnrollmentProgress } from "../progress.js";

/**
 * The assessment. Port of src/components/learn/quiz-runner.tsx and the page
 * that hosts it. Extended for the question types added in
 * 0008_quiz_engine_v2.sql.
 *
 * One question per screen, review before submit. Marking happens entirely in
 * submit_quiz_attempt(); no answer key for any question type is granted to
 * any client role, so the answers are simply not in any payload this page
 * receives — the only way to find them is to answer.
 *
 * `answers[question.id]` is kept in exactly the shape submit_quiz_attempt()
 * expects, so the submission payload is just `answers` — no reshaping:
 *   MULTIPLE_CHOICE → { choice_id }
 *   SHORT_TEXT      → { text }
 *   MATCHING        → { pairs: [[leftItemId, rightItemId], …] }
 *   ORDERING        → { order: [itemId, …] }
 */

function shell(children) {
  mount("#app", el("div", { class: "quiz" }, children));
}

/** In-place Fisher–Yates. Used so the server's row order (and, for ordering
 *  questions, anything resembling the correct sequence) is never visible in
 *  how items are laid out on screen. */
function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isAnswerComplete(question, value) {
  if (!value) return false;
  switch (question.questionType) {
    case "SHORT_TEXT":
      return !!value.text?.trim();
    case "MATCHING":
      return question.leftItems.length > 0 && (value.pairs?.length ?? 0) === question.leftItems.length;
    case "ORDERING":
      return question.items.length > 0 && (value.order?.length ?? 0) === question.items.length;
    default:
      return !!value.choice_id;
  }
}

page(async () => {
  const user = await requireUser();
  appChrome(user);

  const enrollmentId = param("e");
  const quizId = param("q");
  const programHref = `/learn/index.html?e=${enrollmentId}`;

  if (!enrollmentId || !quizId) {
    location.replace("/dashboard.html");
    return;
  }

  const [progress, quiz] = await Promise.all([
    getEnrollmentProgress(enrollmentId),
    sb.from("quizzes")
      .select(`
        id, title, pass_mark_percent, max_attempts,
        course:courses ( id, title ),
        questions (
          id, prompt, position, question_type,
          choices ( id, text, position ),
          question_items ( id, side, label )
        )
      `)
      .eq("id", quizId)
      .maybeSingle()
      .then(unwrap),
  ]);

  if (!progress || !quiz) {
    shell(emptyState({
      iconName: "lock",
      title: "That assessment isn't available to you",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  setTitle(quiz.title);

  const courseState = progress.courses.find((c) => c.id === quiz.course.id);
  const state = courseState?.quiz;

  // The same gates submit_quiz_attempt() enforces. Checking here is about not
  // wasting the learner's time, not about security.
  if (!state?.unlocked) {
    shell(card(cardBody(emptyState({
      iconName: "lock",
      title: "Finish the course first",
      description: `Complete every lesson in ${quiz.course.title} to unlock this assessment.`,
      action: buttonLink("Back to the programme", programHref),
    }))));
    return;
  }

  if (state.passed) {
    shell(card(cardBody(emptyState({
      iconName: "award",
      title: "You've already passed this assessment",
      description: `Your best score was ${state.bestScorePercent}%.`,
      action: buttonLink("Back to the programme", programHref),
    }))));
    return;
  }

  if (!state.canAttempt) {
    shell(card(cardBody(emptyState({
      iconName: "alert",
      title: "No attempts remaining",
      description:
        "Contact us on (021) 713-2380 and we'll help you get back on track.",
      action: buttonLink("Back to the programme", programHref),
    }))));
    return;
  }

  const questions = [...(quiz.questions ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((question) => {
      const items = question.question_items ?? [];
      return {
        id: question.id,
        prompt: question.prompt,
        questionType: question.question_type,
        choices: [...(question.choices ?? [])].sort((a, b) => a.position - b.position),
        // Ordering's items; matching's two sides. Shuffled once here so
        // neither layout nor row order ever hints at the answer.
        items: shuffled(items),
        leftItems: shuffled(items.filter((i) => i.side === "LEFT")),
        rightItems: shuffled(items.filter((i) => i.side === "RIGHT")),
      };
    });

  if (!questions.length) {
    shell(card(cardBody(emptyState({
      iconName: "alert",
      title: "This assessment has no questions yet",
      action: buttonLink("Back to the programme", programHref),
    }))));
    return;
  }

  runner({ enrollmentId, quiz, questions, state, programHref });
});

/* --- Matching: click a left item, then a right item, to pair them --------- */

function matchingWidget(question, initial, onChange) {
  let pairs = [...(initial?.pairs ?? [])];
  let selectedLeft = null;

  const leftCol = el("div", { class: "quiz__match-col" });
  const rightCol = el("div", { class: "quiz__match-col" });

  const rightFor = (leftId) => pairs.find(([l]) => l === leftId)?.[1] ?? null;
  const leftFor = (rightId) => pairs.find(([, r]) => r === rightId)?.[0] ?? null;

  function paint() {
    leftCol.replaceChildren(...question.leftItems.map((item) => {
      const paired = rightFor(item.id);
      const classes = ["quiz__match-item"];
      if (paired) classes.push("quiz__match-item--paired");
      if (selectedLeft === item.id) classes.push("quiz__match-item--selected");
      return el("button", {
        type: "button", class: classes.join(" "),
        onClick: () => {
          if (paired) { pairs = pairs.filter(([l]) => l !== item.id); selectedLeft = null; }
          else selectedLeft = selectedLeft === item.id ? null : item.id;
          paint();
        },
      }, item.label);
    }));

    rightCol.replaceChildren(...question.rightItems.map((item) => {
      const paired = leftFor(item.id);
      return el("button", {
        type: "button",
        class: "quiz__match-item" + (paired ? " quiz__match-item--paired" : ""),
        onClick: () => {
          if (paired) {
            pairs = pairs.filter(([, r]) => r !== item.id);
          } else if (selectedLeft) {
            pairs = pairs.filter(([l]) => l !== selectedLeft);
            pairs.push([selectedLeft, item.id]);
            selectedLeft = null;
          }
          paint();
        },
      }, item.label);
    }));

    onChange({ pairs });
  }
  paint();

  return el("div", { class: "quiz__match" }, [leftCol, rightCol]);
}

/* --- Ordering: shuffled list, moved into place with up/down --------------- */

function orderingWidget(question, initial, onChange) {
  let order = initial?.order?.length ? [...initial.order] : question.items.map((i) => i.id);
  const labelById = new Map(question.items.map((i) => [i.id, i.label]));

  const list = el("ol", { class: "quiz__order" });

  function paint() {
    list.replaceChildren(...order.map((id, i) =>
      el("li", { class: "quiz__order-item" }, [
        el("span", { class: "quiz__order-num tabular" }, String(i + 1)),
        el("span", { class: "grow" }, labelById.get(id)),
        button(icon("chevronDown", 14), {
          variant: "ghost", size: "sm", "aria-label": "Move down",
          disabled: i === order.length - 1,
          onClick: () => {
            [order[i], order[i + 1]] = [order[i + 1], order[i]];
            paint();
          },
        }),
      ])));
    onChange({ order });
  }
  paint();

  return list;
}

function runner({ enrollmentId, quiz, questions, state, programHref }) {
  const answers = {};
  let index = 0;
  let reviewing = false;
  let busy = false;
  let error = null;

  const answered = () => questions.filter((q) => isAnswerComplete(q, answers[q.id])).length;
  const allAnswered = () => answered() === questions.length;

  function advance() {
    if (index < questions.length - 1) index += 1;
    else reviewing = true;
    render();
  }

  function header(subtitle) {
    return el("header", { class: "mt-2" }, [
      el("p", { class: "lesson__eyebrow" }, quiz.course.title),
      el("h1", { class: "display t-2xl mt-1" }, quiz.title),
      el("div", { class: "quiz__meta mt-2" }, [
        badge(`${quiz.pass_mark_percent}% to pass`, "accent"),
        badge(`${state.attemptsLeft} of ${quiz.max_attempts} attempts left`),
        subtitle ? el("span", {}, subtitle) : null,
      ]),
    ]);
  }

  /** The per-type answer control. Matching/ordering manage their own repaint
   *  and call back into `onChange` so the Continue button can react without a
   *  full question-screen re-render on every click. */
  function answerArea(question, chosen, onChange) {
    if (question.questionType === "SHORT_TEXT") {
      return el("div", { class: "field mt-4" }, [
        el("input", {
          class: "control", type: "text", value: chosen?.text ?? "",
          placeholder: "Type your answer",
          onInput: (event) => { answers[question.id] = { text: event.target.value }; onChange(); },
        }),
      ]);
    }
    if (question.questionType === "MATCHING") {
      return matchingWidget(question, chosen, (value) => { answers[question.id] = value; onChange(); });
    }
    if (question.questionType === "ORDERING") {
      return orderingWidget(question, chosen, (value) => { answers[question.id] = value; onChange(); });
    }
    return el("div", { class: "quiz__choices", role: "radiogroup", "aria-label": question.prompt },
      question.choices.map((choice) =>
        el("button", {
          type: "button", class: "choice", role: "radio",
          "aria-checked": String(chosen?.choice_id === choice.id),
          onClick: () => { answers[question.id] = { choice_id: choice.id }; advance(); },
        }, choice.text)));
  }

  /* --- Question screen ---------------------------------------------------- */

  function renderQuestion() {
    const question = questions[index];

    // Multiple choice advances on click; every other type needs an explicit
    // "Continue" (there's no equivalent single click that means "done here").
    const continueButton = question.questionType !== "MULTIPLE_CHOICE"
      ? button(["Continue", icon("arrowRight", 16)], { onClick: () => advance() })
      : null;
    const refreshContinue = () => {
      if (continueButton) continueButton.disabled = !isAnswerComplete(question, answers[question.id]);
    };

    const area = answerArea(question, answers[question.id], refreshContinue);
    refreshContinue();

    shell([
      header(),
      el("div", { class: "quiz__progress" }, [
        el("p", { class: "tabular subtle t-xs" },
          `Question ${index + 1} of ${questions.length}`),
        progressBar(((index) / questions.length) * 100, {
          size: "sm",
          className: "mt-1",
          label: `Question ${index + 1} of ${questions.length}`,
        }),
      ]),

      card(cardBody([
        el("p", { class: "quiz__question" }, question.prompt),
        area,
        continueButton ? el("div", { class: "row mt-4" }, [continueButton]) : null,
      ])),

      el("div", { class: "quiz__nav" }, [
        index > 0
          ? button([icon("arrowLeft", 16), "Previous"], {
              variant: "secondary",
              onClick: () => { index -= 1; render(); },
            })
          : buttonLink("Back to the programme", programHref, { variant: "ghost" }),
        allAnswered()
          ? button("Review answers", {
              variant: "secondary",
              className: "push",
              onClick: () => { reviewing = true; render(); },
            })
          : index < questions.length - 1
            ? button(["Skip", icon("arrowRight", 16)], {
                variant: "ghost",
                className: "push",
                onClick: () => { index += 1; render(); },
              })
            : null,
      ]),
    ]);
  }

  /* --- Review screen ------------------------------------------------------- */

  function answerSummary(question) {
    const value = answers[question.id];
    if (!isAnswerComplete(question, value)) return null;
    switch (question.questionType) {
      case "SHORT_TEXT":
        return value.text;
      case "MATCHING":
        return `${value.pairs.length} of ${question.leftItems.length} pairs set`;
      case "ORDERING":
        return "Order set";
      default:
        return question.choices.find((c) => c.id === value.choice_id)?.text ?? null;
    }
  }

  function renderReview() {
    shell([
      header(),
      card([
        cardBody([
          el("h2", { class: "medium" }, "Check your answers"),
          el("p", { class: "muted t-sm mt-1" },
            allAnswered()
              ? "You can change any answer before submitting. Marking happens on our server, and your score is final once you submit."
              : "Every question must be answered before you can submit."),

          el("ol", { class: "quiz__review mt-4" }, questions.map((question, i) => {
            const summary = answerSummary(question);
            return el("li", {
              class: summary ? "quiz__review-row" : "quiz__review-row quiz__review-row--unanswered",
            }, [
              el("div", { class: "q" }, [
                el("span", { class: "tabular subtle" }, `${i + 1}. `),
                question.prompt,
              ]),
              el("button", {
                type: "button",
                class: "a link",
                onClick: () => { index = i; reviewing = false; render(); },
              }, summary ?? "Not answered"),
            ]);
          })),

          error ? el("div", { class: "mt-4" }, formError(error)) : null,
        ]),
        el("div", { class: "card__footer row" }, [
          button([icon("arrowLeft", 16), "Back to questions"], {
            variant: "secondary",
            onClick: () => { reviewing = false; render(); },
          }),
          button(busy ? "Marking…" : "Submit assessment", {
            className: "push",
            disabled: busy || !allAnswered(),
            onClick: submit,
          }),
        ]),
      ]),
    ]);
  }

  async function submit() {
    if (busy || !allAnswered()) return;
    busy = true;
    error = null;
    render();

    const outcome = await rpc("submit_quiz_attempt", {
      p_enrollment_id: enrollmentId,
      p_quiz_id: quiz.id,
      // Every answers[qid] is already shaped exactly as the RPC expects.
      p_answers: answers,
    });

    busy = false;

    if (!outcome.ok) {
      error = outcome.error;
      render();
      return;
    }

    renderResult(outcome);
  }

  /* --- Result screen ------------------------------------------------------- */

  function renderResult(result) {
    shell(
      card(cardBody([
        el("div", {
          class: `quiz__score ${result.passed ? "quiz__score--pass" : "quiz__score--fail"}`,
        }, [
          el("span", {
            class: "animate-pop result-mark",
            style: {
              backgroundColor: result.passed ? "var(--success)" : "var(--warn)",
            },
          }, icon(result.passed ? "award" : "arrowLeft", 28)),

          el("h1", { class: "display t-2xl mt-4" },
            result.passed ? "Assessment passed" : "Not quite there"),

          el("p", { class: "quiz__score-value" }, `${result.score_percent}%`),
          el("p", { class: "tabular subtle t-sm" },
            `${result.correct_count} of ${result.total_questions} correct · ` +
            `${quiz.pass_mark_percent}% needed to pass`),

          el("p", { class: "muted measure-narrow mt-4" },
            result.passed
              ? "Well done — this course is now complete."
              : result.attempts_left > 0
                ? `You have ${result.attempts_left} ${result.attempts_left === 1 ? "attempt" : "attempts"} remaining. Review the course material and try again.`
                : "You have no attempts remaining. Contact us on (021) 713-2380 and we'll help you get back on track."),

          el("div", { class: "row row--wrap mt-6", style: { justifyContent: "center" } }, [
            buttonLink("Back to the programme", programHref),
            !result.passed && result.attempts_left > 0
              ? button("Try again", {
                  variant: "secondary",
                  onClick: () => {
                    for (const key of Object.keys(answers)) delete answers[key];
                    index = 0;
                    reviewing = false;
                    // attemptsLeft comes from the server's count, so the badge
                    // stays honest across retries within the same page load.
                    state.attemptsLeft = result.attempts_left;
                    render();
                  },
                })
              : null,
          ]),
        ]),
      ])),
    );
  }

  function render() {
    if (reviewing) renderReview();
    else renderQuestion();
  }

  render();
}
