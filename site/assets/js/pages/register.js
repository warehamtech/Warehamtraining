import { $, el, mount, page } from "../dom.js";
import { renderPublicHeader, renderFooter } from "../shell.js";
import { setFieldErrors, setFormMessage, setPending, card, cardBody, buttonLink } from "../ui.js";
import { icon } from "../icons.js";
import { getUser, signUp, nextAfterLogin } from "../session.js";

/** Port of src/app/(auth)/register/ — page + register-form. */

function validate({ name, email, password }) {
  const errors = {};
  if (name.length < 2) errors.name = "Enter your full name";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "Enter a valid email address";
  if (password.length < 8) errors.password = "Use at least 8 characters";
  else if (password.length > 200) errors.password = "That password is too long";
  return errors;
}

page(async () => {
  renderFooter();
  renderPublicHeader();

  const existing = await getUser();
  if (existing) {
    location.replace(nextAfterLogin(existing.role));
    return;
  }

  const next = new URLSearchParams(location.search).get("next");
  if (next) {
    $("#login-link").href = `/login.html?next=${encodeURIComponent(next)}`;
  }

  const form = $("#register-form");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const values = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim().toLowerCase(),
      jobTitle: form.elements.jobTitle.value.trim(),
      password: form.elements.password.value,
    };

    const errors = validate(values);
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);
    const result = await signUp(values);
    setPending(form, false);

    if (!result.ok) {
      if (result.fieldErrors) setFieldErrors(form, result.fieldErrors);
      if (result.error) setFormMessage(form, result.error);
      return;
    }

    // With "Confirm email" enabled in Supabase Auth there is no session yet,
    // so sending them to the dashboard would just bounce them to /login.
    if (result.needsConfirmation) {
      mount("#app",
        el("div", { class: "auth-card" },
          card(cardBody([
            el("div", { class: "verify-mark" }, icon("mail", 24)),
            el("h1", { class: "display t-2xl center mt-4" }, "Check your inbox"),
            el("p", { class: "muted center mt-2" }, [
              "We've sent a confirmation link to ",
              el("strong", {}, values.email),
              ". Open it to finish setting up your account.",
            ]),
            el("p", { class: "subtle t-sm center mt-4" },
              "Nothing after a few minutes? Check your spam folder, or call us on (021) 713-2380."),
            el("div", { class: "center mt-6" },
              buttonLink("Back to sign in", "/login.html", { variant: "secondary" })),
          ]))));
      return;
    }

    const user = await getUser({ refresh: true });
    location.href = nextAfterLogin(user?.role ?? "LEARNER");
  });
});
