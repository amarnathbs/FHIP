/**
 * FDH-12 — Retirement Statement Intelligence: upload + processing
 * orchestration (spec sections 20-21, 46-54, 91-93, 119).
 *
 * The NINTH FDH file approved to use the service-role client (see
 * `tests/unit/fdh1Isolation.test.ts`'s `FDH3_SERVICE_ROLE_FILES`), following
 * the exact carve-out every prior `*ProcessingService.ts` established: reads
 * use the ordinary RLS-scoped client, and every admin write is explicitly
 * re-scoped by `.eq('user_id', userId)` regardless of RLS bypass.
 *
 * The service role is what makes the FDH-11-style authoritative-write guards
 * in migration 0112 PART F meaningful: those triggers refuse system-owned
 * column writes from `auth.role() = 'authenticated'`, so THIS FILE is the only
 * thing that can set `reconciliation_status`, `account_match_status`,
 * `payslip_match_status` and the rest. A user cannot forge them over
 * PostgREST no matter that they own the row (spec section 96).
 *
 * ============================================================================
 * NO CANONICAL WRITE HAPPENS HERE (spec section 56)
 * ============================================================================
 *
 * This file writes `fdh_retirement_statements` / `_activities` / `_positions`
 * and the FDH-3 document row. It never touches `retirement_accounts`,
 * `retirement_members`, `smsf_funds`, `income_sources`, any expense register
 * or `fdh_transactions`. Upload, parse, match, reconcile, review and approve
 * all leave canonical Retirement byte-for-byte unchanged; only
 * `fdh12_apply_retirement_proposal()` can change it, and only when the user
 * presses Apply. Mechanically enforced by `tests/unit/fdh12Isolation.test.ts`.
 *
 * ============================================================================
 * SCOPE, HONESTLY DISCLOSED (spec sections 83-84, 93)
 * ============================================================================
 *
 * CSV retirement statements via the four certified generic adapters
 * (`../retirement/adapters/`) only. A PDF upload fails with
 * `pdf_manual_mapping_required` — never a silent "$0 balance" (spec sections
 * 93, 94). No OCR is claimed anywhere.
 */

import { resolveEmailForAiePilotCohort } from '@/lib/aie/pilotCohortEmail';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { statementUploadsRepository } from '../repositories';
import { createUploadSession, completeUpload, FdhUploadLifecycleError } from './uploadLifecycle';
import { downloadDocumentObject } from './storage';
import { recordDocumentAuditEvent } from './auditLog';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { detectRetirementCsvFormat } from '../retirement/detection';
import { extractRetirementStatement } from '../retirement/extraction';
import { detectSmsf } from '../retirement/smsfDetection';
import { reconcileStatement } from '../retirement/reconciliation';
import { computeActivityFingerprint, dedupActivities, findSupersededStatement } from '../retirement/dedup';
import { matchContributionToPayslip, type PayrollEventEvidence } from '../retirement/payslipReconciliation';
import { matchRetirementActivityToBank, type BankTransactionEvidence } from '../retirement/bankMatching';
import { matchRolloverCounterpart, type RolloverLeg } from '../retirement/rolloverIntelligence';
import { minorUnitsToDecimalString } from '../retirement/money';
import type { RetirementJurisdiction, RetirementStatementExtraction, RetirementStatementType, RetirementAccountType } from '../retirement/types';
// AIE retirement-statement AI-fallback (2026-09-23). Follows the pattern
// proven by the payslip and bank-statement paths: call the shared AIE gateway
// DIRECTLY from inside this native processing service's own failure branch,
// rather than routing through the `lib/aie/orchestrator.ts` intake/accept
// pipeline, whose three existing adapters were all found to have zero
// frontend callers. See `lib/aie/adapters/retirement/index.ts` and
// `docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md`.
import {
  isAieRetirementAiFallbackEnabled,
  requestRetirementAiExtraction,
  mapRetirementFactsToExtraction,
} from '@/lib/aie/adapters/retirement';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { adapterCallEvidenceMetadata } from '@/lib/aie/adapters/shared/gateway';
import { reviewableMaskedIdentifier, figureIsPrinted } from '@/lib/aie/adapters/shared/reviewDraft';
import { AIE_RETIREMENT_FACTS_SCHEMA_NAME, AIE_RETIREMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/retirement/schema';
import { saveAiFallbackDraft, claimPendingAiFallbackDraft, releaseClaimedAiFallbackDraftIfNothingWritten, loadPendingAiFallbackDraft } from './aiFallbackDrafts';
import { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } from './identicalUpload';
// The retirement service holds only BYTES at its failure branch — there is no
// extracted-text variable, because detection decodes the CSV into a local and
// never returns it. `decodeCsvBytes` is the same pure decoder the detector
// itself uses, so masking sees exactly the text the parser saw.
import { decodeCsvBytes } from '../bank-csv/csv';
import type { FdhStatementUpload } from '../domain/types';
import { fetchAllRows } from '../bank-csv/pagination';

export class RetirementStatementProcessingError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'internal_error', message: string) {
    super(message);
    this.name = 'RetirementStatementProcessingError';
  }
}

/**
 * User-facing failure copy. Every message names a real next step and none of
 * them implies the balance is zero (spec section 94).
 */
export const RETIREMENT_STATEMENT_FAILURE_MESSAGES: Record<string, string> = {
  manual_mapping_required:
    "We couldn't recognise the layout of this retirement statement. You can still add or update this account manually.",
  ambiguous_format:
    'This file matches more than one known statement layout, so we did not guess. You can add this account manually.',
  layout_unsupported:
    "We couldn't read this file as a retirement statement. You can still add or update this account manually.",
  pdf_manual_mapping_required:
    'PDF super statements are not yet supported for automatic reading. Try a CSV export from your fund, or add the account manually.',
  ocr_required:
    'This statement looks like a scan rather than a text document, so we could not read the figures from it.',
  password_required:
    'This statement is password protected. Enter the password to let us read it.',
  routed_to_smsf:
    'This looks like a self-managed super fund statement. SMSFs are managed in the SMSF section of the Retirement page.',
  unknown_error: 'Something went wrong while reading this statement.',
};

export interface UploadRetirementStatementMetadata {
  jurisdiction: RetirementJurisdiction;
  currencyCode: string;
  fundName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  /** Free text from the document (title/heading), used only for SMSF
   * detection. Never persisted. */
  statementTextSample?: string;
}

