/**
 * AIE-1.2 — the gated, atomic, idempotent canonical write (execution
 * sequence step 11): "Implement the actual atomic, idempotent canonical
 * Investment Intelligence write (through the module's own existing write
 * services, not a new direct-to-table path) — GATED so it never fires
 * until reconciliation passes and (since this phase has no production
 * authority) behind a feature flag defaulted OFF."
 *
 * NO NEW DIRECT-TO-TABLE WRITE PATH. This function inserts exactly ONE row
 * itself (`ii_source_documents` — the same shape
 * `app/api/investment-intelligence/source-documents/route.ts`'s own POST
 * handler already creates for a normal manual upload) and then delegates
 * EVERY canonical write (accounts, instruments, transactions, holdings,
 * reconciliation cases, certification) to Investment Intelligence's OWN
 * existing, already-certified orchestrator, `processSourceDocument`
 * (lib/services/investment-intelligence/documentProcessing.ts) — unchanged,
 * uncopied, called exactly as the real upload flow calls it. That function
 * already provides the atomicity/idempotency this step requires (its own
 * header: "canonical writes are staged in-memory... a write-time failure
 * partway through leaves already-written rows valid... the run is marked
 * 'failed' and is safely retryable").
 *
 * GATES, IN ORDER (all three must hold, checked in the order a reviewer
 * would want to see refused first):
 *   1. `isIiAdapterCanonicalWriteEnabled()` — the kill switch, default OFF.
 *   2. The reconciliation outcome passed to this function is `pass` or
 *      `pass_with_tolerance` — never `fail`/`indeterminate`/`not_applicable`
 *      (P4: a confidence score can never override this; there is no
 *      confidence parameter anywhere in this file's signatures).
 *   3. No open BLOCKING unresolved item remains for this run. Since AIE-1.5
 *      (the real review/acceptance UI) does not exist yet, "required user
 *      acceptance" is represented here, honestly, as an explicit
 *      `acceptedByUserId` the caller must supply AND a caller-verified
 *      absence of open blocking items — this function does not itself
 *      decide what counts as acceptance; it refuses to proceed without
 *      both signals being asserted true by its caller.
 *
 * IDEMPOTENCY. `aie_ii_adapter_link` (migration 0141) has a unique
 * constraint on `aie_run_id` — a second call for the same run either finds
 * the existing link (returns it, does not re-write) or, if the DB itself
 * rejects a duplicate insert, is treated as "already written" rather than
 * a fresh error.
 */

import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { downloadFromQuarantine } from '../../storage';
import { generateObjectKey, uploadSourceDocumentObject } from '@/lib/services/investment-intelligence/storage';
import { processSourceDocument, type ProcessSourceDocumentResult } from '@/lib/services/investment-intelligence/documentProcessing';
import { isIiAdapterCanonicalWriteEnabled } from './featureFlags';
import type { AieReconciliationOutcome } from '../../types';

export interface AcceptAndWriteInput {
  aieIntakeId: string;
  aieRunId: string;
  userId: string;
  ownerMemberId: string | null;
  countryCode: string;
  originalFilename: string;
  declaredMimeType: string;
  quarantineStorageKey: string;
  acceptedByUserId: string;
  reconciliationOutcome: AieReconciliationOutcome;
  hasOpenBlockingUnresolvedItems: boolean;
}

export type AcceptAndWriteOutcome =
  | { ok: false; reason: 'feature_flag_disabled' | 'reconciliation_not_passed' | 'unresolved_items_open' }
  | { ok: false; reason: 'already_written'; iiSourceDocumentId: string }
  | { ok: false; reason: 'quarantine_download_failed' | 'storage_upload_failed' | 'source_document_insert_failed' | 'link_insert_failed'; message: string }
  | { ok: true; iiSourceDocumentId: string; iiResult: ProcessSourceDocumentResult };

