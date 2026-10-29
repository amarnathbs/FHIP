/**
 * Document2 (4) WP-G (F15, PO-D24-03) -- the bank-statement import WORKER: one bounded, resumable SLICE at a time.
 *
 * WHAT A SLICE IS. `advanceBankImportJob` claims the job's lease (one winner, database clock), does a bounded amount of work for
 * the job's current phase (never longer than `BANK_IMPORT_SLICE_BUDGET_MS` plus one unit of work), checkpoints, and either hands
 * the job on (`more`) or finishes it. It is called by (a) the signed-in browser's poll and (b) the scheduled backstop. Neither is a
 * long-running process; each call is an ordinary web request that ends well inside the platform's 28 seconds.
 *
 * IDEMPOTENT BY CONSTRUCTION. What is left to do is always recomputed from the database, never trusted from a counter: the persist
 * phase writes only the staged lines whose source row is not stored yet; the finalize phase clears the derived rows of the
 * statement before writing them; the plan staging replaces itself. A slice killed at ANY point is simply taken over by the next
 * claim after its lease runs out, and re-does at most one unit of work without duplicating anything.
 *
 * WHAT IS NOT CHANGED. The lines written, their duplicate decisions, the reconciliation, the certification, the review items and
 * the document lifecycle are produced by the SAME functions the synchronous import uses (`finalizeBankCsvImport`,
 * `finalizeBankPdfImport`, `csvTransactionRow`, `pdfTransactionRow`, `runBankCsvPipeline`, `runBankPdfPipeline`,
 * `runBankPdfPipelineFromReadRows`); malware admission is re-checked before the file is parsed; the AI reading still goes through
 * the shared gate (kill switches, Premium entitlement, masking that fails closed) and the atomic per-user cost reservation, once
 * per part.
 *
 * SERVICE ROLE. Runs under the service role (the scheduled backstop has no user session); `runWithFdhServiceClient` makes the
 * repositories use it, and every query is scoped by the job's `user_id`, resolved from the job row itself.
 */

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { runWithFdhServiceClient } from '../dbContext';
import {
  BANK_IMPORT_AI_CALL_TIMEOUT_MS,
  BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART,
  BANK_IMPORT_AI_PARALLEL_PARTS,
  BANK_IMPORT_INSERT_CHUNK,
  BANK_IMPORT_LEASE_SECONDS,
  BANK_IMPORT_MAX_CONSECUTIVE_FAILURES,
  BANK_IMPORT_SLICE_BUDGET_MS,
  sanitiseJobError,
  type BankImportJobRow,
  type BankImportPhase,
  type BankImportReviewReason,
} from '../bankImport/jobModel';
import { chunkRows, rowsStillToWrite, type StagedPlanMeta } from '../bankImport/planStaging';
import { csvProcessResponse, pdfProcessResponse } from '../bankImport/processResponse';
import {
  AI_PAGE_SEPARATOR,
  aiPartPrompt,
  dateHintsForParts,
  datesInForceAtStartOfParts,
  datePlausibilityWindow,
  mappedPartReading,
  mergePartReadings,
  splitMaskedPagesIntoParts,
  type MappedPartReading,
} from '../bankImport/aiChunking';
import {
  bumpChunkAttempts,
  claimJob,
  claimNextJob,
  deleteChunks,
  finishJob,
  getChunk,
  getJobForUser,
  listChunks,
  putChunks,
  releaseForNextSlice,
  updateOwned,

} from './bankImportJobStore';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { downloadDocumentObject } from './storage';
import { recordDocumentAuditEvent } from './auditLog';
import { purgeRawDocumentAfterAiConfirm } from './purge';
import { loadConfirmedAiFallbackDraft, saveAiFallbackDraft } from './aiFallbackDrafts';
import {
  csvTransactionRow,
  duplicateCandidateRefs,
  finalizeBankCsvImport,
  summariseExisting as summariseExistingCsv,
} from './bankCsvProcessingService';
import {
  AI_FALLBACK_ELIGIBLE_PIPELINE_STATUSES,
  errorCodeForPipelineStatus,
  finalizeBankPdfImport,
  pdfTransactionRow,
  recordBankPdfAdapterProvenance,
  summariseExisting as summariseExistingPdf,
  unreadBalancesFromDraft,
  carriedDatesFromDraft,
  type AiReadingContext,
  type BankStatementAiFallbackDraft,
} from './bankPdfProcessingService';
import { runBankCsvPipeline } from '../bank-csv/orchestrator';
import { adapterToRowFormat, mappingToRowFormat } from '../bank-csv/normalize';
import { getAdapterById } from '../bank-csv/adapters/registry';
import { loadDedupIndexForAccount, loadPriorStatementDateRanges } from '../bank-csv/repository';
import { computeStatementOverlap } from '../bank-csv/reconciliation';
import { fetchAllRows } from '../bank-csv/pagination';
import { runBankPdfPipeline, runBankPdfPipelineFromReadRows } from '../bank-pdf/orchestrator';
import { AIE_BANK_STATEMENT_PARSER_NAME, AIE_BANK_STATEMENT_PARSER_VERSION } from '@/lib/aie/adapters/bankStatement/mapping';
import {
  AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
  type BankStatementDocumentFacts,
} from '@/lib/aie/adapters/bankStatement/schema';
import { isAieBankStatementAiFallbackEnabled } from '@/lib/aie/adapters/bankStatement/featureFlags';
import { mapBankStatementFactsToDraft, keepOnlyPrintedBankFigures } from '@/lib/aie/adapters/bankStatement/mapping';
import { requestBankStatementAiExtraction } from '@/lib/aie/adapters/bankStatement/gateway';
import { adapterCallEvidenceMetadata } from '@/lib/aie/adapters/shared/gateway';
import { evaluateAiEgressPreconditions, evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { reviewableMaskedIdentifier } from '@/lib/aie/adapters/shared/reviewDraft';
import { aiFallbackRefusalFromReason } from '@/lib/ai/access/aiFallbackRefusal';
import type { PdfStatementMetadata } from '../bank-pdf/metadata';
import type { FdhStatementUpload } from '../domain/types';
import { AI_BALANCES_NOT_READ_TITLE_CODE, AI_DATES_CARRIED_TITLE_CODE, AI_EXTRACTION_INCOMPLETE_TITLE_CODE, STATEMENT_OVERLAP_TITLE_CODE } from '../domain/categoryReview';

// ---------------------------------------------------------------------------
// Types and small helpers
// ---------------------------------------------------------------------------

export type AdvanceOutcome =
  | { kind: 'advanced'; job: BankImportJobRow }
  | { kind: 'busy'; job: BankImportJobRow }
  | { kind: 'not_runnable'; job: BankImportJobRow }
  | { kind: 'not_found' };

export interface AdvanceOptions {
  /** The signed-in caller (browser poll). The backstop passes none: it claims jobs by themselves. */
  userId?: string;
  /** A protected PDF's password: used in memory by the read phase of THIS call only, never stored. */
  password?: string;
  /** Work budget of the slice (default `BANK_IMPORT_SLICE_BUDGET_MS`). */
  sliceBudgetMs?: number;
  /** Test seams. */
  now?: () => number;
  owner?: string;
}

type SliceEnd = 'more' | 'finished' | 'lost';

interface Ctx {
  job: BankImportJobRow;
  owner: string;
  deadlineAt: number;
  password?: string;
  now: () => number;
}

const timeLeft = (c: Ctx) => c.deadlineAt - c.now();

const EXPIRED_MESSAGE =
  'This upload is no longer available: uploads are kept for a short time only. Please upload the statement again.';

async function loadDoc(userId: string, documentId: string): Promise<FdhStatementUpload | null> {
  const { data, error } = await createAdminClient().from('fdh_statement_uploads').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FdhStatementUpload | null) ?? null;
}

