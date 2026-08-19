-- WHA Learning Portal — lesson content blocks
--
-- A lesson's narrative content (previously exactly one of TEXT/VIDEO/PDF,
-- fixed to columns on `lessons`) becomes an ordered sequence of blocks, so a
-- lesson can mix slides of text, images, video and third-party interactive
-- embeds — the shape a course built mostly from "slides" actually needs.
--
-- This is additive only. `lessons.type` / `body_html` / `video_embed_url` /
-- `video_file_key` / `pdf_file_key` are untouched: PDF stays a lesson-level
-- "primary document" (it already works and isn't slide content), and the
-- other legacy columns are kept as a rollback safety net plus the source for
-- the one-time backfill below. Learner rendering falls back to them only for
-- a lesson that somehow has zero blocks.

create type public.block_type as enum ('TEXT', 'IMAGE', 'VIDEO', 'EMBED');

-- `content` shapes, by block_type (documented here rather than as a check
-- constraint, matching how this schema already leaves jsonb envelope shapes
-- to the application — e.g. audit_log.meta, the RPC ok/error envelopes):
--   TEXT  → { "html": "…" }                                  (rawHtml(), same
--                                                               trust boundary
--                                                               as body_html)
--   IMAGE → { "file_key": "…", "alt": "…", "caption": "…" }  (lesson-media)
--   VIDEO → { "embed_url": "…" } | { "file_key": "…" }        (mutually
--                                                               exclusive,
--                                                               same rule as
--                                                               today's video
--                                                               lesson)
--   EMBED → { "embed_html": "…", "provider": "…" }            (admin-pasted
--                                                               third-party
--                                                               iframe/embed;
--                                                               rawHtml(),
--                                                               same trust
--                                                               boundary as
--                                                               TEXT)
create table public.lesson_blocks (
  id         uuid primary key default gen_random_uuid(),
  lesson_id  uuid not null references public.lessons (id) on delete cascade,
  block_type public.block_type not null,
  position   integer not null,
  content    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lesson_blocks_lesson_id_idx on public.lesson_blocks (lesson_id, position);

create trigger lesson_blocks_touch
  before update on public.lesson_blocks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Every lesson that exists before this migration gets one equivalent block,
-- so nothing is left blank the moment this ships. PDF lessons get no block —
-- there is no PDF block type; the document stays on lessons.pdf_file_key.
-- ---------------------------------------------------------------------------

insert into public.lesson_blocks (lesson_id, block_type, position, content)
select id, 'TEXT', 1, jsonb_build_object('html', body_html)
from public.lessons
where type = 'TEXT' and body_html is not null and trim(body_html) <> '';

insert into public.lesson_blocks (lesson_id, block_type, position, content)
select id, 'VIDEO', 1,
  case
    when video_file_key is not null then jsonb_build_object('file_key', video_file_key)
    else jsonb_build_object('embed_url', video_embed_url)
  end
from public.lessons
where type = 'VIDEO' and (video_file_key is not null or video_embed_url is not null);

-- ---------------------------------------------------------------------------
-- Privileges & RLS — mirrors lessons_select / lessons_write_admin exactly,
-- joined one level further through lessons → courses → programs.
-- ---------------------------------------------------------------------------

grant select on public.lesson_blocks to anon, authenticated;
grant insert, update, delete on public.lesson_blocks to authenticated;

alter table public.lesson_blocks enable row level security;

create policy lesson_blocks_select on public.lesson_blocks
  for select using (
    public.is_wha_admin()
    or exists (
      select 1
      from public.lessons l
      join public.courses c on c.id = l.course_id
      join public.programs p on p.id = c.program_id
      where l.id = lesson_blocks.lesson_id
        and (p.published or public.is_enrolled_on(p.id))
    )
  );

create policy lesson_blocks_write_admin on public.lesson_blocks
  for all using (public.is_wha_admin()) with check (public.is_wha_admin());
