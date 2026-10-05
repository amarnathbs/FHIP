// NAV2 Stage 2 -- the correction worker (cache invalidation) and the risk-free dataset loader.
//
// Matrix: Stage 2 rows S2-07 (a corrected NAV / benchmark / risk-free value invalidates exactly the entries it can affect; also spec
// row 9 and 40), S2-08 (the risk-free dataset version moves when a value is corrected), S2-09 (unapplied / unreadable risk-free
// storage is "no dataset", never a zero rate).
//
// NAMED NEGATIVE CONTROLS
//   NC-W1  a correction dated AFTER an entry's last NAV date does not invalidate it; another scheme's entry is untouched;
//   NC-W2  a processed event is never processed again (idempotent), and an unprocessable event is counted, not lost;
//   NC-W3  a benchmark correction touches only that benchmark's entries, a risk-free correction only that dataset's;
//   NC-L1  the dataset version changes when ANY value, the verified-through date, the switch or the terms status changes;
//   NC-L2  a failed read, a missing table and an empty registry are all "no supply" with a plain reason (never null-as-zero).
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { eventToInvalidation, isCacheable, processNav2CorrectionEvents } from '@/lib/services/investment-intelligence/nav2/nav2ResultCacheStore';
import { loadRiskFreeSupply, rowsToRiskFreeDatasets, type RiskFreeObservationRow, type RiskFreeSeriesRow } from '@/lib/services/investment-intelligence/nav2/riskFreeDatasetLoader';
import { createInMemoryDb, type Row } from '../support/inMemorySupabase';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BM = '33333333-3333-4333-8333-333333333333';
const BM2 = '44444444-4444-4444-8444-444444444444';

const entry = (key: string, over: Row): Row => ({ cache_key: key, instrument_id: A, metric_id: 'scheme_performance_bundle', policy_version: 'nav2-policy-v1', definition_version: 'd', actual_end: '2026-10-02', benchmark_id: null, risk_free_dataset_id: null, invalidated_at: null, ...over });

function world(events: Row[], cache: Row[], deps: Row[] = []) {
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ nav2_correction_events: events, nav2_result_cache: cache, nav2_report_nav_dependencies: deps });
  return { db, admin: db.client as unknown as SupabaseClient };
}

