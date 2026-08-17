import { el, mount, page, formatDate, relativeDays } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { badge, buttonLink, card, cardHeader, emptyState, stat, table } from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { orderStatus } from "../config.js";

/** Port of src/app/(app)/admin/orders/page.tsx — the review queue. */

const FILTERS = [
  { key: "queue", label: "Needs review", statuses: ["PROOF_SUBMITTED"] },
  { key: "open", label: "Awaiting payment", statuses: ["PENDING"] },
  { key: "paid", label: "Activated", statuses: ["PAID"] },
  { key: "all", label: "All", statuses: null },
];

function orderRow(order) {
  const state = orderStatus[order.status];
  const overdue = order.status !== "PAID" && new Date(order.due_at) < new Date();

  return el("tr", {}, [
    el("td", {}, [
      el("a", {
        class: "link medium tabular",
        href: `/admin/order.html?id=${order.id}`,
      }, order.invoice_number),
      el("p", { class: "subtle t-xs" }, order.program?.title),
    ]),
    el("td", {}, [
      el("p", { class: "medium" }, order.billing_name),
      el("p", { class: "subtle t-xs" }, order.billing_email),
    ]),
    el("td", { class: "tabular" }, String(order.seats)),
    el("td", { class: "tabular" }, formatMoney(order.total_cents)),
    el("td", {}, [
      el("p", { class: "tabular t-xs" }, formatDate(order.issued_at)),
      overdue
        ? el("p", { class: "t-xs medium", style: { color: "var(--danger)" } },
            `overdue ${relativeDays(order.due_at)}`)
        : el("p", { class: "subtle t-xs" }, `due ${relativeDays(order.due_at)}`),
    ]),
    el("td", {}, [
      badge(state.label, state.tone),
      (order.payment_proofs ?? []).length
        ? el("p", { class: "subtle t-xs mt-1 row" }, [
            icon("fileText", 12),
            `${order.payment_proofs.length} proof${order.payment_proofs.length === 1 ? "" : "s"}`,
          ])
        : null,
    ]),
    el("td", {},
      buttonLink(order.status === "PROOF_SUBMITTED" ? "Review" : "Open",
        `/admin/order.html?id=${order.id}`,
        { variant: order.status === "PROOF_SUBMITTED" ? "primary" : "secondary", size: "sm" })),
  ]);
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  const active = new URLSearchParams(location.search).get("filter") ?? "queue";
  const filter = FILTERS.find((f) => f.key === active) ?? FILTERS[0];

  let query = sb.from("orders")
    .select(`
      id, invoice_number, status, seats, total_cents, issued_at, due_at,
      billing_name, billing_email,
      program:programs ( title ),
      payment_proofs ( id )
    `)
    .order("issued_at", { ascending: false });

  if (filter.statuses) query = query.in("status", filter.statuses);

  const [orders, counts] = await Promise.all([
    query.then(unwrap),
    sb.from("orders").select("status").then(unwrap),
  ]);

  const tally = (status) => counts.filter((o) => o.status === status).length;

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Orders"),
        el("p", {}, "Review proof of payment and release seats."),
      ]),
    ]),

    el("dl", { class: "grid grid--quarters" }, [
      stat("Needs review", String(tally("PROOF_SUBMITTED"))),
      stat("Awaiting payment", String(tally("PENDING"))),
      stat("Activated", String(tally("PAID"))),
      stat("Cancelled", String(tally("CANCELLED"))),
    ]),

    el("nav", { class: "tabs mt-6", "aria-label": "Filter orders" },
      FILTERS.map((entry) =>
        el("a", {
          href: `/admin/orders.html?filter=${entry.key}`,
          class: "tab",
          "aria-current": entry.key === filter.key ? "page" : null,
        }, entry.label))),

    orders.length
      ? card([
          cardHeader(filter.label, {
            description: `${orders.length} ${orders.length === 1 ? "order" : "orders"}`,
          }),
          table(
            ["Invoice", "Billed to", "Seats", "Total", "Dates", "Status", ""],
            orders.map(orderRow)),
        ], { className: "mt-4" })
      : card(emptyState({
          iconName: "inbox",
          title: filter.key === "queue" ? "Nothing waiting for review" : "No orders here",
          description: filter.key === "queue"
            ? "Orders appear here as soon as a buyer uploads proof of payment."
            : "Try a different filter.",
        }), { className: "mt-4" }));
});
