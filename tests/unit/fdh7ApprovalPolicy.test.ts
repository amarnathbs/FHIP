import { describe, expect, it } from 'vitest';
import {
  compareReviewPriority,
  reviewPriorityRank,
  runBulkAction,
  FDH7_REVIEW_PRIORITY_ORDER,
} from '@/lib/financial-data-hub/domain/approvalPolicy';

describe('FDH-7 review priority ordering (spec 21)', () => {
  it('reconciliation variance ranks above every per-transaction reason', () => {
    const reconciliation = reviewPriorityRank(['UNKNOWN_CLASSIFICATION'], true);
    const duplicate = reviewPriorityRank(['POSSIBLE_DUPLICATE']);
    expect(reconciliation).toBeLessThan(duplicate);
  });

  it('possible duplicate ranks above possible transfer, which ranks above unknown classification', () => {
    const dup = reviewPriorityRank(['POSSIBLE_DUPLICATE']);
    const transfer = reviewPriorityRank(['POSSIBLE_TRANSFER']);
    const unknown = reviewPriorityRank(['UNKNOWN_CLASSIFICATION']);
    expect(dup).toBeLessThan(transfer);
    expect(transfer).toBeLessThan(unknown);
  });

  it('an item with no reasons ranks last (Infinity)', () => {
    expect(reviewPriorityRank([])).toBe(Number.POSITIVE_INFINITY);
  });

  it('a multi-reason item takes its MOST urgent reason\'s rank', () => {
    const rank = reviewPriorityRank(['POSSIBLE_REFUND', 'POSSIBLE_DUPLICATE']);
    expect(rank).toBe(FDH7_REVIEW_PRIORITY_ORDER.indexOf('POSSIBLE_DUPLICATE'));
  });

  it('compareReviewPriority sorts a mixed list into the documented priority order, with deterministic tie-breaking', () => {
    const items = [
      { reasons: ['LOW_CLASSIFICATION_CONFIDENCE'] as const, tieBreakKey: 'z' },
      { reasons: [], tieBreakKey: 'ready' },
      { reasons: ['POSSIBLE_DUPLICATE'] as const, tieBreakKey: 'b' },
      { reasons: ['POSSIBLE_DUPLICATE'] as const, tieBreakKey: 'a' },
      { reasons: [], hasReconciliationVariance: true, tieBreakKey: 'recon' },
    ];
    const sorted = [...items].sort(compareReviewPriority);
    expect(sorted.map((i) => i.tieBreakKey)).toEqual(['recon', 'a', 'b', 'z', 'ready']);
  });
});

describe('FDH-7 bulk-action partial-failure contract (spec 50, 96)', () => {
  it('99 valid + 1 invalid: exactly 99 succeed, 1 fails explicitly, none silently skipped', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    const blocked = 'id-42';
    const result = await runBulkAction(ids, async (id) => {
      if (id === blocked) throw new Error('blocking review issue');
    });
    expect(result.requested).toBe(100);
    expect(result.succeeded).toBe(99);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(100); // every id explicitly accounted for
    const blockedResult = result.results.find((r) => r.id === blocked);
    expect(blockedResult?.ok).toBe(false);
    expect(blockedResult?.error).toContain('blocking review issue');
  });

  it('one blocked item never vetoes the other 99 (contract is per-item, not all-or-nothing)', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    const result = await runBulkAction(ids, async (id) => {
      if (id === 'id-0') throw new Error('blocked');
    });
    expect(result.results.filter((r) => r.ok)).toHaveLength(99);
  });

  it('all valid: 100/100 succeed', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
    const result = await runBulkAction(ids, async () => {});
    expect(result.succeeded).toBe(100);
    expect(result.failed).toBe(0);
  });
});
