import { describe, it, expect } from 'vitest';
import {
  assertIntakeTransition,
  assertRunTransition,
  isAllowedIntakeTransition,
  isAllowedRunTransition,
  isTerminalRunStatus,
  AieInvalidTransitionError,
  AIE_PURGE_STATUS_TRANSITIONS,
  isAllowedPurgeTransition,
  assertPurgeTransition,
} from '@/lib/aie/stateMachine';
import { AIE_PURGE_STATUSES } from '@/lib/aie/types';

describe('AIE-1.1 intake state machine (FSM)', () => {
  it('allows the happy path', () => {
    expect(isAllowedIntakeTransition('received', 'quarantined')).toBe(true);
    expect(isAllowedIntakeTransition('quarantined', 'ready')).toBe(true);
    expect(isAllowedIntakeTransition('ready', 'deleted')).toBe(true);
  });

  it('rejects resurrecting a deleted intake', () => {
    expect(isAllowedIntakeTransition('deleted', 'ready')).toBe(false);
    expect(() => assertIntakeTransition('deleted', 'ready')).toThrow(AieInvalidTransitionError);
  });

  it('rejects skipping quarantine straight to ready', () => {
    expect(isAllowedIntakeTransition('received', 'ready')).toBe(false);
  });

  it('rejected/cancelled can still reach deleted (retention sweep)', () => {
    expect(isAllowedIntakeTransition('rejected', 'deleted')).toBe(true);
    expect(isAllowedIntakeTransition('cancelled', 'deleted')).toBe(true);
    expect(isAllowedIntakeTransition('rejected', 'ready')).toBe(false);
  });
});

describe('AIE-1.1 extraction run state machine', () => {
  it('allows the deterministic-complete happy path', () => {
    assertRunTransition('local_extracting', 'local_complete');
    assertRunTransition('local_complete', 'deterministic_complete');
    assertRunTransition('deterministic_complete', 'reconciling');
    assertRunTransition('reconciling', 'awaiting_acceptance');
    assertRunTransition('awaiting_acceptance', 'accepted');
    assertRunTransition('accepted', 'write_pending');
    assertRunTransition('write_pending', 'completed');
  });

  it('allows the masked-AI-fallback path through ai_complete', () => {
    assertRunTransition('deterministic_partial', 'masking');
    assertRunTransition('masking', 'ai_pending');
    assertRunTransition('ai_pending', 'ai_running');
    assertRunTransition('ai_running', 'ai_complete');
    assertRunTransition('ai_complete', 'reconciling');
  });

  it('a masking-policy failure only ever reaches the terminal privacy_blocked state', () => {
    assertRunTransition('masking', 'privacy_blocked');
    expect(isTerminalRunStatus('privacy_blocked')).toBe(true);
    expect(isAllowedRunTransition('privacy_blocked', 'ai_pending')).toBe(false);
  });

  it('a schema-rejected AI response cannot silently become success — it can only retry or move to reconciling', () => {
    expect(isAllowedRunTransition('ai_running', 'schema_rejected')).toBe(true);
    expect(isAllowedRunTransition('schema_rejected', 'ai_complete')).toBe(false);
    assertRunTransition('schema_rejected', 'ai_pending');
    assertRunTransition('schema_rejected', 'reconciling');
  });

  it('completed and failed_terminal are terminal — no onward edge exists', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed_terminal')).toBe(true);
    expect(isAllowedRunTransition('completed', 'write_pending')).toBe(false);
  });

  it('rejects an illegal jump from local_extracting straight to completed', () => {
    expect(() => assertRunTransition('local_extracting', 'completed')).toThrow(AieInvalidTransitionError);
  });
});

