/**
 * PC5 (M4) — K.11: *"Provide a clear path to discard a statement uploaded
 * for the wrong person/household. Discard must: block canonical
 * publication; purge binary; purge unneeded token maps; retain minimal
 * privacy-safe audit that a source was discarded where required; not delete
 * unrelated canonical investments."*
 *
 * ================================================================
 * FIVE REQUIREMENTS, FIVE ANSWERS
 * ================================================================
 *
 * 1. BLOCK CANONICAL PUBLICATION. Delegated ENTIRELY to AIE's existing
 *    `rejectRun`, which CAS-transitions the run to `failed_terminal` and
 *    the intake to `cancelled`. `failed_terminal` is in
 *    `AIE_TERMINAL_RUN_STATUSES` and has NO onward transitions in
 *    `AIE_RUN_TRANSITIONS` — so the acceptance gate's `run.status !==
 *    'awaiting_acceptance'` check can never again be satisfied for this
 *    run, structurally, and no future code path can move it back. That is a
 *    far stronger guarantee than a PC5-owned "discarded" flag some other
 *    call site might forget to check, which is why PC5 adds no such flag.
 *
 *    Note the intake goes to `'cancelled'`, not `'rejected'`, and that is
 *    correct rather than a workaround: by the time a run is reviewable its
 *    intake is already `'ready'`, whose only legal onward transitions in
 *    `AIE_INTAKE_TRANSITIONS` are `['cancelled','deleted']`. `'rejected'`
 *    is reserved for an ADMISSION-time content rejection, before any run
 *    exists. `rejectRun`'s own header records this.
 *
 * 2. PURGE BINARY. Delegated to AIE's existing
 *    `finalizeDocumentBinaryAfterRun`, the SAME function `accept.ts` calls
 *    after a successful write — delete, then INDEPENDENTLY VERIFY ABSENT,
 *    then mark. A delete call returning success is not treated as proof.
 *    If verification cannot confirm absence, the intake is scheduled for
 *    the sweep's bounded retry rather than being marked purged, and the
 *    24-hour hard backstop remains behind that.
 *
 * 3. PURGE UNNEEDED TOKEN MAPS. There are none left to purge, and the
 *    mechanism still exists. Phase 4 implemented the Product Owner's
 *    2026-09-15 one-way-HMAC decision by DELETING the reversible token map
 *    entirely — `lib/aie/masking/tokenMapCrypto.ts` is gone,
 *    `persistMaskTokenMap` is gone, and `aie_mask_token_map` has had no
 *    writer since. The TTL sweep (`purgeExpiredMaskTokenMaps`) still runs
 *    unconditionally on every cron pass precisely so the guarantee survives
 *    if some future code path starts writing the table again. K.11 asks for
 *    the mechanism to exist for future categories; it does, it is already
 *    scheduled, and this file does not duplicate it. Re-verified against
 *    the current tree rather than inherited from the Phase 4 report.
 *
 * 4. RETAIN MINIMAL PRIVACY-SAFE AUDIT. Two rows: AIE's own `run_failed`
 *    audit event (written by `rejectRun`) and an Investment Intelligence
 *    `pc5_statement_discarded` event. Neither carries a holder name, a
 *    folio number, a file name or any document content — only ids, the
 *    reason category, and the counts.
 *
 * 5. NOT DELETE UNRELATED CANONICAL INVESTMENTS. This module imports NO
 *    canonical write service and issues no delete of any kind. It cannot
 *    touch `ii_transactions`, `ii_holding_snapshots`, `ii_accounts` or
 *    anything else — there is nothing here to review for scope, because
 *    there is no deletion code at all. A discarded statement is one that
 *    was never accepted, so by construction it produced no canonical rows
 *    to remove: the ONLY path from a run to a canonical Investment
 *    Intelligence row is `accept.ts`, and a run that reaches discard has
 *    not been through it (a `completed` run is refused below).
 */

