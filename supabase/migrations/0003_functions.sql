-- WHA Learning Portal — server logic
--
-- Everything that must not be decided by the browser lives here: marking,
-- number allocation, activation, seat movement and certificate issue. Each
-- function is SECURITY DEFINER (so it can write tables the caller has no
-- policy for) and re-checks its own gates in SQL — the UI hiding a button is
-- never the reason an action is unavailable.
--
-- These are ports of the server actions in wha-portal/src/lib/actions/.

-- ---------------------------------------------------------------------------
-- Progress
--
-- The browser computes the percentages it displays (assets/js/progress.js).
-- This function is the authoritative version used to gate the certificate, so
-- a tampered client cannot claim one early.
--
-- Completion rules, unchanged from src/lib/progress.ts:
--   lesson complete  → a lesson_progress row exists
--   quiz complete    → a passing quiz_attempt exists
--   course complete  → every lesson ticked AND its quiz passed (if it has one)
--   program complete → every course complete
-- ---------------------------------------------------------------------------

create or replace function public.is_program_complete(p_enrollment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with e as (
    select id, program_id from public.enrollments where id = p_enrollment_id
  ),
  course_state as (
    select
      c.id,
      -- every lesson in this course ticked off for this seat
      not exists (
        select 1
        from public.lessons l
        where l.course_id = c.id
          and not exists (
            select 1 from public.lesson_progress lp
            where lp.enrollment_id = p_enrollment_id and lp.lesson_id = l.id
          )
      ) as lessons_done,
      -- a course with no lessons at all is not "complete"
      exists (select 1 from public.lessons l where l.course_id = c.id) as has_lessons,
      -- its assessment passed, or it has none
      not exists (
        select 1
        from public.quizzes q
        where q.course_id = c.id
          and not exists (
            select 1 from public.quiz_attempts a
            where a.quiz_id = q.id
              and a.enrollment_id = p_enrollment_id
              and a.passed
          )
      ) as quiz_done
    from public.courses c
    join e on e.program_id = c.program_id
  )
  select
    exists (select 1 from course_state)
    and not exists (
      select 1 from course_state
      where not (has_lessons and lessons_done and quiz_done)
    );
$$;

-- ---------------------------------------------------------------------------
-- submit_quiz_attempt
--
-- Port of src/lib/actions/quiz.ts. All marking happens here. The client is
-- never sent is_correct (see the column REVOKE in 0002_rls.sql), so the only
-- way to find the answers is to answer them.
--
-- p_answers is {"<question_id>": "<choice_id>", ...}.
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

-- ---------------------------------------------------------------------------
-- admin_quiz
--
-- The one legitimate reader of is_correct. The authoring screen has to show
-- which choice is marked correct, but `choices.is_correct` is granted to
-- nobody (see 0002_rls.sql), so the editor reads the tree through here.
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
          'choices', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ch.id, 'text', ch.text,
              'position', ch.position, 'is_correct', ch.is_correct
            ) order by ch.position)
            from public.choices ch where ch.question_id = qu.id
          ), '[]'::jsonb)
        ) order by qu.position)
        from public.questions qu where qu.quiz_id = q.id
      ), '[]'::jsonb)
    )
    from public.quizzes q where q.id = p_quiz_id
  ) else null end;
$$;

-- ---------------------------------------------------------------------------
-- create_order_with_invoice
--
-- Port of checkoutAction + createOrderWithInvoice. Prices are read from the
-- programme here, never taken from the request, so the totals on the invoice
-- cannot be chosen by the buyer.
-- ---------------------------------------------------------------------------

