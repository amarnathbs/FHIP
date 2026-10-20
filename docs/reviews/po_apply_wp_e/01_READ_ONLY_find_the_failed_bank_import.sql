-- WP-E / Document2 (4) F15 -- READ ONLY. Changes nothing. Safe on production and on DEV.
-- Purpose: show exactly which stage your failed bank-statement import stopped at. Run each block on its own in the Supabase SQL editor.
-- Before running: replace REPLACE_WITH_YOUR_LOGIN_EMAIL (appears once, in block 1) with the e-mail you log in with.
-- Nothing here shows a statement line, an amount, a description or a file name.

-- BLOCK 1: your most recent bank uploads and where each one stopped.
select d.id,
       d.uploaded_at,
       d.processing_status,
       d.error_code,
       d.malware_scan_status,
       d.mime_type,
       d.page_count,
       d.processing_started_at,
       d.processing_completed_at,
       round(extract(epoch from (now() - d.processing_started_at))::numeric) as seconds_since_processing_started,
       d.financial_account_id is not null as account_assigned,
       d.owner_role,
       d.certification_status,
       d.parsed_row_count,
       d.certified_row_count,
       d.duplicate_row_count
  from fdh_statement_uploads d
  join auth.users u on u.id = d.user_id
 where u.email = 'REPLACE_WITH_YOUR_LOGIN_EMAIL'
   and d.document_type = 'bank_statement'
 order by d.uploaded_at desc nulls last
 limit 10;
-- How to read it:
--   processing_status = processing and seconds_since_processing_started over 120  -> the request was ended by the platform before it could finish
--                                                                                    (the F15 cause). The new code cleans this up and reads it again.
--   processing_status = failed with error_code                                      -> the named stage failed (extraction_timeout, layout_unsupported, malware_*, ...).
--   malware_scan_status not clean                                                    -> stopped at the safety check, before any reading.
--   account_assigned = false                                                         -> stopped at account assignment.
--   owner_role empty on a recent upload                                              -> owner-before-upload (migration 0236) is not live on this database.

-- BLOCK 2: the audit trail of those uploads, newest first (event names and the reason code only).
select e.created_at, e.document_id, e.event_type, e.actor_type, e.metadata ->> 'reason' as reason
  from fdh_document_audit_events e
  join auth.users u on u.id = e.user_id
 where u.email = 'REPLACE_WITH_YOUR_LOGIN_EMAIL'
   and e.created_at > now() - interval '3 days'
 order by e.created_at desc
 limit 60;

-- BLOCK 3: rows a killed run left behind (a count per stuck statement, no content).
select d.id as document_id, count(t.id) as partial_transactions
  from fdh_statement_uploads d
  join auth.users u on u.id = d.user_id
  left join fdh_transactions t on t.statement_upload_id = d.id
 where u.email = 'REPLACE_WITH_YOUR_LOGIN_EMAIL'
   and d.processing_status = 'processing'
 group by d.id;

-- BLOCK 4: is the AI reading of bank statements switched on for your account (Premium window)?
select e.plan_tier, e.effective_from, e.effective_to
  from user_entitlements e
  join auth.users u on u.id = e.user_id
 where u.email = 'REPLACE_WITH_YOUR_LOGIN_EMAIL';
