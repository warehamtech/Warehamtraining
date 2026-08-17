import {
  el, mount, param, page, rawHtml, setTitle, formatMinutes, formatBytes,
} from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { badge, buttonLink, card, cardBody, emptyState } from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap, signedUrl } from "../supabase.js";
import { getEnrollmentProgress } from "../progress.js";
import { curriculumSidebar } from "../components/curriculum.js";

/** Port of src/app/(app)/learn/[enrollmentId]/lesson/[lessonId]/page.tsx. */

/** A lesson carries either a third-party embed or a file we host ourselves. */
async function videoPlayer(lesson) {
  if (lesson.video_file_key) {
    const url = await signedUrl("lesson-media", lesson.video_file_key, 3600);
    if (!url) {
      return card(cardBody(el("p", { class: "subtle t-sm center" },
        "That video could not be loaded.")));
    }
    return el("div", { class: "video-frame" },
      el("video", {
        controls: true,
        controlsList: "nodownload",
        preload: "metadata",
        src: url,
      }));
  }

  if (lesson.video_embed_url) {
    return el("div", { class: "video-frame" },
      el("iframe", {
        src: lesson.video_embed_url,
        title: lesson.title,
        allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen",
        allowfullscreen: true,
      }));
  }

  return card(cardBody(el("p", { class: "subtle t-sm center", style: { padding: "2rem 0" } },
    "The video for this lesson hasn't been uploaded yet.")));
}

async function pdfViewer(lesson) {
  const url = await signedUrl("lesson-media", lesson.pdf_file_key, 3600);
  if (!url) {
    return card(cardBody(el("p", { class: "subtle t-sm" },
      "That document could not be loaded.")));
  }
  return el("object", { data: url, type: "application/pdf", class: "pdf-frame",
    "aria-label": lesson.title },
    el("p", { style: { padding: "1.5rem" }, class: "muted t-sm" }, [
      "Your browser can't display this PDF inline. ",
      el("a", { class: "link", href: url, target: "_blank", rel: "noreferrer" },
        "Open it in a new tab"),
      ".",
    ]));
}

/** Next item after this lesson, walking the curriculum in order. */
function findNext(progress, courseId, lessonId) {
  const courseIndex = progress.courses.findIndex((c) => c.id === courseId);
  if (courseIndex < 0) return null;

  const course = progress.courses[courseIndex];
  const lessonIndex = course.lessons.findIndex((l) => l.id === lessonId);

  if (lessonIndex >= 0 && lessonIndex < course.lessons.length - 1) {
    return { kind: "lesson", id: course.lessons[lessonIndex + 1].id };
  }
  if (course.quiz) return { kind: "quiz", id: course.quiz.id };

  const nextCourse = progress.courses[courseIndex + 1];
  if (nextCourse?.lessons[0]) return { kind: "lesson", id: nextCourse.lessons[0].id };
  return null;
}

/**
 * Sticky action bar. Ticking is optimistic — the checkmark flips immediately
 * and the sidebar updates behind it — because waiting on a round trip for
 * something as small as "I've read this" feels broken.
 */
function lessonFooter({ enrollmentId, lessonId, complete, next, onChange }) {
  let state = complete;
  let busy = false;

  const mark = el("span", { class: "tick", "aria-hidden": "true" });
  const label = el("span", {});
  const errorSlot = el("div", {});

  const button = el("button", {
    type: "button",
    class: "btn",
    onClick: toggle,
  }, [mark, label]);

  function paint() {
    button.className = state ? "btn btn--secondary" : "btn btn--primary";
    button.setAttribute("aria-pressed", String(state));
    button.disabled = busy;
    mark.className = state ? "tick tick--done" : "tick";
    mark.replaceChildren(
      busy ? el("span", { class: "btn__spinner" })
        : state ? icon("check", 10, { strokeWidth: 4 })
          : "",
    );
    label.textContent = state ? "Completed" : "Mark as complete";
  }

  async function toggle() {
    const target = !state;
    errorSlot.replaceChildren();

    // Flip first, reconcile after.
    state = target;
    busy = true;
    paint();
    onChange?.(target);

    const { error } = target
      ? await sb.from("lesson_progress")
          .upsert({ enrollment_id: enrollmentId, lesson_id: lessonId },
            { onConflict: "enrollment_id,lesson_id" })
      : await sb.from("lesson_progress").delete()
          .eq("enrollment_id", enrollmentId).eq("lesson_id", lessonId);

    busy = false;

    if (error) {
      state = !target;
      onChange?.(!target);
      errorSlot.replaceChildren(
        el("p", { class: "t-sm", role: "alert", style: { color: "var(--danger)" } },
          "Couldn't save that. Try again."));
    }
    paint();
  }

  paint();

  return el("div", { class: "lesson__foot" }, [
    errorSlot,
    el("div", { class: "row" }, [
      button,
      next
        ? buttonLink(
            [next.kind === "quiz" ? "Take the assessment" : "Next lesson",
             icon("arrowRight", 16)],
            next.kind === "quiz"
              ? `/learn/quiz.html?e=${enrollmentId}&q=${next.id}`
              : `/learn/lesson.html?e=${enrollmentId}&l=${next.id}`,
            { variant: "secondary", className: "push" })
        : null,
    ]),
  ]);
}

