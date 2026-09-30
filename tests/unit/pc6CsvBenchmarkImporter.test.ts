// BENCH-1 / PC6 — CSV benchmark importer (lib/services/investment-intelligence/pc6/csvBenchmarkImporter.ts).
//
// Covers the staging validation (pure) and the publish path's licence
// enforcement, duplicate/conflict detection and dry-run default -- the
// exact controls mission BENCH-1 sections 8/10/13 require for a manual CSV
// channel that must never become a way around a data licence.
import { describe, it, expect } from 'vitest';
import { parseAndValidateBenchmarkCsv, publishBenchmarkCsv } from '@/lib/services/investment-intelligence/pc6/csvBenchmarkImporter';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const TODAY = '2026-09-30';

describe('parseAndValidateBenchmarkCsv', () => {
  it('accepts a well-formed file', () => {
    const csv = 'benchmark_key,date,value\nTEST_INDEX_TRI,2026-01-01,100.0000\nTEST_INDEX_TRI,2026-01-02,101.2500\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('ok');
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].value).toBe(100);
  });

  it('accepts columns in any order, case-insensitively', () => {
    const csv = 'Value,Benchmark_Key,DATE\n100,TEST_INDEX_TRI,2026-01-01\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('ok');
    expect(result.accepted[0]).toMatchObject({ benchmarkKey: 'TEST_INDEX_TRI', date: '2026-01-01', value: 100 });
  });

  it('rejects a file with a missing required header column', () => {
    const csv = 'benchmark_key,date\nTEST_INDEX_TRI,2026-01-01\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('rejected_all');
    expect(result.rejected[0].reason).toContain('Header must contain');
  });

  it('rejects an invalid date with a per-row reason and row number, without discarding the rest of the file', () => {
    const csv = 'benchmark_key,date,value\nTEST_INDEX_TRI,not-a-date,100\nTEST_INDEX_TRI,2026-01-02,101\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('ok');
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rowNumber).toBe(1);
    expect(result.rejected[0].reason).toContain('Invalid date');
  });

  it('rejects a future-dated row -- no historical calculation may use future information', () => {
    const csv = `benchmark_key,date,value\nTEST_INDEX_TRI,2099-01-01,100\n`;
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('rejected_all');
    expect(result.rejected[0].reason).toContain('future');
  });

  it('rejects the AMFI-style bare trailing-dot value (e.g. "10.") that a lenient parser would silently coerce to 10', () => {
    const csv = 'benchmark_key,date,value\nTEST_INDEX_TRI,2026-01-01,10.\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('rejected_all');
    expect(result.rejected[0].reason).toContain('not a plain decimal number');
  });

  it('rejects a non-positive value', () => {
    const csv = 'benchmark_key,date,value\nTEST_INDEX_TRI,2026-01-01,0\nTEST_INDEX_TRI,2026-01-02,-5\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.status).toBe('rejected_all');
    expect(result.rejected).toHaveLength(2);
  });

  it('skips an exact intra-file duplicate (same benchmark_key + date) rather than accepting both', () => {
    const csv = 'benchmark_key,date,value\nTEST_INDEX_TRI,2026-01-01,100\nTEST_INDEX_TRI,2026-01-01,100\n';
    const result = parseAndValidateBenchmarkCsv(csv, TODAY);
    expect(result.accepted).toHaveLength(1);
    expect(result.intraFileDuplicatesSkipped).toBe(1);
  });

  it('reports empty for a file with only a header', () => {
    const result = parseAndValidateBenchmarkCsv('benchmark_key,date,value\n', TODAY);
    expect(result.status).toBe('empty');
  });
});

describe('publishBenchmarkCsv', () => {
  const acceptedRow = (overrides: Partial<{ benchmarkKey: string; date: string; value: number }> = {}) => [
    { rowNumber: 1, benchmarkKey: 'TEST_INDEX_TRI', date: '2026-01-01', value: 100, rawValue: '100', ...overrides },
  ];

  it('blocks a row whose benchmark_key does not exist in ii_benchmarks -- never creates a new identity from a CSV', async () => {
    const { client } = makeFakeSupabase({ ii_benchmarks: [], ii_benchmark_series: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow());
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain('never creates a new benchmark identity');
    expect(result.written).toBe(0);
  });

  it('blocks a row for a benchmark that is licence_required -- a CSV is a mechanism, not a licence', async () => {
    const { client } = makeFakeSupabase({
      ii_benchmarks: [{ id: 'bm-1', benchmark_key: 'TEST_INDEX_TRI', licence_status: 'licence_required' }],
      ii_benchmark_series: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow());
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain('licence_status');
    expect(result.written).toBe(0);
  });

  it('defaults to dry run: a licence-clear, non-conflicting row is planned but NOT written unless dryRun:false is explicit', async () => {
    const { client, writes } = makeFakeSupabase({
      ii_benchmarks: [{ id: 'bm-1', benchmark_key: 'TEST_INDEX_TRI', licence_status: 'public_open' }],
      ii_benchmark_series: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow());
    expect(result.dryRun).toBe(true);
    expect(result.toInsert).toHaveLength(1);
    expect(result.written).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('writes exactly the planned rows when dryRun:false, tagging them with the import batch and data_version', async () => {
    const { client, writes } = makeFakeSupabase({
      ii_benchmarks: [{ id: 'bm-1', benchmark_key: 'TEST_INDEX_TRI', licence_status: 'public_open' }],
      ii_benchmark_series: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow(), { dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(result.written).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('ii_benchmark_series');
    const payload = writes[0].payload as Array<{ benchmark_id: string; series_date: string; value: number; import_batch_id: string }>;
    expect(payload[0]).toMatchObject({ benchmark_id: 'bm-1', series_date: '2026-01-01', value: 100 });
    expect(payload[0].import_batch_id).toBeTruthy();
  });

  it('treats a re-import of an identical value as a no-op, not a conflict or a duplicate write', async () => {
    const { client, writes } = makeFakeSupabase({
      ii_benchmarks: [{ id: 'bm-1', benchmark_key: 'TEST_INDEX_TRI', licence_status: 'public_open' }],
      ii_benchmark_series: [{ benchmark_id: 'bm-1', series_date: '2026-01-01', value: 100 }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow(), { dryRun: false });
    expect(result.identicalSkipped).toBe(1);
    expect(result.written).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('flags a differing already-published value as a conflict rather than silently overwriting it', async () => {
    const { client, writes } = makeFakeSupabase({
      ii_benchmarks: [{ id: 'bm-1', benchmark_key: 'TEST_INDEX_TRI', licence_status: 'public_open' }],
      ii_benchmark_series: [{ benchmark_id: 'bm-1', series_date: '2026-01-01', value: 99 }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await publishBenchmarkCsv(client as any, acceptedRow(), { dryRun: false });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ existingValue: 99, incomingValue: 100 });
    expect(result.written).toBe(0);
    expect(writes).toHaveLength(0);
  });
});
