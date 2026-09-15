-- ===========================================================================
-- 0154 — App Review 2026-09-15, item 3
-- "Internal migration text leaking into user-facing Notes field (SMSF)"
--
-- ROOT CAUSE
-- ----------
-- supabase/migrations/0084_geo_jurisdiction_smsf.sql, PART 6 (line 614) wrote
--
--   'Backfilled by migration 0084 from the pre-existing retirement_accounts
--    row (Summary Mode, value unchanged).'
--
-- directly into smsf_funds.notes. That column is the user-editable, user-
-- visible "Notes" field on the SMSF card (Investment & Retirement →
-- Retirement → SMSF → Summary). Developer/migration provenance has no meaning
-- for the end user and should never have been stored in a user-facing field.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Adds smsf_funds.backfill_source — an INTERNAL provenance column, the
--    correct home for this kind of audit trail (item 3 requirement 2: "if
--    provenance must be tracked, store it in an internal audit/metadata
--    column, not `notes`"). It is not selected by any user-facing query.
-- 2. Moves the provenance from notes into backfill_source and clears notes,
--    matching ONLY rows whose notes is byte-for-byte the 0084 literal. A row
--    whose notes the user has since edited — even by appending to it — is
--    left completely untouched. Nothing this migration does can destroy a
--    user's own words.
-- 3. Leaves smsf_funds.notes NULL for those rows, which is what the SMSF card
--    renders as an empty Notes field.
--
-- Forward-only and idempotent: re-running it matches zero rows the second
-- time (the literal is gone) and the ALTER is `if not exists`.
--
-- MIGRATION NUMBERING (verified 2026-09-15, not assumed)
-- ------------------------------------------------------
-- `main`'s supabase/migrations folder ends at 0148, so its own
-- scripts/check-migration-versions.mjs reports 0149 as next-free — that is
-- WRONG here. 0149/0150/0151/0152 are claimed by the unmerged AIE-1 closure
-- work (commit 121cfd4 renumbered its 0147/0148 to 0149/0150) and 0153 by the
-- unmerged PC5 branch. A live read-only probe of DEV confirmed 0150's
-- aie_ai_cost_ledger and 0152's aie_ai_cost_attempt are both already applied
-- there. 0154 is therefore the true next-free version.
--
-- APPLICATION: this file must be applied by hand via the Supabase SQL Editor
-- (DEV first, then production). This environment cannot execute DDL.
-- ===========================================================================

begin;

alter table smsf_funds
  add column if not exists backfill_source text;

comment on column smsf_funds.backfill_source is
  'INTERNAL provenance only -- never rendered to the user. Records which migration created or altered this row. Introduced by migration 0154 after App Review 2026-09-15 item 3 found migration 0084 writing this same provenance text into the user-facing notes column. Any future backfill that needs an audit trail writes it HERE, never into notes.';

update smsf_funds
set
  backfill_source = coalesce(
    backfill_source,
    'migration_0084_summary_mode_backfill'
  ),
  notes = null,
  updated_at = now()
where notes = 'Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).';

commit;

-- ---------------------------------------------------------------------------
-- Verification (run after applying; both must return 0):
--
--   select count(*) from smsf_funds
--   where notes ilike '%migration%' or notes ilike '%backfilled%'
--      or notes ilike '%pre-existing%';
--
--   select count(*) from smsf_funds
--   where notes = 'Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).';
--
-- And this should return the rows just cleaned:
--
--   select count(*) from smsf_funds where backfill_source is not null;
-- ---------------------------------------------------------------------------
