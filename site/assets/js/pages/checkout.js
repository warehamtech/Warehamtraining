import { el, mount, param, page, setTitle } from "../dom.js";
import { icon } from "../icons.js";
import { appChrome } from "../shell.js";
import {
  buttonLink, card, cardBody, cardHeader, emptyState, field,
  setFieldErrors, setFormMessage, setPending,
} from "../ui.js";
import { requireUser } from "../session.js";
import { rpc } from "../supabase.js";
import { getProgramBySlug } from "../catalog.js";
import { formatMoney, calculateTotals } from "../money.js";
import { billing, banking, company } from "../config.js";
import { sendMail } from "../mail.js";

/** Port of src/app/(app)/checkout/[slug]/ — page + checkout-form. */

function validate(values) {
  const errors = {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.billingEmail)) {
    errors.billingEmail = "Enter a valid billing email address";
  }
  if (values.buyerType === "COMPANY" && !values.companyName) {
    errors.companyName = "Enter the company name for the invoice";
  }
  if (values.buyerType === "COMPANY" && (values.seats < 1 || values.seats > 500)) {
    errors.seats = "Enter a seat count between 1 and 500";
  }
  return errors;
}

page(async () => {
  const user = await requireUser();
  appChrome(user);

  const slug = param("slug");
  const program = slug ? await getProgramBySlug(slug) : null;

  if (!program || !program.published) {
    mount("#app", emptyState({
      iconName: "search",
      title: "That programme isn't available",
      action: buttonLink("Browse the catalogue", "/programs/index.html"),
    }));
    return;
  }

  setTitle(`Enrol — ${program.title}`);

  // Someone already attached to a company may only buy on its behalf if they
  // administer it. Mirrors the check inside create_order_with_invoice().
  const canBuyForCompany =
    !user.organization_id || user.role === "ORG_ADMIN" || user.role === "WHA_ADMIN";

  const summaryTotals = el("dl", { class: "dl" });
  const seatsField = field({
    label: "Number of seats", name: "seats", type: "number",
    value: 1, min: 1, max: 500, required: true,
    hint: "One seat per learner. Seats are allocated by your team administrator.",
  });

  const companyFields = el("div", { class: "stack" }, [
    field({
      label: "Company name", name: "companyName", required: true,
      autocomplete: "organization",
      value: user.organizationName ?? "",
    }),
    field({ label: "VAT number", name: "vatNumber", hint: "Optional — printed on the invoice." }),
  ]);

  const form = el("form", { novalidate: true, id: "checkout-form", class: "stack--lg" }, [
    el("div", { "data-message": "" }),

    card([
      cardHeader("Who is this for?"),
      cardBody(el("div", { class: "stack" }, [
        el("div", { class: "buyer-choice", role: "radiogroup", "aria-label": "Buyer type" }, [
          el("label", { class: "choice" }, [
            el("input", { type: "radio", name: "buyerType", value: "INDIVIDUAL", checked: true }),
            el("span", {}, [
              el("strong", { class: "block" }, "Just me"),
              el("span", { class: "subtle t-sm" }, "A single seat, invoiced to you."),
            ]),
          ]),
          el("label", { class: canBuyForCompany ? "choice" : "choice choice--disabled" }, [
            el("input", {
              type: "radio", name: "buyerType", value: "COMPANY",
              disabled: !canBuyForCompany,
            }),
            el("span", {}, [
              el("strong", { class: "block" }, "My company"),
              el("span", { class: "subtle t-sm" },
                canBuyForCompany
                  ? "One or more seats, invoiced to the business."
                  : "Only your team administrator can buy on the company's behalf."),
            ]),
          ]),
        ]),
        seatsField,
        companyFields,
      ])),
    ]),

    card([
      cardHeader("Billing details", {
        description: "These appear on the tax invoice exactly as entered.",
      }),
      cardBody(el("div", { class: "stack" }, [
        field({
          label: "Billing email", name: "billingEmail", type: "email", required: true,
          value: user.email, autocomplete: "email",
          hint: "The invoice is sent here.",
        }),
        field({ label: "Address line 1", name: "addressLine1", autocomplete: "address-line1" }),
        field({ label: "Address line 2", name: "addressLine2", autocomplete: "address-line2" }),
        el("div", { class: "grid grid--halves" }, [
          field({ label: "City", name: "city", autocomplete: "address-level2" }),
          field({ label: "Postal code", name: "postalCode", autocomplete: "postal-code" }),
        ]),
      ])),
    ]),

    el("button", { class: "btn btn--accent btn--lg btn--block", type: "submit" },
      "Issue my invoice"),

    el("p", { class: "subtle t-xs center" },
      `No card required. You will receive a VAT invoice from ${company.legalName} to settle by EFT.`),
  ]);

  const summary = el("aside", { class: "sticky-panel" },
    card([
      cardHeader("Order summary"),
      cardBody([
        el("p", { class: "medium" }, program.title),
        program.standard ? el("p", { class: "subtle t-sm mt-1" }, program.standard) : null,
        el("div", { class: "mt-4" }, summaryTotals),
        el("ul", { class: "feature-list feature-list--divided" }, [
          ["receipt", `Invoice due within ${billing.paymentTermDays} days`],
          ["building", `Pay by EFT to ${banking.bank}`],
          ["checkCircle", "Seats activate once payment is confirmed"],
        ].map(([name, text]) =>
          el("li", {}, [icon(name, 16, { class: "i-brand" }), text]))),
      ]),
    ]));

  function refreshSummary() {
    const isCompany = form.elements.buyerType.value === "COMPANY";
    const seats = isCompany ? Math.max(1, Number(form.elements.seats.value) || 1) : 1;
    const totals = calculateTotals(program.priceCents, seats);

    seatsField.hidden = !isCompany;
    companyFields.hidden = !isCompany;

    summaryTotals.replaceChildren(
      ...[
        ["Price per seat", formatMoney(program.priceCents)],
        ["Seats", String(seats)],
        ["Subtotal", formatMoney(totals.subtotalCents)],
        [`VAT @ ${billing.vatRate * 100}%`, formatMoney(totals.vatCents)],
      ].map(([term, value]) =>
        el("div", {}, [el("dt", {}, term), el("dd", { class: "tabular" }, value)])),
      el("div", { class: "dl-total" }, [
        el("dt", { class: "medium" }, "Total incl. VAT"),
        el("dd", { class: "tabular t-lg medium" }, formatMoney(totals.totalCents)),
      ]),
    );
  }

  form.addEventListener("input", refreshSummary);
  form.addEventListener("change", refreshSummary);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormMessage(form, null);

    const buyerType = form.elements.buyerType.value;
    const values = {
      buyerType,
      seats: buyerType === "COMPANY" ? Number(form.elements.seats.value) || 1 : 1,
      companyName: form.elements.companyName.value.trim(),
      vatNumber: form.elements.vatNumber.value.trim(),
      billingEmail: form.elements.billingEmail.value.trim().toLowerCase(),
      addressLine1: form.elements.addressLine1.value.trim(),
      addressLine2: form.elements.addressLine2.value.trim(),
      city: form.elements.city.value.trim(),
      postalCode: form.elements.postalCode.value.trim(),
    };

    const errors = validate(values);
    setFieldErrors(form, errors);
    if (Object.keys(errors).length) return;

    setPending(form, true);

    // Prices and totals are recomputed inside the function from the
    // programme's own price — nothing here decides what is charged.
    const result = await rpc("create_order_with_invoice", {
      p_program_id: program.id,
      p_buyer_type: values.buyerType,
      p_seats: values.seats,
      p_company_name: values.companyName || null,
      p_vat_number: values.vatNumber || null,
      p_billing_email: values.billingEmail,
      p_address_line1: values.addressLine1 || null,
      p_address_line2: values.addressLine2 || null,
      p_city: values.city || null,
      p_postal_code: values.postalCode || null,
    });

    if (!result.ok) {
      setPending(form, false);
      setFormMessage(form, result.error);
      return;
    }

    // A mail failure must not lose the sale — the order exists and the invoice
    // is downloadable in the portal either way.
    await sendMail("invoice", { order_id: result.order_id }).catch((error) =>
      console.error("[checkout] invoice email failed", error));

    location.href = `/orders/order.html?id=${result.order_id}`;
  });

  mount("#app",
    el("div", { class: "page-head" },
      el("div", {}, [
        el("h1", { class: "display" }, "Enrol"),
        el("p", {}, program.title),
      ])),
    el("div", { class: "grid grid--detail" }, [form, summary]));

  refreshSummary();
});
