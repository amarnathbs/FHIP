/**
 * FDH-5 — Bank PDF Statement Engine: processing orchestration (spec sections
 * 6, 13-46, 55-56, 63, 85-90). Direct PDF analogue of
 * `bankCsvProcessingService.ts` — same idempotency/retry-safety discipline,
 * same service-role write carve-out (see that file's own header comment for
 * the full rationale, unchanged here), same downstream persistence shape:
 * `fdh_transactions` / `fdh_reconciliation_results` / `fdh_data_quality_
 * results` / `fdh_data_provenance` / `fdh_duplicate_candidates` — IDENTICAL
 * tables, IDENTICAL columns, so a PDF-sourced transaction is indistinguishable
 * from a CSV-sourced one to every downstream consumer (R8 included) except
 * for its own provenance fields (spec 2, 38, 63, 86-88).
 *
 * PASSWORD DISCIPLINE (spec sections 22-25, "particular scrutiny area").
 * `password` is a plain function parameter on `processBankPdfDocument()`
 * alone. It is:
 *   - never written to any `.insert()`/`.update()` payload in this file,
 *   - never passed to `recordDocumentAuditEvent()`'s `metadata`,
 *   - never logged (no `console.*` call in this file references it),
 *   - used exactly once, to construct the in-memory
 *     `runBankPdfPipeline({ password })` call, and then falls out of scope
 *     when this function returns.
 * `checkPasswordAttemptRateLimit()` (spec 24) is consulted BEFORE that one
 * attempt is made, using only already-persisted audit-event TIMESTAMPS —
 * never the password text itself (see `bank-pdf/password.ts`'s own header
 * comment).
 */

import { resolveEmailForAiePilotCohort } from '@/lib/aie/pilotCohortEmail';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  documentAuditEventsRepository,
  ingestionJobsRepository,
  reviewItemsRepository,
  statementUploadsRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import {
  runBankPdfPipeline,
  runBankPdfPipelineFromReadRows,
  decidePdfCertification,
  type PdfPipelineStatus,
  type PdfPipelineResult,
  type ReadBankStatementRow,
} from '../bank-pdf/orchestrator';
// AIE bank-statement AI-fallback (2026-09-23). Follows the pattern proven by
// the payslip path: call the shared AIE gateway DIRECTLY from inside this
// native processing service's own failure branch, rather than routing through
// the `lib/aie/orchestrator.ts` intake/accept pipeline, whose three existing
// adapters were all found to have zero frontend callers. See
// `lib/aie/adapters/bankStatement/index.ts`'s header (which also explains why
// the pre-existing, unreached `lib/aie/adapters/fdhBankStatement/` adapter is
// not the vehicle here) and
// `docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md`.
import {
  isAieBankStatementAiFallbackEnabled,
  requestBankStatementAiExtraction,
  mapBankStatementFactsToDraft,
  AIE_BANK_STATEMENT_PARSER_NAME,
  AIE_BANK_STATEMENT_PARSER_VERSION,
  type MappedBankStatementDraft,
} from '@/lib/aie/adapters/bankStatement';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { loadDedupIndexForAccount, loadPriorStatementDateRanges } from '../bank-csv/repository';
import { rangesOverlap } from '../bank-csv/reconciliation';
import { moneyEquals } from '../domain/money';
import { checkPasswordAttemptRateLimit } from '../bank-pdf/password';
import type { FdhStatementUpload } from '../domain/types';
import type { FdhErrorCode } from '../constants/enums';

export class BankPdfProcessingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state' | 'account_unresolved' | 'rate_limited' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'BankPdfProcessingError';
  }
}

async function getOwnedDocument(userId: string, documentId: string): Promise<FdhStatementUpload> {
  const { data } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!data) throw new BankPdfProcessingError('not_found', 'document not found');
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

async function adminInsert(table: string, row: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from(table).insert(row);
  if (error) throw new Error(error.message);
}

const INSERT_CHUNK_SIZE = 500;

export interface ProcessBankPdfResult {
  document: FdhStatementUpload;
  transactionsCreated: number;
  duplicatesSkipped: number;
  duplicateCandidates: number;
  rejectedRows: number;
  certificationStatus: string | null;
  reconciliationStatus: string | null;
  pipelineStatus: PdfPipelineStatus | 'idempotent_existing' | 'ai_fallback_available';
  /**
   * Populated ONLY when `pipelineStatus === 'ai_fallback_available'`. A DRAFT
   * an AI read off a statement the deterministic parser could not segment —
   * NOTHING has been written to `fdh_transactions` or anywhere else yet.
   *
   * The document deliberately stays in `processing` (the native success
   * path's own pre-write state) rather than advancing or failing, so that
   * `confirmAiBankStatementFallback`'s `processing -> extracted` edge — the
   * SAME edge a native success uses — stays legal. This matters more here
   * than on any other type: the native failure branch would otherwise move
   * the document to `rejected`, which `documentLifecycle.ts` defines as
   * TERMINAL (`rejected: []`, no onward edge), so a fallback offered after
   * that write could never be confirmed at all.
   *
   * The caller (the API route) shows this to the user for explicit review
   * before `confirmAiBankStatementFallback` writes anything — "try AI, then
   * ask you to review", never a silent auto-write of an AI guess.
   */
  aiFallbackDraft?: BankStatementAiFallbackDraft;
}

