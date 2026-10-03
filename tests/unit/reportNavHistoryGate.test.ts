// PO decision 2026-10-03: the Monthly Report generates ONLY after the missing
// price history of the user's held funds has been fetched; a permanently
// missing source never traps the user (bounded window, then the fund is named
// as "could not be loaded"). Fake data throughout; no network.
//
// NAMED NEGATIVE CONTROLS
//   NC-G1  OLD behaviour (generate immediately, "not available" cells while history
//          loads) is reproduced via the seam the old code effectively had (no
//          gate) and shown to differ from the gated behaviour.
//   NC-G2  no path bypasses the gate: generateReport is the single builder.
//   NC-G3  never forever: every reason releases, with the fund named.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';

let currentDb: InMemoryDb;
let auditClock: string | null = null; // lets a test say what time an audit event is stamped with
vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: async (e: Record<string, unknown>) => {
    currentDb.tables.ii_audit_events.push({ user_id: e.userId, event_type: e.eventType, metadata: e.metadata, created_at: auditClock ?? new Date().toISOString() });
    return { error: null };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => currentDb.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => currentDb.client }));

const resolveReportSourceData = vi.fn();
vi.mock('@/lib/services/reportSnapshotResolver', () => ({
  resolveReportSourceData: (...a: unknown[]) => resolveReportSourceData(...a),
  buildEligibilityInput: () => ({}),
  isEligibleForOfficialMonthlyReport: () => ({ eligible: true, reason: null }),
  loadReportInputsLastChangedAt: async () => null,
}));
const builtSections = () => [
  { sectionCode: 'executive_summary', sectionTitle: 'Summary', displayOrder: 1, sectionStatus: 'included', sectionData: {}, narrativeText: 'Summary text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
  { sectionCode: 'investment_performance', sectionTitle: 'Performance', displayOrder: 30, sectionStatus: 'included', sectionData: {}, narrativeText: 'Performance text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
  { sectionCode: 'india_mf_investment_report', sectionTitle: 'MF report', displayOrder: 33, sectionStatus: 'included', sectionData: { report: {} }, narrativeText: 'MF text.', chartData: null, sourceReferences: {}, confidenceLevel: null, limitationText: null },
];
vi.mock('@/lib/engines/reportSections', () => ({ buildReportSections: () => builtSections() }));
vi.mock('@/lib/services/dashboardData', () => ({ getFxRateAudInr: async () => 60 }));
vi.mock('@/lib/services/investment-intelligence/pc6/reportNavDependencyWriter', () => ({ writeReportNavDependencyManifest: async () => undefined }));
const kickUserNavHistory = vi.fn().mockReturnValue(true);
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: (...a: unknown[]) => kickUserNavHistory(...a) }));

import {
  REPORT_NAV_ANCHOR_KIND,
  REPORT_NAV_ANCHOR_MAX_AGE_MINUTES,
  REPORT_NAV_MAX_FAILED_ATTEMPTS,
  REPORT_NAV_RETRY_WINDOW_MINUTES,
  applyNavDisclosures,
  checkReportNavHistoryGate,
  evaluateReportNavGate,
  heldHeadline,
  unavailableDisclosure,
  type GateSchemeInput,
} from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';

const NOW = '2026-10-03T10:00:00.000Z';
const minutesAgo = (m: number) => new Date(new Date(NOW).getTime() - m * 60_000).toISOString();
const USER = 'user-1';

const gap = { state: 'gap' as const, fromDate: '2022-01-01', toDate: '2026-09-20' };
const fund = (id: string, over: Partial<GateSchemeInput> = {}): GateSchemeInput => ({ instrumentId: id, schemeName: `Fund ${id}`, gap, attempt: null, overlapsCoverageGap: false, ...over });
const loaded = (id: string) => fund(id, { gap: { state: 'complete' } });

