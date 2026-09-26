/**
 * FDH-11 — Australia Investment Statement Intelligence: upload + processing
 * orchestration (spec sections 15-16, 19-25, 54-58, 90). The EIGHTH FDH file
 * approved to use the service-role client (see
 * `tests/unit/fdh1Isolation.test.ts`'s "uses the service-role client ONLY in
 * the eight ... documented files"), following the exact same carve-out
 * `bankCsvProcessingService.ts` / `bankPdfProcessingService.ts` /
 * `liabilityStatementProcessingService.ts` already established.
 *
 * SINGLE-CALL UPLOAD+PROCESS — the same deliberate, disclosed simplification
 * FDH-10 chose for CSV credit-card/loan statements (this file's header
 * comment on `liabilityStatementProcessingService.ts` explains the
 * rationale in full: bytes are already in memory, extraction is synchronous
 * for CSV, no OCR/password retry loop is needed). Byte-safe intake reuses
 * FDH-3's `createUploadSession`/`completeUpload` UNCHANGED — no new upload
 * framework (spec section 19).
 *
 * SCOPE (honestly disclosed — see FDH11_REUSE_AND_GAP_AUDIT.md). CSV
 * investment statements via the two certified generic adapters
 * (`lib/financial-data-hub/investment/adapters/`) only. No AU broker PDF
 * adapter is certified in this pass — a PDF upload here fails with
 * `manual_mapping_required`, never a silent "0 holdings" (spec section 22).
 *
 * NO CANONICAL WRITE HAPPENS HERE (spec sections 63-65). This file only
 * ever writes `fdh_investment_statements` / `_positions` / `_activities` —
 * it never imports Investment Intelligence and never touches an `ii_*`
 * table (mechanically enforced by `tests/unit/fdh11Isolation.test.ts`).
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
import { detectAuInvestmentCsvFormat } from '../investment/detection';
import { extractAuTransactionsFromCsv, extractAuPositionsFromCsv, summariseExtractionWarnings } from '../investment/csvExtraction';
import { reconcileAuStatementTotals } from '../investment/statementTotals';
import {
  matchBankBrokerEvent,
  buildBrokerNarrativeSignal,
  narrativeNamesSecurity,
  AU_ISSUER_PAID_ACTIVITY_TYPES,
  AU_ACTIVITY_BANK_DIRECTION,
  AU_ACTIVITY_BANK_LEG_TYPE,
  AU_ACTIVITY_MATCH_PRIORITY,
  type BankTransactionCandidate,
  type BrokerAliasSet,
} from '../investment/bankMatching';
import type {
  AuStatementTransactionEvidence,
  AuStatementPositionEvidence,
  AuInvestmentStatementType,
  AuInvestmentStatementExtraction,
  AuInvestmentExtractionFailureKind,
  AuStatementTransactionType,
} from '../investment/types';
import type { FdhStatementUpload } from '../domain/types';
import { fetchAllRows } from '../bank-csv/pagination';
import { decodeCsvBytes } from '../bank-csv/csv';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { adapterCallEvidenceMetadata } from '@/lib/aie/adapters/shared/gateway';
import { AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME, AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/auInvestment/schema';
import { saveAiFallbackDraft, claimPendingAiFallbackDraft, releaseClaimedAiFallbackDraftIfNothingWritten, loadPendingAiFallbackDraft } from './aiFallbackDrafts';
import { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } from './identicalUpload';
import {
  isAieInvestmentStatementAiFallbackEnabled,
  requestAuInvestmentAiExtraction,
  mapAuInvestmentFactsToExtraction,
  AIE_AU_INVESTMENT_PARSER_NAME,
  AIE_AU_INVESTMENT_PARSER_VERSION,
  AIE_AU_INVESTMENT_EXTRACTION_CONFIDENCE,
  type AuInvestmentMappingContext,
} from '@/lib/aie/adapters/auInvestment';

export class AuInvestmentStatementProcessingError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state' | 'internal_error', message: string) {
    super(message);
    this.name = 'AuInvestmentStatementProcessingError';
  }
}

export const AU_INVESTMENT_STATEMENT_FAILURE_MESSAGES: Record<string, string> = {
  manual_mapping_required: "We couldn't recognise the layout of this statement. Please check the file, or add this investment manually.",
  ambiguous_format: 'This statement matches more than one known layout. Please check the file, or add this investment manually.',
  layout_unsupported: "We couldn't read this file as a statement export. Please check the file, or add this investment manually.",
  pdf_manual_mapping_required: 'PDF broker statements are not yet supported for automatic reading. Please add this investment manually, or try a CSV export from your broker.',
  unknown_error: 'Something went wrong while reading this statement.',
};

export interface UploadAuInvestmentStatementMetadata {
  csvKind: 'transaction' | 'portfolio';
  currencyCode: string;
  institutionName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
}

export interface UploadAuInvestmentStatementResult {
  document: FdhStatementUpload;
  statementId: string | null;
  // 'pending_scan' (2026-09-21, real-malware-gate async fix): the real
  // scanner (lib/aie/malware) has not yet resolved this upload -- the
  // document is genuinely, legally sitting in `validating`
  // (`malwareScanGate.ts`'s own documented resting state), not an error.
  // The caller (AuInvestmentStatementImportPanel.tsx) polls
  // `GET /financial-data-hub/documents/{id}` until the status leaves
  // `validating`, then calls `continueAuInvestmentStatementProcessing()`
  // (via the new `.../investment-statement/{id}/process` route) to finish.
  // 'ai_fallback_available' (2026-09-23, AIE unified document fallback): the
  // native CSV extractor could not read this layout, an AI read a DRAFT off
  // the same bytes, and NOTHING has been written -- no
  // `fdh_investment_statements` row, no positions, no activities, and
  // deliberately no `processing_status: 'failed'` either (see
  // `attemptAiAuInvestmentFallback`'s header for why that last one matters).
  // The caller shows the draft to the user and only an explicit confirm
  // (`confirmAiAuInvestmentFallback`) ever writes anything.
  pipelineStatus: 'ok' | 'extraction_failed' | 'duplicate_statement' | 'pending_scan' | 'ai_fallback_available';
  failureKind?: string;
  positionsExtracted: number;
  activitiesExtracted: number;
  /** Populated ONLY when `pipelineStatus === 'ai_fallback_available'`. */
  aiFallbackDraft?: AuInvestmentStatementAiFallbackDraft;
  /** 2026-09-25: set when this upload is a byte-identical copy of an earlier
   * one that already has a result; the caller carries on with THAT upload. */
  duplicateOfDocumentId?: string;
}

/**
 * What the review UI is shown, and what the confirm route accepts back.
 *
 * Deliberately the RAW READING — the security names, codes, units, prices,
 * dates and amounts as the model claims the page printed them — rather than a
 * persisted row or any derived verdict. Every derived value (the security
 * match, the holdings reconciliation, the bank match, the approval state) is
 * recomputed server-side from the reviewed rows AFTER the confirm, by the same
 * FDH-11 code a natively-parsed statement goes through. Nothing computed on
 * the client is ever trusted; the client can only supply what a human could
 * have typed off the page.
 *
 * Every numeric is an exact decimal STRING, matching
 * `AuStatementPositionEvidence`/`AuStatementTransactionEvidence` exactly — a
 * JS number would reintroduce float loss into a share registry's 6-decimal
 * unit holdings at the one boundary designed to prevent it.
 */
