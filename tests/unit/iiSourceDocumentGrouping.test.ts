// Statements & data list — "Previously processed" grouping (2026-09-29 fix).
//
// THE REAL BUG UNDER TEST
// ------------------------
// Confirmed live on /investment-intelligence/data: a statement that had been
// fully processed, reviewed, certified AND published never left the working
// list — every uploaded document stayed in the same flat list forever
// regardless of status. These tests pin down the exact condition that now
// moves a document into "previously processed" so a future change cannot
// silently widen or narrow it (e.g. treating "certified" as "done" without
// requiring an actual publish, which would be wrong per R3 spec sections
// 41-42 — publishing is a separate, explicit user action).

import { describe, it, expect } from 'vitest';
import { isSourceDocumentFullyProcessed, partitionSourceDocumentsByProcessedState, type SourceDocumentGroupingSignals } from '@/lib/investment-intelligence/sourceDocumentGrouping';

const DONE: SourceDocumentGroupingSignals = {
  status: 'parsed',
  openReconciliationCaseCount: 0,
  positionsNeedingAttentionCount: 0,
  totalHoldingsCount: 3,
  publishedHoldingsCount: 3,
};

describe('isSourceDocumentFullyProcessed', () => {
  it('is true for a fully parsed, clean, fully-published document', () => {
    expect(isSourceDocumentFullyProcessed(DONE)).toBe(true);
  });

  it('is false for any status other than parsed', () => {
    for (const status of ['uploaded', 'parsing', 'parse_failed', 'password_required', 'reconciliation_required', 'unsupported', 'ai_review_pending', 'superseded', 'archived']) {
      expect(isSourceDocumentFullyProcessed({ ...DONE, status }), `status=${status} must stay active`).toBe(false);
    }
  });

  it('is false while any reconciliation case is still open', () => {
    expect(isSourceDocumentFullyProcessed({ ...DONE, openReconciliationCaseCount: 1 })).toBe(false);
  });

  it('is false while any position still needs attention (certified only, not yet published, or worse)', () => {
    expect(isSourceDocumentFullyProcessed({ ...DONE, positionsNeedingAttentionCount: 1 })).toBe(false);
  });

  it('is false when publishing is incomplete, even with zero open cases and zero flagged positions', () => {
    // The exact distinction this fix depends on: "certified" is not "done".
    // A position can be fully certified and sit unpublished for weeks
    // waiting on the user's own explicit Publish click.
    expect(isSourceDocumentFullyProcessed({ ...DONE, publishedHoldingsCount: 2 })).toBe(false);
  });

  it('is false for a document that produced zero holdings, even if otherwise clean', () => {
    // Nothing was ever published for this document, so there is nothing to
    // confirm — never guess it into the archive.
    expect(isSourceDocumentFullyProcessed({ ...DONE, totalHoldingsCount: 0, publishedHoldingsCount: 0 })).toBe(false);
  });

  it('tolerates undefined counts (a document response shape from before this fix) as "not done"', () => {
    expect(isSourceDocumentFullyProcessed({ status: 'parsed' })).toBe(false);
  });
});

describe('partitionSourceDocumentsByProcessedState', () => {
  it('splits a mixed list, preserving each document exactly once and its relative order', () => {
    const active1 = { ...DONE, id: 'a', status: 'uploaded' as const };
    const done1 = { ...DONE, id: 'b' };
    const active2 = { ...DONE, id: 'c', openReconciliationCaseCount: 1 };
    const done2 = { ...DONE, id: 'd' };
    const { active, previouslyProcessed } = partitionSourceDocumentsByProcessedState([active1, done1, active2, done2]);
    expect(active.map((d) => (d as { id: string }).id)).toEqual(['a', 'c']);
    expect(previouslyProcessed.map((d) => (d as { id: string }).id)).toEqual(['b', 'd']);
  });

  it('returns everything as active when nothing qualifies', () => {
    const { active, previouslyProcessed } = partitionSourceDocumentsByProcessedState([{ status: 'uploaded' }, { status: 'parse_failed' }]);
    expect(active).toHaveLength(2);
    expect(previouslyProcessed).toHaveLength(0);
  });

  it('handles an empty list', () => {
    expect(partitionSourceDocumentsByProcessedState([])).toEqual({ active: [], previouslyProcessed: [] });
  });
});
