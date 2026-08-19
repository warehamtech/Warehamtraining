import { el, mount, param, page, setTitle, formatDate, formatDateTime, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, definitionList,
  emptyState, formError, table,
} from "../ui.js";
import { requireRole } from "../session.js";
import { sb, unwrap, rpc, signedUrl } from "../supabase.js";
import { formatMoney } from "../money.js";
import { orderStatus } from "../config.js";
import { downloadInvoice } from "../pdf.js";
import { sendMail } from "../mail.js";

/** Port of src/app/(app)/admin/orders/[id]/ — page + activate-panel. */

/**
 * Activation. A WHA admin can activate without proof at all — there is a note
 * field for why (e.g. "payment confirmed by phone"), and it is recorded on the
 * order's audit trail. This is a real feature for clients who pay by a channel
 * other than uploading a screenshot, not a debug shortcut.
 */
function activatePanel(order, reload) {
  const messages = el("div", {});

  const note = el("textarea", {
    class: "control", name: "adminNote", rows: 2, maxlength: 500,
    placeholder: "e.g. payment confirmed by phone with the client's accounts department",
  });

  const run = async (fn, args, node, working) => {
    node.disabled = true;
    const original = [...node.childNodes];
    node.replaceChildren(el("span", { class: "btn__spinner" }), working);
    messages.replaceChildren();

    const result = await rpc(fn, args);

    if (!result.ok) {
      node.disabled = false;
      node.replaceChildren(...original);
      messages.replaceChildren(el("div", { class: "mt-3" }, formError(result.error)));
      return;
    }

    if (fn === "activate_order") {
      await sendMail("activated", { order_id: order.id }).catch(() => {});
    }
    reload();
  };

  return card([
    cardHeader("Confirm payment", {
      description: "Activating creates one seat per unit purchased and records who approved it.",
    }),
    cardBody([
      el("div", { class: "field" }, [
        el("label", { class: "field__label" }, "Note for the audit trail"),
        note,
        el("p", { class: "field__hint" },
          "Optional, but worth filling in when activating without proof attached."),
      ]),
      messages,
      el("div", { class: "row row--wrap mt-4" }, [
        button([icon("checkCircle", 16), "Confirm payment & activate"], {
          onClick: (event) => run("activate_order", {
            p_order_id: order.id,
            p_admin_note: note.value.trim() || null,
          }, event.currentTarget, "Activating…"),
        }),
        button("Cancel this invoice", {
          variant: "ghost",
          className: "push",
          onClick: (event) => {
            if (!confirm(
              `Cancel invoice ${order.invoice_number}? The buyer will see it as cancelled.`
            )) return;
            return run("cancel_order", {
              p_order_id: order.id,
              p_reason: note.value.trim() || null,
            }, event.currentTarget, "Cancelling…");
          },
        }),
      ]),
    ]),
  ]);
}

