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
