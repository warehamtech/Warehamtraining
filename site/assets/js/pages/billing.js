import { el, mount, page, formatDate } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardHeader, emptyState, stat, table,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap } from "../supabase.js";
import { formatMoney } from "../money.js";
import { orderStatus } from "../config.js";
import { downloadInvoice } from "../pdf.js";

/** Port of src/app/(app)/team/billing/page.tsx. */

page(async () => {
  const admin = await requireRole("ORG_ADMIN");
  appChrome(admin);

  if (!admin.organization_id) {
    mount("#app", card(emptyState({
      title: "No organisation linked",
      description: "Buy seats as a company at checkout and your invoices appear here.",
      action: buttonLink("Browse the catalogue", "/programs/index.html"),
    })));
    return;
  }

  const orders = await sb.from("orders")
    .select(`
      id, invoice_number, status, seats, total_cents, issued_at, due_at, paid_at,
      program:programs ( title )
    `)
    .eq("organization_id", admin.organization_id)
    .order("issued_at", { ascending: false })
    .then(unwrap);

  const paid = orders.filter((o) => o.status === "PAID");
  const outstanding = orders.filter(
    (o) => o.status === "PENDING" || o.status === "PROOF_SUBMITTED");

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h1", { class: "display" }, "Billing"),
        el("p", {}, "Every invoice issued to your organisation."),
      ]),
      buttonLink("Back to team", "/team/index.html", { variant: "secondary" }),
    ]),

    el("dl", { class: "grid grid--thirds" }, [
      stat("Invoices", String(orders.length)),
      stat("Outstanding",
        formatMoney(outstanding.reduce((sum, o) => sum + o.total_cents, 0))),
      stat("Seats bought", String(paid.reduce((sum, o) => sum + o.seats, 0))),
    ]),

    orders.length
      ? card([
          cardHeader("Invoices"),
          table(
            ["Invoice", "Programme", "Seats", "Total", "Issued", "Status", ""],
            orders.map((order) => {
              const state = orderStatus[order.status];
              return el("tr", {}, [
                el("td", { class: "tabular medium" },
                  el("a", { class: "link", href: `/orders/order.html?id=${order.id}` },
                    order.invoice_number)),
                el("td", {}, order.program.title),
                el("td", { class: "tabular" }, String(order.seats)),
                el("td", { class: "tabular" }, formatMoney(order.total_cents)),
                el("td", { class: "tabular subtle t-xs" }, formatDate(order.issued_at)),
                el("td", {}, badge(state.label, state.tone)),
                el("td", {},
                  button(icon("download", 16), {
                    variant: "ghost",
                    size: "sm",
                    "aria-label": `Download ${order.invoice_number}`,
                    onClick: (event) =>
                      downloadInvoice(order.id, order.invoice_number, event.currentTarget),
                  })),
              ]);
            })),
        ], { className: "mt-6" })
      : card(emptyState({
          iconName: "receipt",
          title: "No invoices yet",
          description: "Invoices appear here as soon as you enrol your team on a programme.",
          action: buttonLink("Browse the catalogue", "/programs/index.html"),
        }), { className: "mt-6" }));
});