export interface AuInvestmentAiFallbackDraftHolding {
  securityNameRaw: string;
  tickerRaw: string | null;
  isin: string | null;
  quantity: string;
  unitPrice: string | null;
  marketValue: string | null;
  valuationDate: string;
}

export interface AuInvestmentAiFallbackDraftActivity {
  transactionType: AuStatementTransactionType;
  tradeDate: string | null;
  settlementDate: string | null;
  securityNameRaw: string | null;
  tickerRaw: string | null;
  quantity: string | null;
  unitPrice: string | null;
  /** Positive magnitude; meaning is carried by `transactionType`. */
  amount: string;
  brokerageRaw: string | null;
}

export interface AuInvestmentStatementAiFallbackDraft {
  holdings: AuInvestmentAiFallbackDraftHolding[];
  activities: AuInvestmentAiFallbackDraftActivity[];
  institutionName: string | null;
  statementDate: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  /** The model's own claim that it listed every printed row. Shown to the user
   * in words. Never the only completeness check — FDH-11's own holdings
   * reconciliation, run after the confirm, is. */
  allRowsListed: boolean;
  warnings: string[];
}

const STATEMENT_TYPE_BY_KIND: Record<'transaction' | 'portfolio', AuInvestmentStatementType> = {
  transaction: 'investment_transaction_csv',
  portfolio: 'portfolio_csv',
};

const DEFAULT_TRANSACTION_COLUMN_MAP = {
  date: 'Date', type: 'Type', amount: 'Amount', ticker: 'Code', isin: 'ISIN',
  securityName: 'Security Name', quantity: 'Quantity', price: 'Price', brokerage: 'Brokerage', settlementDate: 'Settlement Date',
  // WP-12 (INV-G7): the tax evidence columns were never mapped, so franking
  // credits and withholding tax were never extracted at all.
  frankingCredit: 'Franking Credit', withholdingTax: 'Withholding Tax',
};
const DEFAULT_PORTFOLIO_COLUMN_MAP = {
  securityName: 'Security Name', ticker: 'Code', isin: 'ISIN', quantity: 'Quantity', unitPrice: 'Price', marketValue: 'Market Value', valuationDate: 'Valuation Date',
};

/**
 * Native extraction failures this pipeline will attempt an AI fallback for.
 *
 * DELIBERATELY NARROW, mirroring the payslip and bank-statement paths' own
 * eligibility lists and their reasoning. The test is not "did extraction fail"
 * but "is there readable text that genuinely looks like an investment
 * statement the column-mapping extractor could not segment":
 *
 *   - `layout_unsupported` — the file decoded and has text, but no delimiter,
 *     no header row, no recognised columns or no determinable date format was
 *     found. This is the ONLY failure kind the FDH-11 CSV extractor actually
 *     emits for a readable file (`csvExtraction.ts` emits it at six distinct
 *     points), and it is exactly the case a reader can help with.
 *
 * EXCLUDED ON PURPOSE:
 *   - `unknown_error` — an exception of unknown provenance. It carries no
 *     evidence that the bytes are a statement at all, and an AI call on an
 *     arbitrary internal failure is pure spend.
 *   - `scanned_document`, `ocr_required`, `password_required`,
 *     `wrong_password`, `corrupt` — declared on the failure-kind union but
 *     never produced by this CSV-only pipeline. Each would mean NO READABLE
 *     TEXT WAS EVER OBTAINED, so there would be nothing to send.
 *   - `zero_holdings_suspected` — a successfully-read statement whose content
 *     is in question; re-reading it with a model answers a different question
 *     than the one being asked.
 *
 * `manual_mapping_required` and `ambiguous_format` ARE NOT LISTED HERE
 * DELIBERATELY, AND THE REASON IS WORTH RECORDING: both are declared on
 * `AuInvestmentExtractionFailureKind` and both read like the ideal AI-fallback
 * trigger, but NEITHER IS REACHABLE IN THIS SERVICE. `detectAuInvestmentCsvFormat`'s
 * verdict is used only to choose between the transaction and portfolio column
 * maps — a failed detection falls through to the user's own declared
 * `csvKind` — and `csvExtraction.ts` never emits either kind. Keying a trigger
 * on them would produce a fallback path that looks wired and never fires once.
 * If a future adapter-registry change starts emitting them, add them here and
 * to the eligibility comment above at the same time.
 */
const AU_INVESTMENT_AI_FALLBACK_ELIGIBLE_KINDS: readonly AuInvestmentExtractionFailureKind[] = ['layout_unsupported'];

export async function getAuInvestmentStatementIdForDocument(userId: string, documentId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from('fdh_investment_statements').select('id').eq('user_id', userId).eq('statement_upload_id', documentId).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * Upload AND process an AU investment statement CSV in one call. Returns
 * the persisted document plus, on success, the new
 * `fdh_investment_statements.id`.
 *
 * 2026-09-21 (real-malware-gate async fix): this now only creates the
 * upload and hands off to `resolveAuInvestmentStatementDocument()` for
 * everything that happens next -- see that function's header for why. When
 * the real-scan flag is off (today's production default) or a scan
 * resolves inline, this is byte-for-byte the same single round trip it
 * always was.
 */
export async function uploadAndProcessAuInvestmentStatement(
  userId: string,
  metadata: UploadAuInvestmentStatementMetadata,
  bytes: Uint8Array,
): Promise<UploadAuInvestmentStatementResult> {
  const { session } = await createUploadSession(userId, {
    source_type: 'csv',
    document_type: 'investment_statement',
    country_code: 'AU',
    currency_code: metadata.currencyCode as 'AUD' | 'INR' | 'USD',
    declared_mime_type: 'text/csv',
    declared_file_size_bytes: bytes.byteLength,
  });

  let document: FdhStatementUpload;
  try {
    document = await completeUpload(userId, session.id, bytes);
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError) throw new AuInvestmentStatementProcessingError('internal_error', e.message);
    throw e;
  }

  return resolveAuInvestmentStatementDocument(userId, document, metadata);
}

/**
 * Resumes processing for a document `uploadAndProcessAuInvestmentStatement`
 * (or a prior call to this same function) already left in `pending_scan`
 * because the real malware gate had not yet resolved it. Called from
 * `POST /investment-statement/{documentId}/process` once
 * `AuInvestmentStatementImportPanel.tsx` has polled the document's status
 * and observed it leave `validating`. Metadata must be re-supplied by the
 * caller -- nothing here remembers it across the two calls, exactly like
 * the original single-call path never needed to remember the original
 * `bytes` (extraction always re-downloads from storage below).
 */
export async function continueAuInvestmentStatementProcessing(
  userId: string,
  documentId: string,
  metadata: UploadAuInvestmentStatementMetadata,
): Promise<UploadAuInvestmentStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new AuInvestmentStatementProcessingError('not_found', 'document not found');
  return resolveAuInvestmentStatementDocument(userId, document, metadata);
}

/**
 * Everything that happens to an already-uploaded document: the
 * failed/rejected short-circuit, duplicate detection, the real-malware-scan
 * `pending_scan` wait state, and (once genuinely clear to proceed) the CSV
 * detection/extraction/persistence that used to be inlined directly into
 * `uploadAndProcessAuInvestmentStatement()`. Shared by that function's
 * immediate path (flag off / a scan that resolved inline) and by
 * `continueAuInvestmentStatementProcessing()`'s deferred resumption path, so
 * neither can drift from the other.
 */