/** Puts the statement in `processing` the way the lifecycle allows: a failed one is re-queued first (failed -> queued -> processing). */
async function startProcessing(userId: string, doc: FdhStatementUpload, startedAtIso: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (doc.processing_status === 'failed') await patchDoc(userId, doc.id, { processing_status: 'queued' });
  await patchDoc(userId, doc.id, { processing_status: 'processing', processing_started_at: startedAtIso, ...extra });
}

async function patchDoc(userId: string, documentId: string, patch: Record<string, unknown>): Promise<FdhStatementUpload | null> {
  const { data, error } = await createAdminClient()
    .from('fdh_statement_uploads')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('user_id', userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FdhStatementUpload | null) ?? null;
}

/** Review items the import itself raises on a statement with no transaction (so they are not removed with the lines). */
const IMPORT_REVIEW_TITLE_CODES = [
  'bank_csv.duplicate_candidates_pending_review',
  'bank_csv.reconciliation_failed',
  'bank_pdf.duplicate_candidates_pending_review',
  'bank_pdf.reconciliation_failed',
  'bank_statement.account_identifier_mismatch',
  STATEMENT_OVERLAP_TITLE_CODE,
  AI_EXTRACTION_INCOMPLETE_TITLE_CODE,
  AI_BALANCES_NOT_READ_TITLE_CODE,
  AI_DATES_CARRIED_TITLE_CODE,
];

/** Removes what a (partly) run import wrote for a statement: its lines, their duplicate candidates, and the rows finalize derives.
 * Never touches another statement, never touches anything a person created. */
export async function clearImportArtifacts(userId: string, documentId: string): Promise<void> {
  const admin = createAdminClient();
  // Duplicate candidates reference the lines; remove them first by the lines' ids.
  const ids = await fetchAllRows<{ id: string }>(
    () =>
      admin.from('fdh_transactions').select('id').eq('user_id', userId).eq('statement_upload_id', documentId).order('id', { ascending: true }) as unknown as {
        range: (a: number, b: number) => PromiseLike<{ data: { id: string }[] | null; error: { message: string } | null }>;
      },
  );
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100).map((r) => r.id);
    const a = await admin.from('fdh_duplicate_candidates').delete().eq('user_id', userId).in('transaction_id_a', slice);
    if (a.error) throw new Error(a.error.message);
    const b = await admin.from('fdh_duplicate_candidates').delete().eq('user_id', userId).in('transaction_id_b', slice);
    if (b.error) throw new Error(b.error.message);
  }
  for (const table of ['fdh_transactions', 'fdh_reconciliation_results', 'fdh_data_quality_results'] as const) {
    const { error } = await admin.from(table).delete().eq('user_id', userId).eq('statement_upload_id', documentId);
    if (error) throw new Error(error.message);
  }
  const prov = await admin.from('fdh_data_provenance').delete().eq('user_id', userId).eq('entity_type', 'fdh_statement_upload').eq('entity_id', documentId);
  if (prov.error) throw new Error(prov.error.message);
  const items = await admin
    .from('fdh_review_items')
    .delete()
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .is('transaction_id', null)
    .eq('status', 'open')
    .in('title_code', IMPORT_REVIEW_TITLE_CODES);
  if (items.error) throw new Error(items.error.message);
}

async function storedSourceRows(userId: string, documentId: string): Promise<Set<number>> {
  const admin = createAdminClient();
  const rows = await fetchAllRows<{ id: string; source_row: number | null }>(
    () =>
      admin
        .from('fdh_transactions')
        .select('id, source_row')
        .eq('user_id', userId)
        .eq('statement_upload_id', documentId)
        .order('id', { ascending: true }) as unknown as {
        range: (a: number, b: number) => PromiseLike<{ data: { id: string; source_row: number | null }[] | null; error: { message: string } | null }>;
      },
  );
  const set = new Set<number>();
  for (const r of rows) if (typeof r.source_row === 'number') set.add(r.source_row);
  return set;
}

async function storedIds(userId: string, documentId: string): Promise<Array<{ id: string; source_row: number | null }>> {
  const admin = createAdminClient();
  return fetchAllRows<{ id: string; source_row: number | null }>(
    () =>
      admin
        .from('fdh_transactions')
        .select('id, source_row')
        .eq('user_id', userId)
        .eq('statement_upload_id', documentId)
        .order('id', { ascending: true }) as unknown as {
        range: (a: number, b: number) => PromiseLike<{ data: { id: string; source_row: number | null }[] | null; error: { message: string } | null }>;
      },
  );
}

// ---------------------------------------------------------------------------
// Slice endings
// ---------------------------------------------------------------------------

async function more(c: Ctx, patch: Record<string, unknown> = {}): Promise<SliceEnd> {
  const r = await releaseForNextSlice(c.job.id, c.owner, patch);
  return r ? 'more' : 'lost';
}

async function complete(c: Ctx, summary: Record<string, unknown>): Promise<SliceEnd> {
  const r = await finishJob(c.job.id, c.owner, {
    status: 'completed',
    phase: 'done',
    review_reason: null,
    result_summary: summary,
    error_code: null,
    error_message_sanitised: null,
    completed_at: new Date(c.now()).toISOString(),
    consecutive_failures: 0,
  });
  if (!r) return 'lost';
  await deleteChunks(c.job.id, c.job.user_id);
  return 'finished';
}

async function needPerson(c: Ctx, reason: BankImportReviewReason, phase: BankImportPhase, patch: Record<string, unknown> = {}): Promise<SliceEnd> {
  const r = await finishJob(c.job.id, c.owner, { ...patch, status: 'review_required', review_reason: reason, phase, consecutive_failures: 0 });
  return r ? 'finished' : 'lost';
}

interface FailOptions {
  /** What to remove: the lines and derived rows written so far and the staged plan (default), or nothing (the AI parts stay for a retry). */
  clean?: 'import' | 'none';
  /** Where a retry resumes. */
  resumePhase?: BankImportPhase;
  /** The error code recorded on the document (an FdhErrorCode); default internal_error. */
  documentErrorCode?: string;
  /** A finished answer to hand the browser (e.g. the refusal note for the AI reading). */
  summary?: Record<string, unknown>;
  /** Leave the document alone (it is already in its final state). */
  keepDocument?: boolean;
}

async function failJob(c: Ctx, code: string, message: string, options: FailOptions = {}): Promise<SliceEnd> {
  const userId = c.job.user_id;
  const documentId = c.job.statement_upload_id;
  try {
    if ((options.clean ?? 'import') === 'import') {
      await clearImportArtifacts(userId, documentId);
      await deleteChunks(c.job.id, userId, ['plan_meta', 'plan_rows']);
    }
    if (!options.keepDocument) {
      const doc = await loadDoc(userId, documentId);
      if (doc && ['processing', 'queued'].includes(doc.processing_status)) {
        await patchDoc(userId, documentId, { processing_status: 'failed', error_code: options.documentErrorCode ?? 'internal_error' });
      }
    }
  } catch (e) {
    console.error('[bank-import] cleanup after failure did not complete', { jobIdPrefix: c.job.id.slice(0, 8), message: sanitiseJobError(e) });
  }
  const r = await finishJob(c.job.id, c.owner, {
    status: 'failed',
    error_code: code,
    error_message_sanitised: sanitiseJobError(message),
    result_summary: options.summary ?? null,
    consecutive_failures: 0,
    checkpoint: { ...c.job.checkpoint, resume_phase: options.resumePhase ?? 'read' },
  });
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: (c.job.source_kind === 'csv' ? 'bank_csv_processing_failed' : 'pdf_processing_failed') as never,
    actorType: 'system',
    metadata: { reason: code },
  }).catch(() => undefined);
  return r ? 'finished' : 'lost';
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

