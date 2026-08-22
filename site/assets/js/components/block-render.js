import { el, rawHtml } from "../dom.js";
import { icon } from "../icons.js";
import { card, cardBody } from "../ui.js";
import { signedUrl } from "../supabase.js";

/**
 * Turns lesson content into DOM. Shared by the learner-facing lesson page and
 * the admin lesson editor's preview pane, so "what the learner sees" and
 * "what the preview shows" can never drift apart into two implementations.
 */

/** Custom Audio Player component */
export async function audioPlayer(content, lesson) {
  let url = content.audio_url ?? null;
  if (!url && content.file_key) {
    url = await signedUrl("lesson-media", content.file_key, 3600);
  }

  if (!url) {
    return card(cardBody(el("p", { class: "subtle t-sm center", style: { padding: "1.5rem 0" } },
      "The audio clip for this lesson hasn't been uploaded yet.")));
  }

  const audio = new Audio(url);
  audio.preload = "metadata";

  const playIcon = icon("play", 18);
  const pauseIcon = icon("pause", 18);

  const playBtn = el("button", {
    class: "audio-player__play-btn",
    type: "button",
    "aria-label": "Play audio",
  }, playIcon);

  const timeLabel = el("span", { class: "audio-player__time tabular" }, "0:00 / 0:00");
  const trackBar = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: "0",
    class: "audio-player__slider",
    "aria-label": "Audio progress",
  });

  const speedBtn = el("button", {
    class: "btn btn--ghost btn--sm tabular",
    type: "button",
    style: { paddingInline: "0.5rem", fontWeight: "600" },
  }, "1x");

  const speeds = [1, 1.25, 1.5, 2];
  let speedIdx = 0;
  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speedBtn.textContent = `${speeds[speedIdx]}x`;
  });

  const formatSec = (sec) => {
    if (!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  playBtn.addEventListener("click", () => {
    if (audio.paused) {
      audio.play();
      playBtn.replaceChildren(pauseIcon);
      playBtn.setAttribute("aria-label", "Pause audio");
    } else {
      audio.pause();
      playBtn.replaceChildren(playIcon);
      playBtn.setAttribute("aria-label", "Play audio");
    }
  });

  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const progress = (audio.currentTime / audio.duration) * 100;
    trackBar.value = String(progress);
    timeLabel.textContent = `${formatSec(audio.currentTime)} / ${formatSec(audio.duration)}`;
  });

  audio.addEventListener("loadedmetadata", () => {
    timeLabel.textContent = `0:00 / ${formatSec(audio.duration)}`;
  });

  audio.addEventListener("ended", () => {
    playBtn.replaceChildren(playIcon);
    trackBar.value = "0";
  });

  trackBar.addEventListener("input", () => {
    if (!audio.duration) return;
    audio.currentTime = (Number(trackBar.value) / 100) * audio.duration;
  });

  return el("div", { class: "audio-player-card" }, [
    el("div", { class: "audio-player-card__head" }, [
      el("div", { class: "audio-player-card__icon" }, icon("volume2", 20)),
      el("div", { class: "audio-player-card__meta" }, [
        el("strong", {}, content.title || lesson?.title || "Audio Lesson"),
        content.speaker ? el("span", { class: "subtle t-xs" }, `Narrated by ${content.speaker}`) : null,
      ]),
    ]),
    el("div", { class: "audio-player-card__controls" }, [
      playBtn,
      trackBar,
      timeLabel,
      speedBtn,
    ]),
  ]);
}

