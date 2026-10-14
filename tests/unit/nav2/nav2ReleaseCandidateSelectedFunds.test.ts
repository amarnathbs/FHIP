// NAV2 release candidate, blocker B2: the price-history gate and the planner work on the funds the report COVERS, not on every fund held.
//
// A person who holds 30 funds and selects 20 must not wait for the 10 they did not select. Evidence level: UNIT-TESTED against the real gate, the
// real planner and the real service, over an in-memory database that applies every filter for real (a read that forgets its user scope or its
// fund scope returns the wrong rows here too). The DEV behavioural test is scripts/nav2_rc/dev_selected_funds_gate.mjs.
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  30 held funds, 10 of them without history: with NO scope the report is held (the old behaviour, proved so the control means something);
//          scoped to the 20 selected funds it is not held, and the headline counts 20 funds, not 30;
//   NC-R2  one selected fund without history DOES hold the report, and only that fund is named;
//   NC-R3  an id the person does not hold is ignored by the gate (the gate reads only the caller's own funds), it can never be used to read another
//          person's funds, and it neither holds nor releases anything;
//   NC-R4  more than 20 held with no choice yet: the gate is skipped (nothing to wait for until the person chooses), nothing is kicked or written;
//   NC-R5  the planner plans only the selected funds (windows and fetches), and the kick for a report period carries the same ids;
//   NC-R6  the service passes the selection to the gate, the planner and the kick, and pins the selected ids in the stored manifest;
//   NC-R7  the Monthly Report / Performance callers (no scope) are unchanged.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

let currentDb: InMemoryDb;
// the gate's first-hold anchor is an audit event: write it to the in-memory database so the test can count it
vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: async (e: Record<string, unknown>) => {
    currentDb.tables.ii_audit_events.push({ user_id: e.userId, event_type: e.eventType, metadata: e.metadata, created_at: new Date().toISOString() });
    return { error: null };
  },
}));

import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsInput, HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { generateFundAnalyticsReport, type FundAnalyticsDeps } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { planUserNav2Windows } from '@/lib/services/investment-intelligence/nav2/windowPlannerService';
import { checkReportNavHistoryGate } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { createInMemoryDb, type InMemoryDb, type Row } from '../support/inMemorySupabase';
import { buildSeries, pathFromReturns, weekdays } from './support/fixtures';

const USER = 'user-1';
const OTHER = 'user-2';
const NOW = '2026-10-03T10:00:00.000Z';
const AS_OF = '2026-10-03';
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const FUNDS = Array.from({ length: 30 }, (_, i) => i + 1);
const WITH_HISTORY = FUNDS.slice(0, 20); // funds 1..20 have complete history
const WITHOUT_HISTORY = FUNDS.slice(20); // funds 21..30 have none: they would hold an unscoped report

function seed(over: Record<string, Row[]> = {}): InMemoryDb {
  const db = createInMemoryDb();
  currentDb = db;
  db.reset({
    ii_holding_snapshots: FUNDS.map((f) => ({ id: `s-${f}`, user_id: USER, instrument_id: id(f), as_of_date: '2026-09-04' })),
    ii_transactions: FUNDS.map((f) => ({ id: `t-${f}`, user_id: USER, account_id: 'acc', instrument_id: id(f), transaction_date: '2022-03-15', status: 'parsed', source_reference: 'CAMS' })),
    ii_instruments: [
      ...FUNDS.map((f) => ({ id: id(f), instrument_name: `Fund ${String(f).padStart(2, '0')}`, instrument_class: 'mutual_fund' })),
      { id: id(99), instrument_name: 'Someone elses fund', instrument_class: 'mutual_fund' },
    ],
    ii_scheme_master: [],
    ii_investment_date_inputs: [],
    ii_prices_nav: [
      ...WITH_HISTORY.map((f) => ({ instrument_id: id(f), price_date: '2000-01-01', price: 10 })),
      ...WITHOUT_HISTORY.map((f) => ({ instrument_id: id(f), price_date: '2026-09-21', price: 10 })), // starts after the window it needs: a gap
      { instrument_id: id(99), price_date: '2026-09-21', price: 10 },
    ],
    ii_nav_history_floors: [],
    ii_nav_hydration_attempts: [],
    ii_nav_source_coverage_gaps: [],
    ii_audit_events: [],
    ii_reference_job_control: [{ job_key: 'pc6_selective_historical_hydration', enabled: true }],
    // another person holds fund 99 (and has a gap): the caller's scope must never reach it
    ...over,
  });
  db.tables.ii_holding_snapshots.push({ id: 's-other', user_id: OTHER, instrument_id: id(99), as_of_date: '2026-09-04' });
  db.tables.ii_transactions.push({ id: 't-other', user_id: OTHER, account_id: 'acc', instrument_id: id(99), transaction_date: '2022-03-15', status: 'parsed', source_reference: 'CAMS' });
  return db;
}
const gate = (db: InMemoryDb, o: { onlyInstrumentIds?: readonly string[] | null; skipIfMoreHeldThan?: number; kick?: (u: string) => boolean; createAnchor?: boolean } = {}) =>
  checkReportNavHistoryGate({ db: db.client as never, userId: USER, today: AS_OF, nowIso: NOW, createAnchor: o.createAnchor, kick: o.kick, onlyInstrumentIds: o.onlyInstrumentIds, skipIfMoreHeldThan: o.skipIfMoreHeldThan });

