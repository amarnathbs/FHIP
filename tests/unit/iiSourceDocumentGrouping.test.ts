// Statements & data list grouping.
//
// 2026-09-29: a document that had been fully processed never left the working list.
// Document2 (4) WP-J (25-10-2026, Product Owner request): the list shows PROMINENTLY only the statements that need action (Parse failed,
// issues, positions needing attention, ready to publish, a running job, anything not yet processed) and folds everything else, including
// archived or superseded statements with no open issue, into one quiet "Processed statements (N)" disclosure.
//
// These tests pin the exact rule so a future change cannot silently widen or narrow it. "Certified" alone is still not "done": publishing
// is a separate, explicit user action (R3 spec sections 41-42), so a certified statement with unpublished positions stays prominent.

import { describe, it, expect } from 'vitest';
import {
  isSourceDocumentFullyProcessed,
  partitionSourceDocumentsByProcessedState,
  statementActionReasons,
  statementNeedsAction,
  type SourceDocumentGroupingSignals,
} from '@/lib/investment-intelligence/sourceDocumentGrouping';

const DONE: SourceDocumentGroupingSignals = {
  status: 'parsed',
  openReconciliationCaseCount: 0,
  positionsNeedingAttentionCount: 0,
  totalHoldingsCount: 3,
  publishedHoldingsCount: 3,
};

describe('statementNeedsAction / isSourceDocumentFullyProcessed', () => {
  it('a fully parsed, clean, fully published statement is quiet', () => {
    expect(statementNeedsAction(DONE)).toBe(false);
    expect(isSourceDocumentFullyProcessed(DONE)).toBe(true);
  });

  it('every status that is not a finished one needs action (uploaded, processing, Parse failed, password, unsupported, reconciliation, AI review)', () => {
    for (const status of ['uploaded', 'parsing', 'parse_failed', 'password_required', 'reconciliation_required', 'unsupported', 'ai_review_pending']) {
      expect(statementNeedsAction({ ...DONE, status }), `status=${status}`).toBe(true);
    }
  });

  it('archived and superseded statements with no open issue are quiet', () => {
    expect(statementNeedsAction({ status: 'archived', openReconciliationCaseCount: 0 })).toBe(false);
    expect(statementNeedsAction({ status: 'superseded' })).toBe(false);
  });

  it('an open issue is never hidden, not even on an archived statement', () => {
    expect(statementNeedsAction({ ...DONE, openReconciliationCaseCount: 1 })).toBe(true);
    expect(statementNeedsAction({ status: 'archived', openReconciliationCaseCount: 2 })).toBe(true);
  });

  it('positions needing attention keep the statement prominent', () => {
    expect(statementNeedsAction({ ...DONE, positionsNeedingAttentionCount: 15 })).toBe(true);
  });

  it('certified but not fully published (a Publish to FHIP click is still to be made) stays prominent', () => {
    expect(statementNeedsAction({ ...DONE, publishedHoldingsCount: 2 })).toBe(true);
  });

  it('a parsed statement that produced no holdings and has no issue is quiet (nothing is waiting on the person)', () => {
    expect(statementNeedsAction({ ...DONE, totalHoldingsCount: 0, publishedHoldingsCount: 0 })).toBe(false);
    expect(statementNeedsAction({ status: 'parsed' })).toBe(false);
  });

  it('a running or waiting job makes any statement prominent, whatever its status', () => {
    expect(statementNeedsAction(DONE, true)).toBe(true);
    expect(statementNeedsAction({ status: 'archived' }, true)).toBe(true);
  });
});

describe('partitionSourceDocumentsByProcessedState', () => {
  it('splits a mixed list, preserving each document exactly once and its relative order', () => {
    const a = { ...DONE, id: 'a', status: 'uploaded' };
    const b = { ...DONE, id: 'b' };
    const c = { ...DONE, id: 'c', openReconciliationCaseCount: 1 };
    const d = { ...DONE, id: 'd' };
    const e = { id: 'e', status: 'archived' };
    const { active, previouslyProcessed } = partitionSourceDocumentsByProcessedState([a, b, c, d, e]);
    expect(active.map((x) => x.id)).toEqual(['a', 'c']);
    expect(previouslyProcessed.map((x) => x.id)).toEqual(['b', 'd', 'e']);
  });

  it('a statement with a running job is moved to the prominent list', () => {
    const { active, previouslyProcessed } = partitionSourceDocumentsByProcessedState([{ ...DONE, id: 'b' }, { ...DONE, id: 'd' }], new Set(['d']));
    expect(active.map((x) => x.id)).toEqual(['d']);
    expect(previouslyProcessed.map((x) => x.id)).toEqual(['b']);
  });

  it('returns everything as active when nothing is quiet, and handles an empty list', () => {
    const { active, previouslyProcessed } = partitionSourceDocumentsByProcessedState([{ status: 'uploaded' }, { status: 'parse_failed' }]);
    expect(active).toHaveLength(2);
    expect(previouslyProcessed).toHaveLength(0);
    expect(partitionSourceDocumentsByProcessedState([])).toEqual({ active: [], previouslyProcessed: [] });
  });
});

describe('statementActionReasons (the chips that say why a statement is prominent)', () => {
  it('names each reason in plain words', () => {
    expect(statementActionReasons({ status: 'parse_failed' })).toEqual(['Parse failed']);
    expect(statementActionReasons({ ...DONE, openReconciliationCaseCount: 1, positionsNeedingAttentionCount: 15 })).toEqual(['1 issue', '15 positions need attention']);
    expect(statementActionReasons({ ...DONE, publishedHoldingsCount: 1 })).toEqual(['2 ready to publish']);
    expect(statementActionReasons(DONE, true)).toEqual(['Processing']);
    expect(statementActionReasons(DONE)).toEqual([]);
  });
});
