import { sb } from "./supabase.js";

/**
 * Shared upload helper for the `lesson-media` bucket, extracted out of the
 * lesson editor because Phase 2's image blocks and Phase 3's downloads both
 * need the identical sanitize → key → upload sequence admin-lesson.js
 * originally had inline.
 */
export const MAX_LESSON_MEDIA_UPLOAD = 500 * 1024 * 1024; // matches the bucket limit

/**
 * Upload a file into `lesson-media`, keyed by programme id — that is what the
 * bucket's storage policy checks when deciding who may read it back.
 *
 * Returns the storage key, or null if the upload was refused.
 */
export async function uploadLessonMedia(file, programId, prefix) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const key = `${programId}/${prefix}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await sb.storage.from("lesson-media").upload(key, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  return error ? null : key;
}
