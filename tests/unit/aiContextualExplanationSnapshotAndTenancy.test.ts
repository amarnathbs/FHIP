// Module 11.5 — CLOSURE GATES 121 (snapshot binding) and 122 (cross-tenant
// isolation), plus the report-context rules of spec sections 44-48 and 64.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import {
  freshState,
  makeAdminClient,
  makeServerClient,
  seedStoredInsights,
  type HarnessState,
} from './support/contextualExplainHarness';
import type { FinancialContextObject } from '@/lib/ai/context/types';

let state: HarnessState = freshState();
let contextBuilder: () => FinancialContextObject = () => makeContext();
let sessionUser = 'user-a';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminClient(state) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeServerClient(state, sessionUser) }));
vi.mock('@/lib/ai/resolution/routerDependencies', () => ({
  createRouterDependencies: () => ({
    buildContext: async () => contextBuilder(),
    getUserCountry: async () => 'AU' as const,
    isPersonalisedAiEligible: async () => state.eligible,
  }),
  hashNormalisedQuestion: (s: string) => s,
}));

const { AIContextualExplanationService } = await import('@/lib/ai/contextualExplanations/service');

async function ask(user: string, targetCode: string, targetId: string | null = null, contextId: string | null = null) {
  const r = await AIContextualExplanationService.resolveExplanation(user, 'hh-1', {
    target_code: targetCode,
    target_id: targetId,
    context_id: contextId,
  });
  if ('unknownTarget' in r) throw new Error(`unknown target ${targetCode}`);
  return r;
}

const REPORT_A = { id: 'report-a', user_id: 'user-a', report_month: '2026-03-01', as_of_date: '2026-03-31', financial_snapshot_id: 'snapshot-A' };
const REPORT_B = { id: 'report-b', user_id: 'user-a', report_month: '2026-09-01', as_of_date: '2026-09-30', financial_snapshot_id: 'snapshot-B' };
const REPORT_USER_B = { id: 'report-foreign', user_id: 'user-b', report_month: '2026-09-01', as_of_date: '2026-09-30', financial_snapshot_id: 'snapshot-B' };

beforeEach(() => {
  sessionUser = 'user-a';
  state = freshState({
    currentSnapshotId: 'snapshot-A',
    reports: new Map([
      [REPORT_A.id, { ...REPORT_A }],
      [REPORT_B.id, { ...REPORT_B }],
      [REPORT_USER_B.id, { ...REPORT_USER_B }],
    ]),
  });
  seedStoredInsights(state, ['SCORE_EXPLANATION', 'CASH_FLOW_EXPLANATION', 'REPORT_READING_EXPLANATION', 'NET_WORTH_EXPLANATION']);
  contextBuilder = () => makeContext();
});