describe('NC-R1 / NC-R2: the gate looks only at the funds the report covers', () => {
  it('30 held, 10 without history: unscoped the report is held (the control); scoped to the 20 selected it is NOT held and counts 20 funds', async () => {
    const db = seed();
    const unscoped = await gate(db);
    expect(unscoped).toMatchObject({ hold: true, total: 30, loaded: 20 });
    expect(unscoped.waiting).toHaveLength(10);
    const selected = WITH_HISTORY.map(id);
    const scoped = await gate(db, { onlyInstrumentIds: selected });
    expect(scoped).toMatchObject({ hold: false, total: 20, loaded: 20, headline: null });
    expect(scoped.waiting).toEqual([]);
  });

  it('a selected fund without history holds the report and only that fund is named', async () => {
    const db = seed();
    const selected = [...WITH_HISTORY.slice(0, 19), WITHOUT_HISTORY[0]].map(id);
    const g = await gate(db, { onlyInstrumentIds: selected });
    expect(g).toMatchObject({ hold: true, total: 20, loaded: 19 });
    expect(g.waiting.map((f) => f.instrumentId)).toEqual([id(WITHOUT_HISTORY[0])]);
    expect(g.headline).toBe('Your report will be ready once price history is loaded (19 of 20 funds loaded)');
  });

  it('a hold on a selected fund still starts the window once and kicks the (user-scoped) fetch; an unselected gap alone does not', async () => {
    const db = seed();
    const kick = vi.fn().mockReturnValue(true);
    await gate(db, { onlyInstrumentIds: WITH_HISTORY.map(id), createAnchor: true, kick });
    expect(kick).not.toHaveBeenCalled();
    expect(db.tables.ii_audit_events).toHaveLength(0);
    await gate(db, { onlyInstrumentIds: [id(WITHOUT_HISTORY[0])], createAnchor: true, kick });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(db.tables.ii_audit_events).toHaveLength(1);
  });
});

describe('NC-R3: a fund the person does not hold', () => {
  it('is ignored by the gate: it is not counted, does not hold and does not release; the other person\'s data is not read', async () => {
    const db = seed();
    const g = await gate(db, { onlyInstrumentIds: [...WITH_HISTORY.slice(0, 3).map(id), id(99)] });
    expect(g).toMatchObject({ hold: false, total: 3, loaded: 3 });
    expect(g.funds.map((f) => f.instrumentId)).not.toContain(id(99));
    const only = await gate(db, { onlyInstrumentIds: [id(99)] });
    expect(only).toMatchObject({ hold: false, total: 0 });
  });
});

describe('NC-R4: more than the cap held and no choice yet', () => {
  it('the gate is skipped (skippedForChoice): nothing is held, kicked or written until the person chooses', async () => {
    const db = seed();
    const kick = vi.fn();
    const g = await gate(db, { skipIfMoreHeldThan: 20, createAnchor: true, kick });
    expect(g).toMatchObject({ hold: false, total: 0, skippedForChoice: true });
    expect(kick).not.toHaveBeenCalled();
    expect(db.tables.ii_audit_events).toHaveLength(0);
  });

  it('at or under the cap, or with a choice, the gate runs as normal', async () => {
    const db = seed();
    expect((await gate(db, { skipIfMoreHeldThan: 30 })).skippedForChoice).toBeUndefined();
    expect((await gate(db, { skipIfMoreHeldThan: 20, onlyInstrumentIds: WITH_HISTORY.map(id) })).skippedForChoice).toBeUndefined();
  });
});

