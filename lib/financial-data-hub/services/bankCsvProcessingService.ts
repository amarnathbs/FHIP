/**
 * R7 — Bank CSV Engine: detection, mapping and processing orchestration
 * (spec sections 18-23, 42-46, 55-56).
 *
 * ORCHESTRATION vs ENGINE. This file does the DATABASE work: fetching
 * inputs, calling the pure engine in `lib/financial-data-hub/bank-csv/*`,
 * and persisting the result. It performs no CSV parsing, no dedup decision
 * and no reconciliation arithmetic itself — see `bank-csv/orchestrator.ts`
 * for that.
 *
 * RETRY SAFETY (spec 56). `processBankCsvDocument()` is idempotent: if the
 * document was already certified in a PRIOR successful attempt, a repeated
 * call is a no-op that returns the existing result. If a prior attempt
 * FAILED partway (some transactions committed before a later chunk failed),
 * the compensating cleanup below removes every row this document produced
 * before the fresh attempt runs — never layering a second attempt's rows on
 * top of a first attempt's partial ones.
 *
 * SERVICE-ROLE CARVE-OUT (spec 51-52, 82). Migration 0064 adds DB triggers
 * blocking the `authenticated` role from writing R7's authoritative columns
 * on `fdh_statement_uploads`/`fdh_transactions` directly, and from INSERTing
 * into `fdh_transactions`/`fdh_reconciliation_results`/`fdh_data_quality_
 * results`/`fdh_data_provenance`/`fdh_duplicate_candidates` at all — those
 * four tables had no writer before R7, so this is a zero-regression, R7-only
 * boundary. This file is therefore a THIRD sanctioned service-role file
 * (alongside `services/storage.ts` and `services/auditLog.ts`) for exactly
 * those writes — every admin-client call below is preceded by an
 * RLS-scoped ownership read (`getOwnedDocument`) and explicitly re-scopes
 * with `.eq('user_id', userId)` regardless, matching the discipline those
 * two files already established.
 */

import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { fdhDbClient } from '../dbContext';
import { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } from './identicalUpload';
import { createAdminClient } from '@/lib/supabase/admin';
import { processingRunState, STATEMENT_STILL_BEING_READ_MESSAGE } from './interruptedRun';
import {
  ingestionJobsRepository,
  parserRegistryRepository,
  parserVersionsRepository,
  reviewItemsRepository,
  statementUploadsRepository,
} from '../repositories';
import { csvMappingTemplatesRepository } from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { detectBankCsvFormat } from '../bank-csv/detection';
import { getAdapterById } from '../bank-csv/adapters/registry';
import { adapterToRowFormat, mappingToRowFormat } from '../bank-csv/normalize';
import { encodeUnreadLines, summariseUnreadLines, type UnreadLinesSummary } from '../domain/unreadLines';
import { STATEMENT_OVERLAP_TITLE_CODE } from '../domain/categoryReview';
import { runBankCsvPipeline, decideCertification, type AcceptedTransactionPlan, type RejectedRowPlan } from '../bank-csv/orchestrator';
import { loadDedupIndexForAccount, loadPriorStatementDateRanges } from '../bank-csv/repository';
import { computeStatementOverlap, type BalanceReconciliationResult } from '../bank-csv/reconciliation';
import type { BankCsvMappingConfirmInput } from '../validation/bankCsv';
import type { FdhStatementUpload, FdhCsvColumnMapping } from '../domain/types';
import { createHash } from 'node:crypto';

export class BankCsvProcessingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state' | 'mapping_required' | 'account_unresolved' | 'internal_error' | 'in_progress' | 'invalid_mapping' | 'file_gone' | 'already_approved',
    message: string,
  ) {
    super(message);
    this.name = 'BankCsvProcessingError';
  }
}

async function getOwnedDocument(userId: string, documentId: string): Promise<FdhStatementUpload> {
  const { data } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!data) throw new BankCsvProcessingError('not_found', 'document not found');
  return data;
}

export function headerFingerprint(header: readonly string[], delimiter: string): string {
  return createHash('sha256').update(JSON.stringify([delimiter, header.map((h) => h.trim().toLowerCase())])).digest('hex');
}

