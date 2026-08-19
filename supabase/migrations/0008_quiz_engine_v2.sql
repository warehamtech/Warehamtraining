-- WHA Learning Portal — expanded quiz engine
--
-- Adds three question types alongside multiple choice: short free-text
-- (exact match against admin-authored accepted answers), matching (drag/
-- click pairs), and ordering (arrange a list into the correct sequence).
-- All grading stays server-side and all-or-nothing per question, exactly
-- like today's multiple choice — this is a new dispatch inside
-- submit_quiz_attempt(), not a new security model.
--
-- Two new tables carry what a non-multiple-choice question needs:
--   question_items        the *visible* labels (matching pairs, ordering
--                          list) — no secret here, so it's fully selectable.
--   question_answer_keys  the correct pairing/order/accepted-text — granted
--                          NO select privilege to any client role at all
--                          (stronger than the column-grant trick choices.
--                          is_correct uses, and simpler: there is nothing
--                          else in these two tables worth exposing). Reachable
--                          only via admin_quiz() and submit_quiz_attempt(),
--                          both SECURITY DEFINER.

create type public.question_type as enum ('MULTIPLE_CHOICE', 'SHORT_TEXT', 'MATCHING', 'ORDERING');

alter table public.questions
  add column question_type public.question_type not null default 'MULTIPLE_CHOICE';

create table public.question_answer_keys (
  question_id uuid primary key references public.questions (id) on delete cascade,
  -- SHORT_TEXT → {"accepted": ["ISO 9001", "iso9001"], "case_sensitive": false}
  -- MATCHING   → {"pairs": [["<left_item_id>", "<right_item_id>"], …]}
  -- ORDERING   → {"order": ["<item_id_1>", "<item_id_2>", …]}  (correct sequence)
  key jsonb not null
);

create table public.question_items (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  -- 'LEFT'/'RIGHT' for MATCHING; null for ORDERING's flat list.
  side        text check (side in ('LEFT', 'RIGHT')),
  label       text not null
  -- Deliberately no ordinal/position column: for ORDERING, a stored position
  -- would itself leak the correct sequence since this table is selectable.
  -- The learner client shuffles at render time instead.
);

create index question_items_question_id_idx on public.question_items (question_id);

-- A non-multiple-choice answer isn't a choice_id, so the column becomes
-- optional and a jsonb `response` carries whatever was actually submitted
-- (kept, not re-derived, so the results screen can show "what you answered").
-- `question_type` is a snapshot at write time, the same pattern this schema
-- already uses for orders.billing_name / certificates.learner_name.
alter table public.answer_records
  alter column choice_id drop not null,
  add column response jsonb,
  add column question_type public.question_type not null default 'MULTIPLE_CHOICE';

alter table public.answer_records
  add constraint answer_records_shape_chk check (
    (question_type = 'MULTIPLE_CHOICE' and choice_id is not null and response is null)
    or
    (question_type <> 'MULTIPLE_CHOICE' and choice_id is null and response is not null)
  );

-- ---------------------------------------------------------------------------
-- Privileges & RLS
-- ---------------------------------------------------------------------------

-- No SELECT grant at all — see the header comment. The write policy still
-- covers insert/update/delete, the only privileges actually granted.
grant insert, update, delete on public.question_answer_keys to authenticated;
alter table public.question_answer_keys enable row level security;

create policy question_answer_keys_write_admin on public.question_answer_keys
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

-- Visible content — same trust level as `choices.text`.
grant select on public.question_items to anon, authenticated;
grant insert, update, delete on public.question_items to authenticated;
alter table public.question_items enable row level security;

create policy question_items_select on public.question_items
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.questions qu
      join public.quizzes q on q.id = qu.quiz_id
      join public.courses c on c.id = q.course_id
      where qu.id = question_items.question_id and public.is_enrolled_on(c.program_id)
    )
  );

create policy question_items_write_admin on public.question_items
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

-- ---------------------------------------------------------------------------
-- admin_quiz() — extended to also return question_type, items and the
-- answer key for non-multiple-choice questions. Still the one legitimate
-- reader of any answer key, same as it already was for choices.is_correct.
-- ---------------------------------------------------------------------------

create or replace function public.admin_quiz(p_quiz_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_wha_admin() then (
    select jsonb_build_object(
      'id', q.id,
      'title', q.title,
      'pass_mark_percent', q.pass_mark_percent,
      'max_attempts', q.max_attempts,
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', qu.id,
          'prompt', qu.prompt,
          'position', qu.position,
          'explanation', qu.explanation,
          'question_type', qu.question_type,
          'choices', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ch.id, 'text', ch.text,
              'position', ch.position, 'is_correct', ch.is_correct
            ) order by ch.position)
            from public.choices ch where ch.question_id = qu.id
          ), '[]'::jsonb),
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', qi.id, 'side', qi.side, 'label', qi.label
            ))
            from public.question_items qi where qi.question_id = qu.id
          ), '[]'::jsonb),
          'answer_key', (
            select qak.key from public.question_answer_keys qak
            where qak.question_id = qu.id
          )
        ) order by qu.position)
        from public.questions qu where qu.quiz_id = q.id
      ), '[]'::jsonb)
    )
    from public.quizzes q where q.id = p_quiz_id
  ) else null end;
$$;

