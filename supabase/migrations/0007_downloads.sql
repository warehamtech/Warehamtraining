-- WHA Learning Portal — downloadable content gating
--
-- Programme- and course-level downloadable material, with an optional hard
-- gate: a learner may be required to open (and acknowledge) certain
-- downloads before they can tick off a lesson or sit a course's assessment.
--
-- The gate is enforced at the two places a learner's progress state actually
-- changes — the lesson_progress INSERT policy and submit_quiz_attempt() —
-- not by hiding content. Lesson content isn't secret to an enrolled learner
-- today (storage signed URLs are the real file gate); this is a workflow
-- control, so it belongs where progress is written, which is exactly how
-- this schema already gates the assessment on "every lesson complete."
--
-- Fully additive and inert until an admin attaches a required download:
-- course_downloads_acknowledged() returns true whenever no required row
-- exists for a programme/course, so no existing enrollment is affected until
-- someone opts a programme into this.

create table public.program_downloads (
  id            uuid primary key default gen_random_uuid(),
  program_id    uuid not null references public.programs (id) on delete cascade,
  -- null = "before the whole programme"; set = "before this course/section".
  course_id     uuid references public.courses (id) on delete cascade,
  title         text not null,
  file_key      text not null,
  original_name text not null,
  content_type  text not null,
  size_bytes    integer not null,
  -- Required downloads block progress (see the gate below); non-required
  -- ones are just an extra link on the download-gate / course page.
  required      boolean not null default true,
  position      integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index program_downloads_program_id_idx on public.program_downloads (program_id, position);
create index program_downloads_course_id_idx on public.program_downloads (course_id) where course_id is not null;

create trigger program_downloads_touch
  before update on public.program_downloads
  for each row execute function public.touch_updated_at();

-- A learner-asserted "I've reviewed this" fact — one-way, like lesson_progress.
create table public.download_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  enrollment_id   uuid not null references public.enrollments (id) on delete cascade,
  download_id     uuid not null references public.program_downloads (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (enrollment_id, download_id)
);

create index download_acknowledgements_enrollment_id_idx
  on public.download_acknowledgements (enrollment_id);

-- ---------------------------------------------------------------------------
-- The gate.
--
-- True when every REQUIRED download that applies to this enrollment's
-- programme (course_id is null) or to p_course_id specifically has a matching
-- acknowledgement. No required rows configured → trivially true.
-- ---------------------------------------------------------------------------

create or replace function public.course_downloads_acknowledged(
  p_enrollment_id uuid,
  p_course_id     uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.program_downloads pd
    join public.enrollments e on e.id = p_enrollment_id
    where pd.required
      and pd.program_id = e.program_id
      and (pd.course_id is null or pd.course_id = p_course_id)
      and not exists (
        select 1 from public.download_acknowledgements da
        where da.enrollment_id = p_enrollment_id and da.download_id = pd.id
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges & RLS
-- ---------------------------------------------------------------------------

grant select on public.program_downloads to authenticated;
grant insert, update, delete on public.program_downloads to authenticated;

grant select, insert on public.download_acknowledgements to authenticated;

alter table public.program_downloads       enable row level security;
alter table public.download_acknowledgements enable row level security;

create policy program_downloads_select on public.program_downloads
  for select using (
    public.is_wha_admin() or public.is_enrolled_on(program_id)
  );

create policy program_downloads_write_admin on public.program_downloads
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy download_acknowledgements_select on public.download_acknowledgements
  for select using (
    public.owns_enrollment(enrollment_id)
    or public.administers_enrollment(enrollment_id)
    or public.is_wha_admin()
  );

-- Insert-only, and only the seat holder — an acknowledgement is a one-way
-- fact with no server computation behind it, so there's nothing for a
-- SECURITY DEFINER function to check beyond ownership.
create policy download_acknowledgements_insert on public.download_acknowledgements
  for insert with check (public.owns_enrollment(enrollment_id));

grant execute on function public.course_downloads_acknowledged(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Wire the gate into lesson_progress — ticking a lesson complete now also
-- requires every required download for its course/programme to be
-- acknowledged first.
-- ---------------------------------------------------------------------------

drop policy lesson_progress_insert on public.lesson_progress;

create policy lesson_progress_insert on public.lesson_progress
  for insert with check (
    public.owns_enrollment(enrollment_id)
    and public.course_downloads_acknowledged(
      enrollment_id,
      (select course_id from public.lessons where id = lesson_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Wire the gate into submit_quiz_attempt — replaces the function defined in
-- 0003_functions.sql, adding one check (marked below) and otherwise
-- unchanged, so a learner cannot route around the lesson-level gate by
-- jumping straight to the assessment.
-- ---------------------------------------------------------------------------

create or replace function public.submit_quiz_attempt(
  p_enrollment_id uuid,
  p_quiz_id       uuid,
  p_answers       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program_id      uuid;
  v_status          public.enrollment_status;
  v_course_id       uuid;
  v_pass_mark       integer;
  v_max_attempts    integer;
  v_attempts_used   integer;
  v_already_passed  boolean;
  v_total           integer;
  v_correct         integer;
  v_score           integer;
  v_passed          boolean;
  v_attempt_id      uuid;
begin
  -- Ownership.
  select e.program_id, e.status into v_program_id, v_status
  from public.enrollments e
  where e.id = p_enrollment_id and e.user_id = auth.uid();

  if v_program_id is null then
    return jsonb_build_object('ok', false, 'error', 'You don''t have access to this assessment.');
  end if;
  if v_status = 'REVOKED' then
    return jsonb_build_object('ok', false, 'error', 'This enrolment is no longer active.');
  end if;

  -- The assessment belongs to this programme.
  select q.course_id, q.pass_mark_percent, q.max_attempts
    into v_course_id, v_pass_mark, v_max_attempts
  from public.quizzes q
  join public.courses c on c.id = q.course_id
  where q.id = p_quiz_id and c.program_id = v_program_id;

  if v_course_id is null then
    return jsonb_build_object('ok', false, 'error', 'That assessment isn''t part of this programme.');
  end if;

  -- Downloads gate: cannot route around the lesson-level gate by jumping
  -- straight to the assessment. (New in 0007_downloads.sql.)
  if not public.course_downloads_acknowledged(p_enrollment_id, v_course_id) then
    return jsonb_build_object('ok', false,
      'error', 'Review the required downloads for this course before taking the assessment.');
  end if;

  -- Unlocked: the course has lessons and every one of them is ticked off.
  -- A course with no lessons is NOT unlocked, matching lessonsComplete in
  -- src/lib/progress.ts.
  if not exists (select 1 from public.lessons where course_id = v_course_id)
     or exists (
       select 1
       from public.lessons l
       where l.course_id = v_course_id
         and not exists (
           select 1 from public.lesson_progress lp
           where lp.enrollment_id = p_enrollment_id and lp.lesson_id = l.id
         )
     ) then
    return jsonb_build_object('ok', false,
      'error', 'Complete every lesson in this course before taking the assessment.');
  end if;

  select count(*), bool_or(passed) into v_attempts_used, v_already_passed
  from public.quiz_attempts
  where quiz_id = p_quiz_id and enrollment_id = p_enrollment_id;

  if coalesce(v_already_passed, false) then
    return jsonb_build_object('ok', false, 'error', 'You''ve already passed this assessment.');
  end if;
  if v_attempts_used >= v_max_attempts then
    return jsonb_build_object('ok', false, 'error', 'You have no attempts remaining.');
  end if;

  select count(*) into v_total from public.questions where quiz_id = p_quiz_id;
  if v_total = 0 then
    return jsonb_build_object('ok', false, 'error', 'This assessment has no questions yet.');
  end if;

  -- Every question answered, and every answer a real choice belonging to the
  -- question it was submitted against.
  if exists (
    select 1
    from public.questions qu
    where qu.quiz_id = p_quiz_id
      and not exists (
        select 1 from public.choices ch
        where ch.question_id = qu.id
          and ch.id::text = p_answers ->> qu.id::text
      )
  ) then
    return jsonb_build_object('ok', false, 'error', 'Answer every question before submitting.');
  end if;

  -- Marking.
  select count(*) filter (where ch.is_correct) into v_correct
  from public.questions qu
  join public.choices ch
    on ch.question_id = qu.id
   and ch.id::text = p_answers ->> qu.id::text
  where qu.quiz_id = p_quiz_id;

  v_score  := round((v_correct::numeric / v_total) * 100);
  v_passed := v_score >= v_pass_mark;

  insert into public.quiz_attempts (quiz_id, enrollment_id, score_percent, passed)
  values (p_quiz_id, p_enrollment_id, v_score, v_passed)
  returning id into v_attempt_id;

  insert into public.answer_records (attempt_id, question_id, choice_id, correct)
  select v_attempt_id, qu.id, ch.id, ch.is_correct
  from public.questions qu
  join public.choices ch
    on ch.question_id = qu.id
   and ch.id::text = p_answers ->> qu.id::text
  where qu.quiz_id = p_quiz_id;

  -- Passing the final assessment can complete the whole programme.
  if v_passed and public.is_program_complete(p_enrollment_id) then
    update public.enrollments
    set status = 'COMPLETED', completed_at = now()
    where id = p_enrollment_id and status = 'ACTIVE';
  end if;

  update public.enrollments
  set last_seen_at = now(),
      started_at = coalesce(started_at, now())
  where id = p_enrollment_id;

  return jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt_id,
    'score_percent', v_score,
    'passed', v_passed,
    'correct_count', v_correct,
    'total_questions', v_total,
    -- Authoritative, so the result screen never has to guess whether a
    -- refresh has landed yet.
    'attempts_left', greatest(0, v_max_attempts - (v_attempts_used + 1))
  );
end;
$$;
