-- Investment Intelligence R1 — Migration G: storage.objects RLS policy for
-- the private "investment-source-documents" bucket. The bucket ITSELF was
-- created via the Storage Admin API (supabase.storage.createBucket), not
-- here — bucket creation isn't a SQL-editor operation, identical precedent
-- to migration 0022's comment for "report-exports". As of this migration
-- being written, the investment-source-documents bucket has genuinely
-- already been created on the DEV project (private, file_size_limit=20MB,
-- allowed_mime_types=[application/pdf, text/csv]) — see
-- docs/investment-intelligence/R1_SOURCE_STORAGE_REPORT.md for the exact
-- verified configuration and live test evidence.
--
-- Object path convention: "{user_id}/{source_document_id}.{ext}" — a
-- server-generated canonical key (lib/services/investment-intelligence/storage.ts),
-- never a user-provided filename. Uploads happen via the service-role
-- client only (bypasses RLS after an explicit authenticated + ownership
-- check in the API route) — no insert policy is defined for the
-- authenticated role, matching report-exports' identical pattern
-- (R0_SOURCE_PROVENANCE_CONTRACT.md section 4).
--
-- Governing docs: R1_IMPLEMENTATION_SPEC.md section 4, R0_SECURITY_RLS_ARCHITECTURE.md.

create policy "own investment source document objects" on storage.objects
  for select using (
    bucket_id = 'investment-source-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
