-- Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
--
-- Two additive, backward-compatible changes, both required by the new
-- Holdings table + transaction-detail modal on the Performance tab:
--
-- 1. Two new closed-enum `ii_reconciliation_cases.discrepancy_type` values:
--      - 'transaction_missing_from_restatement' — a previously-recorded
--        transaction for an (account, instrument) position was not found in
--        a newer statement's coverage window. ii_transactions is append-only
--        (see 0033's header comment) — a "missing" transaction is NEVER
--        deleted or silently dropped; it is surfaced as a review item for a
--        human to look at, exactly like every other unresolved discrepancy
--        in this table.
--      - 'ai_fallback_reconciliation_attempted' — records that the AI
--        fallback reconciliation path (documentProcessing's existing
--        reconciliation gate; see aiFallbackReconciliation.ts) was invoked
--        for a scheme that failed the deterministic unit-reconciliation
--        check. A 'resolved' row of this type, with the corrected ledger in
--        `evidence`, doubles as the persisted cache so the same scheme is
--        never re-sent to an AI provider on every page view.
--
-- 2. Three new counters on `ii_document_parse_runs`, so a reprocess run's
--    duplicate/new/missing transaction counts are queryable after the fact
--    (surfaced as the "N new, M duplicates skipped, K not found — reviewed
--    separately" summary on the Holdings table), not just returned once in
--    the synchronous API response and then lost.
--
-- Not applied to DEV or production by this task — this sandbox has no
-- DDL-execution mechanism (same standing wall as every other migration file
-- in this repo's history since R1; see e.g. 0086's header). Application is
-- a Product Owner / operator action.

alter table ii_reconciliation_cases drop constraint if exists ii_reconciliation_cases_discrepancy_type_check;
alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in (
  'owner_unmatched', 'account_unmatched', 'instrument_unmatched', 'ambiguous_instrument',
  'transaction_unclassified', 'unit_mismatch', 'value_mismatch', 'duplicate_suspected',
  'missing_opening_history', 'unsupported_document', 'document_corrupt',
  'document_password_required', 'parse_incomplete', 'statement_period_gap', 'other',
  'cross_source_exact_duplicate', 'cross_source_high_confidence_duplicate',
  'cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict',
  'transaction_missing_from_restatement', 'ai_fallback_reconciliation_attempted'
));

alter table ii_document_parse_runs add column if not exists duplicate_transactions_linked int not null default 0;
alter table ii_document_parse_runs add column if not exists new_transactions_count int not null default 0;
alter table ii_document_parse_runs add column if not exists missing_transactions_count int not null default 0;