async function resolveAuInvestmentStatementDocument(
  userId: string,
  document: FdhStatementUpload,
  metadata: UploadAuInvestmentStatementMetadata,
): Promise<UploadAuInvestmentStatementResult> {
  if (document.processing_status === 'failed' || document.processing_status === 'rejected') {
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: document.error_code ?? 'unknown_error', positionsExtracted: 0, activitiesExtracted: 0 };
  }

  // Duplicate whole-document upload (spec sections 54, 106, 120) — the same
  // already-certified FDH-3 signal every FDH phase reuses. Never
  // re-extracted, never a second `fdh_investment_statements` row.
  //
  // 2026-09-25: the shared identical-upload rule (identicalUpload.ts), checked
  // before any download, parse or AI call -- see the liability sibling for
  // why `duplicate_of_document_id` alone sent a third upload back through the
  // parser and the AI.
  const identical = await findEarlierIdenticalUpload(userId, document.id, IDENTICAL_UPLOAD_SPECS.investment);
  if (identical?.kind === 'evidence') {
    return { document, statementId: identical.evidenceId, pipelineStatus: 'duplicate_statement', positionsExtracted: 0, activitiesExtracted: 0, duplicateOfDocumentId: identical.documentId };
  }
  if (identical?.kind === 'pending_draft') {
    return { document, statementId: null, pipelineStatus: 'ai_fallback_available', positionsExtracted: 0, activitiesExtracted: 0, aiFallbackDraft: identical.payload as AuInvestmentStatementAiFallbackDraft, duplicateOfDocumentId: identical.documentId };
  }

  // Real-malware-gate wiring (2026-09-21): `completeUpload()` left this
  // document genuinely, legally waiting in `validating` -- the scan has not
  // resolved yet (see `malwareScanGate.ts`'s own header on why FDH-3 has no
  // worker for this today beyond the cron sweep). This is NOT an error:
  // `assertDocumentTransition('validating', 'processing')` below would
  // correctly refuse the jump (documentLifecycle.ts has no such edge), and
  // reading the file's bytes to extract from it before the scan clears
  // would defeat the entire point of gating on the scan in the first place.
  // Report the wait state honestly instead of either throwing or silently
  // extracting an unscanned file.
  if (document.processing_status === 'validating') {
    return { document, statementId: null, pipelineStatus: 'pending_scan', positionsExtracted: 0, activitiesExtracted: 0 };
  }

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new AuInvestmentStatementProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  // AIE-1 final completion (2026-09-25): see `checkFdhDocumentMalwareAdmission`.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new AuInvestmentStatementProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }

  // 2026-09-25: a draft already issued for THIS document is returned before
  // the file is downloaded or parsed again (resume after a reload; the raw
  // file may already be purged).
  const ownPending = await loadPendingAiFallbackDraft(userId, document.id);
  if (ownPending.found) {
    return { document, statementId: null, pipelineStatus: 'ai_fallback_available', positionsExtracted: 0, activitiesExtracted: 0, aiFallbackDraft: ownPending.payload as AuInvestmentStatementAiFallbackDraft };
  }

  const download = await downloadDocumentObject(document.raw_document_storage_reference!);
  if (!download.ok) throw new AuInvestmentStatementProcessingError('internal_error', download.message);

  assertDocumentTransition(document.processing_status, 'processing');

  const admin = createAdminClient();

  if (document.mime_type === 'application/pdf') {
    await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', error_code: 'layout_unsupported', review_status: 'pending' }).eq('id', document.id).eq('user_id', userId);
    await recordDocumentAuditEvent({ userId, documentId: document.id, eventType: 'investment_statement_extraction_failed', actorType: 'system', metadata: { reason: 'pdf_manual_mapping_required' } });
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: 'pdf_manual_mapping_required', positionsExtracted: 0, activitiesExtracted: 0 };
  }

  const detection = detectAuInvestmentCsvFormat(download.bytes);
  const effectiveKind: 'transaction' | 'portfolio' = detection.status === 'detected' && detection.adapter ? detection.adapter.csvKind : metadata.csvKind;

  const extraction =
    effectiveKind === 'transaction'
      ? extractAuTransactionsFromCsv({ bytes: download.bytes, columnMap: DEFAULT_TRANSACTION_COLUMN_MAP, currencyCode: metadata.currencyCode, institutionName: metadata.institutionName, maskedAccountIdentifier: metadata.maskedAccountIdentifier, statementPeriodStart: metadata.statementPeriodStart, statementPeriodEnd: metadata.statementPeriodEnd, statementDate: metadata.statementDate })
      : extractAuPositionsFromCsv({ bytes: download.bytes, columnMap: DEFAULT_PORTFOLIO_COLUMN_MAP, currencyCode: metadata.currencyCode, institutionName: metadata.institutionName, maskedAccountIdentifier: metadata.maskedAccountIdentifier, statementDate: metadata.statementDate, defaultValuationDate: metadata.statementDate ?? new Date().toISOString().slice(0, 10) });

  if (!extraction.ok) {
    // AI FALLBACK (2026-09-23), attempted BEFORE the `failed` write below and
    // only for the failure kinds where the file genuinely decoded to readable
    // text that the COLUMN-MAPPING extractor could not segment.
    //
    // THE ORDERING IS NOT A PREFERENCE. `resolveAuInvestmentStatementDocument`
    // short-circuits at its very first line for any document already in
    // `failed`, so a draft offered after that write could never be confirmed —
    // the confirm path would find a document it is not allowed to touch. The
    // document is therefore left exactly as it is (still `queued`/`uploaded`)
    // until the user either confirms or walks away.
    //
    // DISCLOSED LIMITATION: because no status is written, a user who reloads
    // and re-submits the same document re-runs the native extraction and, if
    // still eligible, asks the provider again. The gateway's in-flight
    // idempotency (keyed on the document id) collapses concurrent retries but
    // not sequential ones, so a determined retry loop can bill more than once.
    // That is the same trade-off the no-parking-state divergence forces (see
    // `confirmAiAuInvestmentFallback`'s header) and is bounded by the cost
    // admission ledger rather than by this branch.
    if (AU_INVESTMENT_AI_FALLBACK_ELIGIBLE_KINDS.includes(extraction.kind)) {
      // (A draft already issued for this document was returned above, before
      // the download; that closes the "sequential retry bills again"
      // limitation disclosed above, for a re-upload of the same bytes too.)
      const fallback = await attemptAiAuInvestmentFallback(userId, document.id, decodeCsvBytes(download.bytes).text, {
        statementType: STATEMENT_TYPE_BY_KIND[effectiveKind],
        // CALLER CONTEXT ONLY — never the AI's impression of the page. The
        // currency comes from the upload session the user created, the
        // institution and masked account identifier from what they typed on
        // the form, the dates from the metadata they supplied.
        currencyCode: metadata.currencyCode,
        institutionName: metadata.institutionName,
        maskedAccountIdentifier: metadata.maskedAccountIdentifier,
        statementDate: metadata.statementDate,
        statementPeriodStart: metadata.statementPeriodStart,
        statementPeriodEnd: metadata.statementPeriodEnd,
        fallbackValuationDate: metadata.statementDate ?? new Date().toISOString().slice(0, 10),
      });
      if (fallback.ok) {
        return {
          document,
          statementId: null,
          pipelineStatus: 'ai_fallback_available',
          positionsExtracted: 0,
          activitiesExtracted: 0,
          aiFallbackDraft: fallback.draft,
        };
      }
      await recordDocumentAuditEvent({
        userId,
        documentId: document.id,
        eventType: 'investment_statement_ai_fallback_not_usable',
        actorType: 'system',
        metadata: { reason: fallback.reason, nativeFailureKind: extraction.kind },
      });
    }

    await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', error_code: 'layout_unsupported', review_status: 'pending' }).eq('id', document.id).eq('user_id', userId);
    await recordDocumentAuditEvent({ userId, documentId: document.id, eventType: 'investment_statement_extraction_failed', actorType: 'system', metadata: { reason: extraction.kind } });
    return { document, statementId: null, pipelineStatus: 'extraction_failed', failureKind: extraction.kind, positionsExtracted: 0, activitiesExtracted: 0 };
  }

  // The canonical write. Extracted verbatim into `persistAuInvestmentEvidence`
  // below so that the AI-fallback confirm path can reuse the EXACT same write
  // — see that function's header.
  const persisted = await persistAuInvestmentEvidence({
    userId,
    documentId: document.id,
    statementType: STATEMENT_TYPE_BY_KIND[effectiveKind],
    extraction: extraction.extraction,
  });

  return {
    document,
    statementId: persisted.statementId,
    pipelineStatus: 'ok',
    positionsExtracted: persisted.positionsExtracted,
    activitiesExtracted: persisted.activitiesExtracted,
  };
}

