// NAV2 Stage 1 -- the governed RISK-FREE dataset contract (PO decision 2026-10-03:
// RBI 91-day T-bill cut-off yield PRIMARY, RBI policy repo rate SECONDARY).
//
// Matrix rows: 18 (Sharpe uses matched risk-free periodic returns), 22-class
// behaviour for risk-free (typed state, never zero), and the PO's items (1)-(4).
//
// Every expected number below is from scripts/nav2_independent_oracle.py.
//
// NAMED NEGATIVE CONTROLS (the PO's list)
//   NC-RF1  no future-dated rate is ever used (an observation dated after the lookup date is invisible),
//           and a future-dated observation in the dataset is rejected outright;
//   NC-RF2  no interpolation between auctions: a mid-week date carries the earlier auction's yield exactly;
//   NC-RF3  a gap larger than the staleness constant (21 days weekly T-bill) is risk_free_missing for those
//           dates, and the WHOLE ratio is withheld, not part-filled;
//   NC-RF4  switching the series (T-bill -> repo) changes Sharpe / Sortino / alpha to the other hand-computed values;
//   NC-RF5  an empty / disabled / terms-declined series gives risk_free_missing, never a ratio with rf = 0
//           (and the rf = 0 figure is shown to differ, so the control is not vacuous).
import { describe, expect, it } from 'vitest';
import { NAV2_POLICY, RISK_FREE_MAX_STALENESS_DAYS } from '@/lib/config/nav2/metricPolicy';
import { NAV2_RISK_FREE_CONFIG, RISK_FREE_SERIES, type RiskFreeConfig } from '@/lib/config/nav2/riskFreeSeriesConfig';
import {
  cleanRiskFreeDataset,
  matchRiskFree,
  periodicRiskFreeReturn,
  riskFreeFreshness,
  riskFreeObservationOn,
  selectRiskFreeSupply,
  type RiskFreeLookupRule,
} from '@/lib/engines/nav2/riskFree';
import { sharpeRatio, sortinoRatio, jensenAlpha } from '@/lib/engines/nav2/schemeRisk';
import { buildReturns } from '@/lib/engines/nav2/series';
import { allStrings, ctxInr, expectClose, ISO_DATE_IN_TEXT, weekdays } from './support/fixtures';
import { dataset, fixtureB, obs, repoDataset, weeklyDataset } from './support/riskFreeFixtures';

const WEEKLY_RULE: RiskFreeLookupRule = { cadence: 'weekly_auction', maxStalenessDays: 21, verifiedThroughDate: null };