async function stagePlan(c: Ctx, meta: Omit<StagedPlanMeta, 'rowChunkCount'>, rows: Array<Record<string, unknown>>): Promise<void> {
  const { id: jobId, user_id: userId } = c.job;
  // The staging replaces itself: a read slice that was killed half way leaves a partial plan; the re-run starts clean.
  await deleteChunks(jobId, userId, ['plan_meta', 'plan_rows']);
  const chunks = chunkRows(rows);
  await putChunks(jobId, userId, 'plan_rows', chunks.map((rs, seq) => ({ seq, payload: { rows: rs } })));
  // The meta row goes LAST: a persist slice that finds no meta knows the plan is incomplete and goes back to reading.
  await putChunks(jobId, userId, 'plan_meta', [{ seq: 0, payload: { ...meta, rowChunkCount: chunks.length } as unknown as Record<string, unknown> }]);
}

async function loadMeta(c: Ctx): Promise<StagedPlanMeta | null> {
  const chunk = await getChunk(c.job.id, c.job.user_id, 'plan_meta', 0);
  return chunk ? (chunk.payload as unknown as StagedPlanMeta) : null;
}

// ---------------------------------------------------------------------------
// READ phase
// ---------------------------------------------------------------------------

async function readSlice(c: Ctx): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  const doc = await loadDoc(userId, documentId);
  if (!doc) return failJob(c, 'document_not_found', 'This statement could no longer be found.', { clean: 'none', keepDocument: true });

  if (['rejected', 'purge_pending', 'purged'].includes(doc.processing_status) || doc.raw_document_purge_status === 'purged') {
    return failJob(c, 'document_expired', EXPIRED_MESSAGE, { clean: 'none', keepDocument: true });
  }
  // The statement was settled by an earlier slice that was killed before it could mark the job: report it, change nothing.
  if (doc.certification_status && doc.processing_completed_at && ['certified', 'review_required', 'rejected'].includes(doc.certification_status)) {
    return complete(c, job.source_kind === 'csv' ? csvProcessResponse(summariseExistingCsv(doc)) : pdfProcessResponse(summariseExistingPdf(doc)));
  }
  if (!checkFdhDocumentMalwareAdmission(doc).admitted) {
    return failJob(c, 'malware_not_cleared', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE, { clean: 'none', documentErrorCode: 'internal_error' });
  }
  if (!doc.financial_account_id) {
    return failJob(c, 'account_unresolved', 'We could not tell which account this statement belongs to. Please resolve the account before processing.', { clean: 'none', keepDocument: true });
  }
  return job.source_kind === 'csv' ? readCsv(c, doc) : readPdf(c, doc);
}

async function readCsv(c: Ctx, doc: FdhStatementUpload): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  if (!doc.detection_status || doc.detection_status === 'invalid' || doc.detection_status === 'unsupported') {
    return failJob(c, 'not_detected', 'This document has not been successfully detected.', { clean: 'none', keepDocument: true });
  }
  if ((doc.detection_status === 'ambiguous' || doc.detection_status === 'manual_mapping_required') && !doc.mapping_template_id) {
    return failJob(c, 'mapping_required', 'A column mapping must be confirmed before this CSV can be read.', { clean: 'none', keepDocument: true });
  }

  await clearImportArtifacts(userId, documentId);
  await startProcessing(userId, doc, new Date(c.now()).toISOString(), { error_code: null });
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_processing_started', actorType: 'system' });

  if (!doc.raw_document_storage_reference) return failJob(c, 'file_missing', EXPIRED_MESSAGE, { documentErrorCode: 'internal_error' });
  const download = await downloadDocumentObject(doc.raw_document_storage_reference);
  if (!download.ok) return failJob(c, 'file_unreadable', 'We could not read the stored file. Please try again.', { documentErrorCode: 'internal_error' });

  let rowFormat;
  if (doc.mapping_template_id) {
    const admin = createAdminClient();
    const { data: template } = await admin.from('fdh_csv_mapping_templates').select('*').eq('id', doc.mapping_template_id).eq('user_id', userId).maybeSingle();
    if (!template) return failJob(c, 'mapping_missing', 'The saved column mapping could not be found.', { documentErrorCode: 'internal_error' });
    const t = template as { column_mapping: never; amount_convention: never; date_format: string };
    rowFormat = mappingToRowFormat(t.column_mapping, t.amount_convention, t.date_format as never);
  } else if (doc.adapter_key) {
    const adapter = getAdapterById(doc.adapter_key);
    if (!adapter) return failJob(c, 'adapter_missing', 'The statement format is no longer supported.', { documentErrorCode: 'internal_error' });
    rowFormat = adapterToRowFormat(adapter);
  } else {
    return failJob(c, 'no_row_format', 'The statement format could not be determined.', { documentErrorCode: 'internal_error' });
  }

  const dedupIndex = await loadDedupIndexForAccount(userId, doc.financial_account_id as string);
  const priorRanges = await loadPriorStatementDateRanges(userId, doc.financial_account_id as string, documentId);
  const pipeline = runBankCsvPipeline({
    bytes: download.bytes,
    statementUploadId: documentId,
    financialAccountId: doc.financial_account_id as string,
    currencyCode: doc.currency_code ?? 'AUD',
    rowFormatOverride: rowFormat,
    dedupIndex,
    declaredPeriodStart: doc.statement_period_start,
    declaredPeriodEnd: doc.statement_period_end,
  });
  const rowsToInsert = pipeline.accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const rows = rowsToInsert.map((t) => csvTransactionRow(t, { userId, documentId, document: doc, economicFingerprintVersion: pipeline.economicFingerprintVersion }));
  await stagePlan(c, {
    version: 1,
    sourceKind: 'csv',
    origin: 'native',
    acceptedCount: pipeline.accepted.length,
    rowsToInsertCount: rowsToInsert.length,
    duplicateConfirmedCount: pipeline.accepted.length - rowsToInsert.length,
    duplicateCandidates: duplicateCandidateRefs(rowsToInsert),
    overlap: computeStatementOverlap(priorRanges, pipeline.dateCoverage),
    economicFingerprintVersion: pipeline.economicFingerprintVersion,
    csv: {
      detectionStatus: pipeline.detection.status,
      declaredRowCount: pipeline.declaredRowCount,
      parsedRowCount: pipeline.parsedRowCount,
      rejected: pipeline.rejected.map((r) => ({ sourceRowNumber: r.sourceRowNumber, reason: r.reason })),
      reconciliation: pipeline.reconciliation,
      parserVersion: pipeline.parserVersion,
    },
  }, rows);
  return more(c, { phase: 'persist', progress_done: 0, progress_total: rows.length, checkpoint: { ...job.checkpoint, resume_phase: 'read', origin: 'native' } });
}

/** The repair codes a previous rejected attempt left on a part (validation paths only; see the call site). */
function storedRepairCodes(payload: Record<string, unknown>): string[] | null {
  const r = payload.repair;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : null;
}

function metadataFromFacts(facts: BankStatementDocumentFacts): PdfStatementMetadata {
  const num = (v: string | null) => {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    declaredOpeningBalance: num(facts.declaredOpeningBalance.value),
    declaredClosingBalance: num(facts.declaredClosingBalance.value),
    maskedAccountIdentifier: facts.maskedAccountIdentifier.value,
    statementPeriodStart: facts.statementPeriodStart.value,
    statementPeriodEnd: facts.statementPeriodEnd.value,
  };
}

