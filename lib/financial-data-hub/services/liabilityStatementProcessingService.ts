/**
 * FDH-10 — Credit Cards & Loans Intelligence: statement upload + processing
 * orchestration (spec sections 15-20, 28, 36-43).
 *
 * REUSE, NOT DUPLICATION (spec section 6). Byte-safe intake is FDH-3's
 * `createUploadSession`/`completeUpload` (`uploadLifecycle.ts`), used
 * unchanged — the same plumbing every FDH document type uses. Detection and
 * column-mapped extraction are `statementIntake.ts` (spec section 28's
 * adapter contract, built on R7's own CSV safety/amount/date primitives).
 * Reconciliation is the already-certified `statementReconciliation.ts`. Bank
 * matching is the already-certified `bankMatching.ts`. No second copy of any
 * of these exists here — this file only wires them together and persists
 * the result.
 *
 * SINGLE-CALL UPLOAD+PROCESS (a deliberate, disclosed simplification vs.
 * FDH-9's two-step payslip flow). A CSV statement's bytes are already fully
 * in memory at the API boundary and extraction is synchronous (no PDF
 * password retry, no OCR wait) — so this mirrors R7's own `uploadBankCsv`
 * (one call: session create -> complete -> detect -> extract -> persist),
 * not the payslip PDF flow's separate upload-session/process split. Multiple
 * `fdh_document_audit_events` are still recorded distinctly
 * (`liability_statement_extraction_completed`/`_failed`), preserving an
 * auditable trail even though the API surface is one call.
 *
 * ONE STATEMENT EVIDENCE ROW, NOT TWO (spec sections 4, 35, 70). At most one
 * `fdh_liability_statements` row is created per uploaded document — a
 * failed/unrecognised upload creates none at all (spec section 21: no data
 * effect from a file that never became valid evidence).
 */

import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '../bank-csv/pagination';
import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { extractLiabilityStatement } from '../liability/statementIntake';
import { reconcileCreditCardStatement, reconcileLoanStatement } from '../liability/statementReconciliation';
import { matchBankPayment, type BankTransactionCandidate } from '../liability/bankMatching';
import type { LiabilityStatementActivity, LiabilityStatementCountry, LiabilityStatementType } from '../liability/types';
import type { FdhStatementUpload } from '../domain/types';

export class LiabilityStatementProcessingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state' | 'wrong_document_type' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'LiabilityStatementProcessingError';
  }
}

export interface UploadLiabilityStatementMetadata {
  statementType: LiabilityStatementType;
  countryCode: LiabilityStatementCountry;
  currencyCode: string;
  institutionName?: string;
  maskedIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  openingBalance?: number;
  closingBalance?: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
  originalFilenameSanitised?: string;
}

/** User-truthful copy for every controlled failure state (same discipline as
 * `PAYSLIP_FAILURE_MESSAGES`). */
export const LIABILITY_STATEMENT_FAILURE_MESSAGES: Record<string, string> = {
  manual_mapping_required: "We couldn't recognise the layout of this statement. Please check the file, or add this liability manually.",
  ambiguous_format: 'This statement matches more than one known layout. Please check the file, or add this liability manually.',
  layout_unsupported: "We couldn't read this file as a statement export. Please check the file, or add this liability manually.",
  scanned_document: "We couldn't read text from this file. Scanned statement OCR is not yet supported.",
  ocr_required: "We couldn't read text from this file. Scanned statement OCR is not yet supported.",
  unknown_error: 'Something went wrong while reading this statement.',
};

export interface UploadLiabilityStatementResult {
  document: FdhStatementUpload;
  statementId: string | null;
  pipelineStatus: 'ok' | 'extraction_failed' | 'duplicate_statement';
  failureKind?: string;
}

/** Same discipline as `loadBankCandidates` (payslip): a read of the
 * already-certified `fdh_transactions` register within a generous window
 * around the activity's date, so `matchBankPayment` has real candidates. */
