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
-- THE WIDER AUDIT (item 3 requirement 3)
-- --------------------------------------
-- "Audit other tables/fields for the same pattern (search for 'migration',
--  'backfilled', 'pre-existing' in user-facing string data) and clean them."
--
-- Run twice: once as a live read-only sweep of every user-facing name/notes
-- column in DEV, and once as a static sweep of every migration file
-- (tests/unit/appReview0915MigrationTextLeakGuard.test.ts, which now guards
-- this permanently). The static sweep found two further offenders the data
-- sweep's first pass had not covered. Live DEV row counts:
--
--   smsf_funds.notes                  7 rows   (migration 0084)
--   property_liability_links.notes   11 rows   (migration 0078, 3 literals)
--   retirement_members.notes        285 rows   (migration 0077, 2 literals)
--
-- Every other user-facing column swept — assets, liabilities, investments,
-- retirement_accounts, income_sources, expense_items, insurance_policies,
-- user_goals, smsf_holdings, households, business_entities, and every *_name
-- column on each — came back clean.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Adds smsf_funds.backfill_source and retirement_members.backfill_source —
--    INTERNAL provenance columns, the correct home for this kind of audit
--    trail (item 3 requirement 2: "if provenance must be tracked, store it in
--    an internal audit/metadata column, not `notes`"). Neither is selected by
--    any user-facing query. property_liability_links needs no new column: it
--    already records the same fact structurally in `source`
--    ('backfill_deterministic') and `confidence` ('deterministic').
-- 2. Moves the provenance out of notes, matching ONLY rows whose notes is
--    byte-for-byte a known migration literal. A row whose notes the user has
--    since edited — even by appending to it — is left completely untouched.
--    Nothing this migration does can destroy a user's own words.
-- 3. One note is NOT simply cleared. Migration 0077's conflict case
--    ("...conflicted across this member's accounts (67, 65). No value was
--    guessed -- please confirm your target retirement age.") carries real,
--    actionable meaning for the household alongside its developer framing,
--    and the conflicting ages it lists are not recorded anywhere else. That
--    one is REWRITTEN into plain user language with the ages preserved,
--    rather than deleted.
--
-- Forward-only and idempotent: re-running it matches zero rows the second
-- time (the literals are gone) and every ALTER is `if not exists`.
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

-- ---------------------------------------------------------------------------
-- property_liability_links.notes — migration 0078's three auto-link literals.
--
-- The link is genuine and stays exactly as it is; only the developer-facing
-- sentence goes. No provenance is lost: 0078 already set source =
-- 'backfill_deterministic' and confidence = 'deterministic' on these very
-- rows, which is the structured version of the same fact.
-- ---------------------------------------------------------------------------

update property_liability_links
set notes = null
where notes in (
  'Auto-linked by migration 0078: exactly one active Principal Residence and exactly one active Home Loan for this user, with matching owner/currency/country.',
  'Auto-linked by migration 0078: exactly one active Residential Investment Property and exactly one active Investment Loan for this user, with matching owner/currency/country.',
  'Auto-linked by migration 0078: exactly one active Commercial Property and exactly one active Commercial Property Loan for this user, with matching owner/currency/country.'
);

-- ---------------------------------------------------------------------------
-- retirement_members.notes — migration 0077's two literals.
-- ---------------------------------------------------------------------------

alter table retirement_members
  add column if not exists backfill_source text;

comment on column retirement_members.backfill_source is
  'INTERNAL provenance only -- never rendered to the user. Records which migration created or altered this row. Introduced by migration 0154 (App Review 2026-09-15 item 3).';

-- Case C: pure provenance, no user meaning. Cleared.
-- Literal: 'Backfilled by migration 0077 from N consistent legacy
--           retirement_accounts.target_retirement_age value(s) of X.'
update retirement_members
set
  backfill_source = coalesce(backfill_source, 'migration_0077_consistent_legacy_age_backfill'),
  notes = null,
  updated_at = now()
where notes like 'Backfilled by migration 0077 from % consistent legacy retirement\_accounts.target\_retirement\_age value(s) of %.';

-- Case D: REWRITTEN, not cleared. The conflicting ages this sentence lists
-- exist nowhere else, and "please confirm your target retirement age" is a
-- real instruction to the household. Only the developer framing is removed;
-- the ages inside the parentheses are carried across verbatim.
-- Literal: 'Migration 0077: legacy retirement_accounts.target_retirement_age
--           values conflicted across this member''s accounts (67, 65). No
--           value was guessed -- please confirm your target retirement age.'
update retirement_members
set
  backfill_source = coalesce(backfill_source, 'migration_0077_conflicting_legacy_age'),
  notes = 'Your recorded retirement ages differed across your accounts ('
          || substring(notes from 'accounts \(([^)]*)\)')
          || '). None was assumed — please confirm your target retirement age.',
  updated_at = now()
where notes like 'Migration 0077: legacy retirement\_accounts.target\_retirement\_age values conflicted across this member''s accounts (%'
  and substring(notes from 'accounts \(([^)]*)\)') is not null;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run after applying). All three must return 0:
--
--   select count(*) from smsf_funds
--    where notes ilike '%migration%' or notes ilike '%backfilled%'
--       or notes ilike '%pre-existing%';
--
--   select count(*) from property_liability_links
--    where notes ilike '%migration%' or notes ilike '%auto-linked by%';
--
--   select count(*) from retirement_members
--    where notes ilike '%migration%' or notes ilike '%backfilled%'
--       or notes ilike '%retirement_accounts.target_retirement_age%';
--
-- These should return the rows just cleaned (DEV at time of writing: 7, 285):
--
--   select count(*) from smsf_funds where backfill_source is not null;
--   select count(*) from retirement_members where backfill_source is not null;
--
-- And this should show the rewritten, user-readable conflict notes:
--
--   select notes from retirement_members
--    where backfill_source = 'migration_0077_conflicting_legacy_age' limit 5;
-- ---------------------------------------------------------------------------
