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

import { resolveEmailForAiePilotCohort } from '@/lib/aie/pilotCohortEmail';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '../bank-csv/pagination';
import { decodeCsvBytes } from '../bank-csv/csv';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { adapterCallEvidenceMetadata } from '@/lib/aie/adapters/shared/gateway';
import { figureIsPrinted } from '@/lib/aie/adapters/shared/reviewDraft';
import { AIE_LIABILITY_FACTS_SCHEMA_NAME, AIE_LIABILITY_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/liability/schema';
import { saveAiFallbackDraft, claimPendingAiFallbackDraft, releaseClaimedAiFallbackDraft, loadPendingAiFallbackDraft } from './aiFallbackDrafts';
import {
  isAieLiabilityAiFallbackEnabled,
  requestLiabilityAiExtraction,
  mapLiabilityStatementFactsToDraft,
  AIE_LIABILITY_PARSER_NAME,
  AIE_LIABILITY_PARSER_VERSION,
  AIE_LIABILITY_AI_EXTRACTION_CONFIDENCE,
  type MappedLiabilityStatementHeader,
} from '@/lib/aie/adapters/liability';
import { statementUploadsRepository } from '../repositories';
import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { extractLiabilityStatement } from '../liability/statementIntake';
import { reconcileCreditCardStatement, reconcileLoanStatement } from '../liability/statementReconciliation';
import { matchBankPayment, type BankTransactionCandidate } from '../liability/bankMatching';
import type {
  LiabilityExtractionFailureKind,
  LiabilityFacilityType,
  LiabilityReconciliationStatus,
  LiabilityStatementActivity,
  LiabilityStatementCountry,
  LiabilityStatementType,
} from '../liability/types';
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
  // 'pending_scan' (2026-09-21, real-malware-gate async fix): see the
  // identical addition + rationale on `UploadAuInvestmentStatementResult`
  // in investmentStatementProcessingService.ts.
  //
  // 'ai_fallback_available' (2026-09-23, AIE unified document fallback): the
  // native CSV extraction failed on a readable-but-unrecognised layout and an
  // AI read a DRAFT off it instead. NOTHING has been written — no
  // `fdh_liability_statements` row, no activities, and (deliberately) not even
  // a `processing_status` change. See `aiFallbackDraft` below.
  pipelineStatus: 'ok' | 'extraction_failed' | 'duplicate_statement' | 'pending_scan' | 'ai_fallback_available';
  failureKind?: string;
  /**
   * Populated ONLY when `pipelineStatus === 'ai_fallback_available'`.
   *
   * THE DOCUMENT IS DELIBERATELY LEFT EXACTLY WHERE IT WAS — still `queued`
   * or `uploaded`, with no `error_code` — rather than being moved to `failed`
   * as the native failure branch would. That is what keeps
   * `confirmAiLiabilityFallback` able to complete the write later:
   * `persistLiabilityStatementEvidence` ends with the same
   * `processing -> extracted` update a native success uses, and a document
   * already written as `failed` would have to be un-failed first, which is a
   * second write path and therefore a second thing that can disagree with the
   * first.
   *
   * The caller (the API route) shows this to the user for explicit review
   * before `confirmAiLiabilityFallback` writes anything — "try AI, then ask
   * you to review", never a silent auto-write of an AI guess.
   */
  aiFallbackDraft?: LiabilityStatementAiFallbackDraft;
}

/**
 * What the review UI is shown, and what the confirm route sends back.
 *
 * It is deliberately the RAW READING (the header facts as printed, and one
 * row per activity line) rather than any derived result: the user reviews what
 * the model claims the page said, and every derived value — the per-type
 * totals, the reconciliation verdict and its variance, the bank-payment
 * matching, the review status — is recomputed SERVER-SIDE from the reviewed
 * rows at confirm time by the same code a native parse runs through. Nothing
 * computed on the client is ever trusted.
 */
export interface LiabilityStatementAiFallbackDraft {
  /** 2026-09-25: exactly the keys the confirm route's strict activity schema
   * accepts. The panel posts these rows verbatim; `sourceRowNumber` used to
   * ride along and made every confirm fail with 422. */
  activities: LiabilityAiDraftActivity[];
  header: MappedLiabilityStatementHeader;
  /** The model's own claim that it listed every printed line. Shown to the
   * user in words. Never the only completeness check — the reconciliation
   * arithmetic recomputed at confirm time is. */
  allActivitiesListed: boolean;
  warnings: string[];
}

export type LiabilityAiDraftActivity = Pick<
  LiabilityStatementActivity,
  'activityType' | 'activityDate' | 'amount' | 'descriptionRaw' | 'merchantRaw' | 'principalComponent' | 'interestComponent' | 'feeComponent'
>;

/** The reviewable projection of the mapped activities. Exported for the
 * draft/confirm round-trip unit test. */
