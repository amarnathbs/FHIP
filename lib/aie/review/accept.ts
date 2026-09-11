/**
 * AIE-1.5 — canonical-acceptance gate (AIE15-ACPT-01..12, section 20).
 *
 * ONLY WIRED FOR REAL AGAINST INSURANCE (`acceptAndWriteInsuranceCandidates`,
 * merged from `feature/aie-1-4-other-modules`). Every gate below (blocking
 * items resolved, reconciliation fresh/passing, run status CAS'd, adapter
 * write called, idempotent retry) is the real, generic AIE-1.5 mechanism —
 * only the final "which adapter's write service do I call" step is
 * Insurance-specific, and it is the ONE place a future AIE-1.2/1.3 merge
 * needs to add a branch, not rebuild this gate.
 *
 * Every side effect is injected (`AcceptRunDeps`, matching
 * `lib/aie/orchestrator.ts` / `lib/aie/review/revalidate.ts`'s own
 * established pattern) so this — the single most safety-critical function
 * in AIE-1.5 ("no accept-anyway for material failed/indeterminate
 * reconciliation" MUST be structurally impossible, not merely untested) —
 * is fully unit-testable without a database (see
 * `tests/unit/aieReviewAccept.test.ts`).
 *
 * GATE ORDER (ACPT-02..05, in the order a reviewer should be told "no" in,
 * matching this pass's own insurance write.ts's established order, one
 * level up at the run):
 *   1. Run belongs to the caller (IDOR) — enforced by `getRunForUser`'s own
 *      `.eq('user_id', ...)` filter.
 *   2. Run status is exactly `awaiting_acceptance` (ACPT-05: not stale).
 *   3. Zero items currently blocking acceptance (ACPT-02, re-checked here,
 *      never trusted from a client-supplied summary).
 *   4. The LATEST reconciliation outcome for every rule is
 *      pass/pass_with_tolerance (ACPT-03/ACT-08/12: no confidence input
 *      anywhere in this signature, P4).
 *   5. CAS transition `awaiting_acceptance` -> `accepted` -> `write_pending`
 *      (CONC-01/02: a concurrent accept from another tab loses the race
 *      cleanly rather than double-writing).
 *   6. Call ONLY the domain-owned atomic write service (ACPT-08) — never a
 *      direct table write from this module.
 */

import * as repo from '../db/repository';
import { recordAieAuditEvent } from '../audit';
import { worstOutcome } from '../reconciliation/types';
import { mergeCandidatesWithCorrections } from './candidateMerge';
import { acceptAndWriteInsuranceCandidates, createDefaultAcceptAndWriteInsuranceDeps, type AcceptAndWriteInsuranceDeps, type AcceptAndWriteInsuranceOutcome } from '../adapters/insurance';
import { isAieCanonicalAcceptanceEnabled } from './featureFlags';
import type { Owner as OwnerValue } from '@/lib/constants';

export type AcceptRunOutcome =
  | { ok: false; reason: 'feature_flag_disabled' | 'not_found' | 'not_ready' | 'items_still_blocking' | 'reconciliation_not_fresh' | 'stale_conflict' | 'unsupported_adapter' | 'write_failed'; message?: string }
  | { ok: true; alreadyCompleted: boolean; insurancePolicyId?: string };

export interface AcceptRunParams {
  runId: string;
  userId: string;
  acceptedByUserId: string;
  ownerHouseholdRole: OwnerValue;
  masterItemKey?: string | null;
  notes?: string | null;
  idempotencyKey: string;
}

export interface AcceptRunDeps {
  isCanonicalAcceptanceEnabled: () => boolean;
  getRunForUser: typeof repo.getRunForUser;
  countItemsBlockingAcceptanceForRun: typeof repo.countItemsBlockingAcceptanceForRun;
  latestReconciliationOutcomesForRun: typeof repo.latestReconciliationOutcomesForRun;
  listFieldCandidatesForRun: typeof repo.listFieldCandidatesForRun;
  listLatestCorrectionsForRun: typeof repo.listLatestCorrectionsForRun;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  findOrCreateWriteBatch: typeof repo.findOrCreateWriteBatch;
  markWriteBatchStatus: typeof repo.markWriteBatchStatus;
  audit: typeof recordAieAuditEvent;
  acceptAndWriteInsurance: (input: Parameters<typeof acceptAndWriteInsuranceCandidates>[0], deps: AcceptAndWriteInsuranceDeps) => Promise<AcceptAndWriteInsuranceOutcome>;
  insuranceWriteDeps: AcceptAndWriteInsuranceDeps;
}

export function createDefaultAcceptRunDeps(): AcceptRunDeps {
  return {
    isCanonicalAcceptanceEnabled: isAieCanonicalAcceptanceEnabled,
    getRunForUser: repo.getRunForUser,
    countItemsBlockingAcceptanceForRun: repo.countItemsBlockingAcceptanceForRun,
    latestReconciliationOutcomesForRun: repo.latestReconciliationOutcomesForRun,
    listFieldCandidatesForRun: repo.listFieldCandidatesForRun,
    listLatestCorrectionsForRun: repo.listLatestCorrectionsForRun,
    transitionRunStatusCas: repo.transitionRunStatusCas,
    findOrCreateWriteBatch: repo.findOrCreateWriteBatch,
    markWriteBatchStatus: repo.markWriteBatchStatus,
    audit: recordAieAuditEvent,
    acceptAndWriteInsurance: acceptAndWriteInsuranceCandidates,
    insuranceWriteDeps: createDefaultAcceptAndWriteInsuranceDeps(),
  };
}

