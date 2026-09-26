/**
 * FDH-9 — Payslip & Income Intelligence: processing orchestration.
 *
 * Direct payslip analogue of `bankPdfProcessingService.ts` (spec sections 21,
 * 25-29, 45-46, 55-58, 63-64): same document-lifecycle discipline, same
 * idempotency/retry-safety shape, same "download once, extract, persist,
 * transition" structure. What is different, deliberately, is everything
 * downstream of text extraction — a payslip produces payroll EVIDENCE
 * (`fdh_payroll_events` / `fdh_payroll_components`), never a canonical Income
 * mutation (spec section 4's "upload does not change Income").
 *
 * REUSE, NOT DUPLICATION (spec sections 14, 25). PDF byte -> text extraction
 * is FDH-5's `extractPdfPages`, used unchanged. The FDH-3 document lifecycle
 * (`fdh_statement_uploads`, `assertDocumentTransition`,
 * `recordDocumentAuditEvent`, `downloadDocumentObject`) is the same one every
 * other FDH document type uses. No second storage bucket, no second upload
 * service, no second document table (spec section 25).
 *
 * WHY THIS SERVICE NEVER CALLS `assertDocumentTransition('processing',
 * 'queued')`. `bankPdfProcessingService.ts` does exactly that for a
 * password-retry outcome, but `DOCUMENT_STATUS_TRANSITIONS.processing` (see
 * `../domain/documentLifecycle.ts`) does not actually include `'queued'` as a
 * legal target from `'processing'` — only `extracted`, `review_required`,
 * `failed` and `rejected` are. That FDH-5 call site is a genuine pre-existing
 * defect (out of FDH-9's scope to fix; flagged separately), not a pattern to
 * copy. This service instead moves a password outcome to the ALREADY-legal
 * `processing -> failed` edge (mirroring the same file's handling of every
 * other terminal-for-this-attempt outcome), and its own re-entry check (does
 * `document.processing_status` sit in `['queued', 'failed']`?) already covers
 * `failed` as a retry-eligible state, which then legitimately re-enters via
 * the existing `failed -> queued -> processing` edges.
 *
 * ONE ECONOMIC EVENT, NOT TWO (spec sections 4, 35, 87). This service creates
 * AT MOST one `fdh_payroll_events` row per distinct payslip (the unique
 * `(user_id, payslip_fingerprint)` index at the database layer is the
 * backstop — a Postgres `23505` on that constraint is treated as "this exact
 * payslip was already uploaded", not as an error to surface as a processing
 * failure). Matching a bank deposit to that event (`bankMatch.ts`) NEVER
 * creates a second event or a second amount — it only stamps corroboration
 * onto the one row already inserted from the payslip itself.
 */

import { resolveEmailForAiePilotCohort } from '@/lib/aie/pilotCohortEmail';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statementUploadsRepository, documentAuditEventsRepository } from '../repositories';
// M12C §10 (`M2-OPEN-8`) — the SHARED, already-certified limiter. Imported,
// never re-implemented: one threshold and one window for every PDF password
// surface in the product.
import { checkPasswordAttemptRateLimit } from '../bank-pdf/password';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { extractPdfPages } from '../bank-pdf/textExtraction';
import {
  parsePayslipText,
  payslipFingerprint,
  scoreExtractionConfidence,
  PAYSLIP_PARSER_NAME,
  PAYSLIP_PARSER_VERSION,
} from '../payslip/parser';
import { reconcileGrossToNet } from '../payslip/reconciliation';
import { matchSalaryDeposit, type BankCandidate } from '../payslip/bankMatch';
import { normaliseEmployerName } from '../payslip/normalise';
import type { FdhStatementUpload } from '../domain/types';
import type {
  PayrollCountry,
  PayrollExtraction,
  PayrollReconciliationStatus,
  PayslipExtractionFailureKind,
} from '../payslip/types';
import type { FdhErrorCode } from '../constants/enums';
// AI-fallback addition (2026-09-22). Deliberately the SAME shape as
// Investment Intelligence's own live mechanism
// (`lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts`):
// call the shared AIE gateway directly from inside this native processing
// service's own failure branch, gated by its own kill switch plus the
// shared global one plus the shared pilot-cohort gate — never the heavier
// orchestrator/intake/accept pipeline, which this repo's own AIE-programme
// design audit found has zero live frontend callers for any of the three
// adapters that use it today. See
// `lib/aie/adapters/payslip/featureFlags.ts`'s header and
// `docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md`.
import {
  isAiePayslipAiFallbackEnabled,
  requestPayslipAiExtraction,
  mapPayslipFactsToExtraction,
  AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME,
  AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/payslip';
import { saveAiFallbackDraft, claimPendingAiFallbackDraft, releaseClaimedAiFallbackDraftIfNothingWritten } from './aiFallbackDrafts';
import { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } from './identicalUpload';
import { isAieAiFallbackEnabled, isUserInAiePilotCohort } from '@/lib/aie/featureFlags';
import { maskText, isBelowMaskingPolicy } from '@/lib/aie/masking/piiMasking';

export class PayslipProcessingError extends Error {
  constructor(
    // M12C §10 (`M2-OPEN-8`): `rate_limited` mirrors BankPdfProcessingError's
    // own code of the same name, so both PDF password surfaces refuse in the
    // same vocabulary and a caller cannot have to learn two.
    readonly code: 'not_found' | 'invalid_state' | 'wrong_document_type' | 'internal_error' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'PayslipProcessingError';
  }
}

async function getOwnedDocument(userId: string, documentId: string): Promise<FdhStatementUpload> {
  const { data } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!data) throw new PayslipProcessingError('not_found', 'document not found');
  return data;
}

async function adminUpdateStatementUpload(
  userId: string,
  documentId: string,
  patch: Record<string, unknown>,
): Promise<FdhStatementUpload | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('fdh_statement_uploads')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as FdhStatementUpload | null;
}

/** Maps the PDF byte-extraction failure kind onto the ALREADY-existing
 * `error_code` vocabulary (spec section 83 discipline: no new code invented
 * where an existing one fits). */
