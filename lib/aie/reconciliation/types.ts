/**
 * AIE-1.1 — reconciliation handoff contract (REC-01..12).
 *
 * AIE-1.1 core computes NO domain reconciliation rule itself — "do not call
 * canonical write services in AIE-1.1" and reconciliation logic is
 * adapter-owned (AIE-1.2's holding roll-forward/cash-ledger rules, AIE-1.3's
 * balance/running-balance rules, etc.). This file defines the SHAPE that
 * handoff takes and the one universal rule AIE-1.1 itself enforces:
 * a confidence score can never override a reconciliation outcome (P4).
 */

import type { AieFieldCandidate, AieReconciliationOutcome, AieReconciliationRunResult, AieUnresolvedItemInput } from '../types';

export interface ReconciliationHandoffRequest {
  runId: string;
  candidates: AieFieldCandidate[];
}

export type ReconciliationRule = (req: ReconciliationHandoffRequest) => AieReconciliationRunResult[];

/**
 * AIE-1.1 ships no domain adapter (that is AIE-1.2/1.3/1.4's job). Until one
 * is registered, the orchestrator has nothing domain-specific to reconcile
 * against — this rule records that honestly as NOT_APPLICABLE rather than
 * silently fabricating a PASS. A future adapter replaces this by passing
 * its own `ReconciliationRule` into `runExtractionPipeline`.
 */
export const noDomainAdapterReconciliationRule: ReconciliationRule = () => [
  { ruleId: 'aie1_1_no_domain_adapter_registered', ruleVersion: '1', outcome: 'not_applicable' },
];

/**
 * REC-04: "prevent AI confidence from changing reconciliation status." This
 * function takes ONLY the reconciliation outcomes as its input — there is
 * no `confidence` parameter anywhere in this module's signatures by design,
 * so an adapter cannot accidentally wire a confidence score into the
 * blocking decision even if it wanted to.
 */
export function worstOutcome(results: readonly AieReconciliationRunResult[]): AieReconciliationOutcome {
  const order: AieReconciliationOutcome[] = ['fail', 'indeterminate', 'pass_with_tolerance', 'pass', 'not_applicable'];
  let worstIndex = order.length - 1;
  for (const r of results) {
    const idx = order.indexOf(r.outcome);
    if (idx < worstIndex) worstIndex = idx;
  }
  return order[worstIndex] ?? 'not_applicable';
}

/** P4 / REC-05: a FAIL or INDETERMINATE reconciliation outcome must always
 * produce a blocking unresolved item — never a silent pass-through to
 * awaiting_acceptance. */
export function blockingItemsForReconciliation(results: readonly AieReconciliationRunResult[]): AieUnresolvedItemInput[] {
  return results
    .filter((r) => r.outcome === 'fail' || r.outcome === 'indeterminate')
    .map((r) => ({
      reasonCode: `reconciliation_${r.outcome}:${r.ruleId}`,
      severity: 'blocking',
      displayCandidate: null,
      evidenceRef: { ruleId: r.ruleId, ruleVersion: r.ruleVersion, delta: r.delta ?? null, tolerance: r.tolerance ?? null },
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
    }));
}