export function toLiabilityAiDraftActivities(activities: readonly LiabilityStatementActivity[]): LiabilityAiDraftActivity[] {
  return activities.map((a) => {
    const row: LiabilityAiDraftActivity = { activityType: a.activityType, activityDate: a.activityDate, amount: a.amount };
    if (a.descriptionRaw !== undefined) row.descriptionRaw = a.descriptionRaw;
    if (a.merchantRaw !== undefined) row.merchantRaw = a.merchantRaw;
    if (a.principalComponent !== undefined) row.principalComponent = a.principalComponent;
    if (a.interestComponent !== undefined) row.interestComponent = a.interestComponent;
    if (a.feeComponent !== undefined) row.feeComponent = a.feeComponent;
    return row;
  });
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
 *
 * 2026-09-21 (real-malware-gate async fix): only creates the upload now,
 * then hands off to `resolveLiabilityStatementDocument()` — see that
 * function's header. Byte-for-byte unchanged when the real-scan flag is off
 * or a scan resolves inline.
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

  return resolveLiabilityStatementDocument(userId, document, metadata);
}

/**
 * Resumes processing for a document left in `pending_scan` because the real
 * malware gate had not yet resolved it when
 * `uploadAndProcessLiabilityStatement()` (or a prior call to this function)
 * ran. Called from `POST /liability-statement/{documentId}/process` once
 * `LiabilityImportPanel.tsx` has polled the document out of `validating`.
 * Metadata must be re-supplied by the caller, exactly as in the
 * investment-statement sibling of this function.
 */
export async function continueLiabilityStatementProcessing(
  userId: string,
  documentId: string,
  metadata: UploadLiabilityStatementMetadata,
): Promise<UploadLiabilityStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new LiabilityStatementProcessingError('not_found', 'document not found');
  return resolveLiabilityStatementDocument(userId, document, metadata);
}

/**
 * Extraction failure kinds this adapter will attempt an AI-fallback for.
 *
 * DELIBERATELY NARROW, mirroring the payslip and bank-statement paths' own
 * eligibility lists and their reasoning. The test is not "did parsing fail"
 * but "is there readable statement text that the LAYOUT detector could not
 * map":
 *
 *   - `manual_mapping_required` — the file was read, but no registered
 *     adapter's header signature cleared the minimum-confidence bar. The
 *     primary case, and the one real users hit with an unsupported lender.
 *   - `ambiguous_format`        — the file was read, but two adapters scored
 *     within the confidence gap of each other so the detector refused to pick.
 *   - `layout_unsupported`      — the file was read as text but not as a
 *     recognisable statement export.
 *
 * EXCLUDED ON PURPOSE, each because there is either NO READABLE TEXT (so an
 * AI has nothing to read and the call would be pure spend and pure invention
 * risk) or because the failure is not about layout at all:
 *   - `scanned_document` / `ocr_required` — a scan with no text layer. This is
 *     the case people most expect AI to rescue and it is exactly the one it
 *     cannot here: this pipeline does no OCR, and sending near-empty text to a
 *     model invites it to invent a statement wholesale.
 *   - `password_required` / `wrong_password` — a missing credential for this
 *     attempt, recoverable by retrying; not a defect and not a layout problem.
 *   - `corrupt` — the file itself could not be read.
 *   - `statement_type_not_identified` / `country_not_identified` — the
 *     document may not be a liability statement at all. Asking a model to read
 *     one out of it is precisely the "wrong document type" case the design
 *     document's §4 item 6 rules out.
 *   - `unknown_error` — an unclassified internal fault. Its cause is by
 *     definition not established, so it cannot be asserted to be a layout
 *     problem.
 */
const AI_FALLBACK_ELIGIBLE_LIABILITY_FAILURE_KINDS: readonly LiabilityExtractionFailureKind[] = [
  'manual_mapping_required',
  'ambiguous_format',
  'layout_unsupported',
];

/**
 * Everything that happens to an already-uploaded document — see the
 * identical-purpose `resolveAuInvestmentStatementDocument()` in
 * investmentStatementProcessingService.ts for the full rationale. Shared by
 * both entry points above so neither can drift from the other.
 */
