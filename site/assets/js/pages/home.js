import { el, mount, page } from "../dom.js";
import { icon } from "../icons.js";
import { publicChrome } from "../shell.js";
import { emptyState } from "../ui.js";
import { listPrograms } from "../catalog.js";
import { programCard } from "../components/program-card.js";

/** Port of src/app/(public)/page.tsx. */

const trust = [
  {
    iconName: "shieldCheck",
    title: "ISO 9001 certified",
    body: "Our own management system is certified to the standard we train you on.",
  },
  {
    iconName: "award",
    title: "Approved BRCGS Training Partner",
    body: "Our Director of Food Safety is an approved BRCGS training partner.",
  },
  {
    iconName: "checkCircle",
    title: "100% certification success rate",
    body: "Every client we have guided through certification has achieved it.",
  },
];

const steps = [
  {
    iconName: "monitorPlay",
    title: "Choose a programme",
    body: "Browse the catalogue and pick the standard your team needs — for one learner or for a whole site.",
  },
  {
    iconName: "receipt",
    title: "Get an invoice",
    body: "Check out and a VAT invoice is issued immediately. Pay by EFT and upload your proof of payment.",
  },
  {
    iconName: "checkCircle",
    title: "Learn at your pace",
    body: "We activate your seats. Work through video, written and downloadable material, ticking off lessons as you go.",
  },
  {
    iconName: "award",
    title: "Earn your certificate",
    body: "Pass each course assessment and download a verifiable certificate of completion.",
  },
];

page(async () => {
  publicChrome();

  mount("#trust", trust.map((item) =>
    el("li", {}, [
      icon(item.iconName, 20),
      el("div", {}, [
        el("strong", {}, item.title),
        el("span", {}, item.body),
      ]),
    ])));

  mount("#steps", steps.map((step, index) =>
    el("li", { class: "step" }, [
      el("div", { class: "step__head" }, [
        el("span", { class: "step__num tabular" }, String(index + 1)),
        icon(step.iconName, 20),
      ]),
      el("h3", {}, step.title),
      el("p", {}, step.body),
    ])));

  // Only the catalogue needs the database; everything above renders instantly
  // from the HTML.
  try {
    const programs = await listPrograms(6);
    mount("#catalogue",
      programs.length
        ? el("div", { class: "grid grid--cards" }, programs.map(programCard))
        : el("p", { class: "empty--dashed", style: { padding: "2.5rem 1.25rem", textAlign: "center" } },
            "The catalogue is being prepared. Please check back shortly."));
  } catch (error) {
    console.error(error);
    mount("#catalogue", emptyState({
      iconName: "alert",
      title: "The catalogue could not be loaded",
      description: "Please refresh the page, or call us on (021) 713-2380.",
    }));
  }
});
