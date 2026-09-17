/**
 * AIE-1.6 independent certification — adversarial verification written and
 * run by the certifying agent (not part of any prior AIE phase's own test
 * suite). Uses a REAL shared in-memory "database" object with genuine CAS
 * semantics (not a pre-scripted true/false mock) so two `acceptRun()` calls
 * fired via `Promise.all` actually interleave, rather than a test asserting
 * a single simulated race outcome chosen in advance.
 *
 * Scope: concurrent/replayed-operation duplication (AIE-1.6 automatic NO-GO
 * condition #5: "Concurrent/replayed operations can duplicate provider
 * charges, decisions or canonical records").
 */
import { describe, it, expect } from 'vitest';
import { acceptRun, type AcceptRunDeps } from '@/lib/aie/review/accept';
import type { AieRunRow } from '@/lib/aie/db/repository';

function makeSharedFakeDb() {
  const state = {
    run: { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'awaiting_acceptance', aiUsed: false, startedAt: new Date().toISOString() } as AieRunRow,
    writeBatch: null as null | { id: string; status: 'pending' | 'committed' | 'failed' },
    insuranceWriteCount: 0,
    // M12C (M2-OPEN-1): the real `aie_processing_transition` table, as a
    // list. Under a genuine race this is the strongest available check that
    // a LOSING CAS never leaves an audit row behind.
    fsmAudits: [] as Array<{ fromState: string; toState: string; actorType: string; reason?: string }>,
  };

  const deps: AcceptRunDeps = {
    isCanonicalAcceptanceEnabled: () => true,
    getRunForUser: async () => ({ ...state.run }),
    // This probe exercises Insurance's own concurrency path specifically —
    // returning the real Insurance adapter id keeps accept.ts's own
    // adapter dispatch (see AIE_1_MERGE_PLAN.md section 3 finding #2 / the
    // moduleRegistry.ts and accept.ts fixes) routing here exactly as before.
    getAdapterIdForRun: async () => 'insurance_generic_schedule_v1',
    getIntakeUploadMetadata: async () => null,
    getFdhBankUploadMetadata: async () => null,
    findCommittedFdhBankWriteForRun: async () => null,
    downloadQuarantinedBytes: async () => ({ ok: false, message: 'not exercised by this Insurance-only concurrency probe' }),
    countItemsBlockingAcceptanceForRun: async () => 0,
    latestReconciliationOutcomesForRun: async () => [{ ruleId: 'insurance_required_fields_present', outcome: 'pass' }],
    listFieldCandidatesForRun: async () => [],
    listLatestCorrectionsForRun: async () => [],
    // REAL compare-and-swap against shared mutable state, with an
    // artificial await tick inserted so two concurrent callers actually
    // interleave between the read and the write, not just conceptually.
    transitionRunStatusCas: async ({ fromStatus, toStatus }) => {
      await new Promise((r) => setTimeout(r, 1));
      if (state.run.status !== fromStatus) return false;
      state.run = { ...state.run, status: toStatus as AieRunRow['status'] };
      return true;
    },
    recordRunTransitionAudit: async (p) => {
      state.fsmAudits.push({ fromState: p.fromState, toState: p.toState, actorType: p.actorType, reason: p.reason });
    },
    findOrCreateWriteBatch: async ({ idempotencyKey }) => {
      await new Promise((r) => setTimeout(r, 1));
      if (state.writeBatch) return state.writeBatch; // idempotent: same key -> same batch
      state.writeBatch = { id: `batch-for-${idempotencyKey}`, status: 'pending' };
      return state.writeBatch;
    },
    markWriteBatchStatus: async (id, status) => {
      if (state.writeBatch && state.writeBatch.id === id) state.writeBatch = { ...state.writeBatch, status };
    },
    audit: async () => {},
    acceptAndWriteInsurance: async () => {
      await new Promise((r) => setTimeout(r, 1));
      state.insuranceWriteCount += 1;
      return { ok: true, insurancePolicyId: 'policy-1' };
    },
    insuranceWriteDeps: {} as AcceptRunDeps['insuranceWriteDeps'],
    acceptAndWriteInvestment: async () => {
      throw new Error('not exercised by this Insurance-only concurrency probe');
    },
    investmentWriteDeps: {} as AcceptRunDeps['investmentWriteDeps'],
    commitFdhBankImport: async () => {
      throw new Error('not exercised by this Insurance-only concurrency probe');
    },
    finalizeDocumentBinary: async () => ({ status: 'deleted' }),
  };

  return { deps, state };
}

