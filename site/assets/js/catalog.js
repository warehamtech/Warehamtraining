import { sb, unwrap } from "./supabase.js";

/**
 * Catalogue queries. Port of src/lib/queries/catalog.ts.
 *
 * `published` is not filtered here — the RLS policy on `programs` already
 * restricts anon and learners to published rows, and a WHA admin legitimately
 * sees drafts. Filtering again in the query would hide drafts from the admin
 * catalogue view for no benefit.
 */

const CARD_FIELDS = `
  id, slug, title, summary, standard, price_cents, duration_hours, published,
  courses ( id, lessons ( id ) )
`;

function toCard(program) {
  const courses = program.courses ?? [];
  return {
    id: program.id,
    slug: program.slug,
    title: program.title,
    summary: program.summary,
    standard: program.standard,
    priceCents: program.price_cents,
    durationHours: program.duration_hours,
    published: program.published,
    courseCount: courses.length,
    lessonCount: courses.reduce((total, course) => total + (course.lessons?.length ?? 0), 0),
  };
}

export async function listPrograms(limit) {
  let query = sb.from("programs").select(CARD_FIELDS).order("title");
  if (limit) query = query.limit(limit);
  return (await query.then(unwrap)).map(toCard);
}

/** Full programme detail, including the curriculum shown on the sales page. */
export async function getProgramBySlug(slug) {
  const program = await sb
    .from("programs")
    .select(`
      id, slug, title, summary, description, standard, hero_image_url,
      price_cents, duration_hours, published,
      courses (
        id, title, summary, position,
        lessons ( id, title, position, type, duration_minutes ),
        quizzes ( id, title, pass_mark_percent )
      )
    `)
    .eq("slug", slug)
    .maybeSingle()
    .then(unwrap);

  if (!program) return null;

  const courses = [...(program.courses ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((course) => ({
      ...course,
      lessons: [...(course.lessons ?? [])].sort((a, b) => a.position - b.position),
      quiz: Array.isArray(course.quizzes) ? course.quizzes[0] ?? null : course.quizzes ?? null,
    }));

  return {
    id: program.id,
    slug: program.slug,
    title: program.title,
    summary: program.summary,
    description: program.description,
    standard: program.standard,
    heroImageUrl: program.hero_image_url,
    priceCents: program.price_cents,
    durationHours: program.duration_hours,
    published: program.published,
    courses,
    courseCount: courses.length,
    lessonCount: courses.reduce((total, course) => total + course.lessons.length, 0),
    totalMinutes: courses.reduce(
      (total, course) =>
        total + course.lessons.reduce((sum, l) => sum + (l.duration_minutes ?? 0), 0),
      0,
    ),
  };
}

/** The seats this person holds, for the dashboard and the "already enrolled" hint. */
export async function listMyEnrollments(userId) {
  return sb
    .from("enrollments")
    .select(`
      id, status, program_id, activated_at, started_at, completed_at, last_seen_at,
      program:programs ( id, slug, title, standard ),
      certificates ( id, serial, verify_code, issued_at )
    `)
    .eq("user_id", userId)
    .neq("status", "REVOKED")
    .order("activated_at", { ascending: false })
    .then(unwrap);
}
