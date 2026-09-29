import { describe, it, expect } from 'vitest';
import { buildAmcPieSlices, AMC_PIE_MAX_SLICES, type AmcBucket } from '@/components/investment-intelligence/amcConcentrationChart';

// Coverage for the 2026-09-29 AMC/fund-house pie-chart addition to
// PortfolioXrayClient. calculateAmcConcentration()
// (lib/engines/investment-intelligence/xray/concentration.ts) returns one
// bucket per AMC with no upper bound, so this pure grouping function is what
// keeps the pie chart legible -- these tests assert its behaviour directly,
// independent of the client component's JSX.

function bucket(amcId: string, weight: number, schemeCount = 1): AmcBucket {
  return { amcId, amcName: `${amcId} Mutual Fund`, weight, schemeCount };
}

describe('buildAmcPieSlices', () => {
  it('returns an empty array for zero buckets (never fabricates a slice)', () => {
    expect(buildAmcPieSlices([])).toEqual([]);
  });

  it('passes buckets through unchanged, one slice per AMC, when at or under the max slice count', () => {
    const buckets = [bucket('A', 0.5, 3), bucket('B', 0.3, 2), bucket('C', 0.2, 1)];
    const slices = buildAmcPieSlices(buckets, 7);
    expect(slices).toHaveLength(3);
    expect(slices.every((s) => s.isOther === false)).toBe(true);
    expect(slices.map((s) => s.key)).toEqual(['A', 'B', 'C']);
    // weight/schemeCount are carried through verbatim -- no new computation.
    expect(slices[0]).toMatchObject({ key: 'A', name: 'A Mutual Fund', weight: 0.5, schemeCount: 3 });
  });

  it('does not add an "Other" slice when bucket count exactly equals the max', () => {
    const buckets = Array.from({ length: AMC_PIE_MAX_SLICES }, (_, i) => bucket(`AMC${i}`, 1 / AMC_PIE_MAX_SLICES));
    const slices = buildAmcPieSlices(buckets);
    expect(slices).toHaveLength(AMC_PIE_MAX_SLICES);
    expect(slices.some((s) => s.isOther)).toBe(false);
  });

  it('collapses the tail into a single "Other" slice once bucket count exceeds the max, preserving total weight', () => {
    // 10 AMCs, strictly descending weight, summing to 1.
    const buckets = [0.3, 0.2, 0.15, 0.1, 0.08, 0.07, 0.04, 0.03, 0.02, 0.01].map((w, i) => bucket(`AMC${i}`, w, i + 1));
    const slices = buildAmcPieSlices(buckets, 7);

    // 6 largest kept individually + 1 "Other" slice = 7 total.
    expect(slices).toHaveLength(7);
    const other = slices.find((s) => s.isOther);
    expect(other).toBeDefined();
    expect(other!.name).toBe('Other (4 fund houses)');

    // The 4 smallest (0.04 + 0.03 + 0.02 + 0.01) and their scheme counts (7+8+9+10).
    expect(other!.weight).toBeCloseTo(0.1, 10);
    expect(other!.schemeCount).toBe(34);

    // Total weight across all slices is conserved exactly -- grouping must
    // never lose or fabricate exposure.
    const totalWeight = slices.reduce((s, x) => s + x.weight, 0);
    const inputTotal = buckets.reduce((s, b) => s + b.weight, 0);
    expect(totalWeight).toBeCloseTo(inputTotal, 10);

    // The 6 largest individual buckets are the 6 largest inputs, unmodified.
    const individualKeys = slices.filter((s) => !s.isOther).map((s) => s.key);
    expect(individualKeys).toEqual(['AMC0', 'AMC1', 'AMC2', 'AMC3', 'AMC4', 'AMC5']);
  });

  it('does not assume the input is pre-sorted -- groups by weight regardless of input order', () => {
    const buckets = [bucket('SMALL', 0.01, 1), bucket('BIG', 0.9, 5), bucket('MID', 0.09, 2)];
    const slices = buildAmcPieSlices(buckets, 2);
    // Max 2 slices requested with 3 buckets -> BIG kept individually, the
    // other two (SMALL + MID) collapsed into "Other" regardless of the
    // order they were passed in.
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ key: 'BIG', isOther: false });
    expect(slices[1].isOther).toBe(true);
    expect(slices[1].weight).toBeCloseTo(0.1, 10);
  });

  it('a single AMC (100% concentration) renders as exactly one slice, never split or padded', () => {
    const slices = buildAmcPieSlices([bucket('ONLY', 1, 4)]);
    expect(slices).toEqual([{ key: 'ONLY', name: 'ONLY Mutual Fund', weight: 1, schemeCount: 4, isOther: false }]);
  });
});
