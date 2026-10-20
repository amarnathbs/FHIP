/**
 * Document2 (4) F9 (Product Owner live review, 20-10-2026): "Still benchmark is not showing even after NSE and BSE history has been
 * updated in the app".
 *
 * ROOT CAUSE (integration, not data). The SIP consumer (r5Repository.loadBenchmarkSeries) read ONLY declared primary mappings. The Performance
 * and Holdings tabs also resolve a fund with no declared mapping to the read-time CATEGORY REFERENCE (the usual benchmark for its category).
 * After the index history was loaded a fund had a category benchmark with data but no declared row: Performance compared it, SIP said
 * "No primary benchmark mapping exists for these schemes".
 *
 * Harness: the in-memory Supabase fake the category-reference tests use. NEGATIVE CONTROLS: each gate (no entitlement, unverified catalogue,
 * price index, no series, unsupported category) leaves NO benchmark and names exactly why; a declared mapping still wins.
 */
import { describe, it, expect } from 'vitest';
import { loadBenchmarkSeries } from '@/lib/services/investment-intelligence/r5Repository';
import { runSipAnalytics } from '@/lib/engines/investment-intelligence/sip/sipOrchestrator';
import { calculateBenchmarkSip } from '@/lib/engines/investment-intelligence/sip/sipXirr';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const BMV = 'bm-nifty100';
const bmRow = (id: string, key: string, label: string, over: Record<string, unknown> = {}) => ({ id, benchmark_key: key, benchmark_label: label, return_type: 'TRI', lifecycle_status: 'active', catalogue_status: 'verified', ...over });
const access = (o: Record<string, unknown> = {}) => ({ benchmark_id: BMV, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null, ...o });
function world(opts: { declared?: boolean; sub?: string; name?: string; catalogue?: Record<string, unknown>; access?: unknown[]; series?: boolean } = {}) {
  return {
    ii_instruments: [{ id: 'i1', instrument_name: opts.name ?? 'L036G-Test Large Cap Fund (Non-Demat)', base_currency: 'INR', country_of_domicile: 'IN' }],
    ii_scheme_master: [{ instrument_id: 'i1', sub_category: opts.sub ?? 'Large Cap Fund', category_header_raw: null, effective_to: null }],
    ii_instrument_benchmarks: opts.declared
      ? [{ instrument_id: 'i1', benchmark_id: 'bm-declared', relationship_type: 'primary', effective_from: '2019-01-01', effective_to: null, quality_status: 'ok' }]
      : [],
    ii_benchmarks: [bmRow(BMV, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI', opts.catalogue ?? {}), bmRow('bm-declared', 'IN_BSE_100_TRI', 'BSE 100 TRI')],
    ii_benchmark_series:
      opts.series === false
        ? []
        : [
            { benchmark_id: BMV, series_date: '2020-01-01', value: 100, quality_status: 'ok' },
            { benchmark_id: BMV, series_date: '2026-10-01', value: 220, quality_status: 'ok' },
            { benchmark_id: 'bm-declared', series_date: '2020-01-01', value: 100, quality_status: 'ok' },
            { benchmark_id: 'bm-declared', series_date: '2026-10-01', value: 300, quality_status: 'ok' },
          ],
    __benchmark_access: opts.access ?? [access(), access({ benchmark_id: 'bm-declared' })],
  };
}
const run = async (t: Record<string, unknown[]>) => {
  const { client, writes } = makeFakeSupabase(t as never) as unknown as { client: never; writes: unknown[] };
  const warnings: Array<{ scope: string; detail: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await loadBenchmarkSeries(client as any, ['i1'], warnings);
  return { ...out, warnings, writes };
};

describe('F9: the SIP page resolves a benchmark the same way Performance does', () => {
  it('no declared mapping, supported category, verified + entitled + loaded: the category benchmark is used and labelled (the old code gave none)', async () => {
    const r = await run(world());
    const bm = r.byInstrument.get('i1')!;
    expect(bm).toBeDefined();
    expect(bm.benchmarkKey).toBe('IN_NIFTY_100_TRI');
    expect(bm.basis).toBe('category_reference');
    expect(bm.basisLabel).toMatch(/usual benchmark for Large Cap funds/);
    expect(bm.series).toHaveLength(2);
    expect(r.reasons.has('i1')).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.writes).toEqual([]); // nothing is stored
  });

  it('end to end: the same contributions replayed into the benchmark give a figure, from the independent oracle', () => {
    // two contributions of 10,000 on 01-01-2020 (level 100) and 01-10-2026 is the end; one contribution on the first date only
    const series = { seriesKey: 'a:i1:x', accountId: 'a', instrumentId: 'i1', currencyCode: 'INR', contributions: [{ transactionDate: '2020-01-01', grossAmount: 10000 }] } as never;
    const r = calculateBenchmarkSip(series, { benchmarkSeries: [{ date: '2020-01-01', value: 100 }, { date: '2026-10-01', value: 220 }], asOfDate: '2026-10-01', benchmarkReturnType: 'TRI' });
    expect(r.status).toBe('ok');
    expect(r.terminalValue).toBeCloseTo(10000 * (220 / 100), 6); // units = 10000/100, value = units x 220
    const days = (Date.parse('2026-10-01') - Date.parse('2020-01-01')) / 86_400_000;
    expect(r.rate).toBeCloseTo(Math.pow(2.2, 365 / days) - 1, 5);
  });

  it('a DECLARED mapping still wins (NEGATIVE CONTROL: BSE 100 TRI, not the category benchmark)', async () => {
    const bm = (await run(world({ declared: true }))).byInstrument.get('i1')!;
    expect(bm.benchmarkKey).toBe('IN_BSE_100_TRI');
    expect(bm.basis).toBe('declared');
  });

  it.each([
    ['no approved entitlement', { access: [] }, /no approved entitlement/],
    ['an unverified catalogue entry', { catalogue: { catalogue_status: 'draft' } }, /catalogue entry has not been verified yet/],
    ['a price index only', { catalogue: { return_type: 'PRI' } }, /only its price index is loaded.*needs the total-return index of NIFTY 100 TRI/],
    ['no loaded history', { series: false }, /no history of it is loaded yet/],
  ])('NEGATIVE CONTROL (%s): no benchmark, and the exact missing prerequisite is named, not a generic sentence', async (_n, over, pattern) => {
    const r = await run(world(over as never));
    expect(r.byInstrument.has('i1')).toBe(false);
    expect(r.reasons.get('i1')).toMatch(pattern);
    expect(r.warnings.filter((w) => w.scope === 'benchmark').map((w) => w.detail).join(' ')).toMatch(/1 of your 1 fund could not be compared with a benchmark/);
  });

  it('NEGATIVE CONTROL: a category with no honest benchmark (a gold fund of funds) says so in the catalogue\'s own words', async () => {
    const r = await run(world({ sub: 'FoF Domestic', name: 'HGFOF-HDFC Gold ETF Fund of Fund - Regular Plan - Growth (Non-Demat)' }));
    expect(r.byInstrument.has('i1')).toBe(false);
    expect(r.reasons.get('i1')).toMatch(/Benchmark not available for this fund category/);
  });

  it('the reason travels into the SIP result, so the card says why instead of "no benchmark is mapped, or no history is available"', () => {
    const series = { seriesKey: 'a:i1:x', accountId: 'a', instrumentId: 'i1', currencyCode: 'INR', contributions: [{ transactionDate: '2020-01-01', grossAmount: 10000 }] } as never;
    const r = calculateBenchmarkSip(series, { benchmarkSeries: null, asOfDate: '2026-10-01', missingReason: 'NIFTY 100 TRI is the usual benchmark for this fund\'s category, but no history of it is loaded yet, so no comparison is shown.' });
    expect(r.status).toBe('unavailable');
    expect(r.detail).toMatch(/no history of it is loaded yet.*No comparison figure is shown/);
    expect(r.detail).not.toMatch(/no benchmark history is available/);
    void runSipAnalytics;
  });
});
