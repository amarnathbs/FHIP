-- =============================================================================
-- PRODUCTION PREFLIGHT -- READ ONLY. Approved Upload -> Canonical programme.
-- Run in the PRODUCTION Supabase SQL editor BEFORE the release sitting (a day
-- ahead is fine) and AGAIN at the start of the sitting. Nothing here writes.
-- Send Claude every result that is not the "expected" one before going on.
-- Plan: docs/financial-data-hub/PRODUCTION_IMPORT_PROPAGATION_CERTIFICATION.md
-- =============================================================================

-- Q0. Which database is this? Expected: exactly one row, environment = 'production'.
select environment, policy_version, changeover_date from ii_nav_retention_policy;

-- Q1. Which programme migrations are already present? Expected before the sitting: every value false.
select
  exists (select 1 from information_schema.columns where table_name = 'fdh_financial_accounts' and column_name = 'owner_role')          as has_0207,
  to_regproc('public.fdh0207_assert_account_liability_owner') is not null                                                              as has_0207_fn,
  exists (select 1 from information_schema.columns where table_name = 'fdh_liability_statement_activities' and column_name = 'bank_match_candidate_ids') as has_0208,
  to_regproc('public.fdh10_record_liability_statement_ledger') is not null                                                             as has_0209,
  to_regclass('public.uq_fhip_import_applications_income_payroll_event_0210') is not null                                              as has_0210,
  to_regproc('public.fdh12_retirement_evidence_assert_authoritative_insert') is not null                                               as has_0211,
  to_regproc('public.fdh8_replace_transaction_allocations') is not null                                                                as has_0212,
  exists (select 1 from information_schema.columns where table_name = 'fdh_investment_statement_positions' and column_name = 'apply_rejected_reason') as has_0213,
  to_regproc('public.fdh15_apply_asset_proposal') is not null                                                                          as has_0214,
  exists (select 1 from pg_trigger where tgname = 'trg_fdh_allocations_same_tenant_0218')                                              as has_0218;

-- P1 (0208): liability statements sharing one document. Expected: 0 rows.
select statement_upload_id, array_agg(id order by created_at) ids,
       array_agg(approval_status order by created_at) approvals
  from fdh_liability_statements where statement_upload_id is not null
 group by statement_upload_id having count(*) > 1;

-- P2 (0208): one bank debit matched by several liability activities. Expected: 0 rows.
select linked_transaction_id, array_agg(id order by created_at) activity_ids
  from fdh_liability_statement_activities
 where bank_match_status = 'matched' and linked_transaction_id is not null
 group by linked_transaction_id having count(*) > 1;

-- P3 (0209): liability statements with more than one ready/applied proposal. Expected: 0 rows.
select source_liability_statement_id, array_agg(id order by generated_at) ids,
       array_agg(status order by generated_at) statuses
  from fhip_import_proposals
 where source_liability_statement_id is not null and status in ('ready','applied')
 group by 1 having count(*) > 1;

-- P4 (0210): payroll events with more than one Income application. Expected: 0 rows.
-- If any: STOP. scripts/fdh9_0210_duplicate_income_applications_report.sql has the review steps.
select a.source_payroll_event_id, a.user_id, count(*) as applications
  from fhip_import_applications a
 where a.target_domain = 'income' and a.source_payroll_event_id is not null
 group by a.source_payroll_event_id, a.user_id
having count(*) > 1;

-- P5 (0213): cross-tenant II rows. Expected: both counts 0.
select
  (select count(*) from ii_holding_snapshots s join ii_accounts a on a.id = s.account_id where a.user_id <> s.user_id) as cross_tenant_snapshots,
  (select count(*) from ii_transactions t join ii_accounts a on a.id = t.account_id where a.user_id <> t.user_id)       as cross_tenant_transactions;

-- P6 (0218 section B pre-check): split lines owned by a different user than their transaction. Expected: 0.
-- 0218 refuses to apply while this is > 0 (each such row is a forged cross-tenant write).
select count(*) as cross_tenant_allocations
  from fdh_transaction_allocations a join fdh_transactions t on t.id = a.transaction_id
 where t.user_id <> a.user_id;

-- P7 (sizes, for timing the sitting). Informational.
select
  (select count(*) from fdh_transactions)                     as fdh_transactions,
  (select count(*) from fdh_financial_accounts)               as fdh_financial_accounts,
  (select count(*) from fdh_liability_statements)             as fdh_liability_statements,
  (select count(*) from fdh_investment_statement_positions)   as fdh_investment_positions,
  (select count(*) from fhip_import_proposals)                as fhip_import_proposals,
  (select count(*) from fhip_import_applications)             as fhip_import_applications,
  (select count(*) from fdh_transaction_allocations)          as fdh_transaction_allocations;

-- P8 (GraphQL exposure, raised by the security review). Informational: is pg_graphql installed?
-- If it is, tell Claude before the sitting (the GUC analysis assumed it is not reachable).
select extname, extversion from pg_extension where extname = 'pg_graphql';
