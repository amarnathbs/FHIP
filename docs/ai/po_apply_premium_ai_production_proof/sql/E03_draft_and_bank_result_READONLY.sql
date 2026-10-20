-- E03 READ-ONLY. The durable structured draft and the bank result of one document.
-- Replace the all-zero id with your bank statement document id. Expected for DOC-B1: 6 transactions, money_out 1795.75,
-- money_in 2950.00, reconciliation reconciled, variance 0, certification certified. See synthetic/EXPECTED_VALUES.md.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as document_id)
select (select string_agg(d.status || ':' || d.document_type || ':rows=' || coalesce(jsonb_array_length(d.payload -> 'rows')::text, '-'), ', ' order by d.created_at)
          from fdh_ai_fallback_drafts d where d.statement_upload_id = p.document_id) as drafts,
       (select count(*) from fdh_transactions t where t.statement_upload_id = p.document_id) as transactions,
       (select coalesce(sum(t.amount_original), 0) from fdh_transactions t where t.statement_upload_id = p.document_id and t.credit_debit = 'debit') as money_out,
       (select coalesce(sum(t.amount_original), 0) from fdh_transactions t where t.statement_upload_id = p.document_id and t.credit_debit = 'credit') as money_in,
       (select r.status from fdh_reconciliation_results r where r.statement_upload_id = p.document_id order by r.created_at desc limit 1) as reconciliation_status,
       (select r.variance from fdh_reconciliation_results r where r.statement_upload_id = p.document_id order by r.created_at desc limit 1) as reconciliation_variance,
       (select u.certification_status from fdh_statement_uploads u where u.id = p.document_id) as certification_status,
       (select u.processing_status from fdh_statement_uploads u where u.id = p.document_id) as processing_status
  from p;
