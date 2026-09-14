import { describe, it, expect } from 'vitest';
import { rejectRun, type RejectRunDeps } from '@/lib/aie/review/reject';
import type { AieRunRow } from '@/lib/aie/db/repository';

function baseRun(overrides: Partial<AieRunRow> = {}): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString(), ...overrides };
}

function fakeDeps(overrides: Partial<RejectRunDeps> = {}): { deps: RejectRunDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { transitions: [], intakeUpdates: [], audits: [] };
  const deps: RejectRunDeps = {
    getRunForUser: async () => baseRun(),
    transitionRunStatusCas: async (p) => {
      calls.transitions.push(p);
      return true;
    },
    updateIntakeStatus: async (p) => {
      calls.intakeUpdates.push(p);
      return { ok: true };
    },
    audit: async (e) => {
      calls.audits.push(e);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('AIE-1.5 reject.ts — rejectRun (ACT-05, intake state-machine honesty)', () => {
  it('not_found for a run that does not belong to this user', async () => {
    const { deps } = fakeDeps({ getRunForUser: async () => null });
    expect(await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses to reject a run already completed or mid-write (not_eligible)', async () => {
    const { deps } = fakeDeps({ getRunForUser: async () => baseRun({ status: 'completed' }) });
    expect(await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps)).toEqual({ ok: false, reason: 'not_eligible' });
  });

  it('transitions the RUN to failed_terminal and the INTAKE to "cancelled" — NEVER the illegal "rejected" transition from "ready"', async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: true });
    expect(calls.transitions).toEqual([{ runId: 'run-1', fromStatus: 'unresolved', toStatus: 'failed_terminal' }]);
    expect(calls.intakeUpdates).toEqual([{ intakeId: 'intake-1', toStatus: 'cancelled' }]);
  });

  it('a lost CAS race reports stale_conflict and never touches the intake', async () => {
    const { deps, calls } = fakeDeps({ transitionRunStatusCas: async () => false });
    const outcome = await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps);
    expect(outcome).toEqual({ ok: false, reason: 'stale_conflict' });
    expect(calls.intakeUpdates).toHaveLength(0);
  });

  it('never places a raw rationale string into audit metadata (AUD-09 — presence only, not content)', async () => {
    const { deps, calls } = fakeDeps();
    await rejectRun({ runId: 'run-1', userId: 'user-1', rationale: 'This looks like someone else\'s policy, PAN ABCDE1234F' }, deps);
    const audited = calls.audits[0] as { metadata: { rationale: string } };
    expect(audited.metadata.rationale).toBe('provided');
    expect(JSON.stringify(audited)).not.toContain('ABCDE1234F');
  });
});
