import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rejectRun, type RejectRunDeps } from '@/lib/aie/review/reject';
import { AIE_INTAKE_TRANSITIONS } from '@/lib/aie/stateMachine';
import type { AieRunRow } from '@/lib/aie/db/repository';

function baseRun(overrides: Partial<AieRunRow> = {}): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'unresolved', aiUsed: false, startedAt: new Date().toISOString(), ...overrides };
}

function fakeDeps(overrides: Partial<RejectRunDeps> = {}): { deps: RejectRunDeps; calls: Record<string, unknown[]> } {
  // M12C (M2-OPEN-1): `fsmAudits` collects `aie_processing_transition` rows,
  // which are a different table from the coarser `aie_audit_event` rows in
  // `audits`. Mirrors `tests/unit/aieReviewRevalidate.test.ts`, which has
  // faked both since revalidate.ts established the pairing.
  const calls: Record<string, unknown[]> = { transitions: [], intakeUpdates: [], audits: [], fsmAudits: [] };
  const deps: RejectRunDeps = {
    getRunForUser: async () => baseRun(),
    transitionRunStatusCas: async (p) => {
      calls.transitions.push(p);
      return true;
    },
    recordRunTransitionAudit: async (p) => {
      calls.fsmAudits.push(p);
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

  // ==========================================================================
  // M12C — M2-OPEN-1 for the reject path. `rejectRun` performed a CAS to
  // `failed_terminal` — a TERMINAL state, the single most consequential move
  // in the run machine — and left no `aie_processing_transition` row at all.
  // ==========================================================================
  describe('M2-OPEN-1: aie_processing_transition audit on the reject CAS', () => {
    it('records exactly one FSM audit row for the run -> failed_terminal edge, attributed to the rejecting user', async () => {
      const { deps, calls } = fakeDeps();
      await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps);
      expect(calls.fsmAudits).toEqual([
        { runId: 'run-1', intakeId: 'intake-1', userId: 'user-1', fromState: 'unresolved', toState: 'failed_terminal', actorType: 'user', actorId: 'user-1', reason: 'user_rejected_document' },
      ]);
    });

    it('records the real observed from-state, not a hardcoded one (awaiting_acceptance rejects are audited as such)', async () => {
      const { deps, calls } = fakeDeps({ getRunForUser: async () => baseRun({ status: 'awaiting_acceptance' }) });
      await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps);
      expect((calls.fsmAudits[0] as { fromState: string }).fromState).toBe('awaiting_acceptance');
    });

    it('NEVER audits a transition that did not happen: a lost CAS race writes no FSM audit row', async () => {
      const { deps, calls } = fakeDeps({ transitionRunStatusCas: async () => false });
      expect(await rejectRun({ runId: 'run-1', userId: 'user-1' }, deps)).toEqual({ ok: false, reason: 'stale_conflict' });
      expect(calls.fsmAudits).toHaveLength(0);
    });

    it('never places a raw rationale string into the FSM audit reason either (AUD-09 applies to both tables)', async () => {
      const { deps, calls } = fakeDeps();
      await rejectRun({ runId: 'run-1', userId: 'user-1', rationale: 'PAN ABCDE1234F' }, deps);
      expect(JSON.stringify(calls.fsmAudits)).not.toContain('ABCDE1234F');
    });
  });

  // M12C: the header comment of reject.ts asserted a state-machine fact that
  // had since become false. A stale comment about a state machine is not
  // cosmetic — it is the thing a later reader reasons from. Pinned here so it
  // cannot silently rot again.
  describe('M12C: reject.ts documents the CURRENT intake machine, not a superseded one', () => {
    it('ready\'s declared successors include rejected — so the header must not claim otherwise', () => {
      expect(AIE_INTAKE_TRANSITIONS.ready).toContain('rejected');
      const source = readFileSync(join(process.cwd(), 'lib/aie/review/reject.ts'), 'utf8');
      const header = source.slice(0, source.indexOf('import '));
      expect(header).not.toContain("only legal onward transitions are `['cancelled', 'deleted']`");
      // The behaviour itself is unchanged and still documented: cancelled,
      // not rejected, is the right verdict for a USER-initiated decline.
      expect(header).toContain('cancelled');
    });
  });
});
