-- Phase 0C.1: widen user_financial_section_status.status to also accept
-- 'reviewed_with_data'.
--
-- Phase 0C's completion report surfaced a semantic gap: effectiveSectionStatus()
-- was treating "at least one row exists" as equivalent to "the user has
-- finished reviewing this section" for positive-data sections (Income,
-- Expenses, Assets, Investments, Retirement, and Liabilities/Insurance once
-- rows exist). One salary row doesn't prove Income is fully reviewed any
-- more than one rent row proves Expenses is. Positive-data sections now
-- need their own explicit "I've added everything relevant to me"
-- confirmation, persisted the same way 'reviewed_zero'/'not_applicable'
-- already are.
--
-- Additive-only: widens an existing CHECK constraint, does not touch any
-- other column, table, row, or the RLS policy from migration 0031. No
-- backfill is performed here — see the Phase 0C.1 completion report for why
-- existing users with unconfirmed rows are deliberately left at
-- 'in_progress' (derived, not persisted) rather than being auto-marked
-- 'reviewed_with_data'.
alter table user_financial_section_status
  drop constraint if exists user_financial_section_status_status_check;

alter table user_financial_section_status
  add constraint user_financial_section_status_status_check
  check (status in ('reviewed_zero', 'not_applicable', 'reviewed_with_data'));

-- Rollback notes (manual — this repo has no down-migration runner):
--   alter table user_financial_section_status drop constraint user_financial_section_status_status_check;
--   alter table user_financial_section_status add constraint user_financial_section_status_status_check
--     check (status in ('reviewed_zero', 'not_applicable'));
-- Only safe to roll back if no row has status = 'reviewed_with_data' yet —
-- otherwise the old, narrower constraint would reject those existing rows.
-- Check first: select count(*) from user_financial_section_status where status = 'reviewed_with_data';