create or replace function public.create_order_with_invoice(
  p_program_id    uuid,
  p_buyer_type    public.buyer_type,
  p_seats         integer,
  p_company_name  text,
  p_vat_number    text,
  p_billing_email text,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_postal_code   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_role       public.role;
  v_user_org   uuid;
  v_user_name  text;
  v_price      integer;
  v_seats      integer;
  v_subtotal   integer;
  v_vat        integer;
  v_total      integer;
  v_vat_rate   double precision := 0.15;
  v_org_id     uuid;
  v_prefix     text;
  v_seq        integer;
  v_invoice    text;
  v_address    text;
  v_order_id   uuid;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'Please sign in first.');
  end if;

  select role, organization_id, name into v_role, v_user_org, v_user_name
  from public.profiles where id = v_user_id;

  select price_cents into v_price
  from public.programs where id = p_program_id and published;

  if v_price is null then
    return jsonb_build_object('ok', false, 'error', 'That programme is no longer available.');
  end if;

  v_seats := case when p_buyer_type = 'COMPANY' then greatest(1, coalesce(p_seats, 1)) else 1 end;
  if v_seats > 500 then
    return jsonb_build_object('ok', false, 'error', 'Please contact us for orders above 500 seats.');
  end if;

  if p_buyer_type = 'COMPANY' and coalesce(trim(p_company_name), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Enter the company name for the invoice.');
  end if;

  v_subtotal := v_price * v_seats;
  v_vat      := round(v_subtotal * v_vat_rate);
  v_total    := v_subtotal + v_vat;

  if p_buyer_type = 'COMPANY' then
    if v_user_org is not null then
      -- Someone already attached to a company may only buy on its behalf if
      -- they administer it — otherwise this would be a privilege escalation.
      if v_role not in ('ORG_ADMIN', 'WHA_ADMIN') then
        return jsonb_build_object('ok', false, 'error',
          'Your account belongs to an organisation but you are not one of its administrators. Ask your team administrator to place this order, or buy a single seat for yourself.');
      end if;
      v_org_id := v_user_org;
      update public.organizations
      set name          = coalesce(nullif(trim(p_company_name), ''), name),
          vat_number    = nullif(trim(p_vat_number), ''),
          billing_email = p_billing_email,
          address_line1 = nullif(trim(p_address_line1), ''),
          address_line2 = nullif(trim(p_address_line2), ''),
          city          = nullif(trim(p_city), ''),
          postal_code   = nullif(trim(p_postal_code), '')
      where id = v_org_id;
    else
      insert into public.organizations
        (name, vat_number, billing_email, address_line1, address_line2, city, postal_code)
      values
        (trim(p_company_name), nullif(trim(p_vat_number), ''), p_billing_email,
         nullif(trim(p_address_line1), ''), nullif(trim(p_address_line2), ''),
         nullif(trim(p_city), ''), nullif(trim(p_postal_code), ''))
      returning id into v_org_id;

      -- The person who creates the company account administers it.
      update public.profiles
      set organization_id = v_org_id,
          role = case when role = 'WHA_ADMIN' then 'WHA_ADMIN' else 'ORG_ADMIN' end
      where id = v_user_id;
    end if;
  end if;

  v_prefix  := 'WHA-INV-' || to_char(now(), 'YYYY') || '-';
  v_seq     := public.next_number(v_prefix);
  v_invoice := v_prefix || lpad(v_seq::text, 4, '0');

  v_address := nullif(
    array_to_string(
      array_remove(array[
        nullif(trim(p_address_line1), ''),
        nullif(trim(p_address_line2), ''),
        nullif(trim(p_city), ''),
        nullif(trim(p_postal_code), '')
      ], null),
      E'\n'
    ), '');

  insert into public.orders (
    invoice_number, buyer_type, user_id, organization_id, program_id,
    seats, unit_price_cents, subtotal_cents, vat_cents, total_cents, vat_rate,
    billing_name, billing_email, billing_vat_number, billing_address, due_at
  ) values (
    v_invoice, p_buyer_type, v_user_id, v_org_id, p_program_id,
    v_seats, v_price, v_subtotal, v_vat, v_total, v_vat_rate,
    case when p_buyer_type = 'COMPANY' then trim(p_company_name) else v_user_name end,
    p_billing_email, nullif(trim(p_vat_number), ''), v_address,
    now() + interval '14 days'
  )
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'invoice_number', v_invoice);
end;
$$;

-- ---------------------------------------------------------------------------
-- activate_order / cancel_order
--
-- Port of activateOrderAction / cancelOrderAction. WHA admin only.
-- ---------------------------------------------------------------------------

