// NAV2 Stage 2 -- generate / list / read the Fund analytics report (service level, in-memory database).
//
// Matrix: Stage 2 rows S2-01 (a report is a pinned, versioned output with a dependency manifest), S2-03 (Premium only, explicit
// refusal, fails closed), S2-04 (switch off = nothing happens, nothing is deleted), S2-05 (shared cache reuse is exact), S2-06
// (another user's report is never returned), S2-21 / S2-22 (the planner step, only with its switch on).
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  the switch is OFF unless the job-control row exists AND is enabled (missing row, read error = OFF);
//   NC-S2  a free user is refused before anything is loaded or written;
//   NC-S3  a held price-history gate stops generation before the loader runs and before anything is written;
//   NC-S4  a second generation is a NEW version that supersedes the first; no row is ever updated (immutable);
//   NC-S5  a cache hit yields byte-identical report JSON to a computed one (cache correctness), and a changed
//          input (different NAV checksum) is a different key (a miss);
//   NC-S6  another user's report id returns null, as does a list for another user.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsInput, HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { generateFundAnalyticsReport, getFundAnalyticsReport, listFundAnalyticsReports, parsePeriodChoice, type FundAnalyticsDeps } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { isNav2FlagOn, NAV2_JOB_KEYS } from '@/lib/services/investment-intelligence/nav2/nav2Flags';
import type { ReportNavGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { buildSeries, pathFromReturns, weekdays } from './support/fixtures';

const AS_OF = '2026-10-02';
const DATES = weekdays('2024-10-01', 520);
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const USER = 'user-1';

function navs(seed: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < DATES.length - 1; i++) r.push(0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2));
  return pathFromReturns(100, r);
}

function scheme(id: string, name: string, seed: number): HeldSchemeInput {
  return {
    instrumentId: id,
    schemeName: name,
    planType: 'direct',
    optionType: 'growth',
    category: 'flexi_cap',
    categoryLabel: 'Flexi Cap',
    series: buildSeries(DATES, navs(seed), { identity: { instrumentId: id, schemeName: name }, asOf: AS_OF }),
    benchmarks: [],
    investor: null,
    firstHeldDate: '2025-03-03',
  };
}

const input = (schemes: HeldSchemeInput[]): FundAnalyticsInput => ({
  asOfDate: AS_OF,
  displayCurrency: 'INR',
  policy: NAV2_POLICY,
  spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'),
  periodChoice: 'since_first_held',
  riskFree: null,
  schemes,
  scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
});

const openGate: ReportNavGate = { hold: false, funds: [], total: 2, loaded: 2, waiting: [], unavailable: [], heldSince: null, headline: null, disclosures: [] };
const heldGate: ReportNavGate = { ...openGate, hold: true, loaded: 1, headline: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)' };

function setup(over: Partial<FundAnalyticsDeps> = {}, schemes: HeldSchemeInput[] = [scheme(ID_A, 'Alpha Fund', 1), scheme(ID_B, 'Beta Fund', 2)]) {
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [], ii_reference_job_control: [] });
  const load = vi.fn(async () => ({ input: input(schemes), warnings: [], riskFreeUnavailableReason: null }));
  const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate, load, nowIso: () => '2026-10-02T06:00:00.000Z', ...over };
  const call = (periodChoice?: unknown) =>
    generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice, asOfDate: AS_OF, deps });
  return { db, load, call };
}

