import { $, page } from "../dom.js";
import { renderPublicHeader, renderFooter } from "../shell.js";
import { setFormMessage, setPending } from "../ui.js";
import { getUser, signIn, resetPassword, nextAfterLogin } from "../session.js";

/** Port of src/app/(auth)/login/ — page + login-form. */

page(async () => {
  renderFooter();
  renderPublicHeader();

  // Already signed in? Go where they were heading.
  const existing = await getUser();
  if (existing) {
    location.replace(nextAfterLogin(existing.role));
    return;
  }

  // Carry `?next=` through to registration, so someone who signs up instead
  // still lands where they were going.
  const next = new URLSearchParams(location.search).get("next");
  if (next) {
    const link = $("#register-link");
    link.href = `/register.html?next=${encodeURIComponent(next)}`;
  }

  const form = $("#login-form");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const email = form.elements.email.value.trim().toLowerCase();
    const password = form.elements.password.value;

    if (!email || !password) {
      setFormMessage(form, "Enter your email address and password.");
      return;
    }

    setPending(form, true);
    const result = await signIn(email, password);
    setPending(form, false);

    if (!result.ok) {
      setFormMessage(form, result.error);
      return;
    }

    const user = await getUser({ refresh: true });
    location.href = nextAfterLogin(user?.role ?? "LEARNER");
  });

  $("#forgot").addEventListener("click", async () => {
    const email = form.elements.email.value.trim().toLowerCase();
    if (!email) {
      setFormMessage(form, "Enter your email address first, then choose this again.");
      form.elements.email.focus();
      return;
    }

    const result = await resetPassword(email);
    // Deliberately the same wording whether or not the address is on file, so
    // this cannot be used to find out who has an account.
    setFormMessage(
      form,
      result.ok
        ? `If ${email} has an account, a reset link is on its way.`
        : result.error,
      result.ok ? "success" : "error",
    );
  });
});