create or replace function public.activate_order(
  p_order_id   uuid,
  p_admin_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid := auth.uid();
  v_order  public.orders;
  v_note   text := nullif(trim(coalesce(p_admin_note, '')), '');
begin
  if not public.is_wha_admin() then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if v_order.id is null then
    return jsonb_build_object('ok', false, 'error', 'Order not found.');
  end if;
  if v_order.status = 'PAID' then
    return jsonb_build_object('ok', false, 'error', 'This order is already active.');
  end if;
  if v_order.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'This order was cancelled and cannot be activated.');
  end if;

  update public.orders
  set status = 'PAID', paid_at = now(), activated_by_id = v_admin, admin_note = v_note
  where id = p_order_id;

  -- One enrollment row per purchased seat. An individual buyer is assigned
  -- their seat immediately; company seats stay unallocated until the team
  -- administrator hands them out.
  insert into public.enrollments (order_id, program_id, user_id, status)
  select
    v_order.id,
    v_order.program_id,
    case when v_order.buyer_type = 'INDIVIDUAL' then v_order.user_id else null end,
    'ACTIVE'
  from generate_series(1, v_order.seats);

  insert into public.audit_log (actor_id, action, entity_type, entity_id, meta)
  values (v_admin, 'order.activated', 'Order', v_order.id, jsonb_build_object(
    'invoice_number', v_order.invoice_number,
    'seats', v_order.seats,
    'total_cents', v_order.total_cents,
    'program_id', v_order.program_id,
    'note', v_note
  ));

  return jsonb_build_object(
    'ok', true, 'seats', v_order.seats, 'billing_name', v_order.billing_name
  );
end;
$$;

create or replace function public.cancel_order(
  p_order_id uuid,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid := auth.uid();
  v_status public.order_status;
  v_number text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_wha_admin() then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;

  select status, invoice_number into v_status, v_number
  from public.orders where id = p_order_id;

  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'Order not found.');
  end if;
  if v_status = 'PAID' then
    return jsonb_build_object('ok', false, 'error',
      'This order is already active. Revoke the individual seats instead of cancelling the invoice.');
  end if;

  update public.orders
  set status = 'CANCELLED', admin_note = v_reason
  where id = p_order_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, meta)
  values (v_admin, 'order.cancelled', 'Order', p_order_id,
          jsonb_build_object('invoice_number', v_number, 'reason', v_reason));

  return jsonb_build_object('ok', true, 'invoice_number', v_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- Certificates
--
-- Port of issueCertificate(). Idempotent: the unique constraint on
-- enrollment_id means a double click returns the existing certificate rather
-- than minting a second serial.
-- ---------------------------------------------------------------------------

-- Verification codes are what an auditor types in from the QR link, so they
-- use an unambiguous alphabet — no O/0, I/1/L — and are long enough that
-- guessing one is not worth attempting. Grouped XXXX-XXXX-XXXX.
create or replace function public.new_verify_code()
returns text
language plpgsql
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_out text := '';
  i integer;
begin
  for i in 1..12 loop
    v_out := v_out || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    if i % 4 = 0 and i < 12 then
      v_out := v_out || '-';
    end if;
  end loop;
  return v_out;
end;
$$;

create or replace function public.issue_certificate(p_enrollment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing     public.certificates;
  v_user_id      uuid;
  v_learner_name text;
  v_program      text;
  v_prefix       text;
  v_serial       text;
  v_code         text;
  v_cert         public.certificates;
begin
  -- Only the seat holder claims their own certificate; WHA staff may issue on
  -- someone's behalf.
  if not (public.owns_enrollment(p_enrollment_id) or public.is_wha_admin()) then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;

  select * into v_existing from public.certificates where enrollment_id = p_enrollment_id;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'certificate_id', v_existing.id,
                              'serial', v_existing.serial, 'verify_code', v_existing.verify_code);
  end if;

  select e.user_id, p.name, pr.title
    into v_user_id, v_learner_name, v_program
  from public.enrollments e
  join public.programs pr on pr.id = e.program_id
  left join public.profiles p on p.id = e.user_id
  where e.id = p_enrollment_id;

  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'That enrolment has no learner assigned.');
  end if;

  -- Never trust the caller's view of completion — recompute it here.
  if not public.is_program_complete(p_enrollment_id) then
    return jsonb_build_object('ok', false, 'error',
      'This programme isn''t complete yet. Finish every lesson and pass each assessment first.');
  end if;

  v_prefix := 'WHA-CERT-' || to_char(now(), 'YYYY') || '-';
  v_serial := v_prefix || lpad(public.next_number(v_prefix)::text, 5, '0');

  loop
    v_code := public.new_verify_code();
    exit when not exists (select 1 from public.certificates where verify_code = v_code);
  end loop;

  insert into public.certificates
    (enrollment_id, serial, verify_code, learner_name, program_title)
  values
    (p_enrollment_id, v_serial, v_code, v_learner_name, v_program)
  returning * into v_cert;

  update public.enrollments
  set status = 'COMPLETED', completed_at = now()
  where id = p_enrollment_id and status = 'ACTIVE';

  return jsonb_build_object('ok', true, 'certificate_id', v_cert.id,
                            'serial', v_serial, 'verify_code', v_code);
