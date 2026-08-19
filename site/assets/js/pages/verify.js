import { $ } from "../dom.js";
import { icon } from "../icons.js";
import { publicChrome } from "../shell.js";

/** Port of src/app/(public)/verify/page.tsx — the code entry form. */

export async function init() {
  publicChrome();

  $("#mark")?.append(icon("shieldCheck", 24));

  const form = $("#verify-form");
  const input = form.elements.code;

  // Group as the certificate prints it, so a code typed straight off the paper
  // matches what is on screen. verify_certificate() ignores dashes and case
  // anyway, but the field should not fight the person filling it in.
  input.addEventListener("input", () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    input.value = raw.replace(/(.{4})(?=.)/g, "  publicChrome();

  $("#mark")?.append(icon("shieldCheck", 24));

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
-");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    location.href = `/verify/certificate.html?code=${encodeURIComponent(code)}`;
  });
}
