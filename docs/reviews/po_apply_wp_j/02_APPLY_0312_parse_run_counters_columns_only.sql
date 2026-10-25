-- 0312 -- the three transaction counters on ii_document_parse_runs, columns only (Document2 (4) WP-J, task 2).
--
-- WHY. Migration 0159 added these three counters together with a rewrite of a CHECK constraint on ii_reconciliation_cases. On
-- production the counters never arrived, so every processing run that tried to record them failed at the very last update and stayed
-- running. The Product Owner added the three columns by hand on 22-10-2026 with the columns-only statement kept in
-- docs/reviews/po_apply_parse_run_counters. This migration is that same statement, so the migration ledger and every environment
-- end up the same: it is byte-identical in effect to what was applied by hand.
--
-- WHAT THIS DOES NOT DO. It does not run, repeat or replace 0159. 0159 also drops and recreates the discrepancy type CHECK with an
-- older list of values, which would take away values that later migrations added. This file touches no constraint.
--
-- SAFE ANYWHERE. Additive. If exists means a database where 0159 or the manual statement already ran is left exactly as it is, and
-- running this twice changes nothing. Existing rows read zero for the new columns. No policy, no index, no data changes.

alter table ii_document_parse_runs add column if not exists duplicate_transactions_linked int not null default 0;
alter table ii_document_parse_runs add column if not exists new_transactions_count int not null default 0;
alter table ii_document_parse_runs add column if not exists missing_transactions_count int not null default 0;
