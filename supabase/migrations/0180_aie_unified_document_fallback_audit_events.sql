-- AIE unified document fallback — audit-event vocabulary widening (2026-09-23).
--
-- CONTEXT. Extends the payslip AI-fallback pattern (migration 0173) to the
-- four remaining FDH-3 document types that have BOTH a native processing
-- service AND a real import panel: bank statement, retirement statement,
-- liability statement and investment statement. See
-- docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md §3/§5
-- and each type's own `attemptAi*Fallback`/`confirmAi*Fallback` in
-- lib/financial-data-hub/services/.
--
-- Adds 28 new event types (7 per document type, the same seven the payslip
-- path already records) to the EXISTING `fdh_document_audit_events` table —
-- no new table, same discipline every prior FDH-9/10/11/12 and AIE-payslip
-- widening already established (migrations 0091/0096/0106/0112/0173). This
-- migration touches ONLY that one CHECK constraint; it creates no new table,
-- column or index, and writes no data.
--
-- STRICTLY ADDITIVE, AND MECHANICALLY VERIFIED TO BE SO. The 79 pre-existing
-- values below were not retyped — they were carried over VERBATIM from
-- 0173's own constraint body (comments included) by a generator that then
-- asserted, before writing this file, that every one of those 79 survived
-- into the new list and that no value appears twice. 79 carried + 28 new =
-- 107. The TypeScript side was checked against 0173 in both directions first
-- (79 = 79, nothing in TS missing from SQL, nothing in SQL missing from TS),
-- so this file and `FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES` in
-- lib/financial-data-hub/constants/enums.ts start from a proven-synchronised
-- baseline. That check matters more than it looks: `recordDocumentAuditEvent`
-- SWALLOWS insert errors to console.error, so a TS value missing from this
-- constraint fails SILENTLY at runtime rather than loudly.
--
-- MIGRATION NUMBER GOVERNANCE. Numbered 0180 after establishing the true
-- ceiling across EVERY branch, not just this worktree — `npm run
-- check:migrations` only sees the working tree and its sibling only compares
-- `origin/main`, so neither can see a number already claimed on an unmerged
-- branch. That exact blind spot caused a collision on 2026-09-22. Two
-- independent scans were run:
--   (1) a git scan of every ref under refs/remotes AND refs/heads
--       (`git ls-tree -r <ref> -- supabase/migrations/`), which returned a
--       contiguous ceiling of 0179;
--   (2) a filesystem scan of every sibling worktree checkout plus the repo
--       root, to catch a migration file CREATED BUT NOT YET COMMITTED on
--       another agent's branch — the case a git scan cannot see at all.
-- Both agreed: the highest number claimed anywhere is 0179
-- (`0179_fdh3_real_malware_scan_error_codes.sql`). 0175-0178 belong to an
-- unmerged Module 11 branch and are already applied to DEV. 0180 is
-- therefore the lowest genuinely-free number.
--
-- ALSO VERIFIED: no migration between 0174 and 0179 references
-- `fdh_document_audit_events` at all, so 0173 really is the latest definition
-- of this constraint and its value list really is the current superset. This
-- was checked by grep across all migrations rather than assumed from the
-- numbering.
--
-- STATUS: DRAFTED, NOT APPLIED to any environment. This dispatch has no
-- production or DEV-apply authority. Every flag the new code sits behind
-- defaults OFF, so none of these event types can be emitted until an operator
-- both applies this migration and enables a flag.

alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058).
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064).
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions (migration 0068).
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created',
      -- FDH-5 additions (migration 0071).
      'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
      'pdf_native_extraction_started', 'pdf_native_extraction_completed',
      'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
      'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed',
      -- FDH-7 additions (migration 0076).
      'transaction_split_created', 'transaction_approved', 'statement_approved',
      'statement_reopened', 'bulk_review_action_completed',
      -- FDH-9 additions (migration 0091).
      'payslip_extraction_completed', 'payslip_extraction_failed',
      'payroll_event_approved', 'income_proposal_generated',
      'income_proposal_applied', 'income_proposal_dismissed',
      -- FDH-10 additions (migration 0096).
      'liability_statement_extraction_completed',
      'liability_statement_extraction_failed',
      'liability_statement_approved',
      'liability_bank_match_completed',
      'liability_proposal_generated',
      'liability_proposal_applied',
      'liability_proposal_dismissed',
      -- FDH-11 additions (migration 0106).
      'investment_statement_extraction_completed',
      'investment_statement_extraction_failed',
      'investment_statement_account_matched',
      'investment_statement_security_matched',
      'investment_statement_reconciled',
      'investment_statement_bank_match_completed',
      'investment_statement_approved',
      'investment_statement_applied',
      'investment_statement_apply_rejected_stale',
      -- FDH-12 additions (migration 0112).
      'retirement_statement_extraction_completed',
      'retirement_statement_extraction_failed',
      'retirement_statement_account_matched',
      'retirement_statement_payslip_matched',
      'retirement_statement_reconciled',
      'retirement_statement_bank_match_completed',
      'retirement_statement_routed_to_smsf',
      'retirement_statement_approved',
      'retirement_proposal_generated',
      'retirement_proposal_applied',
      'retirement_proposal_dismissed',
      -- AIE payslip AI-fallback additions (this migration).
      'payslip_ai_fallback_attempted',
      'payslip_ai_fallback_masking_below_policy',
      'payslip_ai_fallback_provider_outcome',
      'payslip_ai_fallback_insufficient_fields',
      'payslip_ai_fallback_draft_ready',
      'payslip_ai_fallback_not_usable',
      'payslip_ai_fallback_confirmed',
      -- AIE unified document fallback — bank statement (this migration).
      'bank_statement_ai_fallback_attempted',
      'bank_statement_ai_fallback_masking_below_policy',
      'bank_statement_ai_fallback_provider_outcome',
      'bank_statement_ai_fallback_insufficient_fields',
      'bank_statement_ai_fallback_draft_ready',
      'bank_statement_ai_fallback_not_usable',
      'bank_statement_ai_fallback_confirmed',
      -- AIE unified document fallback — retirement statement (this migration).
      'retirement_statement_ai_fallback_attempted',
      'retirement_statement_ai_fallback_masking_below_policy',
      'retirement_statement_ai_fallback_provider_outcome',
      'retirement_statement_ai_fallback_insufficient_fields',
      'retirement_statement_ai_fallback_draft_ready',
      'retirement_statement_ai_fallback_not_usable',
      'retirement_statement_ai_fallback_confirmed',
      -- AIE unified document fallback — liability statement (this migration).
      'liability_statement_ai_fallback_attempted',
      'liability_statement_ai_fallback_masking_below_policy',
      'liability_statement_ai_fallback_provider_outcome',
      'liability_statement_ai_fallback_insufficient_fields',
      'liability_statement_ai_fallback_draft_ready',
      'liability_statement_ai_fallback_not_usable',
      'liability_statement_ai_fallback_confirmed',
      -- AIE unified document fallback — investment statement (this migration).
      'investment_statement_ai_fallback_attempted',
      'investment_statement_ai_fallback_masking_below_policy',
      'investment_statement_ai_fallback_provider_outcome',
      'investment_statement_ai_fallback_insufficient_fields',
      'investment_statement_ai_fallback_draft_ready',
      'investment_statement_ai_fallback_not_usable',
      'investment_statement_ai_fallback_confirmed'
    ));