// ---------------------------------------------------------------------------
describe('evaluateReportNavGate (pure)', () => {
  it('HOLDS while any fund is still waiting, with the wording the PO asked for', () => {
    const g = evaluateReportNavGate({ schemes: [loaded('a'), loaded('b'), loaded('c'), fund('d'), fund('e')], heldSinceIso: NOW, nowIso: NOW });
    expect(g.hold).toBe(true);
    expect(g.headline).toBe('Your report will be ready once price history is loaded (3 of 5 funds loaded)');
    expect(heldHeadline(1, 1)).toContain('(1 of 1 fund loaded)');
    expect(g.waiting.map((f) => f.schemeName)).toEqual(['Fund d', 'Fund e']);
    expect(g.disclosures).toEqual([]);
  });

  it('RELEASES when every fund is loaded, with nothing to disclose', () => {
    const g = evaluateReportNavGate({ schemes: [loaded('a'), loaded('b')], heldSinceIso: NOW, nowIso: NOW });
    expect(g).toMatchObject({ hold: false, headline: null, loaded: 2, total: 2, disclosures: [] });
  });

  it('a user with no funds, or with no gaps, is entirely unaffected (never held, no anchor needed)', () => {
    expect(evaluateReportNavGate({ schemes: [], heldSinceIso: null, nowIso: NOW })).toMatchObject({ hold: false, total: 0, disclosures: [] });
    expect(evaluateReportNavGate({ schemes: [loaded('a')], heldSinceIso: null, nowIso: NOW }).hold).toBe(false);
  });

  it('a fund that is waiting but whose window has NOT elapsed keeps holding', () => {
    const g = evaluateReportNavGate({ schemes: [fund('a')], heldSinceIso: minutesAgo(REPORT_NAV_RETRY_WINDOW_MINUTES - 1), nowIso: NOW });
    expect(g.hold).toBe(true);
  });

  describe('NC-G3: never forever. Each of these releases the report and NAMES the fund', () => {
    const cases: Array<[string, GateSchemeInput, string | null]> = [
      ['a confirmed unrecoverable coverage gap (e.g. HSBC AMFI 151069)', fund('hsbc', { overlapsCoverageGap: true, schemeName: 'HSBC Short Term Fund' }), null],
      ['a fund with no AMFI scheme code', fund('nocode', { attempt: { lastAttemptedAt: NOW, lastOutcome: 'unresolvable_identifier', consecutiveFailures: 1 } }), null],
      ['attempts exhausted', fund('tried', { attempt: { lastAttemptedAt: NOW, lastOutcome: 'fetch_failed', consecutiveFailures: REPORT_NAV_MAX_FAILED_ATTEMPTS } }), null],
      ['the bounded retry window elapsing (also covers kill switch off and rate limit, which leave no failure record)', fund('slow'), minutesAgo(REPORT_NAV_RETRY_WINDOW_MINUTES)],
    ];
    for (const [label, f, heldSince] of cases) {
      it(label, () => {
        const g = evaluateReportNavGate({ schemes: [loaded('ok'), f], heldSinceIso: heldSince, nowIso: NOW });
        expect(g.hold).toBe(false);
        expect(g.unavailable.map((u) => u.instrumentId)).toEqual([f.instrumentId]);
        expect(g.disclosures).toEqual([`Price history for ${f.schemeName} could not be loaded; its figures are marked not available.`]);
      });
    }
    it('two failures are NOT yet "exhausted" (the third is)', () => {
      const g = evaluateReportNavGate({ schemes: [fund('a', { attempt: { lastAttemptedAt: NOW, lastOutcome: 'fetch_failed', consecutiveFailures: REPORT_NAV_MAX_FAILED_ATTEMPTS - 1 } })], heldSinceIso: NOW, nowIso: NOW });
      expect(g.hold).toBe(true);
    });
  });

  it('a mix holds only for the funds still waiting; a fund already marked unavailable does not keep the report back', () => {
    const g = evaluateReportNavGate({ schemes: [fund('a', { overlapsCoverageGap: true }), fund('b')], heldSinceIso: NOW, nowIso: NOW });
    expect(g.hold).toBe(true);
    expect(g.waiting.map((f) => f.instrumentId)).toEqual(['b']);
    expect(g.unavailable.map((f) => f.instrumentId)).toEqual(['a']);
  });

  it('the named constants are sensible and exposed', () => {
    expect(REPORT_NAV_RETRY_WINDOW_MINUTES).toBe(10);
    expect(REPORT_NAV_MAX_FAILED_ATTEMPTS).toBe(3);
    expect(unavailableDisclosure('X')).toBe('Price history for X could not be loaded; its figures are marked not available.');
  });
});