describe('correction worker', () => {
  it('NC-W1: a NAV correction invalidates only that scheme\'s entries that could have used the corrected date', async () => {
    const { db, admin } = world(
      [{ id: 1, kind: 'nav_correction', instrument_id: A, benchmark_id: null, series_id: null, event_date: '2026-09-01', processed_at: null }],
      [
        entry('a-current', { instrument_id: A, actual_end: '2026-10-02' }),
        entry('a-ended-before', { instrument_id: A, actual_end: '2026-08-15' }),
        entry('b-current', { instrument_id: B, actual_end: '2026-10-02' }),
      ],
      [{ id: 'd1', instrument_id: A, nav_date_to: '2026-10-02' }, { id: 'd2', instrument_id: A, nav_date_to: '2026-08-01' }]
    );
    const r = await processNav2CorrectionEvents(admin, 50, '2026-10-04T00:00:00.000Z');
    expect(r).toMatchObject({ eventsProcessed: 1, entriesInvalidated: 1, failed: 0, pinnedReportsAffected: 1 });
    const by = Object.fromEntries(db.tables.nav2_result_cache.map((c) => [c.cache_key as string, c.invalidated_at]));
    expect(by['a-current']).toBe('2026-10-04T00:00:00.000Z');
    expect(by['a-ended-before']).toBeNull();
    expect(by['b-current']).toBeNull();
    expect(db.tables.nav2_correction_events[0]).toMatchObject({ processed_at: '2026-10-04T00:00:00.000Z', entries_invalidated: 1 });
  });

  it('NC-W2: running again processes nothing; a malformed event is counted as processed with zero invalidated, never looped on', async () => {
    const { admin } = world(
      [
        { id: 1, kind: 'nav_correction', instrument_id: A, benchmark_id: null, series_id: null, event_date: '2026-09-01', processed_at: null },
        { id: 2, kind: 'benchmark_correction', instrument_id: null, benchmark_id: null, series_id: null, event_date: '2026-09-01', processed_at: null },
      ],
      [entry('a-current', {})]
    );
    const first = await processNav2CorrectionEvents(admin, 50);
    expect(first.eventsProcessed).toBe(2);
    expect(first.entriesInvalidated).toBe(1);
    const second = await processNav2CorrectionEvents(admin, 50);
    expect(second).toMatchObject({ eventsProcessed: 0, entriesInvalidated: 0 });
  });

  it('NC-W3: benchmark and risk-free corrections touch only their own dependants', async () => {
    const { db, admin } = world(
      [
        { id: 1, kind: 'benchmark_correction', instrument_id: null, benchmark_id: BM, series_id: null, event_date: '2026-09-01', processed_at: null },
        { id: 2, kind: 'risk_free_correction', instrument_id: null, benchmark_id: null, series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', event_date: '2026-09-01', processed_at: null },
      ],
      [
        entry('uses-bm', { benchmark_id: BM }),
        entry('uses-bm2', { benchmark_id: BM2 }),
        entry('uses-rf', { risk_free_dataset_id: 'RBI_91D_TBILL_CUTOFF_YIELD' }),
        entry('uses-repo', { risk_free_dataset_id: 'RBI_POLICY_REPO_RATE' }),
        entry('plain', {}),
      ]
    );
    const r = await processNav2CorrectionEvents(admin, 50, '2026-10-04T00:00:00.000Z');
    expect(r.entriesInvalidated).toBe(2);
    const invalid = db.tables.nav2_result_cache.filter((c) => c.invalidated_at).map((c) => c.cache_key).sort();
    expect(invalid).toEqual(['uses-bm', 'uses-rf']);
  });

  it('maps each event kind to its invalidation and refuses an event with no subject', () => {
    expect(eventToInvalidation({ id: 1, kind: 'nav_correction', instrument_id: A, benchmark_id: null, series_id: null, event_date: '2026-09-01' })).toEqual({ kind: 'nav_correction', instrumentId: A, date: '2026-09-01' });
    expect(eventToInvalidation({ id: 1, kind: 'risk_free_correction', instrument_id: null, benchmark_id: null, series_id: 'S', event_date: '2026-09-01' })).toEqual({ kind: 'risk_free_correction', datasetId: 'S', date: '2026-09-01' });
    expect(eventToInvalidation({ id: 1, kind: 'nav_correction', instrument_id: null, benchmark_id: null, series_id: null, event_date: '2026-09-01' })).toBeNull();
  });

  it('only entries whose ids fit the table are cacheable', () => {
    const parts = { scopeId: null, instrumentId: A, metricId: 'scheme_performance_bundle', definitionVersion: 'd', policyVersion: 'p', requested: { start: null, end: null }, actual: { start: null, end: null }, navSeriesChecksum: 'c', benchmarkId: null, benchmarkDatasetVersion: null, riskFreeDatasetId: null, riskFreeDatasetVersion: null, transactionVersion: null, currency: 'INR' } as const;
    expect(isCacheable(parts)).toBe(true);
    expect(isCacheable({ ...parts, instrumentId: 'inst-a' })).toBe(false);
    expect(isCacheable({ ...parts, benchmarkId: `${BM}+${BM2}` })).toBe(false);
  });
});

const seriesRow = (over: Partial<RiskFreeSeriesRow> = {}): RiskFreeSeriesRow => ({
  series_id: 'RBI_91D_TBILL_CUTOFF_YIELD',
  series_name: 'RBI 91-day Treasury bill auction cut-off yield',
  source: 'Reserve Bank of India',
  attribution_text: 'Source: Reserve Bank of India',
  cadence: 'weekly_auction',
  max_staleness_days: 21,
  enabled: true,
  terms_review_status: 'po_accepted_2026-10-03',
  verified_through_date: null,
  ...over,
});
const obsRow = (date: string, value: number | null, over: Partial<RiskFreeObservationRow> = {}): RiskFreeObservationRow => ({
  series_id: 'RBI_91D_TBILL_CUTOFF_YIELD',
  observation_date: date,
  kind: value === null ? 'gap' : 'value',
  value_percent: value,
  gap_reason: value === null ? 'no_accepted_bids' : null,
  source_document: 'RBI press release (synthetic test row)',
  source_url: null,
  retrieved_on: '2026-10-03',
  notes: null,
  entry_kind: 'first_load_csv',
  extraction: null,
  ...over,
});

describe('risk-free dataset loader', () => {
  const rows = [obsRow('2026-09-24', 5.5199), obsRow('2026-09-17', '5.4' as unknown as number), obsRow('2026-09-10', null)];

  it('maps rows to the engine contract: ascending, numeric (numeric columns arrive as strings), gap rows keep no value', () => {
    const [ds] = rowsToRiskFreeDatasets([seriesRow()], rows);
    expect(ds.observations.map((o) => o.observationDate)).toEqual(['2026-09-10', '2026-09-17', '2026-09-24']);
    expect(ds.observations[1].yieldPercent).toBe(5.4);
    expect(ds.observations[0]).toMatchObject({ kind: 'gap', yieldPercent: null, gapReason: 'no_accepted_bids' });
    expect(ds).toMatchObject({ seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD', enabled: true, termsReviewStatus: 'po_accepted_2026-10-03', maxStalenessDays: 21, retrievedOn: '2026-10-03' });
  });

  it('NC-L1: the dataset version is deterministic and moves with every input that can change a ratio', () => {
    const v = (s: Partial<RiskFreeSeriesRow>, o: RiskFreeObservationRow[] = rows) => rowsToRiskFreeDatasets([seriesRow(s)], o)[0].datasetVersion;
    const base = v({});
    expect(v({})).toBe(base);
    expect(base).toMatch(/^RBI_91D_TBILL_CUTOFF_YIELD@[0-9a-f]{16}$/);
    expect(v({}, [obsRow('2026-09-24', 5.52), ...rows.slice(1)])).not.toBe(base);
    expect(v({ enabled: false })).not.toBe(base);
    expect(v({ terms_review_status: 'declined' })).not.toBe(base);
    expect(v({ verified_through_date: '2026-09-30' })).not.toBe(base);
    expect(v({}, [...rows, obsRow('2026-10-01', 5.6)])).not.toBe(base);
  });

  it('a series with no rows is an empty dataset (the engine then reports it unavailable), not an error', () => {
    const [ds] = rowsToRiskFreeDatasets([seriesRow()], []);
    expect(ds.observations).toEqual([]);
  });

  it('loads the selected (primary) series from storage', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({
      ii_risk_free_series: [seriesRow(), seriesRow({ series_id: 'RBI_POLICY_REPO_RATE', cadence: 'policy_change', max_staleness_days: 90, verified_through_date: '2026-09-30' })] as unknown as Row[],
      ii_risk_free_observations: [...rows, obsRow('2026-06-06', 5.5, { series_id: 'RBI_POLICY_REPO_RATE' })] as unknown as Row[],
    });
    const r = await loadRiskFreeSupply(db.client as unknown as SupabaseClient);
    expect(r.unavailableReason).toBeNull();
    expect(r.supply?.seriesId).toBe('RBI_91D_TBILL_CUTOFF_YIELD');
    expect(r.datasets.map((d) => d.seriesId).sort()).toEqual(['RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE']);
    expect(r.supply?.observations).toHaveLength(3);
  });

  it('a disabled series is still supplied (so the engine can say it is switched off), flagged enabled=false', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ ii_risk_free_series: [seriesRow({ enabled: false })] as unknown as Row[], ii_risk_free_observations: rows as unknown as Row[] });
    const r = await loadRiskFreeSupply(db.client as unknown as SupabaseClient);
    expect(r.supply?.enabled).toBe(false);
    expect(r.supply?.observations).toHaveLength(3);
  });

  it('NC-L2: an empty registry, a failed read and a missing table are all "no supply" with a plain reason', async () => {
    const empty = createInMemoryDb({ strictSchema: true });
    empty.reset({ ii_risk_free_series: [], ii_risk_free_observations: [] });
    const a = await loadRiskFreeSupply(empty.client as unknown as SupabaseClient);
    expect(a.supply).toBeNull();
    expect(a.unavailableReason).toMatch(/No risk-free rate series/);

    const erroring = { from: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) } as unknown as SupabaseClient;
    const b = await loadRiskFreeSupply(erroring);
    expect(b.supply).toBeNull();
    expect(b.unavailableReason).toMatch(/could not be read/);

    const missing = { from: () => { throw new Error('relation "ii_risk_free_series" does not exist'); } } as unknown as SupabaseClient;
    const c = await loadRiskFreeSupply(missing);
    expect(c.supply).toBeNull();
    expect(c.unavailableReason).toMatch(/could not be read/);
  });
});