describe('the feature switch (NC-S1)', () => {
  it('is OFF when the row is missing, disabled, or unreadable; ON only when the row is enabled', async () => {
    const db = createInMemoryDb({ strictSchema: true });
    db.reset({ ii_reference_job_control: [] });
    expect(await isNav2FlagOn(db.client as unknown as SupabaseClient, NAV2_JOB_KEYS.fundAnalytics)).toBe(false);
    db.reset({ ii_reference_job_control: [{ job_key: NAV2_JOB_KEYS.fundAnalytics, enabled: false }] });
    expect(await isNav2FlagOn(db.client as unknown as SupabaseClient, NAV2_JOB_KEYS.fundAnalytics)).toBe(false);
    db.reset({ ii_reference_job_control: [{ job_key: NAV2_JOB_KEYS.fundAnalytics, enabled: true }] });
    expect(await isNav2FlagOn(db.client as unknown as SupabaseClient, NAV2_JOB_KEYS.fundAnalytics)).toBe(true);
    const errored = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: { message: 'permission denied' } }) }) }) }) } as unknown as SupabaseClient;
    expect(await isNav2FlagOn(errored, NAV2_JOB_KEYS.fundAnalytics)).toBe(false); // a read error is OFF even if data came back
    const broken = { from: () => { throw new Error('relation does not exist'); } } as unknown as SupabaseClient;
    expect(await isNav2FlagOn(broken, NAV2_JOB_KEYS.fundAnalytics)).toBe(false);
  });

  it('switch off: nothing is loaded, written or deleted (matrix 43)', async () => {
    const { db, load, call } = setup({ isFlagOn: async () => false });
    const r = await call();
    expect(r.status).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

describe('refusals happen before any work (NC-S2, NC-S3)', () => {
  it('a free user is refused with an explicit Premium message, loading and writing nothing', async () => {
    const { db, load, call } = setup({ isPremium: async () => false });
    const r = await call();
    expect(r).toMatchObject({ status: 'forbidden', message: expect.stringMatching(/Premium/) });
    expect(load).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('a held price-history gate answers preparing and stops: no load, no write', async () => {
    const { db, load, call } = setup({ gate: async () => heldGate });
    const r = await call();
    expect(r.status).toBe('preparing');
    if (r.status === 'preparing') expect(r.waiting.waiting).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('a household with no covered fund gets a plain message and no stored report', async () => {
    const { db, call } = setup({}, []);
    const r = await call();
    expect(r.status).toBe('no_funds');
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(0);
  });
});

describe('generation, versioning and the pinned dependency manifest (NC-S4, matrix 38)', () => {
  it('stores version 1 with one dependency row per fund, then version 2 superseding it; nothing is ever updated', async () => {
    const { db, call } = setup();
    const first = await call('3y');
    expect(first.status).toBe('ready');
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(1);
    const row1 = db.tables.nav2_fund_analytics_reports[0] as Record<string, unknown>;
    expect(row1).toMatchObject({ user_id: USER, version_number: 1, supersedes_report_id: null, scheme_count: 2, reporting_currency: 'INR', policy_version: NAV2_POLICY.version });
    expect(String(row1.manifest_checksum)).toMatch(/^[0-9a-f]{64}$/);
    expect(db.tables.nav2_report_nav_dependencies.map((d) => d.instrument_id).sort()).toEqual([ID_A, ID_B]);
    for (const d of db.tables.nav2_report_nav_dependencies) expect(d.report_id).toBe(row1.id);

    const second = await call('3y');
    expect(second.status).toBe('ready');
    if (second.status === 'ready') expect(second.report.versionNumber).toBe(2);
    const row2 = db.tables.nav2_fund_analytics_reports[1] as Record<string, unknown>;
    expect(row2).toMatchObject({ version_number: 2, supersedes_report_id: row1.id });
    expect(db.writes.filter((w) => w.kind === 'update' || w.kind === 'delete')).toEqual([]);
  });

  it('the stored report carries the period the user chose, and an unrecognised period falls back to the default', async () => {
    expect(parsePeriodChoice('5y')).toBe('5y');
    expect(parsePeriodChoice('forever')).toBe('since_first_held');
    expect(parsePeriodChoice(undefined)).toBe('since_first_held');
  });
});

describe('shared cache reuse is exact (NC-S5, matrix 44)', () => {
  it('the second run is served from the cache and the stored report JSON is byte-identical', async () => {
    const { db, call } = setup();
    const first = await call();
    const second = await call();
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('ready expected');
    expect(first.cache).toEqual({ hits: 0, computed: 2, stored: 2 });
    expect(second.cache).toEqual({ hits: 2, computed: 0, stored: 0 });
    const [r1, r2] = db.tables.nav2_fund_analytics_reports as Array<{ report_json: unknown; manifest_checksum: string }>;
    expect(JSON.stringify(r2.report_json)).toBe(JSON.stringify(r1.report_json));
    expect(r2.manifest_checksum).toBe(r1.manifest_checksum);
    expect(db.tables.nav2_result_cache).toHaveLength(2);
    for (const c of db.tables.nav2_result_cache) expect(c.scope_hash).toBeNull(); // public-data results carry no user scope
  });

  it('a changed NAV series is a different key: a miss, never a stale hit', async () => {
    const a1 = [scheme(ID_A, 'Alpha Fund', 1)];
    const a2 = [scheme(ID_A, 'Alpha Fund', 7)];
    const { db, call } = setup({}, a1);
    await call();
    const deps2 = setup({}, a2);
    deps2.db.reset({ ...db.tables });
    const r = await deps2.call();
    if (r.status !== 'ready') throw new Error('ready expected');
    expect(r.cache.hits).toBe(0);
    expect(r.cache.computed).toBe(1);
  });

  it('an invalidated entry is never read', async () => {
    const { db, call } = setup();
    await call();
    for (const c of db.tables.nav2_result_cache) c.invalidated_at = '2026-10-02T07:00:00.000Z';
    const r = await call();
    if (r.status !== 'ready') throw new Error('ready expected');
    expect(r.cache.hits).toBe(0);
    expect(r.cache.computed).toBe(2);
  });
});

describe('own reports only (NC-S6, matrix 46)', () => {
  it('list and get are filtered to the caller; another user\'s id returns null', async () => {
    const { db, call } = setup();
    await call();
    const id = String((db.tables.nav2_fund_analytics_reports[0] as { id: string }).id);
    expect(await getFundAnalyticsReport(db.client as never, 'someone-else', id)).toBeNull();
    expect(await listFundAnalyticsReports(db.client as never, 'someone-else')).toEqual([]);
    const mine = await getFundAnalyticsReport(db.client as never, USER, id);
    expect(mine?.summary.versionNumber).toBe(1);
    expect(mine?.report.schemes).toHaveLength(2);
    expect((await listFundAnalyticsReports(db.client as never, USER)).map((r) => r.versionNumber)).toEqual([1]);
  });
});

describe('the NAV2 planner step (only with nav2_trigger_planner ON) (NC-S7)', () => {
  const plan = (toFetch: string[], over: Record<string, unknown> = {}) => ({ windows: [{ instrumentId: ID_A }, { instrumentId: ID_B }], fetch: { toFetch: toFetch.map((instrumentId) => ({ instrumentId, fromDate: '2020-01-01', toDate: AS_OF, chunkCount: 3 })), alreadyCovered: [], inCooldown: [], deferred: [], ...over }, requiredFromOverrides: new Map(), policyVersion: NAV2_POLICY.version }) as never;

  it('switch OFF: the planner is never consulted and generation proceeds exactly as before', async () => {
    const planPeriod = vi.fn(async () => plan([ID_A]));
    const kickPeriod = vi.fn(() => true);
    const { call, load } = setup({ plannerOn: async () => false, planPeriod, kickPeriod });
    expect((await call()).status).toBe('ready');
    expect(planPeriod).not.toHaveBeenCalled();
    expect(kickPeriod).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalled();
  });

  it('switch ON with missing history that could be fetched: kicks the fetch, answers preparing, and loads and writes nothing', async () => {
    const kickPeriod = vi.fn(() => true);
    const { db, call, load } = setup({ plannerOn: async () => true, planPeriod: async () => plan([ID_A]), kickPeriod, fetchingEnabled: async () => true });
    db.tables.ii_instruments = [{ id: ID_A, instrument_name: 'Alpha Fund' }];
    const r = await call('5y');
    expect(r.status).toBe('preparing');
    if (r.status === 'preparing') {
      expect(r.waiting).toMatchObject({ waiting: true, total: 2, waitingFunds: ['Alpha Fund'] });
      expect(r.message).toMatch(/period you chose/);
    }
    expect(kickPeriod).toHaveBeenCalledWith(USER, '5y');
    expect(load).not.toHaveBeenCalled();
    expect(db.writes.filter((w) => w.table === 'nav2_fund_analytics_reports')).toEqual([]);
  });

  it('NC-S8 (Stage 3 finding): planner ON but the NAV fetch kill switch is OFF: the report is NOT held (the fetch can never run and leaves no attempt for a cooldown), it proceeds and nothing is kicked', async () => {
    const kickPeriod = vi.fn(() => true);
    const { db, call } = setup({ plannerOn: async () => true, planPeriod: async () => plan([ID_A]), kickPeriod });
    db.tables.ii_reference_job_control = [{ job_key: 'pc6_selective_historical_hydration', enabled: false }];
    expect((await call()).status).toBe('ready');
    expect(kickPeriod).not.toHaveBeenCalled();
    // control: the same situation with the switch ON holds and kicks, so the test can tell the two apart
    const on = setup({ plannerOn: async () => true, planPeriod: async () => plan([ID_A]), kickPeriod });
    on.db.tables.ii_reference_job_control = [{ job_key: 'pc6_selective_historical_hydration', enabled: true }];
    on.db.tables.ii_instruments = [{ id: ID_A, instrument_name: 'Alpha Fund' }];
    expect((await on.call()).status).toBe('preparing');
    expect(kickPeriod).toHaveBeenCalledTimes(1);
    // a missing row or an unreadable switch is OFF as well
    const missing = setup({ plannerOn: async () => true, planPeriod: async () => plan([ID_A]), kickPeriod });
    expect((await missing.call()).status).toBe('ready');
  });

  it('switch ON but nothing to fetch (covered, in cooldown or deferred-only): generation proceeds', async () => {
    const kickPeriod = vi.fn(() => true);
    const { call } = setup({ plannerOn: async () => true, planPeriod: async () => plan([], { inCooldown: [ID_A] }), kickPeriod });
    expect((await call()).status).toBe('ready');
    expect(kickPeriod).not.toHaveBeenCalled();
  });

  it('NC-S7: a fetch that could NOT be scheduled never holds the report (it proceeds, honestly labelled), and a planner failure never blocks it', async () => {
    const a = setup({ plannerOn: async () => true, planPeriod: async () => plan([ID_A]), kickPeriod: () => false });
    expect((await a.call()).status).toBe('ready');
    const b = setup({ plannerOn: async () => true, planPeriod: async () => { throw new Error('planner exploded'); }, kickPeriod: () => true });
    expect((await b.call()).status).toBe('ready');
  });
});

describe('simultaneous generations for one user (NC-S9, Stage 3 finding: 4 of 6 concurrent requests answered 500)', () => {
  // Several generations read "latest version" at the same moment and all insert the same next number: the unique key refuses all but one.
  // The loser must read again and take the following number; a single retry only rescued the second racer.
  function racing(failures: number) {
    const { db, load } = setup();
    let inserts = 0;
    const wrapped = {
      from: (table: string) => {
        const real = (db.client as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        if (table !== 'nav2_fund_analytics_reports') return real;
        return new Proxy(real, {
          get: (target, prop) => {
            if (prop !== 'insert') return target[prop as string];
            return (row: unknown) => {
              inserts++;
              if (inserts <= failures) return { select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }) }) };
              return (target.insert as (r: unknown) => unknown)(row);
            };
          },
        });
      },
    } as unknown as SupabaseClient;
    const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate, load, nowIso: () => '2026-10-02T06:00:00.000Z' };
    const call = () => generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: wrapped, asOfDate: AS_OF, deps });
    return { db, call, attempts: () => inserts };
  }

  it('a generation that loses the version race three times in a row still stores a report (it took the next free number)', async () => {
    const { db, call, attempts } = racing(3);
    const r = await call();
    expect(r.status).toBe('ready');
    expect(attempts()).toBe(4);
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(1);
  });

  it('a generation that can never get a version stops after a bounded number of attempts with the typed failure, never loops', async () => {
    const { call, attempts } = racing(1000);
    await expect(call()).rejects.toThrow(/could not be saved/);
    expect(attempts()).toBeLessThan(20);
  });
});