export function errorCodeForPdfExtractionFailure(kind: string): FdhErrorCode {
  switch (kind) {
    case 'password_required':
      return 'password_required';
    case 'wrong_password':
      return 'password_invalid';
    case 'corrupt':
      return 'file_corrupt';
    case 'insufficient_text':
      // Spec section 27: a scanned/image-only payslip is refused with a
      // truthful "OCR not yet supported" state, never a guess.
      return 'ocr_required';
    case 'page_limit_exceeded':
      return 'page_limit_exceeded';
    default:
      return 'internal_error';
  }
}

/** Maps a payslip-layout parse failure onto the existing vocabulary. */
export function errorCodeForPayslipParseFailure(kind: PayslipExtractionFailureKind): FdhErrorCode {
  switch (kind) {
    case 'not_a_payslip':
      return 'document_type_not_identified';
    case 'country_not_identified':
      return 'document_type_not_identified';
    case 'scanned_document':
    case 'ocr_required':
      return 'ocr_required';
    case 'password_required':
      return 'password_required';
    case 'wrong_password':
      return 'password_invalid';
    case 'corrupt':
      return 'file_corrupt';
    case 'layout_unsupported':
      return 'layout_unsupported';
    case 'page_limit_exceeded':
      return 'page_limit_exceeded';
    default:
      return 'internal_error';
  }
}

/** User-truthful copy for every controlled failure state (spec sections
 * 27-28, 33-34, 59: never a stack trace, never an internal enum name, never a
 * misleading "error" for a legitimate INSUFFICIENT_DATA-shaped outcome). */
export const PAYSLIP_FAILURE_MESSAGES: Record<string, string> = {
  password_required: 'This payslip is password-protected. Enter the password to continue.',
  password_invalid: 'The password provided could not open this payslip.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  ocr_required: "We couldn't read text from this payslip. Scanned payslip OCR is not yet supported.",
  page_limit_exceeded: 'This document has too many pages to process as a single payslip.',
  document_type_not_identified: "This doesn't look like a payslip we can read yet. Please check the file, or add this income manually.",
  layout_unsupported: "We couldn't recognise the layout of this payslip. Please check the file, or add this income manually.",
  internal_error: 'Something went wrong while processing this payslip.',
  // UPL-01 (WP-08 maps a timed-out PDF read to this code; WP-09 gives the
  // payslip panel its words).
  extraction_timeout: 'Reading this payslip took too long, so we stopped. Please try again, or add this income manually.',
};

export interface ProcessPayslipResult {
  document: FdhStatementUpload;
  payrollEventId: string | null;
  pipelineStatus: 'ok' | PayslipExtractionFailureKind | 'pdf_extraction_failed' | 'idempotent_existing' | 'duplicate_payslip' | 'ai_fallback_available';
  /** Populated only when `pipelineStatus === 'ai_fallback_available'`. A
   * DRAFT the AI read off the payslip — nothing has been written to
   * `fdh_payroll_events` yet. The document itself deliberately stays in
   * `processing` (native success's own pre-write state) rather than
   * advancing, so `confirmAiPayslipFallback`'s own
   * `assertDocumentTransition('processing', 'extracted')` — the SAME edge a
   * native success uses — stays legal. The caller (the API route) shows this
   * to the user for explicit review/correction before
   * `confirmAiPayslipFallback` ever writes it (PO requirement: "try AI, then
   * ask you to review" — never a silent auto-write of an AI guess).
   */
  aiFallbackDraft?: PayrollExtraction;
}

/** Failure kinds this adapter will attempt an AI-fallback extraction for.
 * Deliberately narrow (mirrors Investment Intelligence's own two trigger
 * reasons, `documentAiFallbackTriggerReason()` in
 * `aiFallbackDocumentExtraction.ts`): only kinds where the document is
 * genuinely readable text and genuinely looks like it is TRYING to be a
 * payslip, but the deterministic, layout-specific parser could not read it.
 * Excluded on purpose: `password_required`/`wrong_password`/`corrupt`/
 * `page_limit_exceeded` (no text was even extracted — AI cannot help),
 * `scanned_document`/`ocr_required` (same reason), and `not_a_payslip` (the
 * parser's own judgement that this document is not a payslip at all — AI
 * fallback exists to read a payslip the native parser cannot, not to
 * classify an unrelated document as one). */
const AI_FALLBACK_ELIGIBLE_FAILURE_KINDS: readonly PayslipExtractionFailureKind[] = ['layout_unsupported', 'country_not_identified'];

/** Removes any row a PRIOR failed attempt for this document produced, so a
 * retry is safe (identical discipline to the bank-PDF path's own
 * `cleanupPriorAttempt`). */
async function cleanupPriorAttempt(userId: string, documentId: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from('fdh_payroll_events').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
}