describe('the series configuration records the PO decision', () => {
  it('primary is the RBI 91-day T-bill cut-off yield, secondary the RBI policy repo rate; both named constants for staleness', () => {
    expect(NAV2_RISK_FREE_CONFIG.selectedSeriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    expect(RISK_FREE_SERIES.RBI_91D_TBILL_CUTOFF_YIELD.role).toBe('primary');
    expect(RISK_FREE_SERIES.RBI_POLICY_REPO_RATE.role).toBe('secondary');
    expect(RISK_FREE_MAX_STALENESS_DAYS).toEqual({ RBI_91D_TBILL_CUTOFF_YIELD: 21, RBI_POLICY_REPO_RATE: 90 });
    expect(NAV2_POLICY.riskFreeMaxStalenessDays.RBI_91D_TBILL_CUTOFF_YIELD).toBe(21);
    expect(NAV2_RISK_FREE_CONFIG.termsReviewStatus).toBe('po_accepted_2026-10-03'); // PO decision: RBI's written confirmation is not required
    expect(NAV2_RISK_FREE_CONFIG.attributionText).toBe('Source: Reserve Bank of India');
    // the PO-accepted risk is stated factually, never presented as a granted licence
    expect(NAV2_RISK_FREE_CONFIG.termsNote).toMatch(/no explicit reuse licence/);
    expect(NAV2_RISK_FREE_CONFIG.termsNote).toMatch(/accepted this risk/);
    expect(NAV2_RISK_FREE_CONFIG.ingestion).toBe('weekly_refresh_job_and_admin_upload');
    // the Stage 2 weekly refresh ships OFF, in dry-run, behind a kill switch row in the existing job-control mechanism
    expect(NAV2_RISK_FREE_CONFIG.weeklyRefresh).toEqual({ jobKey: 'nav2_risk_free_weekly_refresh', defaultEnabled: false, dryRunByDefault: true });
    // series ids and cadence words are those of the PO's first-load CSV files
    expect(RISK_FREE_SERIES.RBI_91D_TBILL_CUTOFF_YIELD.cadence).toBe('weekly_auction');
    expect(RISK_FREE_SERIES.RBI_POLICY_REPO_RATE.cadence).toBe('policy_change');
    expect(RISK_FREE_SERIES.RBI_91D_TBILL_CUTOFF_YIELD.source).toBe('Reserve Bank of India');
  });

  it('ships NO observations: the config contains no rate (nothing invented, nothing seeded)', () => {
    expect(JSON.stringify(NAV2_RISK_FREE_CONFIG)).not.toMatch(/\d\.\d{2,}/);
    expect(Object.keys(NAV2_RISK_FREE_CONFIG)).not.toContain('observations');
  });
});

describe('conversion: rf_periodic = (1 + y/100)^(1/N) - 1, N = 252 / 52 / 12 (matched to the return frequency)', () => {
  it('hand-checkable cases: the yield built from a round periodic rate converts back exactly', () => {
    // y = (1.01^12 - 1) x 100 = 12.682503013196972 -> monthly 1% exactly
    expectClose(periodicRiskFreeReturn(12.682503013196972, 12), 0.01, 1e-14);
    // y = (1.002^52 - 1) x 100 = 10.948521608698425 -> weekly 0.2% exactly
    expectClose(periodicRiskFreeReturn(10.948521608698425, 52), 0.002, 1e-14);
    // y = (1.0001^252 - 1) x 100 = 2.5518911987697367 -> daily 0.01% exactly
    expectClose(periodicRiskFreeReturn(2.5518911987697367, 252), 0.0001, 1e-14);
  });

  it('matches the 50-digit oracle at realistic yields (daily / weekly / monthly)', () => {
    expectClose(periodicRiskFreeReturn(7.3, 252), 0.00027963616887663613, 1e-14);
    expectClose(periodicRiskFreeReturn(7.3, 52), 0.0013558888419956979, 1e-14);
    expectClose(periodicRiskFreeReturn(7.3, 12), 0.0058888099067943756, 1e-14);
    expectClose(periodicRiskFreeReturn(6.5, 252), 0.00024993122427755003, 1e-14);
    expectClose(periodicRiskFreeReturn(6.25, 252), 0.00024060283631741263, 1e-14);
    expectClose(periodicRiskFreeReturn(5.5199, 252), 0.00021323453574782518, 1e-14);
    expectClose(periodicRiskFreeReturn(5.5199, 52), 0.0010337912005306864, 1e-14);
    expectClose(periodicRiskFreeReturn(5.5199, 12), 0.0044874866412933080, 1e-14);
  });

  it('the factor is the SAME N the ratio annualises with (policy table 252 / 52 / 12)', () => {
    expect(NAV2_POLICY.periodsPerYear).toEqual({ daily: 252, weekly: 52, monthly: 12 });
  });

  it('compounding back over N periods returns the quoted yield (no loss of a year)', () => {
    for (const n of [252, 52, 12]) expectClose(Math.pow(1 + periodicRiskFreeReturn(6.5, n), n) - 1, 0.065, 1e-12);
  });
});

describe('step-function lookup: latest on or before the date, never future, never interpolated, never stale', () => {
  const weekly = [obs('2025-02-03', 6.5), obs('2025-02-10', 6.0), obs('2025-02-17', 5.5)];

  it('NC-RF2: a mid-week date carries the EARLIER auction exactly (no blend between 6.5 and 6.0)', () => {
    const r = riskFreeObservationOn(weekly, '2025-02-06', WEEKLY_RULE);
    expect(r.ok && r.observation.yieldPercent).toBe(6.5);
    expect(r.ok && r.observation.observationDate).toBe('2025-02-03');
    expect(r.ok && r.ageDays).toBe(3);
    expect(r.ok && r.observation.yieldPercent).not.toBeCloseTo((6.5 + 6.0) / 2, 3);
  });

  it('the observation date itself takes the new rate (in force from the auction date)', () => {
    const r = riskFreeObservationOn(weekly, '2025-02-10', WEEKLY_RULE);
    expect(r.ok && r.observation.yieldPercent).toBe(6.0);
  });

  it('NC-RF1: a rate dated AFTER the lookup date is never used, even when it is the only one', () => {
    const r = riskFreeObservationOn(weekly, '2025-02-02', WEEKLY_RULE);
    expect(r).toEqual({ ok: false, reason: 'none_on_or_before' });
    // control: the closest observation by distance (02-03, one day AFTER) would have been chosen by a nearest-neighbour lookup
    const nearest = [...weekly].sort((a, b) => Math.abs(Date.parse(a.observationDate) - Date.parse('2025-02-02')) - Math.abs(Date.parse(b.observationDate) - Date.parse('2025-02-02')))[0];
    expect(nearest.observationDate).toBe('2025-02-03');
  });

  it('NC-RF3: 21 days old is still in force; 22 days is stale (the weekly T-bill constant)', () => {
    expect(riskFreeObservationOn(weekly, '2025-03-10', WEEKLY_RULE).ok).toBe(true); // 02-17 + 21 days
    expect(riskFreeObservationOn(weekly, '2025-03-11', WEEKLY_RULE)).toEqual({ ok: false, reason: 'stale' });
  });

  it('a future-dated observation in the dataset is rejected as future_dated (observation after the retrieval date)', () => {
    const ds = dataset({ retrievedOn: '2025-02-10', observations: [{ ...obs('2025-02-03', 6.5), retrievedOn: '2025-02-10' }, { ...obs('2025-02-17', 5.5), retrievedOn: '2025-02-10' }] });
    const c = cleanRiskFreeDataset(ds);
    expect(c.observations.map((o) => o.observationDate)).toEqual(['2025-02-03']);
    expect(c.issues).toEqual([{ observationDate: '2025-02-17', issue: 'future_dated' }]);
  });

  it('validation: bad dates, unit mistakes, missing source document and conflicting duplicates are dropped and reported; identical duplicates collapse', () => {
    const ds = dataset({
      observations: [
        obs('2025-02-03', 6.5),
        obs('2025-02-03', 6.5), // identical duplicate: collapses
        obs('2025-02-10', 0.065), // plausible only as a decimal fraction; accepted (0-100 range) -- see below
        obs('2025-02-17', 650), // a basis-point style unit mistake: rejected
        { ...obs('2025-02-24', 6.0), sourceDocument: '' },
        obs('2025-03-03', 6.0),
        obs('2025-03-03', 6.1), // conflicting duplicate: dropped
        obs('2025-02-30', 6.0), // not a date
      ],
    });
    const c = cleanRiskFreeDataset(ds);
    expect(c.observations.map((o) => o.observationDate)).toEqual(['2025-02-03', '2025-02-10']);
    expect(c.issues.map((i) => i.issue).sort()).toEqual(['conflicting_duplicate', 'invalid_date', 'invalid_yield', 'missing_source_document']);
    expect(c.usable).toBe(true);
  });

  it('a dataset missing its attribution, version or name is not usable at all', () => {
    expect(cleanRiskFreeDataset(dataset({ attributionText: '', observations: [obs('2025-02-03', 6.5)] })).usable).toBe(false);
    expect(cleanRiskFreeDataset(dataset({ datasetVersion: '', observations: [obs('2025-02-03', 6.5)] })).usable).toBe(false);
  });
});

describe('matched risk-free returns for a return series (the engine side)', () => {
  const dates = weekdays('2025-01-06', 8);
  const returns = buildReturns(dates.map((date, i) => ({ date, value: 100 + i })));
  const ctx = ctxInr();
  const extras = { instrumentId: 'x' };

  it('NC-RF3: a gap beyond the staleness constant makes those dates risk_free_missing (risk_free_stale) and the WHOLE match fails', () => {
    // observations 2025-01-06 and then nothing until 2025-02-03: intervals starting after 2025-01-27 have no rate in force
    const gappy = dataset({ observations: [obs('2025-01-06', 6.5), obs('2025-02-03', 6.5)] });
    const long = buildReturns(weekdays('2025-01-06', 25).map((date, i) => ({ date, value: 100 + i })));
    const m = matchRiskFree(long, gappy, ctx, 'sharpe_ratio', extras, 'daily');
    expect(m.ok).toBe(false);
    if (m.ok) throw new Error('unreachable');
    expect(m.result.state).toBe('risk_free_missing');
    expect(m.result.reason).toBe('risk_free_stale');
    expect(m.result.detail).toContain('21 days');
    expect(m.result.detail).not.toMatch(ISO_DATE_IN_TEXT);
    // control: the SAME series is fully covered when the gap is closed
    const covered = dataset({ observations: [obs('2025-01-06', 6.5), obs('2025-01-20', 6.5), obs('2025-02-03', 6.5)] });
    expect(matchRiskFree(long, covered, ctx, 'sharpe_ratio', extras, 'daily').ok).toBe(true);
  });

  it('data that starts after the window is risk_free_coverage_incomplete (nothing assumed for the missing start)', () => {
    const late = dataset({ observations: [obs('2025-01-10', 6.5)] });
    const m = matchRiskFree(returns, late, ctx, 'sharpe_ratio', extras, 'daily');
    expect(m.ok).toBe(false);
    expect(!m.ok && m.result.reason).toBe('risk_free_coverage_incomplete');
  });

  it('the provenance names the series, source, attribution, version, retrieval date, window, rates and conversion', () => {
    const ds = dataset({ observations: [obs('2025-01-06', 6.5), obs('2025-01-13', 6.25)] });
    const m = matchRiskFree(returns, ds, ctx, 'sharpe_ratio', extras, 'daily');
    if (!m.ok) throw new Error('match expected');
    expect(m.provenance).toMatchObject({
      seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD',
      source: 'Reserve Bank of India',
      attributionText: 'Source: Reserve Bank of India',
      datasetVersion: 'test-fixture-v1',
      retrievedOn: '2026-10-03',
      termsReviewStatus: 'po_accepted_2026-10-03',
      cadence: 'weekly_auction',
      verifiedThroughDate: null,
      frequency: 'daily',
      periodsPerYear: 252,
      conversion: 'compound_per_period_1_over_n',
      maxStalenessDays: 21,
      observationFirstDate: '2025-01-06',
      observationLastDate: '2025-01-13',
      distinctObservationCount: 2,
      yieldPercentAtWindowStart: 6.5,
      yieldPercentAtWindowEnd: 6.25,
      minYieldPercent: 6.25,
      maxYieldPercent: 6.5,
      windowStart: '2025-01-06',
    });
    expect(m.provenance.disclosureText).toContain('Source: Reserve Bank of India');
    expect(m.provenance.disclosureText).toContain('06-01-2025');
    expect(m.provenance.disclosureText).toContain('13-01-2025');
    expect(m.provenance.disclosureText).toContain('6.5%');
    expect(m.provenance.disclosureText).toContain('(1 + yield) ^ (1 / 252) - 1');
    expect(m.provenance.disclosureText).not.toMatch(ISO_DATE_IN_TEXT);
    // PO-accepted terms: the attribution is printed, no "pending" notice
    expect(m.disclosures.map((d) => d.code)).toEqual(['risk_free_series_used']);
    // a series whose terms are still pending adds the notice; confirmed-in-writing drops it again
    const pending = matchRiskFree(returns, { ...ds, termsReviewStatus: 'pending_confirmation' }, ctx, 'sharpe_ratio', extras, 'daily');
    expect(pending.ok && pending.disclosures.map((d) => d.code)).toEqual(['risk_free_series_used', 'risk_free_terms_pending']);
    const confirmed = matchRiskFree(returns, { ...ds, termsReviewStatus: 'confirmed_in_writing' }, ctx, 'sharpe_ratio', extras, 'daily');
    expect(confirmed.ok && confirmed.disclosures.map((d) => d.code)).toEqual(['risk_free_series_used']);
  });
});

describe('Sharpe / Sortino / alpha with a supplied series (Fixture B): available, with hand-computed values', () => {
  const { scheme, benchmarks } = fixtureB();
  const tbill = weeklyDataset(2.5518911987697367); // periodic daily rf = 0.0001 exactly

  it('Sharpe: mean(r - rf) / sample_sd(r - rf), rf matched per interval (matrix 18)', () => {
    const r = sharpeRatio(scheme, ctxInr(), tbill);
    if (r.state !== 'available') throw new Error(`${r.state} ${'reason' in r ? r.reason : ''}`);
    // oracle + closed form: mean excess = 0.0005 - 0.0001 = 0.0004; sd = sqrt(0.03399 / 59) = 0.024002118550562453
    expectClose(r.value.meanExcessReturn, 0.0004, 1e-12);
    expectClose(r.value.sampleSdExcessReturn, 0.024002118550562453, 1e-12);
    expectClose(r.value.periodicRatio, 0.016665195580855366, 1e-11);
    expectClose(r.value.annualisedRatio, 0.26455177834317544, 1e-11);
    expect(r.value.returnCount).toBe(60);
    expect(r.provenance.riskFree?.seriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    expect(r.provenance.convention.sharpe).toBe('mean_excess_over_sample_sd_excess');
    expect(r.disclosures.map((d) => d.code)).toContain('risk_free_series_used');
  });

  it('Sortino: MAR = matched risk-free, downside over ALL periods (declared), matches the oracle (matrix 19)', () => {
    const r = sortinoRatio(scheme, ctxInr(), tbill);
    if (r.state !== 'available') throw new Error(r.state);
    // hand: downside terms are (-0.0126)^2 and (-0.0316)^2 per 4-cycle = 0.00115732; x15 / 60 = 2.8933e-4; sqrt = 0.017009703113223346
    expectClose(r.value.downsideDeviation, 0.017009703113223346, 1e-11);
    expectClose(r.value.periodicRatio, 0.023515989511247843, 1e-11);
    expectClose(r.value.annualisedRatio, 0.37330476048219086, 1e-11);
    expect(r.value.downsideConvention).toContain('all periods');
  });

  it('Jensen alpha: mean(r_s) - [rf + beta (mean(r_b) - rf)] = 0.00055 per period; x252 = 0.1386 (arithmetic)', () => {
    const r = jensenAlpha(scheme, ctxInr(), benchmarks, tbill);
    if (r.state !== 'available') throw new Error(`${r.state} ${'reason' in r ? r.reason : ''}`);
    expectClose(r.value.beta, 1.5, 1e-12);
    expectClose(r.value.alphaPeriodic, 0.00055, 1e-12);
    expectClose(r.value.alphaAnnualised, 0.1386, 1e-11);
    expect(r.value.annualisationConvention).toBe('arithmetic_periodic_alpha_times_periods_per_year');
    expectClose(r.value.meanRiskFreeReturn, 0.0001, 1e-12);
    expect(r.provenance.riskFree?.disclosureText).toContain('Source: Reserve Bank of India');
    expect(r.provenance.benchmark?.label).toBeTruthy();
  });

  it('NC-RF4: switching to the repo-rate series gives DIFFERENT, hand-computed values (T-bill 6.5% vs repo 6.0%)', () => {
    const tb = weeklyDataset(6.5);
    const repo = repoDataset(6.0); // a policy_change series: one change observation, verified through the window
    const a = sharpeRatio(scheme, ctxInr(), tb);
    const b = sharpeRatio(scheme, ctxInr(), repo);
    if (a.state !== 'available' || b.state !== 'available') throw new Error('available expected');
    expectClose(a.value.annualisedRatio, 0.16539034831368709, 1e-11);
    expectClose(b.value.annualisedRatio, 0.17774403251924644, 1e-11);
    expect(a.value.annualisedRatio).not.toBeCloseTo(b.value.annualisedRatio, 3);
    expect(a.provenance.riskFree?.seriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    expect(b.provenance.riskFree?.seriesId).toBe('RBI_POLICY_REPO_RATE');
    expect(b.provenance.riskFree?.cadence).toBe('policy_change');
    const sa = sortinoRatio(scheme, ctxInr(), tb);
    const sb = sortinoRatio(scheme, ctxInr(), repo);
    if (sa.state !== 'available' || sb.state !== 'available') throw new Error('available expected');
    expectClose(sa.value.annualisedRatio, 0.23205021334279251, 1e-11);
    expectClose(sb.value.annualisedRatio, 0.24956018531030374, 1e-11);
    const aa = jensenAlpha(scheme, ctxInr(), benchmarks, tb);
    const ab = jensenAlpha(scheme, ctxInr(), benchmarks, repo);
    if (aa.state !== 'available' || ab.state !== 'available') throw new Error('available expected');
    expectClose(aa.value.alphaAnnualised, 0.15749133425897130, 1e-11);
    expectClose(ab.value.alphaAnnualised, 0.15513782264071817, 1e-11);
  });

  it('a yield that STEPS mid-window is applied per interval from the auction date (6.5% to 6.25% from 12-02-2025)', () => {
    const mondays = ['2024-12-30', '2025-01-06', '2025-01-13', '2025-01-20', '2025-01-27', '2025-02-03', '2025-02-10'].map((d) => obs(d, 6.5));
    const wednesdays = ['2025-02-12', '2025-02-19', '2025-02-26', '2025-03-05', '2025-03-12', '2025-03-19', '2025-03-26'].map((d) => obs(d, 6.25));
    const stepped = dataset({ observations: [...mondays, ...wednesdays] });
    const r = sharpeRatio(scheme, ctxInr(), stepped);
    if (r.state !== 'available') throw new Error(r.state);
    // oracle: 27 intervals start before 12-02-2025 (old rate 0.00024993122427755003), 33 on or after it (new rate 0.00024060283631741263)
    expectClose(r.value.meanExcessReturn, 0.00025519938910052554, 1e-12);
    expectClose(r.value.sampleSdExcessReturn, 0.024001908213476206, 1e-12);
    expectClose(r.value.periodicRatio, 0.010632462503845435, 1e-11);
    // 6 Monday auctions (06-01 .. 10-02) and 7 Wednesday auctions (12-02 .. 26-03) were actually used
    expect(r.provenance.riskFree).toMatchObject({ yieldPercentAtWindowStart: 6.5, yieldPercentAtWindowEnd: 6.25, distinctObservationCount: 13, minYieldPercent: 6.25, maxYieldPercent: 6.5 });
    const alpha = jensenAlpha(scheme, ctxInr(), benchmarks, stepped);
    if (alpha.state !== 'available') throw new Error(alpha.state);
    expectClose(alpha.value.meanRiskFreeReturn, 0.00024480061089947446, 1e-12);
    expectClose(alpha.value.alphaPeriodic, 0.00062240030544973723, 1e-11);
  });

  it('NC-RF1 (engine): a future-dated yield placed inside the window does not move the result', () => {
    const base = weeklyDataset(6.5);
    // an auction dated 2025-02-12 with a very different yield, retrieved only on 2025-02-05: a future-dated row, dropped at validation
    const withFuture = { ...base, observations: [...base.observations, { ...obs('2025-02-12', 25), retrievedOn: '2025-02-05' }] };
    const a = sharpeRatio(scheme, ctxInr(), base);
    const b = sharpeRatio(scheme, ctxInr(), withFuture);
    if (a.state !== 'available' || b.state !== 'available') throw new Error('available expected');
    expect(b.value.annualisedRatio).toBe(a.value.annualisedRatio);
  });
});

describe('risk_free_missing: never zero (NC-RF5)', () => {
  const { scheme, benchmarks } = fixtureB();

  it('no dataset -> Sharpe, Sortino and alpha are risk_free_missing with no value; rf = 0 would have given a different number', () => {
    for (const r of [sharpeRatio(scheme, ctxInr(), null), sortinoRatio(scheme, ctxInr(), null), jensenAlpha(scheme, ctxInr(), benchmarks, null)]) {
      expect(r.state).toBe('risk_free_missing');
      expect('value' in r).toBe(false);
      expect(r.state === 'risk_free_missing' && r.reason).toBe('risk_free_dataset_not_configured');
    }
    // control: with an explicit 0% dataset the ratio exists and is 0.0005 / sd x sqrt(252) = 0.3306..., not what a silent zero must never produce
    const zeroYield = sharpeRatio(scheme, ctxInr(), weeklyDataset(0));
    if (zeroYield.state !== 'available') throw new Error('available expected');
    expectClose(zeroYield.value.annualisedRatio, (0.0005 / 0.024002118550562453) * Math.sqrt(252), 1e-10);
  });

  it('a dataset switched OFF (dataset flag, master switch, or declined terms) is risk_free_series_disabled; nothing is deleted', () => {
    const on = weeklyDataset(6.5);
    const offByDataset = sharpeRatio(scheme, ctxInr(), { ...on, enabled: false });
    expect(offByDataset.state).toBe('risk_free_missing');
    expect(offByDataset.state === 'risk_free_missing' && offByDataset.reason).toBe('risk_free_series_disabled');

    const masterOff: RiskFreeConfig = { ...NAV2_RISK_FREE_CONFIG, enabled: false };
    const supplyOff = selectRiskFreeSupply([on], masterOff);
    expect(supplyOff?.enabled).toBe(false);
    expect(supplyOff?.observations.length).toBe(on.observations.length); // data retained
    expect(sharpeRatio(scheme, ctxInr(), supplyOff).state).toBe('risk_free_missing');

    const declined: RiskFreeConfig = { ...NAV2_RISK_FREE_CONFIG, termsReviewStatus: 'declined' };
    expect(sharpeRatio(scheme, ctxInr(), selectRiskFreeSupply([on], declined)).state).toBe('risk_free_missing');
    expect(sharpeRatio(scheme, ctxInr(), selectRiskFreeSupply([{ ...on, termsReviewStatus: 'declined' }], NAV2_RISK_FREE_CONFIG)).state).toBe('risk_free_missing');

    // switching back on restores the figure
    expect(sharpeRatio(scheme, ctxInr(), selectRiskFreeSupply([on], NAV2_RISK_FREE_CONFIG)).state).toBe('available');
  });

  it('selectRiskFreeSupply picks the configured series and returns null when that series was not supplied', () => {
    const tb = weeklyDataset(6.5);
    const repo = repoDataset(6.0);
    expect(selectRiskFreeSupply([tb, repo], NAV2_RISK_FREE_CONFIG)?.seriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    expect(selectRiskFreeSupply([tb, repo], { ...NAV2_RISK_FREE_CONFIG, selectedSeriesId: 'RBI_POLICY_REPO_RATE' })?.seriesId).toBe('RBI_POLICY_REPO_RATE');
    expect(selectRiskFreeSupply([tb], { ...NAV2_RISK_FREE_CONFIG, selectedSeriesId: 'RBI_POLICY_REPO_RATE' })).toBeNull();
    expect(selectRiskFreeSupply([], NAV2_RISK_FREE_CONFIG)).toBeNull();
  });

  it('every sentence produced is day-first and free of ISO dates', () => {
    const r = sharpeRatio(scheme, ctxInr(), weeklyDataset(6.5));
    const texts = [...r.disclosures.map((d) => d.detail), r.provenance.riskFree!.disclosureText];
    expect(texts.length).toBeGreaterThan(1);
    for (const t of allStrings(texts)) expect(t, t).not.toMatch(ISO_DATE_IN_TEXT);
  });
});


describe('policy_change series (the repo rate): changes only, freshness is the verified-through date', () => {
  // synthetic repo history: rows only where the rate CHANGED
  const changes = [obs('2025-02-07', 6.25), obs('2025-04-09', 6.0), obs('2025-06-06', 5.5), obs('2025-12-05', 5.25)];
  const rule = (verifiedThroughDate: string | null): RiskFreeLookupRule => ({ cadence: 'policy_change', maxStalenessDays: 90, verifiedThroughDate });

  it('the rate in force is the latest CHANGE on or before the date, whatever its age: 5.25 held for months is still 5.25 (the last change is far older than 90 days)', () => {
    const r = riskFreeObservationOn(changes, '2026-03-10', rule('2026-09-25'));
    expect(r.ok && r.observation.yieldPercent).toBe(5.25);
    expect(r.ok && r.ageDays).toBe(95); // 05-12-2025 to 10-03-2026: more than the 90-day window, yet fresh because the series was verified later
    // earlier dates step through the history
    expect(riskFreeObservationOn(changes, '2025-05-01', rule('2026-09-25'))).toMatchObject({ ok: true, observation: { yieldPercent: 6.0 } });
    expect(riskFreeObservationOn(changes, '2025-06-06', rule('2026-09-25'))).toMatchObject({ ok: true, observation: { yieldPercent: 5.5 } });
  });

  it('NC-RF3 (repo): a date more than 90 days after the verified-through date has NO rate; so does an unverified series; a date before the first change has none', () => {
    expect(riskFreeObservationOn(changes, '2026-12-24', rule('2026-09-25')).ok).toBe(true); // verified-through plus 90 days
    expect(riskFreeObservationOn(changes, '2026-12-25', rule('2026-09-25'))).toEqual({ ok: false, reason: 'stale' });
    expect(riskFreeObservationOn(changes, '2026-03-10', rule(null))).toEqual({ ok: false, reason: 'stale' });
    expect(riskFreeObservationOn(changes, '2025-01-01', rule('2026-09-25'))).toEqual({ ok: false, reason: 'none_on_or_before' });
  });

  it('through the engine: a repo series covers a window with ONE change observation and a verification date, and goes risk_free_missing when verification lapses', () => {
    const { scheme } = fixtureB();
    expect(sharpeRatio(scheme, ctxInr(), repoDataset(6.0)).state).toBe('available');
    const lapsed = sharpeRatio(scheme, ctxInr(), repoDataset(6.0, { verifiedThroughDate: '2024-12-10' })); // 90 days later is 10-03-2025; the window runs to 28-03-2025
    expect(lapsed.state).toBe('risk_free_missing');
    expect(lapsed.state === 'risk_free_missing' && lapsed.reason).toBe('risk_free_stale');
    expect(lapsed.state !== 'available' && lapsed.detail).toContain('10-12-2024');
    expect(sharpeRatio(scheme, ctxInr(), repoDataset(6.0, { verifiedThroughDate: null })).state).toBe('risk_free_missing');
  });
});

describe('gap rows: an auction with no accepted bids is recorded as a gap and never as a value', () => {
  it('a valid gap row is kept apart from the values and the lookup never uses it', () => {
    const ds = dataset({
      observations: [
        obs('2025-03-12', 6.5),
        { ...obs('2025-03-19', 0), yieldPercent: null, kind: 'gap', gapReason: 'no_accepted_bids' },
        obs('2025-03-26', 6.0),
      ],
    });
    const c = cleanRiskFreeDataset(ds);
    expect(c.observations.map((o) => o.observationDate)).toEqual(['2025-03-12', '2025-03-26']);
    expect(c.gaps.map((o) => o.observationDate)).toEqual(['2025-03-19']);
    expect(c.issues).toEqual([]);
    // on the gap week the latest VALUE on or before the date is the earlier auction: nothing is invented for the gap
    const r = riskFreeObservationOn(c.observations, '2025-03-20', WEEKLY_RULE);
    expect(r.ok && r.observation.observationDate).toBe('2025-03-12');
  });

  it('a gap row carrying a value, or with no reason, is rejected (it can never smuggle a number in)', () => {
    const ds = dataset({
      observations: [
        { ...obs('2025-03-19', 6.1), kind: 'gap', gapReason: 'no_accepted_bids' },
        { ...obs('2025-03-26', 0), yieldPercent: null, kind: 'gap', gapReason: null },
        obs('2025-03-12', 6.5),
      ],
    });
    const c = cleanRiskFreeDataset(ds);
    expect(c.gaps).toEqual([]);
    expect(c.issues.map((i) => i.issue).sort()).toEqual(['gap_row_carries_value', 'gap_row_without_reason']);
    // and a value row with a null yield is an invalid yield, not a gap
    expect(cleanRiskFreeDataset(dataset({ observations: [{ ...obs('2025-03-12', 0), yieldPercent: null }] })).issues.map((i) => i.issue)).toEqual(['invalid_yield']);
  });
});

describe('freshness signal for the admin dashboard (days since the last observation / verification)', () => {
  it('weekly T-bill: fresh within 21 days of the last auction, stale after, no_data when empty', () => {
    const ds = dataset({ observations: [obs('2026-09-23', 5.39), obs('2026-09-30', 5.5199)] });
    expect(riskFreeFreshness(ds, '2026-10-03')).toMatchObject({ state: 'fresh', basis: 'last_observation', lastObservationDate: '2026-09-30', daysSince: 3, staleAfterDays: 21 });
    expect(riskFreeFreshness(ds, '2026-10-21').state).toBe('fresh'); // 21 days
    expect(riskFreeFreshness(ds, '2026-10-22')).toMatchObject({ state: 'stale', daysSince: 22 });
    expect(riskFreeFreshness(dataset({ observations: [] }), '2026-10-03')).toMatchObject({ state: 'no_data', daysSince: null });
  });

  it('a silently broken job is visible: the same state is what makes the ratios risk_free_missing', () => {
    const ds = dataset({ observations: [obs('2025-01-06', 6.5)] });
    expect(riskFreeFreshness(ds, '2025-03-31').state).toBe('stale');
    const { scheme } = fixtureB();
    expect(sharpeRatio(scheme, ctxInr(), ds).state).toBe('risk_free_missing');
  });

  it('repo rate: freshness is measured from the verification date, not from the last change', () => {
    const ds = repoDataset(5.25, { observations: [obs('2025-12-05', 5.25)], verifiedThroughDate: '2026-09-25' });
    expect(riskFreeFreshness(ds, '2026-10-03')).toMatchObject({ state: 'fresh', basis: 'verification', daysSince: 8, staleAfterDays: 90, lastObservationDate: '2025-12-05' });
    expect(riskFreeFreshness(ds, '2026-12-25')).toMatchObject({ state: 'stale', daysSince: 91 });
    expect(riskFreeFreshness({ ...ds, verifiedThroughDate: null }, '2026-10-03').state).toBe('no_data');
  });
});
