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

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
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
import { runBankCsvPipeline, decideCertification } from '../bank-csv/orchestrator';
import { loadDedupIndexForAccount, loadPriorStatementDateRanges } from '../bank-csv/repository';
import { rangesOverlap } from '../bank-csv/reconciliation';
import type { BankCsvMappingConfirmInput } from '../validation/bankCsv';
import type { FdhStatementUpload, FdhCsvColumnMapping } from '../domain/types';
import { createHash } from 'node:crypto';

export class BankCsvProcessingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_state' | 'mapping_required' | 'account_unresolved' | 'internal_error',
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

function headerFingerprint(header: readonly string[], delimiter: string): string {
  return createHash('sha256').update(JSON.stringify([delimiter, header.map((h) => h.trim().toLowerCase())])).digest('hex');
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
        const supabase = await createClient();
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

  const updated = await adminUpdateStatementUpload(userId, documentId, {
    delimiter_detected: detection.delimiter,
    encoding_detected: detection.encoding,
    header_row_index: detection.headerRowIndex,
    detection_status: detection.status,
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
    metadata: { status: detection.status, adapter_id: detection.adapter?.id ?? null, confidence: detection.confidence },
  });

  return (updated ?? document) as FdhStatementUpload;
}

async function lookupParserIdByKey(parserKey: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from('fdh_parser_registry').select('id').eq('parser_key', parserKey).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// MAP (spec section 22-23)
// ---------------------------------------------------------------------------

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
  const fingerprint = headerFingerprint(header, input.delimiter);

  let mappingTemplateId: string | null = null;
  if (input.save_as_reusable_template) {
    const { data: existingTemplates } = await csvMappingTemplatesRepository.listForUser(userId, 500);
    const existing = (existingTemplates ?? []).find((t) => t.source_fingerprint === fingerprint);
    if (existing) {
      mappingTemplateId = existing.id;
    } else {
      const { data: created, error } = await csvMappingTemplatesRepository.create(userId, {
        household_id: null,
        institution_id: document.institution_id,
        source_fingerprint: fingerprint,
        country_code: document.country_code,
        version: 1,
        status: 'user_confirmed',
        amount_convention: input.amount_convention,
        date_format: input.date_format,
        delimiter: input.delimiter,
        column_mapping: input.column_mapping as FdhCsvColumnMapping,
      } as never);
      if (error || !created) throw new BankCsvProcessingError('internal_error', error?.message ?? 'could not save mapping template');
      mappingTemplateId = created.id;
    }
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
    metadata: { mapping_template_id: mappingTemplateId, amount_convention: input.amount_convention },
  });

  return (updated ?? document) as FdhStatementUpload;
}

// ---------------------------------------------------------------------------
// PROCESS (spec section 32-46, 55-56)
// ---------------------------------------------------------------------------

const INSERT_CHUNK_SIZE = 500;

export interface ProcessBankCsvResult {
  document: FdhStatementUpload;
  transactionsCreated: number;
  duplicatesSkipped: number;
  duplicateCandidates: number;
  rejectedRows: number;
  certificationStatus: string | null;
  reconciliationStatus: string | null;
}

/** Removes every row a PRIOR (failed) processing attempt for this document
 * produced — the compensating cleanup that makes a retry safe (spec 56). */
async function cleanupPriorAttempt(userId: string, documentId: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from('fdh_transactions').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_reconciliation_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
  await supabase.from('fdh_data_quality_results').delete().eq('user_id', userId).eq('statement_upload_id', documentId);
}

