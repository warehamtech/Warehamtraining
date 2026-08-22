import { el } from "../dom.js";
import { icon } from "../icons.js";
import { button, field } from "../ui.js";

/**
 * Authoring UI for one lesson_blocks row — the editing counterpart to
 * components/block-render.js, which renders the same rows for learners.
 *
 * Kept apart from the builder page itself because the two halves have to stay
 * in step with each other and with the renderer: a block type is only really
 * supported once it has a `content` shape here, a case in `collectContent()`,
 * and a case in renderBlock(). Anything missing one of the three is a block an
 * author can create but nobody can see.
 */

export const BLOCK_LABEL = {
  TEXT: "Rich Text & Notes",
  SLIDES: "Presentation Slide Deck",
  IMAGE: "Picture / Image",
  VIDEO: "Video Lesson",
  AUDIO: "Audio Guide / Voiceover",
  EMBED: "Interactive Embed",
};

/** The palette offered by the "+" inserter, in the order authors reach for. */
export const BLOCK_TYPES = [
  { type: "SLIDES", icon: "presentation", label: "Slide Deck", hint: "Titled slides with bullets and speaker notes" },
  { type: "TEXT", icon: "fileText", label: "Rich Text & Notes", hint: "Formatted body copy, headings and lists" },
  { type: "VIDEO", icon: "monitorPlay", label: "Video", hint: "An embed URL, or a file hosted for enrolled learners" },
  { type: "IMAGE", icon: "image", label: "Picture", hint: "A single image with alt text and a caption" },
  { type: "AUDIO", icon: "volume2", label: "Audio Guide", hint: "Voiceover or narration with a custom player" },
  { type: "EMBED", icon: "code", label: "Interactive Embed", hint: "An iframe from H5P, Canva, Genially or Loom" },
];

/** What a freshly inserted block of each type starts life holding. */
export function initialContent(blockType) {
  if (blockType === "SLIDES") {
    return {
      slides: [{
        id: "s1",
        title: "Key Requirements",
        subtitle: "Overview",
        bullets: ["Requirement 1", "Requirement 2"],
        notes: "",
      }],
    };
  }
  return {};
}

/**
 * Whether this block has anything worth previewing.
 *
 * renderBlock() answers a different question — it returns a node for an empty
 * EMBED or TEXT block just as readily as a full one, because on the learner
 * side an empty block is a mistake nobody should be looking at. In the builder
 * an empty block is the normal state right after inserting one, so the canvas
 * needs to tell "nothing here yet" apart from "content that renders as
 * nothing" and prompt the author instead of showing a blank card.
 */
export function hasContent(blockType, content = {}) {
  switch (blockType) {
    case "TEXT":
      return Boolean(content.html?.replace(/<[^>]*>/g, "").trim());
    case "SLIDES":
      return (content.slides ?? []).length > 0;
    case "IMAGE":
      return Boolean(content.file_key || content.url);
    case "VIDEO":
      return Boolean(content.file_key || content.embed_url);
    case "AUDIO":
      return Boolean(content.file_key || content.audio_url);
    case "EMBED":
      return Boolean(content.embed_html?.trim());
    default:
      return false;
  }
}

/* --- Rich text ------------------------------------------------------------ */

function richTextField(initialHtml) {
  const editable = el("div", {
    class: "control control--editable lesson-prose",
    contenteditable: "true",
    style: { minHeight: "8rem", padding: "0.75rem" },
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

  // Paste as plain text — a paste out of Word otherwise carries a stylesheet's
  // worth of inline markup into content the learner renderer trusts verbatim.
  editable.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  });

  return el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Content text"),
    toolbar,
    editable,
  ]);
}

/* --- Slide deck ----------------------------------------------------------- */

/**
 * `onChange` hands the caller the live `slides` array so `collectContent()` —
 * which runs outside this closure — can read the current edits when it saves.
 * The array reference is fixed for this editor's life (add/delete splice and
 * push, never reassign), so one notification per structural change is enough:
 * a slide's own field edits mutate that slide object in place and are already
 * visible through the same reference.
 */
function slideDeckEditor(content, onChange) {
  let slides = Array.isArray(content.slides) ? [...content.slides] : [];
  if (slides.length === 0) {
    slides = [{ id: "s1", title: "Slide 1", subtitle: "", bullets: [], notes: "" }];
  }
  onChange?.(slides);

  const slidesContainer = el("div", { class: "stack--sm" });

  const renderSlides = () => {
    onChange?.(slides);
    slidesContainer.replaceChildren(
      ...slides.map((slide, idx) =>
        el("div", {
          class: "stack--sm",
          style: {
            padding: "0.75rem",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
          },
        }, [
          el("div", { class: "row row--between" }, [
            el("span", { class: "badge badge--brand t-xs" }, `Slide ${idx + 1}`),
            button(icon("trash", 12), {
              variant: "ghost", size: "sm", "aria-label": "Delete slide",
              disabled: slides.length <= 1,
              onClick: () => { slides.splice(idx, 1); renderSlides(); },
            }),
          ]),
          el("input", {
            class: "control", placeholder: "Slide title",
            value: slide.title ?? "",
            onInput: (e) => { slide.title = e.target.value; },
          }),
          el("input", {
            class: "control", placeholder: "Subtitle (optional)",
            value: slide.subtitle ?? "",
            onInput: (e) => { slide.subtitle = e.target.value; },
          }),
          el("textarea", {
            class: "control", rows: 3, placeholder: "Bullet points (one per line)",
            onInput: (e) => { slide.bullets = e.target.value.split("\n").filter(Boolean); },
          }, (slide.bullets ?? []).join("\n")),
          el("input", {
            class: "control", placeholder: "Speaker notes (optional)",
            value: slide.notes ?? "",
            onInput: (e) => { slide.notes = e.target.value; },
          }),
        ])),
    );
  };

  renderSlides();

  return el("div", { class: "field" }, [
    el("label", { class: "field__label" }, "Slides"),
    slidesContainer,
    el("div", { class: "mt-3" }, button([icon("plus", 12), "Add slide"], {
      variant: "secondary", size: "sm",
      onClick: () => {
        slides.push({ id: `s${Date.now()}`, title: `Slide ${slides.length + 1}`, subtitle: "", bullets: [], notes: "" });
        renderSlides();
      },
    })),
  ]);
}

