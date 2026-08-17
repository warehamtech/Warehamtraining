import { el, mount, page, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, emptyState, formError,
} from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap, rpc } from "../supabase.js";
import { getProgressForEnrollments } from "../progress.js";
import { downloadCertificate } from "../pdf.js";

/** Port of src/app/(app)/certificates/ — page + claim-button. */

function issuedCard(certificate, program) {
  return card([
    el("div", { class: "cert-head" }, [
      el("span", { class: "cert-seal" }, icon("award", 24)),
      el("div", { class: "grow" }, [
        el("p", { class: "medium" }, certificate.program_title),
        el("p", { class: "t-sm" }, `Issued ${formatDate(certificate.issued_at)}`),
      ]),
    ]),
    cardBody([
      el("dl", { class: "dl" }, [
        el("div", {}, [
          el("dt", {}, "Serial"),
          el("dd", { class: "tabular" }, certificate.serial),
        ]),
        el("div", {}, [
          el("dt", {}, "Verification code"),
          el("dd", { class: "tabular" }, certificate.verify_code),
        ]),
        program?.standard
          ? el("div", {}, [el("dt", {}, "Standard"), el("dd", {}, program.standard)])
          : null,
      ]),

      el("div", { class: "row row--wrap mt-4" }, [
        button([icon("download", 16), "Download PDF"], {
          onClick: (event) => downloadCertificate(certificate.id, event.currentTarget),
        }),
        buttonLink([icon("shieldCheck", 16), "Public verification page"],
          `/verify/certificate.html?code=${encodeURIComponent(certificate.verify_code)}`,
          { variant: "secondary" }),
      ]),

      el("p", { class: "subtle t-xs mt-3" },
        "Anyone can confirm this certificate is genuine using the verification code — " +
        "share it with an auditor or a prospective employer."),
    ]),
  ], { className: "cert-card" });
}

/** A finished programme whose certificate has not been minted yet. */
function claimCard({ enrollment, progress }, onClaimed) {
  const errorSlot = el("div", {});

  const claim = button([icon("award", 16), "Claim my certificate"], {
    variant: "accent",
    onClick: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      target.replaceChildren(el("span", { class: "btn__spinner" }), "Issuing…");
      errorSlot.replaceChildren();

      const result = await rpc("issue_certificate", { p_enrollment_id: enrollment.id });

      if (!result.ok) {
        target.disabled = false;
        target.replaceChildren(icon("award", 16), "Claim my certificate");
        errorSlot.replaceChildren(el("div", { class: "mt-3" }, formError(result.error)));
        return;
      }
      onClaimed();
    },
  });

  return card(cardBody([
    el("div", { class: "row row--wrap" }, [
      el("span", { class: "claim-banner__mark" }, icon("award", 24)),
      el("div", { class: "grow" }, [
        el("p", { class: "medium" }, progress.programTitle),
        el("p", { class: "muted t-sm" },
          `All ${progress.totalCourses} courses complete — your certificate is ready to issue.`),
      ]),
      claim,
    ]),
    errorSlot,
  ]), { className: "claim-card" });
}

async function render(user) {
  const [certificates, enrollments] = await Promise.all([
    sb.from("certificates")
      .select(`
        id, serial, verify_code, learner_name, program_title, issued_at, revoked_at,
        enrollment:enrollments!inner ( id, user_id, program:programs ( standard ) )
      `)
      .eq("enrollment.user_id", user.id)
      .order("issued_at", { ascending: false })
      .then(unwrap),
    sb.from("enrollments")
      .select("id, status, program:programs ( title ), certificates ( id )")
      .eq("user_id", user.id)
      .neq("status", "REVOKED")
      .then(unwrap),
  ]);

  // Completed programmes with no certificate row yet.
  const uncertified = enrollments.filter((e) => !(e.certificates ?? []).length);
  const progressMap = await getProgressForEnrollments(uncertified.map((e) => e.id));
  const claimable = uncertified
    .map((enrollment) => ({ enrollment, progress: progressMap.get(enrollment.id) }))
    .filter((entry) => entry.progress?.complete);

  const live = certificates.filter((c) => !c.revoked_at);

  mount("#app",
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "My certificates"),
        el("p", {},
          "Certificates are issued once every course and assessment in a programme is complete."),
      ])),

    claimable.length
      ? el("div", { class: "stack--sm animate-rise mb-6" },
          claimable.map((entry) => claimCard(entry, () => render(user))))
      : null,

    live.length
      ? el("div", { class: "grid grid--halves mt-6" },
          live.map((certificate) =>
            issuedCard(certificate, certificate.enrollment?.program)))
      : claimable.length
        ? null
        : card(emptyState({
            iconName: "award",
            title: "No certificates yet",
            description:
              "Finish every lesson and pass each assessment in a programme, and your certificate will appear here.",
            action: buttonLink("Back to my learning", "/dashboard.html"),
          }), { className: "mt-6" }),

    certificates.some((c) => c.revoked_at)
      ? el("p", { class: "subtle t-sm mt-6" },
          "One or more of your certificates has been revoked and is not shown. " +
          "Contact us on (021) 713-2380 if you believe that is a mistake.")
      : null);
}

page(async () => {
  const user = await requireUser();
  appChrome(user);
  await render(user);
});
