/**
 * Transactional email.
 *
 * Port of src/lib/email.ts plus the sendMail calls that were scattered through
 * the server actions.
 *
 * The caller names a KIND and an id. It never supplies a recipient, a subject
 * or a body — this function re-reads the record through the caller's own JWT
 * (so RLS decides whether they may see it at all) and builds the message from
 * that. The result is that a tampered client can, at worst, re-send a message
 * someone was already entitled to receive. It cannot send arbitrary mail from
 * the WHA domain.
 */
import {
  CORS, clientFor, serviceClient, emailLayout, sendMail, formatMoney, esc,
  json, fail, SITE_URL, SUPABASE_URL,
} from "../_shared/wha.ts";

type Body = {
  kind: "invoice" | "proof_received" | "activated" | "invite" | "seat_assigned" | "certificate";
  order_id?: string;
  token?: string;
  member_id?: string;
  program_id?: string;
  certificate_id?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return fail("Method not allowed", 405);

  const sb = clientFor(request);
  if (!sb) return fail("Not signed in.", 401);

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return fail("Not signed in.", 401);

  const authorization = request.headers.get("Authorization")!;

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.kind) return fail("Missing kind.");

  try {
    switch (body.kind) {
      case "invoice":        return json(await invoice(sb, body.order_id!, authorization));
      case "proof_received": return json(await proofReceived(sb, body.order_id!));
      case "activated":      return json(await activated(sb, body.order_id!));
      case "invite":         return json(await invite(sb, body.token!));
      case "seat_assigned":  return json(await seatAssigned(sb, body.member_id!, body.program_id!));
      case "certificate":    return json(await certificate(sb, body.certificate_id!, authorization));
      default:               return fail("Unknown kind.");
    }
  } catch (error) {
    console.error("[send-mail]", error);
    return fail(error instanceof Error ? error.message : "Send failed.", 500);
  }
});

/* --- Orders --------------------------------------------------------------- */

async function loadOrder(sb: ReturnType<typeof clientFor>, orderId: string) {
  // Read AS THE CALLER: the orders policy is the port of canViewOrder, so an
  // order they may not see simply is not here.
  const { data } = await sb!.from("orders")
    .select(`
      id, invoice_number, seats, total_cents, status,
      billing_name, billing_email,
      program:programs ( title ),
      user:profiles ( name, email )
    `)
    .eq("id", orderId)
    .maybeSingle();
  return data;
}

async function invoice(sb: ReturnType<typeof clientFor>, orderId: string, authorization: string) {
  const order = await loadOrder(sb, orderId);
  if (!order) return { sent: false, reason: "not-permitted" };

  const pdf = await renderInvoice(orderId, authorization);
  const seatLine = order.seats > 1 ? `${order.seats} seats on ` : "";

  return sendMail({
    to: order.billing_email,
    subject: `Tax invoice ${order.invoice_number} — ${order.program.title}`,
    attachments: pdf
      ? [{ filename: `${order.invoice_number}.pdf`, content: pdf, contentType: "application/pdf" }]
      : undefined,
    html: emailLayout({
      heading: `Invoice ${esc(order.invoice_number)}`,
      body: `
        <p>Thank you for your order of ${seatLine}<strong>${esc(order.program.title)}</strong>.</p>
        <p>Your tax invoice for <strong>${formatMoney(order.total_cents)}</strong> (incl. VAT)
           is attached. Please pay by EFT using <strong>${esc(order.invoice_number)}</strong> as
           your payment reference.</p>
        <p>Once you have paid, upload your proof of payment in the portal. We activate
           your training as soon as payment is confirmed.</p>
      `,
      cta: { label: "Upload proof of payment", url: `${SITE_URL}/orders/order.html?id=${order.id}` },
    }),
  });
}

/** Tell WHA staff there is something waiting in the review queue. */
async function proofReceived(sb: ReturnType<typeof clientFor>, orderId: string) {
  const order = await loadOrder(sb, orderId);
  if (!order) return { sent: false, reason: "not-permitted" };

  // The admin roster is not readable by the buyer, so this one lookup needs
  // the service client. The order itself was still authorised above.
  const { data: admins } = await serviceClient()
    .from("profiles").select("email").eq("role", "WHA_ADMIN");

  const results = await Promise.all((admins ?? []).map((admin) =>
    sendMail({
      to: admin.email,
      subject: `Proof of payment received — ${order.invoice_number}`,
      html: emailLayout({
        heading: "Proof of payment awaiting review",
        body: `
          <p><strong>${esc(order.billing_name)}</strong> has uploaded proof of payment for
             invoice <strong>${esc(order.invoice_number)}</strong>
             (${formatMoney(order.total_cents)}).</p>
          <p>Review it and activate the order to release the seats.</p>
        `,
        cta: { label: "Open the invoice queue", url: `${SITE_URL}/admin/invoices.html` },
      }),
    })));

  return { sent: results.some((r) => r.sent), recipients: results.length };
}

