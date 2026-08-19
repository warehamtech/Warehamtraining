import { el, mount, param, setTitle, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { badge, button, buttonLink, card, cardBody, emptyState } from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap, signedUrl } from "../supabase.js";

/**
 * The hard "required before continuing" gate. Landed on from lesson.js
 * whenever course_downloads_acknowledged() would refuse the lesson_progress
 * write the learner is about to make — the actual enforcement is that RLS
 * check plus the same one inside submit_quiz_attempt(); this page is the
 * workflow, not the boundary.
 */

/** Only same-origin relative paths, so ?next= cannot become an open redirect. */
function safeNext(raw) {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard.html";
}

function downloadRow(download, acknowledged, onAcknowledge) {
  const ackButton = button(acknowledged ? [icon("check", 14), "Reviewed"] : "I've reviewed this", {
    variant: acknowledged ? "secondary" : "primary",
    size: "sm",
    disabled: acknowledged,
    onClick: async () => {
      const { error } = await sb.from("download_acknowledgements")
        .insert({ enrollment_id: download.enrollmentId, download_id: download.id });
      if (!error) onAcknowledge(download.id);
    },
  });

  return el("li", { class: "row" }, [
    icon("download", 18, { class: "i-subtle" }),
    el("div", { class: "grow" }, [
      el("p", { class: "medium t-sm" }, download.title),
      el("p", { class: "subtle t-xs tabular" },
        `${download.original_name} · ${formatBytes(download.size_bytes)}`),
    ]),
    button([icon("externalLink", 14), "Open"], {
      variant: "secondary", size: "sm",
      onClick: async () => {
        const url = await signedUrl("lesson-media", download.file_key, 300);
        if (url) window.open(url, "_blank", "noopener");
      },
    }),
    ackButton,
  ]);
}

export async function init() {
  const user = await requireUser();
  appChrome(user);
  setTitle("Before you continue");

  const enrollmentId = param("e");
  const courseId = param("c");
  const next = safeNext(param("next"));

  if (!enrollmentId) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Nothing to review",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  const enrollment = await sb.from("enrollments")
    .select("id, program:programs ( id, title )")
    .eq("id", enrollmentId)
    .maybeSingle()
    .then(unwrap);

  if (!enrollment) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "That enrolment isn't available to you",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  const [downloads, acknowledgements] = await Promise.all([
    sb.from("program_downloads")
      .select("id, title, file_key, original_name, size_bytes, required, position, course_id")
      .eq("program_id", enrollment.program.id)
      .or(courseId ? `course_id.is.null,course_id.eq.${courseId}` : "course_id.is.null")
      .order("position")
      .then(unwrap),
    sb.from("download_acknowledgements")
      .select("download_id")
      .eq("enrollment_id", enrollmentId)
      .then(unwrap),
  ]);

  const acked = new Set(acknowledgements.map((a) => a.download_id));
  const required = downloads.filter((d) => d.required);

  // Nothing (or nothing left) to review — this page should not have been the
  // destination; send the learner straight on rather than showing an empty gate.
  if (!required.length || required.every((d) => acked.has(d.id))) {
    location.replace(next);
    return;
  }

  const list = el("ul", { class: "divided" }, []);
  const footer = el("div", { class: "row mt-4" });

  function paint() {
    list.replaceChildren(...required.map((download) =>
      downloadRow({ ...download, enrollmentId }, acked.has(download.id), (id) => {
        acked.add(id);
        paint();
      })));

    const done = required.every((d) => acked.has(d.id));
    footer.replaceChildren(
      done
        ? buttonLink([icon("arrowRight", 16), "Continue"], next, { variant: "primary" })
        : el("p", { class: "subtle t-sm" }, "Review every item above to continue."),
    );
  }
  paint();

  mount("#app", [
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Before you continue"),
        el("p", {}, [
          `${enrollment.program.title} asks you to review the following `,
          required.length === 1 ? "item" : "items",
          " first.",
          " ",
          badge("Required", "warn"),
        ]),
      ]),
    ]),
    card(cardBody(list)),
    footer,
  ]);
}
