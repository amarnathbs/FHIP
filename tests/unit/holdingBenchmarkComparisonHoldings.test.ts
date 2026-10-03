// The holding-period comparison through the REAL loaders (holdings table + analytics dataset +
// orchestrator) with the in-memory Supabase fake. EVIDENCE LABEL: code-level fixtures; they
// prove the wiring, the entitlement / verification / mapping gates and the per-holding window.
// They do not prove real data, a licence, or anything rendered in a browser.
import { describe, it, expect } from 'vitest';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const USER = 'user-1';
const BM = 'bm-nifty100-tri';
const access = (o: Record<string, unknown> = {}) => ({ benchmark_id: BM, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null, ...o });
const bench = (o: Record<string, unknown> = {}) => ({ benchmark_key: 'IN_NIFTY_100_TRI', benchmark_label: 'NIFTY 100 TRI', return_type: 'TRI', licence_status: 'unknown', lifecycle_status: 'active', catalogue_status: 'verified', ...o });

function tables(opts: { start?: string; over?: Record<string, unknown[]>; benchOver?: Record<string, unknown> } = {}) {
  const start = opts.start ?? '2020-01-01';
  return {
    ii_portfolio_truth_status: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'd1', history_completeness: 'complete_from_inception' }],
    ii_transactions: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', transaction_type: 'purchase', transaction_date: start, gross_amount: 10000, units: 500, currency_code: 'INR', status: 'parsed' }],
    ii_holding_snapshots: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', as_of_date: '2021-01-01', units: 500, value: 15000, currency_code: 'INR', quality_status: 'certified', source_document_id: 'd1' }],
    ii_instruments: [{ id: 'i1', instrument_name: 'Test Large Cap Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF000000001' }],
    ii_accounts: [{ id: 'a1', user_id: USER, folio_number: 'F1', institution_name: 'AMC', currency_code: 'INR' }],
    ii_source_documents: [{ id: 'd1', source_detected: 'cams' }],
    ii_instrument_benchmarks: [{ instrument_id: 'i1', benchmark_id: BM, relationship_type: 'primary', effective_from: '2019-01-01', effective_to: null, quality_status: 'ok', mapping_version: 'bench1-v1', ii_benchmarks: bench(opts.benchOver) }],
    ii_benchmarks: [{ id: BM, benchmark_key: 'IN_NIFTY_100_TRI', return_type: 'TRI' }],
    ii_benchmark_series: [
      { benchmark_id: BM, series_date: '2020-01-01', value: 100, quality_status: 'ok' },
      { benchmark_id: BM, series_date: '2020-07-01', value: 105, quality_status: 'ok' },
      { benchmark_id: BM, series_date: '2021-01-01', value: 110, quality_status: 'ok' },
    ],
    ii_risk_free_rates: [],
    ii_prices_nav: [],
    __benchmark_access: [access()],
    ...(opts.over ?? {}),
  };
}

const holding = async (t: Record<string, unknown[]>) => {
  const { client } = makeFakeSupabase(t as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await loadHoldingsTable(client as any, USER)).holdings[0];
};

