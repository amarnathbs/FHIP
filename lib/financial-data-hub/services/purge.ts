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
 * INVOCATION CONTRACT — updated by LR-1 (Upload Security, Strict Raw-File
 * Deletion & Document Lifecycle). FDH-3 originally shipped this module with
 * no live caller at all outside tests/certification scripts:
 * `scheduleApprovedDocumentPurge` was never called from any real approval
 * path, and `findDuePurges`/`runPurgeAttempt` were never invoked by anything
 * that runs automatically — meaning a raw document that DID get uploaded had
 * no code path that would ever actually delete it. LR-1 closes that gap two
 * ways, reusing this exact module rather than replacing it:
 *
 *   1. `lib/financial-data-hub/services/approvalService.ts#approveStatement`
 *      now calls `scheduleImmediateDocumentPurge` right after the Approved
 *      Financial Summary is durably written (i.e. AFTER structured staging
 *      exists, per the LR-1 ordering rule).
 *   2. `app/api/financial-data-hub/documents/cron/purge-sweep/route.ts` (new,
 *      reusing the same `x-cron-secret` / `CRON_SECRET` pattern as
 *      `app/api/reports/cron/monthly-generate`) calls, in order,
 *      `sweepAbandonedUploadSessions()`, `enforceRawFileHardBackstop()`, then
 *      `findDuePurges()` + `runPurgeAttempt()` for every due row. This is the
 *      janitor of record for every FDH ingestion pipeline (bank-csv,
 *      bank-pdf, payslip, investment-statement, retirement-statement,
 *      liability-statement) — none of them need their own purge wiring,
 *      because `enforceRawFileHardBackstop` acts on `fdh_statement_uploads`
 *      generically by age, independent of which pipeline produced the row.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { recordDocumentAuditEvent } from './auditLog';
import { deleteDocumentObject, verifyDocumentObjectAbsent } from './storage';
import { assertPurgeTransition, isAllowedPurgeTransition, isPurgeEligible } from '../domain/documentLifecycle';
import { buildStatementUploadPurgePatch } from '../domain/privacy';
import { decideRawFileBackstopAction } from '../domain/rawFileBackstop';
import {
  computePurgeDueDateMinutes,
  FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES,
  FDH_DOCUMENT_RETENTION_MINUTES,
} from '../constants/retention';
import type { FdhStatementUpload } from '../domain/types';

export type PurgeAttemptResult =
  | { status: 'purged' }
  | { status: 'already_purged' }
  | { status: 'skipped_no_object' }
  | { status: 'failed'; errorMessage: string };

/**
 * Schedule the purge of an APPROVED document (spec section 39/41). Called
 * live by `approvalService.ts#approveStatement` (LR-1) immediately after the
 * Approved Financial Summary is durably written — i.e. after structured
 * staging exists, never before.
 *
 * A no-op (rather than a throw) if a purge is already pending/in-progress/
 * purged for this document — approval-adjacent callers must be able to call
 * this defensively (e.g. `reopenStatement` never un-schedules a purge, so a
 * re-approval after reopen must not crash on the second call).
 */
export async function scheduleApprovedDocumentPurge(document: FdhStatementUpload): Promise<void> {
  if (!isPurgeEligible(document.processing_status)) {
    throw new Error(`document ${document.id} is not purge-eligible (status=${document.processing_status})`);
  }
  if (!isAllowedPurgeTransition(document.raw_document_purge_status, 'pending')) {
    return; // already scheduled/purged/in-flight — nothing to do (idempotent)
  }
  assertPurgeTransition(document.raw_document_purge_status, 'pending');
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  await admin
    .from('fdh_statement_uploads')
    .update({
      raw_document_purge_status: 'pending',
      raw_document_purge_due_at: computePurgeDueDateMinutes(nowIso, FDH_DOCUMENT_RETENTION_MINUTES.approved),
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
        raw_document_purge_due_at: computePurgeDueDateMinutes(nowIso, FDH_DOCUMENT_RETENTION_MINUTES.abandoned_minutes),
        purge_reason: 'abandoned_upload_session',
      })
      .eq('id', doc.id);
  }
  return (expiredSessions ?? []).length;
}