async function readPdf(c: Ctx, doc: FdhStatementUpload): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  if (!['queued', 'failed', 'processing'].includes(doc.processing_status)) {
    return failJob(c, 'invalid_state', 'This document is not currently ready to be processed.', { clean: 'none', keepDocument: true });
  }
  await clearImportArtifacts(userId, documentId);
  await deleteChunks(job.id, userId, ['ai_text', 'ai_result']);
  await startProcessing(userId, doc, new Date(c.now()).toISOString());
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_native_extraction_started', actorType: 'system' });

  if (!doc.raw_document_storage_reference) return failJob(c, 'file_missing', EXPIRED_MESSAGE, { documentErrorCode: 'internal_error' });
  const download = await downloadDocumentObject(doc.raw_document_storage_reference);
  if (!download.ok) return failJob(c, 'file_unreadable', 'We could not read the stored file. Please try again.', { documentErrorCode: 'internal_error' });
  if (doc.error_code === 'password_required') {
    // One attempt is recorded, regardless of outcome: this IS the rate-limit signal (spec 24).
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_password_required', actorType: 'system' });
  }

  const dedupIndex = await loadDedupIndexForAccount(userId, doc.financial_account_id as string);
  const priorRanges = await loadPriorStatementDateRanges(userId, doc.financial_account_id as string, documentId);
  const password = c.password;
  const pipeline = await runBankPdfPipeline({
    bytes: download.bytes,
    statementUploadId: documentId,
    financialAccountId: doc.financial_account_id as string,
    currencyCode: doc.currency_code ?? 'AUD',
    password,
    dedupIndex,
    declaredPeriodStart: doc.statement_period_start,
    declaredPeriodEnd: doc.statement_period_end,
  });
  // `password` is not used again below this line; it is never written anywhere.

  if (pipeline.status === 'encrypted' || pipeline.status === 'password_invalid') {
    // Wrong or missing password: back to 'queued' awaiting a retry (spec 24), never failed: a missing credential for this attempt.
    await patchDoc(userId, documentId, {
      processing_status: 'queued',
      error_code: errorCodeForPipelineStatus(pipeline.status),
      review_status: 'pending',
    });
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_processing_failed', actorType: 'system', metadata: { reason: pipeline.status } });
    return needPerson(c, 'password', 'read', {
      result_summary: { pipeline_status: pipeline.status, error_code: errorCodeForPipelineStatus(pipeline.status), document_id: documentId },
    });
  }
  if (pipeline.status === 'ok' && password) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_decrypted_for_processing', actorType: 'system' });
  }
  if (pipeline.status === 'extraction_timeout') {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_processing_failed', actorType: 'system', metadata: { reason: 'extraction_timeout' } });
    return failJob(c, 'extraction_timeout', 'Reading this PDF took too long, so we stopped. Please try again, or download the statement from your bank again and upload that copy.', {
      clean: 'none',
      documentErrorCode: 'extraction_timeout',
    });
  }

  if (pipeline.status !== 'ok') {
    let refusal: ReturnType<typeof aiFallbackRefusalFromReason>;
    if (AI_FALLBACK_ELIGIBLE_PIPELINE_STATUSES.includes(pipeline.status) && pipeline.extractedPages && pipeline.extractedPages.length > 0) {
      const prepared = await prepareAiReading(c, doc, pipeline.extractedPages, pipeline.status);
      if (prepared.kind === 'started') return prepared.end;
      refusal = prepared.refusal;
    }
    return rejectUnreadable(c, doc, pipeline, refusal);
  }

  await recordBankPdfAdapterProvenance(userId, documentId, doc, pipeline.adapter ? { id: pipeline.adapter.id, version: pipeline.adapter.version } : null, pipeline.detection?.confidence ?? null);
  const rowsToInsert = pipeline.accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const rows = rowsToInsert.map((t) => pdfTransactionRow(t, { userId, documentId, document: doc, economicFingerprintVersion: pipeline.economicFingerprintVersion }));
  await stagePlan(c, {
    version: 1,
    sourceKind: 'pdf',
    origin: 'native',
    acceptedCount: pipeline.accepted.length,
    rowsToInsertCount: rowsToInsert.length,
    duplicateConfirmedCount: pipeline.accepted.length - rowsToInsert.length,
    duplicateCandidates: duplicateCandidateRefs(rowsToInsert),
    overlap: computeStatementOverlap(priorRanges, pipeline.dateCoverage),
    economicFingerprintVersion: pipeline.economicFingerprintVersion,
    pdf: {
      status: pipeline.status,
      rejected: pipeline.rejected.map((r) => ({ sourceRowNumber: r.sourceRowNumber, reason: r.reason })),
      unparseableBlockCount: pipeline.unparseableBlockCount,
      reconciliation: pipeline.reconciliation,
      statementMetadata: pipeline.statementMetadata,
      parserVersion: pipeline.parserVersion,
      pageCount: pipeline.pageCount,
      statementExtractionConfidence: pipeline.statementExtractionConfidence,
    },
  }, rows);
  return more(c, { phase: 'persist', progress_done: 0, progress_total: rows.length, checkpoint: { ...job.checkpoint, resume_phase: 'read', origin: 'native' } });
}

/** A PDF that cannot be read at all: the document is rejected exactly as the synchronous import rejected it. */
async function rejectUnreadable(
  c: Ctx,
  doc: FdhStatementUpload,
  pipeline: { status: Parameters<typeof errorCodeForPipelineStatus>[0]; pageCount: number | null; statementExtractionConfidence: number | null; rejected: unknown[] },
  refusal: ReturnType<typeof aiFallbackRefusalFromReason>,
): Promise<SliceEnd> {
  const userId = c.job.user_id;
  const documentId = c.job.statement_upload_id;
  const errorCode = errorCodeForPipelineStatus(pipeline.status);
  const finalDoc = await patchDoc(userId, documentId, {
    processing_status: 'rejected',
    certification_status: 'rejected',
    error_code: errorCode,
    review_status: 'pending',
    page_count: pipeline.pageCount,
    pdf_classification:
      pipeline.status === 'corrupt' ? 'corrupt' : pipeline.status === 'image_only' ? 'image_only' : pipeline.status === 'page_limit_exceeded' ? 'unsupported' : null,
    extraction_confidence: pipeline.statementExtractionConfidence,
    processing_completed_at: new Date(c.now()).toISOString(),
  });
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'pdf_processing_failed', actorType: 'system', metadata: { reason: pipeline.status } });
  const summary = pdfProcessResponse({
    document: (finalDoc ?? doc) as FdhStatementUpload,
    transactionsCreated: 0,
    duplicatesSkipped: 0,
    duplicateCandidates: 0,
    rejectedRows: pipeline.rejected.length,
    certificationStatus: 'rejected',
    reconciliationStatus: null,
    pipelineStatus: pipeline.status,
    ...(refusal ? { aiFallbackRefusal: refusal } : {}),
  });
  return failJob(c, errorCode ?? 'unreadable', `This statement could not be read (${errorCode ?? pipeline.status}).`, { clean: 'none', keepDocument: true, summary });
}

// ---------------------------------------------------------------------------
// AI reading in parts
// ---------------------------------------------------------------------------

type PrepareOutcome = { kind: 'started'; end: SliceEnd } | { kind: 'refused'; refusal: ReturnType<typeof aiFallbackRefusalFromReason> };