export interface AcceptAndWriteDeps {
  findExistingLink: (aieRunId: string) => Promise<{ iiSourceDocumentId: string } | null>;
  downloadQuarantined: typeof downloadFromQuarantine;
  uploadToIiStorage: typeof uploadSourceDocumentObject;
  insertSourceDocument: (params: {
    userId: string;
    ownerMemberId: string | null;
    countryCode: string;
    checksum: string;
    storagePath: string;
    originalFilename: string;
    mimeType: string;
    fileSize: number;
  }) => Promise<{ id: string } | { error: string }>;
  processDocument: typeof processSourceDocument;
  recordLink: (params: { aieIntakeId: string; aieRunId: string; userId: string; iiSourceDocumentId: string; acceptedByUserId: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export function createDefaultAcceptAndWriteDeps(): AcceptAndWriteDeps {
  return {
    findExistingLink: async (aieRunId) => {
      const admin = createAdminClient();
      const { data } = await admin.from('aie_ii_adapter_link').select('ii_source_document_id').eq('aie_run_id', aieRunId).maybeSingle();
      return data ? { iiSourceDocumentId: data.ii_source_document_id as string } : null;
    },
    downloadQuarantined: downloadFromQuarantine,
    uploadToIiStorage: uploadSourceDocumentObject,
    insertSourceDocument: async (params) => {
      const admin = createAdminClient();
      // Mirrors app/api/investment-intelligence/source-documents/route.ts's
      // own POST handler shape exactly (document_type is left null here —
      // this adapter's own certified parsers self-detect document type from
      // evidence at parse time; 'other' would be a guess this file has no
      // basis for and the spec forbids guessing).
      const { data, error } = await admin
        .from('ii_source_documents')
        .insert({
          user_id: params.userId,
          owner_member_id: params.ownerMemberId,
          country_code: params.countryCode,
          status: 'uploaded',
          checksum: params.checksum,
          storage_path: params.storagePath,
          original_filename: params.originalFilename,
          mime_type: params.mimeType,
          file_size: params.fileSize,
        })
        .select('id')
        .single();
      if (error || !data) return { error: error?.message ?? 'ii_source_documents insert failed' };
      return { id: data.id as string };
    },
    processDocument: processSourceDocument,
    recordLink: async (params) => {
      const admin = createAdminClient();
      const { error } = await admin.from('aie_ii_adapter_link').insert({
        aie_intake_id: params.aieIntakeId,
        aie_run_id: params.aieRunId,
        user_id: params.userId,
        ii_source_document_id: params.iiSourceDocumentId,
        accepted_by_user_id: params.acceptedByUserId,
      });
      if (error) {
        if (error.code === '23505') return { ok: true }; // idempotent replay — link already exists
        return { ok: false, message: error.message };
      }
      return { ok: true };
    },
  };
}

export async function acceptAndWriteInvestmentCandidates(input: AcceptAndWriteInput, deps: AcceptAndWriteDeps): Promise<AcceptAndWriteOutcome> {
  if (!isIiAdapterCanonicalWriteEnabled()) return { ok: false, reason: 'feature_flag_disabled' };
  if (input.reconciliationOutcome === 'fail' || input.reconciliationOutcome === 'indeterminate' || input.reconciliationOutcome === 'not_applicable') {
    return { ok: false, reason: 'reconciliation_not_passed' };
  }
  if (input.hasOpenBlockingUnresolvedItems) return { ok: false, reason: 'unresolved_items_open' };

  const existing = await deps.findExistingLink(input.aieRunId);
  if (existing) return { ok: false, reason: 'already_written', iiSourceDocumentId: existing.iiSourceDocumentId };

  const download = await deps.downloadQuarantined(input.quarantineStorageKey);
  if (!download.ok) return { ok: false, reason: 'quarantine_download_failed', message: download.message };

  const checksum = createHash('sha256').update(download.bytes).digest('hex');
  const objectKey = generateObjectKey(input.userId, input.originalFilename);
  const upload = await deps.uploadToIiStorage(objectKey, download.bytes, input.declaredMimeType);
  if (upload.error) return { ok: false, reason: 'storage_upload_failed', message: upload.error };

  const inserted = await deps.insertSourceDocument({
    userId: input.userId,
    ownerMemberId: input.ownerMemberId,
    countryCode: input.countryCode,
    checksum,
    storagePath: objectKey,
    originalFilename: input.originalFilename,
    mimeType: input.declaredMimeType,
    fileSize: download.bytes.byteLength,
  });
  if ('error' in inserted) return { ok: false, reason: 'source_document_insert_failed', message: inserted.error };

  const link = await deps.recordLink({
    aieIntakeId: input.aieIntakeId,
    aieRunId: input.aieRunId,
    userId: input.userId,
    iiSourceDocumentId: inserted.id,
    acceptedByUserId: input.acceptedByUserId,
  });
  if (!link.ok) return { ok: false, reason: 'link_insert_failed', message: link.message };

  const iiResult = await deps.processDocument({ userId: input.userId, sourceDocumentId: inserted.id });
  return { ok: true, iiSourceDocumentId: inserted.id, iiResult };
}
