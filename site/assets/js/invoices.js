import { el, formatDate, relativeDays } from "./dom.js";
import { icon } from "./icons.js";
import { badge, card, cardHeader, table } from "./ui.js";
import { orderStatus } from "./config.js";

/**
 * The mechanics behind the Invoices tab, shared by the admin ledger
 * (/admin/invoices.html) and the buyer one (/invoices.html).
 *
 * There used to be two admin tabs over the same `orders` rows: Orders, "the
 * review queue", and Invoices, "the ledger" — which meant two names for every
 * status, two stat rows, and neither tab complete on its own. One tab does
 * both jobs now: it opens on what still needs action, split by who has to
 * act, and holds the full searchable history behind a filter.
 *
 * What lives here is the machinery both audiences need identically —
 * sorting, searching, overdue arithmetic, the table chrome. What
 * deliberately does not is the editorial: each page owns its own columns,
 * row actions and wording, because "waiting on you" means opposite things
 * to an admin and a buyer.
 */

export const VIEWS = [
  { key: "attention", label: "Needs attention", statuses: ["PROOF_SUBMITTED", "PENDING"] },
  { key: "paid", label: "Paid", statuses: ["PAID"] },
  { key: "cancelled", label: "Cancelled", statuses: ["CANCELLED"] },
  { key: "all", label: "All", statuses: null },
];

/** The two statuses that still have someone waiting on someone. */
export const OPEN_STATUSES = ["PENDING", "PROOF_SUBMITTED"];

/* --- URL state ------------------------------------------------------------ */

/** Which view, sorted how — all of it read off the query string, so a filtered
 *  and sorted ledger is a link you can send someone. */
export function viewState() {
  const params = new URLSearchParams(location.search);
  const key = params.get("view") ?? VIEWS[0].key;
  return {
    view: VIEWS.find((entry) => entry.key === key) ?? VIEWS[0],
    sort: {
      key: params.get("sort") ?? "issued_at",
      dir: params.get("dir") === "asc" ? "asc" : "desc",
    },
  };
}

/** Same page, one parameter changed. `null` removes it, keeping the URL clean
 *  for the default view rather than spelling out ?view=attention. */
export function viewHref(basePath, changes) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function viewTabs(basePath, activeKey) {
  return el("nav", { class: "tabs", "aria-label": "Filter invoices" },
    VIEWS.map((entry) =>
      el("a", {
        href: viewHref(basePath, { view: entry.key === VIEWS[0].key ? null : entry.key }),
        class: "tab",
        "aria-current": entry.key === activeKey ? "page" : null,
      }, entry.label)));
}

export function searchBox(onInput, placeholder = "Search invoices…") {
  return el("input", {
    type: "search",
    class: "control",
    placeholder,
    "aria-label": "Search invoices",
    style: { maxWidth: "20rem" },
    onInput: (event) => onInput(event.target.value),
  });
}

/* --- Dates ---------------------------------------------------------------- */

/**
 * A settled invoice is never overdue — the old orders queue treated any
 * non-PAID invoice past its due date as overdue, which painted cancelled
 * ones red forever.
 */
export function overdueInfo(order) {
  if (order.status === "PAID" || order.status === "CANCELLED") {
    return { overdue: false, days: 0 };
  }
  const elapsed = Date.now() - new Date(order.due_at).getTime();
  return { overdue: elapsed > 0, days: Math.floor(elapsed / 86_400_000) };
}

/** Issued date, plus the one date line that matters for this status. */
export function datesCell(order) {
  const { overdue, days } = overdueInfo(order);

  let second = null;
  if (order.status === "PAID") {
    second = order.paid_at
      ? el("p", { class: "subtle t-xs" }, `paid ${formatDate(order.paid_at)}`)
      : null;
  } else if (order.status !== "CANCELLED") {
    second = overdue
      ? el("p", { class: "t-xs medium", style: { color: "var(--danger)" } },
          days < 1 ? "Overdue today" : `Overdue by ${days} day${days === 1 ? "" : "s"}`)
      : el("p", { class: "subtle t-xs" }, `due ${relativeDays(order.due_at)}`);
  }

  return el("td", {}, [
    el("p", { class: "tabular t-xs" }, formatDate(order.issued_at)),
    second,
  ]);
}