end;
$$;

-- Public certificate verification. Anon-callable by design — this is the page
-- an auditor lands on from the QR code. It returns only what confirms the
-- certificate is genuine, so a valid code is not a key to anything else.
create or replace function public.verify_certificate(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'found', true,
        'serial', c.serial,
        'learner_name', c.learner_name,
        'job_title', p.job_title,
        'program_title', c.program_title,
        'standard', pr.standard,
        'issued_at', c.issued_at,
        'revoked', c.revoked_at is not null,
        'organization_name', o.name,
        -- Named on the certificate itself, so an auditor can check the paper
        -- against the record rather than just the serial.
        'course_titles', coalesce((
          select jsonb_agg(co.title order by co.position)
          from public.courses co where co.program_id = pr.id
        ), '[]'::jsonb)
      )
      from public.certificates c
      join public.enrollments e on e.id = c.enrollment_id
      join public.programs pr on pr.id = e.program_id
      left join public.profiles p on p.id = e.user_id
      left join public.organizations o on o.id = p.organization_id
      where upper(replace(c.verify_code, '-', '')) = upper(replace(coalesce(p_code, ''), '-', ''))
    ),
    jsonb_build_object('found', false)
  );
$$;

-- ---------------------------------------------------------------------------
-- Team: invitations and seat movement
--
-- Ports of src/lib/actions/team.ts and acceptInviteAction.
-- ---------------------------------------------------------------------------

create or replace function public.create_invite(
  p_email      text,
  p_program_id uuid default null
)
returns jsonb
language plpgsql
security definer
-- `extensions` is on the path for gen_random_bytes(), which Supabase installs
-- pgcrypto into rather than public.
set search_path = public, extensions
as $$
declare
  v_user  uuid := auth.uid();
  v_org   uuid := public.my_org();
  v_email text := lower(trim(p_email));
  v_seat  uuid;
  v_token text;
  v_org_name text;
begin
  if public.my_role() <> 'ORG_ADMIN' or v_org is null then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'Enter a valid email address.');
  end if;

  if exists (select 1 from public.profiles where email = v_email and organization_id = v_org) then
    return jsonb_build_object('ok', false, 'error',
      v_email || ' is already a member of your team — assign them a seat from the table below.');
  end if;
  if exists (select 1 from public.profiles where email = v_email) then
    return jsonb_build_object('ok', false, 'error',
      v_email || ' already has a WHA account. Ask them to contact us on (021) 713-2380 so we can move them across.');
  end if;
  if exists (
    select 1 from public.invites
    where email = v_email and organization_id = v_org
      and accepted_at is null and expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'error', 'An invitation to ' || v_email || ' is already outstanding.');
  end if;

  -- Only allow assigning a programme the organisation actually owns seats on.
  if p_program_id is not null then
    select e.id into v_seat
    from public.enrollments e
    join public.orders o on o.id = e.order_id
    where e.program_id = p_program_id and e.user_id is null
      and e.status = 'ACTIVE' and o.organization_id = v_org
    limit 1;

    if v_seat is null then
      return jsonb_build_object('ok', false, 'error', 'There are no free seats left on that programme.');
    end if;
  end if;

  v_token := encode(gen_random_bytes(24), 'base64');
  v_token := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  insert into public.invites
    (organization_id, email, token, role, expires_at, invited_by_id, program_id)
  values
    (v_org, v_email, v_token, 'LEARNER', now() + interval '14 days', v_user, p_program_id);

  select name into v_org_name from public.organizations where id = v_org;

  return jsonb_build_object('ok', true, 'token', v_token, 'email', v_email,
                            'organization_name', v_org_name);
