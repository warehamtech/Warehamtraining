import { el, mount, param, formatDate, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { autoChrome } from "../shell.js";
import { badge, buttonLink, card, cardBody } from "../ui.js";
import { rpc } from "../supabase.js";
import { company } from "../config.js";

/**
 * Port of src/app/(public)/verify/[code]/page.tsx.
 *
 * The lookup goes through verify_certificate(), which is anon-callable and
 * returns only the fields that confirm the certificate is genuine. The
 * `certificates` table itself is not readable here, so a valid code cannot be
 * used to walk the rest of the data.
 */

function banner(tone, title, subtitle) {
  return el("div", { class: `verify-banner verify-banner--${tone}` }, [
    icon(tone === "valid" ? "checkCircle" : "alert", 24),
    el("div", {}, [
      el("p", { class: "medium" }, title),
      el("p", { class: "t-sm" }, subtitle),
    ]),
  ]);
}

function detail(term, ...value) {
  return el("div", {}, [el("dt", { class: "verify-term" }, term), ...value.flat()]);
}

export async function init() {
  autoChrome();

  const code = param("code");
  if (!code) {
    location.replace("/verify/index.html");
    return;
  }

  const result = await rpc("verify_certificate", { p_code: code });

  if (!result?.found) {
    setTitle("Certificate not found");
    mount("#app",
      card([
        banner("invalid", "No certificate found", `We hold no record of code ${code}.`),
        cardBody([
          el("p", { class: "muted t-sm" },
            "Check the code and try again — the letters O, I and L are never used, " +
            "so a character that looks like one is a zero or a one."),
          el("div", { class: "row mt-6" }, [
            buttonLink("Try another code", "/verify/index.html", { variant: "secondary" }),
            buttonLink(`Contact ${company.tradingName}`, `mailto:${company.email}`,
              { variant: "ghost" }),
          ]),
        ]),
      ]));
    return;
  }

  if (result.revoked) {
    setTitle("Certificate revoked");
    mount("#app",
      card([
        banner("invalid", "This certificate has been revoked",
          `Serial ${result.serial} is no longer valid.`),
        cardBody(el("p", { class: "muted t-sm" },
          `The certificate was issued but has since been withdrawn. Please contact ${company.email} if you need to confirm the circumstances.`)),
      ]));
    return;
  }

  setTitle(`Certificate ${result.serial}`);

  const subtitle = [result.job_title, result.organization_name].filter(Boolean).join(" · ");

  mount("#app",
    card([
      banner("valid", "Certificate verified", `Issued by ${company.legalName}`),
      cardBody([
        el("dl", { class: "verify-details" }, [
          detail("Awarded to",
            el("dd", { class: "display t-2xl medium mt-1" }, result.learner_name),
            subtitle ? el("dd", { class: "subtle t-sm mt-1" }, subtitle) : []),

          detail("Programme",
            el("dd", { class: "t-lg medium mt-1", style: { color: "var(--brand-700)" } },
              result.program_title),
            result.standard ? el("dd", { class: "mt-2" }, badge(result.standard, "brand")) : []),

          (result.course_titles ?? []).length
            ? detail("Courses completed",
                el("dd", { class: "mt-2" },
                  el("ul", { class: "feature-list" },
                    result.course_titles.map((title) =>
                      el("li", {}, [icon("checkCircle", 16, { class: "i-success" }), title])))))
            : null,

          detail("Serial", el("dd", { class: "mt-1 tabular" }, result.serial)),
          detail("Issued", el("dd", { class: "mt-1 tabular" }, formatDate(result.issued_at))),
        ]),
      ]),
    ]),

    el("p", { class: "subtle t-sm center mt-6" }, [
      "Verified against the Wareham & Associates training register. ",
      el("a", { class: "link", href: "/verify/index.html" }, "Check another certificate"),
    ]));
}
