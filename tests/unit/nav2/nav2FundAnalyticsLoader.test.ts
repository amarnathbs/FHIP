// NAV2 Stage 2 -- the Fund analytics loader's COMPOSITION (the certified loaders are mocked at their module boundary;
// everything this loader adds on top runs for real against an in-memory database).
//
// Matrix rows: 34 (entity-held funds are excluded from the personal report and the exclusion is disclosed), 36 (non-fund
// holdings are not analysed and are counted), 37 (manual path untouched: the loader only reads), 50 (raw NAV lineage
// reaches the series; hydrating is respected). Row 35 (a joint holding appears once) is inherited from the certified
// loader (iiMultiFolioAggregation / iiOwnerClassBreakup); it is not re-proved here.
//
// NAMED NEGATIVE CONTROLS
//   NC-D1  a trust-held fund that is NOT also held personally is counted as excluded; a fund held both ways is NOT;
//   NC-D2  a non-fund instrument is excluded and counted, never given fund metrics;
//   NC-D3  the loader writes nothing (no insert / update / delete reaches any table);
//   NC-D4  a fund whose gate state is "waiting" yields history_hydrating, not insufficient_history;
//   NC-D5  a category reference is offered only when there is no declared mapping (declared always wins).
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { createInMemoryDb, type Row } from '../support/inMemorySupabase';
import { weekdays } from './support/fixtures';

const A = '11111111-1111-4111-8111-111111111111'; // personal fund
const T = '22222222-2222-4222-8222-222222222222'; // trust-only fund
const E = '33333333-3333-4333-8333-333333333333'; // ETF (not a mutual fund)
const H = '44444444-4444-4444-8444-444444444444'; // fund still hydrating
const USER = 'user-1';
const AS_OF = '2026-10-02';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function schemeDs(id: string, name: string): SchemeDataset {
  return {
    instrumentId: id,
    instrumentName: name,
    currencyCode: 'INR',
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception',
    optionType: null,
    hasDistributionAdjustment: false,
    cashFlows: [
      { date: d('2025-03-03'), amount: -10000 },
      { date: d('2025-06-02'), amount: -5000 },
      { date: d(AS_OF), amount: 17000 },
    ],
    externalCashFlows: [],
    currentValue: 17000,
    currentValueDate: d(AS_OF),
    navSeries: [],
    valuationSeries: [{ date: d('2025-03-03'), value: 10000 }],
    valuation: { basis: 'market_nav', folioCount: 1, valuedFolioCount: 1, liveFolioCount: 1, units: 170, marketValue: 17000, valuationDate: AS_OF, currencyCode: 'INR', stale: false, unitsAfterStatement: 0, excludedNavCounts: { future_dated: 0, quality_not_ok: 0, currency_mismatch: 0, invalid_price: 0 }, folios: [] },
  } as unknown as SchemeDataset;
}

const dataset = {
  userId: USER,
  asOfDate: d(AS_OF),
  periodStart: d('2025-03-03'),
  schemes: [schemeDs(A, 'Alpha Flexi Cap Fund - Direct - Growth'), schemeDs(E, 'Some ETF'), schemeDs(H, 'Hydrating Fund - Direct - Growth')],
  mappings: [{ instrumentId: A, benchmarkId: 'bm-1', benchmarkKey: 'NIFTY500_TRI', returnType: 'TRI', effectiveFrom: d('2020-01-01'), effectiveTo: null }],
  benchmarkSeriesById: { 'bm-1': [{ date: d('2026-09-30'), value: 100 }] },
  riskFreeSeries: [],
  navDataVersion: null,
  benchmarkDataVersion: 'bench-v1',
  benchmarkMappingVersion: null,
  benchmarkMeta: { 'bm-1': { label: 'Nifty 500 TRI', catalogueVerified: true, entitled: true } },
  categoryReferenceMappings: [
    { instrumentId: A, benchmarkId: 'bm-cat', benchmarkKey: 'CAT', returnType: 'TRI', effectiveFrom: d('1990-01-01'), effectiveTo: null, basis: 'category_reference', categoryLabel: 'Flexi Cap' },
    { instrumentId: H, benchmarkId: 'bm-cat', benchmarkKey: 'CAT', returnType: 'TRI', effectiveFrom: d('1990-01-01'), effectiveTo: null, basis: 'category_reference', categoryLabel: 'Flexi Cap' },
  ],
  frequency: 'monthly',
};

