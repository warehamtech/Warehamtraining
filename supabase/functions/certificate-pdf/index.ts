/**
 * Certificate of completion PDF.
 *
 * Port of src/lib/pdf/certificate.tsx. Landscape A4 with the WHA seal, the
 * courses covered, the serial, and a QR code pointing at the public
 * verification page.
 *
 * Read through the CALLER'S JWT, so the certificates policy decides whether
 * the document exists for them: the holder, their team administrator, or WHA
 * staff. The learner's name and programme title come from the snapshot taken
 * when the certificate was issued, so renaming anything later never rewrites
 * an already-issued certificate.
 */
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import QRCode from "npm:qrcode@1.5.4";
import { CORS, clientFor, company, formatDate, fail, SITE_URL } from "../_shared/wha.ts";

const BRAND = rgb(6 / 255, 71 / 255, 155 / 255);
const BRAND_DARK = rgb(5 / 255, 47 / 255, 102 / 255);
const ACCENT = rgb(240 / 255, 121 / 255, 0 / 255);
const INK = rgb(44 / 255, 51 / 255, 63 / 255);
const MUTED = rgb(74 / 255, 85 / 255, 104 / 255);
const SUBTLE = rgb(113 / 255, 128 / 255, 150 / 255);

// A4 landscape.
const PAGE = { width: 841.89, height: 595.28 };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return fail("Method not allowed", 405);

  const sb = clientFor(request);
  if (!sb) return fail("Not signed in.", 401);

  const { certificate_id } = await request.json().catch(() => ({}));
  if (!certificate_id) return fail("Missing certificate_id.");

  const { data: certificate } = await sb.from("certificates")
    .select(`
      serial, verify_code, learner_name, program_title, issued_at, revoked_at,
      enrollment:enrollments (
        user:profiles ( job_title, organization:organizations ( name ) ),
        program:programs ( standard, courses ( title, position ) )
      )
    `)
    .eq("id", certificate_id)
    .maybeSingle();

  if (!certificate) return fail("You don't have access to that certificate.", 403);
  if (certificate.revoked_at) return fail("That certificate has been revoked.", 410);

  const pdf = await render(certificate);

  return new Response(pdf, {
    headers: {
      ...CORS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${certificate.serial}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});

// deno-lint-ignore no-explicit-any
async function render(certificate: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate ${certificate.serial}`);
  doc.setAuthor(company.legalName);

  const page = doc.addPage([PAGE.width, PAGE.height]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const centre = (
    value: string,
    y: number,
    { size = 12, font = regular, color = INK } = {},
  ) => {
    const width = font.widthOfTextAtSize(value, size);
    page.drawText(value, { x: (PAGE.width - width) / 2, y, size, font, color });
  };

  /* --- Border ------------------------------------------------------------- */

  page.drawRectangle({
    x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: rgb(1, 1, 1),
  });
  // Brand band down the left edge.
  page.drawRectangle({ x: 0, y: 0, width: 14, height: PAGE.height, color: BRAND });
  page.drawRectangle({ x: 14, y: 0, width: 4, height: PAGE.height, color: ACCENT });

  page.drawRectangle({
    x: 40, y: 32, width: PAGE.width - 80, height: PAGE.height - 64,
    borderColor: rgb(0.88, 0.91, 0.95), borderWidth: 1,
  });

  /* --- Header ------------------------------------------------------------- */

  let y = PAGE.height - 78;
  centre(company.legalName.toUpperCase(), y, { size: 11, font: bold, color: BRAND });

  y -= 40;
  centre("CERTIFICATE OF COMPLETION", y, { size: 27, font: bold, color: BRAND_DARK });

  y -= 18;
  page.drawLine({
    start: { x: PAGE.width / 2 - 50, y },
    end: { x: PAGE.width / 2 + 50, y },
    thickness: 2,
    color: ACCENT,
  });

  /* --- Recipient ---------------------------------------------------------- */

  y -= 40;
  centre("This is to certify that", y, { size: 11, font: italic, color: SUBTLE });

  y -= 38;
  centre(certificate.learner_name, y, { size: 30, font: bold, color: INK });

  const holder = certificate.enrollment?.user;
  const subtitle = [holder?.job_title, holder?.organization?.name]
    .filter(Boolean).join(" · ");
  if (subtitle) {
    y -= 20;
    centre(subtitle, y, { size: 11, color: MUTED });
  }

  y -= 32;
  centre("has successfully completed the training programme", y,
    { size: 11, font: italic, color: SUBTLE });

  y -= 30;
  centre(certificate.program_title, y, { size: 19, font: bold, color: BRAND });

  const standard = certificate.enrollment?.program?.standard;
  if (standard) {
    y -= 20;
    centre(standard, y, { size: 11, color: ACCENT, font: bold });
  }

  /* --- Courses covered ---------------------------------------------------- */

  const courses = [...(certificate.enrollment?.program?.courses ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((course) => course.title);

  if (courses.length) {
    y -= 34;
    centre("COURSES COVERED", y, { size: 8, font: bold, color: SUBTLE });
    y -= 16;

    // Wrap the course list to the page rather than letting it run off the edge.
    const maxWidth = PAGE.width - 200;
    let line = "";
    for (const title of courses) {
      const candidate = line ? `${line}  ·  ${title}` : title;
      if (regular.widthOfTextAtSize(candidate, 9.5) > maxWidth) {
        centre(line, y, { size: 9.5, color: MUTED });
        y -= 14;
        line = title;
      } else {
        line = candidate;
      }
    }
    if (line) centre(line, y, { size: 9.5, color: MUTED });
  }

  /* --- Footer: seal, signature, verification ------------------------------ */

  const footY = 74;

  // Seal.
  page.drawCircle({ x: 150, y: footY + 16, size: 30, color: ACCENT });
  page.drawCircle({
    x: 150, y: footY + 16, size: 24,
    borderColor: rgb(1, 1, 1), borderWidth: 1.2, color: ACCENT,
  });
  const sealTop = "WHA";
  page.drawText(sealTop, {
    x: 150 - bold.widthOfTextAtSize(sealTop, 12) / 2,
    y: footY + 19, size: 12, font: bold, color: rgb(1, 1, 1),
  });
  const sealYear = String(new Date(certificate.issued_at).getFullYear());
  page.drawText(sealYear, {
    x: 150 - regular.widthOfTextAtSize(sealYear, 7) / 2,
    y: footY + 8, size: 7, font: regular, color: rgb(1, 1, 1),
  });

  // Signature block.
  page.drawLine({
    start: { x: 300, y: footY + 26 }, end: { x: 470, y: footY + 26 },
    thickness: 0.8, color: rgb(0.8, 0.84, 0.89),
  });
  page.drawText("Grant Wareham", { x: 300, y: footY + 12, size: 10, font: bold, color: INK });
  page.drawText("Managing Director", { x: 300, y: footY, size: 8, font: regular, color: SUBTLE });

  page.drawText(`Issued ${formatDate(certificate.issued_at)}`,
    { x: 300, y: footY - 16, size: 8, font: regular, color: SUBTLE });
  page.drawText(`Serial ${certificate.serial}`,
    { x: 300, y: footY - 28, size: 8, font: regular, color: SUBTLE });

  /* --- QR code ------------------------------------------------------------ */

  const verifyUrl =
    `${SITE_URL}/verify/certificate.html?code=${encodeURIComponent(certificate.verify_code)}`;

  try {
    const dataUrl = await QRCode.toDataURL(verifyUrl, {
      margin: 0,
      width: 240,
      errorCorrectionLevel: "M",
      color: { dark: "#052f66", light: "#ffffff" },
    });
    const png = await doc.embedPng(dataUrl);
    page.drawImage(png, { x: PAGE.width - 190, y: footY - 14, width: 76, height: 76 });
  } catch (error) {
    console.error("[certificate-pdf] QR generation failed", error);
  }

  page.drawText("Verify this certificate", {
    x: PAGE.width - 190, y: footY - 28, size: 7.5, font: bold, color: SUBTLE,
  });
  page.drawText(certificate.verify_code, {
    x: PAGE.width - 190, y: footY - 39, size: 7.5, font: regular, color: SUBTLE,
  });
  page.drawText(`${SITE_URL.replace(/^https?:\/\//, "")}/verify/`, {
    x: PAGE.width - 190, y: footY - 50, size: 7, font: regular, color: SUBTLE,
  });

  return doc.save();
}
