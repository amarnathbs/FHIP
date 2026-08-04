-- Real PDF export pipeline for the Free Report v2 redesign. The private
-- "report-exports" Storage bucket was already created via the Storage Admin
-- API (supabase.storage.createBucket), not here — bucket creation isn't a
-- SQL-editor operation. render_token/render_token_expires_at on
-- report_exports let the headless-Chromium renderer open the report's print
-- view (app/(app)/reports/[id]/print) without impersonating a full user
-- session — the token is minted server-side per export request and expires
-- within minutes (see lib/services/reportPdfRenderer.ts).

-- Object path convention: "{user_id}/{report_id}/{export_id}.pdf" — owner-only
-- read. Uploads happen via the service-role client (bypasses RLS), the same
-- pattern already used by the cron report-generation job, so no insert
-- policy is needed for authenticated users.
create policy "own report export objects" on storage.objects
  for select using (bucket_id = 'report-exports' and (storage.foldername(name))[1] = auth.uid()::text);

alter table report_exports
  add column if not exists render_token text,
  add column if not exists render_token_expires_at timestamptz;