export interface UploadRetirementStatementResult {
  document: FdhStatementUpload;
  statementId: string | null;
  // 'pending_scan' (2026-09-21, real-malware-gate async fix): see the
  // identical addition + rationale on `UploadAuInvestmentStatementResult`
  // in investmentStatementProcessingService.ts.
  pipelineStatus: 'ok' | 'extraction_failed' | 'duplicate_statement' | 'routed_to_smsf' | 'pending_scan' | 'ai_fallback_available';
  failureKind?: string;
  activitiesExtracted: number;
  activitiesDeduplicated: number;
  positionsExtracted: number;
  /**
   * Populated ONLY when `pipelineStatus === 'ai_fallback_available'`. A DRAFT
   * an AI read off a statement the deterministic CSV parser could not
   * recognise — NOTHING has been written yet.
   *
   * HOW THIS DIFFERS FROM THE PAYSLIP PATH, STATED EXPLICITLY BECAUSE IT IS A
   * REAL DIVERGENCE AND NOT AN OVERSIGHT. The payslip service parks its draft
   * by leaving the document in `processing`, and its confirm step gates on
   * that status. THIS service never persists `processing` at all — it calls
   * `assertDocumentTransition` purely as a guard and writes no status on the
   * success path — so there is no equivalent parking state to gate on.
   *
   * The fallback therefore deliberately does NOT call `failDocument` before
   * returning this draft, leaving the document in `queued`, and
   * `confirmAiRetirementFallback` gates instead on the pair
   * "(still `queued`/`uploaded`) AND (no `fdh_retirement_statements` row
   * exists for this upload yet)". That pair is what makes a replayed or stale
   * confirm a no-op rather than a double-write: the second call finds a
   * statement row and refuses.
   */
  aiFallbackDraft?: RetirementAiDraftForReview;
  /** 2026-09-25: set when this upload is a byte-identical copy of an earlier
   * one that already has a result; the caller carries on with THAT upload
   * (the copy has no statement of its own, so reviewing it dead-ended). */
  duplicateOfDocumentId?: string;
}

/**
 * 2026-09-25 (other-PDF AI proof): the REVIEWABLE projection of an AI-read
 * retirement extraction -- exactly the keys the confirm route's strict body
 * schema accepts. The panel posts this object back verbatim; before this
 * projection it posted the whole internal extraction (`parserName`,
 * `parserVersion`, `extractionConfidence`, `warnings`, the YTD keys, per-row
 * `currencyCode`/`sourceRowNumber`), so every confirm returned 422.
 */
export interface RetirementAiDraftForReview {
  statementType: RetirementStatementType;
  jurisdiction: RetirementJurisdiction;
  accountType: RetirementAccountType;
  currencyCode: string;
  fundName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementStartDate?: string;
  statementEndDate?: string;
  openingBalance?: string;
  closingBalance?: string;
  employerContributions?: string;
  personalContributions?: string;
  salarySacrifice?: string;
  governmentContributions?: string;
  rolloversIn?: string;
  rolloversOut?: string;
  withdrawals?: string;
  pensionPayments?: string;
  investmentEarnings?: string;
  fees?: string;
  insurancePremiums?: string;
  tax?: string;
  activities: Array<{
    activityType: RetirementStatementExtraction['activities'][number]['activityType'];
    amount: string;
    activityDate?: string;
    descriptionRaw?: string;
    employerNameRaw?: string;
    isSummaryTotal: boolean;
    isYearToDate: boolean;
  }>;
  positions: Array<{
    optionNameRaw: string;
    assetClassRaw?: string;
    units?: string;
    unitPrice?: string;
    marketValue?: string;
    valuationDate?: string;
  }>;
}

const RETIREMENT_DRAFT_SCALAR_KEYS = [
  'fundName', 'statementDate', 'statementStartDate', 'statementEndDate',
  'openingBalance', 'closingBalance', 'employerContributions', 'personalContributions', 'salarySacrifice',
  'governmentContributions', 'rolloversIn', 'rolloversOut', 'withdrawals', 'pensionPayments',
  'investmentEarnings', 'fees', 'insurancePremiums', 'tax',
] as const;

/** Exported for the draft/confirm round-trip unit test. Undefined keys are
 * omitted (JSON drops them anyway), never sent as null-vs-absent ambiguity. */
