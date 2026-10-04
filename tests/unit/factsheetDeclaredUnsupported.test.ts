// A scheme whose OWN documents declare a benchmark the data we hold cannot represent (a composite, a gold / silver
// price, an index not in the catalogue) must NEVER silently fall back to the read-time CATEGORY benchmark: that would
// compare the fund with an index its own documents say it does not follow. Every surface shows
// "Declared benchmark: <name as stated> (cannot be compared with the data we hold)" and no comparison number.
// Only a scheme with NO declared record at all keeps the category fallback. And once an auto-published or
// admin-approved single-series declared benchmark exists, the label switches from "Category benchmark" to
// "Fund's declared benchmark" on the next load, with nothing to do by hand.
//
// EVIDENCE LABEL: code-level unit tests with the in-memory Supabase fake. Nothing ran against DEV or PROD.
import { describe, expect, it } from 'vitest';
import {
  declaredRecordMessage,
  declaredRecordsFromRpc,
  isDeclaredRecordsUnavailable,
  statusForCatalogueState,
  type DeclaredRecord,
} from '@/lib/services/investment-intelligence/benchmarkData/declaredRecordStatus';
import { loadCategoryReferenceMappings } from '@/lib/services/investment-intelligence/benchmarkData/categoryReferenceLoader';
import { buildHeldSchemeRows, heldBenchmarkState, type HeldSchemeRaw } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import { DECLARED_BENCHMARK_LABEL } from '@/lib/services/investment-intelligence/benchmarkData/categoryReference';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const USER = 'user-1';
const BMV = 'bm-nifty100';
const COMPOSITE = '45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver';

const rec = (over: Partial<DeclaredRecord> = {}): DeclaredRecord => ({ instrumentId: 'i1', status: 'declared_unsupported', declaredName: COMPOSITE, benchmarkKind: 'composite', catalogueState: 'unsupported_composite', ...over });
const rpcRow = (r: DeclaredRecord) => ({ instrument_id: r.instrumentId, declared_name: r.declaredName, benchmark_kind: r.benchmarkKind, catalogue_state: r.catalogueState });

const bmRow = (id: string, key: string, label: string, over: Record<string, unknown> = {}) => ({ id, benchmark_key: key, benchmark_label: label, return_type: 'TRI', lifecycle_status: 'active', catalogue_status: 'verified', ...over });
const access = (o: Record<string, unknown> = {}) => ({ benchmark_id: BMV, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null, ...o });

/** A Large Cap scheme (which WOULD get NIFTY 100 TRI as its category benchmark) with full history, a verified entitled catalogue entry. */
function world(opts: { declared?: boolean; instruments?: Array<{ id: string; name: string; sub: string }> } = {}) {
  const instruments = opts.instruments ?? [{ id: 'i1', name: 'Test Large Cap Fund', sub: 'Large Cap Fund' }];
  return {
    ii_portfolio_truth_status: instruments.map((i) => ({ user_id: USER, account_id: `a-${i.id}`, instrument_id: i.id, status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'd1', history_completeness: 'complete_from_inception' })),
    ii_transactions: instruments.map((i) => ({ user_id: USER, account_id: `a-${i.id}`, instrument_id: i.id, transaction_type: 'purchase', transaction_date: '2020-01-01', gross_amount: 10000, units: 500, currency_code: 'INR', status: 'parsed' })),
    ii_holding_snapshots: instruments.map((i) => ({ user_id: USER, account_id: `a-${i.id}`, instrument_id: i.id, as_of_date: '2021-01-01', units: 500, value: 15000, currency_code: 'INR', quality_status: 'certified', source_document_id: 'd1' })),
    ii_instruments: instruments.map((i) => ({ id: i.id, instrument_name: i.name, base_currency: 'INR', country_of_domicile: 'IN', isin: `INF00000000${i.id.length}` })),
    ii_accounts: instruments.map((i) => ({ id: `a-${i.id}`, user_id: USER, folio_number: `F-${i.id}`, institution_name: 'AMC', currency_code: 'INR' })),
    ii_source_documents: [{ id: 'd1', source_detected: 'cams' }],
    ii_scheme_master: instruments.map((i) => ({ instrument_id: i.id, scheme_name: i.name, sub_category: i.sub, category_header_raw: null, effective_to: null })),
    ii_instrument_benchmarks: opts.declared
      ? [{ instrument_id: 'i1', benchmark_id: 'bm-declared', relationship_type: 'primary', effective_from: '2019-01-01', effective_to: null, quality_status: 'ok', ii_benchmarks: { benchmark_key: 'IN_BSE_100_TRI', benchmark_label: 'BSE 100 TRI', return_type: 'TRI', licence_status: 'unknown', lifecycle_status: 'active', catalogue_status: 'verified' } }]
      : [],
    ii_benchmarks: [bmRow(BMV, 'IN_NIFTY_100_TRI', 'NIFTY 100 TRI')],
    ii_benchmark_series: [
      { benchmark_id: BMV, series_date: '2020-01-01', value: 100, quality_status: 'ok' },
      { benchmark_id: BMV, series_date: '2021-01-01', value: 110, quality_status: 'ok' },
      { benchmark_id: 'bm-declared', series_date: '2020-01-01', value: 100, quality_status: 'ok' },
      { benchmark_id: 'bm-declared', series_date: '2021-01-01', value: 120, quality_status: 'ok' },
    ],
    ii_risk_free_rates: [],
    ii_prices_nav: [],
    __benchmark_access: [access(), access({ benchmark_id: 'bm-declared' })],
  };
}

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null };
/** The in-memory client with the declared-records function answering as the database would. */
function clientWith(tables: Record<string, unknown[]>, declared: (ids: string[]) => RpcAnswer) {
  const h = makeFakeSupabase(tables as never);
  const calls: string[][] = [];
  const base = h.client as unknown as { rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcAnswer> };
  const client = {
    ...(h.client as object),
    rpc: (name: string, args?: Record<string, unknown>) => {
      if (name === 'declared_benchmark_records_for') {
        const ids = (args?.p_instrument_ids as string[]) ?? [];
        calls.push(ids);
        return Promise.resolve(declared(ids));
      }
      return base.rpc(name, args);
    },
  };
  return { client: client as never, calls, writes: h.writes };
}
const MSG = `Declared benchmark: ${COMPOSITE} (cannot be compared with the data we hold)`;
const compositeFor = (...ids: string[]) => (asked: string[]): RpcAnswer => ({ data: asked.filter((i) => ids.includes(i)).map((i) => rpcRow(rec({ instrumentId: i }))), error: null });

