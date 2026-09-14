import { describe, it, expect } from 'vitest';
import {
  assertIntakeTransition,
  assertRunTransition,
  isAllowedIntakeTransition,
  isAllowedRunTransition,
  isTerminalRunStatus,
  AieInvalidTransitionError,
} from '@/lib/aie/stateMachine';

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