/** The layout this person confirmed earlier for exactly this header (same columns, same order, same delimiter), if any. User-scoped. */
async function findConfirmedLayoutTemplate(userId: string, fingerprint: string): Promise<{ id: string } | null> {
  const supabase = await fdhDbClient();
  const { data } = await supabase
    .from('fdh_csv_mapping_templates')
    .select('id')
    .eq('user_id', userId)
    .eq('source_fingerprint', fingerprint)
    .eq('status', 'user_confirmed')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

/** Service-role write, explicitly re-scoped to (id, user_id) even though the
 * admin client bypasses RLS — see the module header's SERVICE-ROLE
 * CARVE-OUT note. Used for the R7 authoritative columns migration 0064's
 * triggers block the authenticated role from writing directly. */
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

/** Service-role insert into one of the engine-authoritative tables migration
 * 0064 blocks the authenticated role from inserting into directly (see the
 * module header's SERVICE-ROLE CARVE-OUT note). `user_id` is always set
 * explicitly from the already-authenticated caller, never taken from the
 * payload. */
async function adminInsert(table: string, row: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from(table).insert(row);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// DETECT (spec section 18-21)
// ---------------------------------------------------------------------------

export async function detectBankCsvDocument(userId: string, documentId: string): Promise<FdhStatementUpload> {
  const document = await getOwnedDocument(userId, documentId);
  if (!document.raw_document_storage_reference) {
    throw new BankCsvProcessingError('invalid_state', 'this document has no stored file to detect a format for');
  }
  if (!['queued', 'failed'].includes(document.processing_status)) {
    throw new BankCsvProcessingError('invalid_state', `cannot run detection while the document is ${document.processing_status}`);
  }
  // 2026-09-25: a byte-identical copy of an already-imported CSV is not read
  // at all; processing it answers with the original (see
  // processBankCsvDocument).
  if (await findImportedIdenticalCsv(userId, documentId)) return document;
  // AIE-1 final completion (2026-09-25): see `checkFdhDocumentMalwareAdmission`.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new BankCsvProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }

  const download = await downloadDocumentObject(document.raw_document_storage_reference);
  if (!download.ok) throw new BankCsvProcessingError('internal_error', 'could not read the stored file');

  const detection = detectBankCsvFormat(download.bytes);

  let parserId: string | null = null;
  let parserVersionId: string | null = null;
  if (detection.status === 'detected' && detection.adapter) {
    const { data: registryRow } = await parserRegistryRepository.getById(
      (await lookupParserIdByKey(detection.adapter.id)) ?? '',
    );
    if (registryRow) {
      parserId = registryRow.id;
      const versions = await parserVersionsRepository.listCertifiedForParser(registryRow.id);
      parserVersionId = versions.data?.[0]?.id ?? null;
      if (!parserVersionId) {
        // The two generic adapters are 'development', not 'certified' — look
        // up without the certified filter as a fallback so an experimental
        // adapter's version id is still recorded (never presented as
        // certified to the user — that distinction lives in
        // BankCsvAdapter.certificationState, surfaced separately).
        const supabase = await fdhDbClient();
        const { data: anyVersion } = await supabase
          .from('fdh_parser_versions')
          .select('id')
          .eq('parser_id', registryRow.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        parserVersionId = (anyVersion as { id: string } | null)?.id ?? null;
      }
    }
  }

  // 28-10-2026: a layout this person already confirmed for exactly this header is used again, without asking. Only for a file the
  // certified/experimental adapters did not settle on their own (an adapter match is never overridden by a template).
  let savedLayoutId: string | null = null;
  if ((detection.status === 'manual_mapping_required' || detection.status === 'ambiguous') && detection.header && detection.delimiter) {
    const template = await findConfirmedLayoutTemplate(userId, headerFingerprint(detection.header, detection.delimiter));
    savedLayoutId = template?.id ?? null;
  }

  const updated = await adminUpdateStatementUpload(userId, documentId, {
    ...(savedLayoutId ? { mapping_template_id: savedLayoutId } : {}),
    delimiter_detected: detection.delimiter,
    encoding_detected: detection.encoding,
    header_row_index: detection.headerRowIndex,
    detection_status: savedLayoutId ? 'detected' : detection.status,
    detection_confidence: detection.confidence,
    detection_evidence: detection.evidence,
    declared_row_count: detection.parsed?.declaredRowCount ?? null,
    adapter_key: detection.adapter?.id ?? null,
    adapter_version: detection.adapter?.version ?? null,
    parser_id: parserId,
    parser_version_id: parserVersionId,
  });

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'bank_csv_detection_completed',
    actorType: 'system',
    metadata: { status: detection.status, adapter_id: detection.adapter?.id ?? null, confidence: detection.confidence, saved_layout_used: savedLayoutId !== null },
  });

  return (updated ?? document) as FdhStatementUpload;
}

async function lookupParserIdByKey(parserKey: string): Promise<string | null> {
  const supabase = await fdhDbClient();
  const { data } = await supabase.from('fdh_parser_registry').select('id').eq('parser_key', parserKey).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// MAP (spec section 22-23)
// ---------------------------------------------------------------------------

function sameColumn(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The checks that make a mapping usable, against the header this file really has. Throws `invalid_mapping` with the reason in plain words. */
function assertMappingMatchesHeader(header: readonly string[], input: BankCsvMappingConfirmInput): void {
  const m = input.column_mapping;
  const assigned: Array<[string, string | null | undefined]> = [
    ['the date', m.transaction_date],
    ['the other date', m.posting_date],
    ['the description', m.description],
    ['the extra description', m.extra_description],
    ['the amount', m.amount],
    ['the debit amount', m.debit],
    ['the credit amount', m.credit],
    ['the debit/credit marker', m.dr_cr_indicator],
    ['the balance', m.balance],
    ['the reference', m.reference],
  ];
  const used = new Map<string, string>();
  for (const [what, column] of assigned) {
    if (!column) continue;
    const matches = header.filter((h) => sameColumn(h, column));
    if (matches.length === 0) throw new BankCsvProcessingError('invalid_mapping', `The column "${column}" chosen for ${what} is not in this file.`);
    if (matches.length > 1) {
      throw new BankCsvProcessingError('invalid_mapping', `Two columns in this file are both called "${column}", so they cannot be told apart. Rename one in your file and upload it again.`);
    }
    const key = column.trim().toLowerCase();
    const earlier = used.get(key);
    if (earlier && !input.allow_shared_columns) {
      throw new BankCsvProcessingError('invalid_mapping', `The column "${column}" is chosen for both ${earlier} and ${what}. Choose a different column for one of them.`);
    }
    if (!earlier) used.set(key, what);
  }
}

export async function confirmBankCsvMapping(
  userId: string,
  documentId: string,
  input: BankCsvMappingConfirmInput,
): Promise<FdhStatementUpload> {
  const document = await getOwnedDocument(userId, documentId);
  if (!document.detection_status || !['manual_mapping_required', 'ambiguous'].includes(document.detection_status)) {
    throw new BankCsvProcessingError('invalid_state', 'this document does not require manual mapping');
  }
  const header = (document.detection_evidence as { header?: string[] } | null)?.header ?? [];
  assertMappingMatchesHeader(header, input);
  // The layout is remembered under the delimiter the file was really read with, never one the browser claims.
  const delimiter = document.delimiter_detected ?? input.delimiter;
  const fingerprint = headerFingerprint(header, delimiter);

  // Every key present (null when not assigned): the stored template's shape check requires `amount` to exist even for a debit/credit file.
  const m = input.column_mapping;
  const columnMapping: FdhCsvColumnMapping = {
    transaction_date: m.transaction_date,
    posting_date: m.posting_date ?? null,
    value_date: m.value_date ?? null,
    description: m.description,
    extra_description: m.extra_description ?? null,
    amount: m.amount ?? null,
    debit: m.debit ?? null,
    credit: m.credit ?? null,
    dr_cr_indicator: m.dr_cr_indicator ?? null,
    balance: m.balance ?? null,
    reference: m.reference ?? null,
    currency: m.currency ?? null,
  };

  const { data: existingTemplates } = await csvMappingTemplatesRepository.listForUser(userId, 500);
  const sameLayout = (existingTemplates ?? []).filter((t) => t.source_fingerprint === fingerprint);
  const patch = { amount_convention: input.amount_convention, date_format: input.date_format, delimiter, column_mapping: columnMapping, country_code: document.country_code };
  const admin = createAdminClient();

  let mappingTemplateId: string | null = null;
  if (input.save_as_reusable_template) {
    // One remembered layout per header. Confirming again replaces what was remembered (this is how a wrong mapping is corrected for good).
    const confirmed = sameLayout.filter((t) => t.status === 'user_confirmed').sort((a, b) => b.version - a.version)[0];
    if (confirmed) {
      const { error } = await admin.from('fdh_csv_mapping_templates').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', confirmed.id).eq('user_id', userId);
      if (error) throw new BankCsvProcessingError('internal_error', error.message);
      mappingTemplateId = confirmed.id;
    } else {
      const version = Math.max(0, ...sameLayout.map((t) => t.version)) + 1;
      const { data: created, error } = await csvMappingTemplatesRepository.create(userId, {
        household_id: null,
        institution_id: document.institution_id,
        source_fingerprint: fingerprint,
        version,
        status: 'user_confirmed',
        ...patch,
      } as never);
      if (error || !created) throw new BankCsvProcessingError('internal_error', error?.message ?? 'could not save mapping template');
      mappingTemplateId = created.id;
    }
  } else {
    // Not remembered for next time, but THIS import still needs the mapping to read the file from: a draft that no later upload matches.
    const version = Math.max(0, ...sameLayout.map((t) => t.version)) + 1;
    const { data: created, error } = await csvMappingTemplatesRepository.create(userId, {
      household_id: null,
      institution_id: document.institution_id,
      source_fingerprint: fingerprint,
      version,
      status: 'user_draft',
      ...patch,
    } as never);
    if (error || !created) throw new BankCsvProcessingError('internal_error', error?.message ?? 'could not save mapping template');
    mappingTemplateId = created.id;
  }

  const updated = await adminUpdateStatementUpload(userId, documentId, {
    detection_status: 'detected',
    mapping_template_id: mappingTemplateId,
    adapter_key: null,
    adapter_version: null,
  });

  await recordDocumentAuditEvent({
    userId,
    documentId,
    eventType: 'bank_csv_mapping_confirmed',
    actorType: 'user',
    actorId: userId,
    metadata: { mapping_template_id: mappingTemplateId, amount_convention: input.amount_convention, remembered: input.save_as_reusable_template },
  });

  return (updated ?? document) as FdhStatementUpload;
}

// ---------------------------------------------------------------------------
// The columns of an unrecognised file, for the mapping step, and the way back to it
// ---------------------------------------------------------------------------

/** How many data rows the mapping step is shown: enough to prove a date style and to catch a wrong column, small enough to send. */
export const MAPPING_SAMPLE_ROWS = 100;
const MAPPING_SAMPLE_CELL_CHARS = 200;

export interface BankCsvMappingSample {
  header: string[];
  rows: string[][];
  totalRows: number;
  delimiter: string;
}

/**
 * The file's own columns and its first rows, read again from the stored copy. Only for the owner, only while the file needs a mapping,
 * and only once the same malware admission every import passes has cleared it.
 */
export async function loadBankCsvMappingSample(userId: string, documentId: string): Promise<BankCsvMappingSample> {
  const document = await getOwnedDocument(userId, documentId);
  const needsMapping = document.detection_status === 'manual_mapping_required' || document.detection_status === 'ambiguous';
  if (!needsMapping) throw new BankCsvProcessingError('invalid_state', 'this document does not currently need a column mapping');
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new BankCsvProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }
  if (!document.raw_document_storage_reference) throw new BankCsvProcessingError('file_gone', 'the stored copy of this file is no longer available');
  const download = await downloadDocumentObject(document.raw_document_storage_reference);
  if (!download.ok) throw new BankCsvProcessingError('file_gone', 'the stored copy of this file is no longer available');
  const detection = detectBankCsvFormat(download.bytes);
  if (!detection.parsed || !detection.delimiter) throw new BankCsvProcessingError('invalid_state', 'this file could not be read as a table');
  const clip = (cell: string) => (cell.length > MAPPING_SAMPLE_CELL_CHARS ? `${cell.slice(0, MAPPING_SAMPLE_CELL_CHARS)}...` : cell);
  return {
    header: detection.parsed.header,
    rows: detection.parsed.rows.slice(0, MAPPING_SAMPLE_ROWS).map((r) => r.map(clip)),
    totalRows: detection.parsed.rows.length,
    delimiter: detection.delimiter,
  };
}

// ---------------------------------------------------------------------------
// PROCESS (spec section 32-46, 55-56)
// ---------------------------------------------------------------------------

const INSERT_CHUNK_SIZE = 500;

export interface ProcessBankCsvResult {
  /** WP-08 (EXP-G14): the lines that could not be read, with reasons. */
  unreadLines?: UnreadLinesSummary;
  document: FdhStatementUpload;
  transactionsCreated: number;
  duplicatesSkipped: number;
  duplicateCandidates: number;
  rejectedRows: number;
  certificationStatus: string | null;
  reconciliationStatus: string | null;
  /** 2026-09-25: set when this upload is a byte-identical copy of an earlier
   * upload that was already imported. Nothing was read for the copy; the
   * summary is the original's, with nothing created by this upload. */
  duplicateOfDocumentId?: string;
}

/** The earlier, already-imported upload this CSV is a byte-identical copy
 * of, if any (identicalUpload.ts). CSV imports have no AI draft to carry on
 * with, so only a settled import counts. */
export async function findImportedIdenticalCsv(userId: string, documentId: string): Promise<string | null> {
  const match = await findEarlierIdenticalUpload(userId, documentId, { ...IDENTICAL_UPLOAD_SPECS.bank, includePendingDrafts: false });
  return match?.kind === 'evidence' ? match.documentId : null;
}

/** Removes every row a PRIOR (failed) processing attempt for this document
 * produced — the compensating cleanup that makes a retry safe (spec 56). */
async function cleanupPriorAttempt(userId: string, documentId: string): Promise<void> {
  const supabase = await fdhDbClient();
  await supabase.from('fdh_transactions').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_reconciliation_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_data_quality_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
}

export async function processBankCsvDocument(userId: string, documentId: string): Promise<ProcessBankCsvResult> {
  let document = await getOwnedDocument(userId, documentId);

  // IDEMPOTENCY (spec 37, 56): already certified/settled — return as-is.
  if (document.certification_status && ['certified', 'review_required', 'rejected'].includes(document.certification_status) && document.processing_completed_at) {
    return summariseExisting(document);
  }

  // 2026-09-25: a byte-identical re-upload of a CSV already imported is never
  // parsed again -- the original's summary, nothing created by this upload.
  const originalId = await findImportedIdenticalCsv(userId, documentId);
  if (originalId) {
    const original = await getOwnedDocument(userId, originalId);
    return { ...summariseExisting(original), transactionsCreated: 0, duplicatesSkipped: original.certified_row_count ?? 0, rejectedRows: 0, duplicateOfDocumentId: originalId };
  }

  // Document2 (4) F15: a run the platform killed leaves the document in `processing` (see interruptedRun.ts). A live run is not
  // started twice; a dead one is cleaned up and the statement is read again from the top.
  const runState = processingRunState(document);
  if (runState === 'live') throw new BankCsvProcessingError('in_progress', STATEMENT_STILL_BEING_READ_MESSAGE);
  if (runState === 'dead') {
    await cleanupPriorAttempt(userId, documentId);
    assertDocumentTransition('processing', 'failed');
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'failed', error_code: null });
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_processing_failed', actorType: 'system', metadata: { reason: 'run_interrupted' } });
    document = { ...document, processing_status: 'failed' };
  }

  if (!document.detection_status || document.detection_status === 'invalid' || document.detection_status === 'unsupported') {
    throw new BankCsvProcessingError('invalid_state', 'this document has not been successfully detected');
  }
  // AIE-1 final completion (2026-09-25): see `checkFdhDocumentMalwareAdmission`.
  if (!checkFdhDocumentMalwareAdmission(document).admitted) {
    throw new BankCsvProcessingError('invalid_state', FDH_MALWARE_ADMISSION_REFUSED_MESSAGE);
  }
  if (document.detection_status === 'ambiguous' || document.detection_status === 'manual_mapping_required') {
    if (!document.mapping_template_id) {
      throw new BankCsvProcessingError('mapping_required', 'a column mapping must be confirmed before processing');
    }
  }
  if (!document.financial_account_id) {
    // ACCOUNT_REVIEW_REQUIRED fail-safe (spec 31) — halt cleanly, never
    // guess. Route through 'processing' (queued -> processing ->
    // review_required) — 'review_required' is not directly reachable from
    // 'queued' in the FDH-1 lifecycle machine.
    const startFrom = document.processing_status === 'failed' ? 'queued' : document.processing_status;
    if (startFrom !== document.processing_status) {
      await adminUpdateStatementUpload(userId, documentId, { processing_status: 'queued' });
    }
    if (startFrom === 'queued') {
      assertDocumentTransition('queued', 'processing');
      await adminUpdateStatementUpload(userId, documentId, { processing_status: 'processing' });
    }
    assertDocumentTransition('processing', 'review_required');
    await adminUpdateStatementUpload(userId, documentId, {
      processing_status: 'review_required',
      certification_status: 'review_required',
      review_status: 'pending',
    });
    throw new BankCsvProcessingError('account_unresolved', 'account identity is ambiguous — resolve it before processing');
  }

  // Retry cleanup: if a prior attempt left partial rows (processing_status
  // is 'failed' with some already-committed rows), remove them before this
  // fresh attempt.
  if (document.processing_status === 'failed') {
    await cleanupPriorAttempt(userId, documentId);
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'queued' });
  }

  assertDocumentTransition('queued', 'processing');
  await adminUpdateStatementUpload(userId, documentId, {
    processing_status: 'processing',
    processing_started_at: new Date().toISOString(),
  });
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_processing_started', actorType: 'system' });

  try {
    if (!document.raw_document_storage_reference) throw new Error('missing storage reference');
    const download = await downloadDocumentObject(document.raw_document_storage_reference);
    if (!download.ok) throw new Error(download.message);

    let rowFormat;
    if (document.mapping_template_id) {
      const { data: template } = await csvMappingTemplatesRepository.getForUser(userId, document.mapping_template_id);
      if (!template) throw new Error('mapping template not found');
      rowFormat = mappingToRowFormat(template.column_mapping, template.amount_convention, template.date_format as never);
    } else if (document.adapter_key) {
      const adapter = getAdapterById(document.adapter_key);
      if (!adapter) throw new Error('adapter not found');
      rowFormat = adapterToRowFormat(adapter);
    } else {
      throw new Error('no row format resolved');
    }

    const dedupIndex = await loadDedupIndexForAccount(userId, document.financial_account_id);
    const priorRanges = await loadPriorStatementDateRanges(userId, document.financial_account_id, documentId);

    const pipeline = runBankCsvPipeline({
      bytes: download.bytes,
      statementUploadId: documentId,
      financialAccountId: document.financial_account_id,
      currencyCode: document.currency_code ?? 'AUD',
      rowFormatOverride: rowFormat,
      dedupIndex,
      declaredPeriodStart: document.statement_period_start,
      declaredPeriodEnd: document.statement_period_end,
    });

    const rowsToInsert = pipeline.accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
    const duplicateConfirmedCount = pipeline.accepted.length - rowsToInsert.length;

    let insertedIds: { id: string; source_row: number | null }[] = [];
    for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK_SIZE) {
      const chunk = rowsToInsert.slice(i, i + INSERT_CHUNK_SIZE);
      const admin = createAdminClient();
      const { data, error } = await admin
        .from('fdh_transactions')
        .insert(chunk.map((t) => csvTransactionRow(t, { userId, documentId, document, economicFingerprintVersion: pipeline.economicFingerprintVersion })))
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
          eventType: 'bank_csv_processing_failed',
          actorType: 'system',
          metadata: { reason: 'insert_failed' },
        });
        throw new BankCsvProcessingError('internal_error', 'could not persist normalised transactions');
      }
      insertedIds = insertedIds.concat((data ?? []) as { id: string; source_row: number | null }[]);
    }

    return await finalizeBankCsvImport({
      userId,
      documentId,
      document,
      pipeline: {
        detectionStatus: pipeline.detection.status,
        declaredRowCount: pipeline.declaredRowCount,
        parsedRowCount: pipeline.parsedRowCount,
        rejected: pipeline.rejected,
        reconciliation: pipeline.reconciliation,
        parserVersion: pipeline.parserVersion,
      },
      rowsInserted: rowsToInsert.length,
      duplicateConfirmedCount,
      duplicateCandidates: duplicateCandidateRefs(rowsToInsert),
      insertedIds,
      // Overlap evidence (spec 44) -- informational only; does not by itself change certification. WP-08 (EXP-G17): it becomes an
      // info note on the statement, no longer computed and thrown away.
      overlap: computeStatementOverlap(priorRanges, pipeline.dateCoverage),
    });
  } catch (e) {
    if (e instanceof BankCsvProcessingError) throw e;
    await adminUpdateStatementUpload(userId, documentId, {
      processing_status: 'failed',
      error_code: 'internal_error',
    });
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'bank_csv_processing_failed',
      actorType: 'system',
      metadata: { reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' },
    });
    throw new BankCsvProcessingError('internal_error', e instanceof Error ? e.message : 'processing failed');
  }
}

