import { el, rawHtml } from "../dom.js";
import { card, cardBody } from "../ui.js";
import { signedUrl } from "../supabase.js";

/**
 * Turns lesson content into DOM. Shared by the learner-facing lesson page and
 * the admin lesson editor's preview pane, so "what the learner sees" and
 * "what the preview shows" can never drift apart into two implementations.
 */

/** A lesson carries either a third-party embed or a file we host ourselves. */
export async function videoPlayer(lesson) {
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

/** One lesson_blocks row → a rendered node. */
export async function renderBlock(block, lesson) {
  const content = block.content ?? {};
  switch (block.block_type) {
    case "TEXT":
      // Authored by WHA administrators in the admin panel, not by learners —
      // the same trust boundary as the legacy body_html field.
      return card(cardBody(rawHtml(content.html, "lesson-prose")));

    case "IMAGE": {
      const url = await signedUrl("lesson-media", content.file_key, 3600);
      if (!url) {
        return card(cardBody(el("p", { class: "subtle t-sm" },
          "That image could not be loaded.")));
      }
      return el("figure", { class: "lesson-image" }, [
        el("img", { src: url, alt: content.alt ?? "" }),
        content.caption ? el("figcaption", {}, content.caption) : null,
      ]);
    }

    case "VIDEO":
      // Reuses the same player as the legacy VIDEO lesson type — a block's
      // video content is shaped identically (embed_url XOR file_key).
      return videoPlayer({
        video_embed_url: content.embed_url ?? null,
        video_file_key: content.file_key ?? null,
        title: lesson.title,
      });

    case "EMBED":
      // Admin-pasted third-party iframe/embed — same trust boundary as TEXT.
      return el("div", { class: "embed-frame" }, rawHtml(content.embed_html, null));

    default:
      return null;
  }
}