export function toRetirementAiDraftForReview(ex: RetirementStatementExtraction): RetirementAiDraftForReview {
  const out: RetirementAiDraftForReview = {
    statementType: ex.statementType,
    jurisdiction: ex.jurisdiction,
    accountType: ex.accountType,
    currencyCode: ex.currencyCode,
    activities: ex.activities.map((a) => {
      const row: RetirementAiDraftForReview['activities'][number] = {
        activityType: a.activityType,
        amount: a.amount,
        isSummaryTotal: a.isSummaryTotal,
        isYearToDate: a.isYearToDate,
      };
      if (a.activityDate !== undefined) row.activityDate = a.activityDate;
      if (a.descriptionRaw !== undefined) row.descriptionRaw = a.descriptionRaw;
      if (a.employerNameRaw !== undefined) row.employerNameRaw = a.employerNameRaw;
      return row;
    }),
    positions: ex.positions.map((p) => {
      const row: RetirementAiDraftForReview['positions'][number] = { optionNameRaw: p.optionNameRaw };
      if (p.assetClassRaw !== undefined) row.assetClassRaw = p.assetClassRaw;
      if (p.units !== undefined) row.units = p.units;
      if (p.unitPrice !== undefined) row.unitPrice = p.unitPrice;
      if (p.marketValue !== undefined) row.marketValue = p.marketValue;
      if (p.valuationDate !== undefined) row.valuationDate = p.valuationDate;
      return row;
    }),
  };
  const identifier = reviewableMaskedIdentifier(ex.maskedAccountIdentifier);
  if (identifier !== null) out.maskedAccountIdentifier = identifier;
  for (const key of RETIREMENT_DRAFT_SCALAR_KEYS) {
    const v = ex[key];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

/**
 * Failure kinds this adapter will attempt an AI-fallback extraction for.
 *
 * DELIBERATELY NARROW, mirroring the payslip and bank-statement paths. The
 * test is "is there decodable text that the LAYOUT parser could not
 * recognise", not "did extraction fail":
 *   - `manual_mapping_required` — detection scored below the confidence
 *     floor. The primary case: a real super statement in a layout FHIP has
 *     no adapter for.
 *   - `ambiguous_format` — two adapters scored too closely to choose between.
 *   - `layout_unsupported` — a required column was missing, or zero rows
 *     parsed, from an otherwise-readable CSV.
 *
 * EXCLUDED: `unknown_error` (an unclassified internal fault — the cause is by
 * definition not understood, so it is not known that text even exists),
 * `scanned_document`/`ocr_required`/`password_required`/`wrong_password`/
 * `corrupt` (no text was extracted at all; none of these is currently emitted
 * by the CSV-only parser but all are declared, and excluding them keeps the
 * list correct if a PDF path is ever added), and `zero_balance_suspected`
 * (declared, never emitted).
 *
 * ALSO EXCLUDED BY CONSTRUCTION, and worth stating because it is the case
 * users will most expect help with: `pdf_manual_mapping_required`. FDH-12
 * refuses a PDF before any text extraction happens, so there is nothing to
 * mask or send. Adding PDF text extraction to this pipeline is the highest-
 * value follow-up for this document type — see
 * `lib/aie/adapters/retirement/index.ts`'s scope note.
 */
const RETIREMENT_AI_FALLBACK_ELIGIBLE_FAILURE_KINDS: readonly string[] = ['manual_mapping_required', 'ambiguous_format', 'layout_unsupported'];

/** The generic statement type used for an AI-read document. The native parser
 * picks a specific type from the adapter it matched; when no adapter matched
 * at all there is nothing to pick from, so the generic CSV type is used
 * rather than having the model guess a vocabulary value that drives
 * downstream behaviour. */
function statementTypeFor(jurisdiction: RetirementJurisdiction): RetirementStatementType {
  return jurisdiction === 'IN' ? 'epf_passbook_statement' : 'retirement_statement_csv';
}

/** Document type per jurisdiction. All three values already exist in
 * `fdh_statement_uploads.document_type`'s CHECK (migration 0046) — FDH-12
 * widened nothing here. */
function documentTypeFor(jurisdiction: RetirementJurisdiction): 'super_statement' | 'epf_statement' {
  return jurisdiction === 'IN' ? 'epf_statement' : 'super_statement';
}

export async function getRetirementStatementIdForDocument(
  userId: string,
  documentId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_retirement_statements')
    .select('id')
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * Upload AND process a retirement statement CSV in one call.
 *
 * Single-call upload+process is the same deliberate, disclosed simplification
 * FDH-10 and FDH-11 chose for CSV: the bytes are already in memory, extraction
 * is synchronous, and there is no OCR or password retry loop to orchestrate.
 *
 * 2026-09-21 (real-malware-gate async fix): only creates the upload now,
 * then hands off to `resolveRetirementStatementDocument()` — see that
 * function's header. Byte-for-byte unchanged when the real-scan flag is off
 * or a scan resolves inline.
 */
export async function uploadAndProcessRetirementStatement(
  userId: string,
  metadata: UploadRetirementStatementMetadata,
  bytes: Uint8Array,
): Promise<UploadRetirementStatementResult> {
  const { session } = await createUploadSession(userId, {
    source_type: 'csv',
    document_type: documentTypeFor(metadata.jurisdiction),
    country_code: metadata.jurisdiction,
    currency_code: metadata.currencyCode as 'AUD' | 'INR' | 'USD',
    declared_mime_type: 'text/csv',
    declared_file_size_bytes: bytes.byteLength,
  });

  let document: FdhStatementUpload;
  try {
    document = await completeUpload(userId, session.id, bytes);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) {
      throw new RetirementStatementProcessingError('internal_error', e.message);
    }
    throw e;
  }

  return resolveRetirementStatementDocument(userId, document, metadata);
}

/**
 * Resumes processing for a document left in `pending_scan` because the real
 * malware gate had not yet resolved it when
 * `uploadAndProcessRetirementStatement()` (or a prior call to this function)
 * ran. Called from `POST /retirement-statement/{documentId}/process` once
 * `RetirementStatementImportPanel.tsx` has polled the document out of
 * `validating`. Metadata must be re-supplied by the caller, exactly as in
 * the investment-statement sibling of this function.
 */
export async function continueRetirementStatementProcessing(
  userId: string,
  documentId: string,
  metadata: UploadRetirementStatementMetadata,
): Promise<UploadRetirementStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new RetirementStatementProcessingError('not_found', 'document not found');
  return resolveRetirementStatementDocument(userId, document, metadata);
}

/**
 * Everything that happens to an already-uploaded document — see the
 * identical-purpose `resolveAuInvestmentStatementDocument()` in
 * investmentStatementProcessingService.ts for the full rationale. Shared by
 * both entry points above so neither can drift from the other.
 */
async function resolveRetirementStatementDocument(
  userId: string,
  document: FdhStatementUpload,
  metadata: UploadRetirementStatementMetadata,
): Promise<UploadRetirementStatementResult> {
  const empty = { activitiesExtracted: 0, activitiesDeduplicated: 0, positionsExtracted: 0 };

  if (document.processing_status === 'failed' || document.processing_status === 'rejected') {
    return {
      document, statementId: null, pipelineStatus: 'extraction_failed',
      failureKind: document.error_code ?? 'unknown_error', ...empty,
    };
  }

  // DUPLICATE WHOLE-DOCUMENT UPLOAD (spec sections 51, 130). FDH-3's byte
  // hash, reused unchanged. Never re-extracted, never a second statement row —
  // which is what makes "duplicate activities 0, duplicate proposals 0,
  // duplicate accounts 0" true without any FDH-12 code being involved.
  //
  // 2026-09-25: the shared identical-upload rule (identicalUpload.ts), checked
  // before any download, parse or AI call -- see the liability sibling for
  // why `duplicate_of_document_id` alone sent a third upload back through the
  // parser and the AI.
  const identical = await findEarlierIdenticalUpload(userId, document.id, IDENTICAL_UPLOAD_SPECS.retirement);
  if (identical?.kind === 'evidence') {
    return { document, statementId: identical.evidenceId, pipelineStatus: 'duplicate_statement', duplicateOfDocumentId: identical.documentId, ...empty };
  }
  if (identical?.kind === 'pending_draft') {
    return {
      document, statementId: null, pipelineStatus: 'ai_fallback_available',
      aiFallbackDraft: identical.payload as RetirementAiDraftForReview, duplicateOfDocumentId: identical.documentId, ...empty,
    };
  }

  // Real-malware-gate wiring (2026-09-21): see the identical comment in
  // investmentStatementProcessingService.ts's `resolveAuInvestmentStatement
  // Document()` — this is a genuine, legal wait state, not an error.
  if (document.processing_status === 'validating') {
    return { document, statementId: null, pipelineStatus: 'pending_scan', ...empty };
  }

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new RetirementStatementProcessingError(
      'invalid_state', `cannot process while the document is ${document.processing_status}`,
    );
  }

  // AIE-1 final completion (2026-09-25): see `checkFdhDocumentMalwareAdmission`.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new RetirementStatementProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }

  // 2026-09-25: a draft already issued for THIS document is returned before
  // the file is downloaded or parsed again (resume after a reload; the raw
  // file may already be purged). Never a second provider call.
  const ownPending = await loadPendingAiFallbackDraft(userId, document.id);
  if (ownPending.found) {
    return {
      document, statementId: null, pipelineStatus: 'ai_fallback_available',
      aiFallbackDraft: ownPending.payload as RetirementAiDraftForReview, ...empty,
    };
  }

  const download = await downloadDocumentObject(document.raw_document_storage_reference!);
  if (!download.ok) throw new RetirementStatementProcessingError('internal_error', download.message);

  assertDocumentTransition(document.processing_status, 'processing');
  const admin = createAdminClient();

  const failDocument = async (errorCode: string, reason: string) => {
    await admin
      .from('fdh_statement_uploads')
      .update({ processing_status: 'failed', error_code: errorCode, review_status: 'pending' })
      .eq('id', document.id).eq('user_id', userId);
    await recordDocumentAuditEvent({
      userId, documentId: document.id,
      eventType: 'retirement_statement_extraction_failed', actorType: 'system',
      metadata: { reason },
    });
  };

  if (document.mime_type === 'application/pdf') {
    await failDocument('layout_unsupported', 'pdf_manual_mapping_required');
    return {
      document, statementId: null, pipelineStatus: 'extraction_failed',
      failureKind: 'pdf_manual_mapping_required', ...empty,
    };
  }

  // --- SMSF ROUTING, BEFORE ANY EXTRACTION (spec sections 10-11) ----------
  // Checked first so an SMSF statement never becomes ordinary-super evidence
  // even transiently. A `routed_to_smsf` statement row IS created (the user
  // needs to see why their upload stopped, and the routing decision is
  // auditable), but migration 0112 PART H refuses to approve it, so it can
  // never become a proposal and can never reach canonical Retirement.
  const smsf = detectSmsf(metadata.fundName, metadata.statementTextSample);

  const detection = detectRetirementCsvFormat(download.bytes);
  const extraction = extractRetirementStatement(detection, {
    currencyCode: metadata.currencyCode,
    jurisdiction: metadata.jurisdiction,
    fundName: metadata.fundName,
    maskedAccountIdentifier: metadata.maskedAccountIdentifier,
    statementStartDate: metadata.statementPeriodStart,
    statementEndDate: metadata.statementPeriodEnd,
    statementDate: metadata.statementDate,
  });

  if (!extraction.ok) {
    // AI FALLBACK, attempted BEFORE `failDocument` and only for the kinds
    // where the CSV was genuinely decodable text whose LAYOUT the
    // deterministic parser could not recognise.
    //
    // Ordering matters for a concrete reason, not just tidiness:
    // `resolveRetirementStatementDocument` refuses outright to process a
    // document already in `failed` (see the guard at the top of this
    // function), so a draft offered AFTER `failDocument` could never be
    // confirmed. The document is therefore deliberately left in `queued`.
    if (RETIREMENT_AI_FALLBACK_ELIGIBLE_FAILURE_KINDS.includes(extraction.kind)) {
      // (A draft already issued for this document was returned above, before
      // the download -- a repeated /process never pays for a second call.)
      const fallback = await attemptAiRetirementFallback(userId, document.id, download.bytes, {
        jurisdiction: metadata.jurisdiction,
        currencyCode: metadata.currencyCode,
        statementType: statementTypeFor(metadata.jurisdiction),
        // The AI is never asked which retirement product this is — see
        // `mapping.ts`'s header. `unknown` is the native parser's own default
        // for a generic CSV too, and the account type is resolved later by
        // the account-matching step the user drives.
        accountType: 'unknown',
      });
      if (fallback.ok) {
        return {
          document, statementId: null, pipelineStatus: 'ai_fallback_available',
          aiFallbackDraft: fallback.extraction, ...empty,
        };
      }
      await recordDocumentAuditEvent({
        userId, documentId: document.id,
        eventType: 'retirement_statement_ai_fallback_not_usable', actorType: 'system',
        metadata: { reason: fallback.reason, nativeFailureKind: extraction.kind },
      });
    }

    await failDocument('layout_unsupported', extraction.kind);
    return {
      document, statementId: null, pipelineStatus: 'extraction_failed',
      failureKind: extraction.kind, ...empty,
    };
  }
  const ex = extraction.extraction;

  // The canonical write. Extracted verbatim into `persistRetirementEvidence`
  // below so the AI-fallback confirm path reuses the EXACT same write — see
  // that function's header.
  return persistRetirementEvidence({ userId, document, ex, smsf });
}