describe('the pure rule', () => {
  it('only the catalogue states that cannot be compared (or await review) make a declared record; a verified match makes none', () => {
    expect(statusForCatalogueState('unsupported_composite')).toBe('declared_unsupported');
    expect(statusForCatalogueState('unsupported_commodity')).toBe('declared_unsupported');
    expect(statusForCatalogueState('no_catalogue_match')).toBe('declared_unsupported');
    expect(statusForCatalogueState('matched_other')).toBe('declared_awaiting_review');
    expect(statusForCatalogueState('matched_verified')).toBeNull();
  });
  it('the sentence is exactly "Declared benchmark: <name as stated> (cannot be compared with the data we hold)"', () => {
    expect(declaredRecordMessage(rec())).toBe(MSG);
    expect(declaredRecordMessage(rec({ status: 'declared_awaiting_review', declaredName: 'Nifty X TRI' }))).toBe('Declared benchmark: Nifty X TRI (awaiting review before it can be compared)');
    expect(declaredRecordMessage(rec({ declaredName: 'x'.repeat(400) })).length).toBeLessThan(260);
  });
  it('rows are coerced defensively: unknown states, missing fields and non-arrays are dropped, never shown', () => {
    expect(declaredRecordsFromRpc(null).size).toBe(0);
    expect(declaredRecordsFromRpc([{ instrument_id: 'i1', declared_name: 'X', catalogue_state: 'matched_verified' }, { instrument_id: 5 }, null]).size).toBe(0);
    expect(declaredRecordsFromRpc([rpcRow(rec())]).get('i1')).toMatchObject({ status: 'declared_unsupported', benchmarkKind: 'composite' });
  });
  it('"migration not applied" is recognised; a genuine failure is not', () => {
    expect(isDeclaredRecordsUnavailable({ code: 'PGRST202', message: 'x' })).toBe(true);
    expect(isDeclaredRecordsUnavailable({ message: 'Could not find the function public.declared_benchmark_records_for(p_instrument_ids)' })).toBe(true);
    expect(isDeclaredRecordsUnavailable({ code: '57P01', message: 'terminating connection' })).toBe(false);
    expect(isDeclaredRecordsUnavailable(null)).toBe(false);
  });
});

