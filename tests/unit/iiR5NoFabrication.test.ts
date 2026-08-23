// Investment Intelligence R5 — mandatory NO-FABRICATION proofs
// (spec section 89, and critical-FAIL items 4-6, 11-17).
//
// The governing principle: "UNAVAILABLE" IS NEVER "ZERO". Every test here
// takes a situation where the honest answer is "we cannot tell you", and
// asserts the engine says exactly that instead of returning a plausible
// number, an empty chart of zeros, or a falsely confident label.
//
// This directly extends R4's own discovered-and-fixed benchmark-coverage
// lesson to R5's surface area.

import { describe, it, expect } from 'vitest';
import { detectSipSeries, type SipCandidateTransaction } from '@/lib/engines/investment-intelligence/sip/sipDetection';
import { attributeSipUnits } from '@/lib/engines/investment-intelligence/sip/sipAttribution';
import { calculateActualSipXirr, calculateBenchmarkSip, calculateSipExcessReturn, calculateSipWealthComparison } from '@/lib/engines/investment-intelligence/sip/sipXirr';
import { classifySipActivity } from '@/lib/engines/investment-intelligence/sip/sipConsistency';
import { calculatePortfolioLookThrough, type FundHoldingsSnapshot, type PortfolioFundPosition } from '@/lib/engines/investment-intelligence/xray/lookThrough';
import { calculateSecurityConcentration, calculateSectorExposure, calculateMarketCapExposure, calculateIndustryExposure } from '@/lib/engines/investment-intelligence/xray/concentration';
import { calculateCreditQuality, calculateWeightedDuration, type DebtExposureLine } from '@/lib/engines/investment-intelligence/xray/debtXray';
import { resolveUnderlyingSecurity, buildResolutionIndex } from '@/lib/engines/investment-intelligence/xray/securityResolution';

let seq = 0;
function t(over: Partial<SipCandidateTransaction>): SipCandidateTransaction {
  seq += 1;
  return {
    id: `T${seq}`,
    accountId: 'A',
    instrumentId: 'I',
    transactionType: 'sip',
    transactionDate: '2023-01-05',
    grossAmount: 5000,
    units: 50,
    currencyCode: 'INR',
    sourceDescription: 'SIP INSTALMENT',
    ...over,
  };
}
function monthly(n: number, over: Partial<SipCandidateTransaction> = {}): SipCandidateTransaction[] {
  return Array.from({ length: n }, (_, k) =>
    t({ transactionDate: `2022-${String((k % 12) + 1).padStart(2, '0')}-05`.replace('2022', String(2022 + Math.floor(k / 12))), ...over })
  );
}

