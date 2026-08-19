import { el, mount, param, setTitle, formatDate, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  badge, button, buttonLink, card, cardBody, cardHeader, emptyState, definitionList,
} from "../ui.js";
import { requireUser } from "../session.js";
import { sb, unwrap, rpc, signedUrl } from "../supabase.js";
import { formatMoney } from "../money.js";
import { banking, company, orderStatus } from "../config.js";
import { downloadInvoice } from "../pdf.js";
import { sendMail } from "../mail.js";
import { compressProofImage } from "../image-compress.js";

/** Port of src/app/(app)/orders/[id]/ — page + proof-upload. */

const MAX_PROOF_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_PROOF_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp",
]);

function statusBanner(order, seatCount) {
  // Awaiting payment is a normal state, not an error — amber, not red.
  if (order.status === "PENDING") {
    return el("div", { class: "notice notice--warn" }, [
      icon("clock", 20, { class: "i-accent" }),
      el("div", { class: "t-sm" }, [
        el("p", { class: "medium" }, "Awaiting payment"),
        el("p", { class: "muted mt-1" }, [
          "Pay by EFT using ", el("strong", {}, order.invoice_number),
          " as your reference, then upload your proof of payment below. Payment is due by ",
          formatDate(order.due_at), ".",
        ]),
      ]),
    ]);
  }

  if (order.status === "PROOF_SUBMITTED") {
    return el("div", { class: "notice notice--info" }, [
      icon("clock", 20, { class: "i-brand" }),
      el("div", { class: "t-sm" }, [
        el("p", { class: "medium" }, "With our team for confirmation"),
        el("p", { class: "muted mt-1" },
          "We've received your proof of payment. Your training is activated as soon " +
          "as it's confirmed — usually within one working day."),
      ]),
    ]);
  }

  if (order.status === "PAID") {
    const isTeamOrder = order.buyer_type === "COMPANY";
    return el("div", { class: "notice notice--success" }, [
      icon("checkCircle", 20, { class: "i-success" }),
      el("div", { class: "t-sm" }, [
        el("p", { class: "medium" }, "Payment confirmed"),
        el("p", { class: "muted mt-1" },
          `${seatCount} ${seatCount === 1 ? "seat is" : "seats are"} active.`),
        el("div", { class: "mt-3" },
          buttonLink(isTeamOrder ? "Allocate seats" : "Start learning",
            isTeamOrder ? "/team/index.html" : "/dashboard.html", { size: "sm" })),
      ]),
    ]);
  }

  return el("div", { class: "notice notice--danger" }, [
    icon("alert", 20),
    el("div", { class: "t-sm" }, [
      el("p", { class: "medium" }, "This invoice was cancelled"),
      order.admin_note ? el("p", { class: "muted mt-1" }, order.admin_note) : null,
    ]),
  ]);
}

/** Proof-of-payment upload. Port of proof-upload.tsx. */
function proofUpload(order, onDone) {
  const messages = el("div", {});
  const input = el("input", {
    class: "control", type: "file", name: "file", required: true,
    accept: ".pdf,.png,.jpg,.jpeg,.webp",
  });
  const note = el("textarea", {
    class: "control", name: "note", rows: 2, maxlength: 500,
    placeholder: "Anything we should know? (optional)",
  });

  const form = el("form", { class: "stack", novalidate: true }, [
    messages,
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Proof of payment"),
      input,
      el("p", { class: "field__hint" }, "PDF, PNG, JPG or WEBP, up to 10 MB."),
    ]),
    el("div", { class: "field" }, [
      el("label", { class: "field__label" }, "Note"),
      note,
    ]),
    el("button", { class: "btn btn--primary", type: "submit" },
      [icon("upload", 16), "Send proof of payment"]),
  ]);

  const say = (text, tone = "error") => messages.replaceChildren(
    el("div", { class: tone === "error" ? "form-error" : "form-success", role: "alert" }, text));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    messages.replaceChildren();

    const file = input.files?.[0];
    if (!file) return say("Choose a file to upload.");
    if (file.size > MAX_PROOF_BYTES) {
      return say("That file is larger than 10 MB. Please upload a smaller file.");
    }
    if (!ALLOWED_PROOF_TYPES.has(file.type)) {
      return say("Upload a PDF, PNG, JPG or WEBP file.");
    }

    const submit = form.querySelector("button");
    submit.disabled = true;
    submit.replaceChildren(el("span", { class: "btn__spinner" }), "Compressing…");

    // Screenshots routinely arrive as multi-megabyte PNGs; shrinking them here
    // is what keeps the proofs bucket small as invoice volume grows. `original`
    // stays the true filename for the admin's record even though the bytes
    // actually stored may now be a smaller re-encoded JPEG.
    const original = file;
    const stored = await compressProofImage(file);

    submit.replaceChildren(el("span", { class: "btn__spinner" }), "Uploading…");

    // The bucket policy keys off the first path segment being the order id, so
    // this is also what authorises the write.
    const safeName = stored.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const key = `${order.id}/${crypto.randomUUID()}-${safeName}`;

    const upload = await sb.storage.from("proofs").upload(key, stored, {
      contentType: stored.type,
      upsert: false,
    });

    if (upload.error) {
      submit.disabled = false;
      submit.replaceChildren(icon("upload", 16), "Send proof of payment");
      return say("That upload was refused. Check the order is still open and try again.");
    }

    const row = await sb.from("payment_proofs").insert({
      order_id: order.id,
      file_key: key,
      original_name: original.name,
      content_type: stored.type,
      size_bytes: stored.size,
      note: note.value.trim() || null,
      uploaded_by_id: (await sb.auth.getUser()).data.user.id,
    });

    if (row.error) {
      submit.disabled = false;
      submit.replaceChildren(icon("upload", 16), "Send proof of payment");
      return say("We couldn't record that upload. Please try again.");
    }

    // Moving the order into the review queue is a database decision — it only
    // happens if a proof row actually exists.
    await sb.rpc("mark_proof_submitted", { p_order_id: order.id });

    // Let WHA know there is something waiting in the review queue.
    await sendMail("proof_received", { order_id: order.id }).catch(() => {});

    say("Thank you — your proof of payment is with our team. We'll activate your " +
      "training as soon as it's confirmed.", "success");
    setTimeout(onDone, 1200);
  });

  return form;
}