// ============================================================================
// M12C — M2-OPEN-2: the `purge_status` machine.
//
// `aie_document_intake.purge_status` (migration 0149) had a CHECK constraint
// for its VOCABULARY and nothing at all for its TRANSITIONS — no table, no
// validator, and the vocabulary itself was duplicated as an inline literal
// union inside a non-exported interface in `lib/aie/services/purge.ts`. Both
// of the other two AIE machines have had a declared table and a fail-closed
// validator since AIE-1.1, and FDH's own equivalent
// (`lib/financial-data-hub/domain/documentLifecycle.ts:118-136`) has had one
// since FDH-1. This closes the gap with the same shape.
// ============================================================================
describe('M2-OPEN-2 — AIE raw-document purge state machine', () => {
  it('declares exactly the five statuses migration 0149 permits, as the single source of truth', () => {
    expect([...AIE_PURGE_STATUSES]).toEqual(['not_required', 'pending', 'in_progress', 'purged', 'failed']);
    expect(Object.keys(AIE_PURGE_STATUS_TRANSITIONS).sort()).toEqual([...AIE_PURGE_STATUSES].sort());
  });

  // Table test, mirroring `tests/unit/fdh1Domain.test.ts:418-422`. Each row
  // names the real code path that takes the edge — the table exists to
  // DESCRIBE the job this repo actually runs, not to impose an idealised
  // machine on it.
  const legal: Array<[string, string, string]> = [
    ['not_required', 'pending', 'finalizeDocumentBinaryAfterRun retry path / hard backstop schedules a fresh row'],
    ['not_required', 'purged', 'the PRIMARY immediate-deletion path: admitted -> pipeline done -> bytes deleted, never scheduled at all'],
    ['pending', 'in_progress', 'findDuePurges -> runPurgeAttempt leases the row'],
    ['pending', 'pending', 'the hard backstop re-stamps purge_due_at/purge_reason on an already-scheduled row'],
    ['pending', 'purged', 'a scheduled row whose immediate-deletion call later succeeds'],
    ['in_progress', 'purged', 'runPurgeAttempt after delete + independent absence verification'],
    ['in_progress', 'failed', 'failAttempt — every failAttempt call site runs after in_progress was set'],
    ['in_progress', 'pending', 'finalizeDocumentBinaryAfterRun reschedules a row a sweep is mid-flight on (benign, but real)'],
    ['failed', 'in_progress', 'findDuePurges also returns failed rows once the backoff has elapsed'],
    ['failed', 'pending', 'the hard backstop force-schedules a repeatedly-failed row'],
    ['failed', 'purged', 'a previously-failed row whose immediate-deletion call later succeeds'],
  ];
  for (const [from, to, why] of legal) {
    it(`allows ${from} -> ${to} (${why})`, () => {
      expect(isAllowedPurgeTransition(from as never, to as never)).toBe(true);
      expect(() => assertPurgeTransition(from as never, to as never)).not.toThrow();
    });
  }

  it('purged is TERMINAL — an already-purged row can never be resurrected', () => {
    // This is the edge the code could actually take before this fix:
    // `finalizeDocumentBinaryAfterRun`'s retry path wrote purge_status
    // 'pending' with no CAS and no from-state check whatsoever, so a row
    // already marked `purged` was re-scheduled, re-selected by
    // `findDuePurges` forever, and re-audited on every sweep.
    expect(AIE_PURGE_STATUS_TRANSITIONS.purged).toHaveLength(0);
    expect(isAllowedPurgeTransition('purged', 'pending')).toBe(false);
    expect(() => assertPurgeTransition('purged', 'pending')).toThrow(AieInvalidTransitionError);
    for (const to of AIE_PURGE_STATUSES) {
      expect(isAllowedPurgeTransition('purged', to), `purged -> ${to}`).toBe(false);
    }
  });

  it('refuses a purge attempt on a row nobody ever scheduled (not_required -> in_progress)', () => {
    expect(isAllowedPurgeTransition('not_required', 'in_progress')).toBe(false);
  });

  it('refuses a failure verdict that did not come from an in-flight attempt', () => {
    expect(isAllowedPurgeTransition('pending', 'failed')).toBe(false);
    expect(isAllowedPurgeTransition('not_required', 'failed')).toBe(false);
    expect(() => assertPurgeTransition('failed', 'failed')).toThrow(AieInvalidTransitionError);
  });

  it('is fail-closed on an unrecognised from-state, exactly like the other two AIE machines', () => {
    // Same hardening rationale as `isAllowedIntakeTransition`: purge_status
    // comes back out of Postgres as untyped `text` and is cast unchecked.
    expect(isAllowedPurgeTransition('legal_hold' as never, 'pending')).toBe(false);
    expect(() => assertPurgeTransition('legal_hold' as never, 'pending')).toThrow(AieInvalidTransitionError);
  });

  it('does NOT reuse FDH\'s machine — AIE has five statuses, FDH has six (legal_hold)', () => {
    expect([...AIE_PURGE_STATUSES]).not.toContain('legal_hold');
  });
});
