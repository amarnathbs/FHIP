/**
 * AIE-1.5 — document-level "reject document" / "request reprocessing"
 * actions (ACT-05/07). Unlike item-level decisions, these act on the RUN
 * (and, for reject, the INTAKE) as a whole — there is no partial-document
 * accept (section 35: "Unable to process safely... prohibited outcome:
 * partial canonical import").
 *
 * INTAKE STATE-MACHINE NOTE (disclosed deviation from the naive reading of
 * "reject"): by the time a run reaches `unresolved`/`awaiting_acceptance`,
 * its `aie_document_intake.status` is already `'ready'`
 * (`lib/aie/stateMachine.ts`'s `AIE_INTAKE_TRANSITIONS`). This function moves
 * that intake to `'cancelled'`, and reports the user-facing outcome as
 * "declined".
 *
 * M12C CORRECTION TO THIS NOTE. It used to assert that `'ready'`'s only legal
 * onward transitions were `['cancelled', 'deleted']` and that `'rejected'`
 * was an ILLEGAL transition from `'ready'`. That was true when it was
 * written; it is not true now. M2 (H.1) added the edge, and
 * `lib/aie/stateMachine.ts`'s `AIE_INTAKE_TRANSITIONS.ready` today reads
 * `['rejected', 'cancelled', 'deleted']` — because admission to `'ready'`
 * happens before local text extraction is attempted, so an extraction
 * failure genuinely has to reject an already-`'ready'` intake.
 *
 * The BEHAVIOUR here is unchanged and still correct, but for a different and
 * better reason than the stale note gave. `'cancelled'` is chosen because it
 * is the ACCURATE verdict, not because `'rejected'` is unavailable:
 * cancellation is a USER action, rejection is a SYSTEM verdict on the
 * document's content. A person declining a document they uploaded has
 * cancelled it; the system has not judged it unreadable. Recording it as
 * `'rejected'` would now succeed, and would misattribute a human decision to
 * the pipeline. (`tests/unit/aieReviewReject.test.ts` pins both the
 * behaviour and the accuracy of this note.)
 */

import * as repo from '../db/repository';
import { recordAieAuditEvent } from '../audit';

export type RejectRunOutcome = { ok: false; reason: 'not_found' | 'not_eligible' | 'stale_conflict' } | { ok: true };

const REJECTABLE_FROM: readonly string[] = ['unresolved', 'awaiting_acceptance'];

export interface RejectRunDeps {
  getRunForUser: typeof repo.getRunForUser;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  /**
   * M12C (M2-OPEN-1). `transitionRunStatusCas` writes the run's new status
   * and nothing else — it deliberately does NOT write the
   * `aie_processing_transition` audit row, which is why
   * `recordRunTransitionAudit` exists as its separate, intended partner
   * (`lib/aie/db/repository.ts:907`). `lib/aie/review/revalidate.ts:184-185`
   * pairs them; this file did not, so a user declining a document moved the
   * run to a TERMINAL state with no FSM audit trail at all.
   */
  recordRunTransitionAudit: typeof repo.recordRunTransitionAudit;
  updateIntakeStatus: typeof repo.updateIntakeStatus;
  audit: typeof recordAieAuditEvent;
}

export function createDefaultRejectRunDeps(): RejectRunDeps {
  return { getRunForUser: repo.getRunForUser, transitionRunStatusCas: repo.transitionRunStatusCas, recordRunTransitionAudit: repo.recordRunTransitionAudit, updateIntakeStatus: repo.updateIntakeStatus, audit: recordAieAuditEvent };
}

export async function rejectRun(params: { runId: string; userId: string; rationale?: string }, deps: RejectRunDeps = createDefaultRejectRunDeps()): Promise<RejectRunOutcome> {
  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (!REJECTABLE_FROM.includes(run.status)) return { ok: false, reason: 'not_eligible' };

  const moved = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: run.status, toStatus: 'failed_terminal' });
  if (!moved) return { ok: false, reason: 'stale_conflict' };

  // M12C (M2-OPEN-1). Written only AFTER the CAS has been confirmed to have
  // actually moved the row — an audit row for a transition that did not
  // happen is worse than no audit row, because it is believed.
  //
  // `actorType: 'user'`: this edge exists solely because a person clicked
  // "reject". Unlike the machine-driven edges in accept.ts, there is no
  // system decision here at all — the whole function is one human verdict.
  // `actorId` is the authenticated caller (`params.userId`), which is also
  // the run's owner, since `getRunForUser` filters on it.
  //
  // `reason` is a FIXED code, never `params.rationale`. The user's free-text
  // rationale may contain anything they typed, including a PAN or another
  // person's details (AUD-09: record that a rationale was provided, never
  // its content) — the existing `aie_audit_event` below applies the same
  // rule, and this column would otherwise have been a second, unguarded
  // place for that text to land.
  await deps.recordRunTransitionAudit({
    runId: run.id,
    intakeId: run.intakeId,
    userId: run.userId,
    fromState: run.status,
    toState: 'failed_terminal',
    actorType: 'user',
    actorId: params.userId,
    reason: 'user_rejected_document',
  });

  await deps.updateIntakeStatus({ intakeId: run.intakeId, toStatus: 'cancelled' });
  await deps.audit({
    intakeId: run.intakeId,
    runId: run.id,
    userId: run.userId,
    eventType: 'run_failed',
    actorType: 'user',
    actorId: params.userId,
    metadata: { reason: 'user_rejected_document', rationale: params.rationale ? 'provided' : 'none' },
  });
  return { ok: true };
}
