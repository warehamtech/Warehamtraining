-- WHA Learning Portal — full schema, in one paste
-- Generated from supabase/migrations/000{1,2,3,4}_*.sql — run once in the Supabase SQL Editor.
-- Safe to re-run only after a full 'drop schema public cascade' reset; these are not idempotent.

-- ============================================================
-- 0001_schema.sql — tables, enums, triggers
-- ============================================================
-- WHA Learning Portal — data model
--
-- Port of the Prisma schema to native Postgres for Supabase.
--
-- Conventions that differ from the Prisma original, and why:
--   * snake_case tables and columns — PostgREST derives its JSON keys from
--     these, and camelCase identifiers would need quoting everywhere.
--   * uuid primary keys instead of cuid() — generated in the database, so the
--     browser never has to mint an id.
--   * the Prisma `User` model is now `profiles`, keyed to `auth.users`.
--     Supabase Auth owns credentials, so `password_hash` is gone.
--
-- Unchanged from the original, deliberately:
--   Money is stored as integer cents (ZAR) throughout; never floats.
--   A seat is an `enrollments` row: an order for 5 seats creates 5 enrollments,
--   each of which may be unassigned (user_id = null) until an org admin
--   allocates it.

-- pgcrypto supplies gen_random_bytes(), used to mint invite tokens. Supabase
-- ships it in the `extensions` schema; this is a no-op if it is already there.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.role as enum ('LEARNER', 'ORG_ADMIN', 'WHA_ADMIN');

create type public.buyer_type as enum ('INDIVIDUAL', 'COMPANY');

create type public.order_status as enum (
  'PENDING',          -- invoice issued, awaiting payment
  'PROOF_SUBMITTED',  -- buyer uploaded proof of payment, awaiting WHA review
  'PAID',             -- activated by a WHA admin; seats exist
  'CANCELLED'
);

create type public.enrollment_status as enum ('ACTIVE', 'COMPLETED', 'REVOKED');

create type public.lesson_type as enum ('VIDEO', 'TEXT', 'PDF');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- People & organisations
-- ---------------------------------------------------------------------------

create table public.organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  vat_number     text,
  billing_email  text not null,
  phone          text,
  address_line1  text,
  address_line2  text,
  city           text,
  postal_code    text,
  country        text not null default 'South Africa',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger organizations_touch
  before update on public.organizations
  for each row execute function public.touch_updated_at();

-- One row per auth.users row. `email` is mirrored here because PostgREST
-- cannot join across to the auth schema, and the team and admin tables need
-- to list people by email.
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null unique,
  name            text not null default '',
  role            public.role not null default 'LEARNER',
  job_title       text,
  organization_id uuid references public.organizations (id) on delete set null,
  last_active_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index profiles_organization_id_idx on public.profiles (organization_id);
