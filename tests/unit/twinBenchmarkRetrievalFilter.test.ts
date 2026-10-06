// The Twin read path must never serve a superseded benchmark figure (Planning Benchmarks staged upload, design
// section 9). This touches lib/services/twinBenchmarkRetrieval.ts, a LIVE Financial Twin path, so it is tested
// against an in-memory query builder that really applies the filters the code sends.
//
// NAMED NEGATIVE CONTROL (NC-F1): the same assertions run against a builder whose `.or()` is a no-op (the
// behaviour BEFORE this change); the assertion that no superseded row is served MUST go red.
import { describe, it, expect } from 'vitest';
import { liveWindowFilter, loadHealthyRange, loadPeerBenchmark } from '@/lib/services/twinBenchmarkRetrieval';

type Row = Record<string, unknown>;

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function parseOr(expr: string): Array<(r: Row) => boolean> {
  return expr.split(',').map((part) => {
    const [col, op, ...rest] = part.split('.');
    const val = rest.join('.');
    if (op === 'is' && val === 'null') return (r: Row) => r[col] === null || r[col] === undefined;
    if (op === 'gt') return (r: Row) => typeof r[col] === 'string' && (r[col] as string) > val;
    throw new Error(`unsupported or-clause ${part}`);
  });
}

function fakeClient(tables: Record<string, Row[]>, opts: { orIsNoOp?: boolean } = {}) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let order: { col: string } | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
        or: (expr: string) => {
          if (!opts.orIsNoOp) {
            const ors = parseOr(expr);
            filters.push((r) => ors.some((f) => f(r)));
          }
          return b;
        },
        order: (c: string) => ((order = { col: c }), b),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (order) rows = [...rows].sort((a, z) => Number(a[order!.col]) - Number(z[order!.col]));
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

const ds = { benchmark_class: 'observed_market', evidence_level: 'official_statistical', is_indicative: true, benchmark_sources: { citation_text: 'Cite', country_code: 'AU', publication_date: '2022-04-28' } };
const value = (id: string, v: number, over: Row = {}): Row => ({ id, metric_definition_id: 'M1', cohort_id: null, statistic_type: 'median', value_numeric: v, is_derived: false, derivation_method: null, effective_to: null, benchmark_datasets: ds, ...over });
const band = (tier: number, over: Row = {}): Row => ({ metric_definition_id: 'M1', country_code: 'AU', life_stage: null, household_type: null, band_label: `b${tier}`, band_tier: tier, lower_bound: 0, upper_bound: 1, explanation: null, evidence_level: 'research_informed', model_version: 'm', effective_to: null, benchmark_sources: null, ...over });

describe('liveWindowFilter', () => {
  it('is "no end date, or an end date after today"', () => {
    expect(liveWindowFilter('2026-10-06')).toBe('effective_to.is.null,effective_to.gt.2026-10-06');
  });
});

const assertSuperseded = async (client: ReturnType<typeof fakeClient>) => {
  const peer = await loadPeerBenchmark(client as never, 'M1', null, 'AU');
  expect(peer?.value, 'NC-F1 named assertion: the superseded figure is not served').toBe(200);
  const bands = await loadHealthyRange(client as never, 'M1', 'AU', 'x', 'single');
  expect(bands?.map((b) => b.bandLabel), 'NC-F1 named assertion: superseded bands are not served').toEqual(['new1', 'new2']);
};

const tables = () => ({
  benchmark_values: [value('new', 200), value('old', 100, { effective_to: YESTERDAY })],
  benchmark_target_ranges: [band(1, { band_label: 'old1', effective_to: YESTERDAY }), band(1, { band_label: 'new1' }), band(2, { band_label: 'new2' })],
});

describe('Twin read path (live window)', () => {
  it('serves the new figure and bands, not the superseded ones', async () => {
    await assertSuperseded(fakeClient(tables()));
  });

  it('still serves every row that has no end date (nothing changes for data that exists today)', async () => {
    const peer = await loadPeerBenchmark(fakeClient({ benchmark_values: [value('a', 5)], benchmark_target_ranges: [] }) as never, 'M1', null, 'AU');
    expect(peer?.value).toBe(5);
    const bands = await loadHealthyRange(fakeClient({ benchmark_values: [], benchmark_target_ranges: [band(1), band(2)] }) as never, 'M1', 'AU', 'x', 'single');
    expect(bands).toHaveLength(2);
  });

  it('a row end-dated TODAY is out (matches the database rule used by the upload), a row ending tomorrow is still served', async () => {
    const peerToday = await loadPeerBenchmark(fakeClient({ benchmark_values: [value('t', 1, { effective_to: TODAY })], benchmark_target_ranges: [] }) as never, 'M1', null, 'AU');
    expect(peerToday).toBeNull();
    const peerTomorrow = await loadPeerBenchmark(fakeClient({ benchmark_values: [value('t', 1, { effective_to: TOMORROW })], benchmark_target_ranges: [] }) as never, 'M1', null, 'AU');
    expect(peerTomorrow?.value).toBe(1);
  });

  it('a metric whose only figure is superseded has no benchmark at all (null, never the old number)', async () => {
    expect(await loadPeerBenchmark(fakeClient({ benchmark_values: [value('old', 100, { effective_to: YESTERDAY })], benchmark_target_ranges: [] }) as never, 'M1', null, 'AU')).toBeNull();
    expect(await loadHealthyRange(fakeClient({ benchmark_values: [], benchmark_target_ranges: [band(1, { effective_to: YESTERDAY })] }) as never, 'M1', 'AU', 'x', 'single')).toBeNull();
  });

  it('NC-F1: with the filter disabled (the code before this change) the SAME assertion goes red', async () => {
    let failure: Error | null = null;
    try {
      await assertSuperseded(fakeClient(tables(), { orIsNoOp: true }));
    } catch (e) {
      failure = e as Error;
    }
    expect(failure, 'the control did not fail: the test cannot detect an unfiltered query').not.toBeNull();
    expect(failure!.name).toBe('AssertionError');
    expect(failure!.message).toContain('NC-F1 named assertion');
  });
});