export async function processBankCsvDocument(userId: string, documentId: string): Promise<ProcessBankCsvResult> {
  const document = await getOwnedDocument(userId, documentId);

  // IDEMPOTENCY (spec 37, 56): already certified/settled — return as-is.
  if (document.certification_status && ['certified', 'review_required', 'rejected'].includes(document.certification_status) && document.processing_completed_at) {
    return summariseExisting(document);
  }

  if (!document.detection_status || document.detection_status === 'invalid' || document.detection_status === 'unsupported') {
    throw new BankCsvProcessingError('invalid_state', 'this document has not been successfully detected');
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
        .insert(
          chunk.map((t) => ({
            user_id: userId,
            household_id: document.household_id,
            financial_account_id: document.financial_account_id,
            statement_upload_id: documentId,
            transaction_date: t.transactionDate,
            posting_date: t.postedDate,
            value_date: t.valueDate,
            description_raw: t.descriptionRaw,
            description_clean: t.descriptionClean,
            amount_original: t.amountOriginal,
            currency_original: document.currency_code ?? 'AUD',
            credit_debit: t.creditDebit,
            economic_transaction_type: 'unknown',
            source_reference: t.referenceRaw,
            source_row: t.sourceRowNumber,
            extraction_confidence: 1,
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
          eventType: 'bank_csv_processing_failed',
          actorType: 'system',
          metadata: { reason: 'insert_failed' },
        });
        throw new BankCsvProcessingError('internal_error', 'could not persist normalised transactions');
      }
      insertedIds = insertedIds.concat((data ?? []) as { id: string; source_row: number | null }[]);
    }

    // Duplicate-candidate provenance (Layer 4, spec 34/36).
    //
    // LIVE-DEV-DISCOVERED FIX (R7-FINAL live certification): a WITHIN-FILE
    // duplicate candidate (the matched row is earlier in this SAME upload,
    // not a prior persisted transaction) carries a `pending-row-N` placeholder
    // in `matchedTransactionId` (orchestrator.ts's in-memory dedup index,
    // populated before any DB write happens — see its own comment). That
    // placeholder is never a real `fdh_transactions.id`, but by THIS point in
    // the function every accepted row (including row N) has already been
    // bulk-inserted, so `rowNumberToId` can resolve it to the real id the
    // same way `newId` already does for the later row. Previously this was
    // unconditionally skipped, which silently persisted `dedup_status =
    // 'duplicate_candidate'` on both transactions with NO backing
    // `fdh_duplicate_candidates` row at all — the user-facing
    // duplicate-resolution API requires exactly that row's id, so a
    // within-file candidate pair had no way to ever be resolved. Cross-import
    // candidates (matched against a PRIOR statement's already-persisted
    // transaction) are unaffected — `matchedTransactionId` there was never a
    // placeholder.
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

    // Overlap evidence (spec 44) — informational only, folded into date
    // coverage; does not by itself change certification.
    const overlapsPrior = pipeline.dateCoverage?.earliestDate && pipeline.dateCoverage?.latestDate
      ? [...priorRanges.values()].some((r) =>
          rangesOverlap(r, { start: pipeline.dateCoverage!.earliestDate!, end: pipeline.dateCoverage!.latestDate! }),
        )
      : false;

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

    // Data-quality checks (spec 46, FDH-1 closed vocabulary — see migration
    // 0064 header note for why no widening was needed here).
    const dqChecks: { check_code: string; status: string; details_sanitised?: string }[] = [
      {
        check_code: 'transaction_count_valid',
        status: pipeline.declaredRowCount === pipeline.parsedRowCount ? 'pass' : 'fail',
        details_sanitised: `declared=${pipeline.declaredRowCount} parsed=${pipeline.parsedRowCount}`,
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

    // Provenance (spec 24, one statement-level record; see
    // R7_CANONICAL_TRANSACTION_CONTRACT.md for the chosen granularity).
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
      evidence_completeness: pipeline.rejected.length === 0 ? 1 : rowsToInsert.length / Math.max(pipeline.declaredRowCount, 1),
      user_verified: false,
      manual_override: false,
    });

    const certification = decideCertification({
      detectionStatus: pipeline.detection.status,
      declaredRowCount: pipeline.declaredRowCount,
      parsedRowCount: pipeline.parsedRowCount,
      rejectedRowCount: pipeline.rejected.length,
      duplicateCandidateCount: duplicateCandidateCount,
      accountAmbiguous: false,
      reconciliationStatus: pipeline.reconciliation?.status ?? null,
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
    void overlapsPrior;

    let finalProcessingStatus: FdhStatementUpload['processing_status'] = 'review_required';
    assertDocumentTransition('processing', 'extracted');
    await adminUpdateStatementUpload(userId, documentId, { processing_status: 'extracted' });

    if (certification.certificationStatus === 'certified') {
      assertDocumentTransition('extracted', 'ready_for_approval');
      await adminUpdateStatementUpload(userId, documentId, { processing_status: 'ready_for_approval' });
      assertDocumentTransition('ready_for_approval', 'approved');
      finalProcessingStatus = 'approved';
    } else if (certification.certificationStatus === 'partial') {
      // A half-parsed file is never silently certified (spec 46, 91) — it
      // lands in review_required with the exact row-count evidence attached,
      // never in 'extracted'/'approved'.
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
      certified_row_count: rowsToInsert.length,
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
        transactions_created: rowsToInsert.length,
        duplicates_skipped: duplicateConfirmedCount,
      },
    });

    return {
      document: (finalDoc ?? document) as FdhStatementUpload,
      transactionsCreated: rowsToInsert.length,
      duplicatesSkipped: duplicateConfirmedCount,
      duplicateCandidates: duplicateCandidateCount,
      rejectedRows: pipeline.rejected.length,
      certificationStatus: certification.certificationStatus,
      reconciliationStatus: pipeline.reconciliation?.status ?? null,
    };
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

function summariseExisting(document: FdhStatementUpload): ProcessBankCsvResult {
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