/** What the review UI is shown, and what the confirm route sends back. It is
 * deliberately the RAW READING (dates, descriptions, amounts, directions,
 * balances) rather than the derived pipeline result: the user reviews what
 * the model claims the page said, and every derived value — fingerprints,
 * duplicate decisions, the balance rollforward — is recomputed server-side
 * from the reviewed rows at confirm time. Nothing computed on the client is
 * ever trusted. */
export interface BankStatementAiFallbackDraft {
  rows: ReadBankStatementRow[];
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  declaredOpeningBalance: number | null;
  declaredClosingBalance: number | null;
  /** The model's own claim that it listed every printed line. Shown to the
   * user in words. Never the only completeness check — the balance
   * rollforward recomputed at confirm time is. */
  allTransactionsListed: boolean;
  warnings: string[];
}

/** Removes every row a PRIOR (failed) processing attempt for this document
 * produced — the compensating cleanup that makes a retry safe (spec 89-90),
 * identical discipline to the CSV path's own `cleanupPriorAttempt`. */
async function cleanupPriorAttempt(userId: string, documentId: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from('fdh_transactions').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_reconciliation_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_data_quality_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
}

/** Maps a pipeline-level failure status onto the widened, controlled
 * `error_code` vocabulary (spec 83) — see `enums.ts`'s
 * `FDH_ERROR_CODES_FDH5_ADDED` header comment for the full reuse-vs-new-code
 * mapping table this mirrors exactly. */
function errorCodeForPipelineStatus(status: PdfPipelineStatus): FdhErrorCode | null {
  switch (status) {
    case 'encrypted':
      return 'password_required';
    case 'password_invalid':
      return 'password_invalid';
    case 'corrupt':
      return 'file_corrupt';
    case 'image_only':
      return 'ocr_required';
    case 'page_limit_exceeded':
      return 'page_limit_exceeded';
    case 'unsupported_layout':
      return 'layout_unsupported';
    case 'ambiguous_layout':
      return 'format_ambiguous';
    case 'extraction_low_confidence':
      return 'extraction_low_confidence';
    default:
      return null;
  }
}

/**
 * Pipeline statuses this adapter will attempt an AI-fallback extraction for.
 *
 * DELIBERATELY NARROW, mirroring the payslip path's own eligibility list and
 * its reasoning. The test is not "did parsing fail" but "is there readable
 * text that genuinely looks like a statement the layout parser could not
 * segment":
 *
 *   - `unsupported_layout`   — full text extracted, no adapter scored high
 *                              enough. The primary case, and the one real
 *                              users hit with an unsupported bank.
 *   - `ambiguous_layout`     — full text extracted, two adapters scored too
 *                              closely for the detector to choose.
 *   - `extraction_low_confidence` — rows were found but too many blocks were
 *                              unparseable.
 *
 * EXCLUDED ON PURPOSE, each because NO TEXT WAS EVER EXTRACTED, so an AI has
 * nothing to read and the call would be pure spend:
 *   - `encrypted` / `password_invalid` — a missing credential for this
 *     attempt, recoverable by retrying with the password; not a defect.
 *   - `corrupt` — the PDF parser itself threw.
 *   - `image_only` — a scan. This is the case people most expect AI to
 *     rescue, and it is exactly the one it cannot: there is no text layer,
 *     and this pipeline does no OCR. Sending an empty string to a model would
 *     invite it to invent a statement wholesale.
 *   - `page_limit_exceeded` — a resource ceiling, not a layout problem.
 *
 * (Also excluded by construction: `ok`. A statement that parsed natively
 * never reaches the fallback, including the zero-transaction case — see the
 * known-limitations note in the dispatch report.)
 */
const AI_FALLBACK_ELIGIBLE_PIPELINE_STATUSES: readonly PdfPipelineStatus[] = ['unsupported_layout', 'ambiguous_layout', 'extraction_low_confidence'];

