// NAV2 Stage 1 -- scheme-performance RISK and RELATIVE measures against
// independently computed values (scripts/nav2_independent_oracle.py): Fixture A
// (volatility, drawdown), Fixture B (beta, alpha, correlation; Sharpe / Sortino
// are in nav2RiskFreeDataset.test.ts with the risk-free series).
//
// Matrix rows: 16, 17, 20, 21, 22, 25 (and 18 / 19 / 22-risk-free in the
// risk-free suite).
//
// NAMED NEGATIVE CONTROLS
//   NC-K1  sample standard deviation divides by n - 1 (the population value is shown to differ);
//   NC-K2  the annualisation factor follows the declared frequency (252 / 52 / 12) and a series whose
//          spacing does not match the declared frequency is refused, not annualised with the wrong factor;
//   NC-K3  zero volatility yields no Sharpe;
//   NC-K4  a MISSING benchmark never yields beta 0 or alpha 0: it yields benchmark_missing and no value,
//          for every blocker (no mapping, not entitled, catalogue unverified, price index, unknown type,
//          no series, mapping not in force for the window, benchmark changed inside the window);
//   NC-K5  beta / alpha / correlation use COMMON dates only (extra benchmark days are dropped; a benchmark
//          missing days leaves fewer common returns, and below the minimum it is benchmark_missing);
//   NC-K6  correlation is on RETURNS: two series whose NAV LEVELS correlate at 0.9996 have return
//          correlation -1, and the engine reports -1;
//   NC-K7  correlation is refused for a scheme not held in scope;
//   NC-K8  beta / alpha are refused on the category-reference benchmark (PO decision 04-10-2026).
import { describe, expect, it } from 'vitest';
import { withPolicyOverrides } from '@/lib/config/nav2/metricPolicy';
import { beta, correlationBetweenHeldSchemes, jensenAlpha, maxDrawdown, sharpeRatio, volatility } from '@/lib/engines/nav2/schemeRisk';
import { addDays, buildSeries, ctxInr, expectClose, pathFromReturns, weekdays } from './support/fixtures';
import { benchmarkFor } from './support/benchmarks';
import { fixtureB, weeklyDataset } from './support/riskFreeFixtures';

function alternating(n: number, start = 100): number[] {
  return pathFromReturns(start, Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01)));
}