async function findExistingPayrollEvent(userId: string, documentId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select('id')
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Load candidate bank deposits for salary matching (spec sections 20-22,
 * 34). NO bank parsing happens here — only a read of the already-certified
 * `fdh_transactions` register within a generous window around the payslip's
 * payment date, so `matchSalaryDeposit()` (which itself enforces
 * MATCH_THRESHOLD = 0.65) has real candidates to score.
 */
async function loadBankCandidates(userId: string, paymentDate: string | undefined): Promise<BankCandidate[]> {
  if (!paymentDate) return [];
  const supabase = await createClient();
  const from = new Date(paymentDate);
  from.setDate(from.getDate() - 7);
  const to = new Date(paymentDate);
  to.setDate(to.getDate() + 7);
  const { data } = await supabase
    .from('fdh_transactions')
    .select(
      'id, transaction_date, amount_original, currency_original, credit_debit, description_clean, description_raw, merchant_raw, economic_transaction_type, transaction_type_hint, financial_account_id',
    )
    .eq('user_id', userId)
    .eq('credit_debit', 'credit')
    // WP-09 (GAP-10): only APPROVED bank lines are evidence. An unapproved
    // line may still be reclassified, split or removed as a duplicate, so it
    // is never stamped as the payslip's deposit; it is matched later, when its
    // statement is approved (lib/import-bridge/payslipBankRematch.ts).
    .eq('approval_status', 'approved')
    .gte('transaction_date', from.toISOString().slice(0, 10))
    .lte('transaction_date', to.toISOString().slice(0, 10))
    .limit(100);
  return excludeClaimedCandidates(userId, (data ?? []) as BankCandidate[]);
}

/**
 * Drops deposits another payroll event already corroborates. One deposit is
 * evidence for at most one pay run (0091's unique index); without this a
 * REVISED payslip with the same net found its predecessor's deposit, hit that
 * unique index on insert, and the 23505 was mistaken for "identical payslip".
 */
export async function excludeClaimedCandidates(userId: string, candidates: BankCandidate[]): Promise<BankCandidate[]> {
  if (candidates.length === 0) return candidates;
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select('bank_match_transaction_id')
    .eq('user_id', userId)
    .in('bank_match_transaction_id', candidates.map((c) => c.id));
  const claimed = new Set(((data ?? []) as Array<{ bank_match_transaction_id: string | null }>).map((r) => r.bank_match_transaction_id));
  return candidates.filter((c) => !claimed.has(c.id));
}

export async function processPayslipDocument(userId: string, documentId: string, password?: string): Promise<ProcessPayslipResult> {
  const document = await getOwnedDocument(userId, documentId);

  if (document.document_type !== 'payslip') {
    throw new PayslipProcessingError('wrong_document_type', 'This document was not uploaded as a payslip.');
  }

  // IDEMPOTENCY (spec 89-90 discipline, same as bank-PDF): a payroll event
  // already exists for this document — return it rather than reprocessing.
  const existingEventId = await findExistingPayrollEvent(userId, documentId);
  if (existingEventId && ['extracted', 'review_required', 'ready_for_approval', 'approved'].includes(document.processing_status)) {
    return { document, payrollEventId: existingEventId, pipelineStatus: 'idempotent_existing' };
  }

  if (!['queued', 'failed'].includes(document.processing_status)) {
    throw new PayslipProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  // AIE-1 final completion (2026-09-25): `failed` is retryable, but never for a
  // file the malware gate blocked or never scanned. See
  // `checkFdhDocumentMalwareAdmission`'s header for the defect this closes.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new PayslipProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }

  // Byte-identical re-upload (2026-09-25): the same user already turned these
  // exact bytes into a payroll event, so parsing again -- and especially
  // paying for a second AI read -- can only reach the same duplicate. Found in
  // production when a re-upload of an AI-read payslip paid for a second
  // OpenAI call and then dead-ended. Short-circuit to the existing event.
  const identical = await findEarlierIdenticalPayslip(userId, documentId);
  if (identical) {
    if (document.processing_status === 'failed') {
      await cleanupPriorAttempt(userId, documentId);
      await adminUpdateStatementUpload(userId, documentId, { processing_status: 'queued', error_code: null });
    }
    assertDocumentTransition('queued', 'processing');
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'processing', processing_started_at: new Date().toISOString() });
    assertDocumentTransition('processing', 'extracted');
    const finalDoc = await adminUpdateStatementUpload(userId, documentId, { processing_status: 'extracted', error_code: null });
    return { document: (finalDoc ?? document) as FdhStatementUpload, payrollEventId: identical.payrollEventId, pipelineStatus: 'duplicate_payslip' };
  }

  // --- M12C §10 (`M2-OPEN-8`) — password brute-force limiter ----------------
  //
  // This endpoint accepted `password` (route schema `z.string().max(200)
  // .optional()`) and handed it straight to `extractPdfPages` with no counting
  // of any kind, while its sibling bank-PDF service — the same pipeline, the
  // same extractor — has been rate-limited since FDH-5. Closed here with the
  // SAME shared decision function and the SAME certified threshold; no second
  // counter and no second policy is introduced.
  //
  // One deliberate difference from the bank-PDF call site, and it is stricter,
  // not looser: that one gates on `document.error_code === 'password_required'`,
  // so a guess made against a document not yet flagged is uncounted. This gates
  // on a password actually having been SUPPLIED, which counts every guess.
  // Behaviour for a call with no password is unchanged in every respect.
  if (typeof password === 'string' && password.length > 0) {
    const { data: allEvents } = await documentAuditEventsRepository.listForUser(userId, 500);
    const recentForDoc = (allEvents ?? []).filter((e) => e.document_id === documentId);
    const rateLimit = checkPasswordAttemptRateLimit({ recentAuditEvents: recentForDoc, nowIso: new Date().toISOString() });
    if (!rateLimit.allowed) {
      throw new PayslipProcessingError('rate_limited', 'Too many password attempts for this document recently. Please try again later.');
    }
    // RECORDED BEFORE DECRYPTION, deliberately: an attempt that crashes, times
    // out or is abandoned mid-flight must still count, or a caller could obtain
    // unlimited free guesses by aborting each request. The event records only
    // that an attempt happened — never the value attempted.
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_password_required', actorType: 'system' });
  }

  if (document.processing_status === 'failed') {
    await cleanupPriorAttempt(userId, documentId);
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'queued', error_code: null });
  }

  assertDocumentTransition('queued', 'processing');
  await adminUpdateStatementUpload(userId, documentId, {
    processing_status: 'processing',
    processing_started_at: new Date().toISOString(),
  });
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_native_extraction_started', actorType: 'system' });

  try {
    if (!document.raw_document_storage_reference) throw new Error('missing storage reference');
    const download = await downloadDocumentObject(document.raw_document_storage_reference);
    if (!download.ok) throw new Error(download.message);

    const extraction = await extractPdfPages(download.bytes, password);
    if (!extraction.ok) {
      const errorCode = errorCodeForPdfExtractionFailure(extraction.kind);
      // Password states are a missing credential for THIS attempt, not a
      // document defect — recoverable via `failed -> queued -> processing`
      // on the next call, mirroring the bank-PDF path's own discipline
      // (see this file's header comment for why `processing -> failed`,
      // not `processing -> queued`, is the legal edge used here).
      assertDocumentTransition('processing', 'failed');
      const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'failed',
        error_code: errorCode,
        review_status: 'pending',
      });
      await recordDocumentAuditEvent({
        userId,
        documentId,
        eventType: 'payslip_extraction_failed',
        actorType: 'system',
        metadata: { reason: extraction.kind },
      });
      return { document: (finalDoc ?? document) as FdhStatementUpload, payrollEventId: null, pipelineStatus: 'pdf_extraction_failed' };
    }

    const text = extraction.pages.join('\n');
    const declaredCountry = document.country_code === 'AU' || document.country_code === 'IN' ? document.country_code : undefined;
    const rawParsed = parsePayslipText(text, { declaredCountry });
    // AIE-1 final completion (2026-09-25). DEFECT: `parsePayslipText` can only
    // fail with `not_a_payslip` or `country_not_identified`, and the second is
    // impossible here because the upload always declares AU/IN. So a payslip
    // the parser could not read AT ALL came back as a "successful" extraction
    // with neither gross nor net pay, was persisted as empty payroll evidence,
    // and the AI fallback (eligible only for `layout_unsupported` /
    // `country_not_identified`) could never run -- confirmed by probe. An
    // extraction with no gross AND no net is now what it is: an unsupported
    // layout. A partial read (gross or net present) is unchanged.
    const parsed: typeof rawParsed | { error: 'layout_unsupported' } =
      !('error' in rawParsed) && rawParsed.grossPay === undefined && rawParsed.netPay === undefined
        ? { error: 'layout_unsupported' }
        : rawParsed;

    if ('error' in parsed) {
      if (AI_FALLBACK_ELIGIBLE_FAILURE_KINDS.includes(parsed.error)) {
        const fallback = await attemptAiPayslipFallback(userId, documentId, text, declaredCountry ?? 'AU');
        if (fallback.ok) {
          // Deliberately NO document status change here (see
          // `ProcessPayslipResult.aiFallbackDraft`'s own doc comment) — the
          // document stays `processing` until the user explicitly reviews
          // and confirms via `confirmAiPayslipFallback`.
          return { document, payrollEventId: null, pipelineStatus: 'ai_fallback_available', aiFallbackDraft: fallback.extraction };
        }
        await recordDocumentAuditEvent({
          userId,
          documentId,
          eventType: 'payslip_ai_fallback_not_usable',
          actorType: 'system',
          metadata: { reason: fallback.reason, nativeFailureKind: parsed.error },
        });
      }

      const errorCode = errorCodeForPayslipParseFailure(parsed.error);
      assertDocumentTransition('processing', 'failed');
      const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'failed',
        error_code: errorCode,
        review_status: 'pending',
      });
      await recordDocumentAuditEvent({
        userId,
        documentId,
        eventType: 'payslip_extraction_failed',
        actorType: 'system',
        metadata: { reason: parsed.error },
      });
      return { document: (finalDoc ?? document) as FdhStatementUpload, payrollEventId: null, pipelineStatus: parsed.error };
    }

    const result = await persistPayrollEvidence(userId, documentId, document, parsed);
    return result;
  } catch (e) {
    if (e instanceof PayslipProcessingError) throw e;
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'failed', error_code: 'internal_error' });
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'payslip_extraction_failed',
      actorType: 'system',
      metadata: { reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' },
    });
    throw new PayslipProcessingError('internal_error', e instanceof Error ? e.message : 'processing failed');
  }
}

