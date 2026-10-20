-- E09 READ-ONLY. Platform-wide health of the scan and deletion path over the last 7 days. Counts only.
-- Expected: scan_pending_over_30_min = 0, originals_kept_over_2_hours_after_durable_result = 0, scan_copy_purge_unverified = 0.
-- A non-zero scan_copy_purge_unverified means the temporary copy made for the malware scan was not proven deleted
-- (on DEV the scan copy delete was answered access_denied: check the production permission of the scan role).

select (select count(*) from fdh_statement_uploads u where u.created_at >= now() - interval '7 days') as uploads_7d,
       (select count(*) from fdh_statement_uploads u where u.created_at >= now() - interval '7 days' and u.malware_scan_status = 'clean') as scanned_clean_7d,
       (select count(*) from fdh_statement_uploads u where u.created_at >= now() - interval '7 days' and u.malware_scan_status = 'not_required') as scan_not_required_7d,
       (select count(*) from fdh_statement_uploads u where u.malware_scan_status = 'pending' and u.created_at < now() - interval '30 minutes') as scan_pending_over_30_min,
       (select count(*) from fdh_statement_uploads u where u.created_at >= now() - interval '7 days' and u.malware_scan_status in ('malicious', 'suspicious', 'scan_failed', 'scan_timeout', 'unknown')) as scan_blocked_7d,
       (select count(*) from fdh_statement_uploads u
         where u.created_at >= now() - interval '7 days' and u.raw_document_storage_reference is not null
           and u.created_at < now() - interval '2 hours'
           and exists (select 1 from fdh_ai_fallback_drafts d where d.statement_upload_id = u.id)) as originals_kept_over_2_hours_after_durable_result,
       (select count(*) from fdh_statement_uploads u
         where u.created_at >= now() - interval '7 days' and u.malware_scan_status = 'clean'
           and coalesce(u.malware_scan_object_ref -> 's3Purge' ->> 'verified', 'none') <> 'absent') as scan_copy_purge_unverified;