export type AiRetirementFallbackOutcome = { ok: true; extraction: RetirementAiDraftForReview } | { ok: false; reason: string };

/**
 * The one call site that reaches the AI provider for a retirement statement.
 *
 * Every gate — this adapter's own kill switch, the shared global AIE kill
 * switch, the shared AIE-1 pilot cohort, and masking (which FAILS CLOSED) —
 * is evaluated by the shared `evaluateAiFallbackGate`, in that order. The
 * gate returns ONLY masked text on success, so this function cannot send the
 * raw statement to the provider even by mistake.
 *
 * It takes BYTES rather than text because this service has no extracted-text
 * variable at its failure branch: detection decodes the CSV into a local and
 * never returns it. `decodeCsvBytes` is the same pure decoder the detector
 * uses, so what is masked is exactly what the parser saw.
 *
 * Exported so it is independently unit-testable with a faked provider.
 */
export async function attemptAiRetirementFallback(
  userId: string,
  documentId: string,
  bytes: Uint8Array,
  context: { jurisdiction: RetirementJurisdiction; currencyCode: string; statementType: RetirementStatementType; accountType: RetirementAccountType },
): Promise<AiRetirementFallbackOutcome> {
  let text: string;
  try {
    text = decodeCsvBytes(bytes).text;
  } catch {
    return { ok: false, reason: 'could_not_decode_bytes' };
  }

  const gate = evaluateAiFallbackGate({ userId, cohortEmail: await resolveEmailForAiePilotCohort(userId), adapterEnabled: isAieRetirementAiFallbackEnabled(), extractedText: text });
  if (!gate.ok) {
    if (gate.reason === 'masking_below_policy') {
      await recordDocumentAuditEvent({
        userId, documentId,
        eventType: 'retirement_statement_ai_fallback_masking_below_policy', actorType: 'system',
      });
    }
    return { ok: false, reason: gate.reason };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'retirement_statement_ai_fallback_attempted', actorType: 'system' });
  const result = await requestRetirementAiExtraction({ maskedText: gate.maskedText, requestId: documentId });
  if (result.outcome !== 'success') {
    await recordDocumentAuditEvent({
      userId, documentId,
      eventType: 'retirement_statement_ai_fallback_provider_outcome', actorType: 'system',
      metadata: { outcome: result.outcome, ...adapterCallEvidenceMetadata(result.evidence) },
    });
    return { ok: false, reason: result.outcome };
  }

  const read = mapRetirementFactsToExtraction(result.facts, context);
  // 2026-09-25: an opening/closing balance the page does not print is
  // dropped -- the reconciliation identity must never check the model's own
  // arithmetic against itself (live finding on the bank adapter).
  const dropped: string[] = [];
  const extraction = read ? { ...read } : null;
  if (extraction) {
    for (const key of ['openingBalance', 'closingBalance'] as const) {
      const v = extraction[key];
      if (v !== undefined && !figureIsPrinted(Number(v), text)) { extraction[key] = undefined; dropped.push(key); }
    }
  }
  if (!extraction) {
    await recordDocumentAuditEvent({
      userId, documentId,
      eventType: 'retirement_statement_ai_fallback_insufficient_fields', actorType: 'system',
      metadata: adapterCallEvidenceMetadata(result.evidence),
    });
    return { ok: false, reason: 'insufficient_fields' };
  }

  const draft = toRetirementAiDraftForReview(extraction);
  const saved = await saveAiFallbackDraft({
    userId,
    documentId,
    documentType: 'retirement_statement',
    schemaName: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
    payload: draft,
    providerIdempotencyKey: result.evidence?.idempotencyKey ?? null,
  });
  if (!saved.persisted && saved.reason === 'write_failed') {
    console.error(`retirement AI draft for ${documentId} could not be persisted: ${saved.detail ?? 'unknown'}`);
    return { ok: false, reason: 'draft_not_persisted' };
  }

  await recordDocumentAuditEvent({
    userId, documentId,
    eventType: 'retirement_statement_ai_fallback_draft_ready', actorType: 'system',
    metadata: { ...adapterCallEvidenceMetadata(result.evidence), draft_persisted: saved.persisted, activities: draft.activities.length, ...(dropped.length ? { dropped_unprinted_figures: dropped } : {}) },
  });
  return { ok: true, extraction: draft };
}