/** Most overdue first, then soonest due — the order you would work the pile in. */
export function byUrgency(a, b) {
  return new Date(a.due_at) - new Date(b.due_at);
}

/* --- Cells ---------------------------------------------------------------- */

/** Proof used to be a column of its own beside a status column that already
 *  implied it. It reads better as a footnote under the badge. */
export function proofHint(order) {
  const count = order.payment_proofs?.length ?? 0;
  if (!count) return null;
  return el("p", { class: "subtle t-xs mt-1 row", style: { gap: "0.25rem" } }, [
    icon("fileText", 12),
    `${count} proof${count === 1 ? "" : "s"}`,
  ]);
}

export function statusCell(order) {
  const state = orderStatus[order.status] ?? { label: order.status, tone: "neutral" };
  return el("td", {}, [badge(state.label, state.tone), proofHint(order)]);
}

export function invoiceLinkCell(order, href) {
  return el("td", {}, el("a", { class: "link medium tabular", href }, order.invoice_number));
}

/* --- Search and sort ------------------------------------------------------ */

/** Enough to find "that invoice from Cape Foods" without knowing its number. */
export function matchesSearch(order, term) {
  if (!term) return true;
  return [
    order.invoice_number,
    order.billing_name,
    order.billing_email,
    order.program?.title,
  ].filter(Boolean).join(" ").toLowerCase().includes(term);
}

export function compareOrders(a, b, key) {
  if (key === "program") return (a.program?.title ?? "").localeCompare(b.program?.title ?? "");
  if (key === "status") return statusLabel(a).localeCompare(statusLabel(b));
  if (key === "issued_at") return new Date(a.issued_at) - new Date(b.issued_at);
  const va = a[key];
  const vb = b[key];
  if (typeof va === "number" || typeof vb === "number") return (va ?? 0) - (vb ?? 0);
  return String(va ?? "").localeCompare(String(vb ?? ""));
}

/** Falls back to the raw enum value so adding a fifth order_status can't throw
 *  here before config.js catches up. */
function statusLabel(order) {
  return orderStatus[order.status]?.label ?? order.status ?? "";
}

export function sortRows(orders, sort) {
  return [...orders].sort((a, b) =>
    (compareOrders(a, b, sort.key) || 0) * (sort.dir === "asc" ? 1 : -1));
}

/** Sorting reloads the page rather than re-rendering, which keeps the sort in
 *  the URL and the back button meaningful. */
export function sortHandler(basePath, sort) {
  return (key) => {
    const dir = sort.key === key && sort.dir === "desc" ? "asc" : "desc";
    location.href = viewHref(basePath, { sort: key, dir });
  };
}

function sortHeaderCell(column, sort, onSort) {
  if (!column.sortable) return column.label ?? "";

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

/* --- Table ---------------------------------------------------------------- */

/**
 * One card, one table. Both the attention groups and the history views are
 * built from this, so a column added for one shows up identically in the
 * other.
 */
export function invoiceCard({
  title, description, columns, orders, sort, onSort, renderRow, className,
}) {
  return card([
    cardHeader(title, { description }),
    table(
      columns.map((column) => sortHeaderCell(column, sort, onSort)),
      orders.map(renderRow)),
  ], { className });
}

/* --- Totals --------------------------------------------------------------- */

/** Everything the stat tiles need, in one pass over the rows already fetched. */
export function summarise(orders) {
  const totals = {
    count: orders.length,
    invoiced: 0,
    collected: 0,
    outstanding: 0,
    needsReview: 0,
    awaitingPayment: 0,
    overdue: 0,
    seatsPaid: 0,
  };

  for (const order of orders) {
    totals.invoiced += order.total_cents;

    if (order.status === "PAID") {
      totals.collected += order.total_cents;
      totals.seatsPaid += order.seats ?? 0;
    }

    if (OPEN_STATUSES.includes(order.status)) {
      totals.outstanding += order.total_cents;
      if (overdueInfo(order).overdue) totals.overdue += 1;
    }

    if (order.status === "PROOF_SUBMITTED") totals.needsReview += 1;
    if (order.status === "PENDING") totals.awaitingPayment += 1;
  }

  return totals;
}

/** "3 overdue", or nothing at all when none are. */
export function overdueHint(count) {
  return count ? { hint: `${count} overdue`, hintTone: "alert" } : {};
}
