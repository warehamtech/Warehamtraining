import { el, mount, param, setTitle, formatBytes } from "../dom.js";
import { icon, blockIcon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  button, buttonLink, emptyState, field, setFormMessage, setPending,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, signedUrl } from "../supabase.js";
import { uploadLessonMedia } from "../storage-upload.js";
import { makeSortable } from "../drag-reorder.js";
import { openLearnerPreview } from "../components/learner-preview.js";

/**
 * Lesson Editor Studio: multi-format media suite (slides, video, audio, text,
 * image gallery, interactive embeds) with drag-and-drop ordering and instant
 * "Review as Learner" preview mode.
 */

const BLOCK_LABEL = {
  TEXT: "Rich Text & Notes",
  SLIDES: "Presentation Slide Deck",
  IMAGE: "Picture / Image Gallery",
  VIDEO: "Video Lesson",
  AUDIO: "Audio Guide / Voiceover",
  EMBED: "Interactive Embed (H5P/Canva)",
};

/** WYSIWYG rich text editor */
function richTextField(initialHtml) {
  const editable = el("div", {
    class: "control control--editable lesson-prose",
    contenteditable: "true",
    style: { minHeight: "8rem", padding: "1rem" },
  });
  editable.innerHTML = initialHtml ?? "";

  const exec = (cmd, arg) => {
    editable.focus();
    document.execCommand(cmd, false, arg);
  };

  const toolBtn = (label, aria, onClick, extraClass) =>
    el("button", {
      type: "button",
      class: extraClass ? `rich-toolbar__btn ${extraClass}` : "rich-toolbar__btn",
      "aria-label": aria,
      onClick,
    }, label);

  const toolbar = el("div", { class: "rich-toolbar", style: { gap: "0.25rem", flexWrap: "wrap" } }, [
    toolBtn("B", "Bold", () => exec("bold"), "rich-toolbar__btn--bold"),
    toolBtn("I", "Italic", () => exec("italic"), "rich-toolbar__btn--italic"),
    toolBtn("H2", "Heading 2", () => exec("formatBlock", "<h2>")),
    toolBtn("H3", "Heading 3", () => exec("formatBlock", "<h3>")),
    toolBtn("• List", "Bulleted list", () => exec("insertUnorderedList")),
    toolBtn("1. List", "Numbered list", () => exec("insertOrderedList")),
    toolBtn("“ Quote", "Quote", () => exec("formatBlock", "<blockquote>")),
    toolBtn("Link", "Add link", () => {
      const url = prompt("Enter URL:");
      if (url) exec("createLink", url);
    }),
    toolBtn("Clear", "Clear formatting", () => exec("removeFormat")),
  ]);

  editable.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  });

  return el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Content Text"),
    toolbar,
    editable,
    el("p", { class: "field__hint" }, "Highlight text to format. Pasted content is sanitized automatically."),
  ]);
}

/**
 * Slide Deck Block Editor.
 *
 * `onChange` hands the caller the live `slides` array so the form's submit
 * handler — a sibling function, outside this closure — can read the current
 * edits when it saves. `slides` is a fixed array reference throughout this
 * editor's life (add/delete mutate it via splice/push, never reassign it),
 * so one notification per structural change is enough: a slide's own field
 * edits mutate that slide object in place and are already visible through
 * the same reference without a fresh notification.
 */
