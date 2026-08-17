-- WHA Learning Portal — row level security
--
-- In the Next.js original the authorisation boundary was server-side:
-- `requireUser()` / `requireRole()` in lib/auth.ts, plus the two predicates in
-- lib/access.ts. There is no server any more, so RLS *is* the boundary. The
-- browser holds an anon key and a user JWT and can issue any query it likes;
-- everything below is what stops it.
--
-- The rules are ports, not reinventions — `orders` below is `canViewOrder`
-- transcribed into SQL.

-- ---------------------------------------------------------------------------
-- Helpers
--
-- SECURITY DEFINER so they can read `profiles` without recursing into the
-- profiles policies (a policy that selects from the table it protects
-- deadlocks). STABLE so the planner calls them once per statement.
-- ---------------------------------------------------------------------------

create or replace function public.my_role()
returns public.role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.my_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_wha_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from public.profiles where id = auth.uid()) = 'WHA_ADMIN',
    false
  );
$$;

-- True when the caller holds a seat on this programme. Gates access to the
-- course/lesson/quiz content of unpublished or paid programmes.
create or replace function public.is_enrolled_on(p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.enrollments
    where program_id = p_program_id
      and user_id = auth.uid()
      and status <> 'REVOKED'
  );
$$;

-- Port of canViewOrder() from src/lib/access.ts:
-- an order is visible to the person who placed it, to administrators of the
-- organisation it was billed to, and to WHA staff. Nobody else — including
-- other members of the same organisation.
create or replace function public.can_view_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.orders o
    where o.id = p_order_id
      and (
        public.is_wha_admin()
        or o.user_id = auth.uid()
        or (
          o.organization_id is not null
          and o.organization_id = public.my_org()
          and public.my_role() = 'ORG_ADMIN'
        )
      )
  );
$$;

-- True when the caller holds this seat.
create or replace function public.owns_enrollment(p_enrollment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.enrollments
    where id = p_enrollment_id and user_id = auth.uid()
  );
$$;

-- True when the caller is the ORG_ADMIN of the organisation that bought this
-- seat. Lets the team page read its members' progress without letting one
-- learner read another's.
create or replace function public.administers_enrollment(p_enrollment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.enrollments e
    join public.orders o on o.id = e.order_id
    where e.id = p_enrollment_id
      and o.organization_id is not null
      and o.organization_id = public.my_org()
      and public.my_role() = 'ORG_ADMIN'
  );
$$;

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- Supabase configures default privileges that would grant these automatically,
-- but relying on that leaves the security model implicit and dependent on
-- project settings. Spelling it out means a table is unreachable until it is
-- listed here, and it documents which tables are writable at all.
--
-- Privileges are the coarse gate ("may this role ever write here?"); the
-- policies below are the fine one ("may it write THIS row?"). Both must pass.
-- ---------------------------------------------------------------------------

-- Signed-out visitors get the public catalogue and nothing else. Everything
-- else they need (certificate verification, invite lookup) goes through an
-- RPC that returns a curated payload.
grant select on
  public.programs, public.courses, public.lessons
  to anon;

grant select on
  public.organizations, public.profiles, public.programs, public.courses,
  public.lessons, public.resources, public.quizzes, public.questions,
  public.orders, public.payment_proofs, public.enrollments,
  public.quiz_attempts, public.answer_records, public.lesson_progress,
  public.certificates, public.audit_log, public.invites
  to authenticated;

-- `choices` is granted COLUMN BY COLUMN, and `is_correct` is not among them.
--
-- This is the line that keeps the answer key off the wire. It has to be a
-- column-level grant rather than a table grant followed by
-- `revoke select (is_correct)`: PostgreSQL keeps table-level and column-level
-- privileges separately, so revoking a column never subtracts from a table
-- grant, and the revoke would silently do nothing.
--
-- Postgres checks column privileges for WHERE and RETURNING too, so
-- `?select=is_correct`, `?is_correct=eq.true` and
-- `update ... returning is_correct` all fail the same way. Marking is only
-- reachable through submit_quiz_attempt(); the admin editor reads the key back
-- through admin_quiz(), which is SECURITY DEFINER and checks is_wha_admin().
grant select (id, question_id, text, position) on public.choices to anon, authenticated;

-- Catalogue authoring. The policies restrict these to WHA_ADMIN.
grant insert, update, delete on
  public.programs, public.courses, public.lessons, public.resources,
  public.quizzes, public.questions, public.choices
  to authenticated;

-- Learner and buyer writes.
grant insert, delete on public.lesson_progress to authenticated;
grant insert on public.payment_proofs to authenticated;
grant update on public.profiles, public.organizations, public.enrollments to authenticated;

-- Deliberately absent: any write privilege on orders, quiz_attempts,
-- answer_records, certificates, invites, audit_log or number_counters. Those
-- tables only ever change from inside a SECURITY DEFINER function.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A table with RLS on and no matching policy denies by
-- default, which is the behaviour we want for anything not listed below.
-- ---------------------------------------------------------------------------

