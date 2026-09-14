/**
 * AIE-1 closure mission (sections 4 & 9) — the temporary-document retention/
 * purge service AIE never had. Reuses LR-1's exact shape
 * (`lib/financial-data-hub/services/purge.ts`) rather than inventing a
 * second retention mechanism: find-due -> attempt (in_progress -> delete ->
 * INDEPENDENTLY VERIFY ABSENT -> purged) -> record outcome, plus a
 * generic-by-age hard backstop that does not depend on any individual route
 * remembering to schedule a purge.
 *
 * TWO COMPLEMENTARY PATHS (mission section 4.1/4.2):
 *   1. PRIMARY — immediate deletion. `finalizeDocumentBinaryAfterRun()` is
 *      called directly by each of the three intake routes right after
 *      `runExtractionPipeline()` returns (always one of `privacy_blocked`,
 *      `unresolved`, or `awaiting_acceptance` — never a state that still
 *      needs the original bytes, since by this point required extraction
 *      has completed and structured candidates/reconciliation results are
 *      already durably persisted). This is the normal path for the vast
 *      majority of documents and does not wait for user acceptance.
 *   2. BACKSTOP — the scheduled sweep (`findDuePurges` + `runPurgeAttempt`,
 *      called by `app/api/aie/cron/purge-sweep/route.ts` every 15 minutes)
 *      catches whatever the primary path missed: a worker crash mid-request
 *      before the immediate-deletion call ever ran, a transient storage
 *      failure on the immediate attempt (scheduled here as `pending` for
 *      retry rather than silently dropped), or a stuck/abandoned intake
 *      approaching the hard 24-hour maximum age
 *      (`enforceAieRawFileHardBackstop`).
 *
 * NEVER marks an intake `deleted`/`purged` before the storage delete has
 * both succeeded AND been independently re-verified absent
 * (`verifyQuarantineObjectAbsent` — a delete-call success alone is not
 * proof, matching FDH-3/LR-1's own established discipline).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { deleteFromQuarantine, verifyQuarantineObjectAbsent } from '../storage';
import { purgeExpiredMaskTokenMapRows } from '../db/repository';
import { recordAieAuditEvent } from '../audit';

const AIE_PURGE_HARD_MAX_AGE_MINUTES = 24 * 60; // mission section 4.2 default
const AIE_PURGE_FAILED_RETRY_DELAY_MINUTES = 5; // bounded backoff before a failed sweep attempt is retried

/**
 * M3 (Phase 4) — the Product Owner's 2026-09-15 mask-token retention
 * decision, as a constant so the number is reviewable in one place: "FIXED
 * SHORT TTL (24-48 hours), independent of document lifecycle state", with
 * 48 hours taken as the decided default. Nothing shorter was chosen because
 * no reason to prefer 24 was found — after the one-way-HMAC decision there
 * is no legitimate writer of this table left at all, so the TTL now acts
 * purely as a hard backstop rather than as a working retention window, and
 * the looser end of the decided range is the safer default for a backstop.
 */
export const AIE_MASK_TOKEN_MAP_TTL_HOURS = 48;

interface AiePurgeRow {
  id: string;
  user_id: string;
  status: string;
  storage_key: string | null;
  purge_status: 'not_required' | 'pending' | 'in_progress' | 'purged' | 'failed';
  purge_attempt_count: number;
  created_at: string;
}

function sanitiseError(message: string): string {
  // Same discipline as FDH's own failPurgeAttempt: strip anything URL-shaped
  // (could carry a signed-URL/host detail) and cap length.
  return message.replace(/https?:\/\/\S+/g, '[redacted-url]').slice(0, 200);
}

/**
 * PRIMARY path. Called once, right after `runExtractionPipeline()` returns,
 * by each of the three intake routes. Idempotent: a no-op (returns
 * `already_deleted`) if the intake has no live storage key (e.g. admission
 * already rejected the document before any object was written, or a prior
 * call already deleted it — defensive, should not normally re-fire).
 */
