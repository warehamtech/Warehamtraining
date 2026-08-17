import { billing } from "./config.js";

/** Format integer cents as a ZAR amount, e.g. 1250000 -> "R 12 500.00". */
export function formatMoney(cents, withSymbol = true) {
  const amount = (Number(cents ?? 0) / 100).toFixed(2);
  const [whole, fraction] = amount.split(".");
  // South African convention uses a space as the thousands separator.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const value = `${grouped}.${fraction}`;
  return withSymbol ? `${billing.currencySymbol} ${value}` : value;
}

/**
 * Work out invoice totals from a unit price and seat count.
 *
 * Prices are held VAT-exclusive; VAT is rounded once on the subtotal so the
 * three figures on the invoice always reconcile exactly.
 *
 * This is for SHOWING the buyer what they are about to be charged. The figures
 * actually written to the invoice are recomputed by create_order_with_invoice()
 * from the programme's own price, so a tampered client cannot choose its total.
 */
export function calculateTotals(unitPriceCents, seats) {
  const subtotalCents = unitPriceCents * seats;
  const vatCents = Math.round(subtotalCents * billing.vatRate);
  return {
    subtotalCents,
    vatCents,
    totalCents: subtotalCents + vatCents,
    vatRate: billing.vatRate,
  };
}