describe('Fixture A3 -- 61 weekday NAVs alternating +1% / -1%: volatility', () => {
  const dates = weekdays('2025-01-06', 61);
  const s = buildSeries(dates, alternating(60));

  it('NC-K1 / matrix 16: sample sd with n - 1; annualised x sqrt(252); matches the oracle and the closed form sqrt(60 x 1e-4 / 59)', () => {
    const r = volatility(s, ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.periodicSampleSd, 0.010084389681792215, 1e-12);
    expectClose(r.value.periodicSampleSd, Math.sqrt((60 * 0.0001) / 59), 1e-12);
    expectClose(r.value.annualisedVolatility, 0.16008472333132789, 1e-12);
    expect(r.value.returnCount).toBe(60);
    // control: dividing by n instead of n - 1 gives 0.01, a visibly different number
    expect(Math.abs(r.value.periodicSampleSd - 0.01)).toBeGreaterThan(5e-5);
    expect(r.provenance.convention.standardDeviation).toBe('sample_n_minus_1');
  });

  it('NC-K2 / matrix 17: the daily factor is 252 and is stated in the result and its provenance', () => {
    const r = volatility(s, ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.frequency).toBe('daily');
    expect(r.value.periodsPerYear).toBe(252);
    expect(r.value.annualisationConvention).toContain('sqrt(252)');
    expect(r.provenance.convention.periodsPerYear).toBe(252);
    expect(r.provenance.policyVersion).toBe('nav2-policy-v1');
    expect(r.provenance.definitionVersion).toBe('nav2-volatility-v1');
  });

  it('weekly (x sqrt 52) and monthly (x sqrt 12) factors, on series that really are weekly / monthly', () => {
    const weeklyDates = Array.from({ length: 32 }, (_, i) => addDays('2025-01-06', 7 * i));
    const w = volatility(buildSeries(weeklyDates, alternating(31)), ctxInr(), { start: null, end: null }, 'weekly');
    if (w.state !== 'available') throw new Error(w.state);
    expectClose(w.value.annualisedVolatility, 0.073264875182340077, 1e-12); // oracle: 0.010160010160015240 x sqrt(52)
    expect(w.value.periodsPerYear).toBe(52);

    const monthEnds = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30', '2025-05-30', '2025-06-30', '2025-07-31', '2025-08-29'];
    const lenient = withPolicyOverrides({ minimums: { volatilityReturns: 6 } }, 'test-vol-6');
    const m = volatility(buildSeries(monthEnds, alternating(7)), ctxInr(lenient), { start: null, end: null }, 'monthly');
    if (m.state !== 'available') throw new Error(m.state);
    expectClose(m.value.annualisedVolatility, 0.037032803990902058, 1e-12); // oracle: 0.010690449676496975 x sqrt(12)
    expect(m.value.periodsPerYear).toBe(12);
  });

  it('NC-K2: a weekly-spaced series declared DAILY is refused (irregular_return_intervals), never annualised by sqrt(252)', () => {
    const weeklyDates = Array.from({ length: 32 }, (_, i) => addDays('2025-01-06', 7 * i));
    const r = volatility(buildSeries(weeklyDates, alternating(31)), ctxInr(), { start: null, end: null }, 'daily');
    expect(r.state).toBe('insufficient_history');
    expect(r.state === 'insufficient_history' && r.reason).toBe('irregular_return_intervals');
    expect('value' in r).toBe(false);
  });

  it('minimum evidence: 30 returns are enough, 29 are not; below 60 the figure carries the "below preferred" disclosure', () => {
    const d31 = weekdays('2025-01-06', 31);
    const d30 = weekdays('2025-01-06', 30);
    expect(volatility(buildSeries(d31, alternating(30)), ctxInr()).state).toBe('available'); // 30 returns
    const short = volatility(buildSeries(d30, alternating(29)), ctxInr()); // 29 returns
    expect(short.state).toBe('insufficient_history');
    expect(short.state === 'insufficient_history' && short.reason).toBe('too_few_returns');
    const forty = volatility(buildSeries(weekdays('2025-01-06', 41), alternating(40)), ctxInr());
    if (forty.state !== 'available') throw new Error(forty.state);
    expectClose(forty.value.periodicSampleSd, 0.010127393670836666, 1e-12); // sqrt(40e-4 / 39)
    expect(forty.disclosures.map((d) => d.code)).toContain('below_preferred_observations');
    const sixty = volatility(s, ctxInr());
    expect(sixty.disclosures.map((d) => d.code)).not.toContain('below_preferred_observations');
  });

  it('NC-K3: zero volatility yields no Sharpe (a constant NAV), with a risk-free dataset supplied', () => {
    const flat = buildSeries(weekdays('2025-01-06', 61), Array(61).fill(100));
    const v = volatility(flat, ctxInr());
    expect(v.state === 'available' && v.value.annualisedVolatility).toBe(0); // zero volatility is a real, valid figure
    const r = sharpeRatio(flat, ctxInr(), weeklyDataset(6.5));
    expect(r.state).toBe('not_applicable');
    expect(r.state === 'not_applicable' && r.reason).toBe('zero_volatility');
    expect('value' in r).toBe(false);
  });
});