async function resolveLiabilityStatementDocument(
  userId: string,
  document: FdhStatementUpload,
  metadata: UploadLiabilityStatementMetadata,
): Promise<UploadLiabilityStatementResult> {
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

  // Real-malware-gate wiring (2026-09-21): see the identical comment in
  // investmentStatementProcessingService.ts's `resolveAuInvestmentStatement
  // Document()` — this is a genuine, legal wait state, not an error.
  if (document.processing_status === 'validating') {
    return { document, statementId: null, pipelineStatus: 'pending_scan' };
  }

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new LiabilityStatementProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  // AIE-1 final completion (2026-09-25): see `checkFdhDocumentMalwareAdmission`.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new LiabilityStatementProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
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
    // AI FALLBACK, attempted BEFORE the failure write below and only for the
    // failure kinds where the file is genuinely readable statement text that
    // the LAYOUT-specific adapter registry could not map. Ordering is not a
    // preference: the write below sets `error_code` and moves the document to
    // `failed`, and a draft offered after that would have to undo it.
    if (AI_FALLBACK_ELIGIBLE_LIABILITY_FAILURE_KINDS.includes(extraction.kind)) {
      // Liability statements are CSV-only — there is no PDF/OCR stage and so
      // no `extractedText` already in hand at this point, unlike every other
      // adapter in this programme. The already-downloaded bytes are decoded
      // here with the SAME certified `decodeCsvBytes()` the native extractor
      // itself uses (encoding sniffing included), purely so the masking layer
      // has text to work on. No second download and no second decoder.
      // 2026-09-25: a pending server-issued draft is returned as-is, so a
      // repeated /process never pays for a second provider call.
      const pending = await loadPendingAiFallbackDraft(userId, document.id);
      if (pending.found) {
        return { document, statementId: null, pipelineStatus: 'ai_fallback_available', aiFallbackDraft: pending.payload as LiabilityStatementAiFallbackDraft };
      }
      const decoded = decodeCsvBytes(download.bytes).text;
      const fallback = await attemptAiLiabilityFallback(userId, document.id, decoded);
      if (fallback.ok) {
        // Deliberately NO document status change and NO error code — see
        // `UploadLiabilityStatementResult.aiFallbackDraft`'s own doc comment.
        return { document, statementId: null, pipelineStatus: 'ai_fallback_available', aiFallbackDraft: fallback.draft };
      }
      await recordDocumentAuditEvent({
        userId,
        documentId: document.id,
        eventType: 'liability_statement_ai_fallback_not_usable',
        actorType: 'system',
        metadata: { reason: fallback.reason, nativeFailureKind: extraction.kind },
      });
    }

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

  const statementId = await persistLiabilityStatementEvidence(userId, document, extraction.extraction.activities, metadata, extraction.extraction.warnings, extraction.extraction.parserName, extraction.extraction.parserVersion, extraction.extraction.extractionConfidence, extraction.extraction.facilityType);

  return { document, statementId, pipelineStatus: 'ok' };
}

/**
 * THE CANONICAL WRITE for a liability statement.
 *
 * EXPORTED 2026-09-23 (AIE unified document fallback) so that the AI-fallback
 * confirm path calls the IDENTICAL function a native successful extraction
 * calls, rather than a second writer that would have to be kept in step with
 * this one. Everything that makes a native import trustworthy — the per-type
 * totals arithmetic, the reconciliation verdict, the bank-payment matching of
 * every PAYMENT line, the review-status decision, the `processing -> extracted`
 * transition and the completion audit event — happens here and therefore
 * happens identically on both paths. An AI-fallback-produced
 * `fdh_liability_statements` row is indistinguishable from a natively-parsed
 * one to every downstream consumer except in the two fields that SHOULD
 * distinguish it: `parser_name` and `extraction_confidence`.
 *
 * It remains an internal-to-FDH function in every other sense: nothing outside
 * this service and its own confirm route calls it, and it is not re-exported
 * from any barrel.
 */
