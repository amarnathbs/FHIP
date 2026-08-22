/**
 * Financial Data Hub — FDH-3 raw-document purge service.
 *
 * THE THIRD AND LAST FILE IN THIS MODULE ALLOWED TO USE THE SERVICE-ROLE
 * CLIENT (alongside `services/storage.ts` and `services/auditLog.ts` — see
 * `repositories/base.ts`). Purge is fundamentally a CROSS-USER, system-
 * triggered operation: a scheduled sweep has no authenticated user session
 * to scope an RLS query by, so it cannot use the normal repositories. Every
 * function here is either (a) given one already-identified document row to
 * act on — never a caller-supplied filter that could span tenants — or
 * (b) a read-only "find work" query whose result is always fed back into
 * (a) one row at a time.
 *
 * INVOCATION CONTRACT (spec section 99). No background scheduler is wired up
 * in FDH-3 — this repository has no cron/queue infrastructure beyond
 * `pg_cron`, which is already used for existing report-generation jobs but
 * is a database-side mechanism this module deliberately does not reach for
 * (a purge attempt needs to call the Storage API, which SQL cannot do). The
 * documented, DEV-testable invocation path is
 * `scripts/fdh3_run_purge_sweep.mjs`, run manually or via an external
 * scheduler once approved. FDH-3 does NOT claim automated purge is
 * operationally running — see FDH3_PURGE_CERTIFICATION.md.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { recordDocumentAuditEvent } from './auditLog';
import { deleteDocumentObject, verifyDocumentObjectAbsent } from './storage';
import { assertPurgeTransition, isPurgeEligible } from '../domain/documentLifecycle';
import { buildStatementUploadPurgePatch } from '../domain/privacy';
import { computePurgeDueDate, FDH_DOCUMENT_RETENTION_DAYS } from '../constants/retention';
import type { FdhStatementUpload } from '../domain/types';

export type PurgeAttemptResult =
  | { status: 'purged' }
  | { status: 'already_purged' }
  | { status: 'skipped_no_object' }
  | { status: 'failed'; errorMessage: string };

/**
 * Schedule the purge of an APPROVED document (spec section 39/41). Not
 * exercised by any live FDH-3 flow today (FDH-3 implements no extraction, so
 * no document reaches `approved` through normal use) — provided for
 * completeness and for the certification harness, which constructs an
 * approved document directly.
 */
export async function scheduleApprovedDocumentPurge(document: FdhStatementUpload): Promise<void> {
  if (!isPurgeEligible(document.processing_status)) {
    throw new Error(`document ${document.id} is not purge-eligible (status=${document.processing_status})`);
  }
  assertPurgeTransition(document.raw_document_purge_status, 'pending');
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  await admin
    .from('fdh_statement_uploads')
    .update({
      raw_document_purge_status: 'pending',
      raw_document_purge_due_at: computePurgeDueDate(nowIso, FDH_DOCUMENT_RETENTION_DAYS.approved),
      purge_reason: 'approved_retention_expired',
    })
    .eq('id', document.id);
  await recordDocumentAuditEvent({
    userId: document.user_id,
    documentId: document.id,
    eventType: 'document_purge_scheduled',
    actorType: 'system',
  });
}

/**
 * One purge attempt for one document (spec sections 42-43, 68). Idempotent:
 * a document already `purged` returns `already_purged` without touching
 * storage again (a second delete call against an already-absent object is
 * harmless, but this short-circuit makes the idempotence explicit and
 * avoids an unnecessary Storage API call).
 *
 * NEVER marks the row `purged` before the storage delete has both succeeded
 * AND been independently verified absent.
 */
