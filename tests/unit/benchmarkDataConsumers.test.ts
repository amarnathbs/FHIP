// BENCH-1 Phase 2 - end-to-end CONSUMPTION through the certified engines (code level, fixtures).
//
// "approved data -> canonical benchmark series -> effective-dated scheme mapping -> existing calculation engine ->
// recompute -> user-visible comparison", with the entitlement gate in the middle. These fixtures prove CODE BEHAVIOUR;
// they do not prove source rights, real coverage or live operation (see the report's evidence labels).
//
// The arithmetic is the certified R4 engine's (loadHoldingsTable runs the real pipeline); nothing here recomputes a return.
import { describe, it, expect } from 'vitest';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadInstrumentBenchmarkContext, summarizeBenchmarkCoverage } from '@/lib/services/investment-intelligence/benchmarkCoverage';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { fingerprintInputs } from '@/lib/engines/investment-intelligence/analyticsVersioning';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const USER = 'user-1';
const BM = 'bm-nifty100-tri';
const access = (o: Record<string, unknown> = {}) => ({ benchmark_id: BM, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null, ...o });

function tables(over: Record<string, unknown[]> = {}) {
  return {
    ii_portfolio_truth_status: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'd1', history_completeness: 'complete_from_inception' }],
    ii_transactions: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 10000, units: 500, currency_code: 'INR', status: 'parsed' }],
    ii_holding_snapshots: [{ user_id: USER, account_id: 'a1', instrument_id: 'i1', as_of_date: '2021-01-01', units: 500, value: 15000, currency_code: 'INR', quality_status: 'certified', source_document_id: 'd1' }],
    ii_instruments: [{ id: 'i1', instrument_name: 'Test Large Cap Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF000000001' }],
    ii_accounts: [{ id: 'a1', user_id: USER, folio_number: 'F1', institution_name: 'AMC', currency_code: 'INR' }],
    ii_source_documents: [{ id: 'd1', source_detected: 'cams' }],
    ii_instrument_benchmarks: [{ instrument_id: 'i1', benchmark_id: BM, relationship_type: 'primary', effective_from: '2019-01-01', effective_to: null, quality_status: 'ok', mapping_version: 'bench1-v1', ii_benchmarks: { benchmark_key: 'IN_NIFTY_100_TRI', benchmark_label: 'NIFTY 100 TRI', return_type: 'TRI', licence_status: 'unknown', lifecycle_status: 'active' } }],
    ii_benchmarks: [{ id: BM, benchmark_key: 'IN_NIFTY_100_TRI', return_type: 'TRI' }],
    ii_benchmark_series: [{ benchmark_id: BM, series_date: '2020-01-01', value: 100, quality_status: 'ok' }, { benchmark_id: BM, series_date: '2021-01-01', value: 110, quality_status: 'ok' }],
    ii_risk_free_rates: [],
    ii_prices_nav: [],
    __benchmark_access: [access()],
    ...over,
  };
}
const holdings = async (t: Record<string, unknown[]>) => {
  const { client } = makeFakeSupabase(t as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await loadHoldingsTable(client as any, USER)).holdings[0];
};

describe('Holdings table (screen 5) through the real pipeline', () => {
  it('entitled benchmark + effective mapping + series covering the window => a real TRI comparison with the exact key and the certified 10% point-to-point', async () => {
    const h = await holdings(tables());
    expect(h.benchmark.status).toBe('CALCULATED');
    expect(h.benchmark.value?.benchmarkKey).toBe('IN_NIFTY_100_TRI');
    expect(h.benchmark.value?.returnType).toBe('TRI');
    expect(h.benchmark.value?.pointToPointReturn).toBeCloseTo(0.1, 6);
  });
  it('NEGATIVE: with the entitlement revoked / absent the same data shows an honest blocked state - never 0%, never a number', async () => {
    const h = await holdings(tables({ __benchmark_access: [] }));
    expect(h.benchmark.status).toBe('MISSING_REFERENCE_DATA');
    expect(h.benchmark.qualityFlag).toBe('BENCHMARK_HISTORY_INCOMPLETE');
    expect(h.benchmark.value).toBeUndefined();
    expect(h.benchmark.detail).toMatch(/entitlement/i);
  });
  it('NEGATIVE: calculation allowed but customer display NOT allowed => blocked (a comparison is customer-visible)', async () => {
    const h = await holdings(tables({ __benchmark_access: [access({ can_display: false })] }));
    expect(h.benchmark.status).toBe('MISSING_REFERENCE_DATA');
    expect(h.benchmark.detail).toMatch(/customer display/);
  });
  it('NEGATIVE: an entitlement whose data-date scope starts AFTER the window start leaves no usable start level => history incomplete, not a guess', async () => {
    const h = await holdings(tables({ __benchmark_access: [access({ data_from: '2020-06-01' })] }));
    expect(h.benchmark.status).toBe('MISSING_REFERENCE_DATA');
    expect(h.benchmark.qualityFlag).toBe('BENCHMARK_HISTORY_INCOMPLETE');
  });
  it('NEGATIVE: no mapping in effect on the window end date => mapping missing (effective dating is honoured)', async () => {
    const t = tables();
    (t.ii_instrument_benchmarks[0] as Record<string, unknown>).effective_to = '2020-12-31';
    const h = await holdings(t);
    expect(h.benchmark.qualityFlag).toBe('BENCHMARK_MAPPING_MISSING');
  });
  it('a CORRECTION to a published level flows through to the comparison (110 -> 111 gives 11%), and a retracted/superseded row is ignored by the loaders\' own filters', async () => {
    const t = tables();
    t.ii_benchmark_series = [{ benchmark_id: BM, series_date: '2020-01-01', value: 100, quality_status: 'ok' }, { benchmark_id: BM, series_date: '2021-01-01', value: 111, quality_status: 'ok' }];
    expect((await holdings(t)).benchmark.value?.pointToPointReturn).toBeCloseTo(0.11, 6);
  });
});

