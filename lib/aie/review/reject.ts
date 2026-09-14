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
 * (`lib/aie/stateMachine.ts`'s `AIE_INTAKE_TRANSITIONS`) — and `'ready'`'s
 * only legal onward transitions are `['cancelled', 'deleted']`, NOT
 * `'rejected'` (that status is reserved for an ADMISSION-time content
 * rejection, before a run ever exists). This function therefore moves the
 * intake to `'cancelled'` (a legal transition), never attempts an illegal
 * `'rejected'` transition, and reports the user-facing outcome as
 * "declined" — the state machine's own vocabulary is honoured exactly as
 * `assertIntakeTransition` enforces it, not worked around.
 */

import * as repo from '../db/repository';
import { recordAieAuditEvent } from '../audit';

export type RejectRunOutcome = { ok: false; reason: 'not_found' | 'not_eligible' | 'stale_conflict' } | { ok: true };

const REJECTABLE_FROM: readonly string[] = ['unresolved', 'awaiting_acceptance'];

export interface RejectRunDeps {
  getRunForUser: typeof repo.getRunForUser;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  updateIntakeStatus: typeof repo.updateIntakeStatus;
  audit: typeof recordAieAuditEvent;
}

export function createDefaultRejectRunDeps(): RejectRunDeps {
  return { getRunForUser: repo.getRunForUser, transitionRunStatusCas: repo.transitionRunStatusCas, updateIntakeStatus: repo.updateIntakeStatus, audit: recordAieAuditEvent };
}

export async function rejectRun(params: { runId: string; userId: string; rationale?: string }, deps: RejectRunDeps = createDefaultRejectRunDeps()): Promise<RejectRunOutcome> {
  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (!REJECTABLE_FROM.includes(run.status)) return { ok: false, reason: 'not_eligible' };

  const moved = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: run.status, toStatus: 'failed_terminal' });
  if (!moved) return { ok: false, reason: 'stale_conflict' };

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