/**
 * AIE-1 final completion (2026-09-25): the reviewable projection of an
 * AI-fallback draft -- exactly the keys the confirm route accepts
 * (`ai-fallback/confirm/route.ts`'s strict body schema). Internal extraction
 * fields (components, parser identity, warnings, confidence) never leave the
 * server, and a draft posted back verbatim by the review UI is always valid.
 */
export const PAYSLIP_AI_DRAFT_REVIEW_KEYS = [
  'country', 'currencyCode', 'employerName', 'payPeriodStart', 'payPeriodEnd', 'paymentDate', 'payFrequency',
  'grossPay', 'basePay', 'overtimePay', 'bonusPay', 'commissionPay', 'allowancesTotal', 'reimbursementsTotal',
  'otherEarnings', 'taxWithheld', 'employeeDeductionsTotal', 'salarySacrifice', 'professionalTax',
  'employerRetirementContribution', 'employeeRetirementContribution', 'employerNpsContribution',
  'employeeNpsContribution', 'netPay',
] as const;

export function toPayslipAiDraftForReview(extraction: PayrollExtraction): Record<string, unknown> {
  const source = extraction as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PAYSLIP_AI_DRAFT_REVIEW_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Identifiers and counts only (auditLog.ts's own metadata rule). */
function aiEvidenceMetadata(evidence: { idempotencyKey: string; providerRequestIds: string[]; inputTokens?: number; outputTokens?: number; model: string; failureCode?: string } | undefined): Record<string, unknown> {
  if (!evidence) return {};
  return {
    ai_model: evidence.model,
    ai_cost_key: evidence.idempotencyKey,
    ai_provider_request_ids: evidence.providerRequestIds.slice(0, 5),
    ai_input_tokens: evidence.inputTokens ?? null,
    ai_output_tokens: evidence.outputTokens ?? null,
    // Only when the provider call threw: its category code (never a message).
    ...(evidence.failureCode ? { ai_failure_code: evidence.failureCode } : {}),
  };
}

export type AiPayslipFallbackOutcome = { ok: true; extraction: PayrollExtraction } | { ok: false; reason: string };

/**
 * The one call site that reaches the AI provider for a payslip. Gated, in
 * order: this adapter's own kill switch, the SAME global AIE kill switch
 * every AI call in this codebase shares, and the SAME shared AIE-1
 * pilot-cohort allowlist every AIE-gated feature shares (never a cloned
 * adapter-local allowlist — see `lib/aie/adapters/payslip/featureFlags.ts`'s
 * header for why). Masks the already-locally-extracted text before it ever
 * leaves this process, exactly like `lib/aie/orchestrator.ts`'s own masking
 * step, including the SAME open item that step discloses (`labelsSeenRaw: []`
 * — see `orchestrator.ts`'s own comment on `isBelowMaskingPolicy`).
 *
 * Exported (not just called internally) so it is independently unit-testable
 * with a fake `requestPayslipAiExtraction` and so a future FDH-3 document
 * type's own processing service can call the identical shape for its own
 * fields, per this design's "any new document type" requirement.
 */
export async function attemptAiPayslipFallback(
  userId: string,
  documentId: string,
  extractedText: string,
  country: 'AU' | 'IN',
): Promise<AiPayslipFallbackOutcome> {
  if (!isAiePayslipAiFallbackEnabled()) return { ok: false, reason: 'adapter_disabled' };
  if (!isAieAiFallbackEnabled()) return { ok: false, reason: 'global_kill_switch_disabled' };
  // AIE-1 final completion (2026-09-25): email resolved so an email-only
  // allowlist (production's configuration) can admit; see pilotCohortEmail.ts.
  if (!isUserInAiePilotCohort({ userId, email: await resolveEmailForAiePilotCohort(userId) })) return { ok: false, reason: 'cohort_denied' };

  let masking: ReturnType<typeof maskText>;
  try {
    masking = maskText(extractedText, { tenantKey: userId });
  } catch {
    return { ok: false, reason: 'masking_unavailable' };
  }
  if (isBelowMaskingPolicy({ maskedText: masking.maskedText, labelsSeenRaw: [] })) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'payslip_ai_fallback_masking_below_policy', actorType: 'system' });
    return { ok: false, reason: 'masking_below_policy' };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'payslip_ai_fallback_attempted', actorType: 'system' });
  const result = await requestPayslipAiExtraction({ maskedText: masking.maskedText, requestId: documentId });
  if (result.outcome !== 'success') {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'payslip_ai_fallback_provider_outcome', actorType: 'system', metadata: { outcome: result.outcome, ...aiEvidenceMetadata(result.evidence) } });
    return { ok: false, reason: result.outcome };
  }

  const currencyCode = country === 'IN' ? 'INR' : 'AUD';
  const extraction = mapPayslipFactsToExtraction(result.facts, { country, currencyCode });
  if (!extraction) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'payslip_ai_fallback_insufficient_fields', actorType: 'system' });
    return { ok: false, reason: 'insufficient_fields' };
  }

  // AIE-1 final completion (2026-09-25): the validated draft is persisted
  // BEFORE the user sees it (migration 0197), so review/confirmation never
  // depends on the PDF still existing and a confirmation is only accepted
  // against a draft the server actually issued. Without 0197 applied the
  // pre-existing behaviour (draft in the response only) is kept.
  const saved = await saveAiFallbackDraft({
    userId,
    documentId,
    documentType: 'payslip',
    schemaName: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION,
    payload: extraction,
    providerIdempotencyKey: result.evidence?.idempotencyKey ?? null,
  });
  if (!saved.persisted && saved.reason === 'write_failed') {
    console.error(`payslip AI draft for ${documentId} could not be persisted: ${saved.detail ?? 'unknown'}`);
    return { ok: false, reason: 'draft_not_persisted' };
  }

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'payslip_ai_fallback_draft_ready',
    actorType: 'system',
    metadata: { ...aiEvidenceMetadata(result.evidence), draft_persisted: saved.persisted },
  });
  return { ok: true, extraction };
}

