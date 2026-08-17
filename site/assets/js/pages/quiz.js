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
 * that hosts it.
 *
 * One question per screen, review before submit. Marking happens entirely in
 * submit_quiz_attempt(); `is_correct` is not granted to any client role, so
 * the answers are simply not in the payload this page receives — the only way
 * to find them is to answer.
 */

function shell(children) {
  mount("#app", el("div", { class: "quiz" }, children));
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
        questions ( id, prompt, position, choices ( id, text, position ) )
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
    .map((question) => ({
      id: question.id,
      prompt: question.prompt,
      choices: [...(question.choices ?? [])].sort((a, b) => a.position - b.position),
    }));

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

function runner({ enrollmentId, quiz, questions, state, programHref }) {
  const answers = {};
  let index = 0;
  let reviewing = false;
  let busy = false;
  let error = null;

  const answered = () => Object.keys(answers).length;
  const allAnswered = () => answered() === questions.length;

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

  /* --- Question screen ---------------------------------------------------- */

  function renderQuestion() {
    const question = questions[index];
    const chosen = answers[question.id];

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
        el("div", { class: "quiz__choices", role: "radiogroup",
          "aria-label": question.prompt },
          question.choices.map((choice) =>
            el("button", {
              type: "button",
              class: "choice",
              role: "radio",
              "aria-checked": String(chosen === choice.id),
              onClick: () => {
                answers[question.id] = choice.id;
                // Advance automatically, but stop at the end so the learner
                // reviews rather than submitting by momentum.
                if (index < questions.length - 1) index += 1;
                else reviewing = true;
                render();
              },
            }, choice.text))),
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
            const chosen = question.choices.find((c) => c.id === answers[question.id]);
            return el("li", {
              class: chosen ? "quiz__review-row" : "quiz__review-row quiz__review-row--unanswered",
            }, [
              el("div", { class: "q" }, [
                el("span", { class: "tabular subtle" }, `${i + 1}. `),
                question.prompt,
              ]),
              el("button", {
                type: "button",
                class: "a link",
                onClick: () => { index = i; reviewing = false; render(); },
              }, chosen ? chosen.text : "Not answered"),
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
