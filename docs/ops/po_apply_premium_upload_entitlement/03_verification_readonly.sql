-- Premium Upload Entitlement -- READ-ONLY verification after the release is live. Changes nothing.
-- Replace REPLACE_RELEASE_TIMESTAMP (for example 2026-10-20 09:30:00+00) with the moment the Amplify build went live.

-- A. Every document admitted since the release carries the Premium-at-admission stamp.
select count(*) filter (where metadata ->> 'import_entitlement' = 'premium') as stamped_premium,
       count(*) filter (where metadata ->> 'import_entitlement' is null)     as unstamped
  from public.fdh_document_audit_events
 where event_type = 'document_upload_created'
   and created_at >= timestamptz 'REPLACE_RELEASE_TIMESTAMP';
-- Expected: unstamped = 0.

-- B. No document was admitted since the release by an account that is Free today AND was never Premium in the window
--    (a rough cross-check; an account that downgraded after admitting will legitimately appear and should be explained).
select count(*) as admitted_by_currently_free_accounts
  from public.fdh_document_audit_events e
  join public.user_entitlements u on u.user_id = e.user_id
 where e.event_type = 'document_upload_created'
   and e.created_at >= timestamptz 'REPLACE_RELEASE_TIMESTAMP'
   and u.plan_tier = 'free';
-- Expected: 0, or each row explained by a downgrade after admission.

-- C. Plan counts are unchanged by the release (this change never writes plan_tier).
select plan_tier, count(*) as accounts
  from public.user_entitlements
 group by plan_tier
 order by plan_tier;
