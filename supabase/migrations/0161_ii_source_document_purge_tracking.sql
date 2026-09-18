-- Investment Intelligence — source-document raw-file purge tracking
-- (2026-09-19).
--
-- WHY THIS EXISTS. deleteSourceDocumentObject() (lib/services/
-- investment-intelligence/storage.ts) has existed since R1 but was never
-- called anywhere in the application — confirmed by a repo-wide search
-- finding zero callers. Every raw statement PDF ever uploaded through this
-- pipeline has been retained in storage indefinitely, past processing and
-- past the point its data was written to the canonical registers, contrary
-- to the documented design intent (R1_SOURCE_STORAGE_REPORT.md) and to the
-- pattern this same codebase already gets right elsewhere (the AIE
-- pipeline's own purge_status/purged_at columns, migration 0149).
--
-- This migration adds the tracking columns; the actual delete-after-
-- successful-parse call is wired into documentProcessing.ts in the same
-- change. Existing already-uploaded documents are NOT retroactively
-- purged by this migration — that is a separate, deliberate decision
-- (deleting real, already-stored files) left for the operator to trigger
-- explicitly once this is verified live, not something a migration does
-- silently as a side effect.

alter table ii_source_documents
  add column if not exists storage_purged_at timestamptz,
  add column if not exists storage_purge_error text;

comment on column ii_source_documents.storage_purged_at is
  'When the raw file object was confirmed deleted from storage (independently verified absent, not merely "delete call returned no error"). Null means the raw file is still present or purge has not been attempted.';
comment on column ii_source_documents.storage_purge_error is
  'Set when a purge attempt failed (delete error, or delete succeeded but the follow-up existence check still found the object) — retryable, never silently dropped.';
