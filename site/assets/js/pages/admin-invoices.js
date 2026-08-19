import { el, mount } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { buttonLink, card, emptyState, stat } from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import {
  byUrgency, datesCell, invoiceCard, invoiceLinkCell, matchesSearch,
  overdueHint, searchBox, sortHandler, sortRows, statusCell, summarise,
  viewState, viewTabs,
} from "../invoices.js";

/**
 * The invoice tab: everything ever issued, opening on whatever still needs
 * an admin's attention. This replaces the old two-tab split (Orders, the
 * review queue; Invoices, the ledger) — both were the same `orders` rows
 * under different names, so this is that table once, in one place.
 */

const BASE = "/admin/invoices.html";

const ACTION_COLUMN = { label: "" };

function actionCell(order) {
  const reviewing = order.status === "PROOF_SUBMITTED";
  return el("td", {},
    buttonLink(reviewing ? "Review" : "Open", `/admin/order.html?id=${order.id}`,
      { variant: reviewing ? "primary" : "secondary", size: "sm" }));
}

function billedToCell(order) {
  const isCompany = order.buyer_type === "COMPANY";
  return el("td", {}, [
    el("p", { class: "medium row", style: { gap: "0.375rem" } }, [
      icon(isCompany ? "building" : "user", 13),
      order.billing_name,
    ]),
    el("p", { class: "subtle t-xs" }, order.billing_email),
  ]);
}

/* --- Attention cards -------------------------------------------------- */

const ATTENTION_COLUMNS = [
  { key: "invoice_number", label: "Invoice" },
  { key: "billing_name", label: "Billed to" },
  { key: "program", label: "Programme" },
  { key: "seats", label: "Seats" },
  { key: "total_cents", label: "Total" },
  { key: "issued_at", label: "Dates" },
  ACTION_COLUMN,
];

function attentionRow(order) {
  return el("tr", {}, [
    invoiceLinkCell(order, `/admin/order.html?id=${order.id}`),
    billedToCell(order),
    el("td", {}, order.program?.title ?? "—"),
    el("td", { class: "tabular" }, String(order.seats)),
    el("td", { class: "tabular medium" }, formatMoney(order.total_cents)),
    datesCell(order),
    actionCell(order),
  ]);
}

function attentionView(orders, sort, onSort) {
  const reviewQueue = orders
    .filter((o) => o.status === "PROOF_SUBMITTED")
    .sort(byUrgency);
  const awaitingPayment = orders
    .filter((o) => o.status === "PENDING")
    .sort(byUrgency);

  if (!reviewQueue.length && !awaitingPayment.length) {
    return card(emptyState({
      iconName: "checkCircle",
      title: "Nothing needs attention",
      description: "Every invoice is either paid or cancelled. Browse the full history in All.",
      action: buttonLink("View all invoices", viewHref("all")),
    }));
  }

  return el("div", { class: "grid", style: { gap: "1.5rem" } }, [
    reviewQueue.length
      ? invoiceCard({
          title: "Waiting on you",
          description: "Proof of payment uploaded — verify it and release the seats.",
          columns: ATTENTION_COLUMNS,
          orders: reviewQueue,
          sort, onSort,
          renderRow: attentionRow,
        })
      : null,
    awaitingPayment.length
      ? invoiceCard({
          title: "Waiting on the buyer",
          description: "Invoice issued, no proof of payment yet. Most overdue first.",
          columns: ATTENTION_COLUMNS,
          orders: awaitingPayment,
          sort, onSort,
          renderRow: attentionRow,
        })
      : null,
  ]);
}

function viewHref(viewKey) {
  const params = new URLSearchParams(location.search);
  if (viewKey === "attention") params.delete("view");
  else params.set("view", viewKey);
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
}

/* --- Ledger table (paid / cancelled / all) ----------------------------- */

const LEDGER_COLUMNS = [
  { key: "invoice_number", label: "Invoice", sortable: true },
  { key: "billing_name", label: "Billed to", sortable: true },
  { key: "program", label: "Programme", sortable: true },
  { key: "seats", label: "Seats", sortable: true },
  { key: "total_cents", label: "Total", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "issued_at", label: "Dates", sortable: true },
  ACTION_COLUMN,
];

function ledgerRow(order) {
  return el("tr", {}, [
    invoiceLinkCell(order, `/admin/order.html?id=${order.id}`),
    billedToCell(order),
    el("td", {}, order.program?.title ?? "—"),
    el("td", { class: "tabular" }, String(order.seats)),
    el("td", { class: "tabular medium" }, formatMoney(order.total_cents)),
    statusCell(order),
    datesCell(order),
    actionCell(order),
  ]);
}

function ledgerView(orders, view, sort, onSort) {
  if (!orders.length) {
    return card(emptyState({
      iconName: "receipt",
      title: "No invoices match",
      description: "Try a different search.",
    }));
  }

  return invoiceCard({
    title: view.label,
    description: `${orders.length} ${orders.length === 1 ? "invoice" : "invoices"}`,
    columns: LEDGER_COLUMNS,
    orders: sortRows(orders, sort),
    sort, onSort,
    renderRow: ledgerRow,
  });
}

/* --- Page --------------------------------------------------------------- */

export async function init() {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  const { view, sort } = viewState();
  const onSort = sortHandler(BASE, sort);

  const orders = await sb.from("orders")
    .select(`
      id, invoice_number, status, buyer_type, seats, total_cents,
      issued_at, due_at, paid_at,
      billing_name, billing_email,
      program:programs ( title ),
      payment_proofs ( id )
    `)
    .then(unwrap);

  const totals = summarise(orders);

  function render(searchTerm) {
    const term = searchTerm.trim().toLowerCase();
    const matching = orders.filter((o) => matchesSearch(o, term));

    let content;
    if (view.key === "attention") {
      content = attentionView(matching, sort, onSort);
    } else {
      const filtered = view.statuses
        ? matching.filter((o) => view.statuses.includes(o.status))
        : matching;
      content = ledgerView(filtered, view, sort, onSort);
    }

    mount("#invoice-view", content);
  }

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Invoices"),
        el("p", {}, "Everything issued, and everything still waiting on someone."),
      ]),
    ]),

    el("dl", { class: "grid grid--quarters" }, [
      stat("Needs your review", String(totals.needsReview)),
      stat("Awaiting payment", String(totals.awaitingPayment), overdueHint(totals.overdue)),
      stat("Outstanding", formatMoney(totals.outstanding)),
      stat("Collected", formatMoney(totals.collected)),
    ]),

    el("div", { class: "row row--between row--wrap mt-6", style: { alignItems: "center" } }, [
      viewTabs(BASE, view.key),
      searchBox(render, "Search invoice, name or email…"),
    ]),

    el("div", { id: "invoice-view", class: "mt-4" }));

  render("");
}
