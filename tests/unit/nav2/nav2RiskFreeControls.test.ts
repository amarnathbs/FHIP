// PO review of NAV2 (A): risk-free controls, golden fixtures and provenance.
//
// A1  the repo rate is never a silent substitute for the 91-day T-bill; every Sharpe / Sortino / alpha result carries its series label
//     ("RBI 91-day T-bill" or "RBI policy repo-rate proxy"), series id and dataset version, and the pinned manifest keeps them;
// A2  look-ahead: an observation is visible only from its own date (the auction result is published that day) and never before; the rate
//     for an interval is the one in force at its START; a later RBI correction changes the dataset version and the bundle key (new reports),
//     never an already-issued report, and invalidates only the entries that depend on that dataset and date;
// A3  golden fixtures for the carry and coverage rules: one short gap, exactly 35 days, 36 days, exactly 95%, below 95%, gaps at the start and
//     at the end of a window, no-accepted-bid dates, a later correction;
// B   the pinned manifest carries NAV series checksum and actual dates, risk-free series + label + version, benchmark versions, a transaction
//     fingerprint, the metric-definition list and the calculation timestamp.
//
// NAMED NEGATIVE CONTROLS: RF-NC1 a disabled / absent primary never falls back to the repo series (a number would be the defect);
// RF-NC2 an observation dated after the lookup date is invisible; RF-NC3 a corrected value changes the key and leaves the old payload alone;
// RF-NC4 the 35-day and 95% limits are exact on both sides; RF-NC5 a gap row is never a value.
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { NAV2_RISK_FREE_CONFIG, RISK_FREE_SERIES_LABELS } from '@/lib/config/nav2/riskFreeSeriesConfig';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { selectInvalidated, type CachedResultMeta } from '@/lib/engines/nav2/cacheKeys';
import { buildFundAnalyticsReport, manifestChecksum, schemeBundleCacheKey, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { cleanRiskFreeDataset, matchRiskFree, riskFreeObservationOn, selectRiskFreeSupply, type RiskFreeLookupRule } from '@/lib/engines/nav2/riskFree';
import { riskFreeLabelOf } from '@/lib/engines/nav2/reportWording';
import { jensenAlpha, sharpeRatio, sortinoRatio } from '@/lib/engines/nav2/schemeRisk';
import { buildReturns } from '@/lib/engines/nav2/series';
import { addDays, buildSeries, ctxInr, pathFromReturns, weekdays } from './support/fixtures';
import { dataset, fixtureB, obs, repoDataset, weeklyDataset } from './support/riskFreeFixtures';

const B = fixtureB();
const gapRow = (date: string, reason: 'no_accepted_bids' | 'no_auction_held' | 'no_row_in_source' = 'no_accepted_bids') => ({ ...obs(date, 0), yieldPercent: null, kind: 'gap' as const, gapReason: reason });
const RULE = (gapDates: string[]): RiskFreeLookupRule => ({ cadence: 'weekly_auction', maxStalenessDays: 21, verifiedThroughDate: null, gapCarry: { gapDates, maxCarryDays: 35, maxRecordSpacingDays: 14 } });

describe('A1: the series label and no silent fallback', () => {
  it('every Sharpe, Sortino and alpha result carries the label, series id and dataset version of the series used', () => {
    const tb = weeklyDataset(6.5, { datasetVersion: 'tb-v7' });
    for (const r of [sharpeRatio(B.scheme, ctxInr(), tb), sortinoRatio(B.scheme, ctxInr(), tb), jensenAlpha(B.scheme, ctxInr(), B.benchmarks, tb)]) {
      if (r.state !== 'available') throw new Error(r.state);
      expect(r.provenance.riskFree).toMatchObject({ seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', seriesLabel: 'RBI 91-day T-bill', datasetVersion: 'tb-v7' });
    }
    const repo = repoDataset(6.0, { datasetVersion: 'repo-v3' });
    for (const r of [sharpeRatio(B.scheme, ctxInr(), repo), sortinoRatio(B.scheme, ctxInr(), repo), jensenAlpha(B.scheme, ctxInr(), B.benchmarks, repo)]) {
      if (r.state !== 'available') throw new Error(r.state);
      expect(r.provenance.riskFree).toMatchObject({ seriesId: 'RBI_POLICY_REPO_RATE', seriesLabel: 'RBI policy repo-rate proxy', datasetVersion: 'repo-v3' });
    }
    expect(RISK_FREE_SERIES_LABELS).toEqual({ RBI_91D_TBILL_CUTOFF_YIELD: 'RBI 91-day T-bill', RBI_POLICY_REPO_RATE: 'RBI policy repo-rate proxy' });
  });

  it('RF-NC1: with the primary switched off the ratio is risk_free_missing even though the repo series is present and enabled', () => {
    const off = weeklyDataset(6.5, { enabled: false });
    const supply = selectRiskFreeSupply([off, repoDataset(6.0)], NAV2_RISK_FREE_CONFIG);
    expect(supply?.seriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    const r = sharpeRatio(B.scheme, ctxInr(), supply);
    expect(r.state).toBe('risk_free_missing');
    expect(r.state === 'risk_free_missing' && r.reason).toBe('risk_free_series_disabled');
    expect(JSON.stringify(r)).not.toContain('RBI_POLICY_REPO_RATE');
    expect('value' in r).toBe(false);
  });

  it('RF-NC1: with the primary absent the supply is null (the repo series is NOT picked), and the ratio has no number', () => {
    const supply = selectRiskFreeSupply([repoDataset(6.0)], NAV2_RISK_FREE_CONFIG);
    expect(supply).toBeNull();
    for (const r of [sharpeRatio(B.scheme, ctxInr(), supply), sortinoRatio(B.scheme, ctxInr(), supply), jensenAlpha(B.scheme, ctxInr(), B.benchmarks, supply)]) {
      expect(r.state).toBe('risk_free_missing');
      expect('value' in r).toBe(false);
    }
  });

  it('RF-NC1: a primary whose observations have gaps beyond the rules is missing / withheld, never topped up from the repo series', () => {
    const tbShort = dataset({ observations: [obs('2025-01-06', 6.5)] }); // one auction, stale after 21 days: most of the window has no rate
    const r = sharpeRatio(B.scheme, ctxInr(), selectRiskFreeSupply([tbShort, repoDataset(6.0)], NAV2_RISK_FREE_CONFIG));
    expect(r.state).toBe('risk_free_missing');
    expect(JSON.stringify(r)).not.toContain('RBI_POLICY_REPO_RATE');
  });

  it('only an explicit selection of the repo series uses it, and then it is labelled a proxy', () => {
    const supply = selectRiskFreeSupply([weeklyDataset(6.5), repoDataset(6.0)], { ...NAV2_RISK_FREE_CONFIG, selectedSeriesId: 'RBI_POLICY_REPO_RATE' });
    expect(supply?.seriesId).toBe('RBI_POLICY_REPO_RATE');
    const r = sharpeRatio(B.scheme, ctxInr(), supply);
    if (r.state !== 'available') throw new Error(r.state);
    expect(riskFreeLabelOf(r.provenance.riskFree)).toBe('RBI policy repo-rate proxy');
  });

  it('a report stored before the label existed gets it from the series id; an unknown series has none (never invented)', () => {
    expect(riskFreeLabelOf({ seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD' })).toBe('RBI 91-day T-bill');
    expect(riskFreeLabelOf({ seriesId: 'SOMETHING_ELSE' })).toBeNull();
    expect(riskFreeLabelOf(null)).toBeNull();
  });
});

describe('A2: look-ahead and corrections', () => {
  const values = [obs('2025-01-01', 6.5), obs('2025-01-08', 7.0)];
  const noGap = RULE([]);

  it('RF-NC2: an observation is invisible before its own date and visible from it; the rate for a date is never a later one', () => {
    expect(riskFreeObservationOn(values, '2025-01-07', noGap)).toMatchObject({ ok: true, observation: { observationDate: '2025-01-01' } });
    expect(riskFreeObservationOn(values, '2025-01-08', noGap)).toMatchObject({ ok: true, observation: { observationDate: '2025-01-08' } });
    expect(riskFreeObservationOn(values, '2024-12-31', noGap)).toEqual({ ok: false, reason: 'none_on_or_before' });
  });

  it('the rate of a return interval is the one in force at its START: an auction held on the interval end date is not used for it', () => {
    const dates = weekdays('2025-01-06', 70);
    const navs = pathFromReturns(100, Array.from({ length: 69 }, (_, i) => 0.0005 + 0.006 * Math.sin(i * 0.6)));
    const ret = buildReturns(dates.map((date, i) => ({ date, value: navs[i] })));
    const weekly = (from: string, to: string, y: number) => { const out = []; for (let d = from; d <= to; d = addDays(d, 7)) out.push(obs(d, y)); return out; };
    const ds = dataset({ observations: [...weekly('2025-01-01', '2025-01-29', 6.0), ...weekly('2025-02-05', '2025-04-30', 9.0)] });
    const m = matchRiskFree(ret, ds, ctxInr(), 'sharpe_ratio', {}, 'daily');
    if (!m.ok) throw new Error('available expected');
    // the interval 04-02-2025 -> 05-02-2025 starts on 04-02, before the 9.0 auction of 05-02: it still uses 6.0
    const idx = ret.findIndex((r) => r.startDate === '2025-02-04');
    const rfAt = (i: number) => m.periodic[m.keptIndexes.indexOf(i)];
    expect(rfAt(idx)).toBeCloseTo(Math.pow(1.06, 1 / 252) - 1, 14);
    expect(rfAt(idx + 1)).toBeCloseTo(Math.pow(1.09, 1 / 252) - 1, 14);
  });

  it('a future-dated observation (after its own retrieval date) is rejected by the cleaning step, never used', () => {
    const c = cleanRiskFreeDataset(dataset({ observations: [obs('2026-12-01', 6.0, { retrievedOn: '2026-10-03' })] }));
    expect(c.observations).toEqual([]);
    expect(c.issues.some((i) => i.issue === 'future_dated')).toBe(true);
  });

  it('RF-NC3: a later RBI correction changes the dataset hash input and the bundle key: the old report payload is untouched, new reports use the corrected value', () => {
    const held = { instrumentId: '11111111-1111-4111-8111-111111111111', firstHeldDate: '2025-01-06', benchmarks: [], series: B.scheme } as unknown as HeldSchemeInput;
    const base = { spec: reportAnalysisSpec('2025-03-31', NAV2_POLICY, 'all_history'), periodChoice: 'all_history' as const, policy: NAV2_POLICY, displayCurrency: 'INR' as const };
    const keyV1 = schemeBundleCacheKey({ ...base, riskFree: weeklyDataset(6.5, { datasetVersion: 'v1' }) }, held);
    const keyV2 = schemeBundleCacheKey({ ...base, riskFree: weeklyDataset(6.5, { datasetVersion: 'v2-corrected' }) }, held);
    expect(keyV2).not.toBe(keyV1);
    // an issued report is a stored JSON snapshot: computing again with the corrected data does not alter the first result object
    const first = sharpeRatio(B.scheme, ctxInr(), weeklyDataset(6.5));
    const frozen = JSON.stringify(first);
    const corrected = sharpeRatio(B.scheme, ctxInr(), weeklyDataset(7.5));
    expect(JSON.stringify(first)).toBe(frozen);
    if (first.state !== 'available' || corrected.state !== 'available') throw new Error('available expected');
    expect(corrected.value.annualisedRatio).not.toBe(first.value.annualisedRatio);
  });

  it('a correction invalidates only the entries that depend on that dataset and could have used that date', () => {
    const meta = (key: string, ds: string | null, actualEnd: string | null): CachedResultMeta => ({ key, family: 'scheme_performance', scopeHash: null, instrumentId: 'i', metricId: 'scheme_performance_bundle', policyVersion: NAV2_POLICY.version, definitionVersion: 'a:b:c:d:e', actualEnd, benchmarkId: null, riskFreeDatasetId: ds });
    const hit = selectInvalidated(
      [meta('uses-after', 'RBI_91D_TBILL_CUTOFF_YIELD', '2025-06-30'), meta('ended-before', 'RBI_91D_TBILL_CUTOFF_YIELD', '2025-01-02'), meta('other-series', 'RBI_POLICY_REPO_RATE', '2025-06-30'), meta('no-rf', null, '2025-06-30')],
      { kind: 'risk_free_correction', datasetId: 'RBI_91D_TBILL_CUTOFF_YIELD', date: '2025-03-12' }
    );
    expect(hit).toEqual(['uses-after']);
  });
});

describe('A3: golden fixtures for the 35-day carry rule and the 95% coverage rule', () => {
  const last = obs('2025-01-01', 6.5);
  const weeklyGaps = ['2025-01-08', '2025-01-15', '2025-01-22', '2025-01-29'];

  it('one short gap: a single no-accepted-bids week is carried (day 10 after the last value)', () => {
    expect(riskFreeObservationOn([last], '2025-01-11', RULE([])).ok).toBe(true); // within 21 days anyway
    const r = riskFreeObservationOn([last], '2025-01-25', RULE(['2025-01-08', '2025-01-15', '2025-01-22'])); // day 24: needs the documented gaps
    expect(r).toMatchObject({ ok: true, ageDays: 24, carriedAcrossGapDates: ['2025-01-08', '2025-01-15', '2025-01-22'] });
  });

  it('RF-NC4: exactly 35 days after the last value carries, 36 does not, with the same gap rows', () => {
    expect(riskFreeObservationOn([last], addDays('2025-01-01', 35), RULE(weeklyGaps))).toMatchObject({ ok: true, ageDays: 35 });
    expect(riskFreeObservationOn([last], addDays('2025-01-01', 36), RULE(weeklyGaps))).toEqual({ ok: false, reason: 'stale' });
  });

  it('a gap at the START of the data: a window that begins before the first value has no rate for those dates (nothing assumed)', () => {
    const ds = dataset({ observations: [gapRow('2024-12-25'), obs('2025-02-05', 6.5), ...['2025-02-12', '2025-02-19', '2025-02-26'].map((d) => obs(d, 6.5))] });
    expect(riskFreeObservationOn(cleanRiskFreeDataset(ds).observations, '2025-01-20', RULE(['2024-12-25']))).toEqual({ ok: false, reason: 'none_on_or_before' });
    const dates = weekdays('2025-01-27', 41);
    const ret = buildReturns(dates.map((date, i) => ({ date, value: 100 + i })));
    const m = matchRiskFree(ret, ds, ctxInr(), 'sharpe_ratio', {}, 'daily');
    expect(m.ok).toBe(false); // the first 8 of 40 intervals have no rate: 80% coverage is below 95%
    expect(!m.ok && m.result.reason).toBe('risk_free_coverage_incomplete');
  });

  it('a gap at the END: the last value stays in force up to its limit after the final record, then the date has no rate', () => {
    const ds = [obs('2025-01-01', 6.5)];
    const rule = RULE(['2025-01-08', '2025-01-15']);
    expect(riskFreeObservationOn(ds, '2025-01-29', rule)).toMatchObject({ ok: true, carriedAcrossGapDates: ['2025-01-08', '2025-01-15'] }); // 28 days, last record 14 days before
    expect(riskFreeObservationOn(ds, '2025-02-03', rule)).toEqual({ ok: false, reason: 'stale' }); // 33 days but the last record is 19 days before: an undocumented hole
  });

  it('no-accepted-bid dates are documented gaps and are never a value (RF-NC5)', () => {
    const ds = dataset({ observations: [last, gapRow('2025-01-08', 'no_accepted_bids'), obs('2025-01-15', 6.4)] });
    const c = cleanRiskFreeDataset(ds);
    expect(c.gaps.map((g) => [g.observationDate, g.gapReason])).toEqual([['2025-01-08', 'no_accepted_bids']]);
    expect(c.observations.map((o) => o.observationDate)).toEqual(['2025-01-01', '2025-01-15']);
    expect(riskFreeObservationOn(c.observations, '2025-01-10', RULE(['2025-01-08']))).toMatchObject({ ok: true, observation: { yieldPercent: 6.5 } });
  });

  it('RF-NC4: coverage of exactly 95% computes and 94.9% does not; the count is in the sentence', () => {
    const dates = weekdays('2025-01-06', 101); // 100 returns, starts 06-01 ..
    const navs = pathFromReturns(100, Array.from({ length: 100 }, (_, i) => 0.0005 + 0.007 * Math.sin(i * 0.5)));
    const ret = buildReturns(dates.map((date, i) => ({ date, value: navs[i] })));
    const startOfWindow = ret[0].startDate;
    // the first k intervals start before the first observation: they have no rate
    const withFirstObs = (k: number) => dataset({ observations: [obs(ret[k].startDate, 6.5), ...Array.from({ length: 30 }, (_, w) => obs(addDays(ret[k].startDate, 7 * (w + 1)), 6.5))] });
    const ok = matchRiskFree(ret, withFirstObs(5), ctxInr(), 'sharpe_ratio', {}, 'daily'); // 95 of 100
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.provenance.windowCoverageShare).toBe(0.95);
    const below = matchRiskFree(ret, withFirstObs(6), ctxInr(), 'sharpe_ratio', {}, 'daily'); // 94 of 100
    expect(below.ok).toBe(false);
    expect(!below.ok && below.result.detail).toMatch(/94 of 100/);
    void startOfWindow;
  });

  it('a later correction of the value that fills a gap changes the figure for the new dataset only (hand check on one interval)', () => {
    const before = matchRiskFree(buildReturns([{ date: '2025-01-02', value: 100 }, { date: '2025-01-03', value: 101 }]), dataset({ observations: [obs('2025-01-01', 6.0)] }), ctxInr(), 'sharpe_ratio', {}, 'daily');
    const after = matchRiskFree(buildReturns([{ date: '2025-01-02', value: 100 }, { date: '2025-01-03', value: 101 }]), dataset({ observations: [obs('2025-01-01', 6.5)] }), ctxInr(), 'sharpe_ratio', {}, 'daily');
    if (!before.ok || !after.ok) throw new Error('ok expected');
    expect(before.periodic[0]).toBeCloseTo(Math.pow(1.06, 1 / 252) - 1, 14);
    expect(after.periodic[0]).toBeCloseTo(Math.pow(1.065, 1 / 252) - 1, 14);
  });
});

describe('B: the pinned manifest carries the provenance the PO asked for', () => {
  const INSTR = 'a';
  const scheme = (over: Partial<HeldSchemeInput> = {}): HeldSchemeInput => ({
    instrumentId: INSTR,
    schemeName: 'Alpha Fund',
    planType: 'direct',
    optionType: 'growth',
    category: 'flexi_cap',
    categoryLabel: 'Flexi Cap',
    series: B.scheme,
    benchmarks: B.benchmarks,
    investor: { instrumentId: INSTR, flows: [{ date: new Date('2025-01-06T00:00:00Z'), amount: -1000 }], valuation: { basis: 'market_nav', units: 10, marketValue: 1200, valuationDate: '2025-03-31', stale: false, nav: 120, navDate: '2025-03-31' }, asOfDate: '2025-03-31' },
    firstHeldDate: '2025-01-06',
    ...over,
  });
  const input = (over: Partial<FundAnalyticsInput> = {}): FundAnalyticsInput => ({
    asOfDate: '2025-03-31',
    displayCurrency: 'INR',
    policy: NAV2_POLICY,
    spec: reportAnalysisSpec('2025-03-31', NAV2_POLICY, 'all_history'),
    periodChoice: 'all_history',
    riskFree: weeklyDataset(6.5, { datasetVersion: 'tb-v9' }),
    schemes: [scheme()],
    scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
    calculatedAt: '2026-10-06T10:15:30.000Z',
    ...over,
  });
  const { manifest } = buildFundAnalyticsReport(input());

  it('NAV series checksum and actual dates, risk-free series + label + version, benchmark versions, transaction fingerprint, definitions, timestamp', () => {
    expect(manifest.schemes[0].navSeries).toMatchObject({ checksum: B.scheme.checksum, firstDate: B.scheme.firstDate, lastDate: B.scheme.lastDate });
    expect(manifest.schemes[0].navRange).toEqual({ from: B.scheme.firstDate, to: B.scheme.lastDate });
    expect(manifest.riskFree).toMatchObject({ seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', seriesLabel: 'RBI 91-day T-bill', datasetVersion: 'tb-v9' });
    expect(manifest.schemes[0].benchmarks.length).toBe(B.benchmarks.length);
    for (const b of manifest.schemes[0].benchmarks) expect(Object.keys(b).sort()).toEqual(['basis', 'benchmarkId', 'datasetVersion']);
    expect(manifest.schemes[0].transactionVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.metricDefinitions.length).toBeGreaterThanOrEqual(15);
    expect(manifest.metricDefinitions.map((m) => m.id)).toEqual([...manifest.metricDefinitions.map((m) => m.id)].sort());
    expect(manifest.metricRegistryDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.calculatedAt).toBe('2026-10-06T10:15:30.000Z');
    expect(manifest.policyVersion).toBe(NAV2_POLICY.version);
  });

  it('the transaction fingerprint changes with a flow, not with the order of flows; a scheme with no investor input has none', () => {
    const f2 = [{ date: new Date('2025-02-03T00:00:00Z'), amount: -500 }];
    const base = scheme();
    const a = buildFundAnalyticsReport(input({ schemes: [{ ...base, investor: { ...base.investor!, flows: [...base.investor!.flows, ...f2] } }] })).manifest.schemes[0].transactionVersion;
    const b = buildFundAnalyticsReport(input({ schemes: [{ ...base, investor: { ...base.investor!, flows: [...f2, ...base.investor!.flows] } }] })).manifest.schemes[0].transactionVersion;
    expect(a).toBe(b);
    expect(a).not.toBe(manifest.schemes[0].transactionVersion);
    expect(buildFundAnalyticsReport(input({ schemes: [scheme({ investor: null })] })).manifest.schemes[0].transactionVersion).toBeNull();
  });

  it('the timestamp is part of the checksum (a new calculation is a new version) and the risk-free series is not substituted when absent', () => {
    expect(manifestChecksum(buildFundAnalyticsReport(input({ calculatedAt: '2026-10-06T10:16:00.000Z' })).manifest)).not.toBe(manifestChecksum(manifest));
    expect(buildFundAnalyticsReport(input({ riskFree: null })).manifest.riskFree).toBeNull();
  });
});
