import { el, mount } from "../dom.js";
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

export async function init() {
  renderFooter();
  renderPublicHeader();

  const existing = await getUser();
  if (existing) {
    location.replace(nextAfterLogin(existing.role));
    return;
  }

  const next = new URLSearchParams(location.search).get("next");
  const loginHref = next ? `/login.html?next=${encodeURIComponent(next)}` : "/login.html";

  const form = el("form", { id: "register-form", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "name" }, ["Full name", el("span", { class: "field__required" }, "*")]),
      el("input", { class: "control", id: "name", name: "name", required: true, autocomplete: "name" }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "email" }, ["Email", el("span", { class: "field__required" }, "*")]),
      el("input", {
        class: "control", id: "email", name: "email", type: "email", required: true,
        autocomplete: "email", autocapitalize: "off", spellcheck: "false",
      }),
      el("p", { class: "field__hint" }, "Your invoice and certificate are sent here."),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "jobTitle" }, "Job title"),
      el("input", { class: "control", id: "jobTitle", name: "jobTitle", autocomplete: "organization-title" }),
      el("p", { class: "field__hint" }, "Optional. Printed on your certificate if given."),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "password" }, ["Password", el("span", { class: "field__required" }, "*")]),
      el("input", {
        class: "control", id: "password", name: "password", type: "password",
        required: true, autocomplete: "new-password", minlength: "8",
      }),
      el("p", { class: "field__hint" }, "At least 8 characters."),
    ]),
    el("button", { class: "btn btn--primary btn--block", type: "submit" }, "Create account"),
  ]);

  mount("#app", el("div", { class: "auth-card" }, [
    el("div", { class: "center" }, [
      el("a", { href: "/", "aria-label": "Wareham & Associates home" },
        el("img", {
          src: "/assets/brand/wha-logo.png", alt: "Wareham & Associates",
          width: "160", height: "62", style: { width: "160px", height: "auto", margin: "0 auto" },
        })),
      el("h1", { class: "display t-2xl mt-6" }, "Create your account"),
      el("p", { class: "muted t-sm mt-2" },
        "You will need one to enrol, track your progress and download your certificate."),
    ]),
    el("section", { class: "card mt-6" }, el("div", { class: "card__body" }, form)),
    el("p", { class: "auth-foot" }, [
      "Already have an account? ",
      el("a", { class: "link", href: loginHref }, "Sign in"),
    ]),
  ]));

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
}
