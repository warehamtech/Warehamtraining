import { el } from "../dom.js";
import { icon, lessonIcon } from "../icons.js";
import { progressBar, progressRing } from "../ui.js";

/**
 * Curriculum sidebar. Port of src/components/learn/curriculum-sidebar.tsx.
 *
 * On desktop it is a sticky column; on mobile it collapses behind a summary
 * button so the lesson content is what you see first.
 */

function tick(done, { quiz = false } = {}) {
  const classes = ["tick"];
  if (done) classes.push("tick--done");
  else if (quiz) classes.push("tick--quiz");
  return el("span", { class: classes.join(" "), "aria-hidden": "true" },
    done ? icon("check", 10, { strokeWidth: 3.5 }) : null);
}

function lessonRow(enrollmentId, lesson, activeId) {
  const href = `/learn/lesson.html?e=${enrollmentId}&l=${lesson.id}`;
  return el("li", {},
    el("a", {
      href,
      class: "curriculum__item",
      "aria-current": lesson.id === activeId ? "page" : null,
    }, [
      tick(lesson.complete),
      el("span", { class: "text" }, lesson.title),
      icon(lessonIcon[lesson.type], 14, { class: "type-icon" }),
      el("span", { class: "sr-only" },
        lesson.complete ? "(completed)" : "(not completed)"),
    ]));
}

function quizRow(enrollmentId, quiz, activeId) {
  // Locked assessments are plain text, not links — the gate is enforced in
  // submit_quiz_attempt() regardless, but there is no point offering a door
  // that will not open.
  if (!quiz.unlocked) {
    return el("li", {},
      el("p", {
        class: "curriculum__item curriculum__item--quiz curriculum__item--locked",
        title: "Complete every lesson in this course to unlock the assessment",
      }, [
        tick(false),
        el("span", { class: "text" }, quiz.title),
        icon("lock", 14, { class: "type-icon" }),
        el("span", { class: "sr-only" }, "(locked)"),
      ]));
  }

  return el("li", {},
    el("a", {
      href: `/learn/quiz.html?e=${enrollmentId}&q=${quiz.id}`,
      class: "curriculum__item curriculum__item--quiz",
      "aria-current": quiz.id === activeId ? "page" : null,
    }, [
      tick(quiz.passed, { quiz: true }),
      el("span", { class: "text" }, quiz.title),
      icon("graduationCap", 14, { class: "type-icon" }),
    ]));
}

export function curriculumSidebar(progress, { activeId } = {}) {
  const nav = el("nav", {
    class: "curriculum__nav",
    "aria-label": "Course curriculum",
    hidden: true,
  }, [
    el("div", { class: "curriculum__head" }, [
      el("strong", {}, progress.programTitle),
      el("p", {},
        `${progress.completedLessons} of ${progress.totalLessons} lessons · ` +
        `${progress.passedAssessments} of ${progress.totalAssessments} assessments`),
      progressBar(progress.percent, { tone: progress.complete ? "success" : "brand" }),
    ]),

    el("ol", {}, progress.courses.map((course, index) =>
      el("li", { class: "curriculum__course" }, [
        el("div", { class: "curriculum__course-head" }, [
          progressRing(course.percent, {
            size: 30,
            strokeWidth: 2.5,
            showValue: false,
            tone: course.complete ? "success" : "brand",
          }),
          el("div", { class: "grow" }, [
            el("p", { class: "label" }, `Course ${index + 1}`),
            el("p", { class: "title" }, course.title),
          ]),
        ]),
        el("ul", { class: "curriculum__lessons" }, [
          ...course.lessons.map((lesson) =>
            lessonRow(progress.enrollmentId, lesson, activeId)),
          course.quiz ? quizRow(progress.enrollmentId, course.quiz, activeId) : null,
        ]),
      ]))),
  ]);

  const toggle = el("button", {
    class: "curriculum__toggle",
    type: "button",
    "aria-expanded": "false",
    onClick: () => {
      const open = nav.hidden;
      nav.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    },
  }, [
    progressRing(progress.percent, { size: 34 }),
    el("span", { class: "grow" }, [
      el("strong", {}, progress.programTitle),
      el("span", { class: "count" },
        `${progress.completedSteps} of ${progress.totalSteps} steps complete`),
    ]),
    icon("chevronDown", 16),
  ]);

  return el("div", { class: "curriculum" }, [toggle, nav]);
}