// ---------------------------------------------------------------------------
// CLOSURE GATE 121 — snapshot binding (spec sections 46-48, 88, 121)
// ---------------------------------------------------------------------------
describe('CLOSURE GATE 121 — current vs historical snapshot binding', () => {
  it('while Snapshot A is current, a report bound to A resolves as CURRENT and is not marked historical', async () => {
    state.currentSnapshotId = 'snapshot-A';
    const r = await ask('user-a', 'REPORT_SCORE', REPORT_A.id);
    expect(r.status).toBe('AVAILABLE');
    expect(r.historical_context).toBe(false);
    expect(r.source_context_label).toContain('current position');
  });

  it('after Snapshot B becomes current, the SAME report A explanation stops resolving with current data', async () => {
    // Snapshot A explanation works while A is current...
    state.currentSnapshotId = 'snapshot-A';
    const whileACurrent = await ask('user-a', 'REPORT_SCORE', REPORT_A.id);
    expect(whileACurrent.status).toBe('AVAILABLE');

    // ...and the household then moves to Snapshot B.
    state.currentSnapshotId = 'snapshot-B';

    // Report B (bound to the new current snapshot) resolves.
    const reportB = await ask('user-a', 'REPORT_SCORE', REPORT_B.id);
    expect(reportB.status).toBe('AVAILABLE');
    expect(reportB.historical_context).toBe(false);

    // Report A is now HISTORICAL. The critical assertion: it does NOT get
    // answered with today's (Snapshot B) figures — that would be exactly the
    // cross-context substitution spec section 48 forbids.
    const reportA = await ask('user-a', 'REPORT_SCORE', REPORT_A.id);
    expect(reportA.status).toBe('HISTORICAL_EXPLANATION_UNAVAILABLE');
    expect(reportA.answer).toBeNull();
    expect(reportA.historical_context).toBe(true);
  });

  it('spec section 64 — a historical report explanation is labelled with ITS OWN month, never as current', async () => {
    state.currentSnapshotId = 'snapshot-B';
    const r = await ask('user-a', 'REPORT_OVERVIEW', REPORT_A.id);
    expect(r.historical_context).toBe(true);
    expect(r.source_context_label).toMatch(/March 2026/);
    expect(r.source_context_label).not.toContain('current position');
  });

  it('REGRESSION — REPORT_OVERVIEW answers about the REQUESTED report, never the most recent one', async () => {
    // This is the defect this test exists to lock down. REPORT_OVERVIEW was
    // originally composed from the REPORT_PERIOD / REPORT_VERSION intents,
    // which are hardwired to `ctx.reports[0]` — the household's LATEST report.
    // Opening the March report therefore answered with SEPTEMBER's period:
    // exactly the cross-context substitution spec section 48 forbids. The
    // fixture context below deliberately reports September as the latest.
    contextBuilder = () =>
      makeContext({
        reports: [
          { report_id: REPORT_B.id, reporting_period: '2026-09-01', data_as_of: '2026-09-30', report_version: '4', executive_metrics: {}, major_findings: [], active_risks: [], goal_references: [], report_confidence: 99, template_version: null },
          { report_id: REPORT_A.id, reporting_period: '2026-03-01', data_as_of: '2026-03-31', report_version: '1', executive_metrics: {}, major_findings: [], active_risks: [], goal_references: [], report_confidence: 60, template_version: null },
        ],
      });
    state.currentSnapshotId = 'snapshot-B';

    const marchReport = await ask('user-a', 'REPORT_OVERVIEW', REPORT_A.id);
    expect(marchReport.status).toBe('AVAILABLE');
    // The answer must be about MARCH.
    expect(marchReport.answer!.headline).toContain('March 2026');
    expect(JSON.stringify(marchReport.answer)).not.toContain('September');
    // And its source ref must be the March report, not the September one.
    expect(marchReport.source_refs.map((s) => s.source_id)).toEqual([REPORT_A.id]);

    // The September report, asked for by id, answers about September.
    // (Its source refs also include the stored commentary's own refs, since
    // September IS the current snapshot — so this asserts the report ref is
    // the September one and that March's is absent, rather than exact equality.)
    const septReport = await ask('user-a', 'REPORT_OVERVIEW', REPORT_B.id);
    expect(septReport.answer!.headline).toContain('September 2026');
    const septIds = septReport.source_refs.map((s) => s.source_id);
    expect(septIds).toContain(REPORT_B.id);
    expect(septIds).not.toContain(REPORT_A.id);
  });

  it('a historical REPORT_OVERVIEW does not attach the current household’s stored report commentary', async () => {
    state.currentSnapshotId = 'snapshot-B';
    const historical = await ask('user-a', 'REPORT_OVERVIEW', REPORT_A.id);
    expect(historical.status).toBe('AVAILABLE');
    // The stored `report_reading_summary` block is generated against the
    // household's CURRENT position, so it must not be attached to an older
    // report — origin stays purely deterministic for a historical one.
    expect(historical.answer_origins).toEqual(['DETERMINISTIC']);
    expect(JSON.stringify(historical.answer)).not.toContain('Stored, grounded');
    expect(historical.answer!.limitations.length).toBeGreaterThan(0);

    // For the CURRENT report the same stored commentary IS legitimately used.
    const current = await ask('user-a', 'REPORT_OVERVIEW', REPORT_B.id);
    expect(current.answer_origins).toEqual(['COMPOSED_ZERO_COST']);
  });

  it('a report-scoped target that reads ONLY the report’s own record stays answerable for a historical report', async () => {
    // REPORT_OVERVIEW composes REPORT_PERIOD/REPORT_VERSION plus the stored
    // report-reading block — all report-scoped, none of it today's figures —
    // so a historical report can still be explained, correctly labelled.
    state.currentSnapshotId = 'snapshot-B';
    const r = await ask('user-a', 'REPORT_OVERVIEW', REPORT_A.id);
    expect(r.status).toBe('AVAILABLE');
    expect(r.historical_context).toBe(true);
  });

  it('a report with NO snapshot binding fails closed (treated as historical, never assumed current)', async () => {
    state.reports.set('report-unbound', { id: 'report-unbound', user_id: 'user-a', report_month: '2026-05-01', as_of_date: '2026-05-31', financial_snapshot_id: null });
    const r = await ask('user-a', 'REPORT_SCORE', 'report-unbound');
    expect(r.status).toBe('HISTORICAL_EXPLANATION_UNAVAILABLE');
    expect(r.historical_context).toBe(true);
  });

  it('spec section 47 — a client-asserted snapshot that does not match the report is rejected, not honoured', async () => {
    state.currentSnapshotId = 'snapshot-A';
    // The client claims report A belongs to snapshot B. The server verifies
    // the relationship against its own record and refuses.
    const r = await ask('user-a', 'REPORT_SCORE', REPORT_A.id, 'snapshot-B');
    expect(r.status).toBe('TARGET_NOT_FOUND');
    expect(r.answer).toBeNull();

    // The truthful pairing still works.
    const ok = await ask('user-a', 'REPORT_SCORE', REPORT_A.id, 'snapshot-A');
    expect(ok.status).toBe('AVAILABLE');
  });

  it('a NON-report target is never marked historical (current module screens use the current snapshot)', async () => {
    state.currentSnapshotId = 'snapshot-B';
    const r = await ask('user-a', 'SCORE_OVERALL');
    expect(r.status).toBe('AVAILABLE');
    expect(r.historical_context).toBe(false);
    expect(r.source_context_label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLOSURE GATE 122 — cross-tenant isolation (spec sections 13, 56, 122)
// ---------------------------------------------------------------------------
describe('CLOSURE GATE 122 — cross-tenant target isolation', () => {
  it('User A cannot explain User B’s report by supplying its id', async () => {
    sessionUser = 'user-a';
    for (const target of ['REPORT_OVERVIEW', 'REPORT_SCORE', 'REPORT_CASH_FLOW']) {
      const r = await ask('user-a', target, REPORT_USER_B.id);
      expect(r.status, target).toBe('TARGET_NOT_FOUND');
      expect(r.answer).toBeNull();
      // Nothing about User B's report may leak — not its month, not its
      // snapshot, not even confirmation that it exists.
      const serialised = JSON.stringify(r);
      expect(serialised).not.toContain('snapshot-B');
      expect(serialised).not.toContain('user-b');
    }
  });

  it('a report id that simply does not exist is INDISTINGUISHABLE from another user’s report', async () => {
    const other = await ask('user-a', 'REPORT_SCORE', REPORT_USER_B.id);
    const missing = await ask('user-a', 'REPORT_SCORE', '00000000-0000-0000-0000-000000000000');
    expect(other.status).toBe(missing.status);
    expect(other.answer).toBe(missing.answer);
    expect(other.source_context_label).toBe(missing.source_context_label);
  });

  it('User B, correctly authenticated, CAN explain their own report (proving the check is scoping, not a blanket refusal)', async () => {
    sessionUser = 'user-b';
    state.currentSnapshotId = 'snapshot-B';
    const r = await ask('user-b', 'REPORT_OVERVIEW', REPORT_USER_B.id);
    expect(r.status).toBe('AVAILABLE');
  });

  it('User A cannot explain a goal that is not in their own certified context', async () => {
    contextBuilder = () =>
      makeContext({
        goals: [
          { goal_reference: 'goal-of-a', goal_type: 'home_deposit', goal_status: 'active', target_date: '2030-01-01', target_amount: 100000, current_funding: 10000, contribution: 400, required_contribution: 900, track_status: 'off_track', forecast_completion_date: '2031-01-01', confidence: 0.7, calculation_version: 'g-1' },
        ],
      });
    const r = await ask('user-a', 'GOAL_STATUS', 'goal-of-user-b');
    expect(r.status).toBe('TARGET_NOT_FOUND');
    expect(JSON.stringify(r)).not.toContain('goal-of-a');
  });

  it('a target that takes NO entity ignores a supplied one entirely (no injection surface)', async () => {
    const withId = await ask('user-a', 'SCORE_OVERALL', REPORT_USER_B.id);
    const withoutId = await ask('user-a', 'SCORE_OVERALL');
    expect(withId.status).toBe(withoutId.status);
    expect(withId.target_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Country / currency integrity (spec sections 82, 41-42 of the acceptance list)
// ---------------------------------------------------------------------------
describe('spec section 82 — country and currency boundaries', () => {
  it('an INVALID currency-integrity context does not produce a consolidated cross-border explanation', async () => {
    contextBuilder = () =>
      makeContext({
        meta: { ...makeContext().meta, currency_integrity_status: 'INVALID' },
        domain_certification: {
          ...makeContext().domain_certification,
          cross_border: { status: 'INVALID', reason: 'currency integrity failed', model_versions: [], data_as_of: null },
        },
      });
    // No cross-border contextual target exists in 11.5, but the domains it
    // would depend on must still fail closed wherever they are reachable.
    const r = await ask('user-a', 'DASHBOARD_NET_WORTH');
    // Balance sheet is still certified, so net worth answers — but nothing in
    // the answer may present a consolidated cross-currency figure sourced
    // from the invalid cross-border domain.
    expect(r.source_refs.every((s) => s.source_type !== 'cross_border')).toBe(true);
  });

  it('an India household resolves from its own certified context without leaking AU-scoped content', async () => {
    contextBuilder = () =>
      makeContext({
        meta: { ...makeContext().meta, reporting_currency: 'INR', country_of_residence: 'IN' },
        household: { ...makeContext().household!, country_of_residence: 'IN', reporting_currency: 'INR' },
      });
    const r = await ask('user-a', 'DASHBOARD_NET_WORTH');
    expect(r.status).toBe('AVAILABLE');
    expect(JSON.stringify(r.answer)).not.toMatch(/superannuation|SMSF/i);
  });
});
