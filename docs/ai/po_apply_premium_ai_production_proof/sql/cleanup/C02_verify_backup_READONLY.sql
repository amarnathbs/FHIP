-- C02 READ-ONLY. The backup must equal the live rows for the registered proof accounts. Every ok must be true BEFORE C03.
-- If you ran more proof uploads after C01, drop the copies with C05 and run C01 again so the copies are current.

select check_name, live_rows, backup_rows, (live_rows = backup_rows) as ok
  from (
    select 'fdh_statement_uploads' as check_name,
           (select count(*) from public.fdh_statement_uploads t where t.user_id in (select user_id from private.aiproof_ids)) as live_rows,
           (select count(*) from private.bkp_aiproof_uploads) as backup_rows
    union all select 'fdh_ai_fallback_drafts', (select count(*) from public.fdh_ai_fallback_drafts t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_drafts)
    union all select 'fdh_transactions', (select count(*) from public.fdh_transactions t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_transactions)
    union all select 'fdh_reconciliation_results', (select count(*) from public.fdh_reconciliation_results t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_reconciliation)
    union all select 'fdh_document_audit_events', (select count(*) from public.fdh_document_audit_events t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_audit)
    union all select 'aie_ai_cost_attempt', (select count(*) from public.aie_ai_cost_attempt t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_cost_attempts)
    union all select 'fdh_payroll_events', (select count(*) from public.fdh_payroll_events t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_payroll)
    union all select 'fdh_liability_statements', (select count(*) from public.fdh_liability_statements t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_liability)
    union all select 'fdh_retirement_statements', (select count(*) from public.fdh_retirement_statements t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_retirement)
    union all select 'fdh_investment_statements', (select count(*) from public.fdh_investment_statements t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_investment)
    union all select 'user_entitlements', (select count(*) from public.user_entitlements t where t.user_id in (select user_id from private.aiproof_ids)), (select count(*) from private.bkp_aiproof_entitlements)
  ) c
 order by ok, check_name;