/**
 * Called only after the user has reviewed the draft `attemptAiPayslipFallback`
 * produced (and may have corrected it — the same trust model as a manual
 * Income entry, which this codebase already permits unrestricted for the
 * user's own data). Performs NO new AI call and re-derives nothing from
 * document text; it validates the submitted extraction is shaped correctly
 * and delegates the actual write to `persistPayrollEvidence` — the EXACT
 * same function, same bank-matching, same fingerprint/dedupe, same
 * `processing -> extracted` transition, a native successful parse uses. This
 * is what makes an AI-fallback-produced payroll event indistinguishable from
 * a natively-parsed one to every downstream review/approve/apply step.
 *
 * Refuses (rather than silently reprocessing) unless the document is still
 * sitting in `processing` — the state `attemptAiPayslipFallback` deliberately
 * left it in — so a stale/replayed confirm on an already-decided document
 * (already failed, already extracted, already re-uploaded) is rejected
 * instead of double-writing.
 */
export async function confirmAiPayslipFallback(userId: string, documentId: string, extraction: PayrollExtraction): Promise<ProcessPayslipResult> {
  const document = await getOwnedDocument(userId, documentId);
  if (document.document_type !== 'payslip') {
    throw new PayslipProcessingError('wrong_document_type', 'This document was not uploaded as a payslip.');
  }
  if (document.processing_status !== 'processing') {
    throw new PayslipProcessingError('invalid_state', 'This payslip has no AI-extracted draft awaiting confirmation.');
  }

  // AIE-1 final completion (2026-09-25): claim the durable draft the server
  // issued (migration 0197). One conditional update: a replayed or concurrent
  // confirmation finds nothing pending and writes nothing. If 0197 is not
  // applied, the pre-existing `processing`-status gate above is the guard.
  const claim = await claimPendingAiFallbackDraft({ userId, documentId, confirmedPayload: extraction });
  if (!claim.claimed && claim.reason !== 'table_missing') {
    throw new PayslipProcessingError('invalid_state', 'This payslip has no AI-extracted draft awaiting confirmation.');
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'payslip_ai_fallback_confirmed', actorType: 'user' });
  try {
    return await persistPayrollEvidence(userId, documentId, document, extraction);
  } catch (e) {
    if (claim.claimed) await releaseClaimedAiFallbackDraftIfNothingWritten(userId, claim.draftId, documentId);
    throw e;
  }
}

