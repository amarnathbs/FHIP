// NAV2 Phase B -- the required-window planner, its triggers, its deduplication
// and its use of the EXISTING user-scoped fetch path. Pure planner tests use
// calendar dates computed by hand (and re-checked with Python datetime); service
// tests run against an in-memory database that APPLIES its filters, with a fake
// source adapter that records every request it receives.
//
// Matrix rows: 1, 2, 3, 4, 5 (Stage 1 part), 41-43 (planner side), 46, 47 (planner side).
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  the planner never reaches back to scheme inception on its own: the widest standard spec asks
//          for 1,855 days before the earliest held date, not for 2006;
//   NC-P2  a document that is draft / rejected / quarantined / malware-failed / unresolved / unaccepted
//          creates NO requirement (classified `ignore`; and a user with only such documents has no windows);
//   NC-P3  a non-held scheme is never planned, fetched or written, even with 1,000 other instruments in
//          the database and an override naming one;
//   NC-P4  the same scheme held by two users is ONE window and ONE fetch; the second user finds the
//          history already stored, and no plan or window carries either user's id;
//   NC-P5  deduplicated by instrument and range: identical windows collapse, a re-run after success makes
//          no provider request at all;
//   NC-P6  an override can only move a scheme's required date EARLIER, never later, and never adds a scheme.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createInMemoryDb, type InMemoryDb, type Row } from '../support/inMemorySupabase';
import type { HistoricalNavAdapter, HistoricalNavAdapterResult, HistoricalNavRequest } from '@/lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter';
import type { HydrationAttemptRecord, HydrationWriteRow } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';

let currentDb: InMemoryDb;
vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: async (e: Record<string, unknown>) => {
    currentDb.tables.ii_audit_events.push({ user_id: e.userId, event_type: e.eventType, metadata: e.metadata, created_at: new Date().toISOString() });
    return { error: null };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => { throw new Error('tests pass their own db'); } }));

