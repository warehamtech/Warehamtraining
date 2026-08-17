import { sb } from "./supabase.js";
import { SUPABASE_URL } from "./env.js";
import { el } from "./dom.js";

/**
 * Invoice and certificate PDFs.
 *
 * The documents are rendered by Edge Functions rather than in the browser,
 * because they are records: the totals on an invoice and the name on a
 * certificate must come from the database, not from whatever the page happens
 * to be holding. Each function verifies the caller's JWT and re-applies the
 * same visibility rule the tables use before it emits a byte.
 */

async function fetchPdf(fn, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Please sign in again.");

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 403) throw new Error("You don't have access to that document.");
    if (response.status === 404) throw new Error("That document could not be found.");
    throw new Error(detail || "The document could not be generated. Please try again.");
  }

  return response.blob();
}

/** Push a blob at the browser as a download. */
function save(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Give the download a moment to start before the URL is torn down.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Run a download with the button showing its own progress, so a slow render
 * does not look like a dead click. Returns nothing; errors are surfaced next
 * to the button.
 */
async function withButton(node, label, work) {
  const original = node ? [...node.childNodes] : [];
  if (node) {
    node.disabled = true;
    node.replaceChildren(el("span", { class: "btn__spinner" }), label);
  }

  try {
    await work();
  } catch (error) {
    const message = el("p", {
      class: "t-sm mt-2",
      role: "alert",
      style: { color: "var(--danger)" },
    }, error.message);
    node?.after(message);
    setTimeout(() => message.remove(), 8000);
  } finally {
    if (node) {
      node.disabled = false;
      node.replaceChildren(...original);
    }
  }
}

export function downloadInvoice(orderId, invoiceNumber, buttonNode) {
  return withButton(buttonNode, "Preparing…", async () => {
    const blob = await fetchPdf("invoice-pdf", { order_id: orderId });
    save(blob, `${invoiceNumber ?? "invoice"}.pdf`);
  });
}

export function downloadCertificate(certificateId, buttonNode) {
  return withButton(buttonNode, "Preparing…", async () => {
    const blob = await fetchPdf("certificate-pdf", { certificate_id: certificateId });
    save(blob, "certificate.pdf");
  });
}