/* --- Fields per block type ------------------------------------------------ */

/**
 * The editing controls for one block.
 *
 * `imagePreviewUrl` is a already-signed URL the caller resolved up front —
 * this function is synchronous so the dock can render in one frame.
 * `onSlidesChange` only fires for SLIDES; see slideDeckEditor() above.
 */
export function blockFields(blockType, content, { imagePreviewUrl, onSlidesChange } = {}) {
  switch (blockType) {
    case "SLIDES":
      return [slideDeckEditor(content, onSlidesChange)];

    case "TEXT":
      return [richTextField(content.html ?? "")];

    case "IMAGE":
      return [
        imagePreviewUrl
          ? el("img", {
              src: imagePreviewUrl,
              alt: "",
              style: {
                width: "100%", borderRadius: "var(--radius-md)",
                border: "1px solid var(--line)", marginBottom: "0.75rem",
              },
            })
          : null,
        el("div", { class: "field" }, [
          el("label", { class: "field__label" }, content.file_key ? "Replace image" : "Upload picture"),
          el("input", { class: "control", type: "file", name: "file", accept: "image/*" }),
        ]),
        field({ label: "Alt text", name: "alt", value: content.alt ?? "", hint: "Describes the image to screen readers." }),
        field({ label: "Caption", name: "caption", value: content.caption ?? "" }),
      ];

    case "VIDEO":
      return [
        field({
          label: "Video embed URL", name: "embedUrl", type: "url",
          value: content.embed_url ?? "",
          placeholder: "https://player.vimeo.com/video/…",
        }),
        el("div", { class: "field" }, [
          el("label", { class: "field__label" }, "…or upload a video file"),
          el("input", { class: "control", type: "file", name: "file", accept: "video/*" }),
          el("p", { class: "field__hint" },
            content.file_key ? "A video file is attached. Uploading replaces it." : "Stored securely for enrolled learners."),
        ]),
      ];

    case "AUDIO":
      return [
        field({ label: "Audio title", name: "audioTitle", value: content.title ?? "" }),
        field({ label: "Narrator / speaker", name: "speaker", value: content.speaker ?? "" }),
        el("div", { class: "field" }, [
          el("label", { class: "field__label" }, "Upload audio file"),
          el("input", { class: "control", type: "file", name: "file", accept: "audio/*" }),
          el("p", { class: "field__hint" },
            content.file_key ? "An audio track is attached. Uploading replaces it." : "Hosted securely for enrolled learners."),
        ]),
      ];

    case "EMBED":
      return [
        field({
          label: "Embed code (iframe)", name: "embedHtml", as: "textarea", rows: 6,
          value: content.embed_html ?? "",
          placeholder: '<iframe src="https://h5p.org/…" width="100%" height="400"></iframe>',
          hint: "Paste an iframe from H5P, Canva, Genially, Figma or Loom.",
        }),
      ];

    default:
      return [];
  }
}

/**
 * Read the edited fields back out into the `content` jsonb to persist.
 *
 * Returns `{ ok: false, error }` rather than throwing so the caller can put
 * the message in the form's own message slot. `upload(file, prefix)` is
 * injected — the builder binds it to the programme the lesson belongs to,
 * which is what scopes the storage key.
 */
export async function collectContent({ form, blockType, content, upload, liveSlides }) {
  const next = { ...content };

  switch (blockType) {
    case "TEXT": {
      const editable = form.querySelector(".control--editable");
      return { ok: true, content: { html: editable?.innerHTML ?? "" } };
    }

    case "SLIDES":
      return { ok: true, content: { slides: liveSlides ?? content.slides ?? [] } };

    case "IMAGE": {
      const file = form.elements.file?.files?.[0];
      if (file) {
        const key = await upload(file, "images");
        if (!key) return { ok: false, error: "That image upload was refused." };
        next.file_key = key;
      }
      next.alt = form.elements.alt?.value.trim() ?? "";
      next.caption = form.elements.caption?.value.trim() ?? "";
      return { ok: true, content: next };
    }

    case "VIDEO": {
      // Embed and hosted file are mutually exclusive: whichever the author
      // supplied replaces the content wholesale, so a leftover embed_url can
      // never shadow a video they just uploaded.
      const file = form.elements.file?.files?.[0];
      const embedUrl = form.elements.embedUrl?.value.trim() ?? "";
      if (file) {
        const key = await upload(file, "videos");
        if (!key) return { ok: false, error: "That video upload was refused." };
        return { ok: true, content: { file_key: key } };
      }
      if (embedUrl) return { ok: true, content: { embed_url: embedUrl } };
      return { ok: true, content: next };
    }

    case "AUDIO": {
      const file = form.elements.file?.files?.[0];
      if (file) {
        const key = await upload(file, "audio");
        if (!key) return { ok: false, error: "That audio upload was refused." };
        next.file_key = key;
      }
      next.title = form.elements.audioTitle?.value.trim() ?? "";
      next.speaker = form.elements.speaker?.value.trim() ?? "";
      return { ok: true, content: next };
    }

    case "EMBED":
      return { ok: true, content: { embed_html: form.elements.embedHtml?.value.trim() ?? "" } };

    default:
      return { ok: true, content: next };
  }
}