// ---------------------------------------------------------------------------
// WP-G (F15): the pieces of the import the background job reuses. The synchronous path above and the job's slices call the SAME
// row mapper and the SAME finalize, so a job-imported statement is indistinguishable from a synchronously imported one.
// ---------------------------------------------------------------------------

/** The `fdh_transactions` row for one accepted CSV line. */
export function csvTransactionRow(
  t: AcceptedTransactionPlan,
  ctx: { userId: string; documentId: string; document: Pick<FdhStatementUpload, 'household_id' | 'financial_account_id' | 'currency_code'>; economicFingerprintVersion: string },
): Record<string, unknown> {
  return {
    user_id: ctx.userId,
    household_id: ctx.document.household_id,
    financial_account_id: ctx.document.financial_account_id,
    statement_upload_id: ctx.documentId,
    transaction_date: t.transactionDate,
    posting_date: t.postedDate,
    value_date: t.valueDate,
    description_raw: t.descriptionRaw,
    description_clean: t.descriptionClean,
    amount_original: t.amountOriginal,
    currency_original: ctx.document.currency_code ?? 'AUD',
    credit_debit: t.creditDebit,
    economic_transaction_type: 'unknown',
    source_reference: t.referenceRaw,
    source_row: t.sourceRowNumber,
    extraction_confidence: 1,
    classification_method: 'unclassified',
    source_row_hash: t.sourceRowHash,
    economic_fingerprint: t.economicFingerprint,
    economic_fingerprint_version: ctx.economicFingerprintVersion,
    dedup_status: t.dedupStatus,
    balance_after: t.balanceAfter,
    transaction_type_hint: t.transactionTypeHint,
  };
}