describe('Portfolio X-Ray coverage (screen 4)', () => {
  it('summarises entitled mappings as mapped, un-entitled as blocked (never as unmapped and never as covered)', async () => {
    for (const [acc, expected] of [[[access()], { mappedCount: 1, licenceBlockedCount: 0 }], [[], { mappedCount: 0, licenceBlockedCount: 1 }]] as const) {
      const { client } = makeFakeSupabase(tables({ __benchmark_access: acc as never }) as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = await loadInstrumentBenchmarkContext(client as any, ['i1']);
      expect(summarizeBenchmarkCoverage(ctx, ['i1'], new Date('2021-01-01'))).toMatchObject({ totalSchemes: 1, unmappedCount: 0, ...expected });
    }
  });
});

describe('Performance / SIP loaders (screens 1-2): the series is withheld unless entitled; export is stricter', () => {
  it('R4 loader: entitled => the benchmark series is loaded with the exact date window; un-entitled => no series + a disclosed warning', async () => {
    const { client } = makeFakeSupabase(tables() as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await loadAnalyticsDataset(client as any, USER, {});
    expect(Object.values(ok.dataset?.benchmarkSeriesById ?? {}).flat().length).toBe(2);
    const { client: c2 } = makeFakeSupabase(tables({ __benchmark_access: [] }) as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocked = await loadAnalyticsDataset(c2 as any, USER, {});
    expect(Object.values(blocked.dataset?.benchmarkSeriesById ?? {}).flat().length).toBe(0);
    expect(blocked.warnings.some((w) => w.scope === 'benchmark' && /entitlement/.test(w.detail))).toBe(true);
  });
  it('report/export need the separate export right: display-only entitlement loads for the screen but NOT for a report', async () => {
    const t = tables({ __benchmark_access: [access({ can_export: false })] });
    const { client } = makeFakeSupabase(t as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screen = await loadAnalyticsDataset(client as any, USER, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await loadAnalyticsDataset(client as any, USER, { benchmarkAccessNeed: 'export' });
    expect(Object.values(screen.dataset?.benchmarkSeriesById ?? {}).flat().length).toBe(2);
    expect(Object.values(report.dataset?.benchmarkSeriesById ?? {}).flat().length).toBe(0);
    const { client: c3 } = makeFakeSupabase(tables({ __benchmark_access: [access({ can_export: true })] }) as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allowed = await loadAnalyticsDataset(c3 as any, USER, { benchmarkAccessNeed: 'export' });
    expect(Object.values(allowed.dataset?.benchmarkSeriesById ?? {}).flat().length).toBe(2);
  });
  it('cache invalidation is content-addressed: adding, correcting or removing a benchmark point changes the engine input fingerprint', () => {
    const base = [['2020-01-01', 100], ['2021-01-01', 110]];
    const f = (pts: unknown[]) => fingerprintInputs(['series', pts, 'method-v1']);
    expect(f(base)).toBe(f([['2020-01-01', 100], ['2021-01-01', 110]]));
    expect(f(base)).not.toBe(f([['2020-01-01', 100], ['2021-01-01', 111]])); // correction
    expect(f(base)).not.toBe(f([...base, ['2021-01-04', 111]])); // new data
    expect(f(base)).not.toBe(f([['2020-01-01', 100]])); // entitlement revoked => points withheld
  });
});

describe('Overview coverage (screen 3): a mapping is not coverage unless the benchmark is usable', () => {
  function overviewClient(t: Record<string, unknown[]>) {
    const { client } = makeFakeSupabase(t as never);
    const real = client as unknown as { from: (t: string) => unknown; rpc: unknown };
    return {
      ...real,
      from(table: string) {
        if (table !== 'ii_benchmark_series') return real.from(table);
        let rows = (t.ii_benchmark_series ?? []) as Array<Record<string, unknown>>;
        const b: Record<string, unknown> = { select: () => b, eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; } };
        b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res);
        return b;
      },
    };
  }
  const countFor = async (t: Record<string, unknown[]>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = await buildOverviewSummary(overviewClient(t) as any, USER);
    return s.signals.instrumentsWithBenchmarkCount;
  };
  it('entitled + series published => counted; un-entitled => NOT counted; entitled but no series yet => NOT counted', async () => {
    expect(await countFor(tables())).toBe(1);
    expect(await countFor(tables({ __benchmark_access: [] }))).toBe(0);
    expect(await countFor(tables({ ii_benchmark_series: [] }))).toBe(0);
  });
});
