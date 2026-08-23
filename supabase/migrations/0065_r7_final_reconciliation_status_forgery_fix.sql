-- =============================================================================
-- R7-FINAL — live-DEV-certification-discovered fix: close the
-- `reconciliation_status` same-user forgery gap on `fdh_statement_uploads`.
-- =============================================================================
-- DISCOVERED BY: this session's live-DEV security certification (spec §27,
-- "forge reconciliation_status=RECONCILED"), run for real against DEV
-- (vqycarelcoijzwlpkpcz) with two real authenticated users. Reproduction:
--   1. A real document was processed for real, genuinely reconciling to
--      `reconciliation_status = 'not_available'`/'reconciled' per its actual
--      content (a fixture with NO balance column genuinely has nothing to
--      roll forward from -> 'not_available').
--   2. As the OWNING user's own real session token, a direct PostgREST
--      PATCH `fdh_statement_uploads?id=eq.<own doc>` with body
--      `{ "reconciliation_status": "reconciled" }` returned HTTP 200 and
--      the row's `reconciliation_status` was durably forged to 'reconciled'
--      -- a genuinely different value from the true, engine-computed one,
--      not a same-value no-op.
--
-- ROOT CAUSE: migration 0064's `r7_assert_statement_upload_authoritative_
-- fields()` trigger protects `certification_status`, `detection_confidence`,
-- `detection_status`, `detection_evidence`, `declared_row_count`,
-- `parsed_row_count`, `certified_row_count`, `duplicate_row_count`,
-- `adapter_key`, `adapter_version`, `mapping_template_id`,
-- `delimiter_detected`, `encoding_detected`, `header_row_index` -- every
-- column IT introduced. `reconciliation_status` is a PRE-EXISTING FDH-1
-- column (migration 0046) that was never covered, because FDH-1 shipped
-- `fdh_statement_uploads` with no writer at all for this column (broad
-- `for all using (auth.uid() = user_id)` policy, safe at the time because
-- nothing ever gave the column real meaning). R7's reconciliation engine is
-- the FIRST real writer -- and the first thing that makes this specific
-- pre-existing gap actually exploitable, exactly parallel to why migration
-- 0064 had to add its own trigger for the columns it introduced. This
-- migration closes the same class of gap for the one column 0064 missed.
--
-- FIX: widen the EXISTING trigger function (not a new one, not a new
-- trigger -- the trigger `trg_r7_statement_upload_authoritative_fields`
-- already fires on every UPDATE) to also guard `reconciliation_status`.
-- ADDITIVE, IDEMPOTENT (`create or replace function`), no column/table
-- change, no data migration. R7's own service-role processing path
-- (`bankCsvProcessingService.ts`) already writes this column via the
-- admin client, which bypasses RLS/triggers entirely (`auth.role() =
-- 'service_role'`, not `'authenticated'`) -- so legitimate server-side
-- processing is completely unaffected by this widening.
--
-- NOT YET APPLIED. This session has no DDL-execution credential for the
-- live DEV project (service-role REST key only, no DATABASE_URL / linked
-- Supabase CLI / exec_sql RPC -- the exact same constraint documented in
-- the earlier R7_LIVE_DEV_VERIFICATION.md and in FDH-1/FDH-2's own closure
-- notes). Requires the human Product Owner to apply this via the Supabase
-- SQL editor or `supabase db push`, then a follow-up session should
-- re-run the exact SEC-027 "forge reconciliation_status" case in
-- scripts/r7final_live_security.mjs and confirm it is now BLOCKED.
-- =============================================================================

create or replace function r7_assert_statement_upload_authoritative_fields() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    if new.detection_status is distinct from old.detection_status
      or new.detection_confidence is distinct from old.detection_confidence
      or new.detection_evidence is distinct from old.detection_evidence
      or new.certification_status is distinct from old.certification_status
      or new.declared_row_count is distinct from old.declared_row_count
      or new.parsed_row_count is distinct from old.parsed_row_count
      or new.certified_row_count is distinct from old.certified_row_count
      or new.duplicate_row_count is distinct from old.duplicate_row_count
      or new.adapter_key is distinct from old.adapter_key
      or new.adapter_version is distinct from old.adapter_version
      or new.mapping_template_id is distinct from old.mapping_template_id
      or new.delimiter_detected is distinct from old.delimiter_detected
      or new.encoding_detected is distinct from old.encoding_detected
      or new.header_row_index is distinct from old.header_row_index
      -- NEW (R7-FINAL live-cert fix): reconciliation_status is a
      -- pre-existing FDH-1 column (migration 0046) that R7's reconciliation
      -- engine is the first real writer of -- it belongs in this same
      -- authoritative-field guard for exactly the reason every other column
      -- above is here.
      or new.reconciliation_status is distinct from old.reconciliation_status
    then
      raise exception 'fdh_statement_uploads: authoritative R7 detection/certification fields may not be written directly by the authenticated role';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- `trg_r7_statement_upload_authoritative_fields` already exists (migration
-- 0064) and fires `before update ... for each row execute function
-- r7_assert_statement_upload_authoritative_fields()` -- replacing the
-- function body above is sufficient; no `create trigger` needed here.
