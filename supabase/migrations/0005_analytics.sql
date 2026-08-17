-- WHA Learning Portal — page-view analytics
--
-- Deliberately minimal: no IP address, no user agent, no cross-site
-- fingerprinting, no cookie. `session_id` is a random id the browser mints
-- into sessionStorage (site/assets/js/analytics.js) — it identifies a browser
-- tab for as long as that tab stays open and nothing more, which is enough to
-- tell "12 000 page views" apart from "3 400 visits" without tracking anyone.
--
-- Insertable by anyone (including signed-out visitors, which is the whole
-- point), readable only by WHA staff on the statistics page.

create table public.page_views (
  id         uuid primary key default gen_random_uuid(),
  path       text not null check (char_length(path) <= 200),
  -- The ?slug= query param, when the page is a programme detail page — lets
  -- the statistics page rank programmes by views without a lookup on every
  -- single page load. Resolved against programs.slug at query time.
  slug       text check (slug is null or char_length(slug) <= 200),
  session_id text not null check (char_length(session_id) <= 100),
  created_at timestamptz not null default now()
);

create index page_views_created_at_idx on public.page_views (created_at desc);
create index page_views_slug_idx on public.page_views (slug) where slug is not null;

alter table public.page_views enable row level security;

grant insert (path, slug, session_id) on public.page_views to anon, authenticated;
grant select on public.page_views to authenticated;

create policy page_views_insert on public.page_views
  for insert with check (true);

create policy page_views_select_admin on public.page_views
  for select using (public.is_wha_admin());