export async function finalizeDocumentBinaryAfterRun(params: {
  intakeId: string;
  userId: string;
  storageKey: string;
}): Promise<{ status: 'deleted' } | { status: 'scheduled_for_retry'; message: string } | { status: 'already_deleted' }> {
  const admin = createAdminClient();

  const deleted = await deleteFromQuarantine(params.storageKey);
  if (deleted.ok) {
    const absent = await verifyQuarantineObjectAbsent(params.storageKey);
    if (absent) {
      const { error } = await admin
        .from('aie_document_intake')
        .update({ status: 'deleted', storage_key: null, purge_status: 'purged', purged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', params.intakeId)
        .eq('status', 'ready'); // CAS-style: only transition from the expected prior state
      if (!error) {
        await recordAieAuditEvent({ intakeId: params.intakeId, runId: null, userId: params.userId, eventType: 'document_deleted_immediate', actorType: 'system' });
        return { status: 'deleted' };
      }
    }
  }

  // Delete failed, or verification could not confirm absence, or the CAS
  // update didn't apply (e.g. status already moved on) — never silently
  // drop this. Schedule an immediate-due retry for the sweep to pick up
  // (mission section 4.2: "bounded retries while the object remains within
  // TTL" — the sweep enforces the bound, this call site only schedules).
  const message = deleted.ok ? 'delete call succeeded but object presence could not be independently verified absent' : deleted.message;
  await admin
    .from('aie_document_intake')
    .update({ purge_status: 'pending', purge_due_at: new Date().toISOString(), purge_reason: 'immediate_deletion_retry', updated_at: new Date().toISOString() })
    .eq('id', params.intakeId);
  await recordAieAuditEvent({
    intakeId: params.intakeId,
    runId: null,
    userId: params.userId,
    eventType: 'document_purge_scheduled',
    actorType: 'system',
    metadata: { reason: 'immediate_deletion_retry' },
  });
  return { status: 'scheduled_for_retry', message: sanitiseError(message) };
}

/** Read-only "find work" query (mission section 9: "a scheduled job and
 * storage lifecycle as independent backstops"). Never takes a caller
 * filter — feeds straight into `runPurgeAttempt` one row at a time. */
export async function findDuePurges(limit = 50): Promise<AiePurgeRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_document_intake')
    .select('id, user_id, status, storage_key, purge_status, purge_attempt_count, created_at')
    .in('purge_status', ['pending', 'failed'])
    .lte('purge_due_at', new Date().toISOString())
    .order('purge_due_at', { ascending: true })
    .limit(limit)
    .returns<AiePurgeRow[]>();
  return data ?? [];
}

export type PurgeAttemptResult =
  | { status: 'purged' }
  | { status: 'already_purged' }
  | { status: 'skipped_no_object' }
  | { status: 'failed'; errorMessage: string };

/** One purge attempt for one intake row. Idempotent (an already-`purged`
 * row is a no-op) and safe under concurrent sweep invocations — the
 * in_progress transition plus the final CAS-style update on `purge_status`
 * means a duplicate concurrent sweep run cannot double-count or race a
 * genuine active reader indefinitely (mission section 9: "use processing
 * leases or equivalent protection"). */
export async function runPurgeAttempt(row: AiePurgeRow): Promise<PurgeAttemptResult> {
  if (row.purge_status === 'purged') return { status: 'already_purged' };

  const admin = createAdminClient();
  await admin.from('aie_document_intake').update({ purge_status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', row.id);

  if (!row.storage_key) {
    const { error: noObjectError } = await admin
      .from('aie_document_intake')
      .update({ status: terminalStatusAfterPurge(), purge_status: 'purged', purged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (noObjectError) return failAttempt(row, noObjectError.message);
    return { status: 'skipped_no_object' };
  }

  const deleted = await deleteFromQuarantine(row.storage_key);
  if (!deleted.ok) return failAttempt(row, deleted.message);

  const absent = await verifyQuarantineObjectAbsent(row.storage_key);
  if (!absent) return failAttempt(row, 'storage object still present after delete');

  // M2 (H.1) — the result of this update is now CHECKED. Previously it was
  // not, and that was a real audit-integrity defect, not a theoretical one:
  // `chk_aie_intake_purged_status` (migration 0149) requires
  // `purge_status <> 'purged' OR status = 'deleted'`, but the old status
  // expression left `received` and `quarantined` rows unchanged while still
  // setting `purge_status: 'purged'`. The database refused the whole row
  // update, the error was discarded, and the code then wrote a
  // `document_purged` audit event and returned `{ status: 'purged' }` for a
  // row that had not been updated at all. Because `storage_key` was
  // therefore never nulled, `findDuePurges` kept re-selecting the same row,
  // so each sweep appended another false `document_purged` event for a
  // document that was already gone from storage. The hard backstop
  // (`enforceAieRawFileHardBackstop`) genuinely reaches those two statuses
  // -- it selects on age alone with no status filter -- so this was live on
  // exactly the abandoned-upload rows the backstop exists to clean up.
  const { error: purgeError } = await admin
    .from('aie_document_intake')
    .update({
      status: terminalStatusAfterPurge(),
      storage_key: null,
      purge_status: 'purged',
      purged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (purgeError) return failAttempt(row, purgeError.message);

  await recordAieAuditEvent({ intakeId: row.id, runId: null, userId: row.user_id, eventType: 'document_purged', actorType: 'system' });
  return { status: 'purged' };
}

/**
 * M2 (H.1) — the single place that decides what an intake's `status` becomes
 * once its bytes are gone.
 *
 * `deleted` is the purge job's own terminal verdict and it must be reachable
 * from EVERY non-deleted state, because the 24-hour retention guarantee
 * cannot be allowed to depend on which state a row happened to stall in. An
 * upload that crashed while still `received` or `quarantined` is precisely
 * the case the hard backstop exists for; leaving those rows in a
 * non-`deleted` status made them unpurgeable (see the CHECK-constraint
 * explanation above) and so made them accumulate forever.
 *
 * Kept as one function rather than two inline ternaries so the two call
 * sites above cannot drift apart again -- they previously listed different
 * status sets (`ready` only, versus `ready`/`rejected`/`cancelled`), which
 * is how the gap survived review.
 */
function terminalStatusAfterPurge(): AiePurgeRow['status'] {
  return 'deleted';
}

async function failAttempt(row: AiePurgeRow, rawMessage: string): Promise<PurgeAttemptResult> {
  const admin = createAdminClient();
  const sanitised = sanitiseError(rawMessage);
  await admin
    .from('aie_document_intake')
    .update({
      purge_status: 'failed',
      purge_attempt_count: row.purge_attempt_count + 1,
      last_purge_error_sanitised: sanitised,
      // Bounded retry: schedule the next attempt a short delay out rather
      // than immediately re-looping within the same sweep invocation.
      purge_due_at: new Date(Date.now() + AIE_PURGE_FAILED_RETRY_DELAY_MINUTES * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  await recordAieAuditEvent({
    intakeId: row.id,
    runId: null,
    userId: row.user_id,
    eventType: 'document_purge_failed',
    actorType: 'system',
    metadata: { attempt: row.purge_attempt_count + 1 },
  });
  return { status: 'failed', errorMessage: sanitised };
}

/**
 * M3 (Phase 4) — mask-token-map TTL enforcement, run by the same scheduled
 * sweep as the binary purge.
 *
 * SEPARATE FROM THE BINARY PURGE ON PURPOSE. `runPurgeAttempt` above deletes
 * a document's bytes and is driven by that document's own lifecycle
 * (`purge_status`, `purge_due_at`). This one is driven by nothing but wall
 * time. It takes no intake id, performs no join, consults no status, and has
 * no way to be told "not yet, this one is still under review" — because the
 * Product Owner's decision was explicitly that a document still under review
 * past the TTL loses this data, and a lifecycle-aware variant would quietly
 * be a different policy.
 *
 * It also runs UNCONDITIONALLY rather than only when rows are expected. The
 * table has had no writer since the one-way-HMAC change, so in normal
 * operation this deletes zero rows every time — which is the point: the
 * guarantee should hold even if some future code path starts writing to the
 * table again without anyone remembering this decision.
 */
export async function purgeExpiredMaskTokenMaps(ttlHours: number = AIE_MASK_TOKEN_MAP_TTL_HOURS): Promise<{ deleted: number; ttlHours: number }> {
  const { deleted } = await purgeExpiredMaskTokenMapRows(ttlHours);
  if (deleted > 0) {
    // No intake id and no user id are available here (the table keys on
    // run_id only, and this sweep deliberately does not join to find them),
    // so the audit records the COUNT and the policy, never a subject. That
    // is the correct shape for a time-driven retention event: it evidences
    // that the policy ran and what it removed, without re-identifying whose
    // data it was.
    await recordAieAuditEvent({
      intakeId: null,
      runId: null,
      userId: null,
      eventType: 'mask_token_map_ttl_purged',
      actorType: 'system',
      metadata: { deleted_rows: deleted, ttl_hours: ttlHours, policy: 'po_decision_2026_09_15_fixed_ttl_lifecycle_independent' },
    });
  }
  return { deleted, ttlHours };
}

/**
 * BACKSTOP. Mission section 4.2: "maximum temporary binary age: 24 hours."
 * Acts generically on `aie_document_intake` by age, independent of which
 * route created the row or what status it is currently stuck in — the
 * safety net for a worker crash before the primary immediate-deletion path
 * ever ran (e.g. the process died between `uploadToQuarantine` succeeding
 * and any pipeline outcome being reached).
 */
export async function enforceAieRawFileHardBackstop(
  maxAgeMinutes: number = AIE_PURGE_HARD_MAX_AGE_MINUTES,
  limit = 200,
): Promise<{ scanned: number; forcedPurgeCount: number }> {
  const admin = createAdminClient();
  const cutoffIso = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();

  const { data: candidates } = await admin
    .from('aie_document_intake')
    .select('id, user_id, status, storage_key, purge_status, purge_attempt_count, created_at')
    .not('storage_key', 'is', null)
    .not('purge_status', 'in', '(purged,in_progress)')
    .lte('created_at', cutoffIso)
    .limit(limit)
    .returns<AiePurgeRow[]>();

  let forcedPurgeCount = 0;
  for (const row of candidates ?? []) {
    await admin
      .from('aie_document_intake')
      .update({ purge_status: 'pending', purge_due_at: new Date().toISOString(), purge_reason: 'raw_retention_hard_backstop_24h', updated_at: new Date().toISOString() })
      .eq('id', row.id);
    await recordAieAuditEvent({
      intakeId: row.id,
      runId: null,
      userId: row.user_id,
      eventType: 'document_purge_scheduled',
      actorType: 'system',
      metadata: { reason: 'raw_retention_hard_backstop', max_age_minutes: maxAgeMinutes },
    });
    forcedPurgeCount += 1;
  }
  return { scanned: (candidates ?? []).length, forcedPurgeCount };
}