export async function acceptRun(params: AcceptRunParams, deps: AcceptRunDeps = createDefaultAcceptRunDeps()): Promise<AcceptRunOutcome> {
  if (!deps.isCanonicalAcceptanceEnabled()) return { ok: false, reason: 'feature_flag_disabled' };

  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };

  // Idempotent replay: already fully completed — do not attempt a second
  // CAS/write (ACPT-11/FAIL-04/10).
  if (run.status === 'completed') return { ok: true, alreadyCompleted: true };
  if (run.status !== 'awaiting_acceptance') {
    // 'accepted' / 'write_pending' means an earlier attempt is (or was)
    // mid-flight — never re-run acceptance concurrently with itself.
    return { ok: false, reason: 'not_ready' };
  }

  const [blockingCount, reconciliationOutcomes] = await Promise.all([deps.countItemsBlockingAcceptanceForRun(run.id), deps.latestReconciliationOutcomesForRun(run.id)]);
  if (blockingCount > 0) return { ok: false, reason: 'items_still_blocking' };

  const worst = worstOutcome(reconciliationOutcomes.map((r) => ({ ruleId: r.ruleId, ruleVersion: '1', outcome: r.outcome })));
  if (worst === 'fail' || worst === 'indeterminate') return { ok: false, reason: 'reconciliation_not_fresh' };
  // `not_applicable` (no domain adapter registered at all, or nothing to
  // reconcile) is deliberately NOT treated as a pass here — accepting a
  // document nothing ever actually checked would be exactly the silent
  // "schema-valid but never verified" gap AIE-1.6's own NO-GO criteria
  // warn about. Only a genuine pass/pass_with_tolerance may proceed.
  if (worst === 'not_applicable') return { ok: false, reason: 'reconciliation_not_fresh' };

  const movedToAccepted = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'awaiting_acceptance', toStatus: 'accepted' });
  if (!movedToAccepted) return { ok: false, reason: 'stale_conflict' };
  await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_transition', actorType: 'user', actorId: params.acceptedByUserId, metadata: { toState: 'accepted' } });

  const movedToWritePending = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'accepted', toStatus: 'write_pending' });
  if (!movedToWritePending) return { ok: false, reason: 'stale_conflict' };

  const batch = await deps.findOrCreateWriteBatch({ runId: run.id, intakeId: run.intakeId, userId: run.userId, targetModule: 'other', idempotencyKey: params.idempotencyKey });
  if (batch.status === 'committed') {
    // Idempotent replay after a previous call already committed the write
    // but the client never saw the response (FAIL-10).
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
    return { ok: true, alreadyCompleted: true };
  }

  const [originalCandidates, corrections] = await Promise.all([deps.listFieldCandidatesForRun(run.id), deps.listLatestCorrectionsForRun(run.id)]);
  const mergedCandidates = mergeCandidatesWithCorrections(originalCandidates, corrections);

  // Only Insurance is wired to a real write service this pass — see this
  // file's header.
  const write = await deps.acceptAndWriteInsurance(
    {
      aieIntakeId: run.intakeId,
      aieRunId: run.id,
      userId: run.userId,
      ownerHouseholdRole: params.ownerHouseholdRole,
      candidates: mergedCandidates,
      acceptedByUserId: params.acceptedByUserId,
      reconciliationOutcome: worst,
      hasOpenBlockingUnresolvedItems: false, // already proven false above, re-asserted structurally rather than re-derived
      masterItemKey: params.masterItemKey ?? null,
      notes: params.notes ?? null,
    },
    deps.insuranceWriteDeps,
  );

  if (!write.ok && write.reason === 'already_written') {
    await deps.markWriteBatchStatus(batch.id, 'committed');
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
    return { ok: true, alreadyCompleted: true, insurancePolicyId: write.insurancePolicyId };
  }
  if (!write.ok) {
    await deps.markWriteBatchStatus(batch.id, 'failed');
    // Retryable vs terminal: a feature-flag/gate failure or schema
    // rejection is a genuine domain rejection (FAIL-01: terminal, do not
    // silently retry into the same wall); anything DB/network-shaped is
    // treated as retryable so a future retry with the SAME idempotency key
    // can still succeed without duplicating.
    const terminal = write.reason === 'feature_flag_disabled' || write.reason === 'reconciliation_not_passed' || write.reason === 'unresolved_items_open' || write.reason === 'schema_validation_failed';
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: terminal ? 'failed_terminal' : 'failed_retryable' });
    await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_failed', actorType: 'system', metadata: { reason: write.reason } });
    return { ok: false, reason: 'write_failed', message: write.reason };
  }

  await deps.markWriteBatchStatus(batch.id, 'committed');
  const movedToCompleted = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'write_pending', toStatus: 'completed' });
  await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'run_completed', actorType: 'user', actorId: params.acceptedByUserId, metadata: { insurancePolicyId: write.insurancePolicyId } });
  if (!movedToCompleted) {
    // The write itself unquestionably succeeded (we have a real
    // insurancePolicyId) — a lost final-transition race must never be
    // reported as failure (FAIL-02: "never report completion before domain
    // transaction commits" cuts both ways: never report FAILURE after it
    // already committed, either).
    return { ok: true, alreadyCompleted: true, insurancePolicyId: write.insurancePolicyId };
  }
  return { ok: true, alreadyCompleted: false, insurancePolicyId: write.insurancePolicyId };
}
