/**
 * AIE-1.3 — FDH bank-statement adapter: the gated canonical-write step
 * (execution-sequence step 10).
 *
 * "Implement the actual atomic, idempotent FDH canonical import (through
 * FDH's own existing atomic-import service, not a new direct-to-table
 * path)... GATED so it never fires until balance reconciliation passes,
 * behind a feature flag defaulted OFF."
 *
 * THIS FILE WRITES NO CANONICAL ROW ITSELF. It calls FDH-5's own,
 * already-certified, unmodified services
 * (`uploadBankPdf` -> `processBankPdfDocument`,
 * `lib/financial-data-hub/services/bankPdf{Upload,Processing}Service.ts`) —
 * the exact same functions the existing `/api/financial-data-hub/bank-pdf`
 * routes already call. AIE's OWN independent reconciliation check
 * (`reconciliation.ts`) has ALREADY run against the SAME bytes by the time
 * this function is ever invoked — this is a second, independent gate on top
 * of FDH-5's own internal reconciliation (which `processBankPdfDocument`
 * still performs itself, unmodified — this file adds a check, it does not
 * remove FDH-5's own), not a replacement for it. Disclosed cost of this
 * design: the bytes are classified/reconstructed twice (once by
 * `parser.ts`'s bridge for AIE's own audit trail, once inside
 * `processBankPdfDocument`'s own call to `runBankPdfPipeline`) — a
 * deliberate trade-off for keeping FDH-5's already-certified write path
 * completely unmodified rather than threading a precomputed result through
 * it (see this module's own commit history for the reasoning).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { uploadBankPdf } from '@/lib/financial-data-hub/services/bankPdfUploadService';
import { processBankPdfDocument, BankPdfProcessingError } from '@/lib/financial-data-hub/services/bankPdfProcessingService';
import type { BankCsvUploadMetadataInput } from '@/lib/financial-data-hub/validation/bankCsv';
import { isAieFdhBankAtomicImportEnabled } from './featureFlags';

export interface FdhBankCommitRequest {
  userId: string;
  runId: string;
  intakeId: string;
  bytes: Uint8Array;
  metadata: BankCsvUploadMetadataInput;
}

export type FdhBankCommitOutcome =
  | { committed: false; reason: 'atomic_import_disabled' }
  | { committed: false; reason: 'account_ambiguous' | 'account_unresolved' | 'processing_failed'; detail?: string }
  | { committed: true; statementUploadId: string; transactionsCreated: number; certificationStatus: string | null };

async function recordWriteBatch(params: {
  runId: string;
  intakeId: string;
  userId: string;
  idempotencyKey: string;
  status: 'pending' | 'committed' | 'failed';
  canonicalReferenceId?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_write_batch').upsert(
    {
      run_id: params.runId,
      intake_id: params.intakeId,
      user_id: params.userId,
      target_module: 'fdh_bank',
      idempotency_key: params.idempotencyKey,
      status: params.status,
      canonical_reference_table: params.canonicalReferenceId ? 'fdh_statement_uploads' : null,
      canonical_reference_id: params.canonicalReferenceId ?? null,
      committed_at: params.status === 'committed' ? new Date().toISOString() : null,
    },
    { onConflict: 'idempotency_key' },
  );
}

/**
 * Commits ONE AIE run's bytes through FDH-5's existing, unmodified
 * upload+processing services. Caller (`route.ts`) MUST have already
 * confirmed AIE's own reconciliation gate is `pass`/`pass_with_tolerance`
 * before calling this — this function does not re-check the AIE
 * reconciliation-run rows itself (single-responsibility: it is a commit
 * step, not a second reconciliation gate), but it DOES require the
 * feature flag, and it records a `pending` `aie_write_batch` row before
 * attempting the write and a `committed`/`failed` one after, so a crash
 * mid-commit is always visible rather than silently unrecorded.
 */
export async function commitFdhBankStatementImport(req: FdhBankCommitRequest): Promise<FdhBankCommitOutcome> {
  const idempotencyKey = `aie:${req.runId}:fdh_bank_commit:1`;

  if (!isAieFdhBankAtomicImportEnabled()) {
    return { committed: false, reason: 'atomic_import_disabled' };
  }

  await recordWriteBatch({ runId: req.runId, intakeId: req.intakeId, userId: req.userId, idempotencyKey, status: 'pending' });

  const uploadOutcome = await uploadBankPdf(req.userId, req.metadata, req.bytes);
  if (uploadOutcome.accountResolution === 'ambiguous') {
    await recordWriteBatch({ runId: req.runId, intakeId: req.intakeId, userId: req.userId, idempotencyKey, status: 'failed' });
    return { committed: false, reason: 'account_ambiguous' };
  }

  try {
    const result = await processBankPdfDocument(req.userId, uploadOutcome.document.id);
    if (result.certificationStatus === 'rejected') {
      await recordWriteBatch({
        runId: req.runId,
        intakeId: req.intakeId,
        userId: req.userId,
        idempotencyKey,
        status: 'failed',
        canonicalReferenceId: uploadOutcome.document.id,
      });
      return { committed: false, reason: 'processing_failed', detail: result.pipelineStatus };
    }
    await recordWriteBatch({
      runId: req.runId,
      intakeId: req.intakeId,
      userId: req.userId,
      idempotencyKey,
      status: 'committed',
      canonicalReferenceId: uploadOutcome.document.id,
    });
    return {
      committed: true,
      statementUploadId: uploadOutcome.document.id,
      transactionsCreated: result.transactionsCreated,
      certificationStatus: result.certificationStatus,
    };
  } catch (e) {
    await recordWriteBatch({
      runId: req.runId,
      intakeId: req.intakeId,
      userId: req.userId,
      idempotencyKey,
      status: 'failed',
      canonicalReferenceId: uploadOutcome.document.id,
    });
    if (e instanceof BankPdfProcessingError && e.code === 'account_unresolved') {
      return { committed: false, reason: 'account_unresolved' };
    }
    return { committed: false, reason: 'processing_failed', detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}
