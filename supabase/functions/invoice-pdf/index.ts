/**
 * Tax invoice PDF.
 *
 * Port of src/lib/pdf/invoice.tsx. That version used @react-pdf/renderer,
 * which is bound to React; this draws with pdf-lib, which runs in Deno.
 *
 * The order is read through the CALLER'S JWT, so the orders policy — the port
 * of canViewOrder — decides whether the document exists for them. Nothing on
 * the invoice comes from the request body: the totals, the invoice number and
 * the billing snapshot are all read from the row.
 */
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import {
  CORS, clientFor, company, banking, formatMoney, formatDate, fail,
} from "../_shared/wha.ts";

// WHA brand palette, matching assets/css/tokens.css.
const BRAND = rgb(6 / 255, 71 / 255, 155 / 255);
const INK = rgb(44 / 255, 51 / 255, 63 / 255);
const MUTED = rgb(74 / 255, 85 / 255, 104 / 255);
const SUBTLE = rgb(113 / 255, 128 / 255, 150 / 255);
const LINE = rgb(226 / 255, 232 / 255, 240 / 255);
const SUCCESS = rgb(19 / 255, 97 / 255, 46 / 255);

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return fail("Method not allowed", 405);

  const sb = clientFor(request);
  if (!sb) return fail("Not signed in.", 401);

  const { order_id } = await request.json().catch(() => ({}));
  if (!order_id) return fail("Missing order_id.");

  const { data: order } = await sb.from("orders")
    .select(`
      invoice_number, issued_at, due_at, status, seats,
      unit_price_cents, subtotal_cents, vat_cents, total_cents, vat_rate, currency,
      billing_name, billing_email, billing_vat_number, billing_address,
      program:programs ( title )
    `)
    .eq("id", order_id)
    .maybeSingle();

  // Empty means the policy refused it, not that the row is missing.
  if (!order) return fail("You don't have access to that invoice.", 403);

  const pdf = await render(order);

  return new Response(pdf, {
    headers: {
      ...CORS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${order.invoice_number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});

// deno-lint-ignore no-explicit-any
async function render(order: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Tax invoice ${order.invoice_number}`);
  doc.setAuthor(company.legalName);
  doc.setCreator("WHA Learning Portal");

  const page = doc.addPage([A4.width, A4.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = A4.height - MARGIN;

  const text = (
    value: string,
    x: number,
    yy: number,
    { size = 10, font = regular, color = INK } = {},
  ) => page.drawText(value, { x, y: yy, size, font, color });

  const right = (
    value: string,
    xRight: number,
    yy: number,
    { size = 10, font = regular, color = INK } = {},
  ) => {
    const width = font.widthOfTextAtSize(value, size);
    page.drawText(value, { x: xRight - width, y: yy, size, font, color });
  };

  const rule = (yy: number, color = LINE) =>
    page.drawLine({
      start: { x: MARGIN, y: yy },
      end: { x: A4.width - MARGIN, y: yy },
      thickness: 1,
      color,
    });

  /* --- Header ------------------------------------------------------------- */

  text(company.legalName.toUpperCase(), MARGIN, y, { size: 9, font: bold, color: BRAND });
  y -= 20;
  text("TAX INVOICE", MARGIN, y, { size: 24, font: bold });

  right(order.invoice_number, A4.width - MARGIN, y + 6, { size: 13, font: bold });
  right(`Issued ${formatDate(order.issued_at)}`, A4.width - MARGIN, y - 10,
    { size: 9, color: SUBTLE });
  right(`Due ${formatDate(order.due_at)}`, A4.width - MARGIN, y - 23,
    { size: 9, color: SUBTLE });

  y -= 34;
  rule(y);
  y -= 22;

  /* --- Parties ------------------------------------------------------------ */

  const columnTop = y;
  text("FROM", MARGIN, y, { size: 8, font: bold, color: SUBTLE });
  y -= 14;
  text(company.legalName, MARGIN, y, { size: 10, font: bold });
  for (const line of company.addressLines) {
    y -= 12;
    text(line, MARGIN, y, { size: 9, color: MUTED });
  }
  y -= 12;
  text(company.country, MARGIN, y, { size: 9, color: MUTED });
  y -= 14;
  text(`VAT no. ${company.vatNumber}`, MARGIN, y, { size: 9, color: MUTED });
  y -= 12;
  text(`Reg. no. ${company.registrationNumber}`, MARGIN, y, { size: 9, color: MUTED });
  y -= 12;
  text(company.email, MARGIN, y, { size: 9, color: MUTED });

  const fromBottom = y;

  // Billed-to column, snapshotted at issue time.
  const bx = A4.width / 2 + 10;
  let by = columnTop;
  text("BILL TO", bx, by, { size: 8, font: bold, color: SUBTLE });
  by -= 14;
  text(order.billing_name, bx, by, { size: 10, font: bold });
  by -= 12;
  text(order.billing_email, bx, by, { size: 9, color: MUTED });

  for (const line of String(order.billing_address ?? "").split("\n").filter(Boolean)) {
    by -= 12;
    text(line, bx, by, { size: 9, color: MUTED });
  }
  if (order.billing_vat_number) {
    by -= 14;
    text(`VAT no. ${order.billing_vat_number}`, bx, by, { size: 9, color: MUTED });
  }

  y = Math.min(fromBottom, by) - 28;

  /* --- Line items --------------------------------------------------------- */

  page.drawRectangle({
    x: MARGIN, y: y - 6, width: A4.width - MARGIN * 2, height: 22, color: rgb(0.97, 0.98, 0.99),
  });
  text("DESCRIPTION", MARGIN + 10, y, { size: 8, font: bold, color: SUBTLE });
  right("QTY", MARGIN + 350, y, { size: 8, font: bold, color: SUBTLE });
  right("UNIT PRICE", MARGIN + 440, y, { size: 8, font: bold, color: SUBTLE });
  right("AMOUNT", A4.width - MARGIN - 10, y, { size: 8, font: bold, color: SUBTLE });

  y -= 26;
  text(order.program.title, MARGIN + 10, y, { size: 10, font: bold });
  right(String(order.seats), MARGIN + 350, y, { size: 10 });
  right(formatMoney(order.unit_price_cents), MARGIN + 440, y, { size: 10 });
  right(formatMoney(order.subtotal_cents), A4.width - MARGIN - 10, y, { size: 10 });

  y -= 13;
  text(
    order.seats > 1
      ? `${order.seats} learner seats · online training programme`
      : "One learner seat · online training programme",
    MARGIN + 10, y, { size: 8.5, color: SUBTLE },
  );

  y -= 20;
  rule(y);

  /* --- Totals ------------------------------------------------------------- */

  const labelX = A4.width - MARGIN - 150;
  const valueX = A4.width - MARGIN - 10;

  y -= 20;
  text("Subtotal (excl. VAT)", labelX, y, { size: 9.5, color: MUTED });
  right(formatMoney(order.subtotal_cents), valueX, y, { size: 9.5 });

  y -= 16;
  text(`VAT @ ${Math.round(order.vat_rate * 100)}%`, labelX, y, { size: 9.5, color: MUTED });
  right(formatMoney(order.vat_cents), valueX, y, { size: 9.5 });

  y -= 10;
  page.drawLine({
    start: { x: labelX, y }, end: { x: valueX, y }, thickness: 1, color: LINE,
  });

  y -= 20;
  text("Total due", labelX, y, { size: 12, font: bold });
  right(`${order.currency} ${formatMoney(order.total_cents, false)}`, valueX, y,
    { size: 13, font: bold, color: BRAND });

  if (order.status === "PAID") {
    y -= 24;
    right("PAID — THANK YOU", valueX, y, { size: 11, font: bold, color: SUCCESS });
  }

  /* --- Payment details ---------------------------------------------------- */

  y -= 46;
  rule(y);
  y -= 20;

  text("PAYMENT DETAILS", MARGIN, y, { size: 8, font: bold, color: SUBTLE });
  y -= 16;

  for (const [label, value] of [
    ["Bank", banking.bank],
    ["Account name", banking.accountName],
    ["Account number", banking.accountNumber],
    ["Branch code", banking.branchCode],
    ["SWIFT", banking.swift],
  ]) {
    text(label, MARGIN, y, { size: 9, color: SUBTLE });
    text(value, MARGIN + 100, y, { size: 9 });
    y -= 13;
  }

  y -= 6;
  text("Payment reference", MARGIN, y, { size: 9, color: SUBTLE });
  text(order.invoice_number, MARGIN + 100, y, { size: 9, font: bold, color: BRAND });

  /* --- Footer ------------------------------------------------------------- */

  const footY = MARGIN + 8;
  rule(footY + 22);
  text(
    `${company.legalName} · ${company.addressLines.join(", ")} · ${company.phone} · ${company.website}`,
    MARGIN, footY + 8, { size: 7.5, color: SUBTLE },
  );
  text(
    "This invoice is issued in South African Rand and includes VAT at the standard rate.",
    MARGIN, footY - 2, { size: 7.5, color: SUBTLE },
  );

  return doc.save();
}