export async function processBankPdfDocument(userId: string, documentId: string, password?: string): Promise<ProcessBankPdfResult> {
  const document = await getOwnedDocument(userId, documentId);

  // IDEMPOTENCY (spec 89-90): already certified/settled — return as-is.
  if (document.certification_status && ['certified', 'review_required', 'rejected'].includes(document.certification_status) && document.processing_completed_at) {
    return summariseExisting(document);
  }

  if (!['queued', 'failed'].includes(document.processing_status)) {
    throw new BankPdfProcessingError('invalid_state', `cannot process while the document is ${document.processing_status}`);
  }

  // AIE-1 final completion (2026-09-25): never re-process a file the malware
  // gate blocked or never scanned (see `checkFdhDocumentMalwareAdmission`).
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new BankPdfProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }

  // PASSWORD RATE LIMIT (spec 24) — consulted BEFORE the one decrypt
  // attempt this call may make, using only already-persisted audit-event
  // TIMESTAMPS (never the password text itself).
  if (document.error_code === 'password_required') {
    const { data: allEvents } = await documentAuditEventsRepository.listForUser(userId, 500);
    const recentForDoc = (allEvents ?? []).filter((e) => e.document_id === documentId);
    const rateLimit = checkPasswordAttemptRateLimit({ recentAuditEvents: recentForDoc, nowIso: new Date().toISOString() });
    if (!rateLimit.allowed) {
      throw new BankPdfProcessingError('rate_limited', 'Too many password attempts for this document recently. Please try again later.');
    }
  }

  if (document.processing_status === 'failed') {
    await cleanupPriorAttempt(userId, documentId);
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'queued' });
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

    if (document.error_code === 'password_required') {
      // One attempt is always recorded, regardless of outcome — this IS the
      // rate-limit signal `checkPasswordAttemptRateLimit` counts (spec 24).
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_password_required', actorType: 'system' });
    }

    if (!document.financial_account_id) {
      assertDocumentTransition('processing', 'review_required');
      await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'review_required',
        certification_status: 'review_required',
        review_status: 'pending',
      });
      throw new BankPdfProcessingError('account_unresolved', 'account identity is ambiguous — resolve it before processing');
    }

    const dedupIndex = await loadDedupIndexForAccount(userId, document.financial_account_id);
    const priorRanges = await loadPriorStatementDateRanges(userId, document.financial_account_id, documentId);

    const pipeline = await runBankPdfPipeline({
      bytes: download.bytes,
      statementUploadId: documentId,
      financialAccountId: document.financial_account_id,
      currencyCode: document.currency_code ?? 'AUD',
      password,
      dedupIndex,
      declaredPeriodStart: document.statement_period_start,
      declaredPeriodEnd: document.statement_period_end,
    });
    // `password` (the function parameter) is not referenced again anywhere
    // below this line — its only use was the one call immediately above.

    if (pipeline.status === 'encrypted' || pipeline.status === 'password_invalid') {
      // Wrong/missing password: back to 'queued' awaiting a retry (spec 24
      // — "allow controlled retry"), NEVER 'failed'/'rejected' (this is not
      // a document defect, it is a missing credential for this one attempt).
      assertDocumentTransition('processing', 'queued');
      const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'queued',
        error_code: errorCodeForPipelineStatus(pipeline.status),
        review_status: 'pending',
      });
      await recordDocumentAuditEvent({
        userId,
        documentId,
        eventType: 'pdf_processing_failed',
        actorType: 'system',
        metadata: { reason: pipeline.status },
      });
      return {
        document: (finalDoc ?? document) as FdhStatementUpload,
        transactionsCreated: 0,
        duplicatesSkipped: 0,
        duplicateCandidates: 0,
        rejectedRows: 0,
        certificationStatus: null,
        reconciliationStatus: null,
        pipelineStatus: pipeline.status,
      };
    }

    if (pipeline.status === 'ok' && password) {
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_decrypted_for_processing', actorType: 'system' });
    }

    if (pipeline.status !== 'ok') {
      // AI FALLBACK, attempted BEFORE the terminal rejection below and only
      // for the statuses where the document is genuinely readable text that
      // the LAYOUT-specific parser could not segment. Ordering is not a
      // preference here: `rejected` is a terminal state with no onward edge
      // (`documentLifecycle.ts`), so a fallback offered after that write
      // could never be confirmed.
      if (AI_FALLBACK_ELIGIBLE_PIPELINE_STATUSES.includes(pipeline.status)) {
        const fallback = await attemptAiBankStatementFallback(userId, documentId, pipeline.extractedText ?? '');
        if (fallback.ok) {
          // Deliberately NO document status change — the document stays in
          // `processing` until the user explicitly reviews and confirms. See
          // `ProcessBankPdfResult.aiFallbackDraft`'s own doc comment.
          return {
            document,
            transactionsCreated: 0,
            duplicatesSkipped: 0,
            duplicateCandidates: 0,
            rejectedRows: 0,
            certificationStatus: null,
            reconciliationStatus: null,
            pipelineStatus: 'ai_fallback_available',
            aiFallbackDraft: fallback.draft,
          };
        }
        await recordDocumentAuditEvent({
          userId,
          documentId,
          eventType: 'bank_statement_ai_fallback_not_usable',
          actorType: 'system',
          metadata: { reason: fallback.reason, nativePipelineStatus: pipeline.status },
        });
      }

      // corrupt / image_only / page_limit_exceeded / unsupported_layout /
      // ambiguous_layout / extraction_low_confidence — a controlled,
      // terminal failure for THIS document (spec 7: never guess; a
      // half-read statement is never silently certified).
      assertDocumentTransition('processing', 'rejected');
      const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'rejected',
        certification_status: 'rejected',
        error_code: errorCodeForPipelineStatus(pipeline.status),
        review_status: 'pending',
        page_count: pipeline.pageCount,
        pdf_classification:
          pipeline.status === 'corrupt'
            ? 'corrupt'
            : pipeline.status === 'image_only'
              ? 'image_only'
              : pipeline.status === 'page_limit_exceeded'
                ? 'unsupported'
                : null,
        extraction_confidence: pipeline.statementExtractionConfidence,
        processing_completed_at: new Date().toISOString(),
      });
      await recordDocumentAuditEvent({
        userId,
        documentId,
        eventType: 'pdf_processing_failed',
        actorType: 'system',
        metadata: { reason: pipeline.status },
      });
      return {
        document: (finalDoc ?? document) as FdhStatementUpload,
        transactionsCreated: 0,
        duplicatesSkipped: 0,
        duplicateCandidates: 0,
        rejectedRows: pipeline.rejected.length,
        certificationStatus: 'rejected',
        reconciliationStatus: null,
        pipelineStatus: pipeline.status,
      };
    }

    // The canonical write. Extracted verbatim into
    // `persistBankPdfPipelineResult` below so that the AI-fallback confirm
    // path can reuse the EXACT same write — see that function's header.
    return await persistBankPdfPipelineResult({ userId, documentId, document, pipeline, priorRanges });
  } catch (e) {
    if (e instanceof BankPdfProcessingError) throw e;
    await adminUpdateStatementUpload(userId, documentId, {
      processing_status: 'failed',
      error_code: 'internal_error',
    });
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'pdf_processing_failed',
      actorType: 'system',
      metadata: { reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' },
    });
    throw new BankPdfProcessingError('internal_error', e instanceof Error ? e.message : 'processing failed');
  }
}