export async function persistLiabilityStatementEvidence(
  userId: string,
  document: FdhStatementUpload,
  activities: readonly LiabilityStatementActivity[],
  metadata: UploadLiabilityStatementMetadata,
  warnings: string[],
  parserName: string,
  parserVersion: string,
  extractionConfidence: number,
  // FIX (live-DEV final certification round): this must be the REAL facility
  // type the matched adapter declared (e.g. AU_LOAN_GENERIC_V1's
  // 'home_loan'), not re-derived from statementType here. Genuinely
  // reproduced live: uploading an AU home-loan CSV against an EXISTING
  // mortgage liability (same lender, same masked_identifier, same currency)
  // persisted facility_type='personal_loan' regardless, which
  // liabilityAdapter.ts's FACILITY_TO_DEBT_TYPE lookup then maps to
  // debt_type='personal_loan' — so facilityMatching.ts could never find the
  // existing 'mortgage'-typed liability no matter how well institution/
  // masked_identifier/currency lined up, and the proposal always recommended
  // add_new. Left uncorrected this would silently create a DUPLICATE mortgage
  // (and leave the property_liability_links row pointed at the stale
  // facility) for every home_loan/investment_property_loan/vehicle_loan/
  // other_term_loan/line_of_credit/overdraft statement — every one of them,
  // since none of those six facility types could ever round-trip through the
  // hardcoded 'personal_loan' fallback. facilityMatching.ts and
  // liabilityAdapter.ts themselves were already correct; the extraction
  // pipeline (statementIntake.ts/csvExtraction.ts) already computed the right
  // value in `extraction.extraction.facilityType` — it just was never wired
  // through to the INSERT below.
  facilityType: LiabilityFacilityType,
): Promise<string> {
  const supabase = await createClient();
  const isCreditCard = metadata.statementType === 'credit_card';

  const sumOf = (type: string) => activities.filter((a) => a.activityType === type).reduce((s, a) => s + a.amount, 0) || null;
  const has = (type: string) => activities.some((a) => a.activityType === type);

  const purchasesTotal = has('PURCHASE') ? sumOf('PURCHASE') : null;
  const cashAdvancesTotal = has('CASH_ADVANCE') ? sumOf('CASH_ADVANCE') : null;
  // Interest/fees reach an activity two different ways depending on
  // statement shape, and a loan statement's total was silently dropping
  // one of them: a credit card statement carries interest/fees as their
  // OWN whole activities (activityType INTEREST/FEE, no component split),
  // while a loan statement's repayment decomposition (auLoan.ts) embeds
  // interestComponent/feeComponent inside a single PAYMENT activity and
  // never emits a standalone INTEREST/FEE activityType at all. Summing
  // only `sumOf('INTEREST'|'FEE')` -- keyed on activityType -- left every
  // loan statement's interest_total/fees_total stuck at null even when
  // real, statement-evidenced interest/fee amounts were extracted and
  // visible per-activity, live-reproduced via a real $2,000 = $1,550
  // principal + $430 interest + $20 fee repayment. Summing both the
  // whole-activity and the component paths together is safe for either
  // shape: credit-card INTEREST/FEE activities never populate these
  // component fields, and loan PAYMENT activities never carry an
  // INTEREST/FEE activityType, so there is no double-count either way.
  const interestTotal =
    (has('INTEREST') ? sumOf('INTEREST') ?? 0 : 0) + activities.reduce((s, a) => s + (a.interestComponent ?? 0), 0) || null;
  const feesTotal =
    (has('FEE') ? sumOf('FEE') ?? 0 : 0) + activities.reduce((s, a) => s + (a.feeComponent ?? 0), 0) || null;
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
    facility_type: facilityType,
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

/** Drops an opening/closing balance the document does not print, with a
 * warning the user sees (exported for its unit test). */
export function keepOnlyPrintedLiabilityBalances<T extends { header: { openingBalance?: number; closingBalance?: number }; warnings: string[] }>(mapped: T, documentText: string): T {
  const header = { ...mapped.header };
  const warnings = [...mapped.warnings];
  if (header.openingBalance !== undefined && !figureIsPrinted(header.openingBalance, documentText)) { header.openingBalance = undefined; warnings.push('ai_opening_balance_not_printed_dropped'); }
  if (header.closingBalance !== undefined && !figureIsPrinted(header.closingBalance, documentText)) { header.closingBalance = undefined; warnings.push('ai_closing_balance_not_printed_dropped'); }
  return { ...mapped, header, warnings };
}

export type AiLiabilityFallbackOutcome = { ok: true; draft: LiabilityStatementAiFallbackDraft } | { ok: false; reason: string };

/**
 * The one call site that reaches the AI provider for a liability statement.
 *
 * Every gate — this adapter's own kill switch, the shared global AIE kill
 * switch, the shared AIE-1 pilot cohort, and masking (which FAILS CLOSED when
 * the masking key is unset) — is evaluated by the shared
 * `evaluateAiFallbackGate`, in that order. The gate returns ONLY masked text
 * on success, so this function has no way to send the raw statement to the
 * provider even by mistake.
 *
 * Exported so it is independently unit-testable with a faked provider, and so
 * a live-DEV proof can exercise it directly.
 */
export async function attemptAiLiabilityFallback(userId: string, documentId: string, extractedText: string): Promise<AiLiabilityFallbackOutcome> {
  const gate = evaluateAiFallbackGate({
    userId,
    cohortEmail: await resolveEmailForAiePilotCohort(userId),
    adapterEnabled: isAieLiabilityAiFallbackEnabled(),
    extractedText,
  });
  if (!gate.ok) {
    if (gate.reason === 'masking_below_policy') {
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'liability_statement_ai_fallback_masking_below_policy', actorType: 'system' });
    }
    return { ok: false, reason: gate.reason };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'liability_statement_ai_fallback_attempted', actorType: 'system' });
  const result = await requestLiabilityAiExtraction({ maskedText: gate.maskedText, requestId: documentId });
  if (result.outcome !== 'success') {
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'liability_statement_ai_fallback_provider_outcome',
      actorType: 'system',
      metadata: { outcome: result.outcome, ...adapterCallEvidenceMetadata(result.evidence) },
    });
    return { ok: false, reason: result.outcome };
  }

  const read = mapLiabilityStatementFactsToDraft(result.facts);
  // 2026-09-25: the opening/closing balances anchor the reconciliation, so a
  // figure the page does not print is dropped (see figureIsPrinted) -- the
  // same rule the bank adapter applies after the live finding there.
  const mapped = read ? keepOnlyPrintedLiabilityBalances(read, extractedText) : null;
  if (!mapped) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'liability_statement_ai_fallback_insufficient_fields', actorType: 'system', metadata: adapterCallEvidenceMetadata(result.evidence) });
    return { ok: false, reason: 'insufficient_fields' };
  }

  const draft: LiabilityStatementAiFallbackDraft = {
    activities: toLiabilityAiDraftActivities(mapped.activities),
    header: mapped.header,
    allActivitiesListed: mapped.allActivitiesListed,
    warnings: mapped.warnings,
  };
  // 2026-09-25: persisted BEFORE the user sees it (0197) -- see the payslip
  // reference. Confirm is then accepted only against this draft, once.
  const saved = await saveAiFallbackDraft({
    userId,
    documentId,
    documentType: 'liability_statement',
    schemaName: AIE_LIABILITY_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_LIABILITY_FACTS_SCHEMA_VERSION,
    payload: draft,
    providerIdempotencyKey: result.evidence?.idempotencyKey ?? null,
  });
  if (!saved.persisted && saved.reason === 'write_failed') {
    console.error(`liability AI draft for ${documentId} could not be persisted: ${saved.detail ?? 'unknown'}`);
    return { ok: false, reason: 'draft_not_persisted' };
  }

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'liability_statement_ai_fallback_draft_ready',
    actorType: 'system',
    metadata: { ...adapterCallEvidenceMetadata(result.evidence), draft_persisted: saved.persisted, activities: draft.activities.length },
  });
  return { ok: true, draft };
}