-- ---------------------------------------------------------------------------
-- submit_quiz_attempt() — replaces the function from 0007_downloads.sql
-- (which itself replaced the original in 0003_functions.sql). Every check
-- from those versions is preserved, including the downloads gate; the
-- multiple-choice-only marking join is replaced with a per-question loop
-- that dispatches on the server-known question_type. The client's payload
-- never gets to declare its own type.
--
-- p_answers shape, per question, keyed by question_id:
--   {"<qid>": {"choice_id": "…"}}                        MULTIPLE_CHOICE
--   {"<qid>": {"text": "…"}}                              SHORT_TEXT
--   {"<qid>": {"pairs": [["<leftId>","<rightId>"], …]}}   MATCHING
--   {"<qid>": {"order": ["<id1>","<id2>", …]}}            ORDERING
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
  v_q               record;
  v_answer          jsonb;
  v_is_correct      boolean;
  v_response        jsonb;
  v_choice_id       uuid;
  v_key             jsonb;
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

  -- Downloads gate (0007_downloads.sql) — carried forward unchanged.
  if not public.course_downloads_acknowledged(p_enrollment_id, v_course_id) then
    return jsonb_build_object('ok', false,
      'error', 'Review the required downloads for this course before taking the assessment.');
  end if;

  -- Unlocked: the course has lessons and every one of them is ticked off.
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

  -- Every question must carry a submitted answer.
  if exists (
    select 1 from public.questions qu
    where qu.quiz_id = p_quiz_id and not (p_answers ? qu.id::text)
  ) then
    return jsonb_build_object('ok', false, 'error', 'Answer every question before submitting.');
  end if;

  -- Multiple-choice answers must reference a real choice on that question —
  -- checked up front so a garbage id fails cleanly here rather than tripping
  -- answer_records' shape constraint during marking below.
  if exists (
    select 1
    from public.questions qu
    where qu.quiz_id = p_quiz_id
      and qu.question_type = 'MULTIPLE_CHOICE'
      and not exists (
        select 1 from public.choices ch
        where ch.question_id = qu.id
          and ch.id::text = p_answers -> qu.id::text ->> 'choice_id'
      )
  ) then
    return jsonb_build_object('ok', false, 'error', 'Answer every question before submitting.');
  end if;

  -- The attempt row exists before marking so answer_records has something to
  -- reference; score/passed are backfilled once every question is marked.
  insert into public.quiz_attempts (quiz_id, enrollment_id, score_percent, passed)
  values (p_quiz_id, p_enrollment_id, 0, false)
  returning id into v_attempt_id;

  v_correct := 0;

  for v_q in
    select id, question_type from public.questions where quiz_id = p_quiz_id
  loop
    v_answer := p_answers -> v_q.id::text;
    v_is_correct := false;
    v_response := null;
    v_choice_id := null;

    if v_q.question_type = 'MULTIPLE_CHOICE' then
      v_choice_id := (v_answer ->> 'choice_id')::uuid;
      select ch.is_correct into v_is_correct
      from public.choices ch
      where ch.id = v_choice_id and ch.question_id = v_q.id;
      v_is_correct := coalesce(v_is_correct, false);

    elsif v_q.question_type = 'SHORT_TEXT' then
      select key into v_key from public.question_answer_keys where question_id = v_q.id;
      declare
        v_case_sensitive boolean := coalesce((v_key ->> 'case_sensitive')::boolean, false);
        v_given text := regexp_replace(trim(coalesce(v_answer ->> 'text', '')), '\s+', ' ', 'g');
      begin
        if not v_case_sensitive then v_given := lower(v_given); end if;
        v_is_correct := exists (
          select 1
          from jsonb_array_elements_text(coalesce(v_key -> 'accepted', '[]'::jsonb)) as accepted(value)
          where regexp_replace(trim(
                  case when v_case_sensitive then accepted.value else lower(accepted.value) end
                ), '\s+', ' ', 'g') = v_given
        );
      end;
      v_response := jsonb_build_object('text', v_answer ->> 'text');

    elsif v_q.question_type = 'MATCHING' then
      select key into v_key from public.question_answer_keys where question_id = v_q.id;
      declare
        v_submitted jsonb := coalesce(v_answer -> 'pairs', '[]'::jsonb);
        v_correct_pairs jsonb := coalesce(v_key -> 'pairs', '[]'::jsonb);
      begin
        v_is_correct :=
          jsonb_array_length(v_submitted) = jsonb_array_length(v_correct_pairs)
          and not exists (
            select 1 from jsonb_array_elements(v_submitted) as sp(val)
            where not exists (
              select 1 from jsonb_array_elements(v_correct_pairs) as kp(val)
              where kp.val = sp.val
            )
          );
      end;
      v_response := jsonb_build_object('pairs', v_answer -> 'pairs');

    elsif v_q.question_type = 'ORDERING' then
      select key into v_key from public.question_answer_keys where question_id = v_q.id;
      v_is_correct := coalesce(v_answer -> 'order', '[]'::jsonb) = coalesce(v_key -> 'order', '[]'::jsonb);
      v_response := jsonb_build_object('order', v_answer -> 'order');
    end if;

    if v_is_correct then v_correct := v_correct + 1; end if;

    insert into public.answer_records
      (attempt_id, question_id, choice_id, response, question_type, correct)
    values
      (v_attempt_id, v_q.id, v_choice_id, v_response, v_q.question_type, v_is_correct);
  end loop;

  v_score  := round((v_correct::numeric / v_total) * 100);
  v_passed := v_score >= v_pass_mark;

  update public.quiz_attempts
  set score_percent = v_score, passed = v_passed
  where id = v_attempt_id;

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
    'attempts_left', greatest(0, v_max_attempts - (v_attempts_used + 1))
  );
end;
$$;