export interface PersistAuInvestmentEvidenceResult {
  statementId: string;
  positionsExtracted: number;
  activitiesExtracted: number;
}

/**
 * THE CANONICAL WRITE for an AU investment statement's evidence.
 *
 * Lifted VERBATIM out of `resolveAuInvestmentStatementDocument`, where it used
 * to be inlined, for exactly one reason: the AI-fallback confirm path
 * (`confirmAiAuInvestmentFallback`) must call the IDENTICAL write rather than
 * a second, parallel one. A second writer is how an AI-sourced row eventually
 * acquires a different column set, a different null-handling rule or a missing
 * audit event from a natively-parsed one — and the whole point of this design
 * is that an AI-fallback-produced statement is INDISTINGUISHABLE downstream
 * from a natively-parsed one.
 *
 * `statementType` is passed in by the caller (from the user's own declared
 * CSV kind) rather than read from `extraction.statementType`.
 *
 * Canonical-upload WP-12 (2026-09-27) deliberately changed the second quirk
 * this header used to record: a failed positions/activities insert no longer
 * leaves a "0 holdings" statement behind -- it removes the statement row and
 * throws (INV-G6). Positions are created `apply_status: 'pending'` (INV-G2),
 * the statement's own totals are reconciled, and the extractor's warnings are
 * persisted for the user to see.
 */
export async function persistAuInvestmentEvidence(params: {
  userId: string;
  documentId: string;
  statementType: AuInvestmentStatementType;
  extraction: AuInvestmentStatementExtraction;
}): Promise<PersistAuInvestmentEvidenceResult> {
  const { userId, documentId, statementType } = params;
  const ex = params.extraction;
  const admin = createAdminClient();

  // Canonical-upload WP-12 (INV-G6/INV-G8): the statement's own totals are
  // checked at persist (it used to stay 'insufficient_data' forever), and the
  // extractor's warnings are PERSISTED (0207's extraction_warnings), so every
  // row that could not be read is visible instead of silently gone.
  const totals = reconcileAuStatementTotals({
    currencyCode: ex.currencyCode,
    positionMarketValues: ex.positions.map((p) => p.marketValue ?? null),
    cashBalance: ex.cashBalance ?? null,
    closingPortfolioValue: ex.closingPortfolioValue ?? null,
  });
  const extractionWarnings = summariseExtractionWarnings(ex.warnings ?? [], statementType === 'portfolio_csv' ? 'portfolio' : 'transaction');

  const { data: statement, error: stmtErr } = await admin
    .from('fdh_investment_statements')
    .insert({
      user_id: userId,
      statement_upload_id: documentId,
      statement_type: statementType,
      institution_name: ex.institutionName ?? null,
      masked_account_identifier: ex.maskedAccountIdentifier ?? null,
      base_currency: ex.currencyCode,
      statement_date: ex.statementDate ?? null,
      statement_start_date: ex.statementPeriodStart ?? null,
      statement_end_date: ex.statementPeriodEnd ?? null,
      opening_portfolio_value: ex.openingPortfolioValue ?? null,
      closing_portfolio_value: ex.closingPortfolioValue ?? null,
      cash_balance: ex.cashBalance ?? null,
      parser: ex.parserName,
      parser_version: ex.parserVersion,
      extraction_confidence: ex.extractionConfidence,
      extraction_status: 'extracted',
      reconciliation_status: totals.status,
      extraction_warnings: extractionWarnings,
    })
    .select('id')
    .single();
  if (stmtErr || !statement) {
    throw new AuInvestmentStatementProcessingError('internal_error', stmtErr?.message ?? 'Could not create statement evidence row.');
  }
  const statementId = statement.id as string;

  // INV-G6: a failed positions/activities insert used to be SWALLOWED -- the
  // statement survived with "0 holdings". Now any failure removes the
  // statement row (its evidence children cascade) and throws, so the user sees
  // an error and can retry; nothing half-written is left to approve.
  const insertChunked = async (table: string, rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += EVIDENCE_INSERT_CHUNK) {
      const { error } = await admin.from(table).insert(rows.slice(i, i + EVIDENCE_INSERT_CHUNK));
      if (error) throw new Error(`${table}: ${error.message}`);
    }
  };

  const positionRows = ex.positions.map((p: AuStatementPositionEvidence) => ({
    user_id: userId, statement_id: statementId, security_name_raw: p.securityNameRaw, ticker_raw: p.tickerRaw ?? null,
    exchange: p.exchange ?? null, isin: p.isin ?? null, quantity: p.quantity, unit_price: p.unitPrice ?? null,
    market_value: p.marketValue ?? null, currency_code: p.currencyCode, valuation_date: p.valuationDate, source_row_number: p.sourceRowNumber ?? null,
    // INV-G2: the column default 'not_applicable' meant a position could
    // NEVER be applied (Apply selects 'pending'). Every position is now
    // created awaiting Apply, exactly like an activity.
    apply_status: 'pending',
  }));
  const activityRows = ex.transactions.map((t: AuStatementTransactionEvidence) => ({
    user_id: userId, statement_id: statementId, activity_type: t.transactionType, trade_date: t.tradeDate ?? null,
    settlement_date: t.settlementDate ?? null, security_name_raw: t.securityNameRaw ?? null, ticker_raw: t.tickerRaw ?? null,
    isin: t.isin ?? null, quantity: t.quantity ?? null, unit_price: t.unitPrice ?? null, amount: t.amount,
    currency_code: t.currencyCode, description_raw: t.descriptionRaw ?? null, brokerage_raw: t.brokerageRaw ?? null,
    franking_credit_raw: t.frankingCreditRaw ?? null, withholding_tax_raw: t.withholdingTaxRaw ?? null, source_row_number: t.sourceRowNumber ?? null,
  }));
  try {
    await insertChunked('fdh_investment_statement_positions', positionRows);
    await insertChunked('fdh_investment_statement_activities', activityRows);
  } catch (e) {
    await admin.from('fdh_investment_statements').delete().eq('id', statementId).eq('user_id', userId);
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_extraction_failed', actorType: 'system', metadata: { reason: 'evidence_insert_failed' } });
    throw new AuInvestmentStatementProcessingError('internal_error', `The statement lines could not be saved (${e instanceof Error ? e.message : String(e)}). Nothing was kept -- please try again.`);
  }
  const positionsExtracted = positionRows.length;
  const activitiesExtracted = activityRows.length;

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_extraction_completed', actorType: 'system', metadata: { statementId, positionsExtracted, activitiesExtracted, warningCodes: extractionWarnings.map((w) => w.code), reconciliation: totals.status } });

  return { statementId, positionsExtracted, activitiesExtracted };
}

