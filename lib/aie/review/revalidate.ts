/**
 * AIE-1.5 — dependency-aware revalidation (AIE15-DEP-01/10/11/12,
 * VALID-10/11): correcting a field must re-run the relevant deterministic
 * reconciliation before an item can be marked resolved, must never let a
 * value be accepted "merely because it makes reconciliation balance"
 * (VALID-07 — this module does not know or care what value was corrected,
 * it just reruns the SAME real reconciliation rule the original run used),
 * and must create a NEW unresolved item (with lineage back to the one it
 * supersedes) if a correction produces a new material conflict rather than
 * silently resolving the old one and hiding the new one (VALID-11).
 *
 * ONLY WIRED FOR REAL AGAINST INSURANCE. `resolveReconciliationRuleForRun`
 * below honestly returns AIE-1.1 core's own
 * `noDomainAdapterReconciliationRule` (NOT_APPLICABLE) for any adapter this
 * pass does not have the actual reconciliation code for (Investment
 * Intelligence / FDH bank both live on unmerged sibling branches — see
 * AIE_1_5_IMPLEMENTATION.md section 1) — it never fabricates a PASS for an
 * adapter it cannot actually re-check, which would be a far worse defect
 * than an honest "cannot revalidate this yet."
 */

import { buildInsuranceReconciliationRule } from '../adapters/insurance';
import { blockingItemsForReconciliation, worstOutcome, type ReconciliationRule } from '../reconciliation/types';
import type { AieReconciliationOutcome, AieReconciliationRunResult, AieUnresolvedItemInput } from '../types';
import * as repo from '../db/repository';
import { recordAieAuditEvent } from '../audit';
import { mergeCandidatesWithCorrections } from './candidateMerge';
import { stripCoreReconciliationPrefix } from './reasonCodes';

/**
 * Returns `null` — deliberately, NOT `noDomainAdapterReconciliationRule` —
 * for any adapter this pass cannot actually re-check. This is a real
 * safety property, not a stylistic choice: `noDomainAdapterReconciliationRule`
 * always reports `not_applicable`, which `blockingItemsForReconciliation`
 * never turns into a blocking item — if `revalidateRun` used it here for an
 * adapter it cannot genuinely reconcile (Investment Intelligence / FDH bank,
 * both design-only this pass), a correction on one of THEIR items would
 * silently manufacture a zero-blocking-item result and wrongly move the run
 * to `awaiting_acceptance`, without ever having re-run the real check that
 * created the item in the first place. `revalidateRun` treats `null` as
 * "cannot safely revalidate" and refuses rather than guessing.
 */
export function resolveReconciliationRuleForAdapter(adapterId: string | null): ReconciliationRule | null {
  if (adapterId === 'insurance_generic_schedule_v1') return buildInsuranceReconciliationRule();
  return null;
}

export interface RevalidateRunDeps {
  getRunForUser: typeof repo.getRunForUser;
  listFieldCandidatesForRun: typeof repo.listFieldCandidatesForRun;
  listLatestCorrectionsForRun: typeof repo.listLatestCorrectionsForRun;
  getAdapterIdForRun: typeof repo.getAdapterIdForRun;
  listOpenUnresolvedItemsForRun: typeof repo.listOpenUnresolvedItemsForRun;
  recordReconciliationRuns: typeof repo.recordReconciliationRuns;
  createUnresolvedItems: typeof repo.createUnresolvedItems;
  resolveItemBySystem: typeof repo.resolveItemBySystem;
  transitionRunStatusCas: typeof repo.transitionRunStatusCas;
  recordRunTransitionAudit: typeof repo.recordRunTransitionAudit;
  audit: typeof recordAieAuditEvent;
}

export function createDefaultRevalidateRunDeps(): RevalidateRunDeps {
  return {
    getRunForUser: repo.getRunForUser,
    listFieldCandidatesForRun: repo.listFieldCandidatesForRun,
    listLatestCorrectionsForRun: repo.listLatestCorrectionsForRun,
    getAdapterIdForRun: repo.getAdapterIdForRun,
    listOpenUnresolvedItemsForRun: repo.listOpenUnresolvedItemsForRun,
    recordReconciliationRuns: repo.recordReconciliationRuns,
    createUnresolvedItems: repo.createUnresolvedItems,
    resolveItemBySystem: repo.resolveItemBySystem,
    transitionRunStatusCas: repo.transitionRunStatusCas,
    recordRunTransitionAudit: repo.recordRunTransitionAudit,
    audit: recordAieAuditEvent,
  };
}

export type RevalidateOutcome =
  | { ok: false; reason: 'not_found' | 'wrong_state' | 'unsupported_adapter' }
  | { ok: true; worstOutcome: AieReconciliationOutcome; openBlockingItemCount: number; runStatus: 'unresolved' | 'awaiting_acceptance'; newItemIds: string[]; resolvedItemIds: string[] };

/**
 * Re-runs the owning adapter's reconciliation rule against the CURRENT
 * merged candidate set (original candidates + latest accepted
 * corrections), then reconciles the open unresolved-item set against the
 * new results:
 *   - an open item whose rule no longer fails/is indeterminate is marked
 *     `resolved` by the system (DEP-10/12);
 *   - a rule that still fails/is indeterminate AND has no corresponding
 *     open item (a freshly-introduced or still-unaddressed conflict) gets
 *     a NEW item, evidence-linked back to any item it supersedes
 *     (DEP-11 — lineage, never silent deletion).
 * Only callable while the run is genuinely `unresolved` — a run already
 * `awaiting_acceptance` has nothing open left to recheck, and any other
 * state means a correction was submitted somewhere it should have been
 * structurally impossible to submit one (defensive `wrong_state`, not a
 * silent no-op).
 */
