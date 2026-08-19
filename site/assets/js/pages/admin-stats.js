import { el, mount } from "../dom.js";
import { appChrome } from "../shell.js";
import { badge, card, cardHeader, emptyState, stat, table } from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { enrollmentStatus } from "../config.js";

/**
 * Site visits, popular courses, revenue by programme, and enrollment status
 * by programme. Views/visits are windowed by the range filter (page_views
 * grows unboundedly); revenue and enrollment status are always all-time —
 * "how many are currently enrolled" is a present-state question, not a trend.
 */

const RANGE_FILTERS = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

const ENROLL_STATUSES = ["ACTIVE", "COMPLETED", "REVOKED"];

function programNameCell(program) {
  if (!program) return "—";
  return el("span", { class: "row", style: { gap: "0.375rem" } }, [
    program.title,
    program.published === false ? badge("Unpublished") : null,
  ]);
}

function rankCard(title, description, rows, { valueLabel, formatValue }) {
  if (!rows.length) {
    return card([
      cardHeader(title, { description }),
      emptyState({
        iconName: "inbox",
        title: "Nothing yet",
        description: "Numbers appear here once there's data to show.",
      }),
    ]);
  }
  return card([
    cardHeader(title, { description }),
    table(["Programme", valueLabel],
      rows.map((row) => el("tr", {}, [
        el("td", {}, programNameCell(row.program)),
        el("td", { class: "tabular medium" }, formatValue(row.value)),
      ]))),
  ]);
}

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  const activeRange = new URLSearchParams(location.search).get("range") ?? "30";
  const range = RANGE_FILTERS.find((r) => r.key === activeRange) ?? RANGE_FILTERS[1];
  const cutoffIso = range.days ? new Date(Date.now() - range.days * 86_400_000).toISOString() : null;

  let viewsQuery = sb.from("page_views").select("slug, session_id");
  if (cutoffIso) viewsQuery = viewsQuery.gte("created_at", cutoffIso);

  const [views, programs, orders, enrollments] = await Promise.all([
    viewsQuery.then(unwrap),
    sb.from("programs").select("id, title, slug, published").then(unwrap),
    sb.from("orders").select("program_id, status, total_cents").then(unwrap),
    sb.from("enrollments").select("program_id, status").then(unwrap),
  ]);

  const programById = new Map(programs.map((p) => [p.id, p]));
  const programBySlug = new Map(programs.map((p) => [p.slug, p]));

  // -- Visits & most-viewed (windowed by range) --------------------------
  const totalViews = views.length;
  const totalVisits = new Set(views.map((v) => v.session_id)).size;

  const viewsBySlug = new Map();
  for (const v of views) {
    if (!v.slug) continue;
    viewsBySlug.set(v.slug, (viewsBySlug.get(v.slug) ?? 0) + 1);
  }
  const mostViewed = [...viewsBySlug.entries()]
    .map(([slug, value]) => ({ program: programBySlug.get(slug), value }))
    .filter((row) => row.program)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // -- Revenue & best-selling (all-time, PAID only) -----------------------
  const revenueByProgram = new Map();
  const paidOrdersByProgram = new Map();
  for (const o of orders) {
    if (o.status !== "PAID") continue;
    revenueByProgram.set(o.program_id, (revenueByProgram.get(o.program_id) ?? 0) + o.total_cents);
    paidOrdersByProgram.set(o.program_id, (paidOrdersByProgram.get(o.program_id) ?? 0) + 1);
  }
  const revenueRows = [...revenueByProgram.entries()]
    .map(([programId, value]) => ({
      program: programById.get(programId),
      value,
      paidOrders: paidOrdersByProgram.get(programId) ?? 0,
    }))
    .filter((row) => row.program)
    .sort((a, b) => b.value - a.value);
  const bestSelling = revenueRows.slice(0, 10);
  const totalRevenue = revenueRows.reduce((sum, row) => sum + row.value, 0);

  // -- Enrollment status by programme (all-time) --------------------------
  const enrollByProgram = new Map();
  for (const e of enrollments) {
    const bucket = enrollByProgram.get(e.program_id) ?? { ACTIVE: 0, COMPLETED: 0, REVOKED: 0 };
    bucket[e.status] = (bucket[e.status] ?? 0) + 1;
    enrollByProgram.set(e.program_id, bucket);
  }
  const enrollRows = [...enrollByProgram.entries()]
    .map(([programId, bucket]) => ({
      program: programById.get(programId),
      bucket,
      total: ENROLL_STATUSES.reduce((sum, key) => sum + bucket[key], 0),
    }))
    .filter((row) => row.program)
    .sort((a, b) => b.total - a.total);

  const setParam = (key, value) => {
    const params = new URLSearchParams(location.search);
    if (value === null) params.delete(key);
    else params.set(key, value);
    return `/admin/stats.html?${params.toString()}`;
  };

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Statistics"),
        el("p", {}, "Traffic, popular courses, revenue and enrolment, at a glance."),
      ]),
    ]),

    el("dl", { class: "grid grid--quarters" }, [
      stat("Page views", String(totalViews)),
      stat("Visits", String(totalVisits)),
      stat("Programmes viewed", String(viewsBySlug.size)),
      stat("Revenue collected", formatMoney(totalRevenue)),
    ]),

    el("nav", { class: "tabs mt-6", "aria-label": "Filter by date range" },
      RANGE_FILTERS.map((entry) =>
        el("a", {
          href: setParam("range", entry.key === "30" ? null : entry.key),
          class: "tab",
          "aria-current": entry.key === range.key ? "page" : null,
        }, entry.label))),
    el("p", { class: "subtle t-xs mt-2" },
      "Views and visits are for the selected range. Revenue and enrolment are all-time."),

    el("div", { class: "grid grid--halves mt-6" }, [
      rankCard("Most viewed", "By programme page visits", mostViewed,
        { valueLabel: "Views", formatValue: String }),
      rankCard("Best selling", "By revenue collected", bestSelling,
        { valueLabel: "Revenue", formatValue: formatMoney }),
    ]),

    el("div", { class: "mt-6" },
      revenueRows.length
        ? card([
            cardHeader("Revenue by programme", {
              description: `${revenueRows.length} ${revenueRows.length === 1 ? "programme" : "programmes"} with paid invoices`,
            }),
            table(["Programme", "Revenue collected", "Paid invoices"],
              revenueRows.map((row) => el("tr", {}, [
                el("td", {}, programNameCell(row.program)),
                el("td", { class: "tabular medium" }, formatMoney(row.value)),
                el("td", { class: "tabular" }, String(row.paidOrders)),
              ]))),
          ])
        : card(emptyState({
            iconName: "receipt",
            title: "No revenue yet",
            description: "Paid invoices will show up here by programme.",
          }))),

    el("div", { class: "mt-6" },
      enrollRows.length
        ? card([
            cardHeader("Enrolment by programme"),
            table(
              ["Programme", enrollmentStatus.ACTIVE.label, enrollmentStatus.COMPLETED.label,
                enrollmentStatus.REVOKED.label, "Total"],
              enrollRows.map((row) => el("tr", {}, [
                el("td", {}, programNameCell(row.program)),
                el("td", { class: "tabular" }, String(row.bucket.ACTIVE)),
                el("td", { class: "tabular" }, String(row.bucket.COMPLETED)),
                el("td", { class: "tabular" }, String(row.bucket.REVOKED)),
                el("td", { class: "tabular medium" }, String(row.total)),
              ]))),
          ])
        : card(emptyState({
            iconName: "users",
            title: "No enrolments yet",
            description: "Seats appear here as soon as an order is activated.",
          }))));
}
