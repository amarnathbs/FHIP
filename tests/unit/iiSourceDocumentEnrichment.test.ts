// GET /api/investment-intelligence/source-documents — per-document counts
// (2026-09-28 fix: openReconciliationCaseCount/positionsNeedingAttentionCount;
// 2026-09-29 fix: totalHoldingsCount/publishedHoldingsCount, feeding the
// "Previously processed" grouping in
// lib/investment-intelligence/sourceDocumentGrouping.ts).
//
// Tests the pure aggregation directly with plain rows rather than through a
// mocked Supabase query chain — route.ts (the GET handler) is a thin
// fetch-then-call wrapper around this function.

import { describe, it, expect } from 'vitest';
import { computeSourceDocumentCounts, EMPTY_SOURCE_DOCUMENT_COUNTS } from '@/lib/services/investment-intelligence/sourceDocumentEnrichment';

describe('computeSourceDocumentCounts', () => {
  it('returns nothing for a user with no rows anywhere', () => {
    const counts = computeSourceDocumentCounts({ openCases: [], holdings: [], truthStatuses: [], publications: [] });
    expect(counts.size).toBe(0);
  });

  it('counts only OPEN reconciliation cases against their document', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [{ source_document_id: 'doc-1' }, { source_document_id: 'doc-1' }, { source_document_id: 'doc-2' }, { source_document_id: null }],
      holdings: [],
      truthStatuses: [],
      publications: [],
    });
    expect(counts.get('doc-1')?.openReconciliationCaseCount).toBe(2);
    expect(counts.get('doc-2')?.openReconciliationCaseCount).toBe(1);
  });

  it('flags a holding as needing attention when it has no truth-status row at all', () => {
    // Never evaluated is not the same as certified — must not be silently
    // treated as fine.
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [{ id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' }],
      truthStatuses: [],
      publications: [],
    });
    expect(counts.get('doc-1')?.positionsNeedingAttentionCount).toBe(1);
  });

  it('does not flag a certified or certified_with_warnings position', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [
        { id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' },
        { id: 'h2', source_document_id: 'doc-1', account_id: 'a2', instrument_id: 'i2' },
      ],
      truthStatuses: [
        { account_id: 'a1', instrument_id: 'i1', status: 'certified' },
        { account_id: 'a2', instrument_id: 'i2', status: 'certified_with_warnings' },
      ],
      publications: [],
    });
    expect(counts.get('doc-1')?.positionsNeedingAttentionCount).toBe(0);
  });

  it('flags any other truth status (e.g. reconciliation_required, pending, failed) as needing attention', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [{ id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' }],
      truthStatuses: [{ account_id: 'a1', instrument_id: 'i1', status: 'reconciliation_required' }],
      publications: [],
    });
    expect(counts.get('doc-1')?.positionsNeedingAttentionCount).toBe(1);
  });

  it('counts total holdings per document regardless of publication state', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [
        { id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' },
        { id: 'h2', source_document_id: 'doc-1', account_id: 'a2', instrument_id: 'i2' },
      ],
      truthStatuses: [],
      publications: [],
    });
    expect(counts.get('doc-1')?.totalHoldingsCount).toBe(2);
    expect(counts.get('doc-1')?.publishedHoldingsCount).toBe(0);
  });

  it('counts a position as published when it has an active publication row (matched on the position)', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [
        { id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' },
        { id: 'h2', source_document_id: 'doc-1', account_id: 'a2', instrument_id: 'i2' },
      ],
      truthStatuses: [],
      publications: [{ canonical_position_id: 'h1', account_id: 'a1', instrument_id: 'i1', status: 'published' }],
    });
    expect(counts.get('doc-1')?.totalHoldingsCount).toBe(2);
    expect(counts.get('doc-1')?.publishedHoldingsCount).toBe(1);
  });

  it('does not count an unpublished or superseded publication row as a live publish', () => {
    // The exact distinction the 2026-09-29 fix depends on: a position the
    // user unpublished (or that was superseded by a later statement) must
    // not make the source document look "done".
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [{ id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' }],
      truthStatuses: [],
      publications: [{ canonical_position_id: 'h1', account_id: 'a1', instrument_id: 'i1', status: 'unpublished' }],
    });
    expect(counts.get('doc-1')?.publishedHoldingsCount).toBe(0);
  });

  it('ignores a holding with no source_document_id rather than throwing', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [{ id: 'h1', source_document_id: null, account_id: 'a1', instrument_id: 'i1' }],
      truthStatuses: [],
      publications: [],
    });
    expect(counts.size).toBe(0);
  });

  it('EMPTY_SOURCE_DOCUMENT_COUNTS is the correct all-zero fallback shape', () => {
    expect(EMPTY_SOURCE_DOCUMENT_COUNTS).toEqual({
      openReconciliationCaseCount: 0,
      positionsNeedingAttentionCount: 0,
      totalHoldingsCount: 0,
      publishedHoldingsCount: 0,
      readyToPublishCount: 0,
    });
  });
});

// 29-10-2026 (PO, production): "Parsed / 17 ready to publish" on a statement whose 17 positions were ALL published. The publication row is
// one-per-position and is made from the position's LATEST certified snapshot, which belongs to a different (newer) statement. Matching on the
// snapshot id alone therefore never saw it as published.
const pos = (n: number) => ({ account_id: `a${n}`, instrument_id: `i${n}` });
const holding = (doc: string, n: number, id = `${doc}-h${n}`) => ({ id, source_document_id: doc, ...pos(n) });
const truth = (n: number, status = 'certified') => ({ ...pos(n), status });
const pub = (n: number, snapshotId: string, status = 'published') => ({ canonical_position_id: snapshotId, ...pos(n), status });

