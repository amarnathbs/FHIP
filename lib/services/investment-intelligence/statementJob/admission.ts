/**
 * Document2 (4) WP-J -- ADMISSION of a statement processing request.
 *
 * The request that used to run the whole pipeline now only decides, within a fraction of a second, what is to happen, and answers
 * 202 with a job id (or an immediate answer when no work is needed). It does exactly what the old process route did BEFORE it started
 * parsing, in the same order:
 *
 *   route:      authenticate, Premium run-start guard, malware scan admission (WP-H2: the password is used in memory for that scan only)
 *   admission:  an unfinished job of this statement is RESUMED (never a second one); otherwise the shared preflight (document exists and
 *               is the caller's, AI review waiting, dead runs closed, cached success, stored file present, password attempt limiter),
 *               then ONE job is created, idempotent on the statement and on the client's Idempotency-Key.
 *
 * The password is not part of the job: it is neither stored nor staged. The browser sends it with the first slice (the `read` step),
 * which is the only step that opens the file.
 */

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { initialPipelineState, preflightProcessing, type ProcessSourceDocumentResult } from '../statementPipeline';
import { toPlain } from '../statementStaging';
import { SOURCE_FILE_NOT_STORED_STATUS } from '../caseLifecycle';
import type { StatementJobKind, StatementJobRow } from './model';
import { createJobIfNoneActive, getActiveJobForDocument, StatementJobsUnavailableError } from './store';

export type AdmitResult =
  | { kind: 'answer'; result: ProcessSourceDocumentResult }
  | { kind: 'job'; job: StatementJobRow; resumed: boolean }
  | { kind: 'conflict'; code: 'idempotency_key_in_use' };

export async function admitStatementJob(params: {
  userId: string;
  documentId: string;
  kind: StatementJobKind;
  forceReparse?: boolean;
  /** Used for the preflight password attempt limiter only. Never stored. */
  password?: string;
  idempotencyKey?: string | null;
}): Promise<AdmitResult> {
  const { userId, documentId, kind } = params;
  const admin = createAdminClient();

  // An unfinished job of this statement is resumed: a second click, a second tab or a retry never starts another.
  const active = await getActiveJobForDocument(userId, documentId);
  if (active) return { kind: 'job', job: active, resumed: true };

  if (kind === 'process') {
    const pre = await preflightProcessing(admin, { userId, sourceDocumentId: documentId, password: params.password, forceReparse: params.forceReparse }, { liveJobId: null });
    if (pre.kind === 'answer') return { kind: 'answer', result: pre.result };
  } else {
    const { data: doc } = await admin.from('ii_source_documents').select('id').eq('id', documentId).eq('user_id', userId).maybeSingle();
    if (!doc) return { kind: 'answer', result: { ok: false, status: 'not_found', parseRunId: null, error: 'Source document not found.' } };
  }

  const created = await createJobIfNoneActive({
    userId,
    documentId,
    kind,
    idempotencyKey: params.idempotencyKey ?? `ii-statement-job:${randomUUID()}`,
    checkpoint: toPlain(initialPipelineState(kind, params.forceReparse === true)) as Record<string, unknown>,
  });
  if (created.outcome === 'idempotency_key_in_use') return { kind: 'conflict', code: 'idempotency_key_in_use' };
  return { kind: 'job', job: created.job, resumed: created.outcome === 'existing' };
}

export interface ReprocessAfterResolution {
  reprocessed: boolean;
  reprocessError: string | null;
  needsReplacementCopy: boolean;
  /** Set when the reprocess was admitted as a background job: the screen follows it (nothing is lost if it is closed). */
  reprocessJobId: string | null;
}

/**
 * The reprocess that follows a resolution the person just made (choosing an instrument, amending a decision). The choice is already
 * saved; applying it re-reads the statement, which for a large one must not run inside this request. Where the job tables do not exist
 * yet the earlier synchronous behaviour is used, so a deployment that runs ahead of the database still works for small statements.
 */
export async function reprocessAfterResolution(userId: string, documentId: string): Promise<ReprocessAfterResolution> {
  try {
    const admitted = await admitStatementJob({ userId, documentId, kind: 'process', forceReparse: true });
    if (admitted.kind === 'job') return { reprocessed: false, reprocessError: null, needsReplacementCopy: false, reprocessJobId: admitted.job.id };
    if (admitted.kind === 'answer') {
      const r = admitted.result;
      return {
        reprocessed: r.ok,
        reprocessError: r.ok ? null : r.error ?? 'Reprocessing did not complete successfully.',
        // The raw file is deleted on purpose after processing: the choice IS saved, applying it needs a replacement copy of the statement.
        needsReplacementCopy: !r.ok && r.status === SOURCE_FILE_NOT_STORED_STATUS,
        reprocessJobId: null,
      };
    }
    return { reprocessed: false, reprocessError: 'A processing request with the same key is already in use.', needsReplacementCopy: false, reprocessJobId: null };
  } catch (e) {
    if (e instanceof StatementJobsUnavailableError) {
      const { processSourceDocument } = await import('../documentProcessing');
      try {
        const result = await processSourceDocument({ userId, sourceDocumentId: documentId, forceReparse: true });
        return {
          reprocessed: result.ok,
          reprocessError: result.ok ? null : result.error ?? 'Reprocessing did not complete successfully.',
          needsReplacementCopy: !result.ok && result.status === SOURCE_FILE_NOT_STORED_STATUS,
          reprocessJobId: null,
        };
      } catch (inner) {
        return { reprocessed: false, reprocessError: inner instanceof Error ? inner.message : 'Reprocessing failed unexpectedly.', needsReplacementCopy: false, reprocessJobId: null };
      }
    }
    return { reprocessed: false, reprocessError: e instanceof Error ? e.message : 'Reprocessing failed unexpectedly.', needsReplacementCopy: false, reprocessJobId: null };
  }
}
