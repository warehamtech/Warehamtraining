import { el, rawHtml } from "../dom.js";
import { icon } from "../icons.js";
import { renderBlock } from "./block-render.js";

/**
 * High-fidelity interactive "Review as Learner" modal overlay.
 * Allows instructors and authors to experience the lesson, slide decks,
 * media players, and quiz questions exactly as a learner sees them.
 */

export async function openLearnerPreview({ title, type = "lesson", data = {}, onClose } = {}) {
  const overlay = el("div", { class: "studio-preview-overlay", role: "dialog", "aria-modal": "true" });
  
  let currentViewport = "desktop"; // "desktop" | "tablet" | "mobile"

  const close = () => {
    overlay.classList.add("is-closing");
    setTimeout(() => {
      overlay.remove();
      document.body.style.overflow = "";
      onClose?.();
    }, 200);
  };

  document.body.style.overflow = "hidden";

  const closeBtn = el("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
    "aria-label": "Close preview",
    onClick: close,
  }, [icon("x", 18), "Exit Preview"]);

  const vpDesktop = el("button", {
    class: "studio-preview-vp-btn is-active",
    type: "button",
    title: "Desktop view",
    onClick: () => {
      currentViewport = "desktop";
      updateVp();
    },
  }, icon("monitorPlay", 16));

  const vpTablet = el("button", {
    class: "studio-preview-vp-btn",
    type: "button",
    title: "Tablet view",
    onClick: () => {
      currentViewport = "tablet";
      updateVp();
    },
  }, icon("layers", 16));

  const vpMobile = el("button", {
    class: "studio-preview-vp-btn",
    type: "button",
    title: "Mobile view",
    onClick: () => {
      currentViewport = "mobile";
      updateVp();
    },
  }, icon("users", 16));

  const vpGroup = el("div", { class: "studio-preview-vp-group" }, [vpDesktop, vpTablet, vpMobile]);

  function updateVp() {
    [vpDesktop, vpTablet, vpMobile].forEach((b) => b.classList.remove("is-active"));
    if (currentViewport === "desktop") vpDesktop.classList.add("is-active");
    if (currentViewport === "tablet") vpTablet.classList.add("is-active");
    if (currentViewport === "mobile") vpMobile.classList.add("is-active");
    bodyWrapper.className = `studio-preview-device studio-preview-device--${currentViewport}`;
  }

  const header = el("div", { class: "studio-preview-header" }, [
    el("div", { class: "row" }, [
      el("span", { class: "badge badge--brand" }, [icon("eye", 12), "Learner Preview Mode"]),
      el("strong", { class: "t-sm truncate", style: { maxWidth: "20rem" } }, title || "Student View"),
    ]),
    vpGroup,
    closeBtn,
  ]);

  const contentArea = el("div", { class: "studio-preview-content" }, [
    el("p", { class: "page-state" }, "Loading preview…"),
  ]);

  const bodyWrapper = el("div", { class: "studio-preview-device studio-preview-device--desktop" }, [
    contentArea,
  ]);

  overlay.append(header, el("div", { class: "studio-preview-scroller" }, bodyWrapper));

  document.body.append(overlay);

  const onKey = (e) => {
    if (e.key === "Escape") {
      window.removeEventListener("keydown", onKey);
      close();
    }
  };
  window.addEventListener("keydown", onKey);

  // Render preview content based on type
  if (type === "lesson") {
    const blocks = data.blocks ?? [];
    const nodes = [];
    for (const b of blocks) {
      const rendered = await renderBlock(b, { title: data.title });
      if (rendered) nodes.push(rendered);
    }

    if (nodes.length === 0) {
      nodes.push(el("div", { class: "card", style: { padding: "2rem", textAlign: "center" } }, [
        el("p", { class: "subtle t-sm" }, "This lesson has no content blocks yet."),
      ]));
    }

    contentArea.replaceChildren(
      el("div", { class: "lesson-preview-container stack" }, [
        el("div", { class: "page-head" }, [
          el("div", {}, [
            el("span", { class: "badge badge--brand mb-2" }, data.courseTitle || "Course Lesson"),
            el("h1", { class: "display" }, data.title || "Untitled Lesson"),
            data.durationMinutes ? el("p", { class: "subtle t-sm" }, `Estimated time: ${data.durationMinutes} min`) : null,
          ]),
        ]),
        ...nodes,
        el("div", { class: "lesson__foot mt-4" }, [
          el("div", { class: "row" }, [
            el("button", { class: "btn btn--primary", type: "button", disabled: true }, [
              icon("check", 14), "Mark as complete (Preview)",
            ]),
          ]),
        ]),
      ]),
    );
  } else if (type === "quiz") {
    const questions = data.questions ?? [];
    let currentIdx = 0;

    const quizCanvas = el("div", { class: "quiz-preview-container stack" });

    const renderQuestion = () => {
      if (questions.length === 0) {
        quizCanvas.replaceChildren(el("p", { class: "subtle center p-4" }, "No questions in this assessment."));
        return;
      }

      const q = questions[currentIdx];
      const qNum = currentIdx + 1;

      const qCard = el("div", { class: "card", style: { padding: "1.5rem" } }, [
        el("div", { class: "row justify-between mb-3" }, [
          el("span", { class: "badge badge--brand" }, `Question ${qNum} of ${questions.length}`),
          q.explanation ? el("span", { class: "subtle t-xs" }, "Has feedback explanation") : null,
        ]),
        el("h3", { style: { fontSize: "1.125rem", fontWeight: "500", marginBottom: "1.25rem" } }, q.prompt),
      ]);

      // Interactive simulator options
      if (q.question_type === "MULTIPLE_CHOICE" || !q.question_type) {
        const choicesList = el("div", { class: "stack--sm" });
        (q.choices ?? []).forEach((ch) => {
          const opt = el("label", {
            class: "quiz-opt-card row p-3",
            style: { border: "1px solid var(--line)", borderRadius: "var(--radius-md)", cursor: "pointer" },
          }, [
            el("input", { type: "radio", name: `preview-q-${q.id}` }),
            el("span", { class: "grow" }, ch.text),
            ch.is_correct ? el("span", { class: "badge badge--success t-xs" }, "Correct Answer") : null,
          ]);
          choicesList.append(opt);
        });
        qCard.append(choicesList);
      } else if (q.question_type === "SHORT_TEXT") {
        qCard.append(el("div", { class: "field" }, [
          el("input", { class: "control", placeholder: "Type learner answer here…" }),
          el("p", { class: "field__hint" }, `Accepted: ${(q.answer_key?.accepted ?? []).join(", ") || "(none set)"}`),
        ]));
      }

      const navBar = el("div", { class: "row justify-between mt-4" }, [
        el("button", {
          class: "btn btn--secondary btn--sm",
          type: "button",
          disabled: currentIdx === 0,
          onClick: () => { currentIdx--; renderQuestion(); },
        }, [icon("arrowLeft", 14), "Previous"]),
        el("button", {
          class: "btn btn--primary btn--sm",
          type: "button",
          disabled: currentIdx === questions.length - 1,
          onClick: () => { currentIdx++; renderQuestion(); },
        }, ["Next Question", icon("arrowRight", 14)]),
      ]);

      quizCanvas.replaceChildren(
        el("div", { class: "page-head" }, [
          el("h2", { class: "display" }, data.title || "Assessment Preview"),
          el("p", { class: "subtle t-sm" }, `Pass mark: ${data.passMarkPercent ?? 80}%`),
        ]),
        qCard,
        navBar,
      );
    };

    renderQuestion();
    contentArea.replaceChildren(quizCanvas);
  }

  return { close };
}