/**
 * THE CANONICAL WRITE for a bank-statement PDF import.
 *
 * EXTRACTED 2026-09-23 (AIE unified document fallback) FROM THE MIDDLE OF
 * `processBankPdfDocument`, VERBATIM — the body below is the same code that
 * ran inline before, moved and de-indented, with no behavioural change. It
 * was extracted for exactly one reason: so that the AI-fallback confirm path
 * (`confirmAiBankStatementFallback`) can call the IDENTICAL write rather than
 * growing a second, AI-specific writer.
 *
 * That is the property the whole design rests on. An AI-fallback-produced
 * import must be indistinguishable from a natively-parsed one to every
 * downstream step — the same `fdh_transactions` columns, the same duplicate
 * candidates, the same reconciliation row, the same five data-quality checks,
 * the same certification decision, the same lifecycle transitions, the same
 * review items, the same provenance row. A parallel writer would be free to
 * drift from all of that, and the first sign would be an AI-sourced statement
 * that was certified on weaker evidence than a native one.
 *
 * NOTE: this function does NOT establish its own try/catch. Both callers
 * invoke it from inside their own, which is what preserves the pre-existing
 * "any unexpected throw marks the document failed with `internal_error`"
 * behaviour unchanged.
 */
export async function persistBankPdfPipelineResult(params: {
  userId: string;
  documentId: string;
  document: FdhStatementUpload;
  pipeline: PdfPipelineResult;
  priorRanges: Awaited<ReturnType<typeof loadPriorStatementDateRanges>>;
}): Promise<ProcessBankPdfResult> {
  const { userId, documentId, document, pipeline, priorRanges } = params;
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'pdf_adapter_detected',
    actorType: 'system',
    metadata: { adapter_id: pipeline.adapter?.id ?? null, confidence: pipeline.detection?.confidence ?? null },
  });

  // Parser/version provenance (spec 27, 86) — recorded now that detection
  // has actually succeeded (there is no separate PDF "detect" step; spec
  // section 26's `detect()` runs inline as part of processing, unlike the
  // CSV path's own separate `/detect` endpoint).
  if (pipeline.adapter) {
    const supabase = await createClient();
    const { data: registryRow } = await supabase
      .from('fdh_parser_registry')
      .select('id')
      .eq('parser_key', pipeline.adapter.id)
      .maybeSingle();
    let parserVersionId: string | null = null;
    if (registryRow) {
      const { data: versionRow } = await supabase
        .from('fdh_parser_versions')
        .select('id')
        .eq('parser_id', (registryRow as { id: string }).id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      parserVersionId = (versionRow as { id: string } | null)?.id ?? null;
    }
    await adminUpdateStatementUpload(userId, documentId, {
      adapter_key: pipeline.adapter.id,
      adapter_version: pipeline.adapter.version,
      parser_id: (registryRow as { id: string } | null)?.id ?? null,
      parser_version_id: parserVersionId,
    });
    document.parser_id = (registryRow as { id: string } | null)?.id ?? null;
    document.parser_version_id = parserVersionId;
  }

  const rowsToInsert = pipeline.accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const duplicateConfirmedCount = pipeline.accepted.length - rowsToInsert.length;

  let insertedIds: { id: string; source_row: number | null }[] = [];
  for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rowsToInsert.slice(i, i + INSERT_CHUNK_SIZE);
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('fdh_transactions')
      .insert(
        chunk.map((t) => ({
          user_id: userId,
          household_id: document.household_id,
          financial_account_id: document.financial_account_id,
          statement_upload_id: documentId,
          transaction_date: t.transactionDate,
          posting_date: null,
          value_date: null,
          description_raw: t.descriptionRaw,
          description_clean: t.descriptionClean,
          amount_original: t.amountOriginal,
          currency_original: document.currency_code ?? 'AUD',
          credit_debit: t.creditDebit,
          economic_transaction_type: 'unknown',
          source_reference: null,
          source_page: t.sourcePage,
          source_row: t.sourceRowNumber,
          extraction_confidence: t.extractionConfidence,
          classification_method: 'unclassified',
          source_row_hash: t.sourceRowHash,
          economic_fingerprint: t.economicFingerprint,
          economic_fingerprint_version: pipeline.economicFingerprintVersion,
          dedup_status: t.dedupStatus,
          balance_after: t.balanceAfter,
          transaction_type_hint: t.transactionTypeHint,
        })),
      )
      .select('id, source_row');
    if (error) {
      await cleanupPriorAttempt(userId, documentId);
      await adminUpdateStatementUpload(userId, documentId, {
        processing_status: 'failed',
        error_code: 'data_validation_failed',
      });
      await recordDocumentAuditEvent({
        userId,
        documentId,
        eventType: 'pdf_processing_failed',
        actorType: 'system',
        metadata: { reason: 'insert_failed' },
      });
      throw new BankPdfProcessingError('internal_error', 'could not persist normalised transactions');
    }
    insertedIds = insertedIds.concat((data ?? []) as { id: string; source_row: number | null }[]);
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_native_extraction_completed', actorType: 'system' });

  // Duplicate-candidate provenance (spec 57-59) — identical logic to the
  // CSV path's own within-file `pending-row-N` placeholder resolution
  // (see `bankCsvProcessingService.ts`'s own header comment for the
  // live-DEV-discovered bug this pattern already fixed once for R7 — the
  // exact same resolution is applied here).
  const rowNumberToId = new Map(insertedIds.map((r) => [r.source_row, r.id]));
  let duplicateCandidateCount = 0;
  for (const t of rowsToInsert) {
    if (t.dedupStatus !== 'duplicate_candidate' || !t.matchedTransactionId) continue;
    const newId = rowNumberToId.get(t.sourceRowNumber);
    let matchedId: string | null = t.matchedTransactionId;
    if (matchedId.startsWith('pending-row-')) {
      const matchedRowNumber = Number(matchedId.slice('pending-row-'.length));
      matchedId = rowNumberToId.get(matchedRowNumber) ?? null;
    }
    if (!newId || !matchedId || matchedId === newId) continue;
    await adminInsert('fdh_duplicate_candidates', {
      user_id: userId,
      transaction_id_a: matchedId,
      transaction_id_b: newId,
      match_method: t.matchMethod ?? 'fuzzy_amount_date',
      confidence: t.dedupConfidence,
      status: 'pending',
    });
    duplicateCandidateCount += 1;
  }
  if (duplicateConfirmedCount > 0 || duplicateCandidateCount > 0) {
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'transaction_duplicate_detected',
      actorType: 'system',
      metadata: { confirmed: duplicateConfirmedCount, candidates: duplicateCandidateCount },
    });
  }

  const overlapsPrior = pipeline.dateCoverage?.earliestDate && pipeline.dateCoverage?.latestDate
    ? [...priorRanges.values()].some((r) =>
        rangesOverlap(r, { start: pipeline.dateCoverage!.earliestDate!, end: pipeline.dateCoverage!.latestDate! }),
      )
    : false;
  void overlapsPrior;

  // Reconciliation persistence (spec 42-43, 60-62) — reuses R7's exact
  // `fdh_reconciliation_results` table and `reconcileBalances()` output
  // unchanged. An EXPLICIT statement-declared opening/closing balance
  // (spec 36, when the adapter found one) is cross-checked here as an
  // ADDITIONAL data-quality signal against the rollforward-DERIVED
  // opening/closing balance `reconcileBalances()` computed — never used to
  // silently override a reconciliation outcome, and never implemented as
  // a second reconciliation engine (spec 60): both values are simply
  // compared with the SAME `moneyEquals()` utility the reused engine
  // itself is built on.
  let declaredBalanceMismatch = false;
  if (pipeline.reconciliation) {
    const declaredOpening = pipeline.statementMetadata?.declaredOpeningBalance;
    if (declaredOpening !== null && declaredOpening !== undefined && pipeline.reconciliation.openingBalance !== null) {
      declaredBalanceMismatch = !moneyEquals(declaredOpening, pipeline.reconciliation.openingBalance, document.currency_code ?? 'AUD');
    }
    const declaredClosing = pipeline.statementMetadata?.declaredClosingBalance;
    if (declaredClosing !== null && declaredClosing !== undefined && pipeline.reconciliation.reportedClosingBalance !== null) {
      declaredBalanceMismatch =
        declaredBalanceMismatch ||
        !moneyEquals(declaredClosing, pipeline.reconciliation.reportedClosingBalance, document.currency_code ?? 'AUD');
    }

    await adminInsert('fdh_reconciliation_results', {
      user_id: userId,
      statement_upload_id: documentId,
      opening_balance: pipeline.reconciliation.openingBalance ?? pipeline.statementMetadata?.declaredOpeningBalance ?? null,
      extracted_credits: pipeline.reconciliation.extractedCredits,
      extracted_debits: pipeline.reconciliation.extractedDebits,
      expected_closing_balance: pipeline.reconciliation.expectedClosingBalance,
      reported_closing_balance: pipeline.reconciliation.reportedClosingBalance ?? pipeline.statementMetadata?.declaredClosingBalance ?? null,
      variance: pipeline.reconciliation.variance,
      variance_tolerance: pipeline.reconciliation.varianceTolerance,
      currency_code: document.currency_code,
      status: declaredBalanceMismatch && pipeline.reconciliation.status === 'reconciled' ? 'failed' : pipeline.reconciliation.status,
      reconciliation_method: pipeline.reconciliation.method,
    });
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'import_reconciled',
      actorType: 'system',
      metadata: { status: pipeline.reconciliation.status, declared_balance_mismatch: declaredBalanceMismatch },
    });
  }

  const dqChecks: { check_code: string; status: string; details_sanitised?: string }[] = [
    {
      check_code: 'transaction_count_valid',
      status: pipeline.rejected.length === 0 && pipeline.unparseableBlockCount === 0 ? 'pass' : 'fail',
      details_sanitised: `parsed=${pipeline.accepted.length} rejected=${pipeline.rejected.length} unparseable=${pipeline.unparseableBlockCount}`,
    },
    { check_code: 'account_identified', status: document.financial_account_id ? 'pass' : 'fail' },
    {
      check_code: 'balance_reconciled',
      status:
        declaredBalanceMismatch
          ? 'fail'
          : pipeline.reconciliation?.status === 'reconciled'
            ? 'pass'
            : pipeline.reconciliation?.status === 'not_available'
              ? 'not_applicable'
              : pipeline.reconciliation?.status === 'failed'
                ? 'fail'
                : 'warning',
    },
    {
      check_code: 'statement_period_found',
      status: (document.statement_period_start && document.statement_period_end) || (pipeline.statementMetadata?.statementPeriodStart && pipeline.statementMetadata?.statementPeriodEnd) ? 'pass' : 'warning',
    },
    { check_code: 'duplicate_file', status: document.duplicate_of_document_id ? 'warning' : 'pass' },
  ];
  for (const check of dqChecks) {
    await adminInsert('fdh_data_quality_results', {
      user_id: userId,
      statement_upload_id: documentId,
      check_code: check.check_code,
      status: check.status,
      details_sanitised: check.details_sanitised ?? null,
    });
  }

  await adminInsert('fdh_data_provenance', {
    user_id: userId,
    household_id: document.household_id,
    entity_type: 'fdh_statement_upload',
    entity_id: documentId,
    source_type: 'pdf_native',
    source_statement_id: documentId,
    parser_id: document.parser_id,
    parser_version_id: document.parser_version_id,
    mapping_rule_version: pipeline.parserVersion,
    evidence_completeness: pipeline.rejected.length === 0 && pipeline.unparseableBlockCount === 0 ? 1 : rowsToInsert.length / Math.max(rowsToInsert.length + pipeline.rejected.length + pipeline.unparseableBlockCount, 1),
    user_verified: false,
    manual_override: false,
  });

  const certification = decidePdfCertification({
    pipelineStatus: pipeline.status,
    declaredRowCount: pipeline.accepted.length + pipeline.rejected.length + pipeline.unparseableBlockCount,
    parsedRowCount: pipeline.accepted.length,
    rejectedRowCount: pipeline.rejected.length + pipeline.unparseableBlockCount,
    duplicateCandidateCount,
    accountAmbiguous: false,
    reconciliationStatus: declaredBalanceMismatch ? 'failed' : (pipeline.reconciliation?.status ?? null),
  });

  if (certification.certificationStatus === 'review_required' && duplicateCandidateCount > 0) {
    await reviewItemsRepository.create(userId, {
      household_id: document.household_id,
      statement_upload_id: documentId,
      transaction_id: null,
      review_type: 'possible_duplicate',
      severity: 'warning',
      status: 'open',
      title_code: 'bank_pdf.duplicate_candidates_pending_review',
      context_json: { counts: { duplicate_candidates: duplicateCandidateCount } },
    } as never);
  }
  if (certification.certificationStatus === 'review_required' && (pipeline.reconciliation?.status === 'failed' || declaredBalanceMismatch)) {
    await reviewItemsRepository.create(userId, {
      household_id: document.household_id,
      statement_upload_id: documentId,
      transaction_id: null,
      review_type: 'reconciliation_failure',
      severity: 'blocking',
      status: 'open',
      title_code: 'bank_pdf.reconciliation_failed',
      context_json: { counts: { variance_minor_units: 1 } },
    } as never);
  }

  let finalProcessingStatus: FdhStatementUpload['processing_status'] = 'review_required';
  assertDocumentTransition('processing', 'extracted');
  await adminUpdateStatementUpload(userId, documentId, { processing_status: 'extracted' });

  if (certification.certificationStatus === 'certified') {
    assertDocumentTransition('extracted', 'ready_for_approval');
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'ready_for_approval' });
    assertDocumentTransition('ready_for_approval', 'approved');
    finalProcessingStatus = 'approved';
  } else if (certification.certificationStatus === 'review_required' || certification.certificationStatus === 'partial') {
    assertDocumentTransition('extracted', 'review_required');
    finalProcessingStatus = 'review_required';
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_review_required', actorType: 'system' });
  } else {
    assertDocumentTransition('extracted', 'rejected');
    finalProcessingStatus = 'rejected';
  }

  const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
    processing_status: finalProcessingStatus,
    certification_status: certification.certificationStatus,
    parsed_row_count: pipeline.accepted.length,
    certified_row_count: rowsToInsert.length,
    duplicate_row_count: duplicateConfirmedCount,
    reconciliation_status: declaredBalanceMismatch ? 'failed' : (pipeline.reconciliation?.status ?? 'not_available'),
    overall_quality_status: certification.certificationStatus === 'certified' ? 'pass' : certification.certificationStatus === 'rejected' ? 'fail' : 'warning',
    processing_completed_at: new Date().toISOString(),
    review_status: finalProcessingStatus === 'review_required' ? 'pending' : 'not_required',
    page_count: pipeline.pageCount,
    pdf_classification: pipeline.unparseableBlockCount > 0 || (pipeline.rejected.length > 0) ? 'mixed_content' : 'text_native',
    extraction_confidence: pipeline.statementExtractionConfidence,
    declared_row_count: pipeline.accepted.length + pipeline.rejected.length + pipeline.unparseableBlockCount,
  });

  await ingestionJobsRepository.listForUser(userId, 500).then(async ({ data }) => {
    const job = (data ?? []).find((j) => j.statement_upload_id === documentId && j.job_type === 'document_extract' && j.status === 'queued');
    if (job) {
      await ingestionJobsRepository.update(userId, job.id, {
        status: certification.certificationStatus === 'rejected' ? 'failed' : 'succeeded',
        started_at: document.processing_started_at ?? new Date().toISOString(),
        completed_at: new Date().toISOString(),
      } as never);
    }
  });

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'pdf_processing_completed',
    actorType: 'system',
    metadata: { certification_status: certification.certificationStatus, transactions_created: rowsToInsert.length, duplicates_skipped: duplicateConfirmedCount },
  });

  return {
    document: (finalDoc ?? document) as FdhStatementUpload,
    transactionsCreated: rowsToInsert.length,
    duplicatesSkipped: duplicateConfirmedCount,
    duplicateCandidates: duplicateCandidateCount,
    rejectedRows: pipeline.rejected.length + pipeline.unparseableBlockCount,
    certificationStatus: certification.certificationStatus,
    reconciliationStatus: declaredBalanceMismatch ? 'failed' : (pipeline.reconciliation?.status ?? null),
    pipelineStatus: pipeline.status,
  };
}