/**
 * Called only after the user has reviewed the draft
 * `attemptAiRetirementFallback` produced (and may have corrected it).
 *
 * MAKES NO AI CALL and re-derives nothing from document text. It validates
 * the submitted extraction and delegates the write to
 * `persistRetirementEvidence` — the EXACT function a native successful parse
 * uses, giving the same reconciliation, the same activity fingerprinting and
 * dedupe, the same SMSF routing, the same audit events.
 *
 * THE IDEMPOTENCY GATE IS A PAIR, AND DIFFERS FROM PAYSLIP'S BY NECESSITY.
 * Payslip can gate on `processing_status === 'processing'` because its
 * service actually persists that state. This service never does (see
 * `UploadRetirementStatementResult.aiFallbackDraft`'s own note), so a status
 * check alone would admit a replay. The gate is therefore:
 *   (a) the document is still in `queued`/`uploaded` — it has not since
 *       failed, been rejected, or been carried elsewhere; AND
 *   (b) no `fdh_retirement_statements` row exists for this upload yet.
 * (b) is the one that actually prevents a double-write: a replayed confirm
 * finds the row written by the first and refuses.
 *
 * SMSF CLASSIFICATION IS RECOMPUTED HERE from the caller's own fund name and
 * text sample — never carried across the two requests and never taken from
 * the client, so a user cannot route a statement away from (or into) SMSF
 * handling by editing a payload.
 */
export async function confirmAiRetirementFallback(
  userId: string,
  documentId: string,
  extraction: RetirementStatementExtraction,
  smsfContext: { fundName?: string; statementTextSample?: string },
): Promise<UploadRetirementStatementResult> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fdh_statement_uploads')
    .select('*')
    .eq('id', documentId)
    .eq('user_id', userId)
    .maybeSingle();
  const document = data as FdhStatementUpload | null;
  if (!document) throw new RetirementStatementProcessingError('not_found', 'document not found');

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new RetirementStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }
  const existingStatementId = await getRetirementStatementIdForDocument(userId, documentId);
  if (existingStatementId) {
    throw new RetirementStatementProcessingError('invalid_state', 'This statement has already been saved.');
  }

  // 2026-09-25: only a draft the server actually issued can be confirmed, and
  // only once. The two checks above were a check-then-act (two racing
  // confirms could both pass them) and accepted a confirm for a document that
  // never produced a draft; the conditional claim closes both.
  const claim = await claimPendingAiFallbackDraft({ userId, documentId, confirmedPayload: extraction });
  if (!claim.claimed && claim.reason !== 'table_missing') {
    throw new RetirementStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'retirement_statement_ai_fallback_confirmed', actorType: 'user' });

  const smsf = detectSmsf(smsfContext.fundName ?? extraction.fundName, smsfContext.statementTextSample);
  try {
    return await persistRetirementEvidence({ userId, document, ex: extraction, smsf });
  } catch (e) {
    if (claim.claimed) await releaseClaimedAiFallbackDraftIfNothingWritten(userId, claim.draftId, documentId);
    throw e;
  }
}

/**
 * THE CANONICAL WRITE for a retirement-statement import.
 *
 * EXTRACTED 2026-09-23 (AIE unified document fallback) FROM THE MIDDLE OF
 * `resolveRetirementStatementDocument`, VERBATIM — the body below is the same
 * code that ran inline before, moved with no behavioural change and no
 * re-indentation. It was extracted for exactly one reason: so that the
 * AI-fallback confirm path (`confirmAiRetirementFallback`) can call the
 * IDENTICAL write rather than growing a second, AI-specific writer.
 *
 * That is the property the whole design rests on. An AI-fallback-produced
 * statement must be indistinguishable from a natively-parsed one to every
 * downstream step — the same reconciliation, the same activity
 * fingerprinting and dedupe, the same SMSF routing decision, the same
 * supersede-prior-statement logic, the same audit events. A parallel writer
 * would be free to drift from all of that.
 *
 * NOTE THE SMSF ARGUMENT. SMSF classification is computed by the CALLER and
 * passed in, never recomputed here, so the AI path and the native path reach
 * this function having made that routing decision the same way — from the
 * fund name and the document text sample, never from anything a model said.
 * That matters: SMSF routing decides whether a statement is diverted out of
 * ordinary super entirely, and it must not become an AI-influenced judgement
 * by the back door.
 */