alter table public.organizations   enable row level security;
alter table public.profiles        enable row level security;
alter table public.programs        enable row level security;
alter table public.courses         enable row level security;
alter table public.lessons         enable row level security;
alter table public.resources       enable row level security;
alter table public.quizzes         enable row level security;
alter table public.questions       enable row level security;
alter table public.choices         enable row level security;
alter table public.orders          enable row level security;
alter table public.payment_proofs  enable row level security;
alter table public.enrollments     enable row level security;
alter table public.quiz_attempts   enable row level security;
alter table public.answer_records  enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.certificates    enable row level security;
alter table public.audit_log       enable row level security;
alter table public.number_counters enable row level security;
alter table public.invites         enable row level security;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

-- A team admin sees their own members; WHA staff see everyone (the
-- /admin/learners table).
create policy profiles_select_org on public.profiles
  for select using (
    public.is_wha_admin()
    or (
      organization_id is not null
      and organization_id = public.my_org()
      and public.my_role() = 'ORG_ADMIN'
    )
  );

-- Self-service edits only cover the display fields. `role` and
-- `organization_id` are deliberately excluded — see the trigger below.
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_update_admin on public.profiles
  for update using (public.is_wha_admin()) with check (public.is_wha_admin());

-- WITH CHECK cannot restrict *which columns* changed, so privilege escalation
-- ("update profiles set role='WHA_ADMIN' where id = auth.uid()") is blocked
-- here instead. The RPCs that legitimately move people between roles are
-- SECURITY DEFINER and bypass this.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  -- Only guard requests that arrived through PostgREST. `postgres` (the SQL
  -- editor, migrations) and `service_role` must stay able to fix data — the
  -- first WHA admin is promoted exactly that way, since there is no existing
  -- admin to do it from inside the app.
  if current_user not in ('anon', 'authenticated') or public.is_wha_admin() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'You cannot change your own role.' using errcode = '42501';
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'You cannot change your own organisation.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------

create policy organizations_select on public.organizations
  for select using (id = public.my_org() or public.is_wha_admin());

create policy organizations_update_admin on public.organizations
  for update using (
    public.is_wha_admin()
    or (id = public.my_org() and public.my_role() = 'ORG_ADMIN')
  ) with check (
    public.is_wha_admin()
    or (id = public.my_org() and public.my_role() = 'ORG_ADMIN')
  );

-- New organisations are created by the checkout RPC, not by the browser.

-- ---------------------------------------------------------------------------
-- Catalogue
--
-- The public catalogue is anon-readable when published. Course and lesson
-- detail is readable by anyone who can see the programme — the programme page
-- lists the curriculum as a selling point — but lesson *bodies* and media keys
-- are only useful to someone holding a seat, and the storage policies in
-- 0004 are what actually gate the files.
-- ---------------------------------------------------------------------------

create policy programs_select_published on public.programs
  for select using (published or public.is_wha_admin());

create policy programs_write_admin on public.programs
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy courses_select on public.courses
  for select using (
    public.is_wha_admin()
    or exists (
      select 1 from public.programs p
      where p.id = courses.program_id and p.published
    )
    or public.is_enrolled_on(courses.program_id)
  );

create policy courses_write_admin on public.courses
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy lessons_select on public.lessons
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.courses c
      join public.programs p on p.id = c.program_id
      where c.id = lessons.course_id
        and (p.published or public.is_enrolled_on(p.id))
    )
  );

create policy lessons_write_admin on public.lessons
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy resources_select on public.resources
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.lessons l
      join public.courses c on c.id = l.course_id
      where l.id = resources.lesson_id and public.is_enrolled_on(c.program_id)
    )
  );

create policy resources_write_admin on public.resources
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

-- ---------------------------------------------------------------------------
-- Assessment
-- ---------------------------------------------------------------------------

create policy quizzes_select on public.quizzes
  for select using (
    public.is_wha_admin()
    or exists (
      select 1 from public.courses c
      where c.id = quizzes.course_id and public.is_enrolled_on(c.program_id)
    )
  );

create policy quizzes_write_admin on public.quizzes
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy questions_select on public.questions
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.quizzes q
      join public.courses c on c.id = q.course_id
      where q.id = questions.quiz_id and public.is_enrolled_on(c.program_id)
    )
  );

create policy questions_write_admin on public.questions
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

create policy choices_select on public.choices
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.questions qu
      join public.quizzes q on q.id = qu.quiz_id
      join public.courses c on c.id = q.course_id
      where qu.id = choices.question_id and public.is_enrolled_on(c.program_id)
    )
  );

create policy choices_write_admin on public.choices
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());

-- Note: RLS is row-level, so no policy above can hide `is_correct` on a row a
-- learner is otherwise allowed to read. That protection is the column-level
-- grant in the privileges section at the top of this file — see the comment
-- there. This preserves the guarantee the Next.js version had by never
-- selecting isCorrect into the client payload.

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------