describe('maximum drawdown (matrix 20)', () => {
  it('spec worked example 3: 100, 120, 90, 108, 125 -> peak 120, trough 90, max drawdown -25%, recovered at 125', () => {
    const dates = weekdays('2025-01-06', 5); // 06, 07, 08, 09, 10 January
    const r = maxDrawdown(buildSeries(dates, [100, 120, 90, 108, 125]), ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.maxDrawdown, -0.25, 1e-14);
    expect(r.value).toMatchObject({ status: 'recovered', peakDate: '2025-01-07', peakNav: 120, troughDate: '2025-01-08', troughNav: 90, recoveryDate: '2025-01-10', daysPeakToTrough: 1, daysTroughToRecovery: 2 });
    // recovery is the FIRST observation at or above the prior peak: 108 (09-01) is below 120, so it is 125 on 10-01
    expect(r.value.recoveryDate).not.toBe('2025-01-09');
    expect(r.disclosures.map((d) => d.code)).toContain('short_period');
  });

  it('a series that never regains its peak is not_recovered, with the worst episode from the oracle (-1.2867%)', () => {
    const dates = weekdays('2025-01-06', 61);
    const r = maxDrawdown(buildSeries(dates, alternating(60)), ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.maxDrawdown, -0.012866984215109826, 1e-12); // 100 x 0.9999^30 / 101 - 1
    expect(r.value.status).toBe('not_recovered');
    expect(r.value.recoveryDate).toBeNull();
    expect(r.value.daysTroughToRecovery).toBeNull();
    expect(r.value.peakDate).toBe(dates[1]); // the first +1% day set the 101 peak that was never regained
    expect(r.value.troughDate).toBe(dates[60]);
    expectClose(r.value.peakNav!, 101, 1e-12);
  });

  it('a series that only rises has no drawdown (value 0, status no_drawdown, no peak / trough dates)', () => {
    const r = maxDrawdown(buildSeries(weekdays('2025-01-06', 4), [100, 101, 102, 103]), ctxInr());
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value).toMatchObject({ maxDrawdown: 0, status: 'no_drawdown', peakDate: null, troughDate: null });
  });

  it('needs at least 2 observations', () => {
    expect(maxDrawdown(buildSeries(['2025-01-06'], [100]), ctxInr()).state).toBe('insufficient_history');
  });
});

