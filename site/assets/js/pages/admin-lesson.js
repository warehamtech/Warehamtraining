import { el, mount, param, page, setTitle, formatBytes } from "../dom.js";
import { icon, blockIcon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, signedUrl } from "../supabase.js";
import { uploadLessonMedia, MAX_LESSON_MEDIA_UPLOAD } from "../storage-upload.js";

/**
 * Lesson editor: an ordered sequence of content blocks (text/image/video/
 * interactive embed) plus the lesson-level settings, primary document and
 * downloadable attachments that sit alongside them.
 *
 * Port of src/app/(app)/admin/programs/[id]/lessons/[lessonId]/ — page +
 * lesson-forms — extended for the block model added in 0006_lesson_blocks.sql.
 */

const BLOCK_LABEL = {
  TEXT: "Text",
  IMAGE: "Image",
  VIDEO: "Video",
  EMBED: "Interactive embed",
};

async function render(admin) {
  const programId = param("id");
  const lessonId = param("lessonId");

  if (!programId || !lessonId) {
    location.replace("/admin/programs.html");
    return;
  }

  const lesson = await sb.from("lessons")
    .select(`
      id, title, position, pdf_file_key, duration_minutes,
      course:courses ( id, title, program_id ),
      resources ( id, title, file_key, original_name, content_type, size_bytes ),
      lesson_blocks ( id, block_type, position, content )
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

  const blocks = [...(lesson.lesson_blocks ?? [])].sort((a, b) => a.position - b.position);

  // Signed previews for existing images, fetched up front so block cards can
  // render synchronously.
  const imagePreviews = new Map();
  for (const block of blocks) {
    if (block.block_type === "IMAGE" && block.content?.file_key) {
      imagePreviews.set(block.id,
        await signedUrl("lesson-media", block.content.file_key, 3600));
    }
  }

  const upload = (file, prefix) => uploadLessonMedia(file, lesson.course.program_id, prefix);

  /* --- Lesson settings ------------------------------------------------------ */

  const settings = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    field({ label: "Title", name: "title", required: true, value: lesson.title }),
    field({
      label: "Duration (minutes)", name: "durationMinutes", type: "number", min: 0,
      value: lesson.duration_minutes ?? 0, hint: "Shown to learners as an estimate.",
    }),
    el("button", { class: "btn btn--primary", type: "submit" }, "Save lesson"),
  ]);

  settings.addEventListener("submit", async (event) => {
    event.preventDefault();
    setPending(settings, true);
    const { error } = await sb.from("lessons").update({
      title: settings.elements.title.value.trim(),
      duration_minutes: Number(settings.elements.durationMinutes.value) || 0,
    }).eq("id", lesson.id);
    setPending(settings, false);

    if (error) return setFormMessage(settings, error.message);
    setFormMessage(settings, "Saved.", "success");
    setTimeout(() => render(admin), 800);
  });

  /* --- Content blocks --------------------------------------------------------
   *
   * Reordering is the same adjacent-position-swap pattern used for courses
   * and lessons in admin-program.js — no drag-and-drop dependency.
   */

  const moveBlock = async (block, direction) => {
    const index = blocks.findIndex((b) => b.id === block.id);
    const swapWith = blocks[index + direction];
    if (!swapWith) return;
    await Promise.all([
      sb.from("lesson_blocks").update({ position: swapWith.position }).eq("id", block.id),
      sb.from("lesson_blocks").update({ position: block.position }).eq("id", swapWith.id),
    ]);
    render(admin);
  };

  const addBlock = async (blockType) => {
    await sb.from("lesson_blocks").insert({
      lesson_id: lesson.id,
      block_type: blockType,
      position: blocks.length + 1,
      content: {},
    });
    render(admin);
  };

  function blockFields(block, content) {
    switch (block.block_type) {
      case "TEXT":
        return [field({
          label: "HTML content", name: "html", as: "textarea", rows: 8,
          value: content.html ?? "",
          hint: "Rendered as-is. Headings, paragraphs, lists, tables and images are styled for you.",
        })];

      case "IMAGE":
        return [
          imagePreviews.get(block.id)
            ? el("img", {
                src: imagePreviews.get(block.id),
                alt: "",
                style: { maxWidth: "12rem", borderRadius: "var(--radius-card)", border: "1px solid var(--line)" },
              })
            : null,
          el("div", { class: "field" }, [
            el("label", { class: "field__label" },
              content.file_key ? "Replace image" : "Image"),
            el("input", { class: "control", type: "file", name: "file", accept: "image/*" }),
          ]),
          field({ label: "Alt text", name: "alt", value: content.alt ?? "",
            hint: "Describes the image for screen readers." }),
          field({ label: "Caption", name: "caption", value: content.caption ?? "" }),
        ];

      case "VIDEO":
        return [
          field({
            label: "Embed URL", name: "embedUrl", type: "url", value: content.embed_url ?? "",
            placeholder: "https://player.vimeo.com/video/…",
            hint: "A CleverClips, Vimeo or YouTube embed URL. Leave blank if you upload a file instead.",
          }),
          el("div", { class: "field" }, [
            el("label", { class: "field__label" }, "…or upload a video file"),
            el("input", { class: "control", type: "file", name: "file", accept: "video/*" }),
            el("p", { class: "field__hint" },
              content.file_key
                ? "A file is already attached. Uploading a new one replaces it."
                : "Stored privately — only learners holding a seat can play it."),
          ]),
        ];

      case "EMBED":
        return [
          field({
            label: "Embed code", name: "embedHtml", as: "textarea", rows: 6,
            value: content.embed_html ?? "",
            hint: "Paste the iframe/embed snippet from H5P, Genially, YouTube, Canva, etc.",
          }),
          field({
            label: "Provider (optional)", name: "provider", value: content.provider ?? "",
            hint: "Display label only, e.g. \"H5P\".",
          }),
        ];

      default:
        return [];
    }
  }

  async function saveBlock(event, block, form) {
    event.preventDefault();
    setFormMessage(form, null);
    setPending(form, true);

    const content = block.content ?? {};
    let next;

    if (block.block_type === "TEXT") {
      next = { html: form.elements.html.value.trim() };
    } else if (block.block_type === "IMAGE") {
      const file = form.elements.file.files?.[0];
      let fileKey = content.file_key ?? null;
      if (file) {
        if (file.size > MAX_LESSON_MEDIA_UPLOAD) {
          setPending(form, false);
          return setFormMessage(form, "That file is larger than 500 MB.");
        }
        fileKey = await upload(file, "image");
        if (!fileKey) {
          setPending(form, false);
          return setFormMessage(form, "That upload was refused.");
        }
      }
      if (!fileKey) {
        setPending(form, false);
        return setFormMessage(form, "Choose an image.");
      }
      next = {
        file_key: fileKey,
        alt: form.elements.alt.value.trim(),
        caption: form.elements.caption.value.trim(),
      };
    } else if (block.block_type === "VIDEO") {
      const file = form.elements.file.files?.[0];
      const embed = form.elements.embedUrl.value.trim();
      if (file) {
        if (file.size > MAX_LESSON_MEDIA_UPLOAD) {
          setPending(form, false);
          return setFormMessage(form, "That file is larger than 500 MB.");
        }
        const fileKey = await upload(file, "video");
        if (!fileKey) {
          setPending(form, false);
          return setFormMessage(form, "That upload was refused.");
        }
        next = { file_key: fileKey };
      } else if (embed) {
        next = { embed_url: embed };
      } else if (content.file_key) {
        next = { file_key: content.file_key };
      } else {
        setPending(form, false);
        return setFormMessage(form, "Add an embed URL or upload a file.");
      }
    } else if (block.block_type === "EMBED") {
      const html = form.elements.embedHtml.value.trim();
      if (!html) {
        setPending(form, false);
        return setFormMessage(form, "Paste an embed snippet.");
      }
      next = { embed_html: html, provider: form.elements.provider.value.trim() || null };
    }

    const { error } = await sb.from("lesson_blocks").update({ content: next }).eq("id", block.id);
    setPending(form, false);

    if (error) return setFormMessage(form, error.message);
    setFormMessage(form, "Saved.", "success");
    setTimeout(() => render(admin), 800);
  }

  function blockCard(block, index) {
    const content = block.content ?? {};
    const form = el("form", { class: "stack", novalidate: true }, [
      el("div", { "data-message": "" }),
      ...blockFields(block, content),
      el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Save block"),
    ]);

    form.addEventListener("submit", (event) => saveBlock(event, block, form));

    return el("li", {}, card([
      el("div", { class: "card__header" }, [
        el("div", { class: "row" }, [
          icon(blockIcon[block.block_type], 16, { class: "i-subtle" }),
          el("span", { class: "medium t-sm" }, BLOCK_LABEL[block.block_type]),
        ]),
        el("div", { class: "row" }, [
          button(icon("chevronDown", 14), {
            variant: "ghost", size: "sm", "aria-label": "Move block down",
            disabled: index === blocks.length - 1,
            onClick: () => moveBlock(block, 1),
          }),
          button(icon("trash", 14), {
            variant: "ghost", size: "sm", "aria-label": "Delete block",
            onClick: async () => {
              if (!confirm("Delete this block? This cannot be undone.")) return;
              await sb.from("lesson_blocks").delete().eq("id", block.id);
              render(admin);
            },
          }),
        ]),
      ]),
      cardBody(form),
    ]));
  }

  const addBlockRow = el("div", { class: "row row--wrap mt-3" }, [
    button([icon("fileText", 14), "Text"], {
      variant: "secondary", size: "sm", onClick: () => addBlock("TEXT"),
    }),
    button([icon("image", 14), "Image"], {
      variant: "secondary", size: "sm", onClick: () => addBlock("IMAGE"),
    }),
    button([icon("monitorPlay", 14), "Video"], {
      variant: "secondary", size: "sm", onClick: () => addBlock("VIDEO"),
    }),
    button([icon("code", 14), "Interactive embed"], {
      variant: "secondary", size: "sm", onClick: () => addBlock("EMBED"),
    }),
  ]);

  /* --- Document (PDF) --------------------------------------------------------
   *
   * Independent of the block sequence — the lesson's optional primary
   * document, unconditional rather than gated on a lesson "type" the way it
   * was before blocks existed.
   */

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

  /* --- Attachments ------------------------------------------------------- */

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

  /* --- Page ----------------------------------------------------------------- */

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
      card([
        cardHeader("Content blocks", {
          description: "The lesson's slides, in the order learners see them.",
        }),
        cardBody([
          blocks.length
            ? el("ul", { class: "stack" }, blocks.map((block, i) => blockCard(block, i)))
            : el("p", { class: "subtle t-sm" }, "No blocks yet — add one below."),
          addBlockRow,
        ]),
      ]),

      el("aside", { class: "stack--lg" }, [
        card([cardHeader("Lesson settings"), cardBody(settings)]),
        card([
          cardHeader("Document", { description: "Optional — a PDF learners can read inline." }),
          cardBody(pdfForm),
        ]),
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
