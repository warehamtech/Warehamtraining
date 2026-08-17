import { el, mount, param, page } from "../dom.js";
import { icon } from "../icons.js";
import { renderPublicHeader, renderFooter } from "../shell.js";
import {
  buttonLink, card, cardBody, field, setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { rpc } from "../supabase.js";
import { getUser, signUp } from "../session.js";

/**
 * Port of src/app/(auth)/invite/[token]/ — page + invite-form.
 *
 * Two steps, because Supabase Auth owns the account: create the account with
 * the invited address, then redeem the token with accept_invite(), which sets
 * the organisation and claims a seat if the invite carried one. The RPC checks
 * that the signed-in address matches the invited one, so the token cannot be
 * used to attach an unrelated account to someone's organisation.
 */

function shell(children) {
  mount("#app", el("div", { class: "auth-card" }, children));
}

function invalid(message) {
  shell(card(cardBody([
    el("div", { class: "verify-mark" }, icon("alert", 24)),
    el("h1", { class: "display t-2xl center mt-4" }, "This invitation isn't valid"),
    el("p", { class: "muted center mt-2" }, message),
    el("div", { class: "center mt-6" },
      buttonLink("Go to sign in", "/login.html", { variant: "secondary" })),
  ])));
}

page(async () => {
  renderFooter();
  renderPublicHeader();

  const token = param("token");
  if (!token) {
    invalid("The link is missing its invitation code. Ask your team administrator to send it again.");
    return;
  }

  const details = await rpc("invite_details", { p_token: token });
  if (!details?.valid) {
    invalid("It may have already been used, or it may have expired. Invitations last 14 days — ask your team administrator for a new one.");
    return;
  }

  // Already signed in as the invited person? Just redeem it.
  const existing = await getUser();
  if (existing && existing.email.toLowerCase() === details.email.toLowerCase()) {
    const claim = await rpc("accept_invite", { p_token: token });
    if (claim.ok) {
      location.replace("/dashboard.html");
      return;
    }
    invalid(claim.error);
    return;
  }

  const form = el("form", { novalidate: true, id: "invite-form" }, [
    el("div", { "data-message": "" }),
    field({
      label: "Email", name: "email", type: "email",
      value: details.email, readonly: true,
      hint: "The address your invitation was sent to.",
    }),
    field({ label: "Full name", name: "name", required: true, autocomplete: "name" }),
    field({
      label: "Job title", name: "jobTitle",
      autocomplete: "organization-title",
      hint: "Optional. Printed on your certificate if given.",
    }),
    field({
      label: "Choose a password", name: "password", type: "password",
      required: true, autocomplete: "new-password", minlength: 8,
      hint: "At least 8 characters.",
    }),
    el("button", { class: "btn btn--primary btn--block", type: "submit" },
      "Set up my account"),
  ]);

  shell([
    el("div", { class: "center" }, [
      el("h1", { class: "display t-2xl" }, "You've been invited"),
      el("p", { class: "muted mt-2" }, [
        el("strong", {}, details.organization_name),
        " has invited you to the Wareham & Associates learning portal.",
      ]),
      details.program_title
        ? el("p", { class: "muted t-sm mt-2" }, [
            "A seat on ", el("strong", {}, details.program_title),
            " is waiting for you.",
          ])
        : null,
    ]),
    card(cardBody(form), { className: "mt-6" }),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const name = form.elements.name.value.trim();
    const password = form.elements.password.value;
    const jobTitle = form.elements.jobTitle.value.trim();

    const errors = {};
    if (name.length < 2) errors.name = "Enter your full name";
    if (password.length < 8) errors.password = "Use at least 8 characters";
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);

    const signed = await signUp({ email: details.email, password, name, jobTitle });
    if (!signed.ok) {
      setPending(form, false);
      setFormMessage(form,
        signed.fieldErrors?.email
          ? "An account already exists for this address. Sign in, then open this link again."
          : signed.error);
      return;
    }

    if (signed.needsConfirmation) {
      setPending(form, false);
      shell(card(cardBody([
        el("div", { class: "verify-mark" }, icon("mail", 24)),
        el("h1", { class: "display t-2xl center mt-4" }, "Confirm your email"),
        el("p", { class: "muted center mt-2" }, [
          "We've sent a link to ", el("strong", {}, details.email),
          ". Open it, then return to this invitation link to claim your seat.",
        ]),
      ])));
      return;
    }

    const claim = await rpc("accept_invite", { p_token: token });
    setPending(form, false);

    if (!claim.ok) {
      // The account exists either way, so send them onward rather than
      // stranding them — a team admin can allocate the seat by hand.
      setFormMessage(form, `${claim.error} Your account was created — an administrator can allocate your seat.`);
      return;
    }

    location.href = "/dashboard.html";
  });
});