describe('ready-to-publish count (certified AND not yet published)', () => {
  it("REGRESSION: 17 certified positions all published from a NEWER statement's snapshots read 17 published, 0 ready", () => {
    const nums = Array.from({ length: 17 }, (_, i) => i + 1);
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [...nums.map((n) => holding('old', n)), ...nums.map((n) => holding('new', n))],
      truthStatuses: nums.map((n) => truth(n)),
      publications: nums.map((n) => pub(n, `new-h${n}`)), // published from the NEWER statement's snapshot
    });
    const old = counts.get('old')!;
    expect(old.totalHoldingsCount).toBe(17);
    expect(old.publishedHoldingsCount).toBe(17);
    expect(old.readyToPublishCount).toBe(0);
    expect(old.positionsNeedingAttentionCount).toBe(0);
  });

  it('partially published: only the certified, unpublished positions are ready', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [1, 2, 3, 4].map((n) => holding('d', n)),
      truthStatuses: [1, 2, 3, 4].map((n) => truth(n)),
      publications: [pub(1, 'd-h1'), pub(2, 'elsewhere')],
    });
    const c = counts.get('d')!;
    expect(c.totalHoldingsCount).toBe(4);
    expect(c.publishedHoldingsCount).toBe(2);
    expect(c.readyToPublishCount).toBe(2);
  });

  it('certified WITH WARNINGS is ready (and counts as published once published)', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [holding('d', 1), holding('d', 2)],
      truthStatuses: [truth(1, 'certified_with_warnings'), truth(2, 'certified_with_warnings')],
      publications: [pub(2, 'd-h2')],
    });
    expect(counts.get('d')).toMatchObject({ readyToPublishCount: 1, publishedHoldingsCount: 1, positionsNeedingAttentionCount: 0 });
  });

  it('a position that is not certified is never "ready", it needs attention', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [holding('d', 1), holding('d', 2), holding('d', 3)],
      truthStatuses: [truth(1), truth(2, 'reconciliation_required')], // 3 has no truth row at all
      publications: [],
    });
    expect(counts.get('d')).toMatchObject({ readyToPublishCount: 1, positionsNeedingAttentionCount: 2 });
  });

  it('unpublished and not republished: ready again; unpublished then republished: published', () => {
    const base = { openCases: [], holdings: [holding('d', 1)], truthStatuses: [truth(1)] };
    const unpublished = computeSourceDocumentCounts({ ...base, publications: [pub(1, 'd-h1', 'unpublished')] }).get('d')!;
    expect(unpublished).toMatchObject({ readyToPublishCount: 1, publishedHoldingsCount: 0 });
    const republished = computeSourceDocumentCounts({ ...base, publications: [pub(1, 'd-h1', 'unpublished'), pub(1, 'd-h1', 'published')] }).get('d')!;
    expect(republished).toMatchObject({ readyToPublishCount: 0, publishedHoldingsCount: 1 });
  });

  it('a superseded or archived position (truth status) neither needs attention nor is ready', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [holding('d', 1), holding('d', 2)],
      truthStatuses: [truth(1, 'superseded'), truth(2, 'archived')],
      publications: [],
    });
    expect(counts.get('d')).toMatchObject({ readyToPublishCount: 0, positionsNeedingAttentionCount: 0, totalHoldingsCount: 2 });
  });

  it('two snapshot rows of the same position in one statement are one position, not two', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [holding('d', 1, 'd-a'), holding('d', 1, 'd-b')],
      truthStatuses: [truth(1)],
      publications: [pub(1, 'd-b')],
    });
    expect(counts.get('d')).toMatchObject({ totalHoldingsCount: 1, publishedHoldingsCount: 1, readyToPublishCount: 0 });
  });

  it('the exact-snapshot-id match still counts when the publication row carries no position columns', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [holding('d', 1)],
      truthStatuses: [truth(1)],
      publications: [{ canonical_position_id: 'd-h1', status: 'published' }],
    });
    expect(counts.get('d')).toMatchObject({ publishedHoldingsCount: 1, readyToPublishCount: 0 });
  });
});

describe('archived statements report no "to do" at all', () => {
  const input = {
    openCases: [{ source_document_id: 'arch' }, { source_document_id: 'live' }],
    holdings: [holding('arch', 1), holding('live', 2)],
    truthStatuses: [truth(1), truth(2, 'reconciliation_required')],
    publications: [],
    archivedDocumentIds: new Set(['arch']),
  };

  it("an archived statement's open issue, attention and ready counts are all zero (its totals are kept)", () => {
    const arch = computeSourceDocumentCounts(input).get('arch')!;
    expect(arch).toEqual({ openReconciliationCaseCount: 0, positionsNeedingAttentionCount: 0, totalHoldingsCount: 1, publishedHoldingsCount: 0, readyToPublishCount: 0 });
  });

  it('a live statement beside it is unaffected', () => {
    const live = computeSourceDocumentCounts(input).get('live')!;
    expect(live).toMatchObject({ openReconciliationCaseCount: 1, positionsNeedingAttentionCount: 1 });
  });

  it('control: without the archived set the same data DOES count the issue (the exclusion is what zeroes it)', () => {
    const { archivedDocumentIds: omitted, ...rest } = input;
    void omitted;
    const arch = computeSourceDocumentCounts(rest).get('arch')!;
    expect(arch.openReconciliationCaseCount).toBe(1);
    expect(arch.readyToPublishCount).toBe(1);
  });
});
