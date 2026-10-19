-- C01 WRITE (copies only). Take the manual backup of every row the cleanup could remove or detach, for the registered proof accounts only.
-- The copies live in the private schema, which the API never serves, with row level security on and every API privilege revoked.
-- Safe to run twice: a copy is created only when it does not exist yet. The copies also serve as the archive of the proof evidence
-- (audit events and cost attempts survive account deletion with the account reference emptied, but the copies keep them attributable).

create schema if not exists private;

create table if not exists private.bkp_aiproof_uploads as select t.* from public.fdh_statement_uploads t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_drafts as select t.* from public.fdh_ai_fallback_drafts t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_transactions as select t.* from public.fdh_transactions t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_reconciliation as select t.* from public.fdh_reconciliation_results t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_audit as select t.* from public.fdh_document_audit_events t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_cost_attempts as select t.* from public.aie_ai_cost_attempt t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_payroll as select t.* from public.fdh_payroll_events t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_liability as select t.* from public.fdh_liability_statements t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_retirement as select t.* from public.fdh_retirement_statements t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_investment as select t.* from public.fdh_investment_statements t where t.user_id in (select user_id from private.aiproof_ids);
create table if not exists private.bkp_aiproof_entitlements as select t.* from public.user_entitlements t where t.user_id in (select user_id from private.aiproof_ids);

alter table private.bkp_aiproof_uploads enable row level security;
alter table private.bkp_aiproof_drafts enable row level security;
alter table private.bkp_aiproof_transactions enable row level security;
alter table private.bkp_aiproof_reconciliation enable row level security;
alter table private.bkp_aiproof_audit enable row level security;
alter table private.bkp_aiproof_cost_attempts enable row level security;
alter table private.bkp_aiproof_payroll enable row level security;
alter table private.bkp_aiproof_liability enable row level security;
alter table private.bkp_aiproof_retirement enable row level security;
alter table private.bkp_aiproof_investment enable row level security;
alter table private.bkp_aiproof_entitlements enable row level security;
revoke all on private.bkp_aiproof_uploads, private.bkp_aiproof_drafts, private.bkp_aiproof_transactions, private.bkp_aiproof_reconciliation,
  private.bkp_aiproof_audit, private.bkp_aiproof_cost_attempts, private.bkp_aiproof_payroll, private.bkp_aiproof_liability,
  private.bkp_aiproof_retirement, private.bkp_aiproof_investment, private.bkp_aiproof_entitlements from public, anon, authenticated;