async function loadBankCandidatesForPayment(
  userId: string,
  paymentDate: string,
  amount: string | number,
  institutionName: string | undefined,
): Promise<BankTransactionCandidate[]> {
  const supabase = await createClient();
  const from = new Date(paymentDate);
  from.setDate(from.getDate() - 7);
  const to = new Date(paymentDate);
  to.setDate(to.getDate() + 7);
  const { data } = await supabase
    .from('fdh_transactions')
    .select('id, transaction_date, amount_original, description_clean, description_raw, merchant_raw')
    .eq('user_id', userId)
    .eq('credit_debit', 'debit')
    .gte('transaction_date', from.toISOString().slice(0, 10))
    .lte('transaction_date', to.toISOString().slice(0, 10))
    .limit(100);

  const institution = institutionName?.trim().toLowerCase();
  return ((data ?? []) as Array<{ id: string; transaction_date: string; amount_original: number; description_clean: string | null; description_raw: string | null; merchant_raw: string | null }>).map((t) => {
    const narrative = `${t.description_clean ?? ''} ${t.description_raw ?? ''} ${t.merchant_raw ?? ''}`.toLowerCase();
    return {
      transactionId: t.id,
      amount: t.amount_original,
      transactionDate: t.transaction_date,
      // Conservative, narrative-substring heuristic (disclosed limitation —
      // see FDH10_BANK_MATCHING.md): the negative-control-tested MATCHING
      // RULES themselves live in `bankMatching.ts` and are proven pure;
      // this is only how real narrative text is turned into the two
      // boolean signals that feed them.
      institutionOrNarrativeMatches: Boolean(institution && narrative.includes(institution)),
      positivelyWrongFacility: false,
    };
  });
}

/**
 * Upload AND process a credit-card/loan CSV statement in one call (see this
 * file's header for why). Returns the persisted document plus, on success,
 * the new `fdh_liability_statements.id`.
 */
export async function uploadAndProcessLiabilityStatement(
  userId: string,
  metadata: UploadLiabilityStatementMetadata,
  bytes: Uint8Array,
): Promise<UploadLiabilityStatementResult> {
  const documentType = metadata.statementType === 'credit_card' ? 'credit_card_statement' : 'loan_statement';

  const { session } = await createUploadSession(userId, {
    source_type: 'csv',
    document_type: documentType,
    country_code: metadata.countryCode,
    currency_code: metadata.currencyCode as 'AUD' | 'INR' | 'USD',
    declared_mime_type: 'text/csv',
    declared_file_size_bytes: bytes.byteLength,
  });

  let document: FdhStatementUpload;
  try {
    document = await completeUpload(userId, session.id, bytes);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) throw new LiabilityStatementProcessingError('internal_error', e.message);
    throw e;
  }

  if (document.processing_status === 'failed' || document.processing_status === 'rejected') {
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: document.error_code ?? 'unknown_error' };
  }

  // Duplicate whole-document upload (spec section 70) — the same, already-
  // certified FDH-3 signal `uploadLifecycle.ts` itself computes. A
  // duplicate is a controlled outcome, not a processing failure: the
  // earlier statement's evidence (if it finished processing) is returned
  // unchanged, never re-extracted, never a second `fdh_liability_statements`
  // row.
  if (document.duplicate_of_document_id) {
    const existingStatementId = await getLiabilityStatementIdForDocument(userId, document.duplicate_of_document_id);
    if (existingStatementId) {
      return { document, statementId: existingStatementId, pipelineStatus: 'duplicate_statement' };
    }
  }

  if (!['queued', 'validating', 'uploaded'].includes(document.processing_status)) {
    throw new LiabilityStatementProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  const download = await downloadDocumentObject(document.raw_document_storage_reference!);
  if (!download.ok) throw new LiabilityStatementProcessingError('internal_error', download.message);

  assertDocumentTransition(document.processing_status, 'processing');

  const extraction = extractLiabilityStatement({
    bytes: download.bytes,
    statementType: metadata.statementType,
    country: metadata.countryCode,
    currencyCode: metadata.currencyCode,
    institutionName: metadata.institutionName,
    maskedIdentifier: metadata.maskedIdentifier,
    statementPeriodStart: metadata.statementPeriodStart,
    statementPeriodEnd: metadata.statementPeriodEnd,
    statementDate: metadata.statementDate,
    dueDate: metadata.dueDate,
    openingBalance: metadata.openingBalance,
    closingBalance: metadata.closingBalance,
    creditLimit: metadata.creditLimit,
    minimumPayment: metadata.minimumPayment,
    interestRate: metadata.interestRate,
  });

  if (!extraction.ok) {
    const supabase = await createClient();
    assertDocumentTransition('processing', 'failed');
    await supabase
      .from('fdh_statement_uploads')
      .update({ processing_status: 'failed', error_code: 'layout_unsupported', review_status: 'pending' })
      .eq('id', document.id)
      .eq('user_id', userId);
    await recordDocumentAuditEvent({
      userId,
      documentId: document.id,
      eventType: 'liability_statement_extraction_failed',
      actorType: 'system',
      metadata: { reason: extraction.kind },
    });
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: extraction.kind };
  }

  const statementId = await persistLiabilityStatementEvidence(userId, document, extraction.extraction.activities, metadata, extraction.extraction.warnings, extraction.extraction.parserName, extraction.extraction.parserVersion, extraction.extraction.extractionConfidence);

  return { document, statementId, pipelineStatus: 'ok' };
}