/**
 * LR-1 hard raw-retention backstop (spec: "a hard raw-retention backstop...
 * if none exists, implement a 60-minute maximum raw-file lifetime from
 * receipt"). This is the SAFETY NET that does not depend on any individual
 * ingestion pipeline (bank-csv, bank-pdf, payslip, investment-statement,
 * retirement-statement, liability-statement) remembering to schedule a
 * purge on its own success/failure path — it acts on `fdh_statement_uploads`
 * generically, by age, regardless of which pipeline produced the row or
 * what `processing_status` it is currently stuck in (`processing`,
 * `review_required`, `ready_for_approval`, a crashed worker, an abandoned
 * review, etc).
 *
 * A document whose raw object has outlived `maxAgeMinutes` (default: the
 * `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` constant) and is not already
 * purged/mid-purge is force-transitioned exactly the way a user-initiated
 * delete already would be (`uploadLifecycle.ts#userDeleteDocument`'s same
 * two branches — approved documents go straight to `purge_pending`,
 * everything else goes to `rejected` first), then scheduled for immediate
 * purge. This never re-opens or reads the raw object itself — it only flips
 * status columns; the actual delete+verify still happens in
 * `runPurgeAttempt`.
 *
 * Documents already awaiting review keep working from structured staging
 * only, per the LR-1 architectural invariant — nothing here reads or needs
 * the raw file to decide anything.
 */
export async function enforceRawFileHardBackstop(
  maxAgeMinutes: number = FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES,
  limit = 200,
): Promise<{ scanned: number; forcedPurgeCount: number }> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Fetch candidates: a live raw storage reference, not already purged or
  // mid-purge. Age filtering happens in application code below because the
  // triggering timestamp is `uploaded_at` with a `created_at` fallback (a
  // document that failed before an `uploaded_at` stamp was ever set), which
  // a single PostgREST filter cannot express as an OR-with-coalesce cleanly.
  const { data: candidates } = await admin
    .from('fdh_statement_uploads')
    .select('*')
    .not('raw_document_storage_reference', 'is', null)
    .not('raw_document_purge_status', 'in', '(purged,in_progress)')
    .limit(limit)
    .returns<FdhStatementUpload[]>();

  let forcedPurgeCount = 0;
  for (const doc of candidates ?? []) {
    const decision = decideRawFileBackstopAction(
      {
        processingStatus: doc.processing_status,
        purgeStatus: doc.raw_document_purge_status,
        receivedAtIso: doc.uploaded_at ?? doc.created_at,
        purgeDueAtIso: doc.raw_document_purge_due_at,
      },
      Date.now(),
      maxAgeMinutes,
    );
    if (!decision) continue;

    // Mirror userDeleteDocument's exact two branches, as a SYSTEM actor
    // rather than the owning user.
    if (decision.forceProcessingStatus) {
      await admin.from('fdh_statement_uploads').update({ processing_status: decision.forceProcessingStatus }).eq('id', doc.id);
    }

    if (decision.schedulePurgeNow) {
      await admin
        .from('fdh_statement_uploads')
        .update({
          raw_document_purge_status: 'pending',
          raw_document_purge_due_at: nowIso,
          purge_reason: 'raw_retention_hard_backstop_60min',
        })
        .eq('id', doc.id);
      await recordDocumentAuditEvent({
        userId: doc.user_id,
        documentId: doc.id,
        eventType: 'document_purge_scheduled',
        actorType: 'system',
        metadata: { reason: 'raw_retention_hard_backstop', max_age_minutes: maxAgeMinutes },
      });
      forcedPurgeCount += 1;
    }
  }

  return { scanned: (candidates ?? []).length, forcedPurgeCount };
}
