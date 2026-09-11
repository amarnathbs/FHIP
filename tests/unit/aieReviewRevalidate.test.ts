/**
 * AIE-1.5 — dependency-aware revalidation, exercised against the REAL
 * Insurance reconciliation rule (`buildInsuranceReconciliationRule`,
 * merged from `feature/aie-1-4-other-modules`) with fully injected
 * persistence deps (no database) — same `fakeDeps` convention as
 * `tests/unit/aieOrchestrator.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { revalidateRun, resolveReconciliationRuleForAdapter, type RevalidateRunDeps } from '@/lib/aie/review/revalidate';
import type { AieRunRow } from '@/lib/aie/db/repository';
import type { AieFieldCandidate, AieUnresolvedItemInput } from '@/lib/aie/types';

function baseRun(overrides: Partial<AieRunRow> = {}): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString(), ...overrides };
}

function fakeDeps(opts: {
  candidates: AieFieldCandidate[];
  adapterId?: string | null;
  openItems?: { id: string; reasonCode: string; severity: 'blocking' | 'warning'; status: 'open' | 'in_review'; displayCandidate: string | null; evidenceRef: Record<string, unknown> | null; itemVersion: number }[];
}): { deps: RevalidateRunDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { transitions: [], reconciliationRuns: [], created: [], resolved: [] };
  const deps: RevalidateRunDeps = {
    getRunForUser: async () => baseRun(),
    listFieldCandidatesForRun: async () => opts.candidates,
    listLatestCorrectionsForRun: async () => [],
    getAdapterIdForRun: async () => (opts.adapterId === undefined ? 'insurance_generic_schedule_v1' : opts.adapterId),
    listOpenUnresolvedItemsForRun: async () => opts.openItems ?? [],
    recordReconciliationRuns: async (p) => {
      calls.reconciliationRuns.push(p);
    },
    createUnresolvedItems: async (p: { items: AieUnresolvedItemInput[] }) => {
      calls.created.push(p);
      return p.items.map((_, i: number) => `new-item-${i}`);
    },
    resolveItemBySystem: async (p) => {
      calls.resolved.push(p);
      return { ok: true };
    },
    transitionRunStatusCas: async (p) => {
      calls.transitions.push(p);
      return true;
    },
    recordRunTransitionAudit: async () => {},
    audit: async () => {},
  };
  return { deps, calls };
}

const CLEAN_CANDIDATES: AieFieldCandidate[] = [
  { fieldName: 'documentSubClass', valueRaw: 'policy_schedule', isNull: false, sourceMethod: 'deterministic' },
  { fieldName: 'policyName', valueRaw: 'Acme Life', isNull: false, sourceMethod: 'deterministic' },
  { fieldName: 'coverAmount', valueRaw: '500000', isNull: false, sourceMethod: 'deterministic' },
  { fieldName: 'premium', valueRaw: '100', isNull: false, sourceMethod: 'deterministic' },
  { fieldName: 'premiumFrequency', valueRaw: 'monthly', isNull: false, sourceMethod: 'deterministic' },
  { fieldName: 'currencyCode', valueRaw: 'AUD', isNull: false, sourceMethod: 'deterministic' },
];

describe('AIE-1.5 revalidate.ts — resolveReconciliationRuleForAdapter safety property', () => {
  it('returns null (never a fabricated not_applicable pass) for an adapter this pass cannot actually reconcile', () => {
    expect(resolveReconciliationRuleForAdapter('fdh_bank_something')).toBeNull();
    expect(resolveReconciliationRuleForAdapter(null)).toBeNull();
  });
  it('returns the real rule for the one integration-tested adapter', () => {
    expect(resolveReconciliationRuleForAdapter('insurance_generic_schedule_v1')).not.toBeNull();
  });
});

describe('AIE-1.5 revalidate.ts — revalidateRun against the real Insurance rule', () => {
  it('not_found for a run that does not belong to this user', async () => {
    const { deps } = fakeDeps({ candidates: [] });
    deps.getRunForUser = async () => null;
    expect(await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_state when the run is not genuinely unresolved', async () => {
    const { deps } = fakeDeps({ candidates: [] });
    deps.getRunForUser = async () => baseRun({ status: 'awaiting_acceptance' });
    expect(await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps)).toEqual({ ok: false, reason: 'wrong_state' });
  });

  it('SAFETY: never resolves an item for an adapter it cannot reconcile — restores status to unresolved and reports unsupported_adapter', async () => {
    const { deps, calls } = fakeDeps({
      candidates: [],
      adapterId: 'fdh_bank_statement_v1',
      openItems: [{ id: 'item-1', reasonCode: 'fdh_bank_statement_balance_reconciliation', severity: 'blocking', status: 'open', displayCandidate: null, evidenceRef: null, itemVersion: 1 }],
    });
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_adapter' });
    expect(calls.resolved).toHaveLength(0); // the open item was NEVER touched
    expect(calls.created).toHaveLength(0);
    const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
    expect(toStates).toEqual(['reconciling', 'unresolved']); // round-tripped, not stranded
  });

  it('a correction that fixes the only failing rule resolves the open item and moves the run to awaiting_acceptance', async () => {
    const openItems = [{ id: 'item-1', reasonCode: 'reconciliation_fail:insurance_currency_supported', severity: 'blocking' as const, status: 'open' as const, displayCandidate: null, evidenceRef: null, itemVersion: 3 }];
    const correctedCandidates = CLEAN_CANDIDATES.map((c) => c); // currencyCode already AUD/supported here
    const { deps, calls } = fakeDeps({ candidates: correctedCandidates, openItems });
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.runStatus).toBe('awaiting_acceptance');
      expect(outcome.openBlockingItemCount).toBe(0);
      expect(outcome.resolvedItemIds).toEqual(['item-1']);
      expect(outcome.newItemIds).toEqual([]);
    }
    expect(calls.resolved).toHaveLength(1);
    expect((calls.resolved[0] as { decisionType: string }).decisionType).toBe('auto_resolved_by_revalidation');
  });

  it('a rule that STILL fails after the correction leaves the existing open item untouched — no duplicate item created', async () => {
    const stillBadCandidates = CLEAN_CANDIDATES.map((c) => (c.fieldName === 'currencyCode' ? { ...c, valueRaw: 'USD' } : c));
    const openItems = [{ id: 'item-1', reasonCode: 'reconciliation_fail:insurance_currency_supported', severity: 'blocking' as const, status: 'open' as const, displayCandidate: null, evidenceRef: null, itemVersion: 2 }];
    const { deps, calls } = fakeDeps({ candidates: stillBadCandidates, openItems });
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.runStatus).toBe('unresolved');
      expect(outcome.openBlockingItemCount).toBe(1);
    }
    expect(calls.resolved).toHaveLength(0); // untouched — still failing under the SAME outcome
    expect(calls.created).toHaveLength(0); // no duplicate
  });

  it('DEP-11: a rule that changes OUTCOME (fail -> indeterminate) supersedes the old item and creates a new one with lineage', async () => {
    // multi-component detected: insurance_multi_component_not_supported goes
    // straight to 'indeterminate' — simulate an old item that had recorded
    // the SAME rule id under a 'fail' code (a hypothetical prior outcome)
    // to exercise the supersede-with-lineage path distinctly from a brand
    // new conflict.
    const multiComponentCandidates = [...CLEAN_CANDIDATES, { fieldName: 'multiComponentPolicyDetected', valueRaw: 'true', isNull: false, sourceMethod: 'deterministic' as const }];
    const openItems = [{ id: 'item-old', reasonCode: 'reconciliation_fail:insurance_multi_component_not_supported', severity: 'blocking' as const, status: 'open' as const, displayCandidate: null, evidenceRef: null, itemVersion: 1 }];
    const { deps, calls } = fakeDeps({ candidates: multiComponentCandidates, openItems });
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome.ok).toBe(true);
    expect(calls.resolved).toHaveLength(1);
    expect((calls.resolved[0] as { decisionType: string }).decisionType).toBe('superseded_by_revalidation');
    expect(calls.created).toHaveLength(1);
    const createdItems = (calls.created[0] as { items: AieUnresolvedItemInput[] }).items;
    expect(createdItems[0].reasonCode).toBe('reconciliation_indeterminate:insurance_multi_component_not_supported');
    expect(createdItems[0].evidenceRef).toMatchObject({ supersedesItemId: 'item-old' });
  });

  it('a fresh conflict introduced by a correction (no prior open item for that rule) creates a brand-new item without any supersede lineage', async () => {
    const brokenByCorrection = CLEAN_CANDIDATES.map((c) => (c.fieldName === 'currencyCode' ? { ...c, valueRaw: 'GBP' } : c));
    const { deps, calls } = fakeDeps({ candidates: brokenByCorrection, openItems: [] });
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.runStatus).toBe('unresolved');
    expect(calls.created).toHaveLength(1);
    const createdItems = (calls.created[0] as { items: AieUnresolvedItemInput[] }).items;
    expect(createdItems[0].evidenceRef?.supersedesItemId).toBeUndefined();
  });

  it('CONC-01: losing the initial unresolved -> reconciling CAS race reports wrong_state without touching anything else', async () => {
    const { deps, calls } = fakeDeps({ candidates: CLEAN_CANDIDATES });
    let first = true;
    deps.transitionRunStatusCas = async (p) => {
      calls.transitions.push(p);
      if (first) {
        first = false;
        return false;
      }
      return true;
    };
    const outcome = await revalidateRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'wrong_state' });
    expect(calls.reconciliationRuns).toHaveLength(0);
  });
});
