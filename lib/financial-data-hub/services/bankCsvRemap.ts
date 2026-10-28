/**
 * Bank CSV column mapping (28-10-2026) -- the way back to the mapping step.
 *
 * Kept apart from bankCsvProcessingService.ts because it needs the import worker's cleanup, and the worker already imports that service.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { runWithFdhServiceClient } from '../dbContext';
import { statementUploadsRepository } from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import { downloadDocumentObject } from './storage';
import { BankCsvProcessingError } from './bankCsvProcessingService';
import { clearImportArtifacts } from './bankImportWorker';
import { deleteChunks, getJobByDocument } from './bankImportJobStore';
import type { FdhStatementUpload } from '../domain/types';

/**
 * Takes a statement back to "tell us which column is which" after an import that read it wrongly (all amounts zero, most lines unread,
 * dates in the wrong order). Only while NOTHING from it has been approved: the lines the wrong reading wrote are removed, the statement's
 * job is removed so a new one can be admitted, and the stored file is checked to be still there BEFORE anything is removed. An approved
 * line is never touched. Not for a file a recognised layout read: only for one that was read through a column mapping.
 */
export async function resetBankCsvForRemap(userId: string, documentId: string): Promise<FdhStatementUpload> {
  const { data: document } = await statementUploadsRepository.getForUser(userId, documentId);
  if (!document) throw new BankCsvProcessingError('not_found', 'document not found');
  if (!document.mapping_template_id) {
    throw new BankCsvProcessingError('invalid_state', 'this statement was read from a recognised layout, so it has no column mapping to change');
  }
  if (!document.raw_document_storage_reference) throw new BankCsvProcessingError('file_gone', 'the stored copy of this file is no longer available');
  const download = await downloadDocumentObject(document.raw_document_storage_reference);
  if (!download.ok) throw new BankCsvProcessingError('file_gone', 'the stored copy of this file is no longer available');

  const admin = createAdminClient();
  const approved = await admin.from('fdh_transactions').select('id').eq('user_id', userId).eq('statement_upload_id', documentId).eq('approval_status', 'approved').limit(1);
  if (approved.error) throw new BankCsvProcessingError('internal_error', approved.error.message);
  if ((approved.data ?? []).length > 0) {
    throw new BankCsvProcessingError('already_approved', 'some lines of this statement are already approved, so it can no longer be read again');
  }
  const job = await getJobByDocument(userId, documentId);
  if (job && (job.status === 'queued' || job.status === 'processing')) {
    throw new BankCsvProcessingError('in_progress', 'this statement is still being read');
  }

  await runWithFdhServiceClient(admin, async () => {
    await clearImportArtifacts(userId, documentId);
    if (job) await deleteChunks(job.id, userId);
  });
  if (job) {
    const del = await admin.from('fdh_bank_import_jobs').delete().eq('id', job.id).eq('user_id', userId);
    if (del.error) throw new BankCsvProcessingError('internal_error', del.error.message);
  }
  // The lifecycle only lets a document back to `queued` from `failed`, so a read statement (review_required) goes through `failed` first.
  const status = document.processing_status;
  if (status !== 'queued' && status !== 'failed') {
    if (!['review_required', 'extracted', 'processing'].includes(status)) {
      throw new BankCsvProcessingError('invalid_state', 'this statement can no longer be read again');
    }
    const toFailed = await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', updated_at: new Date().toISOString() }).eq('id', documentId).eq('user_id', userId);
    if (toFailed.error) throw new BankCsvProcessingError('internal_error', toFailed.error.message);
  }
  const { data: reset, error: resetError } = await admin.from('fdh_statement_uploads').update({
    updated_at: new Date().toISOString(),
    processing_status: 'queued',
    certification_status: null,
    parsed_row_count: null,
    certified_row_count: null,
    duplicate_row_count: 0,
    reconciliation_status: 'not_available',
    overall_quality_status: 'not_assessed',
    processing_started_at: null,
    processing_completed_at: null,
    review_status: 'not_required',
    error_code: null,
    detection_status: 'manual_mapping_required',
    mapping_template_id: null,
  }).eq('id', documentId).eq('user_id', userId).select().maybeSingle();
  if (resetError) throw new BankCsvProcessingError('internal_error', resetError.message);
  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_detection_completed', actorType: 'user', actorId: userId, metadata: { reason: 'mapping_reopened' } });
  return (reset ?? document) as FdhStatementUpload;
}