export async function persistPayrollEvidence(
  userId: string,
  documentId: string,
  document: FdhStatementUpload,
  extraction: PayrollExtraction,
): Promise<ProcessPayslipResult> {
  const supabase = await createClient();

  const reconciliation = reconcileGrossToNet(extraction);
  const fingerprint = payslipFingerprint(extraction);
  const confidence = scoreExtractionConfidence(extraction);

  // Bank corroboration (spec sections 20-22, 34-35). ONE economic event: this
  // never creates a second amount, it only stamps which existing
  // `fdh_transactions` row (if any) corroborates the payroll event about to
  // be inserted.
  let bankMatchStatus: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted' = 'not_attempted';
  let bankMatchTransactionId: string | null = null;
  let bankMatchConfidence: number | null = null;
  if (extraction.netPay !== undefined) {
    const candidates = await loadBankCandidates(userId, extraction.paymentDate);
    const match = matchSalaryDeposit({
      netPay: extraction.netPay,
      currencyCode: extraction.currencyCode,
      paymentDate: extraction.paymentDate,
      employerName: extraction.employerName,
      candidates,
    });
    bankMatchStatus = match.status;
    bankMatchTransactionId = match.transactionId;
    bankMatchConfidence = match.confidence;
  }

  const employerNormalised = normaliseEmployerName(extraction.employerName) ?? null;

  const insertRow = {
    user_id: userId,
    household_id: document.household_id ?? null,
    statement_upload_id: documentId,
    employer_name: extraction.employerName ?? null,
    employer_normalised: employerNormalised,
    country_code: extraction.country,
    currency_code: extraction.currencyCode,
    pay_period_start: extraction.payPeriodStart ?? null,
    pay_period_end: extraction.payPeriodEnd ?? null,
    payment_date: extraction.paymentDate ?? null,
    pay_frequency: extraction.payFrequency,
    pay_frequency_source: extraction.payFrequencySource,
    gross_pay: extraction.grossPay ?? null,
    // Migration 0185. A gross this parser worked out from the payslip's own
    // component lines must never be indistinguishable from one the employer
    // printed — see the parser's own `deriveGrossFromComponents`.
    gross_pay_source: extraction.grossPaySource ?? null,
    base_pay: extraction.basePay ?? null,
    overtime_pay: extraction.overtimePay ?? null,
    bonus_pay: extraction.bonusPay ?? null,
    commission_pay: extraction.commissionPay ?? null,
    allowances_total: extraction.allowancesTotal ?? null,
    reimbursements_total: extraction.reimbursementsTotal ?? null,
    other_earnings: extraction.otherEarnings ?? null,
    tax_withheld: extraction.taxWithheld ?? null,
    employee_deductions_total: extraction.employeeDeductionsTotal ?? null,
    salary_sacrifice: extraction.salarySacrifice ?? null,
    professional_tax: extraction.professionalTax ?? null,
    employer_retirement_contribution: extraction.employerRetirementContribution ?? null,
    employee_retirement_contribution: extraction.employeeRetirementContribution ?? null,
    employer_nps_contribution: extraction.employerNpsContribution ?? null,
    employee_nps_contribution: extraction.employeeNpsContribution ?? null,
    net_pay: extraction.netPay ?? null,
    ytd_gross: extraction.ytdGross ?? null,
    ytd_tax: extraction.ytdTax ?? null,
    ytd_net: extraction.ytdNet ?? null,
    ytd_employer_retirement: extraction.ytdEmployerRetirement ?? null,
    ytd_employee_retirement: extraction.ytdEmployeeRetirement ?? null,
    parser_name: extraction.parserName ?? PAYSLIP_PARSER_NAME,
    parser_version: extraction.parserVersion ?? PAYSLIP_PARSER_VERSION,
    extraction_confidence: confidence,
    reconciliation_status: reconciliation.status,
    reconciliation_variance: reconciliation.variance,
    bank_match_status: bankMatchStatus,
    bank_match_transaction_id: bankMatchTransactionId,
    bank_match_confidence: bankMatchConfidence,
    // 2026-09-24: layout uncertainty now forces review too. The three
    // warnings below mean "this parser could not be sure which column it was
    // reading", which is exactly the condition that let a year-to-date total
    // reach `base_pay` in production. Strengthening, never loosening — the
    // two original triggers are unchanged.
    review_status:
      bankMatchStatus === 'multiple_candidates'
      || reconciliation.status === 'variance'
      || extraction.warnings.includes('column_mapping_ambiguous')
      || extraction.warnings.includes('column_orientation_corrected')
      || extraction.warnings.includes('column_orientation_unresolved')
        ? 'pending'
        : 'not_required',
    payslip_fingerprint: fingerprint,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('fdh_payroll_events')
    .insert(insertRow)
    .select('id')
    .single();

  if (insertError) {
    // Duplicate payslip (spec section 57): the SAME content uploaded twice
    // hits the unique (user_id, payslip_fingerprint) index. This is a
    // correct, controlled outcome — not a processing failure — and the
    // existing payroll event from the first upload is returned unchanged, so
    // no second payroll event, no second proposal, no second Income change
    // can ever result from re-uploading an identical payslip.
    if (insertError.code === '23505') {
      const { data: dupe } = await supabase
        .from('fdh_payroll_events')
        .select('id')
        .eq('user_id', userId)
        .eq('payslip_fingerprint', fingerprint)
        .maybeSingle();
      assertDocumentTransition('processing', 'extracted');
      const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'extracted',
        error_code: null,
      });
      return {
        document: (finalDoc ?? document) as FdhStatementUpload,
        payrollEventId: (dupe as { id: string } | null)?.id ?? null,
        pipelineStatus: 'duplicate_payslip',
      };
    }
    throw new Error(insertError.message);
  }

  const payrollEventId = (inserted as { id: string }).id;

  if (extraction.components.length > 0) {
    const { error: componentError } = await supabase.from('fdh_payroll_components').insert(
      extraction.components.map((c) => ({
        user_id: userId,
        payroll_event_id: payrollEventId,
        component_side: c.side,
        component_type: c.type,
        label_raw: c.labelRaw,
        amount: c.amount,
        is_year_to_date: c.isYearToDate,
      })),
    );
    if (componentError) throw new Error(componentError.message);
  }

  assertDocumentTransition('processing', 'extracted');
  const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
    processing_status: 'extracted',
    error_code: null,
    processing_completed_at: new Date().toISOString(),
  });

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'payslip_extraction_completed',
    actorType: 'system',
    metadata: {
      reconciliation_status: reconciliation.status,
      bank_match_status: bankMatchStatus,
      extraction_confidence: confidence,
    },
  });

  return { document: (finalDoc ?? document) as FdhStatementUpload, payrollEventId, pipelineStatus: 'ok' };
}

// ---------------------------------------------------------------------------
// User correction of extracted payroll figures (2026-09-24)
// ---------------------------------------------------------------------------

/**
 * The money/date fields a user may correct on an extracted payroll event.
 *
 * Deliberately the EXACT key set `fdh9_correct_payroll_event` (migration
 * 0185) accepts — one closed vocabulary, declared once, so a field can never
 * be accepted by the route and then silently rejected by the database, or
 * vice versa.
 */
export const PAYROLL_CORRECTABLE_TEXT_FIELDS = ['employer_name'] as const;
export const PAYROLL_CORRECTABLE_DATE_FIELDS = ['pay_period_start', 'pay_period_end', 'payment_date'] as const;
export const PAYROLL_CORRECTABLE_MONEY_FIELDS = [
  'gross_pay', 'base_pay', 'overtime_pay', 'bonus_pay', 'commission_pay',
  'allowances_total', 'reimbursements_total', 'other_earnings',
  'tax_withheld', 'employee_deductions_total', 'salary_sacrifice', 'professional_tax',
  'employer_retirement_contribution', 'employee_retirement_contribution',
  'employer_nps_contribution', 'employee_nps_contribution', 'net_pay',
] as const;

