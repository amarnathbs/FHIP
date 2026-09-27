// NAV 1 -- PO decision #1 (27 Sep 2026): pure coverage-gap and coverage-alert
// decision functions. See lib/services/investment-intelligence/pc6/navCoverage.ts
// for the "why derive expected from the source's own file" rationale.

import { describe, it, expect } from 'vitest';
import {
  computeCoverageGap,
  decideCoverageComplete,
  evaluateCoverageAlert,
  COVERAGE_MATERIAL_DROP_RATIO,
  COVERAGE_MIN_BASELINE_SAMPLES,
} from '@/lib/services/investment-intelligence/pc6/navCoverage';

describe('computeCoverageGap', () => {
  it('everything present -> zero gap', () => {
    const g = computeCoverageGap(['a', 'b', 'c'], new Set(['a', 'b', 'c']));
    expect(g).toEqual({ expectedCount: 3, presentCount: 3, missingInstrumentIds: [], missingCount: 0 });
  });

  it('names exactly the missing ids, in expected order', () => {
    const g = computeCoverageGap(['a', 'b', 'c', 'd'], new Set(['a', 'c']));
    expect(g.expectedCount).toBe(4);
    expect(g.presentCount).toBe(2);
    expect(g.missingInstrumentIds).toEqual(['b', 'd']);
    expect(g.missingCount).toBe(2);
  });

  it('de-duplicates the expected list (a resolved scheme counted once)', () => {
    const g = computeCoverageGap(['a', 'a', 'b'], new Set(['a']));
    expect(g.expectedCount).toBe(2);
    expect(g.missingInstrumentIds).toEqual(['b']);
  });

  it('empty expected set is trivially complete', () => {
    const g = computeCoverageGap([], new Set());
    expect(g).toEqual({ expectedCount: 0, presentCount: 0, missingInstrumentIds: [], missingCount: 0 });
  });

  it('NEGATIVE CONTROL: a present set that is a strict subset of expected is NOT reported complete', () => {
    const g = computeCoverageGap(['a', 'b'], new Set(['a']));
    expect(decideCoverageComplete(g.missingCount)).toBe(false);
  });
});

describe('decideCoverageComplete', () => {
  it('true only at exactly zero missing', () => {
    expect(decideCoverageComplete(0)).toBe(true);
    expect(decideCoverageComplete(1)).toBe(false);
    expect(decideCoverageComplete(9999)).toBe(false);
  });
});

describe('evaluateCoverageAlert', () => {
  it('does not alert with fewer than the minimum baseline samples', () => {
    const d = evaluateCoverageAlert({ presentCount: 1, recentPresentCounts: [8700, 8710] });
    expect(d.shouldAlert).toBe(false);
    expect(d.coverageRatio).toBeNull();
    expect(d.detail).toMatch(/need 3/);
    expect(COVERAGE_MIN_BASELINE_SAMPLES).toBe(3);
  });

  it('alerts when present is materially below the baseline', () => {
    const d = evaluateCoverageAlert({ presentCount: 5000, recentPresentCounts: [8700, 8710, 8690, 8705] });
    expect(d.shouldAlert).toBe(true);
    expect(d.baselineUsed).toBeCloseTo(8701.25, 1);
    expect(d.coverageRatio).toBeCloseTo(5000 / 8701.25, 4);
    expect(d.detail).toMatch(/below the 85% material-drop threshold/);
  });

  it('NEGATIVE CONTROL: does not alert when present is close to (not below) the baseline', () => {
    const d = evaluateCoverageAlert({ presentCount: 8600, recentPresentCounts: [8700, 8710, 8690, 8705] });
    expect(d.shouldAlert).toBe(false);
    expect(d.coverageRatio).toBeGreaterThan(0.85);
  });

  it('exactly at the threshold does not alert (strict less-than)', () => {
    const baseline = 8700;
    const atThreshold = Math.ceil(baseline * COVERAGE_MATERIAL_DROP_RATIO);
    const d = evaluateCoverageAlert({ presentCount: baseline, recentPresentCounts: [baseline, baseline, baseline] });
    expect(d.shouldAlert).toBe(false);
    const d2 = evaluateCoverageAlert({ presentCount: atThreshold - 1, recentPresentCounts: [baseline, baseline, baseline] });
    expect(d2.shouldAlert).toBe(true);
  });

  it('a custom drop ratio and minimum sample count are honoured', () => {
    const d = evaluateCoverageAlert({ presentCount: 90, recentPresentCounts: [100, 100], materialDropRatio: 0.95, minBaselineSamples: 2 });
    expect(d.shouldAlert).toBe(true);
  });

  it('zero/negative baseline never alerts (would be a divide-by-zero without this guard)', () => {
    const d = evaluateCoverageAlert({ presentCount: 5, recentPresentCounts: [0, 0, 0] });
    expect(d.shouldAlert).toBe(false);
    expect(d.detail).toMatch(/zero or negative/);
  });
});
