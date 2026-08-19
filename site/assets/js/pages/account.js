import { el, mount } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { button, card, cardBody, cardHeader, definitionList } from "../ui.js";
import { requireUser, signOut } from "../session.js";
import { roleLabels } from "../config.js";

/**
 * The account page behind "My details" in the user menu.
 *
 * Read-only: nothing in the portal edits a profile yet, and the columns that
 * matter — role and organisation — are set by an administrator rather than by
 * the person they describe. This is where someone checks which account they
 * are signed in as, and which organisation their seats belong to.
 */

export async function init() {
  const user = await requireUser();
  appChrome(user);

  mount("#app",
    el("div", { class: "page-head" }, [
      el("h1", { class: "display" }, "My details"),
      el("p", {}, "The account you are signed in as."),
    ]),

    card([
      cardHeader("Your account"),
      cardBody(definitionList([
        ["Name", user.name || "—"],
        ["Email", user.authEmail ?? user.email ?? "—"],
        user.job_title ? ["Job title", user.job_title] : null,
        ["Role", roleLabels[user.role] ?? user.role],
        user.organizationName ? ["Organisation", user.organizationName] : null,
      ])),
    ], { className: "mt-6" }),

    card([
      cardBody([
        el("p", { class: "muted t-sm" },
          "To change your name, role or organisation, contact us and we'll " +
          "update it for you."),
        el("div", { class: "mt-4" },
          button([icon("logOut", 16), "Log out"], {
            variant: "secondary",
            onClick: () => signOut(),
          })),
      ]),
    ], { className: "mt-6" }),
  );
}
