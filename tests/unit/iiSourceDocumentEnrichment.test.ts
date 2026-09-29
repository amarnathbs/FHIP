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

  it('counts a holding as published only when its exact canonical_position_id has an active publication', () => {
    const counts = computeSourceDocumentCounts({
      openCases: [],
      holdings: [
        { id: 'h1', source_document_id: 'doc-1', account_id: 'a1', instrument_id: 'i1' },
        { id: 'h2', source_document_id: 'doc-1', account_id: 'a2', instrument_id: 'i2' },
      ],
      truthStatuses: [],
      publications: [{ canonical_position_id: 'h1', status: 'published' }],
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
      publications: [{ canonical_position_id: 'h1', status: 'unpublished' }],
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
    });
  });
});