import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { minimalAnalysisSpec, standardAnalysisSpec, type AnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { classifyTrigger, computeRequiredWindow, consolidateWindows, PLANNER_HISTORY_FLOOR, windowSpanDays, type NonAcceptedSourceState } from '@/lib/engines/nav2/requiredWindowPlanner';
import { handleNav2Trigger, planFetches, planUserNav2Windows, type Nav2RunBatch } from '@/lib/services/investment-intelligence/nav2/windowPlannerService';
import { runUserNavHistoryBatch, type UserNavHistoryRuntime } from '@/lib/services/investment-intelligence/pc6/userNavHistory';

const TODAY = '2026-10-03';
const NOW = '2026-10-03T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------
describe('computeRequiredWindow (spec 5): one consolidated range, buffers from the central policy', () => {
  const base = { instrumentId: 'f3', earliestHeldDate: '2023-01-10', earliestHeldKind: 'earliest_transaction' as const, policy: NAV2_POLICY, today: TODAY };

  it('minimal spec: earliest transaction minus the 10-day buffer; the as-of date is the end (hand: 10-01-2023 minus 10 days = 31-12-2022)', () => {
    const w = computeRequiredWindow({ ...base, spec: minimalAnalysisSpec(TODAY) });
    expect(w.requiredFrom).toBe('2022-12-31');
    expect(w.requiredTo).toBe(TODAY);
    expect(w.drivers.map((d) => d.kind).sort()).toEqual(['earliest_transaction', 'reconstruction_buffer', 'report_as_of']);
    expect(w.policyVersion).toBe('nav2-policy-v1');
  });

  it('standard spec: the widest driver is the 5Y rolling window, 1,855 days before the first endpoint (hand: 10-01-2023 minus 1,855 days = 12-12-2017)', () => {
    const w = computeRequiredWindow({ ...base, spec: standardAnalysisSpec(TODAY, NAV2_POLICY) });
    expect(w.requiredFrom).toBe('2017-12-12');
    expect(w.drivers[0]).toMatchObject({ kind: 'rolling_window', bufferDays: 1855, targetDate: '2023-01-10', from: '2017-12-12' });
    // every rolling horizon contributes its own preceding-data requirement
    const rolling = w.drivers.filter((d) => d.kind === 'rolling_window').map((d) => [d.bufferDays, d.from]);
    expect(rolling).toEqual([[1855, '2017-12-12'], [1125, '2019-12-12'], [380, '2021-12-26'], [210, '2022-06-14'], [110, '2022-09-22'], [45, '2022-11-26']]);
    // SMA200: 199 observations x 1.5 = 299 days (rounded up) + 10 = 309 -> 07-03-2022; EMA50 adds the 20-observation warm-up: 69 -> 104 + 10 = 114 -> 18-09-2022
    expect(w.drivers.find((d) => d.kind === 'moving_average' && d.detail.startsWith('SMA over 200'))?.from).toBe('2022-03-07');
    expect(w.drivers.find((d) => d.kind === 'moving_average' && d.detail.startsWith('EMA over 50'))?.from).toBe('2022-09-18');
  });

  it('NC-P1: bounded, not inception: the standard spec is about 8.8 years of history for this scheme, far from the 2006 floor', () => {
    const w = computeRequiredWindow({ ...base, spec: standardAnalysisSpec(TODAY, NAV2_POLICY) });
    expect(w.requiredFrom > PLANNER_HISTORY_FLOOR).toBe(true);
    expect(windowSpanDays(w)).toBe(3217); // 12-12-2017 to 03-10-2026 (hand: 8 x 365 + 2 leap days + 295 = 3,217)
    expect(windowSpanDays(w)).toBeLessThan(365 * 10);
    // the floor is the hard stop only when the caller explicitly asks for an earlier analysis start
    const early = computeRequiredWindow({ ...base, spec: { ...standardAnalysisSpec(TODAY, NAV2_POLICY), analysisStart: '2010-01-01' } });
    expect(early.requiredFrom).toBe(PLANNER_HISTORY_FLOOR);
  });

  it('a point-to-point period reaches back 10 days before its start, even before the scheme was held (hand: 15-06-2020 minus 10 days = 05-06-2020)', () => {
    const spec: AnalysisSpec = { ...minimalAnalysisSpec(TODAY), pointToPoint: [{ id: '5y', start: '2020-06-15', end: TODAY }] };
    const w = computeRequiredWindow({ ...base, spec });
    expect(w.requiredFrom).toBe('2020-06-05');
    expect(w.drivers[0]).toMatchObject({ kind: 'point_to_point_period', from: '2020-06-05' });
  });

  it('a newly held scheme still gets enough history for the risk measures: 60 returns need 92 days, so the window starts 92 + 10 days before the analysis end (hand: 03-10-2026 minus 92 = 03-07-2026, minus 10 = 23-06-2026)', () => {
    const w = computeRequiredWindow({ ...base, earliestHeldDate: '2026-09-20', spec: { ...minimalAnalysisSpec(TODAY), risk: true } });
    expect(w.requiredFrom).toBe('2026-06-23');
    expect(w.drivers[0].kind).toBe('risk_minimum_span');
  });

  it('requiredTo is never in the future: an as-of date past today is capped at today (no future-dated NAV is ever requested)', () => {
    const w = computeRequiredWindow({ ...base, spec: minimalAnalysisSpec('2026-12-31') });
    expect(w.requiredTo).toBe(TODAY);
  });

  it('an unknown rolling horizon id has no policy requirement and adds nothing', () => {
    const w = computeRequiredWindow({ ...base, spec: { ...minimalAnalysisSpec(TODAY), rollingHorizonIds: ['7Y'] } });
    expect(w.drivers.some((d) => d.kind === 'rolling_window')).toBe(false);
  });

  it('with no held date (a requested report period for a scheme not yet held) only the period and as-of drivers apply', () => {
    const w = computeRequiredWindow({ ...base, earliestHeldDate: null, earliestHeldKind: null, spec: { ...minimalAnalysisSpec(TODAY), pointToPoint: [{ id: '1y', start: '2025-10-03', end: TODAY }] } });
    expect(w.requiredFrom).toBe('2025-09-23');
  });
});

describe('consolidateWindows (spec 12.3): deduplicated by instrument and range, tenancy-free', () => {
  const w = (instrumentId: string, from: string, to: string) => ({ instrumentId, requiredFrom: from, requiredTo: to, drivers: [{ kind: 'earliest_transaction' as const, detail: 'x', targetDate: from, bufferDays: 10, from }], policyVersion: 'nav2-policy-v1' });

  it('NC-P5: five identical windows for one scheme collapse to one; the widest range wins; input order does not matter', () => {
    const a = consolidateWindows([w('f1', '2022-01-01', '2026-10-03'), w('f1', '2022-01-01', '2026-10-03'), w('f1', '2020-05-01', '2026-09-01'), w('f2', '2024-01-01', '2026-10-03'), w('f1', '2022-01-01', '2026-10-03')]);
    const b = consolidateWindows([w('f2', '2024-01-01', '2026-10-03'), w('f1', '2020-05-01', '2026-09-01'), w('f1', '2022-01-01', '2026-10-03')]);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ instrumentId: 'f1', requiredFrom: '2020-05-01', requiredTo: '2026-10-03' });
    expect(a[0].drivers).toHaveLength(2); // identical kind + target + buffer collapse, distinct ones are kept
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('carries no user, household, folio or document identifier anywhere', () => {
    const out = consolidateWindows([w('f1', '2022-01-01', '2026-10-03')]);
    expect(JSON.stringify(out)).not.toMatch(/user|household|folio|document|account/i);
    expect(Object.keys(out[0]).sort()).toEqual(['drivers', 'instrumentId', 'policyVersion', 'requiredFrom', 'requiredTo']);
  });
});

describe('classifyTrigger (spec 4.1)', () => {
  it('the four per-user triggers plan the user\'s held windows', () => {
    for (const kind of ['statement_accepted', 'new_holding', 'report_period_requested', 'analysis_period_changed'] as const) {
      expect(classifyTrigger({ kind }).action, kind).toBe('plan_held_windows');
    }
  });
  it('a NAV correction invalidates only dependents of that scheme and date; a benchmark mapping records a benchmark-history requirement', () => {
    expect(classifyTrigger({ kind: 'nav_correction', instrumentId: 'f1', date: '2025-01-10' })).toMatchObject({ action: 'invalidate_dependents', instrumentId: 'f1', date: '2025-01-10' });
    expect(classifyTrigger({ kind: 'benchmark_mapping_active', benchmarkId: 'bm-1' })).toMatchObject({ action: 'record_benchmark_history_requirement', benchmarkId: 'bm-1' });
  });
  it('NC-P2: a draft, rejected, quarantined, malware-failed, unresolved or unaccepted document creates no requirement', () => {
    const states: NonAcceptedSourceState[] = ['draft', 'rejected', 'quarantined', 'malware_failed', 'unresolved', 'unaccepted'];
    for (const state of states) {
      const a = classifyTrigger({ kind: 'statement_not_accepted', state });
      expect(a.action, state).toBe('ignore');
      expect(a.reason).toContain(state.replace(/_/g, ' '));
    }
    // control: the accepted trigger is the only statement trigger that plans anything
    expect(classifyTrigger({ kind: 'statement_accepted' }).action).toBe('plan_held_windows');
  });
});

// ---------------------------------------------------------------------------
// planFetches: the existing gap, cooldown, fairness and chunking rules
// ---------------------------------------------------------------------------
describe('planFetches reuses the existing gap / cooldown / fair-order / chunk rules', () => {
  const win = (id: string, from: string) => ({ instrumentId: id, requiredFrom: from, requiredTo: TODAY, drivers: [], policyVersion: 'nav2-policy-v1' });
  const cov = (earliest: string | null, floor: string | null = null) => ({ earliestNav: earliest, historyFloor: floor });

  it('covered when stored history reaches the required date; otherwise the gap is [required, earliest stored - 1 day]', () => {
    const plan = planFetches({
      windows: [win('covered', '2022-01-01'), win('gap', '2022-01-01'), win('none', '2022-01-01')],
      coverage: new Map([['covered', cov('2021-06-01')], ['gap', cov('2026-09-21')], ['none', cov(null)]]),
      attempts: new Map(),
      today: TODAY,
      nowIso: NOW,
      budget: 5,
    });
    expect(plan.alreadyCovered).toEqual(['covered']);
    expect(plan.toFetch.map((f) => [f.instrumentId, f.fromDate, f.toDate])).toEqual([['gap', '2022-01-01', '2026-09-20'], ['none', '2022-01-01', TODAY]]);
    expect(plan.toFetch[0].chunkCount).toBe(3); // 1,724 days in windows of at most 730
  });

  it('never asks for dates before a confirmed history floor (a fund younger than the window)', () => {
    const plan = planFetches({ windows: [win('young', '2018-01-01')], coverage: new Map([['young', cov('2026-09-21', '2024-03-01')]]), attempts: new Map(), today: TODAY, nowIso: NOW, budget: 3 });
    expect(plan.toFetch[0]).toMatchObject({ fromDate: '2024-03-01', toDate: '2026-09-20' });
  });

  it('fairness (matrix 43): never-attempted first, then least recently attempted; a failing scheme waits out its cooldown; the budget defers the rest', () => {
    const attempt = (lastAttemptedAt: string, lastOutcome: string, consecutiveFailures: number) => ({ lastAttemptedAt, lastOutcome, consecutiveFailures, attemptsTotal: 1, lastSuccessAt: null });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const plan = planFetches({
      windows: ids.map((id) => win(id, '2022-01-01')),
      coverage: new Map(ids.map((id) => [id, cov('2026-09-21')])),
      attempts: new Map([
        ['a', attempt('2026-10-03T09:00:00.000Z', 'hydrated', 0)],
        ['b', attempt('2026-10-01T09:00:00.000Z', 'hydrated', 0)],
        ['c', attempt('2026-10-03T09:55:00.000Z', 'fetch_failed', 2)], // failed five minutes ago: cooldown (10 minutes)
        // d: never attempted
        ['e', attempt('2026-09-30T09:00:00.000Z', 'partially_hydrated', 0)],
      ]),
      today: TODAY,
      nowIso: NOW,
      budget: 2,
    });
    expect(plan.inCooldown).toEqual(['c']);
    expect(plan.toFetch.map((f) => f.instrumentId)).toEqual(['d', 'e']); // never attempted, then the longest ago
    expect(plan.deferred).toEqual(['b', 'a']);
    // one failing scheme (c) did not take a budget slot from the others
  });
});

// ---------------------------------------------------------------------------
// The service against an in-memory database and a recording fake adapter
// ---------------------------------------------------------------------------
const U1 = 'user-1';
const U2 = 'user-2';
const U3 = 'user-3';

const txn = (id: string, user: string, ins: string, date: string, extra: Row = {}): Row => ({ id, user_id: user, account_id: `acc-${user}`, instrument_id: ins, transaction_date: date, status: 'parsed', source_reference: 'CAMS', ...extra });

function seed(over: Record<string, Row[]> = {}): InMemoryDb {
  currentDb = createInMemoryDb({ strictSchema: true });
  currentDb.reset({
    ii_holding_snapshots: [
      { id: 's1', user_id: U1, instrument_id: 'f3', as_of_date: '2026-09-04' },
      { id: 's2', user_id: U1, instrument_id: 'f4', as_of_date: '2026-09-04' },
      { id: 's3', user_id: U2, instrument_id: 'f3', as_of_date: '2026-09-04' },
    ],
    ii_transactions: [
      txn('t3', U1, 'f3', '2023-01-10'),
      txn('t4', U1, 'f4', '2024-02-20'),
      txn('t3b', U2, 'f3', '2024-06-01'),
      txn('r1', U3, 'f9', '2020-01-01', { status: 'review_required' }), // not an accepted row
      txn('r2', U3, 'f9', '2019-01-01', { status: 'reversed' }),
    ],
    ii_instruments: [
      { id: 'f3', instrument_name: 'Fund F3', instrument_class: 'mutual_fund' },
      { id: 'f4', instrument_name: 'Fund F4', instrument_class: 'mutual_fund' },
      { id: 'f9', instrument_name: 'Fund F9', instrument_class: 'mutual_fund' },
    ],
    ii_scheme_master: [],
    ii_investment_date_inputs: [],
    ii_prices_nav: [
      { instrument_id: 'f3', price_date: '2026-09-21', price: 10 },
      { instrument_id: 'f4', price_date: '2026-09-21', price: 10 },
    ],
    ii_nav_history_floors: [],
    ii_nav_hydration_attempts: [],
    ii_audit_events: [],
    ...over,
  });
  return currentDb;
}

const CODE_BY_ID: Record<string, string> = { f3: '3', f4: '4', f9: '9' };

function runtime(db: InMemoryDb, handler: (req: HistoricalNavRequest) => HistoricalNavAdapterResult = okRows) {
  const requests: HistoricalNavRequest[] = [];
  const adapter: HistoricalNavAdapter = {
    providerKey: 'fake',
    adapterVersion: 'v1',
    async fetchHistory(req) {
      requests.push(req);
      return handler(req);
    },
  };
  const rt: UserNavHistoryRuntime = {
    db: db.client as never,
    adapter,
    deps: {
      isEnabled: async () => ({ enabled: true, reason: null }),
      fetchAdapterIdentifier: async (id: string) => CODE_BY_ID[id] ?? (id.startsWith('bulk-') ? `bulk-code-${id}` : null),
      fetchExistingObservations: async () => new Map(),
      writeRows: async (rows: HydrationWriteRow[]) => {
        for (const r of rows) db.tables.ii_prices_nav.push({ instrument_id: r.instrumentId, price_date: r.priceDate, price: Number(r.price) });
        return { inserted: rows.length, error: null };
      },
      recordHistoryFloor: async () => ({ error: null }),
      recordAttempt: async (rec: HydrationAttemptRecord) => {
        const rows = db.tables.ii_nav_hydration_attempts;
        const i = rows.findIndex((r) => r.instrument_id === rec.instrumentId);
        const row = { instrument_id: rec.instrumentId, last_attempted_at: rec.lastAttemptedAt, last_outcome: rec.lastOutcome, consecutive_failures: rec.consecutiveFailures, attempts_total: rec.attemptsTotal, last_success_at: rec.lastSuccessAt };
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        return { error: null };
      },
    },
  };
  return { rt, requests };
}

const okRows = (req: HistoricalNavRequest): HistoricalNavAdapterResult => ({
  ok: true,
  schemeIdentifier: req.schemeIdentifier,
  providerSchemeName: null,
  coverage: 'unknown',
  observations: [{ date: req.fromDate, nav: '10' }, { date: req.toDate, nav: '11' }],
  provider: { key: 'amfi', adapterVersion: 'v1', requestUrl: 'x', httpStatus: 200, retrievedAt: 'now', rawResponseChecksum: '0123456789abcdef' },
});

function runBatchFor(rt: UserNavHistoryRuntime): Nav2RunBatch {
  return (a) => runUserNavHistoryBatch({ userId: a.userId, today: TODAY, nowIso: NOW, runtime: rt, onlyInstrumentIds: a.onlyInstrumentIds, requiredFromOverrides: a.requiredFromOverrides });
}

/** A modest spec: 1Y rolling + the default boundary rules, so a scheme's window is a few years, not a decade. */
const SPEC: AnalysisSpec = { ...minimalAnalysisSpec(TODAY), rollingHorizonIds: ['1Y'] };

beforeEach(() => {
  seed();
});

describe('planUserNav2Windows: the caller\'s own held schemes only, read-only', () => {
  it('plans exactly the user\'s schemes, each from its own earliest date, and writes nothing', async () => {
    const db = seed();
    const plan = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(plan.windows.map((w) => w.instrumentId)).toEqual(['f3', 'f4']);
    // hand: f3 earliest 10-01-2023 minus the 1Y rolling requirement of 380 days = 26-12-2021; f4 earliest 20-02-2024 minus 380 = 05-02-2023 (2024 is a leap year)
    expect(plan.windows.map((w) => w.requiredFrom)).toEqual(['2021-12-26', '2023-02-05']);
    expect(plan.fetch.toFetch.map((f) => f.instrumentId)).toEqual(['f3', 'f4']);
    expect(plan.requiredFromOverrides.get('f3')).toBe('2021-12-26');
    expect(db.writes).toEqual([]);
  });

  it('NC-P2: a user whose only rows are review-required or reversed has no windows and no fetch', async () => {
    const db = seed();
    const plan = await planUserNav2Windows({ db: db.client as never, userId: U3, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(plan.windows).toEqual([]);
    expect(plan.fetch.toFetch).toEqual([]);
  });
});

describe('handleNav2Trigger: the planned window goes through the existing fetch path (matrix 1)', () => {
  it('first accepted statement for a new scheme: bounded, newest-first fetches for THAT scheme only, from the planned date, then the history is complete', async () => {
    const db = seed();
    const { rt, requests } = runtime(db);
    const out = await handleNav2Trigger({ trigger: { kind: 'statement_accepted' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(rt) });
    if (out.action !== 'plan_held_windows') throw new Error(out.action);
    expect(out.executed).not.toBeNull();
    // only the user's two schemes were asked for, by their own identifiers
    expect(new Set(requests.map((r) => r.schemeIdentifier))).toEqual(new Set(['3', '4']));
    // every request lies inside the planned window and before the NAV already on file
    for (const r of requests) {
      const from = r.schemeIdentifier === '3' ? '2021-12-26' : '2023-02-05';
      expect(r.fromDate >= from).toBe(true);
      expect(r.toDate <= '2026-09-20').toBe(true);
      expect((Date.parse(r.toDate) - Date.parse(r.fromDate)) / 86_400_000).toBeLessThanOrEqual(730); // bounded request width
    }
    const f3 = requests.filter((r) => r.schemeIdentifier === '3').map((r) => r.fromDate).sort();
    expect(f3[0]).toBe('2021-12-26'); // the planned start, not inception
    // after the run the plan is complete
    const again = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(again.fetch.toFetch).toEqual([]);
    expect(again.fetch.alreadyCovered).toEqual(['f3', 'f4']);
  });

  it('NC-P5 / matrix 2: re-accepting the same statement is idempotent: no provider request at all, no new rows', async () => {
    const db = seed();
    const first = runtime(db);
    await handleNav2Trigger({ trigger: { kind: 'statement_accepted' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(first.rt) });
    const rowsAfterFirst = db.tables.ii_prices_nav.length;
    const second = runtime(db);
    const out = await handleNav2Trigger({ trigger: { kind: 'statement_accepted' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(second.rt) });
    if (out.action !== 'plan_held_windows') throw new Error(out.action);
    expect(out.executed).toBeNull(); // nothing to run
    expect(second.requests).toHaveLength(0);
    expect(db.tables.ii_prices_nav.length).toBe(rowsAfterFirst);
  });

  it('NC-P4 / matrix 3: a second user holding the same scheme reuses the stored public history: one window, no fetch, no tenancy in the plan', async () => {
    const db = seed();
    const first = runtime(db);
    await handleNav2Trigger({ trigger: { kind: 'statement_accepted' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(first.rt) });
    const second = runtime(db);
    const out = await handleNav2Trigger({ trigger: { kind: 'new_holding' }, userId: U2, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(second.rt) });
    if (out.action !== 'plan_held_windows') throw new Error(out.action);
    expect(out.plan.windows.map((w) => w.instrumentId)).toEqual(['f3']); // user 2 holds only f3, from 01-06-2024 (a later start than user 1's)
    expect(out.plan.fetch.alreadyCovered).toEqual(['f3']);
    expect(out.plan.fetch.toFetch).toEqual([]);
    expect(second.requests).toHaveLength(0);
    // neither user's id appears anywhere in either plan
    const serialised = JSON.stringify(out) + JSON.stringify(first.requests);
    expect(serialised).not.toContain(U1);
    expect(serialised).not.toContain(U2);
    // and the two users' windows for the same scheme consolidate to ONE
    const p1 = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    const merged = consolidateWindows([...p1.windows, ...out.plan.windows]);
    expect(merged.filter((w) => w.instrumentId === 'f3')).toHaveLength(1);
    expect(merged.find((w) => w.instrumentId === 'f3')?.requiredFrom).toBe('2021-12-26'); // the wider (user 1) range
  });

  it('NC-P2 / matrix 4: a rejected / quarantined statement creates no requirement: the trigger is ignored, no plan, no provider request', async () => {
    const db = seed();
    const { rt, requests } = runtime(db);
    const out = await handleNav2Trigger({ trigger: { kind: 'statement_not_accepted', state: 'rejected' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(rt) });
    expect(out.action).toBe('ignore');
    expect(requests).toHaveLength(0);
    expect(db.writes).toEqual([]);
  });

  it('a per-user trigger with no user named plans nothing', async () => {
    const db = seed();
    const out = await handleNav2Trigger({ trigger: { kind: 'statement_accepted' }, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(out.action).toBe('ignore');
  });

  it('a NAV correction trigger names exactly its scheme and date for invalidation and fetches nothing', async () => {
    const db = seed();
    const { rt, requests } = runtime(db);
    const out = await handleNav2Trigger({ trigger: { kind: 'nav_correction', instrumentId: 'f3', date: '2025-01-10' }, userId: U1, db: db.client as never, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW, runBatch: runBatchFor(rt) });
    expect(out).toMatchObject({ action: 'invalidate_dependents', event: { kind: 'nav_correction', instrumentId: 'f3', date: '2025-01-10' } });
    expect(requests).toHaveLength(0);
  });
});

describe('no full-universe expansion, no non-held scheme (matrix 46, 47 planner side)', () => {
  it('NC-P3: with 1,000 other instruments in the database and an override naming one of them, only the user\'s own schemes are planned, fetched and written', async () => {
    const bulk = Array.from({ length: 1000 }, (_, i) => ({ id: `bulk-${i}`, instrument_name: `Bulk ${i}`, instrument_class: 'mutual_fund' }));
    const db = seed({ ii_instruments: [...(currentDb.tables.ii_instruments as Row[]), ...bulk] });
    const { rt, requests } = runtime(db);
    const priceRowsBefore = db.tables.ii_prices_nav.filter((r) => String(r.instrument_id).startsWith('bulk-')).length;
    const plan = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(plan.windows.map((w) => w.instrumentId)).toEqual(['f3', 'f4']);
    // an override for a scheme the user does not hold is simply not in the candidate set
    const overrides = new Map([...plan.requiredFromOverrides, ['bulk-7', '2006-04-01']]);
    await runUserNavHistoryBatch({ userId: U1, today: TODAY, nowIso: NOW, runtime: rt, requiredFromOverrides: overrides });
    expect(new Set(requests.map((r) => r.schemeIdentifier))).toEqual(new Set(['3', '4']));
    expect(requests.some((r) => r.schemeIdentifier.startsWith('bulk'))).toBe(false);
    expect(db.tables.ii_prices_nav.filter((r) => String(r.instrument_id).startsWith('bulk-')).length).toBe(priceRowsBefore);
  });

  it('NC-P6: an override can only move a scheme\'s required date EARLIER; a later override changes nothing', async () => {
    const db = seed();
    const { rt, requests } = runtime(db);
    // f3's own rule needs 31-12-2022 (earliest 10-01-2023 minus 10 days); the override says 2024-06-01 (later): ignored
    await runUserNavHistoryBatch({ userId: U1, today: TODAY, nowIso: NOW, runtime: rt, onlyInstrumentIds: ['f3'], requiredFromOverrides: new Map([['f3', '2024-06-01']]) });
    const earliest = requests.map((r) => r.fromDate).sort()[0];
    expect(earliest).toBe('2022-12-31');
    // an earlier override widens it
    const db2 = seed();
    const second = runtime(db2);
    await runUserNavHistoryBatch({ userId: U1, today: TODAY, nowIso: NOW, runtime: second.rt, onlyInstrumentIds: ['f3'], requiredFromOverrides: new Map([['f3', '2021-12-26']]) });
    expect(second.requests.map((r) => r.fromDate).sort()[0]).toBe('2021-12-26');
  });

  it('failure isolation (matrix 43): one scheme\'s provider failure does not stop the others in the same pass', async () => {
    const db = seed();
    const { rt } = runtime(db, (req) =>
      req.schemeIdentifier === '3'
        ? { ok: false, schemeIdentifier: req.schemeIdentifier, kind: 'network', detail: 'down', provider: { key: 'amfi', adapterVersion: 'v1', requestUrl: null, httpStatus: null, retrievedAt: 'now' } }
        : okRows(req)
    );
    const plan = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    const result = await runUserNavHistoryBatch({ userId: U1, today: TODAY, nowIso: NOW, runtime: rt, requiredFromOverrides: plan.requiredFromOverrides });
    const by = Object.fromEntries(result.attempted.map((a) => [a.instrumentId, a.outcome]));
    expect(by.f3).toBe('failed');
    expect(by.f4).toBe('fetched');
    // the failing scheme is in cooldown on the next plan; the healthy one is covered
    const next = await planUserNav2Windows({ db: db.client as never, userId: U1, spec: SPEC, policy: NAV2_POLICY, today: TODAY, nowIso: NOW });
    expect(next.fetch.inCooldown).toEqual(['f3']);
    expect(next.fetch.alreadyCovered).toEqual(['f4']);
  });

  it('static guard: the planner and its service never import the brute-force backfill, the scheduled job\'s candidate enumeration, or the benchmark dependency list', () => {
    const files = ['lib/engines/nav2/requiredWindowPlanner.ts', 'lib/engines/nav2/analysisSpec.ts', 'lib/services/investment-intelligence/nav2/windowPlannerService.ts'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/pc6_historical_nav_backfill|fetchAcceptedDependencies|fetchBenchmarkDependencies|userHeldInstrumentsToDependencies|createAdminClient|from ['"].*scripts\//);
      // it never selects from the instrument master by anything but the caller's own ids (that read lives in the existing loader)
      expect(src, f).not.toMatch(/\.from\(['"]ii_instruments['"]\)/);
      expect(src, f).not.toMatch(/\.from\(['"]ii_prices_nav['"]\)/);
    }
    // control: the existing scheduled job DOES enumerate, so the guard pattern is not vacuous
    const job = fs.readFileSync(path.join(process.cwd(), 'lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob.ts'), 'utf8');
    expect(job).toMatch(/fetchAcceptedDependencies/);
  });
});
