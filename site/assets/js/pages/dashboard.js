import { el, mount, page, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, buttonLink, card, cardBody, cardFooter, cardHeader, emptyState, progressBar, progressRing,
} from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { getProgressForEnrollments, nextStepHref } from "../progress.js";
import { formatMoney } from "../money.js";
import { orderStatus } from "../config.js";

/** Port of src/app/(app)/dashboard/page.tsx. */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The one programme to resume, shown large at the top. */
function featuredCard({ enrollment, progress }) {
  const step = progress.nextStep;
  const label =
    progress.completedSteps === 0 ? "Start programme"
      : step.kind === "quiz" ? "Take assessment"
        : "Resume";

  return card([
    el("div", { class: "resume-head" }, [
      el("p", { class: "resume-eyebrow" }, "Continue learning"),
      el("h2", { class: "display t-xl medium mt-1" }, enrollment.program.title),
    ]),
    cardBody([
      el("div", { class: "row row--wrap row--between", style: { alignItems: "flex-end" } }, [
        el("div", {}, [
          el("p", { class: "tabular t-3xl medium" }, `${progress.percent}%`),
          el("p", { class: "tabular subtle t-sm mt-1" },
            `${progress.completedLessons} of ${progress.totalLessons} lessons · ` +
            `${progress.passedAssessments} of ${progress.totalAssessments} assessments`),
        ]),
        buttonLink([icon("monitorPlay", 18), label], nextStepHref(progress), { size: "lg" }),
      ]),

      progressBar(progress.percent, {
        size: "lg",
        className: "mt-4",
        label: `${enrollment.program.title} progress`,
      }),

      step.kind !== "done"
        ? el("p", { class: "row muted t-sm mt-3" }, [
            icon(step.kind === "quiz" ? "graduationCap" : "bookOpen", 16,
              { class: step.kind === "quiz" ? "i-accent" : "i-brand" }),
            `Next: ${step.title}`,
          ])
        : null,
    ]),
  ], { className: "resume-card mt-6" });
}

function programTile({ enrollment, progress }) {
  return el("a", { href: nextStepHref(progress), class: "program-card" }, [
    el("div", { class: "row", style: { alignItems: "flex-start" } }, [
      progressRing(progress.percent, {
        size: 44,
        tone: progress.complete ? "success" : "brand",
      }),
      el("div", { style: { minWidth: "0" } }, [
        enrollment.program.standard
          ? el("p", { class: "subtle t-xs" }, enrollment.program.standard)
          : null,
        el("h3", { class: "medium" }, enrollment.program.title),
      ]),
    ]),
    el("p", { class: "tabular subtle t-xs mt-3" },
      `${progress.completedLessons} of ${progress.totalLessons} lessons`),
    progressBar(progress.percent, {
      size: "sm",
      tone: progress.complete ? "success" : "brand",
      className: "mt-2",
    }),
    progress.complete
      ? el("div", { class: "mt-3" }, badge([icon("award", 14), "Complete"], "success"))
      : null,
  ]);
}

function pendingOrderRow(order) {
  const state = orderStatus[order.status];
  return el("li", { class: "row row--wrap order-row" }, [
    icon("receipt", 16, { class: "i-subtle" }),
    el("div", { class: "grow" }, [
      el("a", { href: `/orders/order.html?id=${order.id}`, class: "medium" },
        order.program.title),
      el("p", { class: "tabular subtle t-xs" },
        `${order.invoice_number} · ${formatMoney(order.total_cents)} · due ${formatDate(order.due_at)}`),
    ]),
    badge(state.label, state.tone),
    buttonLink(order.status === "PENDING" ? "Upload proof" : "View",
      `/orders/order.html?id=${order.id}`, { variant: "secondary", size: "sm" }),
  ]);
}

page(async () => {
  const user = await requireUser();
  appChrome(user);

  const [enrollments, pendingOrders] = await Promise.all([
    sb.from("enrollments")
      .select(`
        id, status, activated_at,
        program:programs ( title, slug, standard ),
        certificates ( id, serial )
      `)
      .eq("user_id", user.id)
      .in("status", ["ACTIVE", "COMPLETED"])
      .order("activated_at", { ascending: false })
      .then(unwrap),
    sb.from("orders")
      .select("id, invoice_number, total_cents, due_at, status, program:programs ( title )")
      .eq("user_id", user.id)
      .in("status", ["PENDING", "PROOF_SUBMITTED"])
      .order("issued_at", { ascending: false })
      .then(unwrap),
  ]);

  const progressMap = await getProgressForEnrollments(enrollments.map((e) => e.id));

  const inFlight = enrollments
    .map((enrollment) => ({ enrollment, progress: progressMap.get(enrollment.id) }))
    .filter((entry) => entry.progress);

  // "Continue learning" surfaces the most recently touched programme that
  // still has something left to do.
  const resumable = inFlight.filter((entry) => !entry.progress.complete);
  const featured = resumable[0];
  const rest = featured
    ? inFlight.filter((entry) => entry.enrollment.id !== featured.enrollment.id)
    : inFlight;

  const newlyCompleted = inFlight.filter(
    (entry) => entry.progress.complete && !(entry.enrollment.certificates ?? []).length,
  );

  mount("#app",
    el("h1", { class: "display t-2xl" },
      `${greeting()}, ${(user.name ?? "").split(" ")[0]}`),
    el("p", { class: "subtle t-sm mt-1" },
      resumable.length > 0 ? "Pick up where you left off."
        : inFlight.length > 0 ? "You're all caught up."
          : "Your training will appear here once it's activated."),

    // Certificate ready to claim.
    newlyCompleted.length
      ? el("div", { class: "stack--sm animate-rise mt-6" },
          newlyCompleted.map(({ enrollment }) =>
            el("div", { class: "claim-banner" }, [
              el("span", { class: "claim-banner__mark animate-pop" }, icon("award", 24)),
              el("div", { class: "grow" }, [
                el("p", { class: "medium" }, `You've completed ${enrollment.program.title}`),
                el("p", { class: "muted t-sm" }, "Your certificate is ready to download."),
              ]),
              buttonLink("Claim certificate", "/certificates.html", { variant: "accent" }),
            ])))
      : null,

    featured ? featuredCard(featured) : null,

    rest.length
      ? el("section", { class: "mt-8" }, [
          el("h2", { class: "section-label" },
            featured ? "Your other programmes" : "Your programmes"),
          el("div", { class: "grid grid--cards mt-3" }, rest.map(programTile)),
        ])
      : null,

    inFlight.length === 0 && pendingOrders.length === 0
      ? card(emptyState({
          iconName: "bookOpen",
          title: "No active training yet",
          description:
            "Browse the catalogue to enrol on a programme. Once your payment is confirmed, your courses appear here.",
          action: buttonLink("Browse the catalogue", "/programs/index.html"),
        }), { className: "mt-6" })
      : null,

    pendingOrders.length
      ? card([
          cardHeader("Awaiting activation", {
            description: "These orders unlock as soon as payment is confirmed.",
          }),
          el("ul", { class: "divided" }, pendingOrders.map(pendingOrderRow)),
          cardFooter(el("a", { class: "link t-sm", href: "/invoices.html" }, "View all invoices →")),
        ], { className: "mt-8" })
      : null);
});