describe('applyNavDisclosures', () => {
  const sections = builtSections() as never as Array<{ sectionCode: string; narrativeText: string | null; limitationText: string | null; sectionData: Record<string, unknown> }>;
  const gate = evaluateReportNavGate({ schemes: [fund('hsbc', { overlapsCoverageGap: true, schemeName: 'HSBC Short Term Fund' })], heldSinceIso: NOW, nowIso: NOW });

  it('names the fund in plain words in the India MF and Performance sections, and nowhere else', () => {
    const out = applyNavDisclosures(sections, gate);
    const by = Object.fromEntries(out.map((s) => [s.sectionCode, s]));
    expect(by.india_mf_investment_report.narrativeText).toContain('Price history for HSBC Short Term Fund could not be loaded; its figures are marked not available.');
    expect(by.investment_performance.narrativeText).toContain('HSBC Short Term Fund');
    expect(by.india_mf_investment_report.sectionData.priceHistoryUnavailable).toEqual([{ fund: 'HSBC Short Term Fund', reason: 'coverage_gap' }]);
    expect(by.executive_summary.narrativeText).toBe('Summary text.');
  });

  it('with nothing unavailable the sections are returned unchanged', () => {
    const none = evaluateReportNavGate({ schemes: [loaded('a')], heldSinceIso: null, nowIso: NOW });
    expect(applyNavDisclosures(sections, none).map((s) => s.narrativeText)).toEqual(sections.map((s) => s.narrativeText));
  });
});

// ---------------------------------------------------------------------------
// checkReportNavHistoryGate against an in-memory database
// ---------------------------------------------------------------------------
function seed(over: Record<string, Row[]> = {}) {
  currentDb = createInMemoryDb();
  const txn = (id: string, ins: string, date: string): Row => ({ id, user_id: USER, account_id: 'acc', instrument_id: ins, transaction_date: date, status: 'parsed', source_reference: 'CAMS' });
  currentDb.reset({
    ii_holding_snapshots: ['f1', 'f2'].map((f) => ({ id: `s-${f}`, user_id: USER, instrument_id: f, as_of_date: '2026-09-04' })),
    ii_transactions: [txn('t1', 'f1', '2021-03-15'), txn('t2', 'f2', '2023-01-10')],
    ii_instruments: [{ id: 'f1', instrument_name: 'Fund One', instrument_class: 'mutual_fund' }, { id: 'f2', instrument_name: 'Fund Two', instrument_class: 'mutual_fund' }],
    ii_scheme_master: [],
    ii_investment_date_inputs: [],
    ii_prices_nav: [{ instrument_id: 'f1', price_date: '2021-01-01', price: 10 }, { instrument_id: 'f2', price_date: '2026-09-21', price: 10 }], // f1 complete, f2 has a gap
    ii_nav_history_floors: [],
    ii_nav_hydration_attempts: [],
    ii_nav_source_coverage_gaps: [],
    ii_audit_events: [],
    ...over,
  });
  return currentDb;
}
beforeEach(() => { auditClock = NOW; });
const check = (db: InMemoryDb, o: { createAnchor?: boolean; nowIso?: string; kick?: (u: string) => boolean } = {}) =>
  checkReportNavHistoryGate({ db: db.client as never, userId: USER, today: '2026-10-03', nowIso: o.nowIso ?? NOW, createAnchor: o.createAnchor, kick: o.kick });