/** What the confirm route hands back after the user has reviewed the draft. */
export interface ReviewedLiabilityStatementDraft {
  /** The caller's own context — statement type, country, currency and the
   * header values, exactly as the upload/process routes already carry them.
   * NEVER taken from the AI response; the AI-read header values reach this
   * only by being shown to the user and confirmed by them. */
  metadata: UploadLiabilityStatementMetadata;
  /** Chosen by the USER, never by the model — see
   * `lib/aie/adapters/liability/schema.ts`'s header for why this one field is
   * singled out (a wrong facility type does not mislabel a row, it makes the
   * user's existing liability unfindable and silently creates a duplicate). */
  facilityType: LiabilityFacilityType;
  activities: readonly LiabilityStatementActivity[];
  /** The warnings the extraction itself produced (dropped rows, an
   * incomplete-listing self-report). Carried through so they are persisted
   * with the evidence rather than lost at the request boundary. */
  aiWarnings?: readonly string[];
}

/**
 * Called only after the user has reviewed the draft `attemptAiLiabilityFallback`
 * produced (and may have corrected it by removing rows).
 *
 * MAKES NO AI CALL and re-reads nothing from the document. It takes the
 * reviewed activities and header values and hands them to
 * `persistLiabilityStatementEvidence` — the EXACT function a native successful
 * extraction uses — which recomputes every per-type total, the reconciliation
 * verdict and its variance, and the bank-payment match for every PAYMENT line,
 * SERVER-SIDE. Nothing the client computed is trusted; the client supplies only
 * what a human could have typed off the page.
 *
 * THE PARKING-STATE GATE, AND HOW IT DELIBERATELY DIVERGES FROM PAYSLIP AND
 * BANK-STATEMENT. Those two services persist `processing_status: 'processing'`
 * before extracting, so their confirm routes can gate on
 * `processing_status === 'processing'` — a state only their own fallback could
 * have left the document in. THIS SERVICE NEVER WRITES `processing` AT ALL: it
 * calls `assertDocumentTransition('processing', ...)` with literal strings to
 * assert the edge is legal, but the row itself stays `queued`/`uploaded` right
 * up until the `extracted` write inside `persistLiabilityStatementEvidence`.
 * Gating on `'processing'` here would therefore reject every legitimate
 * confirm. The equivalent guarantee is reconstructed from two conditions that
 * together mean the same thing:
 *   1. the document is still in `queued`/`uploaded` — i.e. it has not since
 *      been failed, rejected, extracted, approved or purged by anything else;
 *   2. no `fdh_liability_statements` row exists for it yet — i.e. no evidence
 *      has been written for this document by any path.
 * A replayed or stale confirm fails (2) even if it somehow passes (1), which
 * is what makes the double-write impossible. This is a genuine divergence from
 * the reference implementation, recorded here rather than papered over: it is
 * weaker than payslip's gate in one specific way — a document that has been
 * uploaded but whose native processing has never been attempted would also
 * satisfy both conditions, so a caller who guessed a document id could confirm
 * an AI draft for a document that never produced one. That caller must already
 * be the authenticated OWNER of that document (`getForUser` is user-scoped),
 * and the result would be a statement containing exactly the activities they
 * themselves submitted — which they could equally have created by uploading a
 * CSV of the same rows. It is a "user writes their own data by an unintended
 * door", not a cross-tenant or privilege issue.
 */
