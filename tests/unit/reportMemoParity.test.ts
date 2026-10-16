/**
 * Result parity and round-trip reduction for the request-scoped memo (16-10-2026).
 *
 * The REAL loaders (loadDashboard -> loadDashboardContext -> buildCanonicalFinancialSnapshot) run against the golden
 * pair household (the WP-03 oracle: gross 9,000 / net 7,000 a month, spending 3,100, cash 12,000). Inside a scope the
 * Score, DNA, Resilience, Goals, Forecast and Recommendation loaders all ask for the dashboard; before the change each
 * built its own (24 snapshots / 20 dashboard contexts for ONE report, measured on DEV).
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-P1  with the kill switch ON (REPORT_REQUEST_MEMO=off) the same N loads cost N times the reads: the test would
 *          fail if the memo were silently inert.
 *   NC-P2  OUTSIDE a scope two loads still cost two times the reads and see changed data (nothing leaks between callers).
 *   NC-P3  the golden figures are the hand-computed oracle values, not "whatever the code returned".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDashboard } from '@/lib/services/dashboardData';
import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { runWithRequestMemo } from '@/lib/services/requestMemo';
import { makeFakeSupabase } from './readModels/helpers/fakeSupabase';
import { USER } from './readModels/helpers/fixtures';
import { householdM } from './readModels/helpers/goldenPair';

afterEach(() => {
  delete process.env.REPORT_REQUEST_MEMO;
  vi.restoreAllMocks();
});

const LOADS = 6;

async function loadMany(client: unknown) {
  return Promise.all(Array.from({ length: LOADS }, () => loadDashboard(USER, client as never)));
}

describe('request memo: same figures, far fewer reads', () => {
  it('a scope computes the dashboard once; every caller gets the identical (oracle) figures', async () => {
    const single = makeFakeSupabase(householdM());
    const baseline = await loadDashboard(USER, single.client as never);
    const baselineReads = single.requests.length;

    const fake = makeFakeSupabase(householdM());
    const many = await runWithRequestMemo(() => loadMany(fake.client));
    expect(many).toHaveLength(LOADS);
    for (const d of many) expect(d).toEqual(baseline); // parity with a single, un-memoised load
    expect(fake.requests.length).toBe(baselineReads); // LOADS callers, ONE load's worth of reads

    // NC-P3: and those figures are the hand-computed oracle, not merely self-consistent.
    expect(baseline.grossMonthlyIncome).toBe(9000);
    expect(baseline.netMonthlyIncome).toBe(7000);
    expect(baseline.totalMonthlyExpenses).toBe(3100);
    expect(baseline.essentialMonthlyExpenses).toBe(2800);
  });

  it('NC-P1: with the kill switch on, the same calls cost LOADS times the reads', async () => {
    const single = makeFakeSupabase(householdM());
    await loadDashboard(USER, single.client as never);
    const oneLoad = single.requests.length;

    process.env.REPORT_REQUEST_MEMO = 'off';
    const fake = makeFakeSupabase(householdM());
    await runWithRequestMemo(() => loadMany(fake.client));
    expect(fake.requests.length).toBe(oneLoad * LOADS);
  });

  it('NC-P2: outside a scope nothing is shared (two loads, two sets of reads, changed data is seen)', async () => {
    const tables = householdM();
    const fake = makeFakeSupabase(tables);
    const first = await loadDashboard(USER, fake.client as never);
    const afterFirst = fake.requests.length;
    tables.income_sources[0].net_amount = 5000;
    const second = await loadDashboard(USER, fake.client as never);
    expect(fake.requests.length).toBe(afterFirst * 2);
    expect(first.netMonthlyIncome).toBe(7000);
    expect(second.netMonthlyIncome).toBe(5000);
  });

  it('the canonical snapshot is shared inside a scope and not shared when the caller pins its own window', async () => {
    const fake = makeFakeSupabase(householdM());
    await runWithRequestMemo(async () => {
      const a = await buildCanonicalFinancialSnapshot(USER, { client: fake.client as never });
      const reads = fake.requests.length;
      const b = await buildCanonicalFinancialSnapshot(USER, { client: fake.client as never });
      expect(fake.requests.length).toBe(reads);
      expect(b).toEqual(a);
      if (b.status === 'ok') b.userId = 'tampered';
      const c = await buildCanonicalFinancialSnapshot(USER, { client: fake.client as never });
      expect(c.status === 'ok' && c.userId).toBe(USER); // a caller's edit never reaches the next caller
      await buildCanonicalFinancialSnapshot(USER, { client: fake.client as never, now: new Date('2026-09-01T00:00:00Z') });
      expect(fake.requests.length).toBeGreaterThan(reads); // a pinned clock is never served from the shared entry
    });
  });
});
