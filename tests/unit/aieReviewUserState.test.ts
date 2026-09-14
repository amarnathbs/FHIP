import { describe, it, expect } from 'vitest';
import { computeUserFacingState, computeUserFacingStateForIntakeWithoutRun } from '@/lib/aie/review/userState';
import { AIE_RUN_STATUSES } from '@/lib/aie/types';

describe('AIE-1.5 userState.ts — computeUserFacingState (AIE15-TEST-01)', () => {
  it('maps every processing sub-state to "processing"', () => {
    const processingStates = ['local_extracting', 'local_complete', 'deterministic_complete', 'deterministic_partial', 'masking', 'ai_pending', 'ai_running', 'ai_complete', 'schema_rejected', 'reconciling'] as const;
    for (const runStatus of processingStates) {
      expect(computeUserFacingState({ runStatus, reconciliationOutcome: 'not_applicable', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('processing');
    }
  });

  it('privacy_blocked is always unable_to_process_safely', () => {
    expect(computeUserFacingState({ runStatus: 'privacy_blocked', reconciliationOutcome: 'not_applicable', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('unable_to_process_safely');
  });

  it('unresolved with open blocking items is needs_your_review', () => {
    expect(computeUserFacingState({ runStatus: 'unresolved', reconciliationOutcome: 'fail', openBlockingItemCount: 2, hasEverReachedWritePending: false })).toBe('needs_your_review');
  });

  it('unresolved with a stale zero-blocking-count view is honestly "processing", never a false ready-to-accept (TRI-11)', () => {
    expect(computeUserFacingState({ runStatus: 'unresolved', reconciliationOutcome: 'fail', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('processing');
  });

  it('awaiting_acceptance with zero blocking items is ready_to_accept', () => {
    expect(computeUserFacingState({ runStatus: 'awaiting_acceptance', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('ready_to_accept');
  });

  it('awaiting_acceptance with a stale nonzero blocking count is needs_your_review, never ready-to-accept', () => {
    expect(computeUserFacingState({ runStatus: 'awaiting_acceptance', reconciliationOutcome: 'pass', openBlockingItemCount: 1, hasEverReachedWritePending: false })).toBe('needs_your_review');
  });

  it('accepted and write_pending are both accepted_importing', () => {
    expect(computeUserFacingState({ runStatus: 'accepted', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: true })).toBe('accepted_importing');
    expect(computeUserFacingState({ runStatus: 'write_pending', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: true })).toBe('accepted_importing');
  });

  it('completed is completed', () => {
    expect(computeUserFacingState({ runStatus: 'completed', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: true })).toBe('completed');
  });

  it('failed_retryable is import_failed only once a write was actually attempted, else still processing', () => {
    expect(computeUserFacingState({ runStatus: 'failed_retryable', reconciliationOutcome: 'pass', openBlockingItemCount: 0, hasEverReachedWritePending: true })).toBe('import_failed');
    expect(computeUserFacingState({ runStatus: 'failed_retryable', reconciliationOutcome: 'not_applicable', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('processing');
  });

  it('failed_terminal is import_failed after a write attempt, else unable_to_process_safely (e.g. user-rejected document)', () => {
    expect(computeUserFacingState({ runStatus: 'failed_terminal', reconciliationOutcome: 'fail', openBlockingItemCount: 0, hasEverReachedWritePending: true })).toBe('import_failed');
    expect(computeUserFacingState({ runStatus: 'failed_terminal', reconciliationOutcome: 'not_applicable', openBlockingItemCount: 0, hasEverReachedWritePending: false })).toBe('unable_to_process_safely');
  });

  it('every AieRunStatus value is exhaustively handled (fails loudly if lib/aie/types.ts ever adds a new one)', () => {
    for (const runStatus of AIE_RUN_STATUSES) {
      expect(() => computeUserFacingState({ runStatus, reconciliationOutcome: 'not_applicable', openBlockingItemCount: 0, hasEverReachedWritePending: false })).not.toThrow();
    }
  });

  it('intake-without-run mapping: quarantined/received are processing, rejected/cancelled/deleted are unable_to_process_safely', () => {
    expect(computeUserFacingStateForIntakeWithoutRun('received')).toBe('processing');
    expect(computeUserFacingStateForIntakeWithoutRun('quarantined')).toBe('processing');
    expect(computeUserFacingStateForIntakeWithoutRun('rejected')).toBe('unable_to_process_safely');
    expect(computeUserFacingStateForIntakeWithoutRun('cancelled')).toBe('unable_to_process_safely');
    expect(computeUserFacingStateForIntakeWithoutRun('deleted')).toBe('unable_to_process_safely');
  });
});