create index profiles_role_idx on public.profiles (role);

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Create the profile as soon as Supabase Auth creates the account. `name` and
-- `job_title` come from the sign-up metadata the register form sends.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, job_title)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)),
    nullif(trim(new.raw_user_meta_data ->> 'job_title'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

create table public.programs (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  title          text not null,
  -- Short line used on catalogue cards.
  summary        text not null,
  -- Longer marketing copy for the detail page.
  description    text not null,
  -- e.g. "ISO 9001" — shown as an eyebrow label on cards.
  standard       text,
  hero_image_url text,
  -- Price per seat, in cents, VAT exclusive.
  price_cents    integer not null,
  -- Indicative total study time, shown on the detail page.
  duration_hours integer,
  published      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index programs_published_idx on public.programs (published);

create trigger programs_touch
  before update on public.programs
  for each row execute function public.touch_updated_at();

create table public.courses (
  id         uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id) on delete cascade,
  title      text not null,
  summary    text,
  position   integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index courses_program_id_idx on public.courses (program_id, position);

create trigger courses_touch
  before update on public.courses
  for each row execute function public.touch_updated_at();

create table public.lessons (
  id        uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  title     text not null,
  position  integer not null,
  type      public.lesson_type not null default 'TEXT',
  -- VIDEO lessons carry either an embed URL or an uploaded file key, not both.
  video_embed_url text,
  video_file_key  text,
  -- TEXT lessons: sanitised HTML authored in the admin panel.
  body_html       text,
  -- PDF lessons: the primary document shown inline.
  pdf_file_key    text,
  duration_minutes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lessons_course_id_idx on public.lessons (course_id, position);

create trigger lessons_touch
  before update on public.lessons
  for each row execute function public.touch_updated_at();

create table public.resources (
  id            uuid primary key default gen_random_uuid(),
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  title         text not null,
  file_key      text not null,
  original_name text not null,
  content_type  text not null,
  size_bytes    integer not null,
  created_at    timestamptz not null default now()
);

create index resources_lesson_id_idx on public.resources (lesson_id);

-- ---------------------------------------------------------------------------
-- Invitations
--
-- Defined after the catalogue rather than beside `profiles`, because an invite
-- may carry a seat allocation and so references `programs`.
-- ---------------------------------------------------------------------------

create table public.invites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           text not null,
  token           text not null unique,
  role            public.role not null default 'LEARNER',
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  -- Optional: claim a free seat on this programme when the invite is accepted,
  -- so an admin can invite and allocate in one step.
  program_id      uuid references public.programs (id) on delete set null,
  invited_by_id   uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index invites_organization_id_idx on public.invites (organization_id);
create index invites_email_idx on public.invites (email);

-- ---------------------------------------------------------------------------
-- Assessment
-- ---------------------------------------------------------------------------

create table public.quizzes (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null unique references public.courses (id) on delete cascade,
  title             text not null default 'Final assessment',
  pass_mark_percent integer not null default 70,
  max_attempts      integer not null default 3,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger quizzes_touch
  before update on public.quizzes
  for each row execute function public.touch_updated_at();

create table public.questions (
  id       uuid primary key default gen_random_uuid(),
  quiz_id  uuid not null references public.quizzes (id) on delete cascade,
  prompt   text not null,
  position integer not null,
  -- Shown on the results screen after submission.
  explanation text
);

create index questions_quiz_id_idx on public.questions (quiz_id, position);

create table public.choices (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  text        text not null,
  -- Never readable by a client. See 0002_rls.sql — this column is REVOKEd from
  -- anon and authenticated, so marking can only happen inside the RPC.
  is_correct  boolean not null default false,
  position    integer not null
);

create index choices_question_id_idx on public.choices (question_id, position);

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null unique,
  buyer_type      public.buyer_type not null,
  -- Set for INDIVIDUAL orders and for the person who placed a COMPANY order.
  user_id         uuid references public.profiles (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  program_id      uuid not null references public.programs (id),

  seats            integer not null default 1,
  unit_price_cents integer not null,
  subtotal_cents   integer not null,
  vat_cents        integer not null,
  total_cents      integer not null,
  -- Stored as a fraction (0.15) so historical invoices survive a rate change.
  vat_rate         double precision not null default 0.15,
  currency         text not null default 'ZAR',

  status public.order_status not null default 'PENDING',

  -- Billing details are snapshotted at issue time so renaming an organisation
  -- later never rewrites an already-issued invoice.
  billing_name       text not null,
  billing_email      text not null,
  billing_vat_number text,
  billing_address    text,

  issued_at timestamptz not null default now(),
  due_at    timestamptz not null,
  paid_at   timestamptz,

  -- WHA admin who activated the order.
  activated_by_id uuid references public.profiles (id) on delete set null,
  admin_note      text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_status_idx on public.orders (status);
create index orders_organization_id_idx on public.orders (organization_id);
create index orders_user_id_idx on public.orders (user_id);

create trigger orders_touch
  before update on public.orders
  for each row execute function public.touch_updated_at();

create table public.payment_proofs (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete cascade,
  file_key       text not null,
  original_name  text not null,
  content_type   text not null,
  size_bytes     integer not null,
  note           text,
  uploaded_by_id uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index payment_proofs_order_id_idx on public.payment_proofs (order_id);

-- Sequence allocation for invoice numbers and certificate serials.
--
-- The Prisma original read the highest existing number and let a unique
-- constraint arbitrate collisions, retrying up to six times. A counter row
-- locked by ON CONFLICT DO UPDATE is atomic instead of usually-atomic, and
-- costs one statement.
create table public.number_counters (
  prefix     text primary key,
  -- The most recently issued number for this prefix.
  last_value integer not null
);

-- Issue the next number for a prefix such as 'WHA-INV-2026-'.
--
-- The upsert takes a row lock on conflict, so two concurrent checkouts
-- serialise here and cannot be handed the same invoice number. On the insert
-- path RETURNING yields 1; on the update path it yields the incremented value.
create or replace function public.next_number(p_prefix text)
returns integer
language plpgsql
as $$
declare
  v_value integer;
begin
  insert into public.number_counters as c (prefix, last_value)
  values (p_prefix, 1)
  on conflict (prefix)
    do update set last_value = c.last_value + 1
  returning c.last_value into v_value;

  return v_value;
end;
$$;

-- ---------------------------------------------------------------------------
-- Learning
-- ---------------------------------------------------------------------------

-- One row = one purchased seat.
create table public.enrollments (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  program_id uuid not null references public.programs (id) on delete cascade,
  -- Null while the seat is unassigned in an organisation's pool.
  user_id    uuid references public.profiles (id) on delete set null,
  status     public.enrollment_status not null default 'ACTIVE',

  activated_at timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  last_seen_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index enrollments_user_id_idx on public.enrollments (user_id);
create index enrollments_order_id_idx on public.enrollments (order_id);
create index enrollments_program_id_idx on public.enrollments (program_id);
-- Supports the "oldest free seat on this programme" lookup used when a team
-- admin allocates a seat or an invite is accepted.
create index enrollments_free_seat_idx
  on public.enrollments (program_id, created_at)
  where user_id is null;

create trigger enrollments_touch
  before update on public.enrollments
  for each row execute function public.touch_updated_at();

create table public.quiz_attempts (
  id            uuid primary key default gen_random_uuid(),
  quiz_id       uuid not null references public.quizzes (id) on delete cascade,
  -- Attempts belong to a seat, so a re-purchased enrollment starts clean.
  enrollment_id uuid not null references public.enrollments (id) on delete cascade,
  score_percent integer not null,
  passed        boolean not null,
  submitted_at  timestamptz not null default now()
);

create index quiz_attempts_quiz_enrollment_idx
  on public.quiz_attempts (quiz_id, enrollment_id);
create index quiz_attempts_enrollment_idx on public.quiz_attempts (enrollment_id);

create table public.answer_records (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.quiz_attempts (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  choice_id   uuid not null references public.choices (id) on delete cascade,
  correct     boolean not null,
  unique (attempt_id, question_id)
);

create index answer_records_attempt_id_idx on public.answer_records (attempt_id);

create table public.lesson_progress (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id) on delete cascade,
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  completed_at  timestamptz not null default now(),
  unique (enrollment_id, lesson_id)
);

create index lesson_progress_enrollment_id_idx on public.lesson_progress (enrollment_id);

create table public.certificates (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null unique references public.enrollments (id) on delete cascade,
  -- Human-readable, printed on the certificate: WHA-CERT-2026-000123
  serial        text not null unique,
  -- Opaque code embedded in the QR link at /verify/certificate.html?code=
  verify_code   text not null unique,
  -- Name and programme title snapshotted at issue time.
  learner_name  text not null,
  program_title text not null,
  issued_at     timestamptz not null default now(),
  pdf_key       text,
  revoked_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------

-- Trail of consequential admin actions — this is an ISO-certified business, so
-- "who activated this order and when" needs to be answerable.
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid not null,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_created_at_idx on public.audit_log (created_at desc);

-- ============================================================
-- 0002_rls.sql — row level security (the authorisation boundary)
-- ============================================================
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

-- ============================================================
-- 0003_functions.sql — marking, activation, certificates
-- ============================================================
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

-- ============================================================
-- 0004_storage.sql — private file buckets
-- ============================================================
-- WHA Learning Portal — file storage
--
-- Replaces src/lib/storage.ts (local disk) and the authorised delivery route
-- at /api/files/[...key].
--
-- All three buckets are PRIVATE. The original was emphatic that `.uploads/`
-- sat outside `public/` so that proof-of-payment documents and course media
-- were never reachable by guessing a URL; `public = false` here is the same
-- decision. The browser asks for a short-lived signed URL, and the policies
-- below decide whether it gets one.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Proof of payment. 10 MB cap and the same four types the upload action
  -- accepted.
  ('proofs', 'proofs', false, 10485760,
   array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),

  -- Self-hosted lesson video, lesson PDFs and downloadable attachments.
  ('lesson-media', 'lesson-media', false, 524288000, null),

  -- Rendered certificate PDFs, cached by the edge function.
  ('certificates', 'certificates', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- proofs/<order_id>/<uuid>-<name>
--
-- The first path segment is the order id, so the order's own visibility rule
-- (can_view_order, the port of canViewOrder) decides the file's.
-- ---------------------------------------------------------------------------

create policy "proofs are readable by anyone who can see the order"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'proofs'
    and public.can_view_order(((storage.foldername(name))[1])::uuid)
  );

create policy "proofs are uploadable by the buyer while the order is open"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'proofs'
    and public.can_view_order(((storage.foldername(name))[1])::uuid)
    and exists (
      select 1 from public.orders o
      where o.id = ((storage.foldername(name))[1])::uuid
        and o.status in ('PENDING', 'PROOF_SUBMITTED')
    )
  );

-- ---------------------------------------------------------------------------
-- lesson-media/<program_id>/...
--
-- Course material is for people holding a seat. WHA staff manage it.
-- ---------------------------------------------------------------------------

create policy "lesson media is readable by enrolled learners"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'lesson-media'
    and (
      public.is_wha_admin()
      or public.is_enrolled_on(((storage.foldername(name))[1])::uuid)
    )
  );

create policy "lesson media is managed by WHA staff"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'lesson-media' and public.is_wha_admin());

create policy "lesson media is replaceable by WHA staff"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'lesson-media' and public.is_wha_admin())
  with check (bucket_id = 'lesson-media' and public.is_wha_admin());

create policy "lesson media is removable by WHA staff"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'lesson-media' and public.is_wha_admin());

-- ---------------------------------------------------------------------------
-- certificates/<enrollment_id>.pdf
--
-- Written by the certificate-pdf edge function using the service role, which
-- bypasses these policies. Learners and their team admin may read.
-- ---------------------------------------------------------------------------

create policy "certificates are readable by their holder"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'certificates'
    and (
      public.is_wha_admin()
      or public.owns_enrollment(
           replace((storage.filename(name)), '.pdf', '')::uuid)
      or public.administers_enrollment(
           replace((storage.filename(name)), '.pdf', '')::uuid)
    )
  );