async function prepareAiReading(c: Ctx, doc: FdhStatementUpload, pages: string[], nativeStatus: string): Promise<PrepareOutcome> {
  const userId = c.job.user_id;
  const documentId = c.job.statement_upload_id;
  const gate = await evaluateAiFallbackGate({
    userId,
    adapterEnabled: isAieBankStatementAiFallbackEnabled(),
    extractedText: pages.join(AI_PAGE_SEPARATOR),
  });
  if (!gate.ok) {
    if (gate.reason === 'masking_below_policy') {
      await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_masking_below_policy', actorType: 'system' });
    }
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'bank_statement_ai_fallback_not_usable',
      actorType: 'system',
      metadata: { reason: gate.reason, nativePipelineStatus: nativeStatus },
    });
    return { kind: 'refused', refusal: aiFallbackRefusalFromReason(gate.reason) };
  }
  const maskedPages = gate.maskedText.split('\f');
  const parts = splitMaskedPagesIntoParts(maskedPages);
  if (parts.length === 0) return { kind: 'refused', refusal: undefined };
  await putChunks(c.job.id, userId, 'ai_text', parts.map((p) => ({ seq: p.seq, payload: { text: p.text, pageFrom: p.pageFrom, pageTo: p.pageTo, lineCount: p.lineCount } })));
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_attempted', actorType: 'system', metadata: { parts: parts.length } });
  const end = await more(c, {
    phase: 'ai_read',
    progress_done: 0,
    progress_total: parts.length,
    checkpoint: { ...c.job.checkpoint, resume_phase: 'ai_read', origin: 'ai', native_status: nativeStatus, parts_total: parts.length },
  });
  return { kind: 'started', end };
}

const HARD_STOP_OUTCOMES = new Set(['user_daily_cap_reached', 'budget_exhausted', 'kill_switch_blocked', 'unmasked_pii_detected']);

function aiStopMessage(outcome: string): { code: string; message: string; refusal?: ReturnType<typeof aiFallbackRefusalFromReason> } {
  if (outcome === 'user_daily_cap_reached') {
    return {
      code: 'ai_daily_limit',
      message: 'You have reached today\'s limit for AI statement reading. What was read is saved: try again tomorrow, or upload a CSV of the same statement.',
      refusal: aiFallbackRefusalFromReason('user_daily_cap_reached'),
    };
  }
  if (outcome === 'budget_exhausted') return { code: 'ai_unavailable', message: 'AI statement reading is not available right now. Please try again later, or upload a CSV of the same statement.' };
  return { code: 'ai_unavailable', message: 'AI statement reading is not available for this statement.' };
}

async function aiReadSlice(c: Ctx): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;

  const doc = await loadDoc(userId, documentId);
  if (!doc || ['rejected', 'purge_pending', 'purged'].includes(doc.processing_status)) {
    return failJob(c, 'document_expired', EXPIRED_MESSAGE, { clean: 'none', keepDocument: true });
  }
  const texts = await listChunks(job.id, userId, 'ai_text');
  const results = await listChunks(job.id, userId, 'ai_result');
  if (texts.length === 0) {
    // The parts were lost (staging swept): start the reading again from the file.
    return more(c, { phase: 'read', progress_done: 0, progress_total: null });
  }
  // The date in force where each part starts (the bank prints a date only on the first transaction of a day), computed from the STORED part
  // texts in order: deterministic, identical on every slice, retry and resume.
  const partTexts = texts.map((t) => String(t.payload.text ?? ''));
  const dateHints = dateHintsForParts(partTexts);
  const datesInForce = datesInForceAtStartOfParts(partTexts);
  const doneSeqs = new Set(results.map((r) => r.seq));
  const pending = texts.filter((t) => !doneSeqs.has(t.seq));

  if (pending.length > 0) {
    // Re-checked before EACH step: a switch turned off or a plan that lapsed part-way stops the next part.
    const pre = await evaluateAiEgressPreconditions({ userId, adapterEnabled: isAieBankStatementAiFallbackEnabled() });
    if (!pre.ok) {
      const refusal = aiFallbackRefusalFromReason(pre.reason);
      return failJob(c, `ai_${pre.reason}`, 'The AI reading of this statement could not continue. What was read so far is saved.', {
        clean: 'none',
        resumePhase: 'ai_read',
        summary: refusal ? { ai_fallback_refusal: refusal, document_id: documentId } : undefined,
      });
    }
    const batch = pending.filter((p) => p.attempts < BANK_IMPORT_AI_MAX_ATTEMPTS_PER_PART).slice(0, BANK_IMPORT_AI_PARALLEL_PARTS);
    if (batch.length === 0) {
      return failJob(c, 'ai_part_failed', 'Part of this statement could not be read after several tries. What was read so far is saved; please try again, or upload a CSV of the same statement.', {
        clean: 'none',
        resumePhase: 'ai_read',
      });
    }
    const dateHintFor = (seq: number) => {
      const at = texts.findIndex((t) => t.seq === seq);
      return at >= 0 ? dateHints[at] : null;
    };
    // The safety net (a row that still comes back without a usable date takes the date of the line above) may use the date in force even
    // when the prompt needed no hint.
    const dateInForceFor = (seq: number) => {
      const at = texts.findIndex((t) => t.seq === seq);
      return at >= 0 ? datesInForce[at] : null;
    };
    let hardStop: string | null = null;
    await Promise.all(
      batch.map(async (part) => {
        await bumpChunkAttempts(part);
        const outcome = await requestBankStatementAiExtraction({
          // 28-10-2026: after a schema_rejected, the next attempt carries the validation issue PATHS (never values) as a short repair note.
          maskedText: aiPartPrompt({ seq: part.seq, pageFrom: Number(part.payload.pageFrom), pageTo: Number(part.payload.pageTo), text: String(part.payload.text) }, texts.length, storedRepairCodes(part.payload), dateHintFor(part.seq)),
          requestId: `${documentId}:part${part.seq}`,
          userId,
          dateInForceIso: dateInForceFor(part.seq)?.iso ?? null,
          dateWindow: datePlausibilityWindow(String(part.payload.text), dateInForceFor(part.seq) ?? null),
          timeoutMs: BANK_IMPORT_AI_CALL_TIMEOUT_MS,
          maxTransientRetries: 0,
        });
        if (outcome.outcome !== 'success') {
          if (HARD_STOP_OUTCOMES.has(outcome.outcome)) hardStop = outcome.outcome;
          if (outcome.outcome === 'schema_rejected' && outcome.evidence?.schemaErrorCodes?.length) {
            // Kept on the part (not on the attempt counter, which is untouched) so the next slice's call can ask for a correction.
            const codes = outcome.evidence.schemaErrorCodes.filter((x) => /^[A-Za-z0-9_.()]{1,80}:[A-Za-z0-9_]{1,40}$/.test(x)).slice(0, 60);
            if (codes.length > 0) await putChunks(job.id, userId, 'ai_text', [{ seq: part.seq, payload: { ...part.payload, repair: codes } }]).catch(() => undefined);
          }
          await recordDocumentAuditEvent({
            userId,
            documentId,
            eventType: 'bank_statement_ai_fallback_provider_outcome',
            actorType: 'system',
            metadata: { outcome: outcome.outcome, part: part.seq, ...adapterCallEvidenceMetadata(outcome.evidence) },
          }).catch(() => undefined);
          return;
        }
        const facts = outcome.facts;
        const mapped = facts.transactions.length > 0 ? mapBankStatementFactsToDraft(facts, outcome.notes) : null;
        const kept = mapped ? keepOnlyPrintedBankFigures(mapped, String(part.payload.text)) : null;
        const reading = mappedPartReading(part.seq, kept, {
          allTransactionsListed: facts.allTransactionsListed,
          institutionName: facts.institutionName.value,
          metadata: metadataFromFacts(facts),
        }, {
          opening: Boolean(outcome.notes?.declaredOpeningNotRead) || Boolean(kept?.warnings.includes('ai_opening_balance_sign_contradicts_document_dropped')),
          closing: Boolean(outcome.notes?.declaredClosingNotRead) || Boolean(kept?.warnings.includes('ai_closing_balance_sign_contradicts_document_dropped')),
        });
        await putChunks(job.id, userId, 'ai_result', [{ seq: part.seq, payload: reading as unknown as Record<string, unknown> }]);
      }),
    );
    if (hardStop) {
      const stop = aiStopMessage(hardStop);
      return failJob(c, stop.code, stop.message, {
        clean: 'none',
        resumePhase: 'ai_read',
        summary: stop.refusal ? { ai_fallback_refusal: stop.refusal, document_id: documentId } : undefined,
      });
    }
    const nowDone = (await listChunks(job.id, userId, 'ai_result', { withPayload: false })).length;
    if (nowDone < texts.length) return more(c, { progress_done: nowDone, progress_total: texts.length });
  }
  return finishAiReading(c, doc, texts.length);
}