export type PayrollCorrectableField =
  | (typeof PAYROLL_CORRECTABLE_TEXT_FIELDS)[number]
  | (typeof PAYROLL_CORRECTABLE_DATE_FIELDS)[number]
  | (typeof PAYROLL_CORRECTABLE_MONEY_FIELDS)[number]
  | 'pay_frequency';

export type PayrollCorrections = Partial<Record<PayrollCorrectableField, string | number | null>>;

export interface CorrectPayrollEventResult {
  payrollEventId: string;
  correctedFields: string[];
  reconciliationStatus: PayrollReconciliationStatus;
  reconciliationVariance: number | null;
  reconciliationRestamped: boolean;
}

/**
 * Apply a user's corrections to an already-extracted payroll event.
 *
 * WHY THIS IS NOT A DIRECT UPDATE. Migration 0091's D.4 trigger makes every
 * money/period/reconciliation column on `fdh_payroll_events` authoritative:
 * the authenticated role may write `employer_name` and nothing else. Its own
 * comment says any correction UI must add a narrowly-scoped RPC rather than
 * widen that allowance, and `fdh9_correct_payroll_event` (migration 0185) is
 * that RPC. This function does the two things that must NOT live in PL/pgSQL
 * — validation against the closed field vocabulary, and recomputing the
 * gross-to-net identity with the SAME certified `reconcileGrossToNet` an
 * extraction uses — and then delegates the write.
 *
 * WHY RECONCILIATION IS RECOMPUTED FROM HEADER TOTALS. The stored components
 * are the LINES THE DOCUMENT PRINTED; a correction changes the summary
 * figures, not the document. Re-running the component identity would
 * therefore answer a question the user did not ask and return the
 * pre-correction result. The corrected figures are instead checked with the
 * function's own header-total identity (its step 2), which — exactly as
 * before — returns INSUFFICIENT_DATA rather than a guess when the deduction
 * side is ambiguous. The variance safety net is re-stamped, never dropped:
 * a correction that still does not add up stays a `variance`.
 */
export async function correctPayrollEvent(
  userId: string,
  documentId: string,
  corrections: PayrollCorrections,
): Promise<CorrectPayrollEventResult> {
  const document = await getOwnedDocument(userId, documentId);
  if (document.document_type !== 'payslip') {
    throw new PayslipProcessingError('wrong_document_type', 'This document was not uploaded as a payslip.');
  }

  const payrollEventId = await getPayrollEventIdForDocument(userId, documentId);
  if (!payrollEventId) {
    throw new PayslipProcessingError('not_found', 'No payroll evidence has been extracted from this document yet.');
  }

  const review = await getPayrollEventForReview(userId, payrollEventId);
  if (!review) throw new PayslipProcessingError('not_found', 'Payroll event not found.');
  const current = review.event as Record<string, unknown>;

  if (current.approval_status === 'approved') {
    throw new PayslipProcessingError(
      'invalid_state',
      'This payroll evidence has already been approved and can no longer be corrected.',
    );
  }

  const keys = Object.keys(corrections) as PayrollCorrectableField[];
  if (keys.length === 0) {
    throw new PayslipProcessingError('invalid_state', 'No corrections were supplied.');
  }

  // The post-correction value of every field the identity needs, taking the
  // correction where one was supplied and the stored value where one was not.
  const after = (field: string): number | undefined => {
    const supplied = (corrections as Record<string, string | number | null | undefined>)[field];
    if (field in corrections) return supplied === null || supplied === undefined ? undefined : Number(supplied);
    const stored = current[field];
    return stored === null || stored === undefined ? undefined : Number(stored);
  };

  const moneyChanged = keys.some((k) => (PAYROLL_CORRECTABLE_MONEY_FIELDS as readonly string[]).includes(k));

  // `components: []` is deliberate, not an oversight — see this function's
  // own doc comment. It forces `reconcileGrossToNet` down its header-total
  // identity, which is the one the corrected figures actually belong to.
  const recomputed = reconcileGrossToNet({
    country: (current.country_code as PayrollCountry) ?? 'AU',
    currencyCode: (current.currency_code as string) ?? 'AUD',
    payFrequency: 'unknown',
    payFrequencySource: 'unknown',
    grossPay: after('gross_pay'),
    netPay: after('net_pay'),
    taxWithheld: after('tax_withheld'),
    employeeDeductionsTotal: after('employee_deductions_total'),
    salarySacrifice: after('salary_sacrifice'),
    professionalTax: after('professional_tax'),
    employeeRetirementContribution: after('employee_retirement_contribution'),
    employeeNpsContribution: after('employee_nps_contribution'),
    reimbursementsTotal: after('reimbursements_total'),
    components: [],
    parserName: (current.parser_name as string) ?? PAYSLIP_PARSER_NAME,
    parserVersion: (current.parser_version as string) ?? PAYSLIP_PARSER_VERSION,
    extractionConfidence: 0,
    warnings: [],
  });

  const employerNormalised =
    'employer_name' in corrections
      ? normaliseEmployerName(corrections.employer_name == null ? undefined : String(corrections.employer_name)) ?? null
      : null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh9_correct_payroll_event', {
    p_payroll_event_id: payrollEventId,
    p_corrections: corrections,
    p_employer_normalised: employerNormalised,
    p_reconciliation_status: recomputed.status,
    p_reconciliation_variance: recomputed.variance,
  });
  if (error) throw new Error(error.message);

  const result = data as { ok: boolean; code?: string; error?: string; corrected_fields?: string[]; reconciliation_restamped?: boolean } | null;
  if (!result?.ok) {
    const code = result?.code;
    throw new PayslipProcessingError(
      code === 'PAYROLL_EVENT_NOT_FOUND' ? 'not_found' : code === 'ALREADY_APPROVED' ? 'invalid_state' : 'invalid_state',
      result?.error ?? 'These corrections could not be saved.',
    );
  }

  // Attribution, on the SAME document audit trail every other payslip
  // lifecycle event uses. Field NAMES only — never the figures, which
  // `auditLog.ts`'s own rule keeps out of `metadata`.
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'payroll_event_corrected',
    actorType: 'user',
    actorId: userId,
    metadata: {
      payroll_event_id: payrollEventId,
      corrected_fields: result.corrected_fields ?? keys,
      reconciliation_status: recomputed.status,
      reconciliation_restamped: Boolean(result.reconciliation_restamped),
    },
  });

  return {
    payrollEventId,
    correctedFields: result.corrected_fields ?? (keys as string[]),
    reconciliationStatus: recomputed.status,
    reconciliationVariance: recomputed.variance,
    reconciliationRestamped: Boolean(result.reconciliation_restamped) || moneyChanged,
  };
}