/** Evidence rows are inserted in chunks: a 1,001-line statement is two calls, never a truncation. */
const EVIDENCE_INSERT_CHUNK = 500;

export type AiAuInvestmentFallbackOutcome = { ok: true; draft: AuInvestmentStatementAiFallbackDraft } | { ok: false; reason: string };

/**
 * The one call site that reaches the AI provider for an AU investment
 * statement.
 *
 * Every gate — this adapter's own kill switch
 * (`AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED`, default OFF), the shared
 * global AIE kill switch, the shared AIE-1 pilot cohort, and masking (which
 * FAILS CLOSED when the masking key is unset) — is evaluated by the shared
 * `evaluateAiFallbackGate`, in that order. The gate returns ONLY masked text
 * on success, so this function has no way to send the raw statement to the
 * provider even by mistake.
 *
 * WHAT IS SENT is the CSV text decoded from the same bytes the native
 * extractor just failed on (`decodeCsvBytes`) — this pipeline is CSV-only and
 * has no PDF/text-extraction stage of its own, so there is no other text to
 * send and no second decode to disagree with the first.
 *
 * WRITES NOTHING. It returns a draft for a human to look at. That is the
 * entire contract.
 *
 * Exported so it is independently unit-testable with a faked provider, and so
 * a live-DEV proof can exercise it directly.
 */
export async function attemptAiAuInvestmentFallback(
  userId: string,
  documentId: string,
  extractedText: string,
  context: AuInvestmentMappingContext,
): Promise<AiAuInvestmentFallbackOutcome> {
  const gate = evaluateAiFallbackGate({
    userId,
    cohortEmail: await resolveEmailForAiePilotCohort(userId),
    adapterEnabled: isAieInvestmentStatementAiFallbackEnabled(),
    extractedText,
  });
  if (!gate.ok) {
    if (gate.reason === 'masking_below_policy') {
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_ai_fallback_masking_below_policy', actorType: 'system' });
    }
    return { ok: false, reason: gate.reason };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_ai_fallback_attempted', actorType: 'system' });
  const result = await requestAuInvestmentAiExtraction({ maskedText: gate.maskedText, requestId: documentId });
  if (result.outcome !== 'success') {
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'investment_statement_ai_fallback_provider_outcome',
      actorType: 'system',
      metadata: { outcome: result.outcome, ...adapterCallEvidenceMetadata(result.evidence) },
    });
    return { ok: false, reason: result.outcome };
  }

  const mapped = mapAuInvestmentFactsToExtraction(result.facts, context);
  if (!mapped) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_ai_fallback_insufficient_fields', actorType: 'system', metadata: adapterCallEvidenceMetadata(result.evidence) });
    return { ok: false, reason: 'insufficient_fields' };
  }

  const draft: AuInvestmentStatementAiFallbackDraft = {
      // The draft carries only the RAW READING. Caller context (currency,
      // country, statement type, masked account identifier) is deliberately
      // NOT echoed to the client and not accepted back from it — the confirm
      // path re-establishes all of it server-side from the document itself.
      holdings: mapped.positions.map((p) => ({
        securityNameRaw: p.securityNameRaw,
        tickerRaw: p.tickerRaw ?? null,
        isin: p.isin ?? null,
        quantity: p.quantity,
        unitPrice: p.unitPrice ?? null,
        marketValue: p.marketValue ?? null,
        valuationDate: p.valuationDate,
      })),
      activities: mapped.transactions.map((t) => ({
        transactionType: t.transactionType,
        tradeDate: t.tradeDate ?? null,
        settlementDate: t.settlementDate ?? null,
        securityNameRaw: t.securityNameRaw ?? null,
        tickerRaw: t.tickerRaw ?? null,
        quantity: t.quantity ?? null,
        unitPrice: t.unitPrice ?? null,
        amount: t.amount,
        brokerageRaw: t.brokerageRaw ?? null,
      })),
      institutionName: mapped.institutionName ?? null,
      statementDate: mapped.statementDate ?? null,
      statementPeriodStart: mapped.statementPeriodStart ?? null,
      statementPeriodEnd: mapped.statementPeriodEnd ?? null,
      allRowsListed: !mapped.warnings.includes('ai_reported_rows_incomplete'),
      warnings: mapped.warnings,
  };
  // 2026-09-25: persisted BEFORE the user sees it (0197), as for payslips.
  const saved = await saveAiFallbackDraft({
    userId,
    documentId,
    documentType: 'investment_statement',
    schemaName: AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
    payload: draft,
    providerIdempotencyKey: result.evidence?.idempotencyKey ?? null,
  });
  if (!saved.persisted && saved.reason === 'write_failed') {
    console.error(`investment AI draft for ${documentId} could not be persisted: ${saved.detail ?? 'unknown'}`);
    return { ok: false, reason: 'draft_not_persisted' };
  }
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'investment_statement_ai_fallback_draft_ready',
    actorType: 'system',
    metadata: { ...adapterCallEvidenceMetadata(result.evidence), draft_persisted: saved.persisted, holdings: draft.holdings.length, activities: draft.activities.length },
  });
  return { ok: true, draft };
}

/** What the confirm route hands back after the user has reviewed (and
 * possibly pruned) the draft. Every numeric is an exact decimal string, and
 * every field is something a human could have typed off the page — there is
 * no field in which a client could smuggle a currency, a country, an account
 * identity, a reconciliation verdict or an approval. */
export interface ReviewedAuInvestmentEvidence {
  /** The user's own "statement contains" choice, carried back from the upload
   * form. Caller context, never AI-derived. Optional: when absent, the kind is
   * inferred from which table actually has rows. */
  csvKind?: 'transaction' | 'portfolio';
  holdings: readonly AuInvestmentAiFallbackDraftHolding[];
  activities: readonly AuInvestmentAiFallbackDraftActivity[];
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  statementDate: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
}