describe('NC-R7: callers that pass no scope are unchanged', () => {
  it('the Monthly Report / Performance gate still waits for every fund held', async () => {
    const db = seed();
    const g = await checkReportNavHistoryGate({ db: db.client as never, userId: USER, today: AS_OF, nowIso: NOW });
    expect(g).toMatchObject({ hold: true, total: 30, loaded: 20 });
    expect(g.skippedForChoice).toBeUndefined();
  });
});

describe('NC-R5: the planner plans only the selected funds', () => {
  const spec = reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held');
  it('windows and fetches cover exactly the selected funds; a fund outside the selection is never planned', async () => {
    const db = seed();
    const all = await planUserNav2Windows({ db: db.client as never, userId: USER, spec, policy: NAV2_POLICY, today: AS_OF, nowIso: NOW });
    expect(all.windows).toHaveLength(30);
    const selected = [...WITH_HISTORY.slice(0, 10), ...WITHOUT_HISTORY.slice(0, 2)].map(id);
    const scoped = await planUserNav2Windows({ db: db.client as never, userId: USER, spec, policy: NAV2_POLICY, today: AS_OF, nowIso: NOW, onlyInstrumentIds: selected });
    expect(scoped.windows.map((w) => w.instrumentId).sort()).toEqual([...selected].sort());
    expect(scoped.fetch.toFetch.map((f) => f.instrumentId).every((x) => selected.includes(x))).toBe(true);
    expect([...scoped.requiredFromOverrides.keys()].every((x) => selected.includes(x))).toBe(true);
    expect(scoped.windows.map((w) => w.instrumentId)).not.toContain(id(WITHOUT_HISTORY[5]));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------------------
const DATES = weekdays('2025-06-02', 260);
const navsFor = (seedN: number): number[] => pathFromReturns(100, Array.from({ length: DATES.length - 1 }, (_, i) => 0.0004 + 0.01 * Math.sin(i * 0.37 + seedN) * Math.cos(i * 0.11 + seedN * 2)));
function scheme(i: number): HeldSchemeInput {
  const iid = id(i);
  const name = `Fund ${String(i).padStart(2, '0')}`;
  return { instrumentId: iid, schemeName: name, planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap', series: buildSeries(DATES, navsFor(i), { identity: { instrumentId: iid, schemeName: name }, asOf: AS_OF }), benchmarks: [], investor: null, firstHeldDate: '2025-07-01' };
}
const inputFor = (schemes: HeldSchemeInput[], heldFundCount: number): FundAnalyticsInput => ({
  asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null, schemes,
  scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
  selection: { basis: 'chosen', heldFundCount, chosenInstrumentIds: schemes.map((s) => s.instrumentId), max: 20 },
});

describe('NC-R6: the service (30 held, 20 selected)', () => {
  it('passes the selection to the gate, the planner and the kick; the report is NOT held by the 10 unselected funds; the selected ids are pinned in the stored manifest', async () => {
    const db = seed({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [] });
    const selected = WITH_HISTORY.map(id);
    const gateSeen: unknown[] = [];
    const planSeen: unknown[] = [];
    const kickSeen: unknown[] = [];
    const deps: Partial<FundAnalyticsDeps> = {
      isFlagOn: async () => true,
      isPremium: async () => true,
      // the REAL gate over the in-memory database (the 10 unselected funds have no history)
      gate: async (a) => {
        gateSeen.push(a.onlyInstrumentIds);
        return checkReportNavHistoryGate({ db: a.admin as never, userId: a.userId, today: a.today, nowIso: NOW, createAnchor: true, kick: () => true, onlyInstrumentIds: a.onlyInstrumentIds, skipIfMoreHeldThan: a.skipIfMoreHeldThan });
      },
      plannerOn: async () => true,
      planPeriod: async (a) => {
        planSeen.push(a.onlyInstrumentIds);
        return planUserNav2Windows({ db: a.admin as never, userId: a.userId, spec: reportAnalysisSpec(a.today, NAV2_POLICY, a.period), policy: NAV2_POLICY, today: a.today, nowIso: NOW, onlyInstrumentIds: a.onlyInstrumentIds });
      },
      kickPeriod: (_u, _p, ids) => {
        kickSeen.push(ids);
        return true;
      },
      fetchingEnabled: async () => true,
      load: vi.fn(async () => ({ input: inputFor(WITH_HISTORY.map(scheme), 30), warnings: [], riskFreeUnavailableReason: null })),
      nowIso: () => NOW,
      nowMs: () => 0,
    };
    // a cold report of 20 funds may be prepared in steps (the 18 s engine admission budget at 1 s per uncached fund): ask again until it is issued
    let r = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', fundIds: selected, asOfDate: AS_OF, deps });
    for (let i = 0; i < 3 && r.status === 'in_steps'; i++) r = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', fundIds: selected, asOfDate: AS_OF, deps });
    expect(r.status).toBe('ready');
    expect(gateSeen.length).toBeGreaterThanOrEqual(1);
    expect(gateSeen.every((x) => JSON.stringify(x) === JSON.stringify(selected))).toBe(true);
    expect(planSeen.length).toBeGreaterThanOrEqual(1);
    expect(planSeen.every((x) => JSON.stringify(x) === JSON.stringify(selected))).toBe(true);
    expect(kickSeen).toEqual([]); // the selected funds needed no fetch, so no kick was started
    const stored = db.tables.nav2_fund_analytics_reports;
    expect(stored).toHaveLength(1);
    const manifest = stored[0].manifest_json as { selection: { chosenInstrumentIds: string[]; heldFundCount: number } };
    expect(manifest.selection.chosenInstrumentIds).toEqual([...selected].sort());
    expect(manifest.selection.heldFundCount).toBe(30);
  });

  it('when a SELECTED fund is missing history the report is held (202 path) and the kick carries only the selected ids', async () => {
    const db = seed({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [] });
    const selected = [...WITH_HISTORY.slice(0, 5), WITHOUT_HISTORY[0]].map(id);
    const load = vi.fn();
    const kicked: unknown[] = [];
    const deps: Partial<FundAnalyticsDeps> = {
      isFlagOn: async () => true,
      isPremium: async () => true,
      gate: async (a) => checkReportNavHistoryGate({ db: a.admin as never, userId: a.userId, today: a.today, nowIso: NOW, createAnchor: true, kick: (u) => { kicked.push(u); return true; }, onlyInstrumentIds: a.onlyInstrumentIds }),
      load: load as never,
      nowIso: () => NOW,
      nowMs: () => 0,
    };
    const r = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', fundIds: selected, asOfDate: AS_OF, deps });
    expect(r.status).toBe('preparing');
    if (r.status === 'preparing') expect(r.waiting.waitingFunds).toEqual(['Fund 21']);
    expect(load).not.toHaveBeenCalled();
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(0);
    expect(kicked).toEqual([USER]);
  });

  it('30 held and NO choice: the answer is the choice (select_funds), not "preparing" for the 10 funds without history', async () => {
    const db = seed({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [] });
    const choice = { candidates: FUNDS.map((f) => ({ instrumentId: id(f), schemeName: `Fund ${f}`, currentValue: 1000 - f })), max: 20, suggestedIds: WITH_HISTORY.map(id) };
    const deps: Partial<FundAnalyticsDeps> = {
      isFlagOn: async () => true,
      isPremium: async () => true,
      gate: async (a) => checkReportNavHistoryGate({ db: a.admin as never, userId: a.userId, today: a.today, nowIso: NOW, createAnchor: true, kick: () => true, onlyInstrumentIds: a.onlyInstrumentIds, skipIfMoreHeldThan: a.skipIfMoreHeldThan }),
      load: vi.fn(async () => ({ input: null, warnings: [], riskFreeUnavailableReason: null, selectionProblem: 'needed' as const, choice })),
      nowIso: () => NOW,
      nowMs: () => 0,
    };
    const r = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', asOfDate: AS_OF, deps });
    expect(r.status).toBe('select_funds');
    expect(db.tables.ii_audit_events).toHaveLength(0); // no hold was started
  });

  it('a foreign instrument id in the choice is ONE plain refusal from the loader, never a probe of another person\'s funds', async () => {
    const db = seed({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [] });
    const deps: Partial<FundAnalyticsDeps> = {
      isFlagOn: async () => true,
      isPremium: async () => true,
      gate: async (a) => checkReportNavHistoryGate({ db: a.admin as never, userId: a.userId, today: a.today, nowIso: NOW, onlyInstrumentIds: a.onlyInstrumentIds }),
      load: vi.fn(async () => ({ input: null, warnings: [], riskFreeUnavailableReason: null, selectionProblem: 'invalid' as const })),
      nowIso: () => NOW,
      nowMs: () => 0,
    };
    const r = await generateFundAnalyticsReport({ userId: USER, sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', fundIds: [id(1), id(99)], asOfDate: AS_OF, deps });
    expect(r).toEqual({ status: 'invalid_selection', message: 'Choose between 1 and 20 of the funds you hold.' });
    expect(db.tables.nav2_fund_analytics_reports).toHaveLength(0);
  });
});
