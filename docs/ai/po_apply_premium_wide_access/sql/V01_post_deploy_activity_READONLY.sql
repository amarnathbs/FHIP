-- V01  READ-ONLY  After the deploy and your own proof runs: what happened, per document class, with no personal data.
-- Counts only. Change the interval if you want a different window. Run each statement SEPARATELY.

-- 1) AI document reading attempts and outcomes by event type and reason, last 48 hours.
--    Expected after the change: premium_required appears for Free users, and NOT the old cohort_denied reason.
select event_type,
       coalesce(metadata ->> 'reason', metadata ->> 'outcome', '-') as reason_or_outcome,
       count(*) as events
  from fdh_document_audit_events
 where event_type like '%ai_fallback%'
   and created_at >= now() - interval '48 hours'
 group by event_type, coalesce(metadata ->> 'reason', metadata ->> 'outcome', '-')
 order by event_type, events desc;