async function finishAiReading(c: Ctx, doc: FdhStatementUpload, partsTotal: number): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  const results = await listChunks(job.id, userId, 'ai_result');
  const merged = mergePartReadings(results.map((r) => r.payload as unknown as MappedPartReading));
  if (merged.rows.length === 0) {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_insufficient_fields', actorType: 'system' });
    await deleteChunks(job.id, userId, ['ai_text', 'ai_result']);
    return rejectUnreadable(c, doc, { status: (job.checkpoint.native_status as never) ?? 'unsupported_layout', pageCount: null, statementExtractionConfidence: null, rejected: [] }, undefined);
  }
  const draft: BankStatementAiFallbackDraft = {
    rows: merged.rows,
    institutionName: merged.institutionName,
    maskedAccountIdentifier: reviewableMaskedIdentifier(merged.statementMetadata.maskedAccountIdentifier),
    statementPeriodStart: merged.statementMetadata.statementPeriodStart,
    statementPeriodEnd: merged.statementMetadata.statementPeriodEnd,
    declaredOpeningBalance: merged.statementMetadata.declaredOpeningBalance,
    declaredClosingBalance: merged.statementMetadata.declaredClosingBalance,
    allTransactionsListed: merged.allTransactionsListed,
    warnings: merged.warnings,
    ...(merged.balancesNotRead > 0 ? { balancesNotRead: merged.balancesNotRead } : {}),
    ...(merged.declaredBalancesNotRead > 0 ? { declaredBalancesNotRead: merged.declaredBalancesNotRead } : {}),
    ...(merged.datesCarriedForward > 0 ? { datesCarriedForward: merged.datesCarriedForward } : {}),
  };
  // Persisted BEFORE the person sees it (migration 0197): the confirm is accepted only against a draft the server issued, once.
  const saved = await saveAiFallbackDraft({
    userId,
    documentId,
    documentType: 'bank_statement',
    schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
    payload: draft,
    providerIdempotencyKey: null,
  });
  if (!saved.persisted && saved.reason === 'write_failed') {
    throw new Error(`the AI draft could not be saved: ${saved.detail ?? 'unknown'}`);
  }
  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'bank_statement_ai_fallback_draft_ready',
    actorType: 'system',
    metadata: { draft_persisted: saved.persisted, rows: draft.rows.length, parts: partsTotal },
  });
  // The parts did their job; the reviewable draft is the durable result now.
  await deleteChunks(job.id, userId, ['ai_text', 'ai_result']);
  return needPerson(c, 'ai_draft', 'ai_review', {
    progress_done: partsTotal,
    progress_total: partsTotal,
    result_summary: null,
    checkpoint: { ...job.checkpoint, resume_phase: 'plan_confirmed', parts_total: partsTotal },
  });
}

// ---------------------------------------------------------------------------
// PLAN from the person-confirmed AI reading
// ---------------------------------------------------------------------------

async function confirmedPlanSlice(c: Ctx): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  const doc = await loadDoc(userId, documentId);
  if (!doc || ['rejected', 'purge_pending', 'purged'].includes(doc.processing_status)) {
    return failJob(c, 'document_expired', EXPIRED_MESSAGE, { clean: 'none', keepDocument: true });
  }
  if (!doc.financial_account_id) return failJob(c, 'account_unresolved', 'We could not tell which account this statement belongs to. Please resolve the account before confirming.', { clean: 'none', keepDocument: true, resumePhase: 'plan_confirmed' });
  const confirmed = await loadConfirmedAiFallbackDraft(userId, documentId);
  if (!confirmed.found) {
    return failJob(c, 'draft_missing', 'The checked reading could not be found. Please read the statement again.', { clean: 'none', resumePhase: 'read' });
  }
  const reviewed = confirmed.confirmedPayload as {
    rows: Array<{ transactionDate: string; descriptionRaw: string; amountOriginal: number; creditDebit: 'credit' | 'debit'; balanceAfter: number | null }>;
    statementPeriodStart: string | null;
    statementPeriodEnd: string | null;
    declaredOpeningBalance: number | null;
    declaredClosingBalance: number | null;
    maskedAccountIdentifier: string | null;
  };
  const issued = (confirmed.payload ?? {}) as Partial<BankStatementAiFallbackDraft>;
  const aiContext: AiReadingContext = {
    institutionName: typeof issued.institutionName === 'string' ? issued.institutionName : null,
    allTransactionsListed: typeof issued.allTransactionsListed === 'boolean' ? issued.allTransactionsListed : null,
    warningCount: Array.isArray(issued.warnings) ? issued.warnings.length : 0,
    rowsRead: Array.isArray(issued.rows) ? issued.rows.length : reviewed.rows.length,
    inParts: Number(job.checkpoint.parts_total ?? 0) > 1,
    ...unreadBalancesFromDraft(issued, reviewed.rows, reviewed),
    ...carriedDatesFromDraft(issued, reviewed.rows.length),
  };

  await clearImportArtifacts(userId, documentId);
  // Re-loaded here rather than carried across requests: the dedup index must reflect the account's state NOW, at write time.
  const dedupIndex = await loadDedupIndexForAccount(userId, doc.financial_account_id);
  const priorRanges = await loadPriorStatementDateRanges(userId, doc.financial_account_id, documentId);
  const pipeline = runBankPdfPipelineFromReadRows({
    statementUploadId: documentId,
    financialAccountId: doc.financial_account_id,
    currencyCode: doc.currency_code ?? 'AUD',
    dedupIndex,
    // Row numbers are re-assigned from the reviewed order so a person who deleted a bogus row cannot leave a gap.
    rows: reviewed.rows.map((r, i) => ({ ...r, sourceRowNumber: i + 1 })),
    statementMetadata: {
      declaredOpeningBalance: reviewed.declaredOpeningBalance,
      declaredClosingBalance: reviewed.declaredClosingBalance,
      maskedAccountIdentifier: reviewed.maskedAccountIdentifier,
      statementPeriodStart: reviewed.statementPeriodStart,
      statementPeriodEnd: reviewed.statementPeriodEnd,
    },
    pageCount: doc.page_count ?? null,
    declaredPeriodStart: doc.statement_period_start,
    declaredPeriodEnd: doc.statement_period_end,
    parserVersion: `${AIE_BANK_STATEMENT_PARSER_NAME}@${AIE_BANK_STATEMENT_PARSER_VERSION}`,
  });
  await recordBankPdfAdapterProvenance(userId, documentId, doc, null, null);
  const rowsToInsert = pipeline.accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
  const rows = rowsToInsert.map((t) => pdfTransactionRow(t, { userId, documentId, document: doc, economicFingerprintVersion: pipeline.economicFingerprintVersion }));
  await startProcessing(userId, doc, new Date(c.now()).toISOString(), { error_code: null });
  await stagePlan(c, {
    version: 1,
    sourceKind: 'pdf',
    origin: 'ai_confirmed',
    acceptedCount: pipeline.accepted.length,
    rowsToInsertCount: rowsToInsert.length,
    duplicateConfirmedCount: pipeline.accepted.length - rowsToInsert.length,
    duplicateCandidates: duplicateCandidateRefs(rowsToInsert),
    overlap: computeStatementOverlap(priorRanges, pipeline.dateCoverage),
    economicFingerprintVersion: pipeline.economicFingerprintVersion,
    pdf: {
      status: pipeline.status,
      rejected: pipeline.rejected.map((r) => ({ sourceRowNumber: r.sourceRowNumber, reason: r.reason })),
      unparseableBlockCount: pipeline.unparseableBlockCount,
      reconciliation: pipeline.reconciliation,
      statementMetadata: pipeline.statementMetadata,
      parserVersion: pipeline.parserVersion,
      pageCount: pipeline.pageCount,
      statementExtractionConfidence: pipeline.statementExtractionConfidence,
    },
    aiContext,
  }, rows);
  return more(c, { phase: 'persist', progress_done: 0, progress_total: rows.length, checkpoint: { ...job.checkpoint, resume_phase: 'plan_confirmed', origin: 'ai_confirmed' } });
}

