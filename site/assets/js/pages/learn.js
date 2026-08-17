import { el, mount, param, page, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, buttonLink, card, cardBody, emptyState, progressBar,
} from "../ui.js";
import { requireUser } from "../session.js";
import { sb } from "../supabase.js";
import { getEnrollmentProgress, nextStepHref } from "../progress.js";
import { curriculumSidebar } from "../components/curriculum.js";

/**
 * Programme overview — the landing point of the player.
 * Port of src/app/(app)/learn/[enrollmentId]/page.tsx.
 */

page(async () => {
  const user = await requireUser();
  appChrome(user);

  const enrollmentId = param("e");
  if (!enrollmentId) {
    location.replace("/dashboard.html");
    return;
  }

  const progress = await getEnrollmentProgress(enrollmentId);
  if (!progress) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "That programme isn't available to you",
      description: "Your seat may have been reassigned, or the link may be out of date.",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  setTitle(progress.programTitle);

  const step = progress.nextStep;
  const cta =
    progress.complete ? "Review the programme"
      : progress.completedSteps === 0 ? "Start the first lesson"
        : step.kind === "quiz" ? "Take the assessment"
          : "Resume where you left off";

  const overview = el("article", {}, [
    el("header", { class: "lesson__head" }, [
      el("p", { class: "lesson__eyebrow" }, "Programme"),
      el("h1", { class: "display" }, progress.programTitle),
    ]),

    card([
      cardBody([
        el("div", { class: "row row--wrap row--between", style: { alignItems: "flex-end" } }, [
          el("div", {}, [
            el("p", { class: "tabular t-3xl medium" }, `${progress.percent}%`),
            el("p", { class: "tabular subtle t-sm mt-1" },
              `${progress.completedSteps} of ${progress.totalSteps} steps complete`),
          ]),
          progress.complete
            ? buttonLink([icon("award", 18), "View your certificate"], "/certificates.html",
                { variant: "accent", size: "lg" })
            : buttonLink([icon("monitorPlay", 18), cta], nextStepHref(progress), { size: "lg" }),
        ]),

        progressBar(progress.percent, {
          size: "lg",
          className: "mt-4",
          tone: progress.complete ? "success" : "brand",
          label: `${progress.programTitle} progress`,
        }),

        el("dl", { class: "grid grid--thirds mt-6" }, [
          ["Courses", `${progress.completedCourses} of ${progress.totalCourses}`],
          ["Lessons", `${progress.completedLessons} of ${progress.totalLessons}`],
          ["Assessments", `${progress.passedAssessments} of ${progress.totalAssessments}`],
        ].map(([term, value]) =>
          el("div", { class: "stat" }, [
            el("dt", {}, term),
            el("dd", { class: "tabular" }, value),
          ]))),
      ]),
    ], { className: "mt-4" }),

    // Course-by-course breakdown, so the shape of the programme is legible
    // without scanning the sidebar.
    el("section", { class: "mt-8" }, [
      el("h2", { class: "section-label" }, "Courses"),
      el("ol", { class: "stack mt-3" }, progress.courses.map((course, index) =>
        el("li", {},
          card(cardBody([
            el("div", { class: "row row--between row--wrap" }, [
              el("div", { class: "row" }, [
                el("span", { class: "course-number" }, String(index + 1).padStart(2, "0")),
                el("div", {}, [
                  el("h3", { class: "medium" }, course.title),
                  el("p", { class: "tabular subtle t-xs mt-1" },
                    `${course.completedLessons} of ${course.totalLessons} lessons` +
                    (course.quiz
                      ? course.quiz.passed
                        ? " · assessment passed"
                        : course.quiz.unlocked
                          ? " · assessment ready"
                          : " · assessment locked"
                      : "")),
                ]),
              ]),
              course.complete
                ? badge([icon("check", 14), "Complete"], "success")
                : el("span", { class: "tabular subtle t-sm" }, `${course.percent}%`),
            ]),
            progressBar(course.percent, {
              size: "sm",
              className: "mt-3",
              tone: course.complete ? "success" : "brand",
            }),
          ]))))),
    ]),
  ]);

  mount("#app",
    el("div", { class: "player" }, [curriculumSidebar(progress), overview]));

  sb.rpc("touch_enrollment", { p_enrollment_id: enrollmentId });
});