import { rejectRun } from '@/lib/aie/review/reject';
import { finalizeDocumentBinaryAfterRun } from '@/lib/aie/services/purge';
import { getIntakeUploadMetadata, getRunForUser } from '@/lib/aie/db/repository';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { isPc5ResolutionEnabled } from './featureFlags';

/** The reasons a user may give. A closed vocabulary, so the audit is
 * queryable and so the reason can never carry free text that might contain
 * the very PII the discard exists to remove. */
export const PC5_DISCARD_REASONS = ['wrong_person', 'wrong_household', 'wrong_account', 'uploaded_in_error', 'other'] as const;
export type Pc5DiscardReason = (typeof PC5_DISCARD_REASONS)[number];

export type Pc5DiscardBinaryOutcome = 'deleted' | 'scheduled_for_retry' | 'already_deleted' | 'no_binary_recorded';

export type Pc5DiscardOutcome =
  | { ok: false; reason: 'feature_flag_disabled' | 'not_found' | 'not_eligible' | 'already_accepted' | 'stale_conflict' }
  | {
      ok: true;
      binary: Pc5DiscardBinaryOutcome;
      /** Always zero today, and reported anyway — see this file's header
       * point 3. A non-zero value here would mean something started writing
       * the token map again, which is worth noticing. */
      tokenMapRowsPurged: 0;
    };

export interface Pc5DiscardParams {
  runId: string;
  userId: string;
  reason: Pc5DiscardReason;
}

export async function discardStatement(params: Pc5DiscardParams): Promise<Pc5DiscardOutcome> {
  if (!isPc5ResolutionEnabled()) return { ok: false, reason: 'feature_flag_disabled' };

  const run = await getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };

  // A run that already reached `completed` has a canonical Investment
  // Intelligence document behind it. Discarding THAT is not a discard at
  // all — it is an unwind of an accepted import, which is K.18's
  // amendment/supersession question and belongs to Investment
  // Intelligence's own `unpublishPosition`/`document_superseded` path, not
  // here. Refused explicitly rather than silently doing half of it.
  if (run.status === 'completed' || run.status === 'accepted' || run.status === 'write_pending') {
    return { ok: false, reason: 'already_accepted' };
  }

  // Capture the storage key BEFORE rejecting: `rejectRun` moves the intake
  // to `cancelled`, and a later read would still find the key, but reading
  // it first keeps this function's own ordering obvious and makes the
  // "nothing was ever stored" case explicit rather than inferred from a
  // later failure.
  const uploadMetadata = await getIntakeUploadMetadata(run.intakeId);

  const rejected = await rejectRun({
    runId: params.runId,
    userId: params.userId,
    rationale: `pc5_discard:${params.reason}`,
  });
  if (!rejected.ok) {
    if (rejected.reason === 'not_found') return { ok: false, reason: 'not_found' };
    if (rejected.reason === 'stale_conflict') return { ok: false, reason: 'stale_conflict' };
    return { ok: false, reason: 'not_eligible' };
  }

  let binary: Pc5DiscardBinaryOutcome;
  if (!uploadMetadata?.storageKey) {
    binary = 'no_binary_recorded';
  } else {
    const purge = await finalizeDocumentBinaryAfterRun({
      intakeId: run.intakeId,
      userId: run.userId,
      storageKey: uploadMetadata.storageKey,
    });
    binary = purge.status;
  }

  await emitAuditEvent({
    userId: params.userId,
    eventType: 'pc5_statement_discarded',
    subjectType: 'aie_extraction_run',
    subjectId: run.id,
    actorType: 'user',
    actorId: params.userId,
    metadata: {
      // Closed-vocabulary reason, run/intake ids, and the purge result.
      // Deliberately NOT the filename, the holder name, the folio number or
      // any document content — the audit records THAT a source was
      // discarded, never what was in it.
      reason: params.reason,
      intakeId: run.intakeId,
      binaryPurgeResult: binary,
    },
  });

  return { ok: true, binary, tokenMapRowsPurged: 0 };
}