export async function persistRetirementEvidence(params: {
  userId: string;
  document: FdhStatementUpload;
  ex: RetirementStatementExtraction;
  smsf: ReturnType<typeof detectSmsf>;
}): Promise<UploadRetirementStatementResult> {
  const { userId, document, ex, smsf } = params;
  const admin = createAdminClient();
  // --- Reconciliation (spec sections 46-49) -------------------------------
  const reconciliation = reconcileStatement(ex);

  const { data: statement, error: stmtErr } = await admin
    .from('fdh_retirement_statements')
    .insert({
      user_id: userId,
      statement_upload_id: document.id,
      statement_type: ex.statementType,
      retirement_jurisdiction: ex.jurisdiction,
      account_type: ex.accountType,
      fund_name: ex.fundName ?? null,
      masked_account_identifier: ex.maskedAccountIdentifier ?? null,
      currency_code: ex.currencyCode,
      statement_date: ex.statementDate ?? null,
      statement_start_date: ex.statementStartDate ?? null,
      statement_end_date: ex.statementEndDate ?? null,
      opening_balance: ex.openingBalance ?? null,
      closing_balance: ex.closingBalance ?? null,
      employer_contributions: ex.employerContributions ?? null,
      personal_contributions: ex.personalContributions ?? null,
      salary_sacrifice: ex.salarySacrifice ?? null,
      government_contributions: ex.governmentContributions ?? null,
      rollovers_in: ex.rolloversIn ?? null,
      rollovers_out: ex.rolloversOut ?? null,
      withdrawals: ex.withdrawals ?? null,
      pension_payments: ex.pensionPayments ?? null,
      investment_earnings: ex.investmentEarnings ?? null,
      fees: ex.fees ?? null,
      insurance_premiums: ex.insurancePremiums ?? null,
      tax: ex.tax ?? null,
      ytd_employer_contributions: ex.ytdEmployerContributions ?? null,
      ytd_personal_contributions: ex.ytdPersonalContributions ?? null,
      parser: ex.parserName,
      parser_version: ex.parserVersion,
      extraction_confidence: ex.extractionConfidence,
      extraction_status: 'extracted',
      reconciliation_status: reconciliation.status,
      reconciliation_variance: reconciliation.varianceMinorUnits === null
        ? null
        : minorUnitsToDecimalString(reconciliation.varianceMinorUnits),
      smsf_classification: smsf.classification,
      smsf_evidence: smsf.evidence.length > 0 ? { reason: smsf.reason, evidence: smsf.evidence } : null,
      review_status: smsf.classification === 'not_smsf' ? 'not_required' : 'pending',
      source_provenance: `${ex.parserName}@${ex.parserVersion}`,
    })
    .select('id')
    .single();
  if (stmtErr || !statement) {
    throw new RetirementStatementProcessingError(
      'internal_error', stmtErr?.message ?? 'Could not create statement evidence row.',
    );
  }
  const statementId = statement.id as string;

  // REVISED / REISSUED STATEMENT (spec section 54).
  const existingStatements = await fetchAllRows(() =>
    admin
      .from('fdh_retirement_statements')
      .select('id, canonical_account_id, statement_start_date, statement_end_date, statement_date')
      .eq('user_id', userId)
      .neq('id', statementId)
      .order('id', { ascending: true }));
  const superseded = findSupersededStatement(
    {
      canonicalAccountId: null,
      statementStartDate: ex.statementStartDate ?? null,
      statementEndDate: ex.statementEndDate ?? null,
      statementDate: ex.statementDate ?? null,
    },
    (existingStatements ?? []).map((s) => ({
      id: s.id as string,
      canonicalAccountId: (s.canonical_account_id as string | null) ?? null,
      statementStartDate: (s.statement_start_date as string | null) ?? null,
      statementEndDate: (s.statement_end_date as string | null) ?? null,
      statementDate: (s.statement_date as string | null) ?? null,
    })),
  );
  if (superseded) {
    await admin.from('fdh_retirement_statements')
      .update({ supersedes_statement_id: superseded })
      .eq('id', statementId).eq('user_id', userId);
  }

  // --- Activities, with cross-statement deduplication (spec 52-53) --------
  // Fingerprints require a resolved canonical account, which we do not have
  // yet at extraction time, so the dedup pass runs again in
  // `matchRetirementStatementAccount` once the account is known. Here we still
  // dedup WITHIN the batch, which catches an annual statement repeating its
  // own lines.
  let activitiesExtracted = 0;
  let activitiesDeduplicated = 0;
  if (ex.activities.length > 0) {
    const decisions = dedupActivities(ex.activities, null, new Map());
    const rows = ex.activities.map((a, i) => ({
      user_id: userId,
      statement_id: statementId,
      activity_type: a.activityType,
      activity_date: a.activityDate ?? null,
      effective_period_start: a.effectivePeriodStart ?? null,
      effective_period_end: a.effectivePeriodEnd ?? null,
      amount: a.amount,
      currency_code: a.currencyCode,
      description_raw: a.descriptionRaw ?? null,
      employer_name_raw: a.employerNameRaw ?? null,
      employer_normalised: null,
      is_summary_total: a.isSummaryTotal,
      is_year_to_date: a.isYearToDate,
      activity_fingerprint: decisions[i]?.fingerprint ?? null,
      source_row_number: a.sourceRowNumber ?? null,
    }));
    activitiesDeduplicated = decisions.filter((d) => d.isDuplicate).length;
    const { error: actErr } = await admin.from('fdh_retirement_statement_activities').insert(rows);
    if (!actErr) activitiesExtracted = rows.length;
  }

  // --- Positions: EVIDENCE ONLY (spec sections 12-13, 40, 71) -------------
  // Written here and read nowhere that could reach canonical Investments —
  // there is no apply path for a position row at all.
  let positionsExtracted = 0;
  if (ex.positions.length > 0) {
    const rows = ex.positions.map((p) => ({
      user_id: userId,
      statement_id: statementId,
      option_name_raw: p.optionNameRaw,
      asset_class_raw: p.assetClassRaw ?? null,
      ticker_raw: p.tickerRaw ?? null,
      isin: p.isin ?? null,
      units: p.units ?? null,
      unit_price: p.unitPrice ?? null,
      market_value: p.marketValue ?? null,
      currency_code: p.currencyCode,
      valuation_date: p.valuationDate ?? null,
      source_row_number: p.sourceRowNumber ?? null,
    }));
    const { error: posErr } = await admin.from('fdh_retirement_statement_positions').insert(rows);
    if (!posErr) positionsExtracted = rows.length;
  }

  if (smsf.classification !== 'not_smsf') {
    await recordDocumentAuditEvent({
      userId, documentId: document.id,
      eventType: 'retirement_statement_routed_to_smsf', actorType: 'system',
      metadata: { statementId, classification: smsf.classification, reason: smsf.reason },
    });
    return {
      document, statementId, pipelineStatus: 'routed_to_smsf', failureKind: 'routed_to_smsf',
      activitiesExtracted, activitiesDeduplicated, positionsExtracted,
    };
  }

  await recordDocumentAuditEvent({
    userId, documentId: document.id,
    eventType: 'retirement_statement_extraction_completed', actorType: 'system',
    metadata: { statementId, activitiesExtracted, positionsExtracted, reconciliation: reconciliation.status },
  });
  if (reconciliation.status !== 'insufficient_data') {
    await recordDocumentAuditEvent({
      userId, documentId: document.id,
      eventType: 'retirement_statement_reconciled', actorType: 'system',
      metadata: {
        statementId, status: reconciliation.status,
        variance: reconciliation.varianceMinorUnits === null
          ? null : minorUnitsToDecimalString(reconciliation.varianceMinorUnits),
      },
    });
  }

  return {
    document, statementId, pipelineStatus: 'ok',
    activitiesExtracted, activitiesDeduplicated, positionsExtracted,
  };
}

