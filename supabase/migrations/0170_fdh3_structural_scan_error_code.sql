-- FDH-3 malware-scan-gap remediation (2026-09-21) — additive widening.
--
-- CONTEXT. An independent audit found that none of FDH-3's document upload
-- routes (bank-csv, bank-pdf, payslip, liability/investment/retirement
-- statement) or their shared upload-lifecycle service had any malware/virus
-- scan integration at all. This pass wires FDH-3's own upload path through
-- the same structural/heuristic PDF scan the AI document-extraction (AIE)
-- pipeline already uses (`lib/shared/pdfStructuralScan.ts`, extracted from
-- `lib/aie/validation/fileValidation.ts` so both callers share one
-- implementation) — see `lib/financial-data-hub/domain/fileValidation.ts`'s
-- 2026-09-21 header addition and
-- `docs/financial-data-hub/FDH3_SHARED_MALWARE_GATE_DESIGN.md` for the full
-- picture, including what this is NOT (a real signature-based or
-- behavioural malware scanner).
--
-- Deliberately NOT reusing the existing `malware_detected` code (present in
-- the FDH-1 error taxonomy since migration 0046 but never set by any code
-- path until now would have been the first) — that value would overclaim a
-- real malware-scanner verdict this codebase does not have. A brand-new
-- code, `structural_scan_rejected`, names exactly what happened: the
-- disclosed structural/heuristic scan rejected the file. Nothing more.
--
-- This migration widens BOTH taxonomies a rejection can land in, same
-- discipline as FDH-5's own widening (migration 0071):
--   1. `fdh_statement_uploads.error_code` (document-level PROCESSING
--      failure, frozen FDH-1 set from migration 0046, already widened once
--      by FDH-5 in migration 0071).
--   2. `fdh_upload_sessions.failure_code` (session-level upload-MECHANICS
--      failure, its own independently-owned set from migration 0058).
-- `completeUpload()` (lib/financial-data-hub/services/uploadLifecycle.ts)
-- sets this same string value on whichever of the two columns is relevant at
-- the point of rejection, exactly as it already does for every other
-- `validateUploadedFile` failure code.
--
-- STATUS: DRAFTED, NOT APPLIED to any environment (per this pass's explicit
-- scope: no production writes/migrations). Verified collision-free against
-- the active migration directory via
-- `node scripts/check-migration-versions.mjs` before being handed over.

alter table fdh_statement_uploads
  drop constraint if exists fdh_statement_uploads_error_code_check;
alter table fdh_statement_uploads
  add constraint fdh_statement_uploads_error_code_check
    check (error_code is null or error_code in (
      -- FDH-1 original set (migration 0046) — unchanged.
      'unsupported_file_type', 'file_corrupt', 'password_required',
      'password_invalid', 'institution_not_identified',
      'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
      'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
      'malware_detected', 'privacy_purge_failed', 'internal_error',
      -- FDH-5 additions (migration 0071) — unchanged.
      'page_limit_exceeded', 'format_ambiguous', 'extraction_low_confidence',
      'ocr_required', 'ocr_failed',
      -- FDH-3 malware-scan-gap remediation addition (this migration).
      'structural_scan_rejected'
    ));

alter table fdh_upload_sessions
  drop constraint if exists fdh_upload_sessions_failure_code_check;
alter table fdh_upload_sessions
  add constraint fdh_upload_sessions_failure_code_check
    check (failure_code is null or failure_code in (
      -- FDH-3 original set (migration 0058) — unchanged.
      'unsupported_file_type', 'file_too_large', 'mime_mismatch', 'file_corrupt',
      'password_required', 'upload_incomplete', 'storage_error', 'internal_error',
      -- FDH-3 malware-scan-gap remediation addition (this migration).
      'structural_scan_rejected'
    ));