export async function confirmAiLiabilityFallback(
  userId: string,
  documentId: string,
  reviewed: ReviewedLiabilityStatementDraft,
): Promise<UploadLiabilityStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new LiabilityStatementProcessingError('not_found', 'document not found');

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new LiabilityStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }
  const existingStatementId = await getLiabilityStatementIdForDocument(userId, documentId);
  if (existingStatementId) {
    throw new LiabilityStatementProcessingError('invalid_state', 'Evidence has already been saved for this statement.');
  }
  if (reviewed.activities.length === 0) {
    throw new LiabilityStatementProcessingError('invalid_state', 'At least one activity is required.');
  }
  // Defence in depth, duplicated in the route's own validation: a credit-card
  // statement can only ever be a credit-card facility. FDH-10's
  // `FACILITY_TO_DEBT_TYPE` would otherwise map a mis-declared card statement
  // onto a loan debt type, and facility matching would look for the wrong
  // existing liability entirely.
  const facilityType: LiabilityFacilityType =
    reviewed.metadata.statementType === 'credit_card' ? 'credit_card' : reviewed.facilityType;
  if (reviewed.metadata.statementType === 'loan' && facilityType === 'credit_card') {
    throw new LiabilityStatementProcessingError('invalid_state', 'A loan statement cannot be saved as a credit card facility.');
  }

  // 2026-09-25: the conditional claim of the server-issued draft (0197). It
  // closes the two residuals disclosed above: a confirm for a document that
  // never produced a draft, and two confirms racing past the check-then-act.
  const claim = await claimPendingAiFallbackDraft({ userId, documentId, confirmedPayload: { facilityType, activities: reviewed.activities } });
  if (!claim.claimed && claim.reason !== 'table_missing') {
    throw new LiabilityStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'liability_statement_ai_fallback_confirmed', actorType: 'user' });
  try {
    return await persistConfirmedLiabilityDraft(userId, documentId, document, reviewed, facilityType);
  } catch (e) {
    if (claim.claimed) await releaseClaimedAiFallbackDraft(userId, claim.draftId);
    throw e;
  }
}

async function persistConfirmedLiabilityDraft(
  userId: string,
  documentId: string,
  document: FdhStatementUpload,
  reviewed: ReviewedLiabilityStatementDraft,
  facilityType: LiabilityFacilityType,
): Promise<UploadLiabilityStatementResult> {
  // The marker warning is ALWAYS added, never conditionally. Its first job is
  // provenance (the evidence row itself records that it was AI-read and
  // user-confirmed), and its second is that
  // `persistLiabilityStatementEvidence` sets `review_status: 'pending'`
  // whenever warnings are present — so an AI-read statement always lands in
  // the review queue, even when the model's own reading reconciled perfectly.
  const warnings = ['ai_fallback_user_confirmed', ...(reviewed.aiWarnings ?? [])];

  const statementId = await persistLiabilityStatementEvidence(
    userId,
    document,
    reviewed.activities,
    reviewed.metadata,
    warnings,
    AIE_LIABILITY_PARSER_NAME,
    AIE_LIABILITY_PARSER_VERSION,
    AIE_LIABILITY_AI_EXTRACTION_CONFIDENCE,
    facilityType,
  );

  const { data: finalDocument } = await statementUploadsRepository.getForUser(userId, documentId);
  return { document: (finalDocument ?? document) as FdhStatementUpload, statementId, pipelineStatus: 'ok' };
}

// ---------------------------------------------------------------------------
// User correction of extracted statement figures (2026-09-24)
// ---------------------------------------------------------------------------

/**
 * The fields a user may correct on an extracted liability statement.
 *
 * Deliberately the EXACT key set `fdh10_correct_liability_statement`
 * (migration 0186) accepts — one closed vocabulary, declared once, so a field
 * can never be accepted by the route and then silently rejected by the
 * database, or vice versa. `tests/unit/fdh10LiabilityCorrection.test.ts`
 * asserts all three layers agree.
 */
export const LIABILITY_CORRECTABLE_TEXT_FIELDS = ['institution_name'] as const;
export const LIABILITY_CORRECTABLE_DATE_FIELDS = [
  'statement_period_start', 'statement_period_end', 'statement_date', 'due_date',
] as const;
/** Credit-card-only figures. A loan statement has none of these; correcting
 * one there would store a figure no formula and no proposal ever reads. */
export const LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS = [
  'opening_balance', 'closing_balance', 'credit_limit', 'minimum_payment',
  'purchases_total', 'cash_advances_total', 'refunds_total',
] as const;
/** Loan-only figures, in the same sense. */
export const LIABILITY_CORRECTABLE_LOAN_FIELDS = [
  'opening_principal', 'closing_principal', 'drawdowns_total',
  'capitalised_total', 'principal_repayments_total',
] as const;
/** Money figures both kinds of statement disclose. */
export const LIABILITY_CORRECTABLE_SHARED_MONEY_FIELDS = [
  'interest_total', 'fees_total', 'payments_total', 'adjustments_total',
] as const;
/** A percentage, not money — its own group because it is neither formatted
 * nor bounded like the figures above. */