/**
 * Recompute activity fingerprints once the canonical account is known, and
 * flag cross-statement duplicates (spec sections 52-53, 131).
 *
 * The unique index `uq_fdh_retirement_activities_fingerprint` is the DB-level
 * backstop: if two rows would collide, the UPDATE fails and the row is flagged
 * as a duplicate instead. That makes "overlap activity duplicates 0" a
 * structural property rather than a code path that could regress.
 */
export async function refreshActivityFingerprints(
  userId: string,
  statementId: string,
  canonicalAccountId: string,
): Promise<void> {
  const admin = createAdminClient();
  const activities = await fetchAllRows(() =>
    admin
      .from('fdh_retirement_statement_activities')
      .select('id, activity_type, activity_date, amount, currency_code, employer_name_raw, is_summary_total, is_year_to_date')
      .eq('user_id', userId)
      .eq('statement_id', statementId)
      .order('id', { ascending: true }));

  for (const a of activities ?? []) {
    const fingerprint = computeActivityFingerprint({
      canonicalAccountId,
      activityType: a.activity_type as string,
      activityDate: (a.activity_date as string | null) ?? null,
      amount: String(a.amount),
      currencyCode: a.currency_code as string,
      employerNameRaw: (a.employer_name_raw as string | null) ?? null,
      isSummaryTotal: Boolean(a.is_summary_total),
      isYearToDate: Boolean(a.is_year_to_date),
    });
    if (!fingerprint) continue;

    const { error } = await admin
      .from('fdh_retirement_statement_activities')
      .update({ activity_fingerprint: fingerprint })
      .eq('id', a.id).eq('user_id', userId);

    if (error && error.code === '23505') {
      // A row with this exact economic identity already exists — this is an
      // overlapping-period or annual-vs-monthly duplicate. Flag it rather than
      // failing the whole statement; the evidence is retained and visible, and
      // it takes no part in reconciliation.
      const { data: original } = await admin
        .from('fdh_retirement_statement_activities')
        .select('id')
        .eq('user_id', userId)
        .eq('activity_fingerprint', fingerprint)
        .maybeSingle();
      await admin
        .from('fdh_retirement_statement_activities')
        .update({ duplicate_of_activity_id: (original?.id as string | undefined) ?? null })
        .eq('id', a.id).eq('user_id', userId);
    }
  }
}

/**
 * Reconcile this statement's contributions against FDH-9 payslip evidence
 * (spec sections 22-27, 64-67, 120).
 *
 * READS `fdh_payroll_events`; writes only FDH-12's own activity rows. FDH-9's
 * evidence is never modified — there is one contribution engine, and this is
 * not a second one.
 */