async function render(admin) {
  const orderId = param("id");
  if (!orderId) {
    location.replace("/admin/invoices.html");
    return;
  }

  const order = await sb.from("orders")
    .select(`
      id, invoice_number, buyer_type, status, seats,
      unit_price_cents, subtotal_cents, vat_cents, total_cents, vat_rate,
      billing_name, billing_email, billing_vat_number, billing_address,
      issued_at, due_at, paid_at, admin_note, activated_by_id,
      program:programs ( id, title, slug ),
      organization:organizations ( id, name ),
      user:profiles!orders_user_id_fkey ( id, name, email ),
      payment_proofs ( id, original_name, size_bytes, note, created_at, file_key ),
      enrollments ( id, user_id, user:profiles ( name, email ) )
    `)
    .eq("id", orderId)
    .maybeSingle()
    .then(unwrap);

  if (!order) {
    mount("#app", emptyState({
      iconName: "search",
      title: "Order not found",
      action: buttonLink("Back to invoices", "/admin/invoices.html"),
    }));
    return;
  }

  setTitle(`${order.invoice_number} — admin`);

  const state = orderStatus[order.status];
  const proofs = order.payment_proofs ?? [];
  const seats = order.enrollments ?? [];
  const auditTrail = await sb.from("audit_log")
    .select("action, meta, created_at, actor:profiles ( name )")
    .eq("entity_type", "Order")
    .eq("entity_id", order.id)
    .order("created_at", { ascending: false })
    .then(unwrap);

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "link t-sm row", href: "/admin/invoices.html" },
          [icon("arrowLeft", 14), "Back to invoices"]),
        el("h1", { class: "display tabular mt-1" }, order.invoice_number),
        el("p", {}, order.program.title),
      ]),
      el("div", { class: "row" }, [
        badge(state.label, state.tone),
        button([icon("download", 16), "Invoice PDF"], {
          variant: "secondary",
          size: "sm",
          onClick: (event) =>
            downloadInvoice(order.id, order.invoice_number, event.currentTarget),
        }),
      ]),
    ]),

    el("div", { class: "grid grid--detail mt-4" }, [
      el("div", { class: "stack--lg" }, [
        // Proof of payment, shown beside the invoice figures so they can be
        // reconciled without leaving the page.
        card([
          cardHeader("Proof of payment", {
            description: proofs.length
              ? "Check the amount and reference against the invoice."
              : "Nothing uploaded — you can still activate with a note.",
          }),
          proofs.length
            ? el("ul", { class: "divided" }, proofs.map((proof) =>
                el("li", { class: "row row--wrap" }, [
                  icon("fileText", 16, { class: "i-subtle" }),
                  el("div", { class: "grow" }, [
                    el("p", { class: "medium t-sm" }, proof.original_name),
                    el("p", { class: "subtle t-xs tabular" },
                      `${formatBytes(proof.size_bytes)} · uploaded ${formatDateTime(proof.created_at)}`),
                    proof.note ? el("p", { class: "muted t-sm mt-1" }, proof.note) : null,
                  ]),
                  button([icon("eye", 14), "Open"], {
                    variant: "secondary",
                    size: "sm",
                    onClick: async () => {
                      const url = await signedUrl("proofs", proof.file_key, 300);
                      if (url) window.open(url, "_blank", "noopener");
                    },
                  }),
                ])))
            : cardBody(el("p", { class: "subtle t-sm" }, "No documents attached.")),
        ]),

        order.status === "PENDING" || order.status === "PROOF_SUBMITTED"
          ? activatePanel(order, () => render(admin))
          : null,

        seats.length
          ? card([
              cardHeader("Seats", {
                description: `${seats.filter((s) => s.user_id).length} of ${seats.length} allocated`,
              }),
              table(["Seat", "Held by"], seats.map((seat, index) =>
                el("tr", {}, [
                  el("td", { class: "tabular" }, String(index + 1)),
                  el("td", {}, seat.user
                    ? `${seat.user.name} (${seat.user.email})`
                    : el("span", { class: "subtle" }, "Unallocated — in the team pool")),
                ]))),
            ])
          : null,

        auditTrail.length
          ? card([
              cardHeader("Audit trail", {
                description: "Who did what to this order, and when.",
              }),
              el("ul", { class: "divided" }, auditTrail.map((entry) =>
                el("li", {}, [
                  el("p", { class: "medium t-sm" }, entry.action),
                  el("p", { class: "subtle t-xs tabular" },
                    `${entry.actor?.name ?? "system"} · ${formatDateTime(entry.created_at)}`),
                  entry.meta?.note
                    ? el("p", { class: "muted t-sm mt-1" }, entry.meta.note)
                    : null,
                ]))),
            ])
          : null,
      ]),

      el("aside", { class: "sticky-panel stack--lg" }, [
        card([
          cardHeader("Invoice"),
          cardBody([
            definitionList([
              ["Billed to", order.billing_name],
              ["Email", order.billing_email],
              order.billing_vat_number ? ["VAT number", order.billing_vat_number] : null,
              ["Buyer type", order.buyer_type === "COMPANY" ? "Company" : "Individual"],
              order.organization ? ["Organisation", order.organization.name] : null,
              ["Seats", String(order.seats)],
              ["Issued", formatDate(order.issued_at)],
              ["Due", formatDate(order.due_at)],
              order.paid_at ? ["Paid", formatDate(order.paid_at)] : null,
            ]),
            el("dl", { class: "dl dl--totals mt-4" }, [
              el("div", {}, [
                el("dt", {}, "Subtotal"),
                el("dd", { class: "tabular" }, formatMoney(order.subtotal_cents)),
              ]),
              el("div", {}, [
                el("dt", {}, `VAT @ ${Math.round(order.vat_rate * 100)}%`),
                el("dd", { class: "tabular" }, formatMoney(order.vat_cents)),
              ]),
              el("div", { class: "dl-total" }, [
                el("dt", { class: "medium" }, "Total"),
                el("dd", { class: "tabular t-lg medium" }, formatMoney(order.total_cents)),
              ]),
            ]),
            order.billing_address
              ? el("p", { class: "muted t-sm mt-4", style: { whiteSpace: "pre-line" } },
                  order.billing_address)
              : null,
            order.admin_note
              ? el("p", { class: "form-note mt-4 t-sm" }, order.admin_note)
              : null,
          ]),
        ]),
      ]),
    ]));
}

page(async () => {
  const admin = await requireRole("WHA_ADMIN");
  appChrome(admin);
  await render(admin);
});