/** Interactive Slide Deck Presentation component */
export async function slideDeck(slides = [], lesson) {
  if (!slides || slides.length === 0) {
    return card(cardBody(el("p", { class: "subtle t-sm center", style: { padding: "2rem 0" } },
      "No slides have been added yet.")));
  }

  let activeIndex = 0;
  const slideHost = el("div", { class: "slide-deck__canvas" });
  const countLabel = el("span", { class: "slide-deck__counter tabular" }, `1 / ${slides.length}`);
  const dotsContainer = el("div", { class: "slide-deck__dots" });
  const notesPanel = el("div", { class: "slide-deck__notes", hidden: true });

  const prevBtn = el("button", {
    class: "btn btn--secondary btn--sm",
    type: "button",
    "aria-label": "Previous slide",
  }, [icon("arrowLeft", 16), "Prev"]);

  const nextBtn = el("button", {
    class: "btn btn--primary btn--sm",
    type: "button",
    "aria-label": "Next slide",
  }, ["Next", icon("arrowRight", 16)]);

  const notesToggle = el("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
  }, [icon("fileText", 14), "Speaker Notes"]);

  notesToggle.addEventListener("click", () => {
    notesPanel.hidden = !notesPanel.hidden;
  });

  const renderSlideContent = async (slide) => {
    let imageEl = null;
    if (slide.image_file_key) {
      const url = await signedUrl("lesson-media", slide.image_file_key, 3600);
      if (url) imageEl = el("img", { src: url, alt: slide.title ?? "", class: "slide-card__img" });
    } else if (slide.image_url) {
      imageEl = el("img", { src: slide.image_url, alt: slide.title ?? "", class: "slide-card__img" });
    }

    const titleEl = slide.title ? el("h3", { class: "slide-card__title" }, slide.title) : null;
    const subtitleEl = slide.subtitle ? el("p", { class: "slide-card__subtitle" }, slide.subtitle) : null;

    let bodyEl = null;
    if (slide.bullets && Array.isArray(slide.bullets) && slide.bullets.length > 0) {
      bodyEl = el("ul", { class: "slide-card__bullets" },
        slide.bullets.map((b) => el("li", {}, b)));
    } else if (slide.body) {
      bodyEl = rawHtml(slide.body, "slide-card__body lesson-prose");
    }

    if (imageEl && (titleEl || bodyEl)) {
      return el("div", { class: "slide-card slide-card--split" }, [
        el("div", { class: "slide-card__content" }, [titleEl, subtitleEl, bodyEl]),
        el("div", { class: "slide-card__media" }, imageEl),
      ]);
    }

    return el("div", { class: "slide-card slide-card--standard" }, [
      imageEl,
      titleEl,
      subtitleEl,
      bodyEl,
    ]);
  };

  const updateSlide = async (newIndex) => {
    activeIndex = Math.max(0, Math.min(slides.length - 1, newIndex));
    prevBtn.disabled = activeIndex === 0;
    nextBtn.disabled = activeIndex === slides.length - 1;
    countLabel.textContent = `${activeIndex + 1} / ${slides.length}`;

    // Update dots
    [...dotsContainer.children].forEach((dot, idx) => {
      dot.className = idx === activeIndex ? "slide-deck__dot is-active" : "slide-deck__dot";
    });

    const currentSlide = slides[activeIndex];
    slideHost.replaceChildren(await renderSlideContent(currentSlide));

    if (currentSlide.notes) {
      notesPanel.replaceChildren(
        el("strong", {}, "Speaker Notes: "),
        el("span", {}, currentSlide.notes),
      );
      notesToggle.style.display = "inline-flex";
    } else {
      notesPanel.hidden = true;
      notesToggle.style.display = "none";
    }
  };

  prevBtn.addEventListener("click", () => updateSlide(activeIndex - 1));
  nextBtn.addEventListener("click", () => updateSlide(activeIndex + 1));

  slides.forEach((_, idx) => {
    const dot = el("button", {
      type: "button",
      class: idx === 0 ? "slide-deck__dot is-active" : "slide-deck__dot",
      "aria-label": `Go to slide ${idx + 1}`,
      onClick: () => updateSlide(idx),
    });
    dotsContainer.append(dot);
  });

  updateSlide(0);

  return el("div", { class: "slide-deck-container" }, [
    slideHost,
    el("div", { class: "slide-deck__toolbar" }, [
      prevBtn,
      dotsContainer,
      countLabel,
      nextBtn,
      notesToggle,
    ]),
    notesPanel,
  ]);
}

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
    case "SLIDES":
      return slideDeck(content.slides ?? [], lesson);

    case "AUDIO":
      return audioPlayer(content, lesson);

    case "TEXT":
      return card(cardBody(rawHtml(content.html, "lesson-prose")));

    case "IMAGE": {
      const url = content.file_key
        ? await signedUrl("lesson-media", content.file_key, 3600)
        : content.url ?? null;
      if (!url) {
        return card(cardBody(el("p", { class: "subtle t-sm" },
          "That image could not be loaded.")));
      }
      return el("figure", { class: "lesson-image" }, [
        el("img", { src: url, alt: content.alt ?? "", loading: "lazy", decoding: "async" }),
        content.caption ? el("figcaption", {}, content.caption) : null,
      ]);
    }

    case "VIDEO":
      return videoPlayer({
        video_embed_url: content.embed_url ?? null,
        video_file_key: content.file_key ?? null,
        title: lesson?.title ?? "Video",
      });

    case "EMBED":
      return el("div", { class: "embed-frame" }, rawHtml(content.embed_html, null));

    default:
      return null;
  }
}