page(async () => {
  const user = await requireUser();
  appChrome(user);

  const enrollmentId = param("e");
  const lessonId = param("l");

  if (!enrollmentId || !lessonId) {
    mount("#app", emptyState({
      iconName: "search",
      title: "No lesson specified",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  const [progress, lesson] = await Promise.all([
    getEnrollmentProgress(enrollmentId),
    sb.from("lessons")
      .select(`
        id, title, type, body_html, video_embed_url, video_file_key,
        pdf_file_key, duration_minutes,
        course:courses ( id, title, program_id ),
        resources ( id, title, file_key, original_name, size_bytes )
      `)
      .eq("id", lessonId)
      .maybeSingle()
      .then(unwrap),
  ]);

  // RLS returns nothing for a lesson on a programme this person has no seat
  // on, so both failures land here.
  if (!progress || !lesson) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "That lesson isn't available to you",
      description: "Your seat may have been reassigned, or the link may be out of date.",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  setTitle(lesson.title);

  const courseState = progress.courses.find((c) => c.id === lesson.course.id);
  const lessonState = courseState?.lessons.find((l) => l.id === lesson.id);
  const next = findNext(progress, lesson.course.id, lesson.id);

  const body = [];
  if (lesson.type === "VIDEO") body.push(await videoPlayer(lesson));
  if (lesson.type === "PDF" && lesson.pdf_file_key) body.push(await pdfViewer(lesson));
  if (lesson.body_html) {
    // Authored by WHA administrators in the admin panel, not by learners —
    // the same trust boundary the Next.js version drew.
    body.push(card(cardBody(rawHtml(lesson.body_html, "lesson-prose"))));
  }

  const resources = lesson.resources ?? [];
  if (resources.length) {
    body.push(card(cardBody([
      el("h2", { class: "row t-sm medium" }, [
        icon("download", 16, { class: "i-subtle" }),
        "Downloads",
      ]),
      el("ul", { class: "resources" }, resources.map((resource) =>
        el("li", {},
          el("a", {
            class: "resource",
            href: "#",
            onClick: async (event) => {
              // Signed on click rather than on render, so a link left open in
              // a tab does not stay valid indefinitely.
              event.preventDefault();
              const url = await signedUrl("lesson-media", resource.file_key, 300);
              if (url) window.open(url, "_blank", "noopener");
            },
          }, [
            icon("download", 16),
            el("span", { class: "name truncate medium" }, resource.title),
            el("span", { class: "size tabular" }, formatBytes(resource.size_bytes)),
          ])))),
    ])));
  }

  const sidebar = curriculumSidebar(progress, { activeId: lesson.id });
  const completedBadge = el("span", {});

  const article = el("article", {}, [
    el("header", { class: "lesson__head" }, [
      el("p", { class: "lesson__eyebrow" }, lesson.course.title),
      el("h1", { class: "display" }, lesson.title),
      el("div", { class: "row row--wrap mt-2" }, [
        lesson.duration_minutes > 0
          ? badge([icon("clock", 14), formatMinutes(lesson.duration_minutes)])
          : null,
        completedBadge,
      ]),
    ]),
    el("div", { class: "lesson__body stack--lg" }, body),
    lessonFooter({
      enrollmentId,
      lessonId: lesson.id,
      complete: lessonState?.complete ?? false,
      next,
      onChange: (done) => {
        // Keep the header badge and the sidebar tick in step with the button.
        completedBadge.replaceChildren(done ? badge("Completed", "success") : "");
        const item = sidebar.querySelector(`a[href$="l=${lesson.id}"] .tick`);
        if (item) item.className = done ? "tick tick--done" : "tick";
        if (item) item.replaceChildren(done ? icon("check", 10, { strokeWidth: 3.5 }) : "");
      },
    }),
  ]);

  if (lessonState?.complete) completedBadge.replaceChildren(badge("Completed", "success"));

  mount("#app", el("div", { class: "player" }, [sidebar, article]));

  // Record the visit; failure here is never worth telling the learner about.
  sb.rpc("touch_enrollment", { p_enrollment_id: enrollmentId });
});