describe('AIE-1.6 certification — adversarial concurrency probe (not part of any AIE-1.x phase suite)', () => {
  it('two truly concurrent acceptRun() calls for the SAME run never both reach the canonical write', async () => {
    const { deps, state } = makeSharedFakeDb();
    const params = { runId: 'run-1', userId: 'user-1', acceptedByUserId: 'user-1', ownerHouseholdRole: 'self' as const, idempotencyKey: 'run-1:accept:1' };

    const [a, b] = await Promise.all([acceptRun(params, deps), acceptRun(params, deps)]);

    // Exactly one canonical write must have occurred, never zero, never two.
    expect(state.insuranceWriteCount).toBe(1);

    // Exactly one of the two callers should see the fresh completion; the
    // other must see either a clean stale_conflict or the idempotent
    // "alreadyCompleted" result — never a second independent write, and
    // never a silently-swallowed failure that reports ok:true with no write
    // having happened at all.
    const outcomes = [a, b];
    const successCount = outcomes.filter((o) => o.ok).length;
    expect(successCount).toBeGreaterThanOrEqual(1);
    if (a.ok && b.ok) {
      // Both may report ok:true (one real, one idempotent-replay) but must
      // reference the SAME insurance policy id — never two different ones.
      expect(a.insurancePolicyId).toBe(b.insurancePolicyId);
    }
  });

  it('a replayed accept call (same idempotencyKey) after real completion returns alreadyCompleted without a second write', async () => {
    const { deps, state } = makeSharedFakeDb();
    const params = { runId: 'run-1', userId: 'user-1', acceptedByUserId: 'user-1', ownerHouseholdRole: 'self' as const, idempotencyKey: 'run-1:accept:1' };

    const first = await acceptRun(params, deps);
    expect(first.ok).toBe(true);
    expect(state.insuranceWriteCount).toBe(1);

    // Client never saw the first response (e.g. network drop) and retries
    // with the identical idempotency key after the run is already
    // 'completed'.
    const replay = await acceptRun(params, deps);
    expect(replay).toEqual({ ok: true, alreadyCompleted: true });
    expect(state.insuranceWriteCount).toBe(1); // still exactly one — no duplicate write on replay

    // M12C (M2-OPEN-1): the replay short-circuits on `run.status ===
    // 'completed'` BEFORE any CAS, so it must add no audit row at all — the
    // trail records three real edges from the first call and nothing else.
    expect(state.fsmAudits.map((a) => `${a.fromState}->${a.toState}`)).toEqual([
      'awaiting_acceptance->accepted',
      'accepted->write_pending',
      'write_pending->completed',
    ]);
  });

  // M12C (M2-OPEN-1) — the adversarial form of "never audit a transition
  // that did not happen", under a REAL race rather than a scripted `false`.
  it('under a genuine two-caller race, the LOSING CAS leaves no aie_processing_transition row behind', async () => {
    const { deps, state } = makeSharedFakeDb();
    const params = { runId: 'run-1', userId: 'user-1', acceptedByUserId: 'user-1', ownerHouseholdRole: 'self' as const, idempotencyKey: 'run-1:accept:1' };

    await Promise.all([acceptRun(params, deps), acceptRun(params, deps)]);

    // Whatever the interleaving, the run moved through each edge exactly
    // once, so each edge may be audited at most once. A losing caller that
    // audited anyway would show up here as a duplicate.
    const edges = state.fsmAudits.map((a) => `${a.fromState}->${a.toState}`);
    expect(new Set(edges).size).toBe(edges.length);
    // Every audited edge is one the shared fake DB actually applied: the
    // run's status can only be what the last applied CAS set it to.
    expect(state.run.status).toBe('completed');
    expect(edges).toContain('awaiting_acceptance->accepted');
    // Exactly one caller may claim the user-attributed acceptance edge.
    expect(state.fsmAudits.filter((a) => a.actorType === 'user')).toHaveLength(1);
  });
});