export const LIABILITY_CORRECTABLE_RATE_FIELDS = ['interest_rate'] as const;

/**
 * Exactly the fields `statementReconciliation.ts`' two formulas READ.
 *
 * This is what decides whether a correction makes the stored reconciliation
 * outcome stale. It is deliberately NARROWER than "every money field": a
 * corrected `credit_limit`, `minimum_payment` or `interest_rate` is not an
 * input to either identity, so re-stamping on one of those would replace a
 * real prior result with the answer to a question the user did not ask. This
 * is the one place this implementation is more precise than its payslip
 * precedent rather than merely parallel to it.
 */
export const LIABILITY_RECONCILIATION_INPUT_FIELDS = [
  'opening_balance', 'closing_balance', 'purchases_total', 'cash_advances_total', 'refunds_total',
  'opening_principal', 'closing_principal', 'drawdowns_total', 'capitalised_total',
  'principal_repayments_total', 'interest_total', 'fees_total', 'payments_total', 'adjustments_total',
] as const;

export type LiabilityCorrectableField =
  | (typeof LIABILITY_CORRECTABLE_TEXT_FIELDS)[number]
  | (typeof LIABILITY_CORRECTABLE_DATE_FIELDS)[number]
  | (typeof LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS)[number]
  | (typeof LIABILITY_CORRECTABLE_LOAN_FIELDS)[number]
  | (typeof LIABILITY_CORRECTABLE_SHARED_MONEY_FIELDS)[number]
  | (typeof LIABILITY_CORRECTABLE_RATE_FIELDS)[number];

export type LiabilityCorrections = Partial<Record<LiabilityCorrectableField, string | number | null>>;

export interface CorrectLiabilityStatementResult {
  statementId: string;
  correctedFields: string[];
  reconciliationStatus: LiabilityReconciliationStatus;
  reconciliationVariance: number | null;
  reconciliationRestamped: boolean;
}

/** Which correctable fields apply to a statement of this type. Used by the
 * route to refuse a cross-type field with an honest message, and asserted
 * against the RPC's own identical guard by this feature's unit test. */
export function liabilityCorrectableFieldsFor(statementType: LiabilityStatementType): readonly string[] {
  return [
    ...LIABILITY_CORRECTABLE_TEXT_FIELDS,
    ...LIABILITY_CORRECTABLE_DATE_FIELDS,
    ...(statementType === 'credit_card' ? LIABILITY_CORRECTABLE_CREDIT_CARD_FIELDS : LIABILITY_CORRECTABLE_LOAN_FIELDS),
    ...LIABILITY_CORRECTABLE_SHARED_MONEY_FIELDS,
    ...LIABILITY_CORRECTABLE_RATE_FIELDS,
  ];
}

/**
 * Apply a user's corrections to an already-extracted liability statement.
 *
 * WHY THIS IS NOT A DIRECT UPDATE. Migration 0096's Part F.1 trigger makes
 * every balance anchor, activity total and reconciliation column on
 * `fdh_liability_statements` authoritative: an ordinary authenticated UPDATE
 * of any of them fails closed, and only a SECURITY DEFINER RPC running under
 * the internal-write GUC may move them. `fdh10_correct_liability_statement`
 * (migration 0186) is that RPC, added rather than widening the trigger's
 * allowance — the same choice migration 0185 made for `fdh_payroll_events`.
 * This function does the two things that must NOT live in PL/pgSQL —
 * validation against the closed, type-scoped field vocabulary, and
 * recomputing the statement identity with the SAME certified
 * `reconcileCreditCardStatement`/`reconcileLoanStatement` an extraction uses
 * — and then delegates the write.
 *
 * WHY RECONCILIATION IS RECOMPUTED FROM THE STORED TOTALS, NOT THE ACTIVITY
 * ROWS. `persistLiabilityStatementEvidence` derives the activity totals by
 * summing `fdh_liability_statement_activities`, which are THE LINES THE
 * STATEMENT PRINTED. A correction changes the summary figures, not the
 * document, so re-summing the activity rows would discard the user's
 * correction and return the pre-correction result. The corrected figures are
 * instead fed straight to the same certified formula, which — exactly as
 * before — returns `insufficient_data` rather than a guess when a balance
 * anchor is missing, and `variance` when the corrected figures still do not
 * add up. The safety net is re-stamped, never dropped.
 */