describe('Holdings table: benchmarkComparison', () => {
  it('entitled + verified + mapped + covered => a real, money-weighted, labelled comparison', async () => {
    const h = await holding(tables());
    const c = h.benchmarkComparison;
    expect(c.status).toBe('ok');
    if (c.status !== 'ok') return;
    expect(c.basis).toBe('annualised_xirr'); // 1 year exactly
    expect(c.periodLabel).toBe('Since 01-01-2020, 1 year'); // day-first, in words
    expect(c.benchmarkKey).toBe('IN_NIFTY_100_TRI');
    expect(c.benchmarkEndingValue).toBeCloseTo(11000, 6); // 10,000 bought at 100, worth 110/100 of that
    expect(c.benchmarkReturn).toBeCloseTo(0.0997, 2); // 10% over 366 days, annualised
    expect(c.holdingReturn).toBeGreaterThan(c.benchmarkReturn); // 15,000 vs 11,000
  });

  it('a holding that started later gets a DIFFERENT window and, being under a year, is not annualised', async () => {
    const early = await holding(tables({ start: '2020-01-01' }));
    const late = await holding(tables({ start: '2020-07-01' }));
    if (early.benchmarkComparison.status !== 'ok' || late.benchmarkComparison.status !== 'ok') throw new Error('expected both ok');
    expect(early.benchmarkComparison.windowStart).toBe('2020-01-01');
    expect(late.benchmarkComparison.windowStart).toBe('2020-07-01');
    expect(late.benchmarkComparison.basis).toBe('absolute_not_annualised');
    expect(late.benchmarkComparison.periodLabel).toBe('Since 01-07-2020, 6 months');
    expect(late.benchmarkComparison.benchmarkReturn).toBeCloseTo(110 / 105 - 1, 9);
    expect(late.benchmarkComparison.benchmarkReturn).not.toBeCloseTo(early.benchmarkComparison.benchmarkReturn, 3);
  });

  it('NEGATIVE: no entitlement => "benchmark data not available", no number (the only difference to the first test)', async () => {
    const c = (await holding(tables({ over: { __benchmark_access: [] } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'NOT_ENTITLED', title: 'Benchmark data not available' });
    expect(JSON.stringify(c)).not.toMatch(/holdingReturn|benchmarkReturn|benchmarkEndingValue/);
  });

  it('NEGATIVE: calculation allowed but customer display not allowed => no number', async () => {
    const c = (await holding(tables({ over: { __benchmark_access: [access({ can_display: false })] } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'NOT_ENTITLED' });
  });

  it('NEGATIVE: an UNVERIFIED catalogue entry => no number', async () => {
    const c = (await holding(tables({ benchOver: { catalogue_status: 'draft' } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'CATALOGUE_NOT_VERIFIED' });
  });

  it('NEGATIVE: a catalogue entry whose status is unknown (older schema, no column) fails closed', async () => {
    const c = (await holding(tables({ benchOver: { catalogue_status: undefined } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'CATALOGUE_NOT_VERIFIED' });
  });

  it('NEGATIVE: a price-return benchmark is never used for the comparison', async () => {
    const c = (await holding(tables({ benchOver: { return_type: 'PRI' } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'PRICE_INDEX_NOT_TOTAL_RETURN' });
  });

  // A fund whose category cannot be recognised has no category benchmark either (see categoryReference.test.ts
  // for the category reference that applies to recognisable funds), so "no mapping" stays a clean no-number state.
  const unrecognisable = (t: Record<string, unknown[]>) => {
    (t.ii_instruments[0] as Record<string, unknown>).instrument_name = 'Test Holding';
    return t;
  };

  it('NEGATIVE: no mapping at all and no recognisable category => unavailable, no number', async () => {
    const c = (await holding(unrecognisable(tables({ over: { ii_instrument_benchmarks: [] } })))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'NO_MAPPING' });
    expect((c as { detail: string }).detail).toMatch(/Benchmark not available for this fund category/);
  });

  it('NEGATIVE: a superseded mapping row is ignored like the analytics loader ignores it (and, for an unrecognisable fund, nothing replaces it)', async () => {
    const t = unrecognisable(tables());
    (t.ii_instrument_benchmarks[0] as Record<string, unknown>).quality_status = 'superseded';
    expect((await holding(t)).benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'NO_MAPPING' });
  });

  it('NEGATIVE: benchmark history that starts after the investment date => says so, no number', async () => {
    const c = (await holding(tables({ over: { ii_benchmark_series: [{ benchmark_id: BM, series_date: '2020-09-01', value: 106, quality_status: 'ok' }, { benchmark_id: BM, series_date: '2021-01-01', value: 110, quality_status: 'ok' }] } }))).benchmarkComparison;
    expect(c).toMatchObject({ status: 'unavailable', reason: 'HISTORY_STARTS_AFTER_INVESTMENT' });
    expect((c as { detail: string }).detail).toMatch(/does not go back to your investment date/);
  });

  it('the legacy lump-sum field is still produced for existing consumers and is separate from the new comparison', async () => {
    const h = await holding(tables());
    expect(h.benchmark.status).toBe('CALCULATED');
    expect(h.benchmarkComparison.status).toBe('ok');
  });
});

describe('Performance (analytics orchestrator): the scheme comparison follows the holding, not the fund', () => {
  const run = async (t: Record<string, unknown[]>) => {
    const { client } = makeFakeSupabase(t as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { dataset } = await loadAnalyticsDataset(client as any, USER, {});
    if (!dataset) throw new Error('no dataset');
    return runAnalytics(dataset).schemes[0];
  };

  it('a holding of a year or more gets an XIRR-based active return with the benchmark key', async () => {
    const s = await run(tables());
    expect(s.benchmarkComparison?.status).toBe('ok');
    expect(s.activeReturn.status).toBe('CALCULATED');
    expect(s.activeReturn.value).toMatchObject({ family: 'XIRR', benchmarkKey: 'IN_NIFTY_100_TRI' });
  });

  it('a holding under a year has NO annualised active return (not annualised), but still has the absolute comparison', async () => {
    const s = await run(tables({ start: '2020-07-01' }));
    expect(s.benchmarkComparison).toMatchObject({ status: 'ok', basis: 'absolute_not_annualised' });
    expect(s.activeReturn.status).toBe('INSUFFICIENT_HISTORY');
    expect(s.activeReturn.value).toBeUndefined();
    expect(s.activeReturn.detail).toMatch(/less than a year/);
  });

  it('NEGATIVE: un-entitled => both are unavailable with no number', async () => {
    const s = await run(tables({ over: { __benchmark_access: [] } }));
    expect(s.benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'NOT_ENTITLED' });
    expect(s.activeReturn.status).toBe('MISSING_REFERENCE_DATA');
    expect(s.activeReturn.value).toBeUndefined();
  });

  it('NEGATIVE: unverified catalogue entry => unavailable', async () => {
    const s = await run(tables({ benchOver: { catalogue_status: 'draft' } }));
    expect(s.benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'CATALOGUE_NOT_VERIFIED' });
    expect(s.activeReturn.value).toBeUndefined();
  });
});