describe('Fixture B -- beta, alpha, correlation (matrix 21)', () => {
  const { scheme, dates, benchmarks } = fixtureB();

  it('beta = cov(r_s, r_b) / var(r_b) = 1.5 on common dates (closed form: the scheme is 1.5 x benchmark + a constant + an orthogonal term)', () => {
    const r = beta(scheme, ctxInr(), benchmarks);
    if (r.state !== 'available') throw new Error(`${r.state}`);
    expectClose(r.value.beta, 1.5, 1e-12);
    expect(r.value.commonReturnCount).toBe(60);
    expect(r.provenance.benchmark).toMatchObject({ benchmarkKey: 'IN_TEST_TRI', basis: 'declared', returnType: 'TRI', datasetVersion: 'test-benchmark-v1', commonObservationCount: 61 });
    expect(r.disclosures.map((d) => d.code)).toContain('benchmark_basis');
    // 60 returns is above the 60 minimum but below the 252 preferred for a one-year claim
    expect(r.disclosures.map((d) => d.code)).toContain('below_preferred_observations');
  });

  it('alpha uses the SAME aligned returns and the declared arithmetic annualisation (0.00055 per period, 0.1386 a year)', () => {
    const r = jensenAlpha(scheme, ctxInr(), benchmarks, weeklyDataset(2.5518911987697367));
    if (r.state !== 'available') throw new Error(`${r.state}`);
    expectClose(r.value.alphaPeriodic, 0.00055, 1e-12);
    expectClose(r.value.alphaAnnualised, 0.1386, 1e-11);
    expectClose(r.value.beta, 1.5, 1e-12);
    expectClose(r.value.meanSchemeReturn, 0.0005, 1e-12);
    expectClose(r.value.meanBenchmarkReturn, 0, 1e-12);
  });

  it('NC-K5: extra benchmark days (weekends the scheme has no NAV for) are dropped: still 60 common returns, beta unchanged', () => {
    const extraDates = [...dates, '2025-01-11', '2025-01-12', '2025-02-01'];
    const full = beta(scheme, ctxInr(), benchmarks);
    const padded = beta(scheme, ctxInr(), [{ ...benchmarks[0], series: [...benchmarks[0].series, ...extraDates.slice(61).map((d) => ({ date: new Date(`${d}T00:00:00.000Z`), value: 5000 }))] }]);
    if (full.state !== 'available' || padded.state !== 'available') throw new Error('available expected');
    expect(padded.value.commonReturnCount).toBe(60);
    expect(padded.value.beta).toBe(full.value.beta);
  });

  it('NC-K5: a benchmark missing one of the scheme days leaves 59 common returns: benchmark_missing (benchmark_overlap_insufficient), not a beta from 59', () => {
    const series = benchmarks[0].series.filter((_, i) => i !== 30);
    const r = beta(scheme, ctxInr(), [{ ...benchmarks[0], series }]);
    expect(r.state).toBe('benchmark_missing');
    expect(r.state === 'benchmark_missing' && r.reason).toBe('benchmark_overlap_insufficient');
    expect('value' in r).toBe(false);
  });

  it('NC-K4: every missing-benchmark blocker is benchmark_missing with NO number (never beta 0, never alpha 0)', () => {
    const base = benchmarks[0];
    const rf = weeklyDataset(6.5);
    const cases: Array<[string, Parameters<typeof beta>[2], string]> = [
      ['no mapping at all', [], 'no_benchmark_mapping'],
      ['undefined', undefined, 'no_benchmark_mapping'],
      ['not entitled', [{ ...base, entitled: false }], 'benchmark_not_entitled'],
      ['catalogue not verified', [{ ...base, catalogueVerified: false }], 'benchmark_catalogue_not_verified'],
      ['a price index where total return is required', [{ ...base, returnType: 'PRI' }], 'benchmark_price_index'],
      ['unknown return type', [{ ...base, returnType: 'OTHER' }], 'benchmark_return_type_unknown'],
      ['no published levels', [{ ...base, series: [] }], 'benchmark_no_series'],
      ['mapping starts after the window starts', [{ ...base, effectiveFrom: new Date('2025-02-01T00:00:00.000Z') }], 'benchmark_mapping_not_effective'],
      ['mapping ended inside the window', [{ ...base, effectiveTo: new Date('2025-02-15T00:00:00.000Z') }], 'benchmark_mapping_not_effective'],
      ['benchmark changed inside the window', [{ ...base, effectiveTo: new Date('2025-02-14T00:00:00.000Z') }, { ...base, benchmarkId: 'bm-2', benchmarkKey: 'IN_OTHER', label: 'Other', effectiveFrom: new Date('2025-02-15T00:00:00.000Z') }], 'benchmark_changed_in_window'],
    ];
    for (const [label, input, reason] of cases) {
      const b = beta(scheme, ctxInr(), input);
      const a = jensenAlpha(scheme, ctxInr(), input, rf);
      expect(b.state, label).toBe('benchmark_missing');
      expect(a.state, label).toBe('benchmark_missing');
      expect(b.state === 'benchmark_missing' && b.reason, label).toBe(reason);
      expect('value' in b, label).toBe(false);
      expect('value' in a, label).toBe(false);
    }
  });

  it('NC-K8 (PO decision 04-10-2026): beta and alpha are NOT shown on the category-reference benchmark; a declared one wins when both exist', () => {
    const declared = { ...benchmarks[0], basis: 'declared' as const };
    const category = { ...benchmarks[0], basis: 'category_reference' as const, categoryLabel: 'Flexi Cap', benchmarkId: 'bm-cat', benchmarkKey: 'IN_NIFTY_500_TRI', label: 'Nifty 500 TRI' };
    const both = beta(scheme, ctxInr(), [category, declared]);
    if (both.state !== 'available') throw new Error(both.state);
    expect(both.provenance.benchmark?.basis).toBe('declared');
    expect(both.provenance.benchmark?.benchmarkKey).toBe('IN_TEST_TRI'); // the declared one, not the category's
    for (const r of [beta(scheme, ctxInr(), [category]), jensenAlpha(scheme, ctxInr(), [category], weeklyDataset(6.5))]) {
      expect(r.state).toBe('benchmark_missing');
      expect(r.state === 'benchmark_missing' && r.reason).toBe('benchmark_category_reference_not_allowed');
      expect('value' in r).toBe(false);
    }
    // control: the SAME series as a declared benchmark gives a number, so it is the label that blocks it, not the data
    expect(beta(scheme, ctxInr(), [{ ...category, basis: 'declared' }]).state).toBe('available');
  });

  it('the category-reference rule is a policy flag (versioned): when a future decision enables it, the honest label travels and the same gates apply', () => {
    const allow = withPolicyOverrides({ benchmark: { allowCategoryReference: true } }, 'test-allow-category');
    const category = { ...benchmarks[0], basis: 'category_reference' as const, categoryLabel: 'Flexi Cap', benchmarkId: 'bm-cat', benchmarkKey: 'IN_NIFTY_500_TRI', label: 'Nifty 500 TRI' };
    const r = beta(scheme, ctxInr(allow), [category]);
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.provenance.benchmark?.basis).toBe('category_reference');
    expect(r.provenance.benchmark?.basisLabel).toContain("not this fund's own declared benchmark");
    expect(r.disclosures.find((d) => d.code === 'benchmark_basis')?.detail).toContain('Flexi Cap');
    expect(beta(scheme, ctxInr(allow), [{ ...category, entitled: false }]).state).toBe('benchmark_missing');
    expect(beta(scheme, ctxInr(allow), [{ ...category, returnType: 'PRI' }]).state).toBe('benchmark_missing');
  });

  it('a flat benchmark has zero variance: not_applicable (zero_benchmark_variance), no beta', () => {
    const flat = benchmarkFor(dates, Array(61).fill(1000));
    const r = beta(scheme, ctxInr(), flat);
    expect(r.state).toBe('not_applicable');
    expect(r.state === 'not_applicable' && r.reason).toBe('zero_benchmark_variance');
  });

  it('alpha without a risk-free dataset is risk_free_missing (not zero), even with a good benchmark', () => {
    const r = jensenAlpha(scheme, ctxInr(), benchmarks, null);
    expect(r.state).toBe('risk_free_missing');
    expect('value' in r).toBe(false);
  });
});

