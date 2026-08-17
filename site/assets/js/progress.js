import { sb, unwrap } from "./supabase.js";

/**
 * Every percentage shown anywhere in the portal is produced here — the learner
 * dashboard, the player sidebar, the team table and the certificate button all
 * call into this module, so they cannot drift apart.
 *
 * Port of src/lib/progress.ts. One difference matters: this runs in the
 * browser, so it decides what to DISPLAY, not what is allowed. The
 * authoritative completion check lives in SQL as is_program_complete(), and
 * issue_certificate() calls it before minting anything. Faking a 100% bar here
 * gets you a green bar and no certificate.
 *
 * Completion rules:
 *   lesson complete  → a lesson_progress row exists
 *   quiz complete    → a passing quiz_attempt exists
 *   course complete  → every lesson ticked AND its quiz passed (if it has one)
 *   program complete → every course complete
 *
 * The progress bar counts "steps": one per lesson plus one per assessment.
 * This means the bar reaches 100% exactly when the certificate unlocks, rather
 * than sitting at 100% while a failed assessment silently blocks it.
 */

function percentOf(done, total) {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

const byPosition = (a, b) => a.position - b.position;

/** PostgREST returns a one-to-one embed as an object on some versions and a
 *  single-element array on others. Normalise. */
function one(value) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * Batched so the dashboard and the team progress table stay at a fixed number
 * of queries regardless of how many seats they render.
 */
export async function getProgressForEnrollments(enrollmentIds) {
  const result = new Map();
  if (!enrollmentIds?.length) return result;

  const [enrollments, progressRows, attempts] = await Promise.all([
    sb.from("enrollments")
      .select(`
        id,
        program:programs (
          id, title, slug,
          courses (
            id, title, summary, position,
            lessons ( id, title, position, type, duration_minutes ),
            quizzes ( id, title, pass_mark_percent, max_attempts )
          )
        )
      `)
      .in("id", enrollmentIds)
      .then(unwrap),
    sb.from("lesson_progress")
      .select("enrollment_id, lesson_id")
      .in("enrollment_id", enrollmentIds)
      .then(unwrap),
    sb.from("quiz_attempts")
      .select("enrollment_id, quiz_id, passed, score_percent")
      .in("enrollment_id", enrollmentIds)
      .then(unwrap),
  ]);

  const completedByEnrollment = new Map();
  for (const row of progressRows) {
    let set = completedByEnrollment.get(row.enrollment_id);
    if (!set) {
      set = new Set();
      completedByEnrollment.set(row.enrollment_id, set);
    }
    set.add(row.lesson_id);
  }

  const attemptsByKey = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.enrollment_id}:${attempt.quiz_id}`;
    const current = attemptsByKey.get(key) ?? { count: 0, passed: false, best: null };
    current.count += 1;
    current.passed = current.passed || attempt.passed;
    current.best =
      current.best === null
        ? attempt.score_percent
        : Math.max(current.best, attempt.score_percent);
    attemptsByKey.set(key, current);
  }

  for (const enrollment of enrollments) {
    const done = completedByEnrollment.get(enrollment.id) ?? new Set();
    const courses = [];

    let totalLessons = 0;
    let completedLessons = 0;
    let totalAssessments = 0;
    let passedAssessments = 0;
    let completedCourses = 0;
    let nextStep = null;

    for (const course of [...(enrollment.program.courses ?? [])].sort(byPosition)) {
      const lessons = [...(course.lessons ?? [])].sort(byPosition).map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        position: lesson.position,
        type: lesson.type,
        durationMinutes: lesson.duration_minutes,
        complete: done.has(lesson.id),
      }));

      const courseCompletedLessons = lessons.filter((l) => l.complete).length;
      const lessonsComplete =
        lessons.length > 0 && courseCompletedLessons === lessons.length;

      const rawQuiz = one(course.quizzes);
      let quiz = null;
      if (rawQuiz) {
        const summary = attemptsByKey.get(`${enrollment.id}:${rawQuiz.id}`);
        const attemptsUsed = summary?.count ?? 0;
        const passed = summary?.passed ?? false;
        quiz = {
          id: rawQuiz.id,
          title: rawQuiz.title,
          passMarkPercent: rawQuiz.pass_mark_percent,
          maxAttempts: rawQuiz.max_attempts,
          attemptsUsed,
          attemptsLeft: Math.max(0, rawQuiz.max_attempts - attemptsUsed),
          bestScorePercent: summary?.best ?? null,
          passed,
          canAttempt: !passed && attemptsUsed < rawQuiz.max_attempts,
          // Assessments only open once every lesson in the course is ticked off.
          unlocked: lessonsComplete,
        };
      }

      const complete = lessonsComplete && (quiz ? quiz.passed : true);

      // Steps within this course, for the per-course ring.
      const courseSteps = lessons.length + (quiz ? 1 : 0);
      const courseDoneSteps = courseCompletedLessons + (quiz?.passed ? 1 : 0);

      courses.push({
        id: course.id,
        title: course.title,
        summary: course.summary,
        position: course.position,
        lessons,
        totalLessons: lessons.length,
        completedLessons: courseCompletedLessons,
        quiz,
        lessonsComplete,
        complete,
        percent: percentOf(courseDoneSteps, courseSteps),
      });

      totalLessons += lessons.length;
      completedLessons += courseCompletedLessons;
      if (quiz) {
        totalAssessments += 1;
        if (quiz.passed) passedAssessments += 1;
      }
      if (complete) completedCourses += 1;

      if (!nextStep) {
        const nextLesson = lessons.find((l) => !l.complete);
        if (nextLesson) {
          nextStep = {
            kind: "lesson",
            courseId: course.id,
            lessonId: nextLesson.id,
            title: nextLesson.title,
          };
        } else if (quiz && !quiz.passed && quiz.canAttempt) {
          nextStep = {
            kind: "quiz",
            courseId: course.id,
            quizId: quiz.id,
            title: quiz.title,
          };
        }
      }
    }

    const totalSteps = totalLessons + totalAssessments;
    const completedSteps = completedLessons + passedAssessments;
    const totalCourses = courses.length;

    result.set(enrollment.id, {
      enrollmentId: enrollment.id,
      programId: enrollment.program.id,
      programTitle: enrollment.program.title,
      programSlug: enrollment.program.slug,
      courses,
      totalLessons,
      completedLessons,
      totalAssessments,
      passedAssessments,
      totalSteps,
      completedSteps,
      percent: percentOf(completedSteps, totalSteps),
      totalCourses,
      completedCourses,
      complete: totalCourses > 0 && completedCourses === totalCourses,
      nextStep: nextStep ?? { kind: "done" },
    });
  }

  return result;
}

export async function getEnrollmentProgress(enrollmentId) {
  const map = await getProgressForEnrollments([enrollmentId]);
  return map.get(enrollmentId) ?? null;
}

/** True when every course in the programme is complete — shows the claim button. */
export function isCertificateEligible(progress) {
  return progress.complete;
}

/** Where "Continue" should take this learner. */
export function nextStepHref(progress) {
  const step = progress.nextStep;
  if (step.kind === "lesson") {
    return `/learn/lesson.html?e=${progress.enrollmentId}&l=${step.lessonId}`;
  }
  if (step.kind === "quiz") {
    return `/learn/quiz.html?e=${progress.enrollmentId}&q=${step.quizId}`;
  }
  return `/learn/index.html?e=${progress.enrollmentId}`;
}