/** One within-file or cross-import duplicate CANDIDATE among the lines being written. */
export interface DuplicateCandidateRef {
  sourceRowNumber: number;
  matchedTransactionId: string;
  matchMethod: 'exact_hash' | 'fuzzy_amount_date' | 'statement_overlap' | 'user_reported' | null;
  dedupConfidence: number;
}

export function duplicateCandidateRefs(
  rows: ReadonlyArray<{ sourceRowNumber: number; dedupStatus: string; matchedTransactionId: string | null; matchMethod: DuplicateCandidateRef['matchMethod']; dedupConfidence: number }>,
): DuplicateCandidateRef[] {
  const out: DuplicateCandidateRef[] = [];
  for (const t of rows) {
    if (t.dedupStatus !== 'duplicate_candidate' || !t.matchedTransactionId) continue;
    out.push({ sourceRowNumber: t.sourceRowNumber, matchedTransactionId: t.matchedTransactionId, matchMethod: t.matchMethod, dedupConfidence: t.dedupConfidence });
  }
  return out;
}

/**
 * Writes the `fdh_duplicate_candidates` rows for a statement whose lines are already stored and returns how many pairs resolved.
 *
 * LIVE-DEV-DISCOVERED FIX (R7-FINAL live certification): a WITHIN-FILE duplicate candidate (the matched row is earlier in this SAME
 * upload) carries a `pending-row-N` placeholder; by the time this runs every accepted row has been stored, so the placeholder resolves
 * to the real id of row N. Cross-import candidates were never placeholders. Shared with the PDF path.
 *
 * WP-G: written in batches, and a pair that already exists is not written again, so a finalize that is run again (a job slice that
 * was killed after writing some) creates each pair once.
 */