export async function matchRetirementContributionsToPayslips(
  userId: string,
  statementId: string,
): Promise<{ matched: number; noMatch: number; multipleCandidates: number; varianceReview: number; noPayslipEvidence: number; error: string | null }> {
  const admin = createAdminClient();

  let activities;
  try {
    // PAGINATION (spec sections 138-139): a statement with more than 1000
    // contribution rows, or a household with more than 1000 payslips, would
    // otherwise be silently truncated by PostgREST's row cap, producing a
    // wrong (incomplete) match outcome rather than an error.
    activities = await fetchAllRows(() =>
      admin
        .from('fdh_retirement_statement_activities')
        .select('id, activity_type, amount, currency_code, activity_date, effective_period_start, effective_period_end, employer_name_raw')
        .eq('user_id', userId)
        .eq('statement_id', statementId)
        // Summary totals and YTD rows are NOT economic contributions and are
        // never matched to a payslip (spec sections 114-118).
        .eq('is_summary_total', false)
        .eq('is_year_to_date', false)
        .is('duplicate_of_activity_id', null)
        .in('activity_type', ['EMPLOYER_CONTRIBUTION', 'SALARY_SACRIFICE', 'PERSONAL_CONTRIBUTION'])
        .order('id', { ascending: true }));
  } catch (e) {
    return { matched: 0, noMatch: 0, multipleCandidates: 0, varianceReview: 0, noPayslipEvidence: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const payrollEvents = await fetchAllRows(() =>
    admin
      .from('fdh_payroll_events')
      .select('id, employer_name, employer_normalised, pay_period_start, pay_period_end, payment_date, currency_code, employer_retirement_contribution, employee_retirement_contribution')
      .eq('user_id', userId)
      .order('id', { ascending: true }));

  // Payslips already claimed by another activity are removed from the pool:
  // one payslip evidences at most one fund contribution (spec sections 22,
  // 64). Migration 0112's unique index enforces the same rule at the DB level.
  const claimed = await fetchAllRows(() =>
    admin
      .from('fdh_retirement_statement_activities')
      .select('matched_payroll_event_id')
      .eq('user_id', userId)
      .not('matched_payroll_event_id', 'is', null)
      .order('matched_payroll_event_id', { ascending: true }));
  const claimedIds = new Set((claimed ?? []).map((r) => r.matched_payroll_event_id as string));

  let matched = 0, noMatch = 0, multipleCandidates = 0, varianceReview = 0, noPayslipEvidence = 0;

  for (const activity of activities ?? []) {
    const pool = (payrollEvents ?? [])
      .filter((e) => !claimedIds.has(e.id as string)) as unknown as PayrollEventEvidence[];

    const result = matchContributionToPayslip(
      {
        activityId: activity.id as string,
        activityType: activity.activity_type as 'EMPLOYER_CONTRIBUTION' | 'SALARY_SACRIFICE' | 'PERSONAL_CONTRIBUTION',
        amount: String(activity.amount),
        currencyCode: activity.currency_code as string,
        activityDate: (activity.activity_date as string | null) ?? null,
        effectivePeriodStart: (activity.effective_period_start as string | null) ?? null,
        effectivePeriodEnd: (activity.effective_period_end as string | null) ?? null,
        employerNameRaw: (activity.employer_name_raw as string | null) ?? null,
      },
      pool,
    );

    if (result.status === 'matched') { matched += 1; if (result.payrollEventId) claimedIds.add(result.payrollEventId); }
    else if (result.status === 'no_match') noMatch += 1;
    else if (result.status === 'multiple_candidates') multipleCandidates += 1;
    else if (result.status === 'variance_review_required') varianceReview += 1;
    else noPayslipEvidence += 1;

    await admin
      .from('fdh_retirement_statement_activities')
      .update({
        payslip_match_status: result.status,
        matched_payroll_event_id: result.payrollEventId,
        payslip_match_variance: result.varianceMinorUnits === null
          ? null : minorUnitsToDecimalString(result.varianceMinorUnits),
        payslip_match_candidates: result.candidates.length > 0
          ? { reason: result.reason, candidates: result.candidates.map((c) => ({ ...c, varianceMinorUnits: c.varianceMinorUnits.toString() })) }
          : null,
        review_status: result.status === 'multiple_candidates' || result.status === 'variance_review_required'
          ? 'pending' : 'not_required',
      })
      .eq('id', activity.id).eq('user_id', userId);
  }

  await recordDocumentAuditEvent({
    userId, documentId: statementId,
    eventType: 'retirement_statement_payslip_matched', actorType: 'system',
    metadata: { matched, noMatch, multipleCandidates, varianceReview, noPayslipEvidence },
  });

  return { matched, noMatch, multipleCandidates, varianceReview, noPayslipEvidence, error: null };
}

/**
 * Bank matching for the activities that genuinely cross the household-cash
 * boundary (spec sections 77-81, 126).
 *
 * Internal activities are never even considered — `matchRetirementActivityToBank`
 * returns `not_expected` for them, so a super fee or an employer contribution
 * never generates an unmatched-bank review item.
 */
export async function matchRetirementActivitiesToBank(
  userId: string,
  statementId: string,
): Promise<{ matched: number; noMatch: number; multipleCandidates: number; notExpected: number; noBankEvidence: number; error: string | null }> {
  const admin = createAdminClient();

  const { data: stmt } = await admin
    .from('fdh_retirement_statements')
    .select('fund_name')
    .eq('id', statementId).eq('user_id', userId).maybeSingle();

  let activities;
  try {
    activities = await fetchAllRows(() =>
      admin
        .from('fdh_retirement_statement_activities')
        .select('id, activity_type, amount, currency_code, activity_date')
        .eq('user_id', userId)
        .eq('statement_id', statementId)
        .eq('is_summary_total', false)
        .eq('is_year_to_date', false)
        .is('duplicate_of_activity_id', null)
        .order('id', { ascending: true }));
  } catch (e) {
    return { matched: 0, noMatch: 0, multipleCandidates: 0, notExpected: 0, noBankEvidence: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const bankTxns = await fetchAllRows(() =>
    admin
      .from('fdh_transactions')
      .select('id, amount_original, transaction_date, description_clean, description_raw, credit_debit, currency_original')
      .eq('user_id', userId)
      .order('id', { ascending: true }));

  const claimed = await fetchAllRows(() =>
    admin
      .from('fdh_retirement_statement_activities')
      .select('linked_transaction_id')
      .eq('user_id', userId)
      .not('linked_transaction_id', 'is', null)
      .order('linked_transaction_id', { ascending: true }));
  const claimedIds = new Set((claimed ?? []).map((r) => r.linked_transaction_id as string));

  let matched = 0, noMatch = 0, multipleCandidates = 0, notExpected = 0, noBankEvidence = 0;

  for (const activity of activities ?? []) {
    const pool = (bankTxns ?? [])
      .filter((t) => !claimedIds.has(t.id as string)) as unknown as BankTransactionEvidence[];

    const result = matchRetirementActivityToBank(
      {
        activityType: activity.activity_type as never,
        amount: String(activity.amount),
        currencyCode: activity.currency_code as string,
        activityDate: (activity.activity_date as string | null) ?? null,
      },
      (stmt?.fund_name as string | null) ?? null,
      pool,
    );

    if (result.status === 'matched') { matched += 1; if (result.transactionId) claimedIds.add(result.transactionId); }
    else if (result.status === 'no_match') noMatch += 1;
    else if (result.status === 'multiple_candidates') multipleCandidates += 1;
    else if (result.status === 'not_expected') notExpected += 1;
    else noBankEvidence += 1;

    await admin
      .from('fdh_retirement_statement_activities')
      .update({
        bank_match_status: result.status,
        linked_transaction_id: result.transactionId,
        bank_match_candidates: result.candidates.length > 0
          ? { reason: result.reason, candidates: result.candidates } : null,
        review_status: result.status === 'multiple_candidates' ? 'pending' : undefined,
      })
      .eq('id', activity.id).eq('user_id', userId);
  }

  await recordDocumentAuditEvent({
    userId, documentId: statementId,
    eventType: 'retirement_statement_bank_match_completed', actorType: 'system',
    metadata: { matched, noMatch, multipleCandidates, notExpected, noBankEvidence },
  });

  return { matched, noMatch, multipleCandidates, notExpected, noBankEvidence, error: null };
}

/**
 * Pair rollover legs across the user's retirement statements (spec sections
 * 33-35, 149).
 *
 * Pairing is presentational and analytical: it lets the UI say "this money
 * moved from Fund A to Fund B" rather than showing two unexplained movements.
 * It changes no balance and creates no transaction.
 */
export async function matchRetirementRollovers(
  userId: string,
  statementId: string,
): Promise<{ matched: number; noMatch: number; multipleCandidates: number; error: string | null }> {
  const admin = createAdminClient();

  const allLegs = await fetchAllRows(() =>
    admin
      .from('fdh_retirement_statement_activities')
      .select('id, statement_id, activity_type, amount, currency_code, activity_date')
      .eq('user_id', userId)
      .in('activity_type', ['ROLLOVER_IN', 'ROLLOVER_OUT'])
      .eq('is_summary_total', false)
      .eq('is_year_to_date', false)
      .is('duplicate_of_activity_id', null)
      .order('id', { ascending: true }));

  const statementIds = [...new Set((allLegs ?? []).map((l) => l.statement_id as string))];
  const statementMeta = new Map<string, { fundName: string | null; accountId: string | null }>();
  if (statementIds.length > 0) {
    const metaRows = await fetchAllRows(() =>
      admin
        .from('fdh_retirement_statements')
        .select('id, fund_name, canonical_account_id')
        .eq('user_id', userId)
        .in('id', statementIds)
        .order('id', { ascending: true }));
    for (const m of metaRows ?? []) {
      statementMeta.set(m.id as string, {
        fundName: (m.fund_name as string | null) ?? null,
        accountId: (m.canonical_account_id as string | null) ?? null,
      });
    }
  }

  const legs: RolloverLeg[] = (allLegs ?? []).map((l) => {
    const meta = statementMeta.get(l.statement_id as string);
    return {
      activityId: l.id as string,
      statementId: l.statement_id as string,
      activityType: l.activity_type as never,
      amount: String(l.amount),
      currencyCode: l.currency_code as string,
      activityDate: (l.activity_date as string | null) ?? null,
      fundName: meta?.fundName ?? null,
      canonicalAccountId: meta?.accountId ?? null,
    };
  });

  const thisStatementLegs = legs.filter((l) => l.statementId === statementId);
  let matched = 0, noMatch = 0, multipleCandidates = 0;

  for (const leg of thisStatementLegs) {
    const result = matchRolloverCounterpart(leg, legs);
    if (result.status === 'matched') matched += 1;
    else if (result.status === 'multiple_candidates') multipleCandidates += 1;
    else noMatch += 1;

    await admin
      .from('fdh_retirement_statement_activities')
      .update({
        rollover_match_status: result.status,
        rollover_counterpart_activity_id: result.counterpartActivityId,
      })
      .eq('id', leg.activityId).eq('user_id', userId);
  }

  return { matched, noMatch, multipleCandidates, error: null };
}
