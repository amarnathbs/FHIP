-- E01 READ-ONLY. One uploaded document: scan verdict and its binding to the stored object, status, and deletion of the original file.
-- Replace the all-zero id below with the document id of your proof upload (the last part of the address, or the id in the network tab).
-- Returns statuses, booleans and timestamps. No file name, no content, no object key.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as document_id)
select left(u.id::text, 8) as document_prefix,
       u.processing_status,
       u.certification_status,
       u.error_code,
       u.mime_type,
       u.uploaded_at,
       u.malware_scan_status,
       u.malware_scan_decided_at,
       (u.malware_scan_object_ref -> 'ref' ->> 'versionId') is not null as scan_has_object_version,
       ((u.malware_scan_object_ref -> 'ref' ->> 'versionId') = (u.malware_scan_object_ref -> 'expected' ->> 'expectedVersionId')) as scan_version_matches_expected,
       ((u.malware_scan_object_ref -> 'ref' ->> 'eTag') = (u.malware_scan_object_ref -> 'expected' ->> 'expectedETag')) as scan_etag_matches_expected,
       ((u.malware_scan_object_ref -> 'ref' ->> 'objectKey') = (u.malware_scan_object_ref -> 'expected' ->> 'objectKey')) as scan_object_key_matches_expected,
       u.malware_scan_object_ref -> 's3Purge' ->> 'outcome' as scan_copy_purge_outcome,
       u.malware_scan_object_ref -> 's3Purge' ->> 'verified' as scan_copy_purge_verified,
       u.raw_document_purge_status,
       (u.raw_document_storage_reference is not null) as original_reference_still_set,
       exists (select 1 from storage.objects o where o.bucket_id = 'fdh-source-documents' and o.name = u.raw_document_storage_reference) as original_object_still_stored,
       u.purge_reason
  from fdh_statement_uploads u
  join p on p.document_id = u.id;