export async function runPurgeAttempt(document: FdhStatementUpload): Promise<PurgeAttemptResult> {
  if (document.raw_document_purge_status === 'purged') return { status: 'already_purged' };

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  assertPurgeTransition(document.raw_document_purge_status, 'in_progress');
  await admin
    .from('fdh_statement_uploads')
    .update({
      raw_document_purge_status: 'in_progress',
      purge_requested_at: document.purge_requested_at ?? nowIso,
    })
    .eq('id', document.id);

  if (!document.raw_document_storage_reference) {
    // Nothing to delete (e.g. a session that was created but never
    // completed an upload) — go straight to purged.
    await applyPurgedPatch(document.id, nowIso);
    return { status: 'skipped_no_object' };
  }

  const deleted = await deleteDocumentObject(document.raw_document_storage_reference);
  if (!deleted.ok) {
    return failPurgeAttempt(document, deleted.message);
  }

  const absent = await verifyDocumentObjectAbsent(document.raw_document_storage_reference);
  if (!absent) {
    return failPurgeAttempt(document, 'storage object still present after delete');
  }

  await applyPurgedPatch(document.id, nowIso);
  await recordDocumentAuditEvent({
    userId: document.user_id,
    documentId: document.id,
    eventType: 'document_purged',
    actorType: 'system',
  });
  return { status: 'purged' };
}

async function applyPurgedPatch(documentId: string, nowIso: string): Promise<void> {
  const admin = createAdminClient();
  assertPurgeTransition('in_progress', 'purged');
  await admin.from('fdh_statement_uploads').update(buildStatementUploadPurgePatch(nowIso)).eq('id', documentId);
}

async function failPurgeAttempt(document: FdhStatementUpload, rawMessage: string): Promise<PurgeAttemptResult> {
  const admin = createAdminClient();
  assertPurgeTransition('in_progress', 'failed');
  // Sanitised: a raw storage-client error can carry a URL or internal detail
  // (spec section 53) — bounded and stripped of anything path-shaped.
  const sanitised = rawMessage.replace(/https?:\/\/\S+/g, '[redacted-url]').slice(0, 200);
  await admin
    .from('fdh_statement_uploads')
    .update({
      raw_document_purge_status: 'failed',
      purge_attempt_count: document.purge_attempt_count + 1,
      last_purge_error_sanitised: sanitised,
    })
    .eq('id', document.id);
  await recordDocumentAuditEvent({
    userId: document.user_id,
    documentId: document.id,
    eventType: 'document_purge_failed',
    actorType: 'system',
    metadata: { attempt: document.purge_attempt_count + 1 },
  });
  return { status: 'failed', errorMessage: sanitised };
}

/** Read-only "find work" queries — spec section 41/99. Each returns full
 * rows so the caller can feed them straight into `runPurgeAttempt` one at a
 * time; neither takes a caller-supplied filter. */
export async function findDuePurges(limit = 50): Promise<FdhStatementUpload[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('fdh_statement_uploads')
    .select('*')
    .in('raw_document_purge_status', ['pending', 'failed'])
    .lte('raw_document_purge_due_at', new Date().toISOString())
    .order('raw_document_purge_due_at', { ascending: true })
    .limit(limit)
    .returns<FdhStatementUpload[]>();
  return data ?? [];
}

/**
 * Abandoned-upload cleanup (spec section 48). An upload session past its
 * expiry that never completed, or a document that has sat with no forward
 * progress past the abandoned-retention window, is scheduled for purge —
 * never left indefinitely.
 */
export async function sweepAbandonedUploadSessions(limit = 100): Promise<number> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: expiredSessions } = await admin
    .from('fdh_upload_sessions')
    .select('id, document_id, user_id')
    .in('upload_status', ['session_created', 'upload_in_progress'])
    .lt('expires_at', nowIso)
    .limit(limit);
  for (const session of expiredSessions ?? []) {
    await admin
      .from('fdh_upload_sessions')
      .update({ upload_status: 'expired', expired_at: nowIso })
      .eq('id', session.id);
    const { data: doc } = await admin
      .from('fdh_statement_uploads')
      .select('*')
      .eq('id', session.document_id)
      .maybeSingle<FdhStatementUpload>();
    if (!doc || doc.processing_status !== 'created') continue; // already progressed past this session
    await admin.from('fdh_statement_uploads').update({ processing_status: 'failed', error_code: 'internal_error' }).eq('id', doc.id);
    await admin
      .from('fdh_statement_uploads')
      .update({
        raw_document_purge_status: 'pending',
        raw_document_purge_due_at: computePurgeDueDate(nowIso, FDH_DOCUMENT_RETENTION_DAYS.abandoned_days),
        purge_reason: 'abandoned_upload_session',
      })
      .eq('id', doc.id);
  }
  return (expiredSessions ?? []).length;
}