-- Port of canViewOrder().
create policy orders_select on public.orders
  for select using (
    public.is_wha_admin()
    or user_id = auth.uid()
    or (
      organization_id is not null
      and organization_id = public.my_org()
      and public.my_role() = 'ORG_ADMIN'
    )
  );

-- Orders are created by create_order_with_invoice() and mutated by
-- activate_order() / cancel_order(), all SECURITY DEFINER. No direct
-- INSERT or UPDATE policy exists, so a client cannot mint an invoice number,
-- set its own total, or flip an order to PAID.

create policy payment_proofs_select on public.payment_proofs
  for select using (public.can_view_order(order_id));

-- Port of canUploadProof(): the buyer or an admin of the billed organisation,
-- and never once the order is settled.
create policy payment_proofs_insert on public.payment_proofs
  for insert with check (
    uploaded_by_id = auth.uid()
    and public.can_view_order(order_id)
    and exists (
      select 1 from public.orders o
      where o.id = order_id and o.status in ('PENDING', 'PROOF_SUBMITTED')
    )
  );

-- ---------------------------------------------------------------------------
-- Learning
-- ---------------------------------------------------------------------------

create policy enrollments_select on public.enrollments
  for select using (
    public.is_wha_admin()
    or user_id = auth.uid()
    or exists (
      select 1 from public.orders o
      where o.id = enrollments.order_id
        and o.organization_id is not null
        and o.organization_id = public.my_org()
        and public.my_role() = 'ORG_ADMIN'
    )
  );

-- Seats are created by activate_order() and moved by assign_seat() /
-- revoke_seat() / accept_invite(). The only field the seat holder may touch
-- directly is the "I'm here" timestamp.
create policy enrollments_touch_own on public.enrollments
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.guard_enrollment_columns()
returns trigger
language plpgsql
as $$
begin
  -- As above: SECURITY DEFINER RPCs run as the function owner, and it is those
  -- RPCs (assign_seat, revoke_seat, accept_invite, activate_order) that are
  -- allowed to move a seat between people.
  if current_user not in ('anon', 'authenticated') or public.is_wha_admin() then
    return new;
  end if;
  if new.user_id      is distinct from old.user_id
     or new.status    is distinct from old.status
     or new.order_id  is distinct from old.order_id
     or new.program_id is distinct from old.program_id
     or new.completed_at is distinct from old.completed_at then
    raise exception 'Seats are allocated through the team tools, not directly.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger enrollments_guard_columns
  before update on public.enrollments
  for each row execute function public.guard_enrollment_columns();

-- Ticking a lesson off is the one thing a learner writes directly. Everything
-- derived from it (course %, certificate eligibility) is recomputed, never
-- stored, so this is safe to expose.
create policy lesson_progress_select on public.lesson_progress
  for select using (
    public.owns_enrollment(enrollment_id)
    or public.administers_enrollment(enrollment_id)
    or public.is_wha_admin()
  );

create policy lesson_progress_insert on public.lesson_progress
  for insert with check (public.owns_enrollment(enrollment_id));

create policy lesson_progress_delete on public.lesson_progress
  for delete using (public.owns_enrollment(enrollment_id));

-- Attempts are readable but NOT writable. There is deliberately no INSERT
-- policy: submit_quiz_attempt() is the only way a row appears here, which is
-- what keeps marking on the server.
create policy quiz_attempts_select on public.quiz_attempts
  for select using (
    public.owns_enrollment(enrollment_id)
    or public.administers_enrollment(enrollment_id)
    or public.is_wha_admin()
  );

create policy answer_records_select on public.answer_records
  for select using (
    exists (
      select 1 from public.quiz_attempts a
      where a.id = answer_records.attempt_id
        and (public.owns_enrollment(a.enrollment_id) or public.is_wha_admin())
    )
  );

create policy certificates_select on public.certificates
  for select using (
    public.owns_enrollment(enrollment_id)
    or public.administers_enrollment(enrollment_id)
    or public.is_wha_admin()
  );

-- Public verification does not read this table directly — verify_certificate()
-- returns only the fields an auditor needs, so a valid code cannot be used to
-- enumerate the rest.

-- ---------------------------------------------------------------------------
-- Invites
--
-- No SELECT policy at all. An invite token is a bearer credential; letting
-- anon list the table would hand over every outstanding one. invite_details()
-- looks a single token up, and accept_invite() redeems it.
-- ---------------------------------------------------------------------------

create policy invites_select_org on public.invites
  for select using (
    public.is_wha_admin()
    or (organization_id = public.my_org() and public.my_role() = 'ORG_ADMIN')
  );

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------

create policy audit_log_select_admin on public.audit_log
  for select using (public.is_wha_admin());

-- No INSERT policy: the trail is written by SECURITY DEFINER functions only,
-- so it cannot be forged or padded from a browser.

-- number_counters has RLS on and no policy — it is reachable only from
-- next_number(), which runs inside SECURITY DEFINER callers.
