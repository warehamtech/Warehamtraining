/**
 * Shrink a proof-of-payment image before it reaches Supabase Storage.
 *
 * A phone screenshot of an EFT confirmation is routinely 3-8 MB as a PNG; the
 * same image re-encoded as a JPEG at a sane resolution is typically under
 * 200 KB with no loss anyone reviewing a bank reference and an amount would
 * ever notice. This is what keeps the `proofs` bucket small as invoice volume
 * grows, without touching how long anything is kept — see the retention note
 * in README.md.
 *
 * PDFs pass through untouched: they're usually small already (mostly text),
 * and there's no lightweight way to recompress one in the browser.
 */

const MAX_DIMENSION = 1600;
const QUALITY = 0.82;

/**
 * @param {File} file
 * @returns {Promise<File>} the original file, or a smaller JPEG replacement
 */
export async function compressProofImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Unreadable/corrupt image — let the upload proceed with the original and
    // let the normal upload error handling deal with it if it's really bad.
    return file;
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", QUALITY));

  // A tiny or already-compressed source image can come back larger after
  // re-encoding — keep whichever is actually smaller.
  if (!blob || blob.size >= file.size) return file;

  const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
}