// ---------------------------------------------------------------------------
// PERSIST phase
// ---------------------------------------------------------------------------

async function persistSlice(c: Ctx): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  const meta = await loadMeta(c);
  if (!meta) {
    // The plan is incomplete or gone (a read slice was killed while staging, or the staging was swept): read again.
    return more(c, { phase: (job.checkpoint.resume_phase as BankImportPhase | undefined) === 'plan_confirmed' ? 'plan_confirmed' : 'read', progress_done: 0 });
  }
  const doc = await loadDoc(userId, documentId);
  if (!doc || ['rejected', 'purge_pending', 'purged'].includes(doc.processing_status)) {
    return failJob(c, 'document_expired', EXPIRED_MESSAGE, { clean: 'import', keepDocument: true });
  }

  const stored = await storedSourceRows(userId, documentId);
  const chunkIndex = await listChunks(job.id, userId, 'plan_rows', { withPayload: false });
  const admin = createAdminClient();
  let batchMs = 0;
  let batches = 0;

  for (const idx of chunkIndex) {
    if (stored.size >= meta.rowsToInsertCount) break;
    const chunk = await getChunk(job.id, userId, 'plan_rows', idx.seq);
    if (!chunk) continue;
    const todo = rowsStillToWrite((chunk.payload.rows ?? []) as Array<{ source_row?: unknown }>, stored);
    for (const batch of chunkRows(todo, BANK_IMPORT_INSERT_CHUNK)) {
      // Stop starting new batches when the next one might not finish inside the slice. Every slice writes at least one batch, so a
      // slice can never make no progress (and the tests can drive it one batch at a time with a zero budget).
      if (batches > 0 && timeLeft(c) < Math.max(1_500, batchMs * 1.6)) return persistProgress(c, stored.size, meta.rowsToInsertCount);
      const t0 = c.now();
      const { error } = await admin.from('fdh_transactions').insert(batch as never);
      if (error) {
        // A line of this batch is already stored (a previous slice died after writing it and before the checkpoint): re-read what is
        // stored and carry on; anything else is a real failure.
        if (/duplicate key|23505|uq_fdh_transactions_statement_source_row/i.test(error.message ?? '')) {
          const fresh = await storedSourceRows(userId, documentId);
          for (const s of fresh) stored.add(s);
          continue;
        }
        throw new Error(error.message);
      }
      for (const r of batch as Array<{ source_row?: unknown }>) if (typeof r.source_row === 'number') stored.add(r.source_row);
      batches += 1;
      batchMs = Math.max(batchMs, c.now() - t0);
      // Checkpoint, and renew the lease: if it was taken over this write matches nothing and the slice stops.
      const renewed = await updateOwned(job.id, c.owner, {
        progress_done: Math.min(stored.size, meta.rowsToInsertCount),
        progress_total: meta.rowsToInsertCount,
        lease_expires_at: new Date(c.now() + BANK_IMPORT_LEASE_SECONDS * 1000).toISOString(),
        heartbeat_at: new Date(c.now()).toISOString(),
      });
      if (!renewed) return 'lost';
    }
  }

  if (stored.size < meta.rowsToInsertCount) return persistProgress(c, stored.size, meta.rowsToInsertCount);
  // Everything is stored: finalize (in this slice when there is time, otherwise in the next).
  // Finalize is chained into this slice only when there is clearly room for it (measured on DEV: a 3,000-line finalize needs several
  // seconds of round trips); otherwise it gets a slice of its own.
  if (timeLeft(c) < 9_000) return more(c, { phase: 'finalize', progress_done: meta.rowsToInsertCount, progress_total: meta.rowsToInsertCount });
  const upd = await updateOwned(job.id, c.owner, { phase: 'finalize', progress_done: meta.rowsToInsertCount, progress_total: meta.rowsToInsertCount });
  if (!upd) return 'lost';
  return finalizeSlice({ ...c, job: upd });
}

async function persistProgress(c: Ctx, stored: number, total: number): Promise<SliceEnd> {
  return more(c, { progress_done: Math.min(stored, total), progress_total: total });
}

// ---------------------------------------------------------------------------
// FINALIZE phase
// ---------------------------------------------------------------------------

