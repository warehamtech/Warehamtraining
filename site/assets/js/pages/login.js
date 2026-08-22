import { el, mount } from "../dom.js";
import { renderPublicHeader, renderFooter } from "../shell.js";
import { setFormMessage, setPending } from "../ui.js";
import { getUser, signIn, resetPassword, nextAfterLogin } from "../session.js";

/** Port of src/app/(auth)/login/ — page + login-form. */

export async function init() {
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
  const registerHref = next
    ? `/register.html?next=${encodeURIComponent(next)}`
    : "/register.html";

  const form = el("form", { id: "login-form", novalidate: true }, [
    el("div", { "data-message": "" }),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "email" }, ["Email", el("span", { class: "field__required" }, "*")]),
      el("input", {
        class: "control", id: "email", name: "email", type: "email", required: true,
        autocomplete: "email", autocapitalize: "off", spellcheck: "false",
      }),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "password" }, ["Password", el("span", { class: "field__required" }, "*")]),
      el("input", {
        class: "control", id: "password", name: "password", type: "password",
        required: true, autocomplete: "current-password",
      }),
    ]),
    el("div", { class: "row row--between" },
      el("button", { class: "link t-sm", type: "button", id: "forgot" }, "Forgotten your password?")),
    el("button", { class: "btn btn--primary btn--block", type: "submit" }, "Sign in"),
  ]);

  mount("#app", el("div", { class: "auth-card" }, [
    el("div", { class: "center" }, [
      el("a", { href: "/", "aria-label": "Wareham & Associates home" },
        el("img", {
          src: "/assets/brand/wha-logo.png", alt: "Wareham & Associates",
          width: "160", height: "62", style: { width: "160px", height: "auto", margin: "0 auto" },
        })),
      el("h1", { class: "display t-2xl mt-6" }, "Sign in"),
      el("p", { class: "muted t-sm mt-2" }, "Welcome back. Pick up where you left off."),
    ]),
    el("section", { class: "card mt-6" }, el("div", { class: "card__body" }, form)),
    el("p", { class: "auth-foot" }, [
      "Don't have an account? ",
      el("a", { class: "link", href: registerHref }, "Create one"),
    ]),
  ]));

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

  form.querySelector("#forgot").addEventListener("click", async () => {
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
}
