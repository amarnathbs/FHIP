/**
 * Document2 (4) F2 (Product Owner live review, 20-10-2026), Investment Intelligence > Performance:
 *   "risk free return is not there message is coming and data currency also some comment not sure why".
 *
 * ROOT CAUSE. The Performance consumer read only the old table ii_risk_free_rates (empty in production), while the governed RBI
 * 91-day T-bill series (ii_risk_free_series / ii_risk_free_observations, loaded through 14-10-2026) was read only by the Fund
 * analytics report. The notice also printed the internal key (`risk_free`, `data_currency`) to the customer.
 *
 * ORACLE: the expected rate is the published yield in the fixture divided by 100; no engine arithmetic is reused.
 * NEGATIVE CONTROL: the previous consumer (the old table only) is reproduced on the SAME database and MUST give "no rate".
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { governedRiskFreeFor } from '@/lib/services/investment-intelligence/performanceRiskFree';
import { lookupRiskFreeRate } from '@/lib/config/investment-intelligence/riskFreeRate';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { presentWarningScope } from '@/lib/engines/investment-intelligence/warningLabels';
import type { RiskFreeDataset } from '@/lib/engines/nav2/riskFree';

type Row = Record<string, unknown>;
function builder(rows: Row[]) {
  let f = rows;
  const order: Array<{ c: string; asc: boolean }> = [];
  const sorted = () => {
    const o = [...f];
    for (let i = order.length - 1; i >= 0; i--) o.sort((a, b) => ((a[order[i].c] as string) < (b[order[i].c] as string) ? (order[i].asc ? -1 : 1) : (a[order[i].c] as string) > (b[order[i].c] as string) ? (order[i].asc ? 1 : -1) : 0));
    return o;
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => ((f = f.filter((r) => r[c] === v)), b),
    in: (c: string, vs: unknown[]) => ((f = f.filter((r) => new Set(vs).has(r[c]))), b),
    is: (c: string, v: unknown) => ((f = f.filter((r) => (r[c] ?? null) === v)), b),
    order: (c: string, o?: { ascending?: boolean }) => (order.push({ c, asc: o?.ascending !== false }), b),
    range: (a: number, z: number) => Promise.resolve({ data: sorted().slice(a, z + 1), error: null }),
    then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: sorted().slice(0, 1000), error: null }).then(res, rej),
  };
  return b;
}
const client = (t: Record<string, Row[]>) => ({ from: (n: string) => builder(t[n] ?? []) }) as unknown as SupabaseClient;

const userId = 'u-rf';
const A = 'inst-rf';
const base: Record<string, Row[]> = {
  ii_instruments: [{ id: A, instrument_name: 'Fund A', base_currency: 'INR', country_of_domicile: 'IN' }],
  ii_transactions: [{ id: 't1', user_id: userId, instrument_id: A, account_id: 'acc', transaction_type: 'purchase', transaction_date: '2024-01-10', gross_amount: 10000, units: 100, currency_code: 'INR', status: 'confirmed' }],
  ii_holding_snapshots: [{ id: 's1', user_id: userId, instrument_id: A, account_id: 'acc', as_of_date: '2026-09-04', units: 100, value: 20000, currency_code: 'INR', quality_status: 'certified' }],
  ii_prices_nav: [{ id: 'n1', instrument_id: A, price_date: '2026-10-16', price: 210, data_version: 'v1', quality_status: 'ok', currency_code: 'INR' }],
};
const SERIES = { series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', series_name: 'RBI 91-day Treasury bill auction cut-off yield', source: 'Reserve Bank of India', attribution_text: 'Source: Reserve Bank of India', cadence: 'weekly_auction', max_staleness_days: 21, enabled: true, terms_review_status: 'po_accepted_2026-10-03', verified_through_date: '2026-10-14' };
const obs = (date: string, y: number): Row => ({ series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', observation_date: date, kind: 'value', value_percent: y, gap_reason: null, source_document: 'RBI press release', source_url: null, retrieved_on: '2026-10-15', notes: null, entry_kind: 'first_load_csv', extraction: null });
const governed = { ii_risk_free_series: [SERIES], ii_risk_free_observations: [obs('2026-09-30', 5.4), obs('2026-10-07', 5.45), obs('2026-10-14', 5.5)] };

describe('F2: the Performance tab uses the governed RBI series', () => {
  it('finds the published rate in force on the as-at date (16-10-2026 -> the 14-10-2026 auction, 5.5%) and raises no risk_free notice', async () => {
    const { dataset, warnings } = await loadAnalyticsDataset(client({ ...base, ...governed }), userId, { asOfDate: new Date('2026-10-20T00:00:00.000Z') });
    expect(dataset!.asOfDate.toISOString().slice(0, 10)).toBe('2026-10-16');
    expect(warnings.filter((w) => w.scope === 'risk_free')).toEqual([]);
    const hit = lookupRiskFreeRate(dataset!.riskFreeSeries, 'IN', dataset!.asOfDate);
    expect(hit.status).toBe('ok');
    expect(hit.rate).toBeCloseTo(5.5 / 100, 12);
    expect(hit.point!.source).toMatch(/RBI 91-day T-bill/);
    expect(hit.point!.source).toMatch(/14-10-2026/); // day-first, never ISO
    const rs = runAnalytics(dataset!);
    expect(rs.portfolios[0].risk.riskFree.status).toBe('ok');
    expect(rs.portfolios[0].risk.riskFree.rate).toBeCloseTo(0.055, 12);
  });

  it('NEGATIVE CONTROL: the previous consumer (old table only) finds no rate on the very same data', async () => {
    const t = { ...base, ...governed, ii_risk_free_series: [], ii_risk_free_observations: [] }; // what the old code could see
    const { dataset } = await loadAnalyticsDataset(client(t), userId, { asOfDate: new Date('2026-10-20T00:00:00.000Z') });
    expect(lookupRiskFreeRate(dataset!.riskFreeSeries, 'IN', dataset!.asOfDate).status).toBe('unavailable');
  });

  it('with no series set up the notice names the reason in plain words and never says "loaded yet" or prints a key', async () => {
    const { warnings } = await loadAnalyticsDataset(client(base), userId, { asOfDate: new Date('2026-10-20T00:00:00.000Z') });
    const w = warnings.find((x) => x.scope === 'risk_free')!;
    expect(w.detail).toMatch(/No risk-free rate series is set up/);
    expect(w.detail).toMatch(/No rate has been assumed/);
    expect(presentWarningScope(w.scope).label).toBe('Risk-free rate');
  });

  it('the old uncertified seed table is only a fallback: it never overrides a governed rate for India', async () => {
    const seed: Row = { country_code: 'IN', period_start: '2026-01-01', period_end: '2026-12-31', annualised_rate: 0.099, source: 'DEV SEED', method: 'period_average', version: 'seed' };
    const { dataset } = await loadAnalyticsDataset(client({ ...base, ...governed, ii_risk_free_rates: [seed] }), userId, { asOfDate: new Date('2026-10-20T00:00:00.000Z') });
    expect(lookupRiskFreeRate(dataset!.riskFreeSeries, 'IN', dataset!.asOfDate).rate).toBeCloseTo(0.055, 12);
  });
});

describe('governedRiskFreeFor: named reasons, never a silent assumption', () => {
  const ds = (over: Partial<RiskFreeDataset> = {}): RiskFreeDataset => ({
    seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', seriesName: 'RBI 91-day T-bill', source: 'Reserve Bank of India', attributionText: 'Source: Reserve Bank of India', cadence: 'weekly_auction', datasetVersion: 'v', retrievedOn: '2026-10-15',
    termsReviewStatus: 'po_accepted_2026-10-03', enabled: true, yieldBasis: 'annualised_percent_as_published', conversion: 'compound_per_period_1_over_n', observationSemantics: 'latest_on_or_before_never_future_never_interpolated', maxStalenessDays: 21, verifiedThroughDate: '2026-10-14',
    observations: [{ observationDate: '2026-10-07', yieldPercent: 5.45, kind: 'value', sourceDocument: 'x', sourceUrl: null, retrievedOn: '2026-10-15' }, { observationDate: '2026-10-14', yieldPercent: 5.5, kind: 'value', sourceDocument: 'x', sourceUrl: null, retrievedOn: '2026-10-15' }],
    ...over,
  });
  it('a date after the data by more than the staleness window says the rates end on 14-10-2026 and that nothing was carried forward', () => {
    const r = governedRiskFreeFor(ds(), null, '2026-12-01');
    expect(r.points).toEqual([]);
    expect(r.unavailableReason).toMatch(/dated 14-10-2026, more than 21 days before 01-12-2026/);
    expect(r.unavailableReason).toMatch(/No rate has been carried forward or estimated/);
  });
  it('a date before the first rate says when the rates start', () => {
    const r = governedRiskFreeFor(ds(), null, '2026-01-01');
    expect(r.unavailableReason).toMatch(/start on 07-10-2026, after 01-01-2026/);
  });
  it('a switched-off series says so', () => {
    expect(governedRiskFreeFor(ds({ enabled: false }), null, '2026-10-16').unavailableReason).toMatch(/switched off/);
  });
  it('no dataset at all reuses the loader reason', () => {
    expect(governedRiskFreeFor(null, 'The risk-free rate data could not be read.', '2026-10-16').unavailableReason).toMatch(/could not be read/);
  });
});

describe('notice headings: no internal key ever reaches the customer', () => {
  it('known scopes get a plain heading; data_currency and valuation carry a working link; an unknown scope is made readable', () => {
    for (const s of ['risk_free', 'data_currency', 'as_of_date', 'valuation', 'nav', 'benchmark', 'benchmark_mapping', 'fund_holdings', 'persistence', 'some_new_scope']) {
      const p = presentWarningScope(s);
      expect(p.label, s).not.toMatch(/_/);
      expect(p.label[0]).toBe(p.label[0].toUpperCase());
    }
    expect(presentWarningScope('data_currency').action?.href).toBe('/investment-intelligence/data');
    expect(presentWarningScope('valuation').action?.href).toBe('/investment-intelligence/data');
    expect(presentWarningScope('some_new_scope').label).toBe('Some new scope');
  });
});