async function finalizeSlice(c: Ctx): Promise<SliceEnd> {
  const { job } = c;
  const userId = job.user_id;
  const documentId = job.statement_upload_id;
  const meta = await loadMeta(c);
  if (!meta) return more(c, { phase: (job.checkpoint.resume_phase as BankImportPhase | undefined) === 'plan_confirmed' ? 'plan_confirmed' : 'read', progress_done: 0 });
  const doc = await loadDoc(userId, documentId);
  if (!doc) return failJob(c, 'document_not_found', 'This statement could no longer be found.', { clean: 'none', keepDocument: true });

  // A previous finalize wrote the whole result and was killed before it marked the job: report it, write nothing.
  if (doc.processing_completed_at && doc.certification_status && ['certified', 'review_required', 'rejected', 'partial'].includes(doc.certification_status)) {
    return complete(c, job.source_kind === 'csv' ? csvProcessResponse(summariseExistingCsv(doc)) : pdfProcessResponse(summariseExistingPdf(doc)));
  }
  // The lines must all be there; if not, go back to persisting them.
  const ids = await storedIds(userId, documentId);
  const storedCount = new Set(ids.map((r) => r.source_row)).size;
  if (storedCount < meta.rowsToInsertCount) return more(c, { phase: 'persist' });

  // Idempotent re-run: clear what a previous, killed finalize derived (the LINES are kept). The FIRST run of finalize has nothing to
  // clear, and clearing is a round trip per few hundred lines, so it is skipped: a durable flag, written before anything is derived,
  // tells a re-run (a killed finalize leaves the flag set) that it must clear first. Measured on DEV: this cost 30 s on 3,000 lines.
  if (job.checkpoint.finalize_started === true) {
    await clearDerived(userId, documentId);
  } else {
    const marked = await updateOwned(job.id, c.owner, { checkpoint: { ...job.checkpoint, finalize_started: true } });
    if (!marked) return 'lost';
  }
  const document = (await loadDoc(userId, documentId)) as FdhStatementUpload;

  let summary: Record<string, unknown>;
  if (meta.sourceKind === 'csv' && meta.csv) {
    const result = await finalizeBankCsvImport({
      userId,
      documentId,
      document,
      pipeline: { ...meta.csv, rejected: meta.csv.rejected as never },
      rowsInserted: meta.rowsToInsertCount,
      duplicateConfirmedCount: meta.duplicateConfirmedCount,
      duplicateCandidates: meta.duplicateCandidates,
      insertedIds: ids,
      overlap: meta.overlap,
    });
    summary = csvProcessResponse(result);
  } else if (meta.pdf) {
    const result = await finalizeBankPdfImport({
      userId,
      documentId,
      document,
      pipeline: {
        status: meta.pdf.status,
        acceptedCount: meta.acceptedCount,
        rejected: meta.pdf.rejected,
        unparseableBlockCount: meta.pdf.unparseableBlockCount,
        reconciliation: meta.pdf.reconciliation,
        statementMetadata: meta.pdf.statementMetadata,
        parserVersion: meta.pdf.parserVersion,
        pageCount: meta.pdf.pageCount,
        statementExtractionConfidence: meta.pdf.statementExtractionConfidence,
      },
      rowsInserted: meta.rowsToInsertCount,
      duplicateConfirmedCount: meta.duplicateConfirmedCount,
      duplicateCandidates: meta.duplicateCandidates,
      insertedIds: ids,
      overlap: meta.overlap,
      aiContext: meta.aiContext,
    });
    summary = pdfProcessResponse(result);
  } else {
    return failJob(c, 'plan_invalid', 'The staged import is incomplete. Please try again.', { resumePhase: 'read' });
  }
  const end = await complete(c, summary);
  // PO decision 2026-10-01: once the checked reading is durably saved the raw upload goes (best effort, never throws).
  if (end === 'finished' && meta.origin === 'ai_confirmed') await purgeRawDocumentAfterAiConfirm(userId, documentId);
  return end;
}

/** Removes the rows finalize derives, keeping the statement's lines. */
async function clearDerived(userId: string, documentId: string): Promise<void> {
  const admin = createAdminClient();
  const ids = await storedIds(userId, documentId);
  for (let i = 0; i < ids.length; i += 250) {
    const slice = ids.slice(i, i + 250).map((r) => r.id);
    const [a, b] = await Promise.all([
      admin.from('fdh_duplicate_candidates').delete().eq('user_id', userId).in('transaction_id_a', slice),
      admin.from('fdh_duplicate_candidates').delete().eq('user_id', userId).in('transaction_id_b', slice),
    ]);
    if (a.error) throw new Error(a.error.message);
    if (b.error) throw new Error(b.error.message);
  }
  for (const table of ['fdh_reconciliation_results', 'fdh_data_quality_results'] as const) {
    const { error } = await admin.from(table).delete().eq('user_id', userId).eq('statement_upload_id', documentId);
    if (error) throw new Error(error.message);
  }
  const prov = await admin.from('fdh_data_provenance').delete().eq('user_id', userId).eq('entity_type', 'fdh_statement_upload').eq('entity_id', documentId);
  if (prov.error) throw new Error(prov.error.message);
  const items = await admin
    .from('fdh_review_items')
    .delete()
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .is('transaction_id', null)
    .eq('status', 'open')
    .in('title_code', IMPORT_REVIEW_TITLE_CODES);
  if (items.error) throw new Error(items.error.message);
}

// ---------------------------------------------------------------------------
// Dispatch and the public entry points
// ---------------------------------------------------------------------------

async function runSlice(c: Ctx): Promise<SliceEnd> {
  switch (c.job.phase) {
    case 'read':
      return readSlice(c);
    case 'ai_read':
      return aiReadSlice(c);
    case 'plan_confirmed':
      return confirmedPlanSlice(c);
    case 'persist':
      return persistSlice(c);
    case 'finalize':
      return finalizeSlice(c);
    default:
      // ai_review / done are never runnable; hand the lease back untouched.
      return more(c);
  }
}

async function runClaimed(claimed: BankImportJobRow, owner: string, opts: AdvanceOptions): Promise<BankImportJobRow> {
  const now = opts.now ?? Date.now;
  const c: Ctx = { job: claimed, owner, now, deadlineAt: now() + (opts.sliceBudgetMs ?? BANK_IMPORT_SLICE_BUDGET_MS), password: opts.password };
  try {
    await runWithFdhServiceClient(createAdminClient(), () => runSlice(c));
  } catch (e) {
    const failures = claimed.consecutive_failures + 1;
    console.error('[bank-import] slice failed', { jobIdPrefix: claimed.id.slice(0, 8), phase: claimed.phase, failures, message: sanitiseJobError(e) });
    try {
      if (failures >= BANK_IMPORT_MAX_CONSECUTIVE_FAILURES) {
        await runWithFdhServiceClient(createAdminClient(), () =>
          failJob(c, 'internal_error', 'We could not finish importing this statement. Please try again.', { resumePhase: claimed.phase === 'ai_read' ? 'ai_read' : 'read', clean: claimed.phase === 'ai_read' ? 'none' : 'import' }),
        );
      } else {
        await updateOwned(claimed.id, owner, {
          status: 'queued',
          lease_owner: null,
          lease_expires_at: null,
          consecutive_failures: failures,
          error_message_sanitised: sanitiseJobError(e),
          last_slice_at: new Date(now()).toISOString(),
        });
      }
    } catch (inner) {
      // Even recording the failure failed: leave the lease to run out; the next claim takes over.
      console.error('[bank-import] could not record a slice failure', { message: sanitiseJobError(inner) });
    }
  }
  const after = await getJobForUser(claimed.user_id, claimed.id);
  return after ?? claimed;
}

/**
 * Advances one job by one slice. Safe to call any number of times, from any number of tabs and from the backstop at once:
 * exactly one caller holds the lease; the others get `busy` and the job's current state.
 */
export async function advanceBankImportJob(jobId: string, opts: AdvanceOptions = {}): Promise<AdvanceOutcome> {
  let current: BankImportJobRow | null;
  if (opts.userId) {
    current = await getJobForUser(opts.userId, jobId);
  } else {
    const { data, error } = await createAdminClient().from('fdh_bank_import_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw new Error(error.message);
    current = (data as BankImportJobRow | null) ?? null;
  }
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'queued' && current.status !== 'processing') return { kind: 'not_runnable', job: current };
  const owner = opts.owner ?? randomUUID();
  const claimed = await claimJob(jobId, owner);
  if (!claimed) {
    const latest = (await getJobForUser(current.user_id, jobId)) ?? current;
    return { kind: 'busy', job: latest };
  }
  const job = await runClaimed(claimed, owner, opts);
  return { kind: 'advanced', job };
}

/** Backstop: claims the most overdue unfinished job nobody holds and advances it by one slice. null = nothing to do. */
export async function advanceNextBankImportJob(opts: AdvanceOptions = {}): Promise<AdvanceOutcome | null> {
  const owner = opts.owner ?? randomUUID();
  const claimed = await claimNextJob(owner);
  if (!claimed) return null;
  const job = await runClaimed(claimed, owner, opts);
  return { kind: 'advanced', job };
}