describe('the read-time loader (shared by Holdings and Performance)', () => {
  it('NEGATIVE CONTROL: a declared-unsupported scheme NEVER gets a category benchmark, even though its category (Large Cap) has one', async () => {
    const { client } = clientWith(world(), compositeFor('i1'));
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(out.mappings).toEqual([]);
    expect(out.benchmarkIds).toEqual([]);
    expect(out.facts.size).toBe(0);
    expect(out.noBenchmark.get('i1')).toBe(MSG);
  });
  it('NEGATIVE CONTROL: a scheme with NO declared record at all still gets its category benchmark', async () => {
    const { client } = clientWith(world(), compositeFor());
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(out.mappings).toHaveLength(1);
    expect(out.mappings[0]).toMatchObject({ instrumentId: 'i1', benchmarkKey: 'IN_NIFTY_100_TRI', basis: 'category_reference' });
    expect(out.noBenchmark.size).toBe(0);
  });
  it('in one call: the declared-unsupported scheme is withheld and its neighbour keeps the category benchmark', async () => {
    const t = world({ instruments: [{ id: 'i1', name: 'Multi Asset Fund', sub: 'Large Cap Fund' }, { id: 'i2', name: 'Other Large Cap Fund', sub: 'Large Cap Fund' }] });
    const { client } = clientWith(t, compositeFor('i1'));
    const out = await loadCategoryReferenceMappings(client, ['i1', 'i2'], new Set());
    expect(out.mappings.map((m) => m.instrumentId)).toEqual(['i2']);
    expect([...out.noBenchmark.keys()]).toEqual(['i1']);
  });
  it('a declared MAPPING still always wins: the lookup is not even asked about that instrument', async () => {
    const { client, calls } = clientWith(world(), compositeFor('i1'));
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set(['i1']));
    expect(out.mappings).toEqual([]);
    expect(out.noBenchmark.size).toBe(0);
    expect(calls).toEqual([]);
  });
  it('NEGATIVE CONTROL (fail closed): if the declared-record lookup fails, no category benchmark is guessed for anyone', async () => {
    const { client } = clientWith(world(), () => ({ data: null, error: { code: '57P01', message: 'terminating connection' } }));
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(out.mappings).toEqual([]);
    expect(out.noBenchmark.get('i1')).toMatch(/declared-benchmark record could not be read/);
  });
  it('migration 0252 not applied (function missing): behaviour is exactly as before, category benchmark and all', async () => {
    const { client } = clientWith(world(), () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.declared_benchmark_records_for' } }));
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(out.mappings).toHaveLength(1);
  });
  it('a declared record awaiting review is withheld too (a possibly different index is never swapped in)', async () => {
    const { client } = clientWith(world(), (asked) => ({ data: asked.map((i) => rpcRow(rec({ instrumentId: i, status: 'declared_awaiting_review', declaredName: 'Nifty Something TRI', catalogueState: 'matched_other', benchmarkKind: 'single_index' }))), error: null }));
    const out = await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(out.mappings).toEqual([]);
    expect(out.noBenchmark.get('i1')).toBe('Declared benchmark: Nifty Something TRI (awaiting review before it can be compared)');
  });
  it('the loader still writes nothing', async () => {
    const { client, writes } = clientWith(world(), compositeFor('i1'));
    await loadCategoryReferenceMappings(client, ['i1'], new Set());
    expect(writes).toEqual([]);
  });
});

describe('every surface that reaches the user', () => {
  it('Holdings table: the declared-unsupported scheme shows the sentence and NO number; a scheme with no declared record shows its category figure', async () => {
    const withRecord = clientWith(world(), compositeFor('i1'));
    const h1 = (await loadHoldingsTable(withRecord.client, USER)).holdings[0];
    expect(h1.benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'NO_MAPPING' });
    expect((h1.benchmarkComparison as { detail: string }).detail).toBe(MSG);
    expect(JSON.stringify(h1.benchmarkComparison)).not.toMatch(/benchmarkEndingValue|holdingReturn|NIFTY 100/);

    const without = clientWith(world(), compositeFor());
    const h2 = (await loadHoldingsTable(without.client, USER)).holdings[0];
    expect(h2.benchmarkComparison).toMatchObject({ status: 'ok', benchmarkBasis: 'category_reference', benchmarkLabel: 'NIFTY 100 TRI' });
  });
  it('Performance (orchestrator): the same rule; no active return and no category label for the declared-unsupported scheme', async () => {
    const run = async (declared: (ids: string[]) => RpcAnswer) => {
      const { client } = clientWith(world(), declared);
      const { dataset } = await loadAnalyticsDataset(client, USER, {});
      if (!dataset) throw new Error('no dataset');
      return runAnalytics(dataset).schemes[0];
    };
    const withheld = await run(compositeFor('i1'));
    expect(withheld.benchmarkComparison).toMatchObject({ status: 'unavailable', reason: 'NO_MAPPING' });
    expect(withheld.activeReturn.value).toBeUndefined();
    expect(JSON.stringify(withheld.benchmarkComparison)).toContain('cannot be compared with the data we hold');
    const category = await run(compositeFor());
    expect(category.benchmarkComparison).toMatchObject({ status: 'ok', benchmarkBasis: 'category_reference' });
  });
});

