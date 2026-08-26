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

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statementUploadsRepository } from '../repositories';
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
import type { PayrollExtraction, PayslipExtractionFailureKind } from '../payslip/types';
import type { FdhErrorCode } from '../constants/enums';

export class PayslipProcessingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state' | 'wrong_document_type' | 'internal_error',
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
};

export interface ProcessPayslipResult {
  document: FdhStatementUpload;
  payrollEventId: string | null;
  pipelineStatus: 'ok' | PayslipExtractionFailureKind | 'pdf_extraction_failed' | 'idempotent_existing' | 'duplicate_payslip';
}

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
    .gte('transaction_date', from.toISOString().slice(0, 10))
    .lte('transaction_date', to.toISOString().slice(0, 10))
    .limit(100);
  return (data ?? []) as BankCandidate[];
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
    const parsed = parsePayslipText(text, { declaredCountry });

    if ('error' in parsed) {
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

async function persistPayrollEvidence(
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
    review_status: bankMatchStatus === 'multiple_candidates' || reconciliation.status === 'variance' ? 'pending' : 'not_required',
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

/** Resolve the payroll event for a given uploaded document (1:1 in FDH-9
 * today — one payslip document produces at most one payroll event). Used by
 * every downstream route (review, approve, propose) that only knows the
 * document id from the URL. */
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