/**
 * Called only after the user has reviewed the draft
 * `attemptAiAuInvestmentFallback` produced (and may have pruned).
 *
 * MAKES NO AI CALL and re-reads nothing from the document. It takes the
 * reviewed raw rows, rebuilds the SAME `AuInvestmentStatementExtraction` shape
 * the native CSV extractor produces, and hands it to
 * `persistAuInvestmentEvidence` — the EXACT function a native successful parse
 * uses. Everything that happens afterwards (security matching, holdings
 * reconciliation, bank matching, the explicit approve and the explicit apply)
 * is untouched and unaware that a model was ever involved, which is precisely
 * the property that stops an AI-sourced statement being approved on weaker
 * evidence than a native one.
 *
 * THE RE-ENTRY GATE DIVERGES FROM THE PAYSLIP/BANK-STATEMENT REFERENCE, AND
 * THE DIVERGENCE IS REAL RATHER THAN COSMETIC — SO IT IS STATED, NOT PAPERED
 * OVER. Those two services park a document in `processing_status:
 * 'processing'` while a draft awaits confirmation, and their confirm routes
 * gate on exactly that state. THIS service never writes `'processing'` at all:
 * `resolveAuInvestmentStatementDocument` calls `assertDocumentTransition`
 * purely as a guard and writes no status on the success path either, so there
 * is no parking state to gate on and inventing one would change the native
 * path's own behaviour (and would collide with the `validating`/`pending_scan`
 * malware-gate states this pipeline already threads through that column).
 *
 * The gate used instead is a conjunction of two conditions that together mean
 * the same thing — "this document has not been decided yet":
 *   1. the document is still in `queued`/`uploaded` — it has not been failed,
 *      rejected, or moved on by anything else, and in particular it has not
 *      been failed by a later native attempt; and
 *   2. `getAuInvestmentStatementIdForDocument` returns null — no
 *      `fdh_investment_statements` row exists for it yet, which is the actual
 *      thing a double-confirm would duplicate.
 *
 * Condition 2 is the one that carries the weight: it is a check on the exact
 * artefact being created, not a proxy for it, so a replayed or concurrent
 * confirm finds the evidence already there and is refused. It is a
 * check-then-act rather than a DB constraint, so two confirms racing inside
 * the same few milliseconds could in principle both pass — the residual is
 * disclosed here rather than hidden, and the blast radius is a duplicate
 * evidence row for one document, which the user can see and which nothing
 * downstream auto-applies.
 */
export async function confirmAiAuInvestmentFallback(
  userId: string,
  documentId: string,
  reviewed: ReviewedAuInvestmentEvidence,
): Promise<UploadAuInvestmentStatementResult> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new AuInvestmentStatementProcessingError('not_found', 'document not found');

  if (!['queued', 'uploaded'].includes(document.processing_status)) {
    throw new AuInvestmentStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }
  const existingStatementId = await getAuInvestmentStatementIdForDocument(userId, documentId);
  if (existingStatementId) {
    throw new AuInvestmentStatementProcessingError('invalid_state', 'This statement has already been saved.');
  }
  if (reviewed.holdings.length === 0 && reviewed.activities.length === 0) {
    throw new AuInvestmentStatementProcessingError('invalid_state', 'At least one holding or transaction is required.');
  }

  // 2026-09-25: the conditional claim of the server-issued draft (0197)
  // closes the check-then-act race disclosed above, and refuses a confirm for
  // a document that never produced a draft.
  const claim = await claimPendingAiFallbackDraft({ userId, documentId, confirmedPayload: reviewed });
  if (!claim.claimed && claim.reason !== 'table_missing') {
    throw new AuInvestmentStatementProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'investment_statement_ai_fallback_confirmed', actorType: 'user' });

  // Statement kind: the user's own declared choice when supplied, otherwise
  // inferred from which table actually carries rows. Never the model's.
  const effectiveKind: 'transaction' | 'portfolio' =
    reviewed.csvKind ?? (reviewed.activities.length > 0 ? 'transaction' : 'portfolio');
  // CURRENCY IS TAKEN FROM THE DOCUMENT, NOT FROM THE REQUEST. The upload
  // session recorded it when the user created it, behind an authoritative
  // AU-home-country check at the upload route. A client cannot re-declare it
  // here, and the AUD default only ever applies to a legacy row that somehow
  // has none — this pipeline is AU-only by construction.
  const currencyCode = document.currency_code ?? 'AUD';
  const fallbackValuationDate = reviewed.statementDate ?? new Date().toISOString().slice(0, 10);

  const extraction: AuInvestmentStatementExtraction = {
    statementType: STATEMENT_TYPE_BY_KIND[effectiveKind],
    country: 'AU',
    currencyCode,
    institutionName: reviewed.institutionName ?? undefined,
    maskedAccountIdentifier: reviewed.maskedAccountIdentifier ?? undefined,
    statementDate: reviewed.statementDate ?? undefined,
    statementPeriodStart: reviewed.statementPeriodStart ?? undefined,
    statementPeriodEnd: reviewed.statementPeriodEnd ?? undefined,
    // Portfolio totals stay absent on this path, exactly as the mapping layer
    // leaves them: a total derived from the very rows being written is not
    // independent evidence, and leaving it null lets FDH-11's own
    // reconciliation report "insufficient data" honestly instead of checking
    // the rows against themselves.
    openingPortfolioValue: undefined,
    closingPortfolioValue: undefined,
    cashBalance: undefined,
    positions: reviewed.holdings.map((h, index) => ({
      securityNameRaw: h.securityNameRaw,
      tickerRaw: h.tickerRaw ?? undefined,
      exchange: undefined,
      isin: h.isin ?? undefined,
      quantity: h.quantity,
      unitPrice: h.unitPrice ?? undefined,
      marketValue: h.marketValue ?? undefined,
      currencyCode,
      valuationDate: h.valuationDate || fallbackValuationDate,
      // Row numbers are re-assigned from the reviewed order so a user who
      // removed a bogus line cannot leave a gap in the evidence's own
      // source-row numbering.
      sourceRowNumber: index + 1,
    })),
    transactions: reviewed.activities.map((a, index) => ({
      transactionType: a.transactionType,
      tradeDate: a.tradeDate ?? undefined,
      settlementDate: a.settlementDate ?? undefined,
      securityNameRaw: a.securityNameRaw ?? undefined,
      tickerRaw: a.tickerRaw ?? undefined,
      isin: undefined,
      quantity: a.quantity ?? undefined,
      unitPrice: a.unitPrice ?? undefined,
      amount: a.amount,
      currencyCode,
      descriptionRaw: undefined,
      brokerageRaw: a.brokerageRaw ?? undefined,
      frankingCreditRaw: undefined,
      withholdingTaxRaw: undefined,
      sourceRowNumber: index + 1,
    })),
    parserName: AIE_AU_INVESTMENT_PARSER_NAME,
    parserVersion: AIE_AU_INVESTMENT_PARSER_VERSION,
    // The same deliberately-lower-than-native confidence the draft carried:
    // the provenance of these rows does not improve because a human pressed
    // a button, and a reviewer looking at the evidence later should be able
    // to tell an AI-read statement from a column-mapped one.
    extractionConfidence: AIE_AU_INVESTMENT_EXTRACTION_CONFIDENCE,
    warnings: ['read_by_ai_fallback_not_native_parser', 'user_confirmed_ai_fallback_draft'],
  };

  let persisted: PersistAuInvestmentEvidenceResult;
  try {
    persisted = await persistAuInvestmentEvidence({
      userId,
      documentId,
      statementType: STATEMENT_TYPE_BY_KIND[effectiveKind],
      extraction,
    });
  } catch (e) {
    if (claim.claimed) await releaseClaimedAiFallbackDraftIfNothingWritten(userId, claim.draftId, documentId);
    throw e;
  }

  return {
    document,
    statementId: persisted.statementId,
    pipelineStatus: 'ok',
    positionsExtracted: persisted.positionsExtracted,
    activitiesExtracted: persisted.activitiesExtracted,
  };
}

