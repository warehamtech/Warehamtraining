import { el, mount, param, page, setTitle, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, signedUrl } from "../supabase.js";

/** Port of src/app/(app)/admin/programs/[id]/lessons/[lessonId]/ — page + lesson-forms. */

const MAX_UPLOAD = 500 * 1024 * 1024; // matches the lesson-media bucket limit

async function render(admin) {
  const programId = param("id");
  const lessonId = param("lessonId");

  if (!programId || !lessonId) {
    location.replace("/admin/programs.html");
    return;
  }

  const lesson = await sb.from("lessons")
    .select(`
      id, title, type, position, body_html, video_embed_url, video_file_key,
      pdf_file_key, duration_minutes,
      course:courses ( id, title, program_id ),
      resources ( id, title, file_key, original_name, content_type, size_bytes )
    `)
    .eq("id", lessonId)
    .maybeSingle()
    .then(unwrap);

  if (!lesson) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Lesson not found",
      action: buttonLink("Back to the programme", `/admin/program.html?id=${programId}`),
    }));
    return;
  }

  setTitle(`${lesson.title} — admin`);

  /* --- Upload helper ------------------------------------------------------ */

  // Media is keyed by programme id, because that is what the lesson-media
  // bucket policy checks when deciding who may read it back.
  async function upload(file, prefix) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const key = `${lesson.course.program_id}/${prefix}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await sb.storage.from("lesson-media").upload(key, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    return error ? null : key;
  }

  /* --- Core settings ------------------------------------------------------ */

  const settings = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({ label: "Title", name: "title", required: true, value: lesson.title }),
    el("div", { class: "grid grid--halves" }, [
      field({
        label: "Type", name: "type", as: "select",
        options: [
          { value: "TEXT", label: "Written", selected: lesson.type === "TEXT" },
          { value: "VIDEO", label: "Video", selected: lesson.type === "VIDEO" },
          { value: "PDF", label: "PDF", selected: lesson.type === "PDF" },
        ],
      }),
      field({
        label: "Duration (minutes)", name: "durationMinutes", type: "number", min: 0,
        value: lesson.duration_minutes ?? 0,
        hint: "Shown to learners as an estimate.",
      }),
    ]),
    field({
      label: "Written content (HTML)", name: "bodyHtml", as: "textarea", rows: 12,
      value: lesson.body_html ?? "",
      hint: "Rendered as-is into the lesson page. Headings, paragraphs, lists, tables and images are styled for you.",
    }),
    el("button", { class: "btn btn--primary", type: "submit" }, "Save lesson"),
  ]);

  settings.addEventListener("submit", async (event) => {
    event.preventDefault();
    setPending(settings, true);
    const { error } = await sb.from("lessons").update({
      title: settings.elements.title.value.trim(),
      type: settings.elements.type.value,
      duration_minutes: Number(settings.elements.durationMinutes.value) || 0,
      body_html: settings.elements.bodyHtml.value.trim() || null,
    }).eq("id", lesson.id);
    setPending(settings, false);

    if (error) return setFormMessage(settings, error.message);
    setFormMessage(settings, "Saved.", "success");
    setTimeout(() => render(admin), 800);
  });

  /* --- Video source ------------------------------------------------------- */

  const videoForm = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({
      label: "Embed URL", name: "videoEmbedUrl", type: "url",
      value: lesson.video_embed_url ?? "",
      placeholder: "https://player.vimeo.com/video/…",
      hint: "A CleverClips, Vimeo or YouTube embed URL. Leave blank if you upload a file instead.",
    }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "…or upload a video file"),
      el("input", { class: "control", type: "file", name: "file", accept: "video/*" }),
      el("p", { class: "field__hint" },
        lesson.video_file_key
          ? "A file is already attached. Uploading a new one replaces it."
          : "Stored privately — only learners holding a seat can play it."),
    ]),
    el("button", { class: "btn btn--secondary", type: "submit" }, "Save video source"),
  ]);

  videoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(videoForm, null);
    setPending(videoForm, true);

    const file = videoForm.elements.file.files?.[0];
    const embed = videoForm.elements.videoEmbedUrl.value.trim();

    let fileKey = lesson.video_file_key;
    if (file) {
      if (file.size > MAX_UPLOAD) {
        setPending(videoForm, false);
        return setFormMessage(videoForm, "That file is larger than 500 MB.");
      }
      fileKey = await upload(file, "video");
      if (!fileKey) {
        setPending(videoForm, false);
        return setFormMessage(videoForm, "That upload was refused.");
      }
    }

    // A lesson carries either an embed or a hosted file, not both — whichever
    // was set most recently wins.
    const { error } = await sb.from("lessons").update({
      video_embed_url: file ? null : (embed || null),
      video_file_key: file ? fileKey : (embed ? null : fileKey),
    }).eq("id", lesson.id);

    setPending(videoForm, false);
    if (error) return setFormMessage(videoForm, error.message);
    render(admin);
  });

  /* --- PDF ---------------------------------------------------------------- */

  const pdfForm = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Primary document"),
      el("input", { class: "control", type: "file", name: "file", accept: "application/pdf" }),
      el("p", { class: "field__hint" },
        lesson.pdf_file_key ? "A document is already attached." : "Shown inline in the lesson."),
    ]),
    el("button", { class: "btn btn--secondary", type: "submit" }, "Upload document"),
  ]);

  pdfForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = pdfForm.elements.file.files?.[0];
    if (!file) return setFormMessage(pdfForm, "Choose a PDF to upload.");

    setPending(pdfForm, true);
    const key = await upload(file, "pdf");
    if (!key) {
      setPending(pdfForm, false);
      return setFormMessage(pdfForm, "That upload was refused.");
    }
    await sb.from("lessons").update({ pdf_file_key: key }).eq("id", lesson.id);
    setPending(pdfForm, false);
    render(admin);
  });

  /* --- Attachments -------------------------------------------------------- */

  const resourceForm = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({ label: "Title", name: "title", required: true,
      placeholder: "Gap analysis template" }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "File"),
      el("input", { class: "control", type: "file", name: "file", required: true }),
    ]),
    el("button", { class: "btn btn--secondary", type: "submit" },
      [icon("plus", 16), "Add attachment"]),
  ]);

  resourceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = resourceForm.elements.file.files?.[0];
    const title = resourceForm.elements.title.value.trim();
    if (!file || !title) return setFormMessage(resourceForm, "Give it a title and choose a file.");

    setPending(resourceForm, true);
    const key = await upload(file, "resources");
    if (!key) {
      setPending(resourceForm, false);
      return setFormMessage(resourceForm, "That upload was refused.");
    }
    await sb.from("resources").insert({
      lesson_id: lesson.id,
      title,
      file_key: key,
      original_name: file.name,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
    });
    setPending(resourceForm, false);
    render(admin);
  });

  /* --- Page --------------------------------------------------------------- */

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "link t-sm row", href: `/admin/program.html?id=${programId}` },
          [icon("arrowLeft", 14), lesson.course.title]),
        el("h1", { class: "display mt-1" }, lesson.title),
      ]),
      button([icon("trash", 14), "Delete lesson"], {
        variant: "ghost",
        onClick: async () => {
          if (!confirm(`Delete "${lesson.title}"? This cannot be undone.`)) return;
          await sb.from("lessons").delete().eq("id", lesson.id);
          location.href = `/admin/program.html?id=${programId}`;
        },
      }),
    ]),

    el("div", { class: "grid grid--detail mt-4" }, [
      card([cardHeader("Lesson content"), cardBody(settings)]),

      el("aside", { class: "stack--lg" }, [
        lesson.type === "VIDEO"
          ? card([
              cardHeader("Video source", {
                description: "An embed URL or a file we host — not both.",
              }),
              cardBody(videoForm),
            ])
          : null,

        lesson.type === "PDF"
          ? card([cardHeader("Document"), cardBody(pdfForm)])
          : null,

        card([
          cardHeader("Attachments", {
            description: "Downloadable extras shown under the lesson.",
          }),
          (lesson.resources ?? []).length
            ? el("ul", { class: "divided" }, lesson.resources.map((resource) =>
                el("li", { class: "row" }, [
                  icon("download", 16, { class: "i-subtle" }),
                  el("div", { class: "grow" }, [
                    el("p", { class: "medium t-sm truncate" }, resource.title),
                    el("p", { class: "subtle t-xs tabular" },
                      `${resource.original_name} · ${formatBytes(resource.size_bytes)}`),
                  ]),
                  button(icon("trash", 14), {
                    variant: "ghost", size: "sm", "aria-label": "Remove attachment",
                    onClick: async () => {
                      await sb.storage.from("lesson-media").remove([resource.file_key]);
                      await sb.from("resources").delete().eq("id", resource.id);
                      render(admin);
                    },
                  }),
                ])))
            : null,
          cardBody(resourceForm),
        ]),
      ]),
    ]));
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