export type AiBankStatementFallbackOutcome = { ok: true; draft: BankStatementAiFallbackDraft } | { ok: false; reason: string };

/**
 * The one call site that reaches the AI provider for a bank statement.
 *
 * Every gate — this adapter's own kill switch, the shared global AIE kill
 * switch, the shared AIE-1 pilot cohort, and masking (which FAILS CLOSED) —
 * is evaluated by the shared `evaluateAiFallbackGate`, in that order. The
 * gate returns ONLY masked text on success, so this function has no way to
 * send the raw document to the provider even by mistake.
 *
 * Exported so it is independently unit-testable with a faked provider, and so
 * the live-DEV proof can exercise it directly.
 */
export async function attemptAiBankStatementFallback(userId: string, documentId: string, extractedText: string): Promise<AiBankStatementFallbackOutcome> {
  const gate = evaluateAiFallbackGate({
    userId,
    cohortEmail: await resolveEmailForAiePilotCohort(userId),
    adapterEnabled: isAieBankStatementAiFallbackEnabled(),
    extractedText,
  });
  if (!gate.ok) {
    if (gate.reason === 'masking_below_policy') {
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_masking_below_policy', actorType: 'system' });
    }
    return { ok: false, reason: gate.reason };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_attempted', actorType: 'system' });
  const result = await requestBankStatementAiExtraction({ maskedText: gate.maskedText, requestId: documentId });
  if (result.outcome !== 'success') {
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'bank_statement_ai_fallback_provider_outcome',
      actorType: 'system',
      metadata: { outcome: result.outcome },
    });
    return { ok: false, reason: result.outcome };
  }

  const mapped = mapBankStatementFactsToDraft(result.facts);
  if (!mapped) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_insufficient_fields', actorType: 'system' });
    return { ok: false, reason: 'insufficient_fields' };
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_draft_ready', actorType: 'system' });
  return { ok: true, draft: toDraft(mapped) };
}

