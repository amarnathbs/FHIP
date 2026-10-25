-- WP-H2 pack 01 (READ ONLY, DEV first and then production). Shows what the malware scan recorded and why a file was refused.
-- Nothing is written. No file names, no user identifiers and no document content are returned.

-- Result 1: the recorded scan state of statements uploaded in the last 14 days.
-- detail_kind is the first word of the stored scan detail. UNSUPPORTED on a password protected statement is the known cause of the block.
-- Expect scan_status none or not_required for statements uploaded while the scan was off or deferred for a password.
select
  coalesce(malware_scan_status, 'none') as scan_status,
  split_part(coalesce(malware_scan_object_ref ->> 'detail', ''), ':', 1) as detail_kind,
  count(*) as statements,
  min(uploaded_at) as first_seen,
  max(uploaded_at) as last_seen
from ii_source_documents
where uploaded_at > now() - interval '14 days'
group by 1, 2
order by statements desc;

-- Result 2: refusals recorded by the gate since this release was deployed. One row per refusal, reason code only.
-- outcome is blocked when the content was refused and unavailable when the scan could not finish.
select
  created_at,
  metadata ->> 'outcome' as outcome,
  metadata ->> 'refusal' as refusal_code,
  metadata ->> 'scanStatus' as stored_scan_status,
  subject_id as statement_id
from ii_audit_events
where event_type = 'document_processing_failed'
  and metadata ->> 'reason' = 'malware_scan_refused'
  and created_at > now() - interval '14 days'
order by created_at desc
limit 100;
