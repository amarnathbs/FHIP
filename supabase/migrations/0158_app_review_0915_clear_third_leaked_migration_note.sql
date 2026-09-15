-- ===========================================================================
-- 0158 — App Review 2026-09-15, item 3, FOLLOW-UP
-- A third leaked migration-0077 literal, missed by 0156's own audit.
--
-- 0156 was applied to DEV and cleaned two of migration 0077's three
-- literals (182 "consistent legacy age" rows; 0 "conflicting ages" rows
-- existed after all -- that pattern never actually occurred in this data).
-- Live re-verification after applying 0156 found retirement_members'
-- leaked-notes count was NOT zero as expected: 103 rows, all one single
-- distinct pattern 0156's own audit sweep did not catch:
--
--   'Migration 0077: this member has retirement account(s) but no legacy
--    target retirement age was ever recorded. Age left unconfirmed.'
--
-- This is pure developer/migration provenance exactly like 0156's Case C:
-- it carries no information a household needs that isn't already visible
-- as the member's own (blank) target retirement age in the app itself. It
-- is cleared, not rewritten -- there is nothing here to preserve, unlike
-- 0156's Case D (which, as it turned out, matched zero real rows anyway).
--
-- Reuses smsf_funds/retirement_members.backfill_source? No -- only
-- retirement_members.backfill_source, added by 0156, already exists and
-- already has the correct shape for this. Reused, not re-created.
--
-- Same enforce_country_confirmed() trigger, same fix: DISABLE/ENABLE
-- TRIGGER USER around the UPDATE, for the same reason 0156 needed it (one
-- of these 103 rows belongs to a household that has real data but has
-- never completed country confirmation -- unrelated to this cleanup).
--
-- MIGRATION NUMBERING (verified 2026-09-15, not assumed): 0156 and 0157
-- are now BOTH genuinely applied to DEV (0156 today; 0157 -- PC7's
-- look-through foundation, from the unrelated 11-phase AIE/PC4 mission --
-- also applied to DEV today, per the operator). 0158 is therefore the true
-- next-free version for DEV. Not yet checked against production, which
-- has neither 0156 nor 0157 applied yet -- apply 0153 through 0158 in
-- strict numeric order in production, and re-run 0156's own verification
-- queries (plus this file's own, below) before considering this item
-- closed there.
--
-- APPLICATION: this file must be applied by hand via the Supabase SQL
-- Editor (DEV first, then production, after 0156 and 0157 in both places).
-- This environment cannot execute DDL.
-- ===========================================================================

begin;

alter table retirement_members disable trigger user;

update retirement_members
set
  backfill_source = coalesce(backfill_source, 'migration_0077_no_legacy_age_recorded'),
  notes = null,
  updated_at = now()
where notes = 'Migration 0077: this member has retirement account(s) but no legacy target retirement age was ever recorded. Age left unconfirmed.';

alter table retirement_members enable trigger user;

commit;

-- ---------------------------------------------------------------------------
-- Verification (run after applying). Must return 0:
--
--   select count(*) from retirement_members
--    where notes ilike '%migration%' or notes ilike '%backfilled%'
--       or notes ilike '%retirement_accounts.target_retirement_age%';
--
-- This should now read 285 (182 from 0156 + 103 from this file), matching
-- the original total leaked-row count 0156's own audit found:
--
--   select count(*) from retirement_members where backfill_source is not null;
-- ---------------------------------------------------------------------------