async function activated(sb: ReturnType<typeof clientFor>, orderId: string) {
  const order = await loadOrder(sb, orderId);
  if (!order) return { sent: false, reason: "not-permitted" };

  const isTeam = order.seats > 1;
  const to = order.user?.email ?? order.billing_email;
  const name = order.user?.name ?? order.billing_name;

  return sendMail({
    to,
    subject: `Your training is active — ${order.program.title}`,
    html: emailLayout({
      heading: "Payment confirmed — your training is active",
      body: `
        <p>Hello ${esc(name)},</p>
        <p>We have received payment for invoice <strong>${esc(order.invoice_number)}</strong> and
           activated ${isTeam ? `<strong>${order.seats} seats</strong> on` : "your access to"}
           <strong>${esc(order.program.title)}</strong>.</p>
        ${isTeam
          ? "<p>You can now allocate those seats to your team from the Team page. Each person you assign receives their own login and progress tracking.</p>"
          : "<p>You can start straight away — your progress is saved as you go, and your certificate is issued once you complete every course.</p>"}
      `,
      cta: {
        label: isTeam ? "Allocate seats" : "Start learning",
        url: `${SITE_URL}${isTeam ? "/team/index.html" : "/dashboard.html"}`,
      },
    }),
  });
}

/* --- Team ----------------------------------------------------------------- */

async function invite(sb: ReturnType<typeof clientFor>, token: string) {
  // The invites policy limits this to the issuing organisation's admin.
  const { data: row } = await sb!.from("invites")
    .select("email, token, expires_at, organization:organizations ( name ), program:programs ( title )")
    .eq("token", token)
    .maybeSingle();
  if (!row) return { sent: false, reason: "not-permitted" };

  const { data: { user } } = await sb!.auth.getUser();
  const { data: sender } = await sb!.from("profiles")
    .select("name").eq("id", user!.id).maybeSingle();

  return sendMail({
    to: row.email,
    subject: `You've been invited to training by ${row.organization.name}`,
    html: emailLayout({
      heading: "Your training account is ready to set up",
      body: `
        <p>${esc(sender?.name ?? "A colleague")} has invited you to the Wareham &amp; Associates
           learning portal on behalf of <strong>${esc(row.organization.name)}</strong>.</p>
        ${row.program?.title
          ? `<p>You've been allocated a seat on <strong>${esc(row.program.title)}</strong>.</p>`
          : ""}
        <p>This invitation expires in 14 days.</p>
      `,
      cta: {
        label: "Set up your account",
        url: `${SITE_URL}/invite.html?token=${encodeURIComponent(row.token)}`,
      },
    }),
  });
}

async function seatAssigned(
  sb: ReturnType<typeof clientFor>, memberId: string, programId: string,
) {
  // Both reads are subject to RLS: a team admin may read their own members,
  // and everyone may read a published programme.
  const [{ data: member }, { data: program }, { data: { user } }] = await Promise.all([
    sb!.from("profiles").select("name, email").eq("id", memberId).maybeSingle(),
    sb!.from("programs").select("title").eq("id", programId).maybeSingle(),
    sb!.auth.getUser(),
  ]);
  if (!member || !program) return { sent: false, reason: "not-permitted" };

  const { data: sender } = await sb!.from("profiles")
    .select("name").eq("id", user!.id).maybeSingle();

  return sendMail({
    to: member.email,
    subject: `You've been given access to ${program.title}`,
    html: emailLayout({
      heading: "A training seat has been allocated to you",
      body: `
        <p>Hello ${esc(member.name)},</p>
        <p>${esc(sender?.name ?? "Your team administrator")} has allocated you a seat on
           <strong>${esc(program.title)}</strong>. You can start whenever you're ready —
           your progress is saved as you go.</p>
      `,
      cta: { label: "Start learning", url: `${SITE_URL}/dashboard.html` },
    }),
  });
}

/* --- Certificates --------------------------------------------------------- */

async function certificate(
  sb: ReturnType<typeof clientFor>, certificateId: string, authorization: string,
) {
  const { data: cert } = await sb!.from("certificates")
    .select("id, serial, program_title, enrollment:enrollments ( user:profiles ( name, email ) )")
    .eq("id", certificateId)
    .maybeSingle();
  if (!cert?.enrollment?.user) return { sent: false, reason: "not-permitted" };

  const pdf = await renderCertificate(certificateId, authorization);

  return sendMail({
    to: cert.enrollment.user.email,
    subject: `Your certificate — ${cert.program_title}`,
    attachments: pdf
      ? [{ filename: `${cert.serial}.pdf`, content: pdf, contentType: "application/pdf" }]
      : undefined,
    html: emailLayout({
      heading: "Congratulations — here is your certificate",
      body: `
        <p>You've completed every course and assessment in
           <strong>${esc(cert.program_title)}</strong>.</p>
        <p>Your certificate is attached. It carries the serial
           <strong>${esc(cert.serial)}</strong>, and anyone can confirm it is genuine
           at ${SITE_URL}/verify/.</p>
      `,
      cta: { label: "View your certificates", url: `${SITE_URL}/certificates.html` },
    }),
  });
}

/* --- Attachments ---------------------------------------------------------- */

/**
 * Fetch the PDF from the sibling function rather than duplicating the layout.
 *
 * The caller's own Authorization header is forwarded, so the PDF function
 * applies the same visibility check it would for a direct download — this
 * function does not become a way to obtain a document the caller could not
 * fetch itself. A failure here costs the attachment, not the email: the
 * document is always downloadable from the portal.
 */
async function renderFrom(fn: string, body: unknown, authorization: string) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(`[send-mail] ${fn} returned ${response.status}`);
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.error(`[send-mail] ${fn} attachment failed`, error);
    return null;
  }
}

const renderInvoice = (orderId: string, authorization: string) =>
  renderFrom("invoice-pdf", { order_id: orderId }, authorization);

const renderCertificate = (certificateId: string, authorization: string) =>
  renderFrom("certificate-pdf", { certificate_id: certificateId }, authorization);
