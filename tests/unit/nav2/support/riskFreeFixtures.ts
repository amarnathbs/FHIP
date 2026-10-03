// Test-only builders for the risk-free dataset contract and for Fixture B. The
// observations are SYNTHETIC (their source document says so); no RBI page and no
// RBI-published series is copied into the repository.
import { RISK_FREE_MAX_STALENESS_DAYS } from '@/lib/config/nav2/metricPolicy';
import { RISK_FREE_SERIES } from '@/lib/config/nav2/riskFreeSeriesConfig';
import type { RiskFreeDataset, RiskFreeObservation } from '@/lib/engines/nav2/riskFree';
import { benchmarkFor } from './benchmarks';
import { bReturns, buildSeries, pathFromReturns, weekdays } from './fixtures';

export const obs = (observationDate: string, yieldPercent: number, over: Partial<RiskFreeObservation> = {}): RiskFreeObservation => ({
  observationDate,
  yieldPercent,
  sourceDocument: 'SYNTHETIC TEST FIXTURE (not RBI data)',
  sourceUrl: null,
  retrievedOn: '2026-10-03',
  ...over,
});

export function dataset(over: Partial<RiskFreeDataset> & Pick<RiskFreeDataset, 'observations'>): RiskFreeDataset {
  return {
    seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD',
    seriesName: RISK_FREE_SERIES.RBI_91D_TBILL_CUTOFF_YIELD.name,
    source: 'Reserve Bank of India',
    attributionText: 'Source: Reserve Bank of India',
    cadence: 'weekly_auction',
    datasetVersion: 'test-fixture-v1',
    retrievedOn: '2026-10-03',
    termsReviewStatus: 'po_accepted_2026-10-03',
    enabled: true,
    yieldBasis: 'annualised_percent_as_published',
    conversion: 'compound_per_period_1_over_n',
    observationSemantics: 'latest_on_or_before_never_future_never_interpolated',
    maxStalenessDays: RISK_FREE_MAX_STALENESS_DAYS.RBI_91D_TBILL_CUTOFF_YIELD,
    verifiedThroughDate: null,
    ...over,
  };
}

/** Weekly (Monday) observations of one yield covering the B fixture window (06-01-2025 .. 28-03-2025), starting the Monday before. */
export function weeklyDataset(yieldPercent: number, over: Partial<RiskFreeDataset> = {}): RiskFreeDataset {
  const mondays: string[] = [];
  const cur = new Date('2024-12-30T00:00:00.000Z');
  while (cur.toISOString().slice(0, 10) <= '2025-03-31') {
    mondays.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return dataset({ observations: mondays.map((d) => obs(d, yieldPercent)), ...over });
}

/** A policy_change series (the repo rate): ONE change observation, verified through the end of the B window. */
export function repoDataset(yieldPercent: number, over: Partial<RiskFreeDataset> = {}): RiskFreeDataset {
  return dataset({
    seriesId: 'RBI_POLICY_REPO_RATE',
    seriesName: RISK_FREE_SERIES.RBI_POLICY_REPO_RATE.name,
    cadence: 'policy_change',
    maxStalenessDays: RISK_FREE_MAX_STALENESS_DAYS.RBI_POLICY_REPO_RATE,
    verifiedThroughDate: '2025-03-31',
    observations: [obs('2024-12-06', yieldPercent)],
    ...over,
  });
}

/** Fixture B: scheme and benchmark paths over 61 weekdays from 06-01-2025 (see scripts/nav2_independent_oracle.py section B). */
export function fixtureB() {
  const dates = weekdays('2025-01-06', 61);
  const { bench, scheme } = bReturns();
  return {
    dates,
    scheme: buildSeries(dates, pathFromReturns(100, scheme)),
    benchmarks: benchmarkFor(dates, pathFromReturns(1000, bench)),
  };
}