async function persistLiabilityStatementEvidence(
  userId: string,
  document: FdhStatementUpload,
  activities: readonly LiabilityStatementActivity[],
  metadata: UploadLiabilityStatementMetadata,
  warnings: string[],
  parserName: string,
  parserVersion: string,
  extractionConfidence: number,
): Promise<string> {
  const supabase = await createClient();
  const isCreditCard = metadata.statementType === 'credit_card';

  const sumOf = (type: string) => activities.filter((a) => a.activityType === type).reduce((s, a) => s + a.amount, 0) || null;
  const has = (type: string) => activities.some((a) => a.activityType === type);

  const purchasesTotal = has('PURCHASE') ? sumOf('PURCHASE') : null;
  const cashAdvancesTotal = has('CASH_ADVANCE') ? sumOf('CASH_ADVANCE') : null;
  const interestTotal = has('INTEREST') ? sumOf('INTEREST') : null;
  const feesTotal = has('FEE') ? sumOf('FEE') : null;
  const paymentsTotal = has('PAYMENT') ? sumOf('PAYMENT') : null;
  const refundsTotal = has('REFUND') ? sumOf('REFUND') : null;
  const drawdownsTotal = has('LOAN_ADVANCE') ? sumOf('LOAN_ADVANCE') : null;
  const principalRepaymentsTotal = activities.reduce((s, a) => s + (a.principalComponent ?? 0), 0) || null;

  const reconciliation = isCreditCard
    ? reconcileCreditCardStatement({
        openingBalance: metadata.openingBalance ?? null,
        purchasesTotal,
        cashAdvancesTotal,
        interestTotal,
        feesTotal,
        paymentsTotal,
        refundsTotal,
        adjustmentsTotal: null,
        closingBalance: metadata.closingBalance ?? null,
        currencyCode: metadata.currencyCode,
      })
    : reconcileLoanStatement({
        openingPrincipal: metadata.openingBalance ?? null,
        drawdownsTotal,
        capitalisedTotal: null,
        principalRepaymentsTotal,
        adjustmentsTotal: null,
        closingPrincipal: metadata.closingBalance ?? null,
        currencyCode: metadata.currencyCode,
      });

  const insertRow = {
    user_id: userId,
    statement_upload_id: document.id,
    statement_type: metadata.statementType,
    facility_type: isCreditCard ? 'credit_card' : 'personal_loan',
    country_code: metadata.countryCode,
    currency_code: metadata.currencyCode,
    institution_name: metadata.institutionName ?? null,
    masked_identifier: metadata.maskedIdentifier ?? null,
    statement_period_start: metadata.statementPeriodStart ?? null,
    statement_period_end: metadata.statementPeriodEnd ?? null,
    statement_date: metadata.statementDate ?? null,
    due_date: metadata.dueDate ?? null,
    opening_balance: isCreditCard ? metadata.openingBalance ?? null : null,
    closing_balance: isCreditCard ? metadata.closingBalance ?? null : null,
    credit_limit: isCreditCard ? metadata.creditLimit ?? null : null,
    minimum_payment: isCreditCard ? metadata.minimumPayment ?? null : null,
    opening_principal: !isCreditCard ? metadata.openingBalance ?? null : null,
    closing_principal: !isCreditCard ? metadata.closingBalance ?? null : null,
    interest_rate: metadata.interestRate ?? null,
    purchases_total: purchasesTotal,
    cash_advances_total: cashAdvancesTotal,
    interest_total: interestTotal,
    fees_total: feesTotal,
    payments_total: paymentsTotal,
    refunds_total: refundsTotal,
    drawdowns_total: drawdownsTotal,
    principal_repayments_total: principalRepaymentsTotal,
    reconciliation_status: reconciliation.status,
    reconciliation_variance: reconciliation.variance,
    parser_name: parserName,
    parser_version: parserVersion,
    extraction_confidence: extractionConfidence,
    review_status: reconciliation.status === 'variance' || warnings.length > 0 ? 'pending' : 'not_required',
  };

  const { data: inserted, error: insertError } = await supabase
    .from('fdh_liability_statements')
    .insert(insertRow)
    .select('id')
    .single();
  if (insertError || !inserted) throw new Error(insertError?.message ?? 'could not create statement evidence');
  const statementId = (inserted as { id: string }).id;

  // Bank matching for PAYMENT activities only (spec sections 39-43) — never
  // for PURCHASE/REFUND/INTEREST/FEE, which are never matched against a
  // bank transaction (only settled/expensed on their own terms).
  for (const activity of activities) {
    let bankMatchStatus: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted' | 'bank_evidence_not_available' = 'not_attempted';
    let linkedTransactionId: string | null = null;
    if (activity.activityType === 'PAYMENT') {
      const candidates = await loadBankCandidatesForPayment(userId, activity.activityDate, activity.amount, metadata.institutionName);
      const match = matchBankPayment(
        { paymentAmount: activity.amount, paymentDate: activity.activityDate, currencyCode: metadata.currencyCode },
        candidates,
      );
      // A PAYMENT with no bank evidence available yet is recorded as such
      // (spec section 49) rather than a plain 'no_match' — a future bank
      // statement import may still corroborate it.
      bankMatchStatus =
        match.outcome === 'matched' ? 'matched' :
        match.outcome === 'multiple_candidates' ? 'multiple_candidates' :
        'bank_evidence_not_available';
      linkedTransactionId = match.matchedTransactionId;
    }

    const { error: actError } = await supabase.from('fdh_liability_statement_activities').insert({
      user_id: userId,
      statement_id: statementId,
      activity_type: activity.activityType,
      activity_date: activity.activityDate,
      amount: activity.amount,
      currency_code: metadata.currencyCode,
      description_raw: activity.descriptionRaw ?? null,
      merchant_raw: activity.merchantRaw ?? null,
      principal_component: activity.principalComponent ?? null,
      interest_component: activity.interestComponent ?? null,
      fee_component: activity.feeComponent ?? null,
      linked_transaction_id: linkedTransactionId,
      bank_match_status: bankMatchStatus,
      review_status: bankMatchStatus === 'multiple_candidates' ? 'pending' : 'not_required',
      source_row_number: activity.sourceRowNumber ?? null,
    });
    if (actError) throw new Error(actError.message);
  }

  assertDocumentTransition('processing', 'extracted');
  await supabase
    .from('fdh_statement_uploads')
    .update({ processing_status: 'extracted', error_code: null, processing_completed_at: new Date().toISOString() })
    .eq('id', document.id)
    .eq('user_id', userId);

  await recordDocumentAuditEvent({
    userId,
    documentId: document.id,
    eventType: 'liability_statement_extraction_completed',
    actorType: 'system',
    metadata: { statement_id: statementId, reconciliation_status: reconciliation.status },
  });

  return statementId;
}

export async function getLiabilityStatementIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_liability_statements')
    .select('id')
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Read-model for the review screen (spec sections 22-23). No write. */
export async function getLiabilityStatementForReview(userId: string, statementId: string) {
  const supabase = await createClient();
  const { data: statement, error } = await supabase
    .from('fdh_liability_statements')
    .select('*')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !statement) return null;
  // FDH-8's own historical defect class (spec section 121-124, silent
  // PostgREST 1,000-row truncation): a statement with more than
  // POSTGREST_PAGE_SIZE activities must never have its later rows silently
  // dropped from the review screen. `fetchAllRows` pages past that cap with
  // a deterministic, unique ordering (activity_date, id — activity_date
  // alone is not unique across same-day activities).
  const activities = await fetchAllRows<Record<string, unknown>>(() =>
    supabase
      .from('fdh_liability_statement_activities')
      .select('*')
      .eq('statement_id', statementId)
      .eq('user_id', userId)
      .order('activity_date', { ascending: true })
      .order('id', { ascending: true }),
  );
  return { statement, activities };
}