function toDraft(mapped: MappedBankStatementDraft): BankStatementAiFallbackDraft {
  return {
    rows: mapped.rows,
    institutionName: mapped.institutionName,
    maskedAccountIdentifier: mapped.statementMetadata.maskedAccountIdentifier,
    statementPeriodStart: mapped.statementMetadata.statementPeriodStart,
    statementPeriodEnd: mapped.statementMetadata.statementPeriodEnd,
    declaredOpeningBalance: mapped.statementMetadata.declaredOpeningBalance,
    declaredClosingBalance: mapped.statementMetadata.declaredClosingBalance,
    allTransactionsListed: mapped.allTransactionsListed,
    warnings: mapped.warnings,
  };
}

/**
 * Called only after the user has reviewed the draft
 * `attemptAiBankStatementFallback` produced (and may have corrected it).
 *
 * MAKES NO AI CALL and re-derives nothing from document text. It takes the
 * reviewed RAW ROWS and re-runs the deterministic downstream over them
 * SERVER-SIDE — `runBankPdfPipelineFromReadRows` recomputes every source-row
 * hash, every economic fingerprint, every duplicate decision, the balance
 * rollforward and the date coverage — and then hands the result to
 * `persistBankPdfPipelineResult`, the EXACT function a native successful
 * parse uses. Nothing the client computed is trusted; the client supplies
 * only what a human could have typed.
 *
 * This is what makes an AI-fallback-produced import indistinguishable from a
 * natively-parsed one, and what makes it impossible for an AI-sourced
 * statement to be certified on weaker evidence than a native one: it faces
 * the same reconciliation arithmetic and the same certification decision.
 *
 * Refuses unless the document is still in `processing` — the state
 * `attemptAiBankStatementFallback` deliberately left it in — so a stale or
 * replayed confirm on an already-decided document is rejected rather than
 * double-writing.
 */
