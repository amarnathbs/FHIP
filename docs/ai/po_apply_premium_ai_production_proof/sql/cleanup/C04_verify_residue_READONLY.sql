-- C04 READ-ONLY. After C03: nothing of the proof accounts may remain except the detached audit events and cost attempts.
-- Expected: accounts_left 0, uploads_left 0, transactions_left 0, drafts_left 0, entitlements_left 0.
-- audit_events_kept_detached and cost_attempts_kept_detached are the records that must survive, so their counts are checked against the backup.

select (select count(*) from auth.users u where u.id in (select user_id from private.aiproof_ids)) as accounts_left,
       (select count(*) from public.fdh_statement_uploads t where t.user_id in (select user_id from private.aiproof_ids)) as uploads_left,
       (select count(*) from public.fdh_transactions t where t.user_id in (select user_id from private.aiproof_ids)) as transactions_left,
       (select count(*) from public.fdh_ai_fallback_drafts t where t.user_id in (select user_id from private.aiproof_ids)) as drafts_left,
       (select count(*) from public.user_entitlements t where t.user_id in (select user_id from private.aiproof_ids)) as entitlements_left,
       (select count(*) from private.bkp_aiproof_audit) as audit_events_in_backup,
       (select count(*) from private.bkp_aiproof_cost_attempts) as cost_attempts_in_backup,
       (select count(*) from public.aie_ai_cost_attempt a where a.idempotency_key in (select b.idempotency_key from private.bkp_aiproof_cost_attempts b)) as cost_attempts_kept_detached,
       (select count(*) from public.fdh_document_audit_events e where e.id in (select b.id from private.bkp_aiproof_audit b)) as audit_events_kept_detached;