/** Resolve the payroll event for a given uploaded document (1:1 in FDH-9
 * today — one payslip document produces at most one payroll event). Used by
 * every downstream route (review, approve, propose) that only knows the
 * document id from the URL. */
/**
 * The earlier payslip this upload is a byte-identical copy of, if the same
 * user already turned those exact bytes into a payroll event. Service-role
 * read, always scoped to `userId` (processing can run from the scan-sweep
 * cron with no user session). Oldest match wins, so every copy points at the
 * original rather than at another copy.
 */
export async function findEarlierIdenticalPayslip(
  userId: string,
  documentId: string,
): Promise<{ documentId: string; payrollEventId: string } | null> {
  // The shared rule (identicalUpload.ts), which every statement type now uses
  // too. Evidence only, exactly as the payslip fix shipped it.
  const match = await findEarlierIdenticalUpload(userId, documentId, { ...IDENTICAL_UPLOAD_SPECS.payslip, includePendingDrafts: false });
  return match?.kind === 'evidence' ? { documentId: match.documentId, payrollEventId: match.evidenceId } : null;
}

/** The upload a payroll event was extracted from (for pointing a duplicate at its original). */
export async function getDocumentIdForPayrollEvent(userId: string, payrollEventId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select('statement_upload_id')
    .eq('user_id', userId)
    .eq('id', payrollEventId)
    .maybeSingle();
  return (data as { statement_upload_id: string | null } | null)?.statement_upload_id ?? null;
}

export async function getPayrollEventIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select('id')
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Read-model for the review screen (spec section 32). Joins the payroll
 * event with its components — no write of any kind. */
export async function getPayrollEventForReview(userId: string, payrollEventId: string) {
  const supabase = await createClient();
  const { data: event, error } = await supabase
    .from('fdh_payroll_events')
    .select('*')
    .eq('id', payrollEventId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !event) return null;
  const { data: components } = await supabase
    .from('fdh_payroll_components')
    .select('*')
    .eq('payroll_event_id', payrollEventId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return { event, components: components ?? [] };
}

// ---------------------------------------------------------------------------
// Revised payslips (WP-09, GAP-15)
// ---------------------------------------------------------------------------

export interface RevisionPredecessor {
  payroll_event_id: string;
  statement_upload_id: string | null;
  employer_name: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  approval_status: string;
  currency_code: string;
}

interface RevisionRow extends RevisionPredecessor {
  id: string;
  employer_normalised: string | null;
  payslip_fingerprint: string | null;
  superseded_by_payroll_event_id: string | null;
  created_at: string;
}

/**
 * The earlier payslip this one REVISES, if any: same employer, same pay
 * period, same currency, different content (a different fingerprint -- the
 * same content is a duplicate, handled by the fingerprint index), and not
 * itself already replaced. The same rule `fdh9_supersede_payroll_event`
 * (0210) re-checks before it links anything, so a stale answer here can never
 * supersede the wrong payslip.
 */
export async function findRevisionPredecessor(userId: string, payrollEventId: string): Promise<RevisionPredecessor | null> {
  const supabase = await createClient();
  const cols = 'id, statement_upload_id, employer_name, employer_normalised, pay_period_start, pay_period_end, gross_pay, net_pay, approval_status, currency_code, payslip_fingerprint, superseded_by_payroll_event_id, created_at';
  const { data: current } = await supabase.from('fdh_payroll_events').select(cols).eq('user_id', userId).eq('id', payrollEventId).maybeSingle();
  const me = current as RevisionRow | null;
  if (!me || !me.employer_normalised || !me.pay_period_end || me.superseded_by_payroll_event_id) return null;
  const { data } = await supabase
    .from('fdh_payroll_events')
    .select(cols)
    .eq('user_id', userId)
    .eq('employer_normalised', me.employer_normalised)
    .eq('pay_period_end', me.pay_period_end)
    .is('superseded_by_payroll_event_id', null)
    .neq('id', me.id)
    .order('created_at', { ascending: false })
    .limit(10);
  const match = ((data ?? []) as RevisionRow[]).find((e) =>
    e.currency_code === me.currency_code
    && e.payslip_fingerprint !== me.payslip_fingerprint
    && (!e.pay_period_start || !me.pay_period_start || e.pay_period_start === me.pay_period_start)
    // Only an OLDER payslip can be revised by this one.
    && e.created_at <= me.created_at);
  if (!match) return null;
  return {
    payroll_event_id: match.id,
    statement_upload_id: match.statement_upload_id,
    employer_name: match.employer_name,
    pay_period_start: match.pay_period_start,
    pay_period_end: match.pay_period_end,
    gross_pay: match.gross_pay,
    net_pay: match.net_pay,
    approval_status: match.approval_status,
    currency_code: match.currency_code,
  };
}

export type SupersedeResult = { ok: true; bankMatchMoved: boolean } | { ok: false; code: string };

/** Links `supersededId` -> `supersedingId` through `fdh9_supersede_payroll_event` (0210). */
export async function supersedePayrollEvent(supersededId: string, supersedingId: string): Promise<SupersedeResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh9_supersede_payroll_event', {
    p_superseded_payroll_event_id: supersededId,
    p_superseding_payroll_event_id: supersedingId,
  });
  if (error) return { ok: false, code: error.code === 'PGRST202' ? 'MIGRATION_PENDING' : 'WRITE_FAILED' };
  const result = data as { ok: boolean; code?: string; bank_match_moved?: boolean } | null;
  if (!result?.ok) return { ok: false, code: result?.code ?? 'WRITE_FAILED' };
  return { ok: true, bankMatchMoved: Boolean(result.bank_match_moved) };
}