end;
$$;

-- Anon-callable: the invite page needs to show who invited you and to what
-- before you have an account. Returns nothing identifying beyond that.
create or replace function public.invite_details(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'valid', i.accepted_at is null and i.expires_at > now(),
        'email', i.email,
        'organization_name', o.name,
        'program_title', pr.title
      )
      from public.invites i
      join public.organizations o on o.id = i.organization_id
      left join public.programs pr on pr.id = i.program_id
      where i.token = p_token
    ),
    jsonb_build_object('valid', false)
  );
$$;

-- Redeem an invite. Called immediately after Supabase Auth creates the
-- account, so auth.uid() is the person who just signed up.
create or replace function public.accept_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_email  text;
  v_invite public.invites;
  v_seat   uuid;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'Please sign in first.');
  end if;

  select * into v_invite from public.invites where token = p_token for update;

  if v_invite.id is null or v_invite.accepted_at is not null or v_invite.expires_at < now() then
    return jsonb_build_object('ok', false, 'error',
      'This invitation is no longer valid. Ask for a new one.');
  end if;

  select email into v_email from public.profiles where id = v_user;
  if lower(v_email) <> lower(v_invite.email) then
    return jsonb_build_object('ok', false, 'error',
      'This invitation was issued to ' || v_invite.email || '. Sign up with that address.');
  end if;

  update public.profiles
  set organization_id = v_invite.organization_id, role = v_invite.role
  where id = v_user;

  update public.invites set accepted_at = now() where id = v_invite.id;

  -- Claim a free seat on the programme the invite was issued against, if one
  -- is still available. If the pool has been used up in the meantime the
  -- person still joins the team and the admin sees them as needing a seat.
  if v_invite.program_id is not null then
    select e.id into v_seat
    from public.enrollments e
    join public.orders o on o.id = e.order_id
    where e.program_id = v_invite.program_id and e.user_id is null
      and e.status = 'ACTIVE' and o.organization_id = v_invite.organization_id
    order by e.created_at
    limit 1
    for update of e skip locked;

    if v_seat is not null then
      update public.enrollments set user_id = v_user where id = v_seat and user_id is null;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'seat_claimed', v_seat is not null);
end;
$$;

create or replace function public.assign_seat(
  p_member_id  uuid,
  p_program_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid := public.my_org();
  v_name  text;
  v_seat  uuid;
  v_title text;
begin
  if public.my_role() <> 'ORG_ADMIN' or v_org is null then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;

  select name into v_name from public.profiles
  where id = p_member_id and organization_id = v_org;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'That person isn''t a member of your team.');
  end if;

  if exists (
    select 1 from public.enrollments
    where user_id = p_member_id and program_id = p_program_id
      and status in ('ACTIVE', 'COMPLETED')
  ) then
    return jsonb_build_object('ok', false, 'error', v_name || ' already has a seat on that programme.');
  end if;

  -- Claim the oldest free seat the organisation owns. SKIP LOCKED plus the
  -- `user_id is null` guard on the update makes this safe against two admins
  -- allocating at the same moment.
  select e.id into v_seat
  from public.enrollments e
  join public.orders o on o.id = e.order_id
  where e.program_id = p_program_id and e.user_id is null
    and e.status = 'ACTIVE' and o.organization_id = v_org
  order by e.created_at
  limit 1
  for update of e skip locked;

  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'There are no free seats on that programme.');
  end if;

  update public.enrollments set user_id = p_member_id
  where id = v_seat and user_id is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'That seat was just taken. Try again.');
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, meta)
  values (v_actor, 'seat.assigned', 'Enrollment', v_seat,
          jsonb_build_object('member_id', p_member_id, 'program_id', p_program_id));

  select title into v_title from public.programs where id = p_program_id;

  return jsonb_build_object('ok', true, 'member_name', v_name, 'program_title', v_title);