export async function correctLiabilityStatement(
  userId: string,
  documentId: string,
  corrections: LiabilityCorrections,
): Promise<CorrectLiabilityStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) {
    throw new LiabilityStatementProcessingError('not_found', 'document not found');
  }
  // `document_type` is nullable on `fdh_statement_uploads`, and a document
  // that never declared one is not a liability statement either — the same
  // refusal, not a cast that pretends the column cannot be null.
  if (!document.document_type || !['credit_card_statement', 'loan_statement'].includes(document.document_type)) {
    throw new LiabilityStatementProcessingError(
      'wrong_document_type',
      'This document was not uploaded as a credit card or loan statement.',
    );
  }

  const statementId = await getLiabilityStatementIdForDocument(userId, documentId);
  if (!statementId) {
    throw new LiabilityStatementProcessingError(
      'not_found',
      'No statement evidence has been extracted from this document yet.',
    );
  }

  const review = await getLiabilityStatementForReview(userId, statementId);
  if (!review) throw new LiabilityStatementProcessingError('not_found', 'Statement not found.');
  const current = review.statement as Record<string, unknown>;

  if (current.approval_status === 'approved') {
    throw new LiabilityStatementProcessingError(
      'invalid_state',
      'This statement evidence has already been approved and can no longer be corrected.',
    );
  }

  const keys = Object.keys(corrections) as LiabilityCorrectableField[];
  if (keys.length === 0) {
    throw new LiabilityStatementProcessingError('invalid_state', 'No corrections were supplied.');
  }

  // A figure that belongs to the other kind of facility is refused here with
  // an honest message; the RPC refuses it again as a backstop.
  const statementType = (current.statement_type as LiabilityStatementType) ?? 'credit_card';
  const allowed = liabilityCorrectableFieldsFor(statementType);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new LiabilityStatementProcessingError(
        'invalid_state',
        statementType === 'credit_card'
          ? `${key} is not a figure on a credit card statement.`
          : `${key} is not a figure on a loan statement.`,
      );
    }
  }

  // The post-correction value of every field the identity needs, taking the
  // correction where one was supplied and the stored value where one was not.
  // `null` is the formulas' own "not disclosed", and is passed through as one.
  const after = (field: string): number | null => {
    const source = field in corrections
      ? (corrections as Record<string, string | number | null | undefined>)[field]
      : current[field];
    if (source === null || source === undefined || source === '') return null;
    const value = Number(source);
    return Number.isFinite(value) ? value : null;
  };

  const currencyCode = (current.currency_code as string) ?? 'AUD';
  const recomputed = statementType === 'credit_card'
    ? reconcileCreditCardStatement({
        openingBalance: after('opening_balance'),
        purchasesTotal: after('purchases_total'),
        cashAdvancesTotal: after('cash_advances_total'),
        interestTotal: after('interest_total'),
        feesTotal: after('fees_total'),
        paymentsTotal: after('payments_total'),
        refundsTotal: after('refunds_total'),
        adjustmentsTotal: after('adjustments_total'),
        closingBalance: after('closing_balance'),
        currencyCode,
      })
    : reconcileLoanStatement({
        openingPrincipal: after('opening_principal'),
        drawdownsTotal: after('drawdowns_total'),
        capitalisedTotal: after('capitalised_total'),
        principalRepaymentsTotal: after('principal_repayments_total'),
        adjustmentsTotal: after('adjustments_total'),
        closingPrincipal: after('closing_principal'),
        currencyCode,
      });

  const reconciliationRestamped = keys.some(
    (k) => (LIABILITY_RECONCILIATION_INPUT_FIELDS as readonly string[]).includes(k),
  );

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh10_correct_liability_statement', {
    p_statement_id: statementId,
    p_corrections: corrections,
    p_reconciliation_status: recomputed.status,
    p_reconciliation_variance: recomputed.variance,
  });
  if (error) throw new Error(error.message);

  const result = data as {
    ok: boolean; code?: string; error?: string;
    corrected_fields?: string[]; reconciliation_restamped?: boolean;
  } | null;
  if (!result?.ok) {
    const code = result?.code;
    throw new LiabilityStatementProcessingError(
      code === 'STATEMENT_NOT_FOUND' ? 'not_found' : 'invalid_state',
      result?.error ?? 'These corrections could not be saved.',
    );
  }

  // Attribution, on the SAME document audit trail every other liability
  // statement lifecycle event uses. Field NAMES only — never the figures,
  // which `auditLog.ts`'s own rule keeps out of `metadata`.
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'liability_statement_corrected',
    actorType: 'user',
    actorId: userId,
    metadata: {
      statement_id: statementId,
      corrected_fields: result.corrected_fields ?? keys,
      reconciliation_status: recomputed.status,
      reconciliation_restamped: Boolean(result.reconciliation_restamped),
    },
  });

  return {
    statementId,
    correctedFields: result.corrected_fields ?? (keys as string[]),
    reconciliationStatus: recomputed.status,
    reconciliationVariance: recomputed.variance,
    reconciliationRestamped: Boolean(result.reconciliation_restamped) || reconciliationRestamped,
  };
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