vi.mock('@/lib/services/investment-intelligence/analyticsRepository', () => ({
  loadAnalyticsDataset: vi.fn(async () => ({ dataset, warnings: [{ scope: 'x', detail: 'a warning from the certified loader' }], empty: false })),
}));

const scoped = createInMemoryDb();
vi.mock('@/lib/services/investment-intelligence/ownerClassReportScope', () => ({
  loadOwnerClassScopeForReport: vi.fn(async () => ({ client: scoped.client, breakup: null })),
}));

import { benchmarkSegmentsFor, firstHeldDateFor, investorInputFor, loadFundAnalyticsInput } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsLoader';

function world() {
  const session = createInMemoryDb();
  // The session sees the whole household (including the trust fund); the scoped client sees the personal subset only.
  session.reset({
    ii_portfolio_truth_status: [
      { id: 't1', user_id: USER, instrument_id: A },
      { id: 't2', user_id: USER, instrument_id: T },
      { id: 't3', user_id: USER, instrument_id: E },
      { id: 't4', user_id: USER, instrument_id: H },
    ],
    ii_reconciliation_cases: [
      { id: 'r1', user_id: USER, status: 'open' },
      { id: 'r2', user_id: USER, status: 'resolved' },
      { id: 'r3', user_id: 'other', status: 'open' },
    ],
  });
  scoped.reset({
    ii_portfolio_truth_status: [
      { id: 't1', user_id: USER, instrument_id: A },
      { id: 't3', user_id: USER, instrument_id: E },
      { id: 't4', user_id: USER, instrument_id: H },
    ],
  });
  const admin = createInMemoryDb();
  const dates = weekdays('2025-01-01', 40);
  const navRows: Row[] = dates.map((priceDate, i) => ({ id: `n-${i}`, instrument_id: A, price_date: priceDate, price: 100 + i, currency_code: 'INR', quality_status: 'ok', superseded_by_id: null, correction_of_id: null, record_checksum: `ck-${i}`, provider: 'amfi', data_version: 'v1' }));
  admin.reset({
    ii_instruments: [
      { id: A, instrument_name: 'Alpha Flexi Cap Fund - Direct - Growth', instrument_class: 'mutual_fund', base_currency: 'INR', plan_type: 'direct', option_type: 'growth' },
      { id: E, instrument_name: 'Some ETF', instrument_class: 'etf', base_currency: 'INR', plan_type: null, option_type: null },
      { id: H, instrument_name: 'Hydrating Fund - Direct - Growth', instrument_class: 'mutual_fund', base_currency: 'INR', plan_type: 'direct', option_type: 'growth' },
    ],
    ii_scheme_master: [{ instrument_id: A, sub_category: 'Flexi Cap Fund', category_header_raw: null, effective_to: null }],
    ii_prices_nav: navRows,
    ii_nav_source_coverage_gaps: [{ instrument_id: A, gap_from: '2025-01-10', gap_to: '2025-01-20', reason_code: 'fund_house_transition', resolved_at: null }, { instrument_id: A, gap_from: '2024-01-10', gap_to: '2024-01-20', reason_code: 'other', resolved_at: '2025-01-01' }],
    ii_risk_free_series: [],
    ii_risk_free_observations: [],
  });
  return { session, admin };
}

const gate = { waiting: [{ instrumentId: H, schemeName: 'Hydrating Fund - Direct - Growth', state: 'waiting', reason: null }], unavailable: [{ instrumentId: 'x', schemeName: 'Gamma Fund', state: 'unavailable', reason: 'no_source' }] } as never;

async function run() {
  const { session, admin } = world();
  const res = await loadFundAnalyticsInput({ userId: USER, sessionClient: session.client as never, adminClient: admin.client as unknown as SupabaseClient, asOfDate: AS_OF, displayCurrency: 'INR', periodChoice: 'since_first_held', gate });
  return { res, session, admin };
}

