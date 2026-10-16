-- V02  READ-ONLY  Drafts, reviews, deletion of the original files, and spend. Counts only, no personal data.
-- Run each statement SEPARATELY.

-- 1) Durable AI drafts by status and document type, last 7 days.
select document_type, status, count(*) as drafts
  from fdh_ai_fallback_drafts
 where created_at >= now() - interval '7 days'
 group by document_type, status
 order by document_type, status;

-- 2) Investment Intelligence AI reviews by status, last 7 days.
select status, count(*) as reviews
  from ii_ai_extraction_reviews
 where created_at >= now() - interval '7 days'
 group by status
 order by status;

-- 3) Verified deletion of the original files: any document that has a draft or a confirmed result but whose original
--    file is still stored after more than 24 hours should be zero. Anything above zero needs the purge sweep checked.
select d.document_type, u.raw_document_purge_status, count(*) as documents
  from fdh_statement_uploads u
  join fdh_ai_fallback_drafts d on d.statement_upload_id = u.id
 where d.created_at < now() - interval '24 hours'
   and u.raw_document_storage_reference is not null
 group by d.document_type, u.raw_document_purge_status
 order by documents desc;

-- 4) AI spend ledger and its change. Compare the numbers with the P03 reading you took before the deploy.
select allowance_usd, reserved_usd, settled_usd,
       (allowance_usd - reserved_usd - settled_usd) as remaining_usd,
       total_attempts, total_input_tokens, total_output_tokens
  from aie_ai_cost_ledger
 where id = 'global';

-- 6) The ten most recent provider calls as accounted: model, tokens, outcome and cost. This is the evidence of the
--    real gpt-4o-mini call for your proof account (match it by the time you ran the proof).
select created_at, model, input_tokens, output_tokens, call_outcome, billing_uncertain, reserved_usd, settled_usd
  from aie_ai_cost_attempt
 order by created_at desc
 limit 10;

-- 5) Reservations still open for more than an hour (should be zero; the sweep settles them conservatively).
select count(*) as open_reservations_older_than_1h
  from aie_ai_cost_attempt
 where created_at < now() - interval '1 hour'
   and settled_at is null;