export async function writeDuplicateCandidates(
  userId: string,
  candidates: readonly DuplicateCandidateRef[],
  insertedIds: ReadonlyArray<{ id: string; source_row: number | null }>,
): Promise<number> {
  const rowNumberToId = new Map(insertedIds.map((r) => [r.source_row, r.id]));
  const pairs: Array<{ a: string; b: string; ref: DuplicateCandidateRef }> = [];
  for (const t of candidates) {
    const newId = rowNumberToId.get(t.sourceRowNumber);
    let matchedId: string | null = t.matchedTransactionId;
    if (matchedId.startsWith('pending-row-')) {
      const matchedRowNumber = Number(matchedId.slice('pending-row-'.length));
      matchedId = rowNumberToId.get(matchedRowNumber) ?? null;
    }
    if (!newId || !matchedId || matchedId === newId) continue;
    pairs.push({ a: matchedId, b: newId, ref: t });
  }
  if (pairs.length === 0) return 0;
  const admin = createAdminClient();
  const existing = new Set<string>();
  const newIds = [...new Set(pairs.map((p) => p.b))];
  for (let i = 0; i < newIds.length; i += 200) {
    const { data, error } = await admin
      .from('fdh_duplicate_candidates')
      .select('transaction_id_a, transaction_id_b')
      .eq('user_id', userId)
      .in('transaction_id_b', newIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ transaction_id_a: string; transaction_id_b: string }>) existing.add(`${r.transaction_id_a}|${r.transaction_id_b}`);
  }
  const fresh = pairs.filter((p) => !existing.has(`${p.a}|${p.b}`));
  for (let i = 0; i < fresh.length; i += 200) {
    const { error } = await admin.from('fdh_duplicate_candidates').insert(
      fresh.slice(i, i + 200).map((p) => ({
        user_id: userId,
        transaction_id_a: p.a,
        transaction_id_b: p.b,
        match_method: p.ref.matchMethod ?? 'fuzzy_amount_date',
        confidence: p.ref.dedupConfidence,
        status: 'pending',
      })),
    );
    if (error) throw new Error(error.message);
  }
  return pairs.length;
}

