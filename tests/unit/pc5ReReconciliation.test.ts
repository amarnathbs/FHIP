/**
 * PC5 (M4) — K.19: every decision that changes owner, duplicate status,
 * correction or statement interpretation triggers the appropriate
 * reconciliation rerun.
 *
 * WHAT WAS BROKEN BEFORE THIS, and is asserted fixed here: AIE's own
 * `resolveReconciliationRuleForAdapter` returns `null` for Investment
 * Intelligence, so `revalidateRun` answered `unsupported_adapter` for every
 * II item and left its run in `unresolved` permanently — the only other
 * exit being `rejectRun`. An II document that needed any decision could
 * therefore only ever be thrown away.
 *
 * Fully injected deps: no database, no clock dependence, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAccountOverrides,
  reReconcileInvestmentRun,
  type Pc5ReReconcileDeps,
} from '@/lib/pc5/reReconciliation';
import { resolveReconciliationRuleForAdapter } from '@/lib/aie/review/revalidate';
import { II_ADAPTER_ID } from '@/lib/aie/adapters/investment-intelligence';
import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { toAieCandidates } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { matchAccountsReadOnly } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';
import type { AccountMatchOutcome } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import type { AieRunRow, AieUnresolvedItemFullRow } from '@/lib/aie/db/repository';
import type { AieFieldCandidate } from '@/lib/aie/types';

describe('PC5 K.19 — the gap this closes is real and still open in AIE core', () => {
  it('AIE\'s own revalidate resolver still returns null for Investment Intelligence — PC5 does not paper over it, it supplies the missing half', () => {
    expect(resolveReconciliationRuleForAdapter(II_ADAPTER_ID)).toBeNull();
    // ...and still returns the real rule for the one adapter it does cover,
    // so PC5 has changed nothing about the insurance path.
    expect(resolveReconciliationRuleForAdapter('insurance_generic_schedule_v1')).not.toBeNull();
  });
});

describe('PC5 K.19 — applyAccountOverrides', () => {
  const ambiguous: AccountMatchOutcome = {
    kind: 'ambiguous',
    key: '1122334455|Prime Mutual Fund',
    folioNumber: '1122334455',
    amcName: 'Prime Mutual Fund',
    candidateAccountIds: ['acc-1', 'acc-2'],
  };

  it('resolves an ambiguity onto a candidate the matcher itself produced', () => {
    const result = applyAccountOverrides([ambiguous], { '1122334455|Prime Mutual Fund': 'acc-2' });
    expect(result[0]).toEqual({ kind: 'resolved', key: ambiguous.key, folioNumber: '1122334455', amcName: 'Prime Mutual Fund', accountId: 'acc-2' });
  });

  it('IGNORES an id outside the candidate set — a user cannot attach a statement to an arbitrary account', () => {
    const result = applyAccountOverrides([ambiguous], { '1122334455|Prime Mutual Fund': 'acc-999' });
    expect(result[0].kind).toBe('ambiguous');
  });

  it('IGNORES an override for a key that is not ambiguous', () => {
    const resolved: AccountMatchOutcome = { kind: 'resolved', key: 'k', folioNumber: 'f', amcName: 'a', accountId: 'acc-1' };
    expect(applyAccountOverrides([resolved], { k: 'acc-2' })[0]).toEqual(resolved);
  });

  it('is a no-op with no overrides', () => {
    expect(applyAccountOverrides([ambiguous], undefined)).toEqual([ambiguous]);
    expect(applyAccountOverrides([ambiguous], {})).toEqual([ambiguous]);
  });
});

// ---------------------------------------------------------------------------
// The full pass, with every side effect injected.
// ---------------------------------------------------------------------------

function fixtureCandidates(): AieFieldCandidate[] {
  const text = buildAieIiCasFixtureText({ holderName: 'Anil Sharma', holdingMode: 'SI' });
  const detection = detectSource(text);
  return toAieCandidates(parseDocumentWithParser(detection.parser!, text));
}

function baseRun(overrides: Partial<AieRunRow> = {}): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString(), ...overrides };
}

function fullItem(overrides: Partial<AieUnresolvedItemFullRow> = {}): AieUnresolvedItemFullRow {
  return {
    id: 'item-1',
    runId: 'run-1',
    intakeId: 'intake-1',
    userId: 'user-1',
    reasonCode: 'ii_adapter:owner_unresolved',
    severity: 'blocking',
    status: 'open',
    displayCandidate: null,
    evidenceRef: null,
    permittedActionTypes: ['choose_value', 'reject_document'],
    itemVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Calls {
  transitions: { fromStatus: string; toStatus: string }[];
  reconciliationRuns: { results: { ruleId: string; outcome: string }[] }[];
  created: { items: { reasonCode: string; severity: string }[] }[];
  resolved: { itemId: string; decisionType: string }[];
}

function fakeDeps(opts: {
  candidates?: AieFieldCandidate[];
  run?: AieRunRow;
  adapterId?: string | null;
  openItems?: AieUnresolvedItemFullRow[];
  priorOutcomes?: { ruleId: string; outcome: string }[];
  casSucceeds?: boolean;
  accountOutcomes?: AccountMatchOutcome[];
}): { deps: Pc5ReReconcileDeps; calls: Calls } {
  const calls: Calls = { transitions: [], reconciliationRuns: [], created: [], resolved: [] };
  const deps = {
    getRunForUser: async () => opts.run ?? baseRun(),
    getAdapterIdForRun: async () => (opts.adapterId === undefined ? II_ADAPTER_ID : opts.adapterId),
    listFieldCandidatesForRun: async () => opts.candidates ?? fixtureCandidates(),
    listUnresolvedItemsForRunPc5: async () => opts.openItems ?? [],
    latestReconciliationOutcomesForRun: async () => opts.priorOutcomes ?? [],
    transitionRunStatusCas: async (p: { fromStatus: string; toStatus: string }) => {
      calls.transitions.push(p);
      return opts.casSucceeds ?? true;
    },
    recordReconciliationRuns: async (p: { results: { ruleId: string; outcome: string }[] }) => {
      calls.reconciliationRuns.push(p);
    },
    resolveItemBySystem: async (p: { itemId: string; decisionType: string }) => {
      calls.resolved.push(p);
      return { ok: true as const, decisionId: `d-${calls.resolved.length}`, replayed: false };
    },
    createUnresolvedItems: async (p: { items: { reasonCode: string; severity: string }[] }) => {
      calls.created.push(p);
      return p.items.map((_, i) => `new-item-${i}`);
    },
    recordRunTransitionAudit: async () => {},
    // The REAL matcher runs, so `plan` is a genuine
    // `planFolioAccountResolution` result and the reconciliation rule's own
    // `plan.resolveRowKey(...)` lookups work exactly as they do in
    // production. Only the OUTCOMES are substituted, which is precisely
    // what `applyAccountOverrides` does on the real path too — the shape
    // under test stays real, the scenario is what is injected.
    buildContext: async (p: { parsed: Parameters<typeof matchAccountsReadOnly>[0] }) => {
      const realMatches = matchAccountsReadOnly(p.parsed, []);
      const outcomes = opts.accountOutcomes ?? realMatches.outcomes;
      return {
        sourceKey: 'cams',
        countryCode: 'IN',
        accountMatches: {
          plan: realMatches.plan,
          outcomes,
          byKey: new Map(outcomes.map((o) => [o.key, o])),
        },
        instrumentMatches: new Map(),
        existingFingerprints: new Set<string>(),
        existingSnapshots: new Map(),
        existingTransactionsForPosition: new Map(),
        existingAccountCurrency: new Map(),
        config: DEFAULT_RECONCILIATION_CONFIG,
      };
    },
    loadHouseholdMembers: async () => [{ id: 'm1', fullName: 'Anil Sharma', relationship: 'self', isActive: true }],
    audit: async () => {},
    iiAudit: async () => ({ error: null }),
  } as unknown as Pc5ReReconcileDeps;

  return { deps, calls };
}

describe('PC5 K.19 — reReconcileInvestmentRun refusals', () => {
  it('not_found for a run that does not belong to this user', async () => {
    const { deps } = fakeDeps({});
    deps.getRunForUser = (async () => null) as typeof deps.getRunForUser;
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_state for a run that is not genuinely unresolved — never races the acceptance gate', async () => {
    const { deps, calls } = fakeDeps({ run: baseRun({ status: 'awaiting_acceptance' }) });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'wrong_state' });
    expect(calls.transitions).toHaveLength(0);
  });

  it('unsupported_adapter for a run produced by a different adapter', async () => {
    const { deps, calls } = fakeDeps({ adapterId: 'insurance_generic_schedule_v1' });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'unsupported_adapter' });
    // Refused BEFORE the CAS lock, so nothing is stranded in `reconciling`.
    expect(calls.transitions).toHaveLength(0);
  });

  it('no_candidates when the run has no recorded evidence to reconcile against', async () => {
    const { deps } = fakeDeps({ candidates: [] });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'no_candidates' });
  });

  it('evidence_unavailable when the candidates cannot be rehydrated — never a vacuously clean pass', async () => {
    const { deps, calls } = fakeDeps({
      candidates: [{ fieldName: 'unrelated', valueRaw: 'x', isNull: false, sourceMethod: 'deterministic' }],
    });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'evidence_unavailable' });
    expect(calls.transitions).toHaveLength(0);
  });

  it('lost_race when a concurrent pass already took the run into reconciling — K.22 concurrent idempotency', async () => {
    const { deps } = fakeDeps({ casSucceeds: false });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'lost_race' });
  });
});

describe('PC5 K.19 — reReconcileInvestmentRun happy paths', () => {
  it('a resolved owner clears the owner_unresolved item and moves the run to awaiting_acceptance', async () => {
    const { deps, calls } = fakeDeps({ openItems: [fullItem()] });
    const outcome = await reReconcileInvestmentRun(
      { runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runStatus).toBe('awaiting_acceptance');
    expect(outcome.openBlockingItemCount).toBe(0);
    expect(outcome.resolvedItemIds).toEqual(['item-1']);
    expect(calls.resolved[0].decisionType).toBe('auto_resolved_by_revalidation');
    // Routed through `reconciling` in BOTH directions — the FSM has no
    // direct edge either way.
    expect(calls.transitions.map((t) => t.toStatus)).toEqual(['reconciling', 'awaiting_acceptance']);
  });

  it('NO owner chosen leaves the owner_unresolved item standing and the run unresolved', async () => {
    const accountOutcomes: AccountMatchOutcome[] = [
      { kind: 'resolved', key: 'k1', folioNumber: '1122334455', amcName: 'Prime Mutual Fund', accountId: 'acc-1' },
    ];
    const { deps, calls } = fakeDeps({ openItems: [fullItem()], accountOutcomes });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: null } }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runStatus).toBe('unresolved');
    expect(outcome.openBlockingItemCount).toBe(1);
    // Still open under the SAME reason code — never resolved-and-recreated,
    // which would churn the item id the user is looking at.
    expect(calls.resolved).toHaveLength(0);
    expect(calls.created).toHaveLength(0);
  });

  it('a JOINT statement still blocks even after an owner is chosen — one person cannot assert sole ownership of a jointly-held folio', async () => {
    const text = buildAieIiCasFixtureText({ holderName: 'Anil Sharma', holdingMode: 'JO' });
    const detection = detectSource(text);
    const candidates = toAieCandidates(parseDocumentWithParser(detection.parser!, text));
    const { deps, calls } = fakeDeps({ candidates, openItems: [] });
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runStatus).toBe('unresolved');
    expect(calls.created[0].items.some((i) => i.reasonCode === 'ii_adapter:owner_joint_allocation_required')).toBe(true);
  });

  it('records identity findings as reconciliation rows too, so the acceptance gate\'s two signals stay consistent', async () => {
    const accountOutcomes: AccountMatchOutcome[] = [
      { kind: 'ambiguous', key: 'k1', folioNumber: '1122334455', amcName: 'Prime Mutual Fund', candidateAccountIds: ['acc-1', 'acc-2'] },
    ];
    const { deps, calls } = fakeDeps({ accountOutcomes });
    await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } }, deps);
    const recorded = calls.reconciliationRuns.flatMap((r) => r.results);
    const mirror = recorded.find((r) => r.ruleId === 'ii_adapter_identity:ii_adapter:ambiguous_account');
    expect(mirror).toBeDefined();
    expect(mirror!.outcome).toBe('fail');
  });

  it('a chosen account CLEARS the ambiguity and no identity mirror is recorded as failing for it', async () => {
    const accountOutcomes: AccountMatchOutcome[] = [
      { kind: 'ambiguous', key: 'k1', folioNumber: '1122334455', amcName: 'Prime Mutual Fund', candidateAccountIds: ['acc-1', 'acc-2'] },
    ];
    const { deps, calls } = fakeDeps({ accountOutcomes });
    await reReconcileInvestmentRun(
      { runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1', resolvedAccountIdByKey: { k1: 'acc-2' } } },
      deps,
    );
    const recorded = calls.reconciliationRuns.flatMap((r) => r.results);
    const stillFailing = recorded.filter((r) => r.ruleId === 'ii_adapter_identity:ii_adapter:ambiguous_account' && r.outcome === 'fail');
    expect(stillFailing).toHaveLength(0);
  });

  it('K.10 "separate genuine events" SUPPRESSES the overlap finding rather than rewriting it to pass', async () => {
    const { deps, calls } = fakeDeps({});
    await reReconcileInvestmentRun(
      { runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1', duplicateResolution: 'separate_genuine_events' } },
      deps,
    );
    const recorded = calls.reconciliationRuns.flatMap((r) => r.results);
    // Absent entirely — not present-with-outcome-pass. A suppressed check
    // and a passed check are different facts.
    expect(recorded.some((r) => r.ruleId.startsWith('ii_adapter_duplicate_overlap'))).toBe(false);
  });

  it('CRITICAL: an identity rule that PREVIOUSLY failed and now passes is re-recorded as `pass`, not merely omitted', async () => {
    // `latestReconciliationOutcomesForRun` keeps the LATEST row per rule id.
    // A previously-failing identity rule that is simply absent from this
    // pass would keep its stale `fail` forever, and the acceptance gate
    // would refuse the run for a condition that no longer exists — the
    // exact trap this branch exists to avoid.
    const { deps, calls } = fakeDeps({
      priorOutcomes: [
        { ruleId: 'ii_adapter_identity:ii_adapter:owner_unresolved', outcome: 'fail' },
        { ruleId: 'ii_adapter_roll_forward:acc-1:inst-1', outcome: 'fail' },
      ],
    });
    await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } }, deps);
    const recorded = calls.reconciliationRuns.flatMap((r) => r.results);
    const cleared = recorded.find((r) => r.ruleId === 'ii_adapter_identity:ii_adapter:owner_unresolved');
    expect(cleared, 'the cleared identity rule must be re-recorded').toBeDefined();
    expect(cleared!.outcome).toBe('pass');
    // A NON-identity prior failure is NOT cleared here — only the
    // arithmetic rule itself may clear its own finding, and silently
    // passing someone else's rule would be far worse than leaving it.
    expect(recorded.some((r) => r.ruleId === 'ii_adapter_roll_forward:acc-1:inst-1' && r.outcome === 'pass')).toBe(false);
  });

  it('an identity rule that is STILL failing is not also re-recorded as passing', async () => {
    // No owner chosen -> owner_unresolved still fires. `owner_unresolved`
    // needs at least one matched account to be raised at all, hence the
    // resolved outcome below.
    const accountOutcomes: AccountMatchOutcome[] = [
      { kind: 'resolved', key: 'k1', folioNumber: '1122334455', amcName: 'Prime Mutual Fund', accountId: 'acc-1' },
    ];
    const { deps, calls } = fakeDeps({
      priorOutcomes: [{ ruleId: 'ii_adapter_identity:ii_adapter:owner_unresolved', outcome: 'fail' }],
      accountOutcomes,
    });
    await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: null } }, deps);
    const recorded = calls.reconciliationRuns.flatMap((r) => r.results);
    const rows = recorded.filter((r) => r.ruleId === 'ii_adapter_identity:ii_adapter:owner_unresolved');
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('fail');
  });

  it('REGRESSION (found live): a FAILED resolution still counts as blocking — the run must not be reported ready while the item is open', async () => {
    // Before the fix, the blocking count came from what this pass INTENDED
    // (`stillOpenReasonCodes` + items about to be created) and never from
    // what it achieved. A `resolveItemBySystem` failure therefore left the
    // item open in the database while the pass counted it as gone and moved
    // the run to `awaiting_acceptance`. Nothing unsafe could follow —
    // `accept.ts` re-derives the count — but the stored run status
    // contradicted the stored item set, which is the exact trap M3 fixed in
    // `dispatch.ts`. The live-DEV matrix caught it recurring here (S-26).
    const { deps, calls } = fakeDeps({ openItems: [fullItem()] });
    deps.resolveItemBySystem = (async () => ({ ok: false as const, reason: 'db_error' as const })) as typeof deps.resolveItemBySystem;

    const outcome = await reReconcileInvestmentRun(
      { runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolvedItemIds).toEqual([]);
    expect(outcome.failedResolutionItemIds).toEqual(['item-1']);
    expect(outcome.openBlockingItemCount).toBe(1);
    expect(outcome.runStatus).toBe('unresolved');
    // And the run row is moved to match what was reported, not to
    // `awaiting_acceptance`.
    expect(calls.transitions.map((t) => t.toStatus)).toEqual(['reconciling', 'unresolved']);
  });

  it('a WARNING item that fails to resolve does NOT inflate the blocking count', async () => {
    const { deps } = fakeDeps({ openItems: [fullItem({ severity: 'warning' })] });
    deps.resolveItemBySystem = (async () => ({ ok: false as const, reason: 'db_error' as const })) as typeof deps.resolveItemBySystem;
    const outcome = await reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: { ownerMemberId: 'm1' } }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.openBlockingItemCount).toBe(0);
    expect(outcome.failedResolutionItemIds).toEqual([]);
    expect(outcome.runStatus).toBe('awaiting_acceptance');
  });

  it('never leaves the run stranded in `reconciling` when the pass throws', async () => {
    const { deps, calls } = fakeDeps({});
    deps.buildContext = (async () => {
      throw new Error('boom');
    }) as typeof deps.buildContext;
    await expect(reReconcileInvestmentRun({ runId: 'run-1', userId: 'user-1', countryCode: 'IN', overrides: {} }, deps)).rejects.toThrow('boom');
    expect(calls.transitions.map((t) => t.toStatus)).toEqual(['reconciling', 'unresolved']);
  });
});
