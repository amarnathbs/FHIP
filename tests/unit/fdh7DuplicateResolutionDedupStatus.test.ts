/**
 * FDH-8 closure (2026-08-25) — regression test for a real live-DEV finding:
 * `resolveDuplicateCandidate()` used to mark BOTH sides of a resolved
 * duplicate pair with the SAME `dedup_status`. Since
 * `computeApprovedFinancialSummary` (`domain/approvedSummary.ts`) excludes
 * EVERY row whose `dedup_status` is `'user_confirmed_duplicate'` from every
 * total, a resolved pair contributed $0 to every total instead of the kept
 * transaction's amount exactly once — reproduced live: a $6.50 duplicate
 * pair resolved as `'removed_b'` produced $0.00 approved expense instead of
 * $6.50 (see `docs/financial-data-hub/FDH8_LIVE_DEV_CERTIFICATION.md`,
 * Live Case 4).
 *
 * This tests the pure per-side mapping function directly — no Supabase
 * mocking needed (matches this codebase's own stated preference for
 * testing pure logic separately from I/O, `resolveDedupStatusPerSide` was
 * extracted from `resolveDuplicateCandidate` specifically for this).
 */
import { describe, expect, it } from 'vitest';
import { resolveDedupStatusPerSide } from '@/lib/financial-data-hub/services/bankTransactionActionsService';

describe('resolveDedupStatusPerSide', () => {
  it('kept_both: BOTH sides remain counted (user_confirmed_distinct)', () => {
    expect(resolveDedupStatusPerSide('kept_both')).toEqual({ a: 'user_confirmed_distinct', b: 'user_confirmed_distinct' });
  });

  it('removed_a: side A is excluded, side B stays counted — NEVER both excluded', () => {
    const result = resolveDedupStatusPerSide('removed_a');
    expect(result.a).toBe('user_confirmed_duplicate');
    expect(result.b).toBe('user_confirmed_distinct');
  });

  it('removed_b: side B is excluded, side A stays counted — NEVER both excluded', () => {
    const result = resolveDedupStatusPerSide('removed_b');
    expect(result.a).toBe('user_confirmed_distinct');
    expect(result.b).toBe('user_confirmed_duplicate');
  });

  it('merged: exactly one side survives counted, the other is excluded — NEVER both excluded, NEVER both counted', () => {
    const result = resolveDedupStatusPerSide('merged');
    const excludedCount = [result.a, result.b].filter((s) => s === 'user_confirmed_duplicate').length;
    const countedCount = [result.a, result.b].filter((s) => s === 'user_confirmed_distinct').length;
    expect(excludedCount).toBe(1);
    expect(countedCount).toBe(1);
  });

  it('NEGATIVE CONTROL — for every real resolution, it is never the case that both sides are excluded', () => {
    for (const resolution of ['kept_both', 'removed_a', 'removed_b', 'merged'] as const) {
      const result = resolveDedupStatusPerSide(resolution);
      const bothExcluded = result.a === 'user_confirmed_duplicate' && result.b === 'user_confirmed_duplicate';
      expect(bothExcluded, `resolution=${resolution} excluded BOTH sides — this is the exact defect this test guards against (the pair would contribute $0, not counted once)`).toBe(false);
    }
  });
});
