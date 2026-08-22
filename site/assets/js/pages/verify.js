import { el, mount, $ } from "../dom.js";
import { icon } from "../icons.js";
import { autoChrome } from "../shell.js";

/** Port of src/app/(public)/verify/page.tsx — the code entry form. */

export async function init() {
  autoChrome();

  // Same markup build/prerender.mjs bakes into site/verify/index.html for
  // crawlers — that copy is static (no JS ever runs there, see the comment
  // in that file), this is the one that's actually interactive.
  mount("#app", [
    el("div", { class: "center" }, [
      el("span", { class: "verify-mark" }, icon("shieldCheck", 24)),
      el("h1", { class: "display t-2xl mt-4" }, "Verify a certificate"),
      el("p", { class: "muted mt-2" },
        "Enter the verification code printed on the certificate, or scan its QR " +
        "code, to confirm it was issued by Wareham & Associates."),
    ]),
    el("section", { class: "card mt-8" },
      el("div", { class: "card__body" },
        el("form", { id: "verify-form", class: "stack", autocomplete: "off" }, [
          el("div", { class: "field" }, [
            el("label", { class: "field__label", for: "code" }, [
              "Verification code",
              el("span", { class: "field__required" }, "*"),
            ]),
            el("input", {
              class: "control code-input", id: "code", name: "code", required: true,
              spellcheck: "false", placeholder: "XXXX-XXXX-XXXX", maxlength: "14",
            }),
            el("p", { class: "field__hint" }, "For example: A7K2-M9PQ-3XTR"),
          ]),
          el("button", { class: "btn btn--primary btn--lg btn--block", type: "submit" },
            "Verify certificate"),
        ]))),
  ]);

  const form = $("#verify-form");
  const input = form.elements.code;

  // Group as the certificate prints it, so a code typed straight off the paper
  // matches what is on screen. verify_certificate() ignores dashes and case
  // anyway, but the field should not fight the person filling it in.
  input.addEventListener("input", () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    input.value = raw.replace(/(.{4})(?=.)/g, "$1-");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    location.href = `/verify/certificate.html?code=${encodeURIComponent(code)}`;
  });
}