export async function revalidateRun(params: { runId: string; userId: string }, deps: RevalidateRunDeps = createDefaultRevalidateRunDeps()): Promise<RevalidateOutcome> {
  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (run.status !== 'unresolved') return { ok: false, reason: 'wrong_state' };

  const movedToReconciling = await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'unresolved', toStatus: 'reconciling' });
  if (!movedToReconciling) return { ok: false, reason: 'wrong_state' }; // lost a race with a concurrent revalidation/reprocess

  const [originalCandidates, corrections, adapterId, openItems] = await Promise.all([
    deps.listFieldCandidatesForRun(run.id),
    deps.listLatestCorrectionsForRun(run.id),
    deps.getAdapterIdForRun(run.id),
    deps.listOpenUnresolvedItemsForRun(run.id),
  ]);

  const rule = resolveReconciliationRuleForAdapter(adapterId);
  if (!rule) {
    // Restore exactly the state this run was in before this call — never
    // leave it stranded in 'reconciling', and never fabricate a result for
    // an adapter this pass cannot actually re-check (see
    // resolveReconciliationRuleForAdapter's own header).
    await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'reconciling', toStatus: 'unresolved' });
    return { ok: false, reason: 'unsupported_adapter' };
  }

  const mergedCandidates = mergeCandidatesWithCorrections(originalCandidates, corrections);
  const results: AieReconciliationRunResult[] = rule({ runId: run.id, candidates: mergedCandidates });
  await deps.recordReconciliationRuns({ runId: run.id, intakeId: run.intakeId, userId: run.userId, results });

  const newBlockingItems: AieUnresolvedItemInput[] = blockingItemsForReconciliation(results);
  const newBlockingReasonCodes = new Set(newBlockingItems.map((i) => i.reasonCode));
  // Reason codes embed the OUTCOME (`reconciliation_fail:<ruleId>` vs.
  // `reconciliation_indeterminate:<ruleId>`) as well as the rule id — a
  // rule flipping from fail to indeterminate (or vice versa) is a
  // materially different finding even though it is "the same rule", so it
  // is tracked separately from a rule that disappeared entirely (DEP-11:
  // supersede with lineage rather than silently mutate in place).
  const newBlockingRuleIds = new Set(newBlockingItems.map((i) => stripCoreReconciliationPrefix(i.reasonCode)));

  const resolvedItemIds: string[] = [];
  const stillOpenReasonCodes = new Set<string>();
  const supersededItemIdByRuleId = new Map<string, string>();
  for (const item of openItems) {
    if (newBlockingReasonCodes.has(item.reasonCode)) {
      stillOpenReasonCodes.add(item.reasonCode);
      continue;
    }
    const ruleId = stripCoreReconciliationPrefix(item.reasonCode);
    const ruleStillFailingUnderDifferentOutcome = newBlockingRuleIds.has(ruleId);
    const resolution = await deps.resolveItemBySystem({
      itemId: item.id,
      intakeId: run.intakeId,
      userId: run.userId,
      expectedItemVersion: item.itemVersion,
      decisionType: ruleStillFailingUnderDifferentOutcome ? 'superseded_by_revalidation' : 'auto_resolved_by_revalidation',
      idempotencyKey: `${run.id}:revalidate-resolve:${item.id}:${item.itemVersion}`,
      rationale: ruleStillFailingUnderDifferentOutcome
        ? 'Superseded — the same underlying check now reports a different outcome after correction.'
        : 'Deterministic recheck after correction no longer reproduces this condition.',
    });
    if (resolution.ok) {
      resolvedItemIds.push(item.id);
      if (ruleStillFailingUnderDifferentOutcome) supersededItemIdByRuleId.set(ruleId, item.id);
    }
    // A stale_conflict here means someone/something else already moved this
    // item since we listed it (CONC-06/07) — leave it exactly as it is
    // rather than forcing a second, conflicting write; the next
    // revalidation pass (or the item's own decision endpoint) will see its
    // true current state.
  }

  const itemsToCreate: AieUnresolvedItemInput[] = newBlockingItems
    .filter((i) => !stillOpenReasonCodes.has(i.reasonCode))
    .map((i) => {
      const supersedes = supersededItemIdByRuleId.get(stripCoreReconciliationPrefix(i.reasonCode));
      return supersedes ? { ...i, evidenceRef: { ...(i.evidenceRef ?? {}), supersedesItemId: supersedes } } : i;
    });
  let newItemIds: string[] = [];
  if (itemsToCreate.length > 0) {
    newItemIds = await deps.createUnresolvedItems({ runId: run.id, intakeId: run.intakeId, userId: run.userId, items: itemsToCreate });
    await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'unresolved_item_created', actorType: 'system', metadata: { count: itemsToCreate.length, trigger: 'revalidation' } });
  }

  const openBlockingItemCount = stillOpenReasonCodes.size + itemsToCreate.filter((i) => i.severity === 'blocking').length;
  const finalStatus = openBlockingItemCount > 0 ? 'unresolved' : 'awaiting_acceptance';
  await deps.transitionRunStatusCas({ runId: run.id, fromStatus: 'reconciling', toStatus: finalStatus });
  await deps.recordRunTransitionAudit({ runId: run.id, intakeId: run.intakeId, userId: run.userId, fromState: 'reconciling', toState: finalStatus, actorType: 'system', reason: 'post_correction_revalidation' });

  return {
    ok: true,
    worstOutcome: worstOutcome(results),
    openBlockingItemCount,
    runStatus: finalStatus,
    newItemIds,
    resolvedItemIds,
  };
}