async function render(user) {
  const orderId = param("id");
  if (!orderId) {
    location.replace("/dashboard.html");
    return;
  }

  const order = await sb.from("orders")
    .select(`
      id, invoice_number, buyer_type, status, seats,
      unit_price_cents, subtotal_cents, vat_cents, total_cents, vat_rate,
      billing_name, billing_email, billing_vat_number, billing_address,
      issued_at, due_at, paid_at, admin_note,
      program:programs ( title, slug ),
      payment_proofs ( id, original_name, size_bytes, note, created_at, file_key ),
      enrollments ( id )
    `)
    .eq("id", orderId)
    .maybeSingle()
    .then(unwrap);

  // RLS returns nothing for an order this person may not see, so "missing" and
  // "not yours" are indistinguishable from here — deliberately.
  if (!order) {
    mount("#app", emptyState({
      iconName: "lock",
      title: "That order isn't available to you",
      action: buttonLink("Back to my learning", "/dashboard.html"),
    }));
    return;
  }

  setTitle(`Invoice ${order.invoice_number}`);

  const state = orderStatus[order.status];
  const proofs = order.payment_proofs ?? [];
  const canUpload = order.status === "PENDING" || order.status === "PROOF_SUBMITTED";

  mount("#app",
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("a", { class: "link t-sm row", href: "/invoices.html" },
          [icon("arrowLeft", 14), "Back to invoices"]),
        el("p", { class: "eyebrow mt-1" }, "Order"),
        el("h1", { class: "display tabular" }, order.invoice_number),
        el("p", {}, order.program.title),
      ]),
      badge(state.label, state.tone),
    ]),

    statusBanner(order, (order.enrollments ?? []).length),

    el("div", { class: "grid grid--detail mt-6" }, [
      el("div", { class: "stack--lg" }, [
        card([
          cardHeader("Order details", {
            action: button([icon("download", 16), "Invoice PDF"], {
              variant: "secondary",
              size: "sm",
              onClick: (event) =>
                downloadInvoice(order.id, order.invoice_number, event.currentTarget),
            }),
          }),
          cardBody([
            definitionList([
              ["Programme", el("a", {
                class: "link medium",
                href: `/programs/program.html?slug=${order.program.slug}`,
              }, order.program.title)],
              ["Billed to", order.billing_name],
              ["Seats", String(order.seats)],
              order.billing_vat_number ? ["VAT number", order.billing_vat_number] : null,
              ["Issued", formatDate(order.issued_at)],
              ["Due", formatDate(order.due_at)],
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
          ]),
        ]),

        canUpload
          ? card([
              cardHeader("Proof of payment", {
                description: "Upload your EFT confirmation or bank statement extract.",
              }),
              cardBody(proofUpload(order, () => render(user))),
            ])
          : null,

        proofs.length
          ? card([
              cardHeader("Uploaded documents"),
              el("ul", { class: "divided" }, proofs.map((proof) =>
                el("li", { class: "row" }, [
                  icon("fileText", 16, { class: "i-subtle" }),
                  el("div", { class: "grow" }, [
                    el("button", {
                      class: "link medium",
                      type: "button",
                      onClick: async () => {
                        const url = await signedUrl("proofs", proof.file_key, 300);
                        if (url) window.open(url, "_blank", "noopener");
                      },
                    }, proof.original_name),
                    el("p", { class: "subtle t-xs tabular" },
                      `${formatBytes(proof.size_bytes)} · ${formatDate(proof.created_at)}`),
                    proof.note ? el("p", { class: "muted t-sm mt-1" }, proof.note) : null,
                  ]),
                ]))),
            ])
          : null,
      ]),

      // Banking panel — the details someone needs to actually pay.
      el("aside", { class: "sticky-panel" },
        card([
          cardHeader("How to pay"),
          cardBody([
            definitionList([
              ["Bank", banking.bank],
              ["Account name", banking.accountName],
              ["Account number", banking.accountNumber],
              ["Branch code", banking.branchCode],
              ["Reference", order.invoice_number],
            ]),
            el("p", { class: "form-note mt-4 t-sm" }, [
              "Use ", el("strong", {}, order.invoice_number),
              " as your payment reference so we can match it to your order.",
            ]),
            el("p", { class: "subtle t-xs mt-3" },
              `Questions? Call ${company.phone} or email ${company.email}.`),
          ]),
        ])),
    ]));
}

export async function init() {
  const user = await requireUser();
  appChrome(user);
  await render(user);
}