describe('checkReportNavHistoryGate', () => {
  beforeEach(() => kickUserNavHistory.mockClear());

  it('holds for the fund with a gap, counts the loaded one, starts the window ONCE and kicks the fetch', async () => {
    const db = seed();
    const kick = vi.fn().mockReturnValue(true);
    const g = await check(db, { createAnchor: true, kick });
    expect(g).toMatchObject({ hold: true, loaded: 1, total: 2, headline: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)' });
    expect(kick).toHaveBeenCalledWith(USER);
    const anchors = db.tables.ii_audit_events.filter((e) => (e.metadata as { kind?: string }).kind === REPORT_NAV_ANCHOR_KIND);
    expect(anchors).toHaveLength(1);
    // asking again inside the window does not write a second anchor
    await check(db, { createAnchor: true, kick });
    expect(db.tables.ii_audit_events.filter((e) => (e.metadata as { kind?: string }).kind === REPORT_NAV_ANCHOR_KIND)).toHaveLength(1);
  });

  it('after the retry window the fund is released with a disclosure, so the report generates', async () => {
    const db = seed();
    await check(db, { createAnchor: true });
    const later = await check(db, { createAnchor: true, nowIso: new Date(new Date(NOW).getTime() + REPORT_NAV_RETRY_WINDOW_MINUTES * 60_000).toISOString() });
    expect(later.hold).toBe(false);
    expect(later.disclosures).toEqual(['Price history for Fund Two could not be loaded; its figures are marked not available.']);
  });

  it('an old anchor is ignored: a NEW gap gets its own wait, it does not inherit an old release', async () => {
    const db = seed({ ii_audit_events: [{ user_id: USER, event_type: 'calculation', metadata: { kind: REPORT_NAV_ANCHOR_KIND }, created_at: minutesAgo(REPORT_NAV_ANCHOR_MAX_AGE_MINUTES + 30) }] });
    const g = await check(db, { createAnchor: true });
    expect(g.hold).toBe(true);
  });

  it('a user with every fund loaded is unaffected: not held, no anchor written, nothing kicked', async () => {
    const db = seed({ ii_prices_nav: [{ instrument_id: 'f1', price_date: '2021-01-01', price: 10 }, { instrument_id: 'f2', price_date: '2022-01-01', price: 10 }] });
    const kick = vi.fn();
    const g = await check(db, { createAnchor: true, kick });
    expect(g).toMatchObject({ hold: false, loaded: 2, total: 2 });
    expect(kick).not.toHaveBeenCalled();
    expect(db.tables.ii_audit_events).toHaveLength(0);
  });

  it('a confirmed coverage gap OVER the needed window (HSBC 151069) releases at once with a disclosure; a resolved one, or one outside the window, does not', async () => {
    // f2 needs [2022-12-31, 2026-09-20].
    const overlapping = seed({ ii_nav_source_coverage_gaps: [{ instrument_id: 'f2', gap_from: '2020-01-01', gap_to: '2023-06-30', resolved_at: null }] });
    const g = await check(overlapping, { createAnchor: true });
    expect(g).toMatchObject({ hold: false, unavailable: [{ instrumentId: 'f2', reason: 'coverage_gap' }] });
    expect(g.disclosures).toEqual(['Price history for Fund Two could not be loaded; its figures are marked not available.']);

    const outside = seed({ ii_nav_source_coverage_gaps: [{ instrument_id: 'f2', gap_from: '2013-01-28', gap_to: '2022-09-19', resolved_at: null }] });
    expect((await check(outside, { createAnchor: true })).hold).toBe(true);
    const resolved = seed({ ii_nav_source_coverage_gaps: [{ instrument_id: 'f2', gap_from: '2020-01-01', gap_to: '2023-06-30', resolved_at: '2026-01-01' }] });
    expect((await check(resolved, { createAnchor: true })).hold).toBe(true);
  });

  it('without createAnchor (a read-only look) nothing is written and nothing is kicked', async () => {
    const db = seed();
    const kick = vi.fn();
    const g = await check(db, { kick });
    expect(g.hold).toBe(true);
    expect(db.tables.ii_audit_events).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
  });
});