describe('Fixture B -- correlation between held schemes (matrix 25)', () => {
  const { scheme, dates } = fixtureB();
  const other = buildSeries(dates, pathFromReturns(50, bReturnsOther()), { identity: { instrumentId: 'inst-b', schemeName: 'Beta Debt Fund - Direct - Growth' } });
  const held = new Set(['inst-a', 'inst-b']);

  function bReturnsOther(): number[] {
    // the benchmark pattern itself: scheme A = 1.5 b + 0.0005 + e, so corr(A, b) has the closed form 0.0225 / sqrt(0.03399 x 0.015)
    return Array.from({ length: 60 }, (_, i) => [0.01, -0.01, 0.02, -0.02][i % 4]);
  }

  it('Pearson correlation of aligned RETURNS = 0.99646329572905807 (oracle and closed form)', () => {
    const r = correlationBetweenHeldSchemes(scheme, other, ctxInr(), held);
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.correlation, 0.99646329572905807, 1e-12);
    expectClose(r.value.correlation, 0.0225 / Math.sqrt(0.03399 * 0.015), 1e-12);
    expect(r.value.commonReturnCount).toBe(60);
    expect(r.value.correlatedSeries).toBe('periodic_simple_returns');
    expect(r.value.windowStart).toBe(dates[0]);
    expect(r.value.windowEnd).toBe(dates[60]);
    // 60 shared returns is not below the "disclose below 60" line
    expect(r.disclosures.map((d) => d.code)).not.toContain('below_preferred_observations');
  });

  it('NC-K6 / matrix 25: NAV levels that correlate at 0.9996 have RETURN correlation -1, and the engine reports -1', () => {
    const ra = Array.from({ length: 60 }, (_, i) => 0.01 + 0.005 * (i % 2 === 0 ? 1 : -1));
    const rb = Array.from({ length: 60 }, (_, i) => 0.01 - 0.005 * (i % 2 === 0 ? 1 : -1));
    const a = buildSeries(dates, pathFromReturns(100, ra));
    const b = buildSeries(dates, pathFromReturns(100, rb), { identity: { instrumentId: 'inst-b' } });
    const r = correlationBetweenHeldSchemes(a, b, ctxInr(), held);
    if (r.state !== 'available') throw new Error(r.state);
    expectClose(r.value.correlation, -1, 1e-9);
    // the control: Pearson on the NAV LEVELS (the wrong measure) is ~ +1 (oracle 0.99958532519865144)
    const la = a.observations.map((o) => o.value);
    const lb = b.observations.map((o) => o.value);
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    const ma = mean(la);
    const mb = mean(lb);
    let cov = 0;
    let va = 0;
    let vb = 0;
    la.forEach((v, i) => {
      cov += (v - ma) * (lb[i] - mb);
      va += (v - ma) ** 2;
      vb += (lb[i] - mb) ** 2;
    });
    const levelsCorr = cov / Math.sqrt(va * vb);
    expectClose(levelsCorr, 0.99958532519865144, 1e-9);
    expect(levelsCorr).toBeGreaterThan(0.99);
    expect(r.value.correlation).toBeLessThan(-0.99);
  });

  it('NC-K7: a scheme not held in scope is not_applicable (scheme_not_held_in_scope); the engine cannot be used to correlate arbitrary funds', () => {
    const r = correlationBetweenHeldSchemes(scheme, other, ctxInr(), new Set(['inst-a']));
    expect(r.state).toBe('not_applicable');
    expect(r.state === 'not_applicable' && r.reason).toBe('scheme_not_held_in_scope');
    expect('value' in r).toBe(false);
  });

  it('needs 30 common returns; a flat scheme has zero variance (no value)', () => {
    const shortDates = weekdays('2025-01-06', 20);
    const a = buildSeries(shortDates, alternating(19));
    const b = buildSeries(shortDates, alternating(19), { identity: { instrumentId: 'inst-b' } });
    expect(correlationBetweenHeldSchemes(a, b, ctxInr(), held).state).toBe('insufficient_history');
    const flat = buildSeries(dates, Array(61).fill(100), { identity: { instrumentId: 'inst-b' } });
    const z = correlationBetweenHeldSchemes(scheme, flat, ctxInr(), held);
    expect(z.state).toBe('not_applicable');
    expect(z.state === 'not_applicable' && z.reason).toBe('zero_variance');
  });

  it('between 30 and 59 common returns the result is shown with a prominent below-60 disclosure', () => {
    const d = weekdays('2025-01-06', 41);
    const a = buildSeries(d, pathFromReturns(100, Array.from({ length: 40 }, (_, i) => [0.01, -0.01, 0.02, -0.02][i % 4])));
    const b = buildSeries(d, pathFromReturns(100, Array.from({ length: 40 }, (_, i) => [0.015, -0.005, 0.025, -0.01][i % 4])), { identity: { instrumentId: 'inst-b' } });
    const r = correlationBetweenHeldSchemes(a, b, ctxInr(), held);
    if (r.state !== 'available') throw new Error(r.state);
    expect(r.value.commonReturnCount).toBe(40);
    expect(r.disclosures.find((x) => x.code === 'below_preferred_observations')?.detail).toContain('40');
  });
});