end;
$$;

create or replace function public.revoke_seat(p_enrollment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid := public.my_org();
  v_owner uuid;
begin
  if public.my_role() <> 'ORG_ADMIN' or v_org is null then
    return jsonb_build_object('ok', false, 'error', 'Not permitted.');
  end if;

  select e.user_id into v_owner
  from public.enrollments e
  join public.orders o on o.id = e.order_id
  where e.id = p_enrollment_id and o.organization_id = v_org;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'That seat doesn''t belong to your organisation.');
  end if;

  if exists (select 1 from public.certificates where enrollment_id = p_enrollment_id) then
    return jsonb_build_object('ok', false, 'error',
      'This learner has already been certified. Their seat can''t be reassigned — buy an additional seat instead.');
  end if;

  -- Returning the seat to the pool wipes the previous holder's progress, which
  -- is why it is blocked once a certificate exists.
  delete from public.lesson_progress where enrollment_id = p_enrollment_id;
  delete from public.quiz_attempts   where enrollment_id = p_enrollment_id;

  update public.enrollments
  set user_id = null, status = 'ACTIVE',
      started_at = null, completed_at = null, last_seen_at = null
  where id = p_enrollment_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, meta)
  values (v_actor, 'seat.returned_to_pool', 'Enrollment', p_enrollment_id,
          jsonb_build_object('previous_user_id', v_owner));

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Small helpers the pages call
-- ---------------------------------------------------------------------------

-- Marks the order as awaiting review once its proof row is in. Kept out of the
-- browser's reach so an order cannot be pushed into the queue without a file.
create or replace function public.mark_proof_submitted(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_view_order(p_order_id) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update public.orders
  set status = 'PROOF_SUBMITTED'
  where id = p_order_id
    and status = 'PENDING'
    and exists (select 1 from public.payment_proofs where order_id = p_order_id);
end;
$$;

create or replace function public.touch_enrollment(p_enrollment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.owns_enrollment(p_enrollment_id) then
    return;
  end if;
  update public.enrollments
  set last_seen_at = now(), started_at = coalesce(started_at, now())
  where id = p_enrollment_id;
  update public.profiles set last_active_at = now() where id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- EXECUTE is granted explicitly rather than relying on the PUBLIC default, so
-- adding a function does not silently expose it.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from anon, authenticated;

-- RLS policy expressions are evaluated with the privileges of the querying
-- role, so the helpers in 0002_rls.sql have to be executable by it — the blanket
-- REVOKE above would otherwise make every protected table error out. They leak
-- nothing: each one reports on the caller's own row, or takes an id the caller
-- had to know already.
grant execute on function public.my_role()                        to anon, authenticated;
grant execute on function public.my_org()                         to anon, authenticated;
grant execute on function public.is_wha_admin()                   to anon, authenticated;
grant execute on function public.is_enrolled_on(uuid)             to anon, authenticated;
grant execute on function public.can_view_order(uuid)             to anon, authenticated;
grant execute on function public.owns_enrollment(uuid)            to anon, authenticated;
grant execute on function public.administers_enrollment(uuid)     to anon, authenticated;

grant execute on function public.verify_certificate(text) to anon, authenticated;
grant execute on function public.invite_details(text)      to anon, authenticated;

grant execute on function public.submit_quiz_attempt(uuid, uuid, jsonb) to authenticated;
grant execute on function public.admin_quiz(uuid)                       to authenticated;
grant execute on function public.is_program_complete(uuid)              to authenticated;
grant execute on function public.create_order_with_invoice(uuid, public.buyer_type, integer, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.activate_order(uuid, text)   to authenticated;
grant execute on function public.cancel_order(uuid, text)     to authenticated;
grant execute on function public.issue_certificate(uuid)      to authenticated;
grant execute on function public.create_invite(text, uuid)    to authenticated;
grant execute on function public.accept_invite(text)          to authenticated;
grant execute on function public.assign_seat(uuid, uuid)      to authenticated;
grant execute on function public.revoke_seat(uuid)            to authenticated;
grant execute on function public.mark_proof_submitted(uuid)   to authenticated;
grant execute on function public.touch_enrollment(uuid)       to authenticated;
