-- AIE payslip AI-fallback — audit-event vocabulary widening (2026-09-22).
--
-- CONTEXT. Adds a payslip AI-fallback path (see
-- docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md and
-- lib/financial-data-hub/services/payslipProcessingService.ts's
-- `attemptAiPayslipFallback`/`confirmAiPayslipFallback`) that records seven
-- new event types on the EXISTING `fdh_document_audit_events` table — no new
-- table, same discipline every prior FDH-9/10/11/12 widening already
-- established (migrations 0091/0096/0106/0112). This migration touches ONLY
-- that one CHECK constraint; it creates no new table, column or index, and
-- writes no data.
--
-- MIGRATION NUMBER GOVERNANCE. `node scripts/check-migration-versions.mjs`
-- reports 0171 as the next free number in THIS worktree's own chain
-- (`origin/main`, HEAD `f0c0895`), but that check only sees this checkout's
-- own directory. A cross-branch scan of every currently-active remote/local
-- branch found `feature/nav1-selective-history-2026-09-21` has already
-- claimed 0171 and 0172 (its own migrations exist locally under that
-- branch's worktree). This migration is therefore numbered 0173 — the
-- lowest number free across every branch checked, not merely `origin/main`.
-- Also checked and confirmed lower/non-conflicting at the time of writing:
-- `feature/admin-a2-a5-master-execution` (0164/0165), `audit/lr-independent-
-- completeness-2026-09-21` (0163/0164), `fix/fdh3-structural-malware-
-- validation-2026-09-21` (0164/0170), `mission/m13-production-activation-
-- 2026-09-21` (0163/0164), `fix/ii-ai-fallback-admission-cohort-gate-2026-
-- 09-21` (0163/0164), `discovery/entity-data-separation-2026-09-21`
-- (0163/0164), `fix/expenses-panel-upload-not-wired-2026-09-21`
-- (0163/0164), `feature/investment-intelligence-r11-multisource-
-- professional` (0077/0082/0083), `feature/lr-1-upload-security-lifecycle`
-- (0137/0138/0139), `feature/fdh12-retirement-statement-intelligence`
-- (0112/0113/0114), `feature/aie-1-4-other-modules` (0137/0140/0143).
--
-- STATUS: DRAFTED, NOT APPLIED to any environment. This dispatch has no
-- production or DEV-apply authority (see the design document's own
-- "what's left before production activation" section) — this file exists so
-- the schema change is reviewable alongside the code that depends on it, and
-- so a future apply is a straight `supabase db push`, not a re-derivation.

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
      'payslip_ai_fallback_confirmed'
    ));
