-- E08 READ-ONLY. One Investment Intelligence statement: scan verdict, AI review state, and what was written.
-- Replace the all-zero id with the II source document id (the id shown in the Investment Intelligence statement list or the network tab).
-- Needs migration 0160 (table ii_ai_extraction_reviews). If that table is missing this statement fails: that is itself the finding.
-- Expected for DOC-I1: status ai_review_pending until the person accepts, then a purchase of 100 units for 5000.00 and
-- a holding valued 5250.00 as at 31/08/2026. Storage of the original removed.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as document_id)
select d.status as document_status,
       d.mime_type,
       d.malware_scan_status,
       d.malware_scan_decided_at,
       d.malware_scan_object_ref -> 's3Purge' ->> 'verified' as scan_copy_purge_verified,
       d.storage_purged_at,
       (d.storage_purge_error is not null) as storage_purge_error_present,
       (select string_agg(r.status || ':' || r.trigger_reason, ', ' order by r.created_at) from ii_ai_extraction_reviews r where r.source_document_id = d.id) as ai_reviews,
       (select count(*) from ii_transactions t where t.source_document_id = d.id) as transactions_written,
       (select coalesce(sum(t.gross_amount), 0) from ii_transactions t where t.source_document_id = d.id and t.transaction_type = 'purchase') as purchase_amount,
       (select coalesce(sum(t.units), 0) from ii_transactions t where t.source_document_id = d.id and t.transaction_type = 'purchase') as purchase_units
  from ii_source_documents d
  join p on p.document_id = d.id;
