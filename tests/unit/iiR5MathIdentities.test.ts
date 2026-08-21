// Investment Intelligence R5 — mandatory mathematical-identity tests
// (spec sections 85-86, 88).
//
// These assert PROPERTIES that must hold for any input, not just the
// certification fixtures: the exact weighted look-through identity, overlap
// symmetry, overlap bounds, the HHI convention, and the no-double-count
// weight identity that makes look-through attribution rather than additional
// wealth.

import { describe, it, expect } from 'vitest';
import {
  calculatePortfolioLookThrough,
  selectSnapshotAsOf,
  classifyFreshness,
  calculateFundCoverage,
  type FundHoldingsSnapshot,
  type PortfolioFundPosition,
} from '@/lib/engines/investment-intelligence/xray/lookThrough';
import { calculateFundOverlap, calculateOverlapMatrix } from '@/lib/engines/investment-intelligence/xray/overlap';
import { calculateSecurityConcentration } from '@/lib/engines/investment-intelligence/xray/concentration';

function snap(fundInstrumentId: string, holdingsAsOfDate: string, holdings: Array<[string | null, number, string?]>): FundHoldingsSnapshot {
  return {
    snapshotId: `${fundInstrumentId}-${holdingsAsOfDate}`,
    fundInstrumentId,
    holdingsAsOfDate,
    sourceKey: 'test',
    sourceDataVersion: 'v1',
    classificationVersion: 'v1',
    holdings: holdings.map(([canonicalId, weightPct, kind]) => ({
      canonicalId,
      displayName: canonicalId ?? 'UNRESOLVED',
      weightPct,
      assetKind: (kind as 'security' | 'cash' | 'derivative' | 'other') ?? 'security',
    })),
  };
}
function pos(fundInstrumentId: string, value: number): PortfolioFundPosition {
  return { fundInstrumentId, fundName: fundInstrumentId, value, currencyCode: 'INR' };
}
function mapOf(...snaps: FundHoldingsSnapshot[]): Map<string, FundHoldingsSnapshot[]> {
  const m = new Map<string, FundHoldingsSnapshot[]>();
  for (const s of snaps) {
    if (!m.has(s.fundInstrumentId)) m.set(s.fundInstrumentId, []);
    m.get(s.fundInstrumentId)!.push(s);
  }
  return m;
}

describe('R5 weighted look-through — exact identity', () => {
  it('Fund A 60% holding X at 10% + Fund B 40% holding X at 20% = EXACTLY 14%', () => {
    const r = calculatePortfolioLookThrough(
      [pos('FA', 600_000), pos('FB', 400_000)],
      mapOf(snap('FA', '2024-06-01', [['X', 10], ['OA', 90]]), snap('FB', '2024-06-01', [['X', 20], ['OB', 80]])),
      '2024-06-30',
      '2024-06-30'
    );
    const x = r.exposures.find((e) => e.canonicalId === 'X');
    expect(x).toBeDefined();
    // 0.60 × 0.10 + 0.40 × 0.20 = 0.06 + 0.08 = 0.14
    expect(Math.abs(x!.effectiveWeight - 0.14)).toBeLessThanOrEqual(1e-8);
    expect(x!.schemeCount).toBe(2);
  });

  it("the spec's worked example: 40%-weighted fund holding 8% Reliance contributes 3.2%, plus 2% from another fund = 5.2%", () => {
    // Fund B is sized so its Reliance contribution is exactly 2.0%:
    // 0.60 portfolio weight × 3.3333...% holding weight = 2.0%
    const r = calculatePortfolioLookThrough(
      [pos('FA', 400_000), pos('FB', 600_000)],
      mapOf(
        snap('FA', '2024-06-01', [['RELIANCE', 8], ['OA', 92]]),
        snap('FB', '2024-06-01', [['RELIANCE', 10 / 3], ['OB', 100 - 10 / 3]])
      ),
      '2024-06-30',
      '2024-06-30'
    );
    const rel = r.exposures.find((e) => e.canonicalId === 'RELIANCE')!;
    expect(Math.abs(rel.contributingFunds[0].contribution - 0.032)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(rel.contributingFunds[1].contribution - 0.02)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(rel.effectiveWeight - 0.052)).toBeLessThanOrEqual(1e-8);
  });

  it('NO DOUBLE COUNT: all weight buckets sum to exactly 1', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 500_000), pos('F2', 300_000), pos('F3', 200_000)],
      mapOf(
        snap('F1', '2024-06-01', [['S1', 50], ['S2', 30], [null, 10], [null, 5, 'cash']]),
        snap('F2', '2024-06-01', [['S2', 60], [null, 20, 'derivative']])
      ),
      '2024-06-30',
      '2024-06-30'
    );
    const total =
      r.exposures.reduce((s, e) => s + e.effectiveWeight, 0) +
      r.cashWeight + r.derivativeWeight + r.otherWeight + r.unresolvedWeight + r.noSnapshotWeight + r.undisclosedRemainderWeight;
    expect(Math.abs(total - 1)).toBeLessThanOrEqual(1e-8);
  });

  it('effective VALUES sum back to the original portfolio value — look-through adds no wealth', () => {
    const positions = [pos('F1', 700_000), pos('F2', 300_000)];
    const r = calculatePortfolioLookThrough(
      positions,
      mapOf(snap('F1', '2024-06-01', [['S1', 60], ['S2', 40]]), snap('F2', '2024-06-01', [['S2', 100]])),
      '2024-06-30',
      '2024-06-30'
    );
    const looked = r.exposures.reduce((s, e) => s + e.effectiveValue, 0);
    expect(Math.abs(looked - 1_000_000)).toBeLessThanOrEqual(1e-6);
    expect(r.totalPortfolioValue).toBe(1_000_000);
  });
});