describe('the admin held-schemes list', () => {
  const raw = (over: Partial<HeldSchemeRaw> = {}): HeldSchemeRaw => ({ instrumentId: 'i1', instrumentName: 'SBI Multi Asset Allocation Fund', amcName: 'SBI', amfiSchemeCode: '103408', subCategory: 'Large Cap Fund', categoryHeaderRaw: null, holderCount: null, firstHeldDate: null, mapped: false, proposalWaiting: false, ...over });

  it('NEGATIVE CONTROL: a declared-unsupported scheme is "declared_unsupported" with the sentence; it is never "category_reference"', () => {
    const s = heldBenchmarkState(raw({ declaredRecord: rec() }));
    expect(s).toEqual({ kind: 'declared_unsupported', declaredName: COMPOSITE, status: 'declared_unsupported', message: MSG });
  });
  it('NEGATIVE CONTROL: with NO declared record the same scheme is category_reference', () => {
    expect(heldBenchmarkState(raw()).kind).toBe('category_reference');
    expect(heldBenchmarkState(raw({ declaredRecord: null })).kind).toBe('category_reference');
  });
  it('the label switches from "Category benchmark" to "Fund\'s declared benchmark" on the next load once a declared mapping exists (auto-published or admin-approved)', () => {
    const before = buildHeldSchemeRows([raw({ instrumentName: 'HDFC Large Cap Fund', amfiSchemeCode: '102000', mapped: false })]);
    expect(before.rows[0].benchmark.kind).toBe('category_reference');
    expect(before.counts).toMatchObject({ declared: 0, categoryReference: 1 });
    // the nightly / monthly job (or an admin) publishes the mapping; the NEXT load reads mapped = true. Nothing else changes by hand.
    const after = buildHeldSchemeRows([raw({ instrumentName: 'HDFC Large Cap Fund', amfiSchemeCode: '102000', mapped: true })]);
    expect(after.rows[0].benchmark).toEqual({ kind: 'declared', label: DECLARED_BENCHMARK_LABEL });
    expect(DECLARED_BENCHMARK_LABEL).toBe("Fund's declared benchmark");
    expect(after.counts).toMatchObject({ declared: 1, categoryReference: 0 });
  });
  it('a declared MAPPING outranks a declared-unsupported record (rule order: mapping, then declared-unsupported, then category)', () => {
    expect(heldBenchmarkState(raw({ mapped: true, declaredRecord: rec() })).kind).toBe('declared');
  });
  it('the counts report declared-unsupported schemes separately, and the row carries its last factsheet check', () => {
    const r = buildHeldSchemeRows([raw({ declaredRecord: rec() }), raw({ instrumentId: 'i2', instrumentName: 'HDFC Large Cap Fund' })], {
      factsheetChecks: new Map([['i1', { checkedAt: '2026-10-03T02:00:00.000Z', outcome: 'recorded_first_observation', result: 'Benchmark recorded (first reading)', documentDate: '2026-04-30' }]]),
    });
    expect(r.counts).toMatchObject({ held: 2, declaredUnsupported: 1, categoryReference: 1 });
    expect(r.rows.find((x) => x.instrumentId === 'i1')?.factsheetCheck).toMatchObject({ outcome: 'recorded_first_observation' });
    expect(r.rows.find((x) => x.instrumentId === 'i2')?.factsheetCheck).toBeNull();
  });
});

describe('the "declared wins" tests of the three layers stay as they were', () => {
  it('a declared mapping is still used for Holdings (BSE 100 TRI 20%, not the category NIFTY 100 TRI 10%) and the lookup is not consulted for it', async () => {
    const { client, calls } = clientWith(world({ declared: true }), compositeFor('i1'));
    const c = (await loadHoldingsTable(client, USER)).holdings[0].benchmarkComparison;
    expect(c.status).toBe('ok');
    if (c.status !== 'ok') return;
    expect(c).toMatchObject({ benchmarkBasis: 'declared', benchmarkLabel: 'BSE 100 TRI', benchmarkBasisLabel: DECLARED_BENCHMARK_LABEL });
    expect(calls.flat()).not.toContain('i1');
  });
});