describe('NO FABRICATION — SIP', () => {
  it('a missing benchmark produces MISSING_BENCHMARK, never a rate of 0', () => {
    const series = detectSipSeries(monthly(24))[0];
    const r = calculateBenchmarkSip(series, { benchmarkSeries: null, asOfDate: '2024-06-30' });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('MISSING_BENCHMARK');
    expect(r.rate).toBeUndefined();
    expect(r.terminalValue).toBeUndefined();
  });

  it('benchmark history that misses even ONE contribution date is refused, not partially reported', () => {
    const series = detectSipSeries(monthly(24))[0];
    // Series starts only in 2023, so 2022 contributions cannot be aligned.
    const bm = Array.from({ length: 400 }, (_, i) => ({
      date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10),
      value: 1000 + i,
    }));
    const r = calculateBenchmarkSip(series, { benchmarkSeries: bm, asOfDate: '2024-01-31' });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('INCOMPLETE_BENCHMARK_HISTORY');
    expect(r.rate).toBeUndefined();
    // The partial work IS retained for transparency, but never presented as a result.
    expect(r.unalignedContributions!.length).toBeGreaterThan(0);
  });

  it('an unavailable benchmark makes the excess return unavailable, never actual-minus-zero', () => {
    const txns = monthly(24);
    const series = detectSipSeries(txns)[0];
    const actual = calculateActualSipXirr(series, attributeSipUnits(series, txns, '2024-06-30'), { asOfDate: '2024-06-30', navAtAsOf: 120 });
    expect(actual.status).toBe('ok'); // the ACTUAL leg is genuinely available...
    const bm = calculateBenchmarkSip(series, { benchmarkSeries: null, asOfDate: '2024-06-30' });
    const excess = calculateSipExcessReturn(actual, bm, series);
    expect(excess.status).toBe('unavailable');
    expect(excess.excessReturn).toBeUndefined();
    expect(excess.label).toBe('SIP benchmark excess return');
  });

  it('the excess-return label is NEVER "alpha"', () => {
    const series = detectSipSeries(monthly(6))[0];
    const r = calculateSipExcessReturn(
      { status: 'unavailable', method: 'sip-xirr-r5-v1' as never, xirrMethod: 'xirr-newton-bisection-v1' as never },
      { status: 'unavailable', method: 'benchmark-sip-identical-cashflow-r5-v1' as never, dateAlignmentMethod: 'next-available-on-or-after-v1' as never, xirrMethod: 'xirr-newton-bisection-v1' as never },
      series
    );
    expect(r.label.toLowerCase()).not.toContain('alpha');
    expect(r.label).toBe('SIP benchmark excess return');
  });

  it('missing units make attribution UNAVAILABLE and suppress the SIP-specific XIRR entirely', () => {
    const txns = monthly(12);
    txns[5] = { ...txns[5], units: null };
    const series = detectSipSeries(txns)[0];
    const attr = attributeSipUnits(series, txns, '2024-06-30');
    expect(attr.status).toBe('unavailable');
    expect(attr.reason).toBe('MISSING_UNITS_ON_CONTRIBUTION');

    const xirrResult = calculateActualSipXirr(series, attr, { asOfDate: '2024-06-30', navAtAsOf: 150 });
    expect(xirrResult.status).toBe('unavailable');
    expect(xirrResult.reason).toBe('ATTRIBUTION_UNAVAILABLE');
    expect(xirrResult.rate).toBeUndefined();
    // and it must say the fund-level figure is still available, not imply total failure
    expect(xirrResult.detail).toMatch(/fund-level/i);
  });

  it('a missing NAV suppresses the ending value rather than assuming zero or last-known', () => {
    const txns = monthly(12);
    const series = detectSipSeries(txns)[0];
    const attr = attributeSipUnits(series, txns, '2024-06-30');
    expect(attr.status).toBe('ok'); // attribution is fine; only the NAV is missing
    const r = calculateActualSipXirr(series, attr, { asOfDate: '2024-06-30', navAtAsOf: null });
    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('NAV_UNAVAILABLE');
    expect(r.terminalValue).toBeUndefined();
  });

  it('ambiguous purchases are NEVER labelled CONFIRMED_SOURCE', () => {
    const txns = [
      t({ transactionDate: '2022-01-11', transactionType: 'purchase', sourceDescription: 'PURCHASE', grossAmount: 7000 }),
      t({ transactionDate: '2022-01-28', transactionType: 'purchase', sourceDescription: 'PURCHASE', grossAmount: 7000 }),
      t({ transactionDate: '2022-08-03', transactionType: 'purchase', sourceDescription: 'PURCHASE', grossAmount: 7000 }),
      t({ transactionDate: '2023-05-19', transactionType: 'purchase', sourceDescription: 'PURCHASE', grossAmount: 7000 }),
    ];
    const series = detectSipSeries(txns);
    for (const s of series) {
      expect(s.confidence).not.toBe('CONFIRMED_SOURCE');
      expect(s.confidence).toBe('AMBIGUOUS');
    }
  });

  it('two purchases can never become an inferred SIP', () => {
    const txns = [
      t({ transactionDate: '2023-11-07', transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
      t({ transactionDate: '2023-12-07', transactionType: 'purchase', sourceDescription: 'PURCHASE' }),
    ];
    const s = detectSipSeries(txns)[0];
    expect(['AMBIGUOUS', 'NOT_SIP']).toContain(s.confidence);
    expect(s.confidence).not.toBe('HIGH_CONFIDENCE');
  });

  it('ONE missed instalment can never produce LIKELY_STOPPED', () => {
    const txns = monthly(12);
    const series = detectSipSeries(txns)[0];
    // As-of date exactly one nominal period after the latest contribution.
    // Exactly one nominal period after the latest contribution: the next
    // instalment is only just due, so NOTHING has been missed yet.
    const oneMonthLater = new Date(Date.parse(`${series.latestContributionDate}T00:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10);
    const activity = classifySipActivity(series, oneMonthLater);
    expect(activity.status).not.toBe('LIKELY_STOPPED');
    expect(activity.status).not.toBe('POSSIBLE_PAUSE');
    expect(['EXPECTED', 'LATE']).toContain(activity.status);

    // Even a genuinely missed instalment (two periods) must not read as stopped.
    const twoMonthsLater = new Date(Date.parse(`${series.latestContributionDate}T00:00:00Z`) + 62 * 86400000).toISOString().slice(0, 10);
    expect(classifySipActivity(series, twoMonthsLater).status).not.toBe('LIKELY_STOPPED');

    // LIKELY_STOPPED requires more than POSSIBLE_PAUSE_MAX_MISSED (3) periods.
    const sixMonthsLater = new Date(Date.parse(`${series.latestContributionDate}T00:00:00Z`) + 200 * 86400000).toISOString().slice(0, 10);
    expect(classifySipActivity(series, sixMonthsLater).status).toBe('LIKELY_STOPPED');
  });

  it('pause/stop wording is observational and contains no imperative advice', () => {
    const series = detectSipSeries(monthly(12))[0];
    for (const asOf of ['2024-01-31', '2024-06-30', '2025-06-30']) {
      const s = classifySipActivity(series, asOf).statement.toLowerCase();
      for (const banned of ['you should', 'increase your', 'stop this', 'switch to', 'we recommend', 'consider increasing']) {
        expect(s).not.toContain(banned);
      }
    }
  });

  it('wealth comparison is unavailable when either leg is unavailable', () => {
    const w = calculateSipWealthComparison(
      { status: 'unavailable', method: 'sip-xirr-r5-v1' as never, xirrMethod: 'xirr-newton-bisection-v1' as never },
      { status: 'unavailable', method: 'benchmark-sip-identical-cashflow-r5-v1' as never, dateAlignmentMethod: 'next-available-on-or-after-v1' as never, xirrMethod: 'xirr-newton-bisection-v1' as never }
    );
    expect(w.status).toBe('unavailable');
    expect(w.difference).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

function snap(fund: string, date: string, holdings: Array<[string | null, number, string?]>): FundHoldingsSnapshot {
  return {
    snapshotId: `${fund}-${date}`,
    fundInstrumentId: fund,
    holdingsAsOfDate: date,
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
const pos = (f: string, v: number): PortfolioFundPosition => ({ fundInstrumentId: f, fundName: f, value: v, currencyCode: 'INR' });

describe('NO FABRICATION — Portfolio X-Ray', () => {
  it('0% holdings coverage produces UNAVAILABLE, never an all-zero sector chart', () => {
    const r = calculatePortfolioLookThrough([pos('F1', 1_000_000)], new Map(), '2024-06-30', '2024-06-30');
    expect(r.status).toBe('unavailable');
    expect(r.qualityStatuses).toContain('MISSING_HOLDINGS');
    expect(r.exposures).toHaveLength(0);
    expect(r.effectiveCoverage).toBe(0);

    // The downstream widgets must ALSO refuse, not render zeros.
    const conc = calculateSecurityConcentration(r);
    expect(conc.status).toBe('unavailable');
    expect(conc.top1).toBeUndefined();
    expect(conc.hhi).toBeUndefined();

    const sector = calculateSectorExposure(r, null);
    expect(sector.status).toBe('unavailable');
    expect(sector.buckets).toHaveLength(0);

    const mcap = calculateMarketCapExposure(r, null);
    expect(mcap.status).toBe('unavailable');
    expect(mcap.buckets).toHaveLength(0);
  });

  it('holdings present but NO classification produces unavailable sector/market-cap, not zero buckets', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 1_000_000)],
      new Map([['F1', [snap('F1', '2024-06-01', [['S1', 60], ['S2', 40]])]]]),
      '2024-06-30',
      '2024-06-30'
    );
    expect(r.status).toBe('ok');
    expect(r.qualityStatuses).toContain('CLASSIFICATION_INCOMPLETE');

    const sector = calculateSectorExposure(r, null);
    expect(sector.status).toBe('unavailable');
    expect(sector.buckets).toHaveLength(0);
    expect(sector.unclassifiedWeight).toBeCloseTo(1, 8);

    const industry = calculateIndustryExposure(r, null);
    expect(industry.status).toBe('unavailable');
  });

  it('stale holdings are flagged STALE and never labelled current', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 1_000_000)],
      new Map([['F1', [snap('F1', '2023-06-30', [['S1', 100]])]]]),
      '2024-06-30',
      '2024-06-30'
    );
    expect(r.freshness).toBe('VERY_STALE');
    expect(r.qualityStatuses).toContain('STALE_HOLDINGS');
  });

  it('an unresolved holding is retained as unresolved, never dropped and never resolved by name', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 1_000_000)],
      new Map([['F1', [snap('F1', '2024-06-01', [['S1', 55], [null, 45]])]]]),
      '2024-06-30',
      '2024-06-30'
    );
    expect(r.unresolvedWeight).toBeCloseTo(0.45, 8);
    expect(r.qualityStatuses).toContain('UNDERLYING_UNRESOLVED');
    expect(r.exposures).toHaveLength(1); // the unresolved line did NOT become an exposure
  });

  it('partial coverage is reported as its true fraction, never rounded up to complete', () => {
    const r = calculatePortfolioLookThrough(
      [pos('F1', 500_000), pos('F2', 500_000)],
      new Map([['F1', [snap('F1', '2024-06-01', [['S1', 100]])]]]),
      '2024-06-30',
      '2024-06-30'
    );
    expect(r.effectiveCoverage).toBeCloseTo(0.5, 8);
    expect(r.noSnapshotWeight).toBeCloseTo(0.5, 8);
    expect(r.qualityStatuses).toContain('PARTIAL_COVERAGE');
    expect(r.qualityStatuses).not.toContain('COMPLETE');
  });

  it('similar NAMES never resolve to the same security without an approved identifier or alias', () => {
    const index = buildResolutionIndex(
      [{ canonicalId: 'REL', name: 'Reliance Industries Limited', countryCode: 'IN', exchangeCode: 'RELIANCE', securityType: 'equity', currencyCode: 'INR', issuerId: null, isin: 'INE002A01018' }],
      [] // NO curated aliases
    );
    // Name-only, no ISIN, no exchange code -> must be UNRESOLVED.
    const byName = resolveUnderlyingSecurity({ holdingName: 'RELIANCE INDUSTRIES LTD.' }, index);
    expect(byName.status).toBe('unresolved');
    expect(byName.method).toBe('UNRESOLVED');

    // With a curated alias approved by a human, the SAME string resolves.
    const withAlias = buildResolutionIndex(
      [{ canonicalId: 'REL', name: 'Reliance Industries Limited', countryCode: 'IN', exchangeCode: 'RELIANCE', securityType: 'equity', currencyCode: 'INR', issuerId: null, isin: 'INE002A01018' }],
      [{ alias: 'RELIANCE INDUSTRIES LTD', canonicalId: 'REL' }]
    );
    const aliased = resolveUnderlyingSecurity({ holdingName: 'RELIANCE INDUSTRIES LTD.' }, withAlias);
    expect(aliased.status).toBe('resolved');
    expect(aliased.method).toBe('CONTROLLED_ALIAS');

    // ISIN always wins and needs no alias.
    const byIsin = resolveUnderlyingSecurity({ holdingName: 'ANYTHING AT ALL', isin: 'ine002a01018' }, index);
    expect(byIsin.status).toBe('resolved');
    expect(byIsin.method).toBe('ISIN');
    expect(byIsin.canonicalId).toBe('REL');
  });
});

describe('NO FABRICATION — Debt X-Ray', () => {
  const line = (over: Partial<DebtExposureLine>): DebtExposureLine => ({ canonicalId: 'B', displayName: 'Bond', effectiveWeight: 0.5, ...over });

  it('a MISSING rating becomes UNRATED — a data statement — never a credit band', () => {
    const r = calculateCreditQuality([line({ canonicalId: 'B1', creditRatingBand: null }), line({ canonicalId: 'B2', creditRatingBand: 'AAA' })]);
    expect(r.status).toBe('ok');
    const unrated = r.buckets.find((b) => b.key === 'UNRATED');
    expect(unrated).toBeDefined();
    expect(unrated!.effectiveWeight).toBeCloseTo(0.5, 8);
    expect(unrated!.label).toMatch(/no rating available/i);
    // It must NOT have been silently placed in any real credit band.
    expect(r.buckets.find((b) => b.key === 'AAA')!.effectiveWeight).toBeCloseTo(0.5, 8);
  });

  it('conflicting multi-agency ratings with no approved methodology SUPPRESS the consolidated view', () => {
    const r = calculateCreditQuality([
      line({ canonicalId: 'B1', creditRatingBand: 'AAA', agencyRatings: [{ agency: 'CRISIL', rating: 'AAA' }, { agency: 'ICRA', rating: 'AA' }] }),
      line({ canonicalId: 'B2', creditRatingBand: 'AA' }),
    ]);
    expect(r.status).toBe('unavailable');
    expect(r.consolidationSuppressed).toBe(true);
    expect(r.buckets).toHaveLength(0);
    // The agency-specific data is RETAINED, not discarded.
    expect(r.multiAgencySecurities).toHaveLength(1);
    expect(r.multiAgencySecurities![0].agencyRatings).toHaveLength(2);
  });

  it('duration is NEVER estimated from maturity when the source omits it', () => {
    const r = calculateWeightedDuration([
      line({ canonicalId: 'B1', maturityDate: '2030-01-31', modifiedDuration: null }),
      line({ canonicalId: 'B2', maturityDate: '2035-01-31', modifiedDuration: null }),
    ]);
    expect(r.status).toBe('unavailable');
    expect(r.weightedModifiedDuration).toBeUndefined();
    expect(r.detail).toMatch(/cannot be reliably derived from maturity/i);
  });

  it('partial duration coverage below the threshold is suppressed, not extrapolated', () => {
    const r = calculateWeightedDuration([
      line({ canonicalId: 'B1', effectiveWeight: 0.3, modifiedDuration: 2.4 }),
      line({ canonicalId: 'B2', effectiveWeight: 0.7, modifiedDuration: null }),
    ]);
    expect(r.status).toBe('unavailable');
    expect(r.weightedModifiedDuration).toBeUndefined();
    expect(r.detail).toMatch(/only 30\.0%/);
  });
});
