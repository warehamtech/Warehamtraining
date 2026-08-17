import { el, mount, page, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import { badge, card, cardHeader, emptyState, stat, table } from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { orderStatus } from "../config.js";

/**
 * The full invoice ledger, distinct from /admin/orders.html — Orders is the
 * action queue ("what needs my attention"), this is every invoice ever
 * issued, sortable the way an accounts view needs to be.
 */

const STATUS_FILTERS = [
  { key: "all", label: "All", statuses: null },
  { key: "PENDING", label: "Awaiting payment", statuses: ["PENDING"] },
  { key: "PROOF_SUBMITTED", label: "Proof submitted", statuses: ["PROOF_SUBMITTED"] },
  { key: "PAID", label: "Paid", statuses: ["PAID"] },
  { key: "CANCELLED", label: "Cancelled", statuses: ["CANCELLED"] },
];

const COLUMNS = [
  { key: "invoice_number", label: "Invoice", sortable: true },
  { key: "billing_name", label: "Billed to", sortable: true },
  { key: "program", label: "Programme", sortable: false },
  { key: "seats", label: "Seats", sortable: true },
  { key: "total_cents", label: "Total", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "issued_at", label: "Date", sortable: true },
];

function compare(a, b, key) {
  if (key === "program") return (a.program?.title ?? "").localeCompare(b.program?.title ?? "");
  if (key === "status") return orderStatus[a.status].label.localeCompare(orderStatus[b.status].label);
  const va = a[key];
  const vb = b[key];
  if (typeof va === "number") return va - vb;
  if (key === "issued_at") return new Date(va) - new Date(vb);
  return String(va ?? "").localeCompare(String(vb ?? ""));
}

function sortHeaderCell(column, sort, onSort) {
  if (!column.sortable) return column.label;

  const active = sort.key === column.key;
  return el("button", {
    type: "button",
    class: "table-sort" + (active ? " table-sort--active" : ""),
    onClick: () => onSort(column.key),
  }, [
    el("span", {}, column.label),
    active
      ? el("span", {
          class: "table-sort__arrow",
          style: { transform: sort.dir === "asc" ? "rotate(180deg)" : "none" },
        }, icon("chevronDown", 12, { strokeWidth: 2.5 }))
      : null,
  ]);
}

function invoiceRow(order) {
  const state = orderStatus[order.status];
  const isCompany = order.buyer_type === "COMPANY";

  return el("tr", {}, [
    el("td", {}, [
      el("a", {
        class: "link medium tabular",
        href: `/admin/order.html?id=${order.id}`,
      }, order.invoice_number),
    ]),
    el("td", {}, [
      el("p", { class: "medium row", style: { gap: "0.375rem" } }, [
        icon(isCompany ? "building" : "user", 13),
        order.billing_name,
      ]),
      el("p", { class: "subtle t-xs" }, order.billing_email),
    ]),
    el("td", {}, order.program?.title ?? "—"),
    el("td", { class: "tabular" }, String(order.seats)),
    el("td", { class: "tabular medium" }, formatMoney(order.total_cents)),
    el("td", {}, badge(state.label, state.tone)),
    el("td", { class: "tabular t-xs" }, formatDate(order.issued_at)),
  ]);
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);

  const activeStatus = new URLSearchParams(location.search).get("status") ?? "all";
  const statusFilter = STATUS_FILTERS.find((f) => f.key === activeStatus) ?? STATUS_FILTERS[0];

  const sort = {
    key: new URLSearchParams(location.search).get("sort") ?? "issued_at",
    dir: new URLSearchParams(location.search).get("dir") ?? "desc",
  };

  const orders = await sb.from("orders")
    .select(`
      id, invoice_number, status, buyer_type, seats, total_cents, issued_at,
      billing_name, billing_email,
      program:programs ( title )
    `)
    .then(unwrap);

  const filtered = statusFilter.statuses
    ? orders.filter((o) => statusFilter.statuses.includes(o.status))
    : orders;

  const sorted = [...filtered].sort((a, b) =>
    (compare(a, b, sort.key) || 0) * (sort.dir === "asc" ? 1 : -1));

  const sum = (rows) => rows.reduce((total, o) => total + o.total_cents, 0);
  const collected = sum(orders.filter((o) => o.status === "PAID"));
  const outstanding = sum(orders.filter((o) => ["PENDING", "PROOF_SUBMITTED"].includes(o.status)));

  const setParam = (key, value) => {
    const params = new URLSearchParams(location.search);
    if (value === null) params.delete(key);
    else params.set(key, value);
    return `/admin/invoices.html?${params.toString()}`;
  };

  const onSort = (key) => {
    const nextDir = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
    const params = new URLSearchParams(location.search);
    params.set("sort", key);
    params.set("dir", nextDir);
    location.href = `/admin/invoices.html?${params.toString()}`;
  };

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Invoices"),
        el("p", {}, "Every invoice issued, individual and team. Click a column to sort."),
      ]),
    ]),

    el("dl", { class: "grid grid--quarters" }, [
      stat("Invoices", String(orders.length)),
      stat("Total invoiced", formatMoney(sum(orders))),
      stat("Collected", formatMoney(collected)),
      stat("Outstanding", formatMoney(outstanding)),
    ]),

    el("nav", { class: "tabs mt-6", "aria-label": "Filter by status" },
      STATUS_FILTERS.map((entry) =>
        el("a", {
          href: setParam("status", entry.key === "all" ? null : entry.key),
          class: "tab",
          "aria-current": entry.key === statusFilter.key ? "page" : null,
        }, entry.label))),

    sorted.length
      ? card([
          cardHeader(statusFilter.label, {
            description: `${sorted.length} ${sorted.length === 1 ? "invoice" : "invoices"}`,
          }),
          table(
            COLUMNS.map((column) => sortHeaderCell(column, sort, onSort)),
            sorted.map(invoiceRow)),
        ], { className: "mt-4" })
      : card(emptyState({
          iconName: "receipt",
          title: "No invoices here",
          description: "Try a different filter.",
        }), { className: "mt-4" }));
});
