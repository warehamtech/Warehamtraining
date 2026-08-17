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