describe('loader composition', () => {
  it('NC-D1 / matrix 34: counts a trust-only fund as excluded; the personally held funds are not', async () => {
    const { res } = await run();
    expect(res.input?.scope.entityHeldSchemesExcluded).toBe(1);
  });

  it('NC-D2 / matrix 36: the ETF is excluded and counted; only mutual funds are analysed', async () => {
    const { res } = await run();
    expect(res.input?.scope.otherInstrumentsExcluded).toBe(1);
    expect(res.input?.schemes.map((s) => s.instrumentId).sort()).toEqual([A, H].sort());
  });

  it('counts only the caller\'s own open review items; names funds whose history could not be loaded', async () => {
    const { res } = await run();
    expect(res.input?.scope.statementLinesAwaitingReview).toBe(1);
    expect(res.input?.scope.priceHistoryUnavailable).toEqual([{ schemeName: 'Gamma Fund', reason: 'no published prices found' }]);
    expect(res.warnings).toContain('a warning from the certified loader');
  });

  it('matrix 50: raw NAV lineage reaches the series (checksum), and an unresolved coverage gap is attached (a resolved one is not)', async () => {
    const { res } = await run();
    const a = res.input!.schemes.find((s) => s.instrumentId === A)!;
    expect(a.series.count).toBe(40);
    expect(a.series.checksum).toMatch(/[0-9a-f]{8}/);
    expect(a.planType).toBe('direct');
    expect(a.optionType).toBe('growth');
    expect(a.categoryLabel).toBeTruthy();
    expect(a.firstHeldDate).toBe('2025-03-03');
  });

  it('NC-D4: a fund still being fetched is history_hydrating, never insufficient_history', async () => {
    const { res } = await run();
    const h = res.input!.schemes.find((s) => s.instrumentId === H)!;
    expect(h.series.count).toBe(0);
    expect(h.series.hydrating).toBe(true);
  });

  it('NC-D3 / matrix 37: nothing is written to any table', async () => {
    const { session, admin } = await run();
    expect(session.writes).toEqual([]);
    expect(admin.writes).toEqual([]);
    expect(scoped.writes).toEqual([]);
  });

  it('the report period drives the spec; the risk-free slot is empty with a plain reason when the registry is empty', async () => {
    const { res } = await run();
    expect(res.input?.periodChoice).toBe('since_first_held');
    expect(res.input?.spec.pointToPoint.map((p) => p.id)).toEqual(['1Y', '3Y', '5Y']);
    expect(res.input?.riskFree).toBeNull();
    expect(res.riskFreeUnavailableReason).toMatch(/No risk-free rate series/);
  });
});

describe('pure helpers', () => {
  it('NC-D5: a declared mapping wins; a category reference is used only without one', () => {
    const forA = benchmarkSegmentsFor(A, dataset as never);
    expect(forA.map((s) => s.benchmarkId)).toEqual(['bm-1']);
    expect(forA[0]).toMatchObject({ basis: 'declared', label: 'Nifty 500 TRI', entitled: true, catalogueVerified: true, datasetVersion: 'bench-v1' });
    const forH = benchmarkSegmentsFor(H, dataset as never);
    expect(forH.map((s) => s.basis)).toEqual(['category_reference']);
    expect(benchmarkSegmentsFor('nobody', dataset as never)).toEqual([]);
  });

  it('investor input drops the synthetic terminal flow (the valuation supplies it) and keeps the real flows', () => {
    const inp = investorInputFor(schemeDs(A, 'x'), AS_OF)!;
    expect(inp.flows).toHaveLength(2);
    expect(inp.flows.every((f) => f.amount < 0)).toBe(true);
    expect(inp.valuation.marketValue).toBe(17000);
    expect(investorInputFor({ ...schemeDs(A, 'x'), valuation: undefined } as never, AS_OF)).toBeNull();
  });

  it('first held date is the first real cash flow, else the earliest dated valuation', () => {
    expect(firstHeldDateFor(schemeDs(A, 'x'))).toBe('2025-03-03');
    const holdingsOnly = { ...schemeDs(A, 'x'), cashFlows: [], valuationSeries: [{ date: d('2025-08-01'), value: 5 }, { date: d('2025-07-01'), value: 4 }] } as unknown as SchemeDataset;
    expect(firstHeldDateFor(holdingsOnly)).toBe('2025-07-01');
  });
});