// ===========================================================================
// Bank <-> broker matching, and the corroborated bank leg (canonical-upload
// WP-12, INV-G4). Queries only the Hub's own tables (`fdh_transactions`, the
// FDH-2 institution master) -- an intra-Hub reference, never an ii_ table.
// ===========================================================================

export interface AuBankMatchSummary {
  matched: number;
  noMatch: number;
  multipleCandidates: number;
  noBankEvidence: number;
  error: string | null;
}

/** Days either side of the trade/settlement date a bank leg may fall on. */
const BANK_MATCH_WINDOW_DAYS = 5;

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The AU broker institutions and their aliases (FDH-2 master, 0054). */
async function loadAuBrokerAliasSets(admin: ReturnType<typeof createAdminClient>): Promise<BrokerAliasSet[]> {
  const { data: institutions, error } = await admin
    .from('fdh_financial_institutions')
    .select('id, institution_code, institution_name')
    .eq('country_code', 'AU')
    .eq('institution_type', 'broker');
  if (error) throw new Error(`fdh_financial_institutions: ${error.message}`);
  const ids = (institutions ?? []).map((i) => i.id as string);
  if (ids.length === 0) return [];
  const { data: aliases, error: aliasErr } = await admin.from('fdh_institution_aliases').select('institution_id, alias_normalized').in('institution_id', ids);
  if (aliasErr) throw new Error(`fdh_institution_aliases: ${aliasErr.message}`);
  return (institutions ?? []).map((i) => ({
    institutionCode: i.institution_code as string,
    institutionName: i.institution_name as string,
    aliases: (aliases ?? []).filter((a) => a.institution_id === i.id).map((a) => String(a.alias_normalized)),
  }));
}

interface BankLegRow {
  id: string;
  amount_original: number;
  currency_original: string;
  credit_debit: string;
  transaction_date: string;
  description_clean: string | null;
  description_raw: string | null;
  merchant_raw: string | null;
  approval_status: string;
  dedup_status: string | null;
}

/**
 * Bank <-> broker matching for one statement's activities (spec sections
 * 66-71; rebuilt by WP-12 for INV-G4).
 *
 * What changed, each one a defect the audit found on main:
 *  - the institution/narrative signal is REAL (the statement's broker, via the
 *    FDH-2 alias master) -- it used to be a hard-coded `true`, which defeated
 *    the "never amount alone" rule;
 *  - only APPROVED, non-duplicate bank lines are candidates (it used to match
 *    every fdh_transactions row, pending ones included);
 *  - direction and currency must agree: a BUY is funded by a DEBIT in the
 *    statement's currency, a SELL / dividend arrives as a CREDIT;
 *  - BUY and SELL are matched (they were not even in the list), security
 *    transfers are not (they have no bank leg);
 *  - one bank line corroborates at most ONE activity: a line already claimed
 *    by another activity (this statement or any other) is not a candidate,
 *    and a broker-cash deposit claims its line before the BUY it funded;
 *  - an activity already matched keeps its match (re-running never flips it),
 *    so this is safe to call again whenever new bank lines are approved;
 *  - the audit event is recorded against the DOCUMENT, not the statement id.
 */