describe('R5 overlap — mathematical identities', () => {
  const a = snap('FA', '2024-06-01', [['S1', 30], ['S2', 25], ['S3', 45]]);
  const b = snap('FB', '2024-06-01', [['S1', 15], ['S3', 60], ['S4', 25]]);

  it('symmetry: Overlap(A,B) === Overlap(B,A)', () => {
    const ab = calculateFundOverlap(a, b, '2024-06-30');
    const ba = calculateFundOverlap(b, a, '2024-06-30');
    expect(ab.weightedOverlap).toBeCloseTo(ba.weightedOverlap!, 15);
    expect(ab.weightedOverlap).toBe(ba.weightedOverlap);
  });

  it('bounds: 0 <= overlap <= 1 for every pair, including degenerate ones', () => {
    const fixtures: Array<[FundHoldingsSnapshot, FundHoldingsSnapshot]> = [
      [a, b],
      [a, a],
      [snap('X', '2024-06-01', [['S1', 100]]), snap('Y', '2024-06-01', [['S2', 100]])],
      [snap('X', '2024-06-01', [['S1', 100]]), snap('Y', '2024-06-01', [['S1', 100]])],
      [snap('X', '2024-06-01', [[null, 100]]), snap('Y', '2024-06-01', [[null, 100]])],
      [snap('X', '2024-06-01', [['S1', 1], ['S2', 99]]), snap('Y', '2024-06-01', [['S1', 99], ['S2', 1]])],
    ];
    for (const [p, q] of fixtures) {
      const r = calculateFundOverlap(p, q, '2024-06-30');
      expect(r.weightedOverlap).toBeGreaterThanOrEqual(0);
      expect(r.weightedOverlap).toBeLessThanOrEqual(1);
    }
  });

  it('identical portfolios overlap exactly 100%', () => {
    const r = calculateFundOverlap(a, snap('FB', '2024-06-01', [['S1', 30], ['S2', 25], ['S3', 45]]), '2024-06-30');
    expect(Math.abs(r.weightedOverlap! - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('disjoint portfolios overlap exactly 0%', () => {
    const r = calculateFundOverlap(snap('X', '2024-06-01', [['S1', 100]]), snap('Y', '2024-06-01', [['S9', 100]]), '2024-06-30');
    expect(r.weightedOverlap).toBe(0);
    expect(r.commonSecurityCount).toBe(0);
  });

  it('the worked example: X at 5% in A and 8% in B contributes exactly min = 5%', () => {
    const r = calculateFundOverlap(
      snap('FA', '2024-06-01', [['X', 5], ['A1', 95]]),
      snap('FB', '2024-06-01', [['X', 8], ['B1', 92]]),
      '2024-06-30'
    );
    expect(Math.abs(r.weightedOverlap! - 0.05)).toBeLessThanOrEqual(1e-12);
    expect(r.topCommonHoldings![0].overlapContribution).toBeCloseTo(0.05, 12);
  });

  it('unresolved holdings are NEVER treated as matched, even with identical names', () => {
    const r = calculateFundOverlap(
      snap('FA', '2024-06-01', [[null, 100]]),
      snap('FB', '2024-06-01', [[null, 100]]),
      '2024-06-30'
    );
    expect(r.weightedOverlap).toBe(0);
    expect(r.commonSecurityCount).toBe(0);
    expect(r.unresolvedWeightA).toBeCloseTo(1, 12);
  });

  it('the full matrix is symmetric and bounded', () => {
    const funds = ['A', 'B', 'C', 'D'].map((k, i) => ({
      fundInstrumentId: k,
      fundName: k,
      snapshot: snap(k, '2024-06-01', [['S1', 20 + i * 5], ['S2', 30], [`S${i + 3}`, 50 - i * 5]]),
    }));
    const m = calculateOverlapMatrix(funds, '2024-06-30');
    for (let i = 0; i < m.matrix.length; i++) {
      for (let j = 0; j < m.matrix.length; j++) {
        expect(m.matrix[i][j]).toBe(m.matrix[j][i]);
        const v = m.matrix[i][j];
        if (v !== null) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      expect(m.matrix[i][i]).toBe(1);
    }
  });
});

describe('R5 concentration — HHI convention', () => {
  it('one security at 100% gives HHI exactly 1.0 (decimal-weight convention)', () => {
    const lt = calculatePortfolioLookThrough([pos('F1', 100_000)], mapOf(snap('F1', '2024-06-01', [['S1', 100]])), '2024-06-30', '2024-06-30');
    const c = calculateSecurityConcentration(lt);
    expect(c.hhi).toBeCloseTo(1.0, 12);
    expect(c.hhiConvention).toBe('decimal_weights_0_to_1');
  });

  it('ten equal securities give HHI exactly 0.1', () => {
    const lt = calculatePortfolioLookThrough(
      [pos('F1', 100_000)],
      mapOf(snap('F1', '2024-06-01', Array.from({ length: 10 }, (_, i) => [`S${i}`, 10] as [string, number]))),
      '2024-06-30',
      '2024-06-30'
    );
    const c = calculateSecurityConcentration(lt);
    expect(Math.abs(c.hhi! - 0.1)).toBeLessThanOrEqual(1e-8);
  });
});

describe('R5 snapshot selection — no look-ahead', () => {
  it('never selects a FUTURE snapshot for an earlier analytics date', () => {
    const snaps = [snap('F1', '2024-01-31', [['OLD', 100]]), snap('F1', '2024-05-31', [['CURRENT', 100]]), snap('F1', '2024-09-30', [['FUTURE', 100]])];
    const chosen = selectSnapshotAsOf(snaps, '2024-06-30');
    expect(chosen!.holdingsAsOfDate).toBe('2024-05-31');
    expect(chosen!.holdings[0].canonicalId).toBe('CURRENT');
  });

  it('older snapshots are preserved, not destroyed, and remain selectable for their own date', () => {
    const snaps = [snap('F1', '2024-01-31', [['OLD', 100]]), snap('F1', '2024-05-31', [['CURRENT', 100]])];
    expect(selectSnapshotAsOf(snaps, '2024-02-15')!.holdings[0].canonicalId).toBe('OLD');
    expect(selectSnapshotAsOf(snaps, '2024-06-15')!.holdings[0].canonicalId).toBe('CURRENT');
  });

  it('a snapshot dated after the as-of date is classified MISSING, never CURRENT', () => {
    expect(classifyFreshness('2024-09-30', '2024-06-30')).toBe('MISSING');
    expect(classifyFreshness('2024-06-01', '2024-06-30')).toBe('CURRENT');
    expect(classifyFreshness('2024-04-15', '2024-06-30')).toBe('ACCEPTABLE'); // 76 days
    expect(classifyFreshness('2024-03-01', '2024-06-30')).toBe('STALE'); // 121 days, past the 100-day acceptable band
    expect(classifyFreshness('2023-12-15', '2024-06-30')).toBe('STALE'); // 198 days
    expect(classifyFreshness('2023-12-01', '2024-06-30')).toBe('VERY_STALE'); // 212 days, past the 210-day stale ceiling
    expect(classifyFreshness('2023-01-01', '2024-06-30')).toBe('VERY_STALE');
    expect(classifyFreshness(null, '2024-06-30')).toBe('MISSING');
  });
});

describe('R5 coverage — no blind rescaling', () => {
  it('an 87% disclosure stays 87%, with the remainder retained explicitly', () => {
    const cov = calculateFundCoverage(snap('F1', '2024-06-01', [['S1', 50], ['S2', 37]]));
    expect(Math.abs(cov.reportedHoldingsCoverage - 0.87)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(cov.undisclosedRemainder - 0.13)).toBeLessThanOrEqual(1e-8);
    expect(cov.weightSumWithinRoundingTolerance).toBe(false);
  });

  it('a 100.02% file is treated as rounding noise, not as negative remainder', () => {
    const cov = calculateFundCoverage(snap('F1', '2024-06-01', [['S1', 50.01], ['S2', 50.01]]));
    expect(cov.undisclosedRemainder).toBe(0);
    expect(cov.weightSumWithinRoundingTolerance).toBe(true);
  });

  it('cash weight is preserved, never redistributed across disclosed equities', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 1_000_000)],
      mapOf(snap('F1', '2024-06-01', [['S1', 85], [null, 15, 'cash']])),
      '2024-06-30',
      '2024-06-30'
    );
    expect(Math.abs(r.exposures[0].effectiveWeight - 0.85)).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(r.cashWeight - 0.15)).toBeLessThanOrEqual(1e-8);
  });
});