/** An adapter that names a bank but is not certified yet (built from too little evidence to certify an import on its own). */
function isExperimentalInstitutionAdapter(adapterKey: string | null | undefined): boolean {
  const adapter = adapterKey ? getAdapterById(adapterKey) : null;
  return Boolean(adapter && adapter.certificationState === 'experimental' && adapter.institutionCode);
}

export interface BankCsvFinalizeInput {
  userId: string;
  documentId: string;
  document: FdhStatementUpload;
  pipeline: {
    detectionStatus: string;
    declaredRowCount: number;
    parsedRowCount: number;
    rejected: ReadonlyArray<RejectedRowPlan>;
    reconciliation: BalanceReconciliationResult | null;
    parserVersion: string;
  };
  rowsInserted: number;
  duplicateConfirmedCount: number;
  duplicateCandidates: readonly DuplicateCandidateRef[];
  insertedIds: ReadonlyArray<{ id: string; source_row: number | null }>;
  overlap: ReturnType<typeof computeStatementOverlap>;
}

/**
 * Everything after the lines are stored: duplicate candidates, reconciliation, data-quality checks, provenance, the certification
 * decision, review items, the lifecycle transitions and the ingestion-job row. Used by the synchronous path and by the background
 * job's `finalize` slice.
 */
export async function finalizeBankCsvImport(input: BankCsvFinalizeInput): Promise<ProcessBankCsvResult> {
  const { userId, documentId, document, pipeline, overlap } = input;
  const duplicateConfirmedCount = input.duplicateConfirmedCount;

  // Duplicate-candidate provenance (Layer 4, spec 34/36).
  const duplicateCandidateCount = await writeDuplicateCandidates(userId, input.duplicateCandidates, input.insertedIds);
  if (duplicateConfirmedCount > 0 || duplicateCandidateCount > 0) {
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'transaction_duplicate_detected',
      actorType: 'system',
      metadata: { confirmed: duplicateConfirmedCount, candidates: duplicateCandidateCount },
    });
  }

  const unreadLines = summariseUnreadLines(pipeline.rejected);

  // Reconciliation persistence (spec 42-43).
  if (pipeline.reconciliation) {
    await adminInsert('fdh_reconciliation_results', {
      user_id: userId,
      statement_upload_id: documentId,
      opening_balance: pipeline.reconciliation.openingBalance,
      extracted_credits: pipeline.reconciliation.extractedCredits,
      extracted_debits: pipeline.reconciliation.extractedDebits,
      expected_closing_balance: pipeline.reconciliation.expectedClosingBalance,
      reported_closing_balance: pipeline.reconciliation.reportedClosingBalance,
      variance: pipeline.reconciliation.variance,
      variance_tolerance: pipeline.reconciliation.varianceTolerance,
      currency_code: document.currency_code,
      status: pipeline.reconciliation.status,
      reconciliation_method: pipeline.reconciliation.method,
    });
    await recordDocumentAuditEvent({
      userId,
      documentId,
      eventType: 'import_reconciled',
      actorType: 'system',
      metadata: { status: pipeline.reconciliation.status },
    });
  }

  // Data-quality checks (spec 46, FDH-1 closed vocabulary -- see migration 0064 header note for why no widening was needed here).
  const dqChecks: { check_code: string; status: string; details_sanitised?: string }[] = [
    {
      check_code: 'transaction_count_valid',
      status: pipeline.declaredRowCount === pipeline.parsedRowCount ? 'pass' : 'fail',
      details_sanitised: `declared=${pipeline.declaredRowCount} parsed=${pipeline.parsedRowCount} ${encodeUnreadLines(unreadLines)}`,
    },
    {
      check_code: 'account_identified',
      status: document.financial_account_id ? 'pass' : 'fail',
    },
    {
      check_code: 'balance_reconciled',
      status:
        pipeline.reconciliation?.status === 'reconciled'
          ? 'pass'
          : pipeline.reconciliation?.status === 'not_available'
            ? 'not_applicable'
            : pipeline.reconciliation?.status === 'failed'
              ? 'fail'
              : 'warning',
    },
    {
      check_code: 'statement_period_found',
      status: document.statement_period_start && document.statement_period_end ? 'pass' : 'warning',
    },
    {
      check_code: 'duplicate_file',
      status: document.duplicate_of_document_id ? 'warning' : 'pass',
    },
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

  // Provenance (spec 24, one statement-level record; see R7_CANONICAL_TRANSACTION_CONTRACT.md for the chosen granularity).
  await adminInsert('fdh_data_provenance', {
    user_id: userId,
    household_id: document.household_id,
    entity_type: 'fdh_statement_upload',
    entity_id: documentId,
    source_type: 'csv',
    source_statement_id: documentId,
    parser_id: document.parser_id,
    parser_version_id: document.parser_version_id,
    mapping_rule_version: pipeline.parserVersion,
    evidence_completeness: pipeline.rejected.length === 0 ? 1 : input.rowsInserted / Math.max(pipeline.declaredRowCount, 1),
    user_verified: false,
    manual_override: false,
  });

  const certification = decideCertification({
    detectionStatus: pipeline.detectionStatus as never,
    declaredRowCount: pipeline.declaredRowCount,
    parsedRowCount: pipeline.parsedRowCount,
    rejectedRowCount: pipeline.rejected.length,
    duplicateCandidateCount: duplicateCandidateCount,
    accountAmbiguous: false,
    reconciliationStatus: pipeline.reconciliation?.status ?? null,
    experimentalInstitutionAdapter: isExperimentalInstitutionAdapter(document.adapter_key),
  });

  if (certification.certificationStatus === 'review_required' && duplicateCandidateCount > 0) {
    await reviewItemsRepository.create(userId, {
      household_id: document.household_id,
      statement_upload_id: documentId,
      transaction_id: null,
      review_type: 'possible_duplicate',
      severity: 'warning',
      status: 'open',
      title_code: 'bank_csv.duplicate_candidates_pending_review',
      context_json: { counts: { duplicate_candidates: duplicateCandidateCount } },
    } as never);
  }
  if (certification.certificationStatus === 'review_required' && pipeline.reconciliation?.status === 'failed') {
    await reviewItemsRepository.create(userId, {
      household_id: document.household_id,
      statement_upload_id: documentId,
      transaction_id: null,
      review_type: 'reconciliation_failure',
      severity: 'blocking',
      status: 'open',
      title_code: 'bank_csv.reconciliation_failed',
      context_json: { counts: { variance_minor_units: 1 } },
    } as never);
  }
  if (overlap) {
    await reviewItemsRepository.create(userId, {
      household_id: document.household_id,
      statement_upload_id: documentId,
      transaction_id: null,
      review_type: 'other',
      severity: 'info',
      status: 'open',
      title_code: STATEMENT_OVERLAP_TITLE_CODE,
      context_json: { overlapping_statement_count: overlap.overlappingStatementCount, overlap_from: overlap.overlapFrom, overlap_to: overlap.overlapTo },
    } as never);
  }

  let finalProcessingStatus: FdhStatementUpload['processing_status'] = 'review_required';
  // WP-G: a finalize that was killed part-way leaves the statement in `extracted` or `ready_for_approval` (the database refuses to
  // move it backwards); the re-run carries on from where it is. A first run is always in `processing`, exactly as before.
  if (document.processing_status === 'processing') {
    assertDocumentTransition('processing', 'extracted');
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'extracted' });
  }

  if (certification.certificationStatus === 'certified') {
    if (document.processing_status !== 'ready_for_approval') {
      assertDocumentTransition('extracted', 'ready_for_approval');
      await adminUpdateStatementUpload(userId, documentId, { processing_status: 'ready_for_approval' });
    }
    assertDocumentTransition('ready_for_approval', 'approved');
    finalProcessingStatus = 'approved';
  } else if (certification.certificationStatus === 'partial') {
    // A half-parsed file is never silently certified (spec 46, 91) -- it lands in review_required with the exact row-count evidence
    // attached, never in 'extracted'/'approved'.
    assertDocumentTransition('extracted', 'review_required');
    finalProcessingStatus = 'review_required';
  } else if (certification.certificationStatus === 'review_required') {
    assertDocumentTransition('extracted', 'review_required');
    finalProcessingStatus = 'review_required';
  } else {
    assertDocumentTransition('extracted', 'rejected');
    finalProcessingStatus = 'rejected';
  }

  const finalDoc = await adminUpdateStatementUpload(userId, documentId, {
    processing_status: finalProcessingStatus,
    certification_status: certification.certificationStatus,
    parsed_row_count: pipeline.parsedRowCount,
    certified_row_count: input.rowsInserted,
    duplicate_row_count: duplicateConfirmedCount,
    reconciliation_status: pipeline.reconciliation?.status ?? 'not_available',
    overall_quality_status: certification.certificationStatus === 'certified' ? 'pass' : certification.certificationStatus === 'partial' || certification.certificationStatus === 'rejected' ? 'fail' : 'warning',
    processing_completed_at: new Date().toISOString(),
    review_status: finalProcessingStatus === 'review_required' ? 'pending' : 'not_required',
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
    eventType: 'bank_csv_processing_completed',
    actorType: 'system',
    metadata: {
      certification_status: certification.certificationStatus,
      transactions_created: input.rowsInserted,
      duplicates_skipped: duplicateConfirmedCount,
    },
  });

  return {
    document: (finalDoc ?? document) as FdhStatementUpload,
    transactionsCreated: input.rowsInserted,
    duplicatesSkipped: duplicateConfirmedCount,
    duplicateCandidates: duplicateCandidateCount,
    rejectedRows: pipeline.rejected.length,
    unreadLines,
    certificationStatus: certification.certificationStatus,
    reconciliationStatus: pipeline.reconciliation?.status ?? null,
  };
}

export function summariseExisting(document: FdhStatementUpload): ProcessBankCsvResult {
  return {
    document,
    transactionsCreated: document.certified_row_count ?? 0,
    duplicatesSkipped: document.duplicate_row_count ?? 0,
    duplicateCandidates: 0,
    rejectedRows: (document.parsed_row_count ?? 0) - (document.certified_row_count ?? 0) - (document.duplicate_row_count ?? 0),
    certificationStatus: document.certification_status,
    reconciliationStatus: document.reconciliation_status,
  };
}