function slideDeckEditor(block, content, onChange) {
  let slides = Array.isArray(content.slides) ? [...content.slides] : [];
  if (slides.length === 0) {
    slides = [{ id: "s1", title: "Slide 1: Overview", subtitle: "Key points", bullets: ["First point", "Second point"], notes: "" }];
  }
  onChange?.(slides);

  const slidesContainer = el("div", { class: "stack--sm" });

  const renderSlidesList = () => {
    onChange?.(slides);
    slidesContainer.replaceChildren(
      ...slides.map((slide, idx) => {
        const slideCard = el("div", {
          class: "card p-4 stack--sm",
          style: { background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" },
        }, [
          el("div", { class: "row row--between" }, [
            el("span", { class: "badge badge--brand font-semibold" }, `Slide ${idx + 1}`),
            button(icon("trash", 14), {
              variant: "ghost", size: "sm", "aria-label": "Delete slide",
              disabled: slides.length <= 1,
              onClick: () => {
                slides.splice(idx, 1);
                renderSlidesList();
              },
            }),
          ]),
          el("input", {
            class: "control",
            placeholder: "Slide Title (e.g. Core Requirements)",
            value: slide.title ?? "",
            onInput: (e) => slide.title = e.target.value,
          }),
          el("input", {
            class: "control",
            placeholder: "Subtitle (optional)",
            value: slide.subtitle ?? "",
            onInput: (e) => slide.subtitle = e.target.value,
          }),
          el("textarea", {
            class: "control",
            rows: 3,
            placeholder: "Bullet points (one per line)",
            onInput: (e) => slide.bullets = e.target.value.split("\n").filter(Boolean),
          }, (slide.bullets ?? []).join("\n")),
          el("input", {
            class: "control",
            placeholder: "Speaker notes (for instructor reference)",
            value: slide.notes ?? "",
            onInput: (e) => slide.notes = e.target.value,
          }),
        ]);
        return slideCard;
      }),
    );
  };

  renderSlidesList();

  const addSlideBtn = el("button", {
    class: "btn btn--secondary btn--sm",
    type: "button",
    onClick: () => {
      slides.push({
        id: `s${Date.now()}`,
        title: `Slide ${slides.length + 1}`,
        subtitle: "",
        bullets: ["New point"],
        notes: "",
      });
      renderSlidesList();
    },
  }, [icon("plus", 14), "Add Slide to Deck"]);

  return el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Interactive Slide Deck"),
    el("p", { class: "field__hint mb-3" }, "Create presentation slides with titles, bullet points, and speaker notes."),
    slidesContainer,
    el("div", { class: "mt-3" }, addSlideBtn),
  ]);
}

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

  setTitle(`${lesson.title} — Lesson Studio`);

  const blocks = [...(lesson.lesson_blocks ?? [])].sort((a, b) => a.position - b.position);

  // Signed previews for images
  const imagePreviews = new Map();
  for (const block of blocks) {
    if (block.block_type === "IMAGE" && block.content?.file_key) {
      imagePreviews.set(block.id, await signedUrl("lesson-media", block.content.file_key, 3600));
    }
  }

  const upload = (file, prefix) => uploadLessonMedia(file, lesson.course.program_id, prefix);

  // ---------------------------------------------------------------------------
  // Studio Top Bar
  // ---------------------------------------------------------------------------

  const previewBtn = el("button", {
    class: "btn btn--accent btn--sm",
    type: "button",
  }, [icon("eye", 16), "Review as Learner"]);

  previewBtn.addEventListener("click", () => {
    openLearnerPreview({
      title: `${lesson.course.title} · ${lesson.title}`,
      type: "lesson",
      data: {
        title: lesson.title,
        courseTitle: lesson.course.title,
        durationMinutes: lesson.duration_minutes,
        blocks,
      },
    });
  });

  const headerBanner = el("div", { class: "studio-banner mb-6" }, [
    el("div", { class: "stack stack--sm" }, [
      el("div", { class: "row row--wrap" }, [
        el("a", { class: "link t-sm subtle", href: `/admin/program.html?id=${programId}` }, `← ${lesson.course.title}`),
        el("span", { class: "subtle t-xs" }, "/"),
        el("span", { class: "badge badge--brand" }, "Lesson Studio"),
      ]),
      el("h1", { class: "display", style: { fontSize: "1.75rem" } }, lesson.title),
      el("p", { class: "subtle t-sm" }, `${blocks.length} content blocks · ${(lesson.resources ?? []).length} attachments`),
    ]),
    el("div", { class: "row" }, [
      previewBtn,
      buttonLink("Back to Course", `/admin/program.html?id=${programId}`, { variant: "secondary", size: "sm" }),
      button([icon("trash", 14), "Delete lesson"], {
        variant: "ghost", size: "sm",
        onClick: async () => {
          if (!confirm(`Delete "${lesson.title}"? This cannot be undone.`)) return;
          await sb.from("lessons").delete().eq("id", lesson.id);
          location.href = `/admin/program.html?id=${programId}`;
        },
      }),
    ]),
  ]);

  // ---------------------------------------------------------------------------
  // Lesson Settings Card
  // ---------------------------------------------------------------------------

  const settingsForm = el("form", { class: "card studio-card stack p-6 mb-6", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Lesson Settings"),
    el("div", { class: "grid grid--halves" }, [
      field({ label: "Lesson Title", name: "title", required: true, value: lesson.title }),
      field({
        label: "Estimated Duration (minutes)", name: "durationMinutes", type: "number", min: 0,
        value: lesson.duration_minutes ?? 0,
      }),
    ]),
    el("button", { class: "btn btn--primary push", type: "submit" }, "Save Settings"),
  ]);

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextValues = {
      title: settingsForm.elements.title.value.trim(),
      duration_minutes: Number(settingsForm.elements.durationMinutes.value) || 0,
    };
    setPending(settingsForm, true);
    const { error } = await sb.from("lessons").update(nextValues).eq("id", lesson.id);
    setPending(settingsForm, false);
    if (error) return setFormMessage(settingsForm, error.message);
    Object.assign(lesson, nextValues);
    setFormMessage(settingsForm, "Saved successfully.", "success");
  });

  // ---------------------------------------------------------------------------
  // Content Blocks Canvas
  // ---------------------------------------------------------------------------

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

  const reorderBlocks = async (orderedIds) => {
    await Promise.all(orderedIds.map((id, i) =>
      sb.from("lesson_blocks").update({ position: i + 1 }).eq("id", id)));
    render(admin);
  };

  const addBlock = async (blockType) => {
    let initialContent = {};
    if (blockType === "SLIDES") {
      initialContent = {
        slides: [
          { id: "s1", title: "Key Requirements", subtitle: "Overview", bullets: ["Requirement 1", "Requirement 2"], notes: "Explain standard context" },
        ],
      };
    }
    const { error } = await sb.from("lesson_blocks").insert({
      lesson_id: lesson.id,
      block_type: blockType,
      position: blocks.length + 1,
      content: initialContent,
    });
    if (error) {
      alert(`Couldn't add that block: ${error.message}`);
      return;
    }
    render(admin);
  };

  function blockFields(block, content, onSlidesChange) {
    switch (block.block_type) {
      case "SLIDES":
        return [slideDeckEditor(block, content, onSlidesChange)];

      case "AUDIO":
        return [
          field({ label: "Audio Title", name: "audioTitle", value: content.title ?? "", placeholder: "e.g. Standard Walkthrough Voiceover" }),
          field({ label: "Narrator / Speaker", name: "speaker", value: content.speaker ?? "", placeholder: "e.g. Lead Auditor Grant Wareham" }),
          el("div", { class: "field" }, [
            el("label", { class: "field__label" }, "Upload Audio File (.mp3, .wav, .m4a)"),
            el("input", { class: "control", type: "file", name: "file", accept: "audio/*" }),
            el("p", { class: "field__hint" }, content.file_key ? "An audio track is attached. Uploading replaces it." : "Hosted securely for enrolled learners."),
          ]),
        ];

      case "TEXT":
        return [richTextField(content.html ?? "")];

      case "IMAGE":
        return [
          imagePreviews.get(block.id)
            ? el("img", {
                src: imagePreviews.get(block.id),
                alt: "",
                style: { maxWidth: "16rem", borderRadius: "var(--radius-md)", border: "1px solid var(--line)", marginBottom: "1rem" },
              })
            : null,
          el("div", { class: "field" }, [
            el("label", { class: "field__label" }, content.file_key ? "Replace image" : "Upload Picture"),
            el("input", { class: "control", type: "file", name: "file", accept: "image/*" }),
          ]),
          field({ label: "Alt text (Accessibility)", name: "alt", value: content.alt ?? "" }),
          field({ label: "Caption", name: "caption", value: content.caption ?? "" }),
        ];

      case "VIDEO":
        return [
          field({
            label: "Video Embed URL", name: "embedUrl", type: "url", value: content.embed_url ?? "",
            placeholder: "https://player.vimeo.com/video/… or YouTube / Loom",
          }),
          el("div", { class: "field" }, [
            el("label", { class: "field__label" }, "…or upload video file (.mp4, .webm)"),
            el("input", { class: "control", type: "file", name: "file", accept: "video/*" }),
            el("p", { class: "field__hint" }, content.file_key ? "A video file is attached. Uploading replaces it." : "Stored securely in cloud storage."),
          ]),
        ];

      case "EMBED":
        return [
          field({
            label: "Interactive Embed Code (iframe)", name: "embedHtml", as: "textarea", rows: 6,
            value: content.embed_html ?? "",
            placeholder: '<iframe src="https://h5p.org/…" width="100%" height="400"></iframe>',
            hint: "Paste iframe from H5P, Canva, Genially, Figma, or Loom.",
          }),
        ];

      default:
        return [];
    }
  }

  const blockCard = (block, index) => {
    const content = block.content ?? {};
    const iconName = blockIcon[block.block_type] ?? "layers";

    // Only SLIDES needs this — see slideDeckEditor()'s own comment on why
    // one shared, mutated-in-place array is enough for the submit handler
    // below to always see the current edits.
    let liveSlides = null;

    const form = el("form", { class: "stack", novalidate: true }, [
      el("div", { "data-message": "" }),
      ...blockFields(block, content, (slides) => { liveSlides = slides; }),
      el("div", { class: "row row--between pt-3", style: { borderTop: "1px solid var(--line)" } }, [
        el("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Save Block"),
        el("div", { class: "row" }, [
          button(icon("trash", 14), {
            variant: "ghost", size: "sm", "aria-label": "Delete block",
            onClick: async () => {
              if (confirm(`Delete this ${BLOCK_LABEL[block.block_type]} block?`)) {
                await sb.from("lesson_blocks").delete().eq("id", block.id);
                render(admin);
              }
            },
          }),
        ]),
      ]),
    ]);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setFormMessage(form, null);

      let nextContent = { ...content };

      if (block.block_type === "TEXT") {
        const editable = form.querySelector(".control--editable");
        nextContent = { html: editable?.innerHTML ?? "" };
      } else if (block.block_type === "SLIDES") {
        nextContent = { slides: liveSlides ?? content.slides ?? [] };
      } else if (block.block_type === "IMAGE") {
        const file = form.elements.file?.files?.[0];
        if (file) {
          setPending(form, true);
          const key = await upload(file, "images");
          setPending(form, false);
          if (!key) return setFormMessage(form, "Image upload failed.");
          nextContent.file_key = key;
        }
        nextContent.alt = form.elements.alt?.value.trim() ?? "";
        nextContent.caption = form.elements.caption?.value.trim() ?? "";
      } else if (block.block_type === "VIDEO") {
        const file = form.elements.file?.files?.[0];
        const embedUrl = form.elements.embedUrl?.value.trim() ?? "";
        if (file) {
          setPending(form, true);
          const key = await upload(file, "videos");
          setPending(form, false);
          if (!key) return setFormMessage(form, "Video upload failed.");
          nextContent = { file_key: key };
        } else if (embedUrl) {
          nextContent = { embed_url: embedUrl };
        }
      } else if (block.block_type === "AUDIO") {
        const file = form.elements.file?.files?.[0];
        if (file) {
          setPending(form, true);
          const key = await upload(file, "audio");
          setPending(form, false);
          if (!key) return setFormMessage(form, "Audio upload failed.");
          nextContent.file_key = key;
        }
        nextContent.title = form.elements.audioTitle?.value.trim() ?? "";
        nextContent.speaker = form.elements.speaker?.value.trim() ?? "";
      } else if (block.block_type === "EMBED") {
        nextContent = { embed_html: form.elements.embedHtml?.value.trim() ?? "" };
      }

      setPending(form, true);
      const { error } = await sb.from("lesson_blocks").update({ content: nextContent }).eq("id", block.id);
      setPending(form, false);

      if (error) return setFormMessage(form, error.message);
      setFormMessage(form, "Saved.", "success");
    });

    return el("section", {
      class: "card studio-card p-6",
      "data-sort-id": block.id,
    }, [
      el("div", { class: "row row--between mb-4 pb-3", style: { borderBottom: "1px solid var(--line)" } }, [
        el("div", { class: "row" }, [
          icon("gripVertical", 18, { class: "grip i-subtle" }),
          icon(iconName, 18, { class: "text-brand-600" }),
          el("strong", { class: "t-sm" }, `${index + 1}. ${BLOCK_LABEL[block.block_type]}`),
        ]),
        el("div", { class: "row" }, [
          button(icon("arrowUp", 14), {
            variant: "ghost", size: "sm", disabled: index === 0,
            onClick: () => moveBlock(block, -1),
          }),
          button(icon("arrowDown", 14), {
            variant: "ghost", size: "sm", disabled: index === blocks.length - 1,
            onClick: () => moveBlock(block, 1),
          }),
        ]),
      ]),
      form,
    ]);
  };

  const blockList = el("div", { class: "stack" }, blocks.map(blockCard));
  makeSortable(blockList, "[data-sort-id]", ".grip", reorderBlocks);

  // Floating Quick Add Speed Dial
  const speedDial = el("div", { class: "studio-floating-actions my-6" }, [
    el("strong", { class: "t-xs uppercase subtle tracking-wider mr-2" }, "Add Block:"),
    button([icon("presentation", 14), "+ Slide Deck"], { variant: "secondary", size: "sm", onClick: () => addBlock("SLIDES") }),
    button([icon("monitorPlay", 14), "+ Video"], { variant: "secondary", size: "sm", onClick: () => addBlock("VIDEO") }),
    button([icon("volume2", 14), "+ Audio Clip"], { variant: "secondary", size: "sm", onClick: () => addBlock("AUDIO") }),
    button([icon("image", 14), "+ Picture"], { variant: "secondary", size: "sm", onClick: () => addBlock("IMAGE") }),
    button([icon("fileText", 14), "+ Text / Notes"], { variant: "secondary", size: "sm", onClick: () => addBlock("TEXT") }),
    button([icon("code", 14), "+ Embed"], { variant: "secondary", size: "sm", onClick: () => addBlock("EMBED") }),
  ]);

  // ---------------------------------------------------------------------------
  // Document (PDF) — independent of the block sequence, the lesson's
  // optional primary document, shown inline in the learner lesson view.
  // ---------------------------------------------------------------------------

  const pdfForm = el("form", { class: "stack", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Primary document"),
      el("input", { class: "control", type: "file", name: "file", accept: "application/pdf" }),
      el("p", { class: "field__hint" },
        lesson.pdf_file_key ? "A document is already attached. Uploading replaces it." : "Shown inline in the lesson."),
    ]),
    el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, "Upload document"),
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
    const { error } = await sb.from("lessons").update({ pdf_file_key: key }).eq("id", lesson.id);
    setPending(pdfForm, false);
    if (error) return setFormMessage(pdfForm, error.message);
    render(admin);
  });

  const documentCard = el("section", { class: "card studio-card stack p-6 mt-6" }, [
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Document"),
    el("p", { class: "subtle t-sm" }, "Optional — a PDF learners can read inline."),
    pdfForm,
  ]);

  // ---------------------------------------------------------------------------
  // Per-lesson Handouts & Resources
  // ---------------------------------------------------------------------------

  const resourceRow = (res) =>
    el("li", { class: "studio-card row p-3" }, [
      icon("download", 16, { class: "i-subtle" }),
      el("div", { class: "grow truncate" }, [
        el("strong", { class: "block t-sm truncate" }, res.title),
        el("span", { class: "subtle t-xs" }, `${res.original_name} · ${formatBytes(res.size_bytes)}`),
      ]),
      button(icon("trash", 14), {
        variant: "ghost", size: "sm",
        onClick: async () => {
          await sb.storage.from("lesson-media").remove([res.file_key]);
          await sb.from("resources").delete().eq("id", res.id);
          render(admin);
        },
      }),
    ]);

  const resourcesList = (lesson.resources ?? []).length
    ? el("ul", { class: "stack--sm" }, (lesson.resources ?? []).map(resourceRow))
    : el("p", { class: "subtle t-sm p-3 center" }, "No downloadable attachments on this lesson.");

  const addResourceForm = el("form", { class: "row row--wrap mt-3", novalidate: true }, [
    el("input", { class: "control grow", name: "title", required: true, placeholder: "Attachment title (e.g. Exercise Worksheet)" }),
    el("input", { class: "control", type: "file", name: "file", required: true }),
    el("button", { class: "btn btn--secondary btn--sm", type: "submit" }, [icon("plus", 14), "Attach File"]),
  ]);

  addResourceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = addResourceForm.elements.file.files?.[0];
    const title = addResourceForm.elements.title.value.trim();
    if (!file || !title) return;

    setPending(addResourceForm, true);
    const key = await upload(file, "resources");
    if (key) {
      await sb.from("resources").insert({
        lesson_id: lesson.id,
        title,
        file_key: key,
        original_name: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
      });
    }
    setPending(addResourceForm, false);
    render(admin);
  });

  const resourcesCard = el("section", { class: "card studio-card stack p-6 mt-6" }, [
    el("h2", { class: "display", style: { fontSize: "1.25rem" } }, "Lesson Attachments & Resources"),
    resourcesList,
    addResourceForm,
  ]);

  mount("#app", el("div", { class: "shell section--tight" }, [
    headerBanner,
    settingsForm,
    el("h2", { class: "display mb-4", style: { fontSize: "1.25rem" } }, "Lesson Content Blocks"),
    blockList,
    speedDial,
    documentCard,
    resourcesCard,
  ]));
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
}


