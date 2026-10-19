-- E02 READ-ONLY. The audit trail of one document, oldest first. Only safe metadata keys are shown.
-- Replace the all-zero id with your document id. Look for: pdf_native_extraction_started, then the class AI events
-- (attempted, provider_outcome, draft_ready or not_usable with a reason), then confirmed, then document_purged.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as document_id)
select e.created_at,
       e.event_type,
       e.actor_type,
       e.metadata ->> 'reason' as reason,
       e.metadata ->> 'outcome' as outcome,
       e.metadata ->> 'ai_model' as ai_model,
       e.metadata ->> 'ai_input_tokens' as ai_input_tokens,
       e.metadata ->> 'ai_output_tokens' as ai_output_tokens,
       case when jsonb_typeof(e.metadata -> 'ai_provider_request_ids') = 'array' then jsonb_array_length(e.metadata -> 'ai_provider_request_ids') else 0 end as provider_request_id_count,
       e.metadata ->> 'draft_persisted' as draft_persisted,
       e.metadata ->> 'rows' as rows_read,
       left(coalesce(e.metadata ->> 'ai_cost_key', ''), 8) as cost_key_prefix
  from fdh_document_audit_events e
  join p on p.document_id = e.document_id
 order by e.created_at asc, e.event_type asc;