export async function confirmAiBankStatementFallback(
  userId: string,
  documentId: string,
  reviewed: { rows: readonly ReadBankStatementRow[]; statementPeriodStart: string | null; statementPeriodEnd: string | null; declaredOpeningBalance: number | null; declaredClosingBalance: number | null; maskedAccountIdentifier: string | null },
): Promise<ProcessBankPdfResult> {
  const document = await getOwnedDocument(userId, documentId);
  if (document.processing_status !== 'processing') {
    throw new BankPdfProcessingError('invalid_state', 'This statement has no AI-extracted draft awaiting confirmation.');
  }
  if (!document.financial_account_id) {
    throw new BankPdfProcessingError('account_unresolved', 'account identity is ambiguous — resolve it before confirming');
  }
  if (reviewed.rows.length === 0) {
    throw new BankPdfProcessingError('invalid_state', 'At least one transaction is required.');
  }

  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_confirmed', actorType: 'user' });

  // Re-loaded here rather than carried across the two requests: the dedup
  // index must reflect the account's state NOW, at write time, not as it was
  // when the draft was produced. A statement imported by another tab in
  // between must still be seen.
  const dedupIndex = await loadDedupIndexForAccount(userId, document.financial_account_id);
  const priorRanges = await loadPriorStatementDateRanges(userId, document.financial_account_id, documentId);

  const pipeline = runBankPdfPipelineFromReadRows({
    statementUploadId: documentId,
    financialAccountId: document.financial_account_id,
    currencyCode: document.currency_code ?? 'AUD',
    dedupIndex,
    // Row numbers are re-assigned from the reviewed order so a user who
    // deleted a bogus row cannot leave a gap that would change a source-row
    // hash unpredictably.
    rows: reviewed.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })),
    statementMetadata: {
      declaredOpeningBalance: reviewed.declaredOpeningBalance,
      declaredClosingBalance: reviewed.declaredClosingBalance,
      maskedAccountIdentifier: reviewed.maskedAccountIdentifier,
      statementPeriodStart: reviewed.statementPeriodStart,
      statementPeriodEnd: reviewed.statementPeriodEnd,
    },
    pageCount: document.page_count ?? null,
    declaredPeriodStart: document.statement_period_start,
    declaredPeriodEnd: document.statement_period_end,
    parserVersion: `${AIE_BANK_STATEMENT_PARSER_NAME}@${AIE_BANK_STATEMENT_PARSER_VERSION}`,
  });

  return persistBankPdfPipelineResult({ userId, documentId, document, pipeline, priorRanges });
}

function summariseExisting(document: FdhStatementUpload): ProcessBankPdfResult {
  return {
    document,
    transactionsCreated: document.certified_row_count ?? 0,
    duplicatesSkipped: document.duplicate_row_count ?? 0,
    duplicateCandidates: 0,
    rejectedRows: (document.parsed_row_count ?? 0) - (document.certified_row_count ?? 0) - (document.duplicate_row_count ?? 0),
    certificationStatus: document.certification_status,
    reconciliationStatus: document.reconciliation_status,
    pipelineStatus: 'idempotent_existing',
  };
}
