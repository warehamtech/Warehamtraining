import { el, formatDate, mount } from "../dom.js";
import { appChrome } from "../shell.js";
import { button, buttonLink, card, cardHeader, emptyState, stat } from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { downloadInvoice } from "../pdf.js";
import { icon } from "../icons.js";
import {
  datesCell, invoiceCard, invoiceLinkCell, matchesSearch, overdueHint,
  searchBox, sortHandler, sortRows, statusCell, summarise, viewState, viewTabs,
} from "../invoices.js";

/**
 * Your invoices: the buyer side of the same tab admins get at
 * /admin/invoices.html. Serves both a LEARNER (their own orders) and an
 * ORG_ADMIN (their own orders plus their organisation's), because both were
 * previously stuck with only a "pending" card on the dashboard and no way to
 * ever see a paid or cancelled invoice again. This is that history, plus
 * whatever still needs the buyer's action, in one place.
 */

const BASE = "/invoices.html";

const COLUMNS = [
  { key: "invoice_number", label: "Invoice", sortable: true },
  { key: "program", label: "Programme", sortable: true },
  { key: "seats", label: "Seats", sortable: true },
  { key: "total_cents", label: "Total", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "issued_at", label: "Dates", sortable: true },
  { label: "" },
];

function actionCell(order) {
  const needsProof = order.status === "PENDING";
  return el("td", { class: "row", style: { gap: "0.375rem" } }, [
    buttonLink(needsProof ? "Upload proof" : "View", `/orders/order.html?id=${order.id}`,
      { variant: needsProof ? "primary" : "secondary", size: "sm" }),
    button(icon("download", 16), {
      variant: "ghost",
      size: "sm",
      "aria-label": `Download ${order.invoice_number}`,
      onClick: (event) => downloadInvoice(order.id, order.invoice_number, event.currentTarget),
    }),
  ]);
}

function invoiceRow(order) {
  return el("tr", {}, [
    invoiceLinkCell(order, `/orders/order.html?id=${order.id}`),
    el("td", {}, order.program?.title ?? "—"),
    el("td", { class: "tabular" }, String(order.seats)),
    el("td", { class: "tabular medium" }, formatMoney(order.total_cents)),
    statusCell(order),
    datesCell(order),
    actionCell(order),
  ]);
}

function attentionView(orders) {
  const waitingOnYou = orders.filter((o) => o.status === "PENDING");
  const withWha = orders.filter((o) => o.status === "PROOF_SUBMITTED");

  if (!waitingOnYou.length && !withWha.length) {
    return card(emptyState({
      iconName: "checkCircle",
      title: "Nothing needs your attention",
      description: "No unpaid invoices right now. Browse your full history in All.",
      action: buttonLink("View all invoices", viewHref("all")),
    }));
  }

  return el("div", { class: "grid", style: { gap: "1.5rem" } }, [
    waitingOnYou.length
      ? card([
          cardHeader("Waiting on you", {
            description: "Pay by EFT using the invoice number as your reference, then upload your proof of payment.",
          }),
          el("ul", { class: "divided" }, waitingOnYou.map(pendingRow)),
        ])
      : null,
    withWha.length
      ? card([
          cardHeader("With WHA", {
            description: "We're checking your proof of payment. Seats open as soon as it clears.",
          }),
          el("ul", { class: "divided" }, withWha.map(pendingRow)),
        ])
      : null,
  ]);
}

function pendingRow(order) {
  const state = order.status;
  return el("li", { class: "row row--wrap order-row" }, [
    icon("receipt", 16, { class: "i-subtle" }),
    el("div", { class: "grow" }, [
      el("a", { href: `/orders/order.html?id=${order.id}`, class: "medium" },
        order.program?.title ?? order.invoice_number),
      el("p", { class: "tabular subtle t-xs" },
        `${order.invoice_number} · ${formatMoney(order.total_cents)} · due ${formatDate(order.due_at)}`),
    ]),
    buttonLink(state === "PENDING" ? "Upload proof" : "View", `/orders/order.html?id=${order.id}`,
      { variant: "secondary", size: "sm" }),
  ]);
}

function viewHref(viewKey) {
  const params = new URLSearchParams(location.search);
  if (viewKey === "attention") params.delete("view");
  else params.set("view", viewKey);
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
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
    columns: COLUMNS,
    orders: sortRows(orders, sort),
    sort, onSort,
    renderRow: invoiceRow,
  });
}

export async function init() {
  const user = await requireRole("LEARNER", "ORG_ADMIN");
  appChrome(user);

  const { view, sort } = viewState();
  const onSort = sortHandler(BASE, sort);

  let query = sb.from("orders").select(`
    id, invoice_number, status, seats, total_cents,
    issued_at, due_at, paid_at,
    program:programs ( title ),
    payment_proofs ( id )
  `);

  query = user.role === "ORG_ADMIN" && user.organization_id
    ? query.or(`user_id.eq.${user.id},organization_id.eq.${user.organization_id}`)
    : query.eq("user_id", user.id);

  const orders = await query.order("issued_at", { ascending: false }).then(unwrap);

  if (!orders.length) {
    mount("#app",
      el("div", { class: "page-head" },
        el("h1", { class: "display" }, "Payments and receipts")),
      card(emptyState({
        iconName: "receipt",
        title: "No invoices yet",
        description: "Invoices appear here as soon as you enrol on a programme.",
        action: buttonLink("Browse the catalogue", "/programs/index.html"),
      }), { className: "mt-6" }));
    return;
  }

  const totals = summarise(orders);

  function render(searchTerm) {
    const term = searchTerm.trim().toLowerCase();
    const matching = orders.filter((o) => matchesSearch(o, term));

    let content;
    if (view.key === "attention") {
      content = attentionView(matching);
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
        el("h1", { class: "display" }, "Payments and receipts"),
        el("p", {}, "Every invoice issued to you" + (user.role === "ORG_ADMIN" ? " and your team" : "") + "."),
      ]),
    ]),

    el("dl", { class: "grid grid--thirds" }, [
      stat("Outstanding", formatMoney(totals.outstanding), overdueHint(totals.overdue)),
      stat("Paid", formatMoney(totals.collected)),
      stat("Seats bought", String(totals.seatsPaid)),
    ]),

    el("div", { class: "row row--between row--wrap mt-6", style: { alignItems: "center" } }, [
      viewTabs(BASE, view.key),
      searchBox(render, "Search invoice or programme…"),
    ]),

    el("div", { id: "invoice-view", class: "mt-4" }));

  render("");
}