export async function matchAuStatementActivitiesToBank(userId: string, statementId: string): Promise<AuBankMatchSummary> {
  const admin = createAdminClient();
  const empty = (error: string | null): AuBankMatchSummary => ({ matched: 0, noMatch: 0, multipleCandidates: 0, noBankEvidence: 0, error });
  try {
    const { data: statement, error: stmtErr } = await admin
      .from('fdh_investment_statements')
      .select('id, statement_upload_id, institution_name, base_currency')
      .eq('id', statementId)
      .eq('user_id', userId)
      .maybeSingle();
    if (stmtErr) return empty(stmtErr.message);
    if (!statement) return empty('Statement not found.');

    // PAGINATION (spec section 93): every read pages past PostgREST's cap.
    const activities = await fetchAllRows<{ id: string; activity_type: string; amount: number; trade_date: string | null; settlement_date: string | null; currency_code: string; bank_match_status: string; linked_transaction_id: string | null; ticker_raw: string | null; security_name_raw: string | null }>(() =>
      admin
        .from('fdh_investment_statement_activities')
        .select('id, activity_type, amount, trade_date, settlement_date, currency_code, bank_match_status, linked_transaction_id, ticker_raw, security_name_raw')
        .eq('user_id', userId)
        .eq('statement_id', statementId)
        .in('activity_type', Object.keys(AU_ACTIVITY_BANK_DIRECTION))
        .order('id', { ascending: true }),
    );
    const toMatch = activities
      .filter((a) => a.bank_match_status !== 'matched' || !a.linked_transaction_id)
      .sort((a, b) => AU_ACTIVITY_MATCH_PRIORITY.indexOf(a.activity_type) - AU_ACTIVITY_MATCH_PRIORITY.indexOf(b.activity_type) || (a.id < b.id ? -1 : 1));
    if (toMatch.length === 0) return empty(null);

    const dates = toMatch.map((a) => a.trade_date ?? a.settlement_date).filter((d): d is string => Boolean(d)).sort();
    let legs: BankLegRow[] = [];
    if (dates.length > 0) {
      legs = await fetchAllRows<BankLegRow>(() =>
        admin
          .from('fdh_transactions')
          .select('id, amount_original, currency_original, credit_debit, transaction_date, description_clean, description_raw, merchant_raw, approval_status, dedup_status')
          .eq('user_id', userId)
          .eq('approval_status', 'approved')
          .gte('transaction_date', shiftIsoDate(dates[0], -BANK_MATCH_WINDOW_DAYS))
          .lte('transaction_date', shiftIsoDate(dates[dates.length - 1], BANK_MATCH_WINDOW_DAYS))
          .order('transaction_date', { ascending: true })
          .order('id', { ascending: true }),
      );
      legs = legs.filter((l) => l.dedup_status !== 'duplicate_confirmed' && l.dedup_status !== 'user_confirmed_duplicate');
    }

    // One bank line -> one activity: every line any activity of this user
    // already claims is off the table.
    const claimedRows = await fetchAllRows<{ id: string; linked_transaction_id: string | null }>(() =>
      admin
        .from('fdh_investment_statement_activities')
        .select('id, linked_transaction_id')
        .eq('user_id', userId)
        .eq('bank_match_status', 'matched')
        .order('id', { ascending: true }),
    );
    const claimed = new Set(claimedRows.map((r) => r.linked_transaction_id).filter((v): v is string => Boolean(v)));

    const signal = buildBrokerNarrativeSignal(statement.institution_name as string | null, await loadAuBrokerAliasSets(admin));

    let matched = 0, noMatch = 0, multipleCandidates = 0, noBankEvidence = 0;
    for (const activity of toMatch) {
      const direction = AU_ACTIVITY_BANK_DIRECTION[activity.activity_type];
      const eventDate = activity.trade_date ?? activity.settlement_date;
      const eligible = eventDate
        ? legs.filter((l) => !claimed.has(l.id) && l.credit_debit === direction && l.currency_original === activity.currency_code)
        : [];
      const candidates: BankTransactionCandidate[] = eligible.map((l) => {
        const narrative = [l.description_clean, l.description_raw, l.merchant_raw].filter(Boolean).join(' ');
        const broker = signal.evaluate(narrative);
        // A dividend is paid by the issuer, so naming the SECURITY is also a
        // real signal for it (never for a trade or a broker-cash movement).
        const issuer = AU_ISSUER_PAID_ACTIVITY_TYPES.has(activity.activity_type) && narrativeNamesSecurity(narrative, activity.ticker_raw, activity.security_name_raw);
        return {
          transactionId: l.id,
          amount: Number(l.amount_original),
          transactionDate: l.transaction_date,
          institutionOrNarrativeMatches: broker.institutionOrNarrativeMatches || issuer,
          positivelyWrongBroker: broker.positivelyWrongBroker && !issuer,
        };
      });
      const result = eventDate
        ? matchBankBrokerEvent({ amount: Number(activity.amount), eventDate, currencyCode: activity.currency_code, dateToleranceDays: BANK_MATCH_WINDOW_DAYS }, candidates)
        : { outcome: 'bank_evidence_not_available' as const, matchedTransactionId: null, candidates: [] };

      let bankMatchStatus: string;
      let linkedTransactionId: string | null = null;
      if (result.outcome === 'matched' && result.matchedTransactionId) {
        matched++;
        bankMatchStatus = 'matched';
        linkedTransactionId = result.matchedTransactionId;
        claimed.add(linkedTransactionId);
      } else if (result.outcome === 'no_match') { noMatch++; bankMatchStatus = 'no_match'; }
      else if (result.outcome === 'multiple_candidates') { multipleCandidates++; bankMatchStatus = 'multiple_candidates'; }
      else { noBankEvidence++; bankMatchStatus = 'bank_evidence_not_available'; }

      const { error: updErr } = await admin
        .from('fdh_investment_statement_activities')
        .update({ bank_match_status: bankMatchStatus, linked_transaction_id: linkedTransactionId, bank_match_candidates: result.candidates.length > 0 ? result.candidates : null })
        .eq('id', activity.id)
        .eq('user_id', userId);
      if (updErr) return { matched, noMatch, multipleCandidates, noBankEvidence, error: updErr.message };
    }

    // INV-G11 (1): the audit trail belongs to the DOCUMENT (it used to be
    // written with the statement id in the document_id column).
    if (statement.statement_upload_id) {
      await recordDocumentAuditEvent({ userId, documentId: statement.statement_upload_id as string, eventType: 'investment_statement_bank_match_completed', actorType: 'system', metadata: { statementId, matched, noMatch, multipleCandidates, noBankEvidence, brokerRecognised: signal.brokerCode !== null } });
    }
    return { matched, noMatch, multipleCandidates, noBankEvidence, error: null };
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
}

export interface AuBankLegReclassifySummary {
  reclassified: number;
  unchanged: number;
  skippedUserOverride: number;
  notVerified: number;
}

/**
 * INV-G4: once an APPROVED broker statement corroborates a bank leg, the leg's
 * own economic type is made to say what it is -- a BUY / broker deposit is
 * 'investment' (spending 0), a SELL is 'asset_sale' (ordinary income 0), a
 * broker withdrawal is a 'transfer'. Dividends are NOT touched: the bank credit
 * is already the single household income leg (one $400 event, never $800).
 *
 * Goes through `fdh_internal_reclassify_corroborated_leg` (0207), the one
 * sanctioned path: it never overrides a line the user settled, writes the
 * correction history first, and audits the change. The leg is re-verified
 * here (approved, direction, currency, amount to the cent) so a weak or stale
 * match can never re-type a line. Idempotent: a second run reports 'unchanged'.
 */
export async function reclassifyCorroboratedAuBankLegs(userId: string, statementId: string): Promise<AuBankLegReclassifySummary> {
  const admin = createAdminClient();
  const out: AuBankLegReclassifySummary = { reclassified: 0, unchanged: 0, skippedUserOverride: 0, notVerified: 0 };
  const { data: statement } = await admin.from('fdh_investment_statements').select('id, approval_status').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (!statement || statement.approval_status !== 'approved') return out;

  const activities = await fetchAllRows<{ id: string; activity_type: string; amount: number; currency_code: string; linked_transaction_id: string | null }>(() =>
    admin
      .from('fdh_investment_statement_activities')
      .select('id, activity_type, amount, currency_code, linked_transaction_id')
      .eq('user_id', userId)
      .eq('statement_id', statementId)
      .eq('bank_match_status', 'matched')
      .in('activity_type', Object.keys(AU_ACTIVITY_BANK_LEG_TYPE))
      .order('id', { ascending: true }),
  );
  for (const a of activities) {
    if (!a.linked_transaction_id) continue;
    const { data: leg } = await admin
      .from('fdh_transactions')
      .select('id, amount_original, currency_original, credit_debit, approval_status')
      .eq('id', a.linked_transaction_id)
      .eq('user_id', userId)
      .maybeSingle();
    const verified =
      leg &&
      leg.approval_status === 'approved' &&
      leg.credit_debit === AU_ACTIVITY_BANK_DIRECTION[a.activity_type] &&
      leg.currency_original === a.currency_code &&
      Math.round(Number(leg.amount_original) * 100) === Math.round(Number(a.amount) * 100);
    if (!verified) {
      out.notVerified += 1;
      continue;
    }
    const { data: outcome, error } = await admin.rpc('fdh_internal_reclassify_corroborated_leg', {
      p_user: userId,
      p_txn: a.linked_transaction_id,
      p_new_type: AU_ACTIVITY_BANK_LEG_TYPE[a.activity_type],
      p_reason: `broker statement ${a.activity_type}`,
      p_source_kind: 'investment_statement_activity',
      p_source_id: a.id,
    });
    if (error) throw new Error(`fdh_internal_reclassify_corroborated_leg: ${error.message}`);
    if (outcome === 'reclassified') out.reclassified += 1;
    else if (outcome === 'skipped_user_override') out.skippedUserOverride += 1;
    else out.unchanged += 1;
  }
  return out;
}

/**
 * The WP-12 post-bank-approval matcher body (INV-G4 / the WP-01 seam). A bank
 * statement approved AFTER the broker statement was processed used to leave
 * every broker activity 'bank_evidence_not_available' forever. Re-runs the
 * matcher for each of this user's AU statements with an unmatched,
 * bank-matchable activity, then re-types the newly corroborated legs of the
 * approved ones. User-scoped and idempotent.
 */
export async function rematchAuStatementsAfterBankApproval(userId: string): Promise<{ statements: number; linked: number; reclassified: number }> {
  const admin = createAdminClient();
  const pending = await fetchAllRows<{ statement_id: string; id: string }>(() =>
    admin
      .from('fdh_investment_statement_activities')
      .select('id, statement_id')
      .eq('user_id', userId)
      .neq('bank_match_status', 'matched')
      .in('activity_type', Object.keys(AU_ACTIVITY_BANK_DIRECTION))
      .order('id', { ascending: true }),
  );
  const statementIds = [...new Set(pending.map((p) => p.statement_id))].sort();
  let linked = 0;
  let reclassified = 0;
  for (const statementId of statementIds) {
    const summary = await matchAuStatementActivitiesToBank(userId, statementId);
    if (summary.error) throw new Error(summary.error);
    linked += summary.matched;
    if (summary.matched > 0) reclassified += (await reclassifyCorroboratedAuBankLegs(userId, statementId)).reclassified;
  }
  return { statements: statementIds.length, linked, reclassified };
}
