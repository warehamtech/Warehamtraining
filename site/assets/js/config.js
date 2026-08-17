/**
 * Company, tax and banking details used on invoices and certificates.
 *
 * Address and contact details are taken from wha.co.za. The VAT number and
 * banking block are PLACEHOLDERS — replace them with the real values before
 * issuing a live invoice. The same values must be set as Edge Function secrets
 * (WHA_VAT_NUMBER and friends), because the PDF is rendered server-side and
 * does not read this file.
 */
export const company = {
  legalName: "Wareham & Associates",
  tradingName: "Wareham & Associates",
  addressLines: [
    "2 Thorpe Close",
    "Corner of Thorpe Close / Zwaanswyk Road",
    "Tokai",
    "7945",
  ],
  country: "South Africa",
  phone: "(021) 713-2380",
  email: "info1@wha.co.za",
  website: "wha.co.za",
  // TODO: replace with the real registered VAT number.
  vatNumber: "4XXXXXXXXX",
  registrationNumber: "XXXX/XXXXXX/XX",
};

/** TODO: replace with the real bank account before going live. */
export const banking = {
  bank: "Standard Bank",
  accountName: "Wareham & Associates",
  accountNumber: "000 000 000",
  branchCode: "051001",
  swift: "SBZAZAJJ",
};

export const billing = {
  currency: "ZAR",
  currencySymbol: "R",
  /** South African standard rate. Mirrors the 0.15 in create_order_with_invoice. */
  vatRate: 0.15,
  /** Days from issue until an invoice falls due. */
  paymentTermDays: 14,
};

export const site = {
  name: "WHA Learning Portal",
  supportEmail: "info1@wha.co.za",
};

/** Labels for the Role enum, used in the header and admin tables. */
export const roleLabels = {
  LEARNER: "Learner",
  ORG_ADMIN: "Team administrator",
  WHA_ADMIN: "WHA administrator",
};

/** Labels and badge tones for OrderStatus. */
export const orderStatus = {
  PENDING: { label: "Awaiting payment", tone: "warn" },
  PROOF_SUBMITTED: { label: "Proof submitted", tone: "brand" },
  PAID: { label: "Paid", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};

export const enrollmentStatus = {
  ACTIVE: { label: "In progress", tone: "brand" },
  COMPLETED: { label: "Completed", tone: "success" },
  REVOKED: { label: "Revoked", tone: "neutral" },
};
