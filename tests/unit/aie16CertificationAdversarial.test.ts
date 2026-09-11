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
  };

  const deps: AcceptRunDeps = {
    isCanonicalAcceptanceEnabled: () => true,
    getRunForUser: async () => ({ ...state.run }),
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
  });
});
