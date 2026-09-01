// Module 11.3 continuation — item 3 of the closure dispatch: a 20-household
// END-TO-END PACK PIPELINE certification, distinct from and additional to
// the 36-case grounding-VALIDATOR golden matrix (tests/unit/
// aiInsightPackGrounding.test.ts, kept unmodified as a permanent regression
// suite). That matrix proves the validator's per-violation-type logic in
// isolation; THIS file proves the REAL generate -> validate -> persist
// PIPELINE (the actual AIPersonalisedInsightPackService, against a REAL
// Postgres instance via the shared PGlite harness) across genuinely
// diverse household DATA SHAPES, not fault-injected provider misbehaviour.
//
// Each of the 20 households below is a DIFFERENT synthetic user, so the
// spec section 34 regeneration cooldown (per-subject) never interferes
// between households.
//
// For every household the pipeline must:
//   - run to a REAL terminal state (READY/PARTIAL/FAILED) — never crash,
//     and never land on a setup-artefact status (NOT_ELIGIBLE,
//     BATCH_DISABLED, CONTEXT_UNAVAILABLE, COST_BLOCKED, IN_PROGRESS,
//     REGENERATION_RATE_LIMITED all indicate a harness bug, not a genuine
//     household-shape outcome, for a well-formed CERTIFIED premium request);
//   - produce no fabricated claim about missing data (every block's
//     grounding verdict is fetched back from the DB and checked: a block
//     built from a domain the household genuinely lacks must be
//     NOT_APPLICABLE or GROUNDED with honest "cannot assess" wording, never
//     UNGROUNDED via a missing-treated-as-zero violation);
//   - persist at least the pack row itself with internally consistent
//     invariants (READY implies validated_at/ready_at present, etc. — the
//     SAME invariant migration 0123 hardens, re-exercised here across 20
//     independent real generations rather than 1).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const recordAiRunMock = vi.fn<(input: unknown) => Promise<string>>(async () => null as unknown as string);
vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: (input: unknown) => recordAiRunMock(input),
  hashContext: (ctx: unknown) => `hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`,
}));

import { AIPersonalisedInsightPackService, type GenerateInsightPackOutcome } from '@/lib/ai/insightPack/insightPackService';
import { MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { buildPgliteInsightPackHarness, insertPremiumUser, type PgliteInsightPackHarness } from './support/pgliteInsightPackHarness';
import { makeContext } from './support/financialContextFixture';
import type { FinancialContextObject } from '@/lib/ai/context/types';

interface HouseholdCase {
  label: string;
  userId: string;
  build: () => FinancialContextObject;
}

function uid(n: number): string {
  return `88888888-8888-8888-8888-${String(n).padStart(12, '0')}`;
}

const HOUSEHOLDS: HouseholdCase[] = [
  {
    label: '1. AU household (standard baseline)',
    userId: uid(1),
    build: () => makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h1-au' } }),
  },
  {
    label: '2. India household',
    userId: uid(2),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h2-india', country_of_residence: 'IN', reporting_currency: 'INR' },
      household: { country_of_residence: 'IN', reporting_currency: 'INR', household_type: 'single', life_stage: null, number_of_adults: 1, number_of_dependants: 0, employment_status_summary: 'employed', housing_tenure_category: null, cross_border_indicator: false },
      cash_flow: { ...makeContext().cash_flow!, data_as_of: '2026-09-01' },
    }),
  },
  {
    label: '3. Cross-border household',
    userId: uid(3),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h3-crossborder' },
      household: { ...makeContext().household!, cross_border_indicator: true },
      cross_border: { countries_present: ['AU', 'IN'], currencies_present: ['AUD', 'INR'], reporting_currency: 'AUD', local_country_totals: [{ country_code: 'AU', value: 500000 }, { country_code: 'IN', value: 4000000 }], converted_totals: [{ country_code: 'AU', value_in_reporting_currency: 500000 }, { country_code: 'IN', value_in_reporting_currency: 65000 }], fx_source: 'rba', fx_rate_date: '2026-09-01', currency_mismatch_metrics: [], country_concentration: 0.6, cross_border_goals: [], cross_border_debt_exposure: null },
    }),
  },
  {
    label: '4. Zero income household',
    userId: uid(4),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h4-zeroincome' },
      cash_flow: { monthly_gross_income: 0, monthly_net_income: 0, monthly_expenses: 1500, essential_monthly_expenses: 1500, discretionary_monthly_expenses: 0, debt_repayments: 0, insurance_premiums: 0, monthly_surplus_or_deficit: -1500, savings_rate: null, income_concentration: null, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    }),
  },
  {
    label: '5. Debt-free household',
    userId: uid(5),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h5-debtfree' },
      balance_sheet: { ...makeContext().balance_sheet!, total_liabilities: 0, net_worth: 900000, debt_breakdown: [] },
    }),
  },
  {
    label: '6. High debt household (negative net worth)',
    userId: uid(6),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h6-highdebt' },
      balance_sheet: { total_assets: 200000, total_liabilities: 350000, net_worth: -150000, liquid_assets: 5000, property_assets: 150000, investment_assets: 20000, retirement_assets: 25000, property_concentration: 0.75, investment_concentration: 0.1, debt_breakdown: [{ debt_type: 'mortgage', balance: 300000 }, { debt_type: 'credit_card', balance: 50000 }], country_breakdown: [{ country_code: 'AU', value: 200000 }], currency_breakdown: [{ currency_code: 'AUD', value: -150000 }], data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    }),
  },
  {
    label: '7. Retired household',
    userId: uid(7),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h7-retired' },
      household: { ...makeContext().household!, life_stage: 'retired', employment_status_summary: 'retired' },
      cash_flow: { monthly_gross_income: 3500, monthly_net_income: 3500, monthly_expenses: 3000, essential_monthly_expenses: 2500, discretionary_monthly_expenses: 500, debt_repayments: 0, insurance_premiums: 150, monthly_surplus_or_deficit: 500, savings_rate: 0.14, income_concentration: 1, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
      retirement: { retirement_balance: 650000, account_categories: ['superannuation_pension'], employer_contribution_rate: null, personal_contribution_rate: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    }),
  },
  {
    label: '8. Missing insurance data',
    userId: uid(8),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h8-missinginsurance' },
      insurance: { data_status: 'missing', active_cover_categories: [], confirmed_no_cover_categories: [], missing_or_unknown_categories: ['life', 'income_protection'], premium_burden: null, confidence: null },
    }),
  },
  {
    label: '9. Missing retirement data',
    userId: uid(9),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h9-missingretirement' },
      retirement: null,
      domain_certification: { ...makeContext().domain_certification, retirement: { status: 'UNAVAILABLE', reason: 'no retirement account on file', model_versions: [], data_as_of: null } },
    }),
  },
  {
    label: '10. Stale valuations',
    userId: uid(10),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h10-stale' },
      domain_certification: { ...makeContext().domain_certification, balance_sheet: { status: 'STALE', reason: 'property valuation older than 12 months', model_versions: ['test-1.0.0'], data_as_of: '2025-06-01' } },
      data_quality: { ...makeContext().data_quality, stale_fields: ['balance_sheet.property_assets'] },
    }),
  },
  {
    label: '11. Multiple goals',
    userId: uid(11),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h11-multigoals' },
      goals: Array.from({ length: 6 }, (_, i) => ({
        goal_reference: `g${i + 1}`, goal_type: ['education', 'holiday', 'home_deposit', 'emergency_fund', 'retirement_top_up', 'wedding'][i],
        goal_status: 'active', target_amount: 10000 * (i + 1), current_funding: 1000 * (i + 1), contribution: 200, target_date: '2028-01-01',
        track_status: i % 2 === 0 ? 'on_track' : 'at_risk', required_contribution: 250, forecast_completion_date: '2027-12-01', confidence: null, calculation_version: 'goals-1.0.0',
      })),
    }),
  },
  {
    label: '12. Asset concentration (high property concentration)',
    userId: uid(12),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h12-concentration' },
      balance_sheet: { ...makeContext().balance_sheet!, property_concentration: 0.95, investment_concentration: 0.02 },
    }),
  },
  {
    label: '13. Missing Twin/Forecast data',
    userId: uid(13),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h13-notwinforecast' },
      financial_twin: null,
      forecasts: [],
      domain_certification: { ...makeContext().domain_certification, financial_twin: { status: 'UNAVAILABLE', reason: 'insufficient peer cohort data', model_versions: [], data_as_of: null }, forecasts: { status: 'UNAVAILABLE', reason: 'no forecast run yet', model_versions: [], data_as_of: null } },
    }),
  },
  {
    label: '14. Resilience score extreme HIGH',
    userId: uid(14),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h14-resiliencehigh' },
      resilience: { resilience_score: 98, resilience_status: 'excellent', emergency_fund_months: 24, liquidity_position: '90% liquid', income_concentration: 0.2, debt_pressure: 'DSR 2%', insurance_protection_status: 'fully_covered', active_risks: [], stress_test_outputs: [], confidence: 0.95, model_version: 'resilience-1.0.0' },
    }),
  },
  {
    label: '15. Resilience score extreme LOW',
    userId: uid(15),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h15-resiliencelow' },
      resilience: { resilience_score: 3, resilience_status: 'critical', emergency_fund_months: 0.1, liquidity_position: '2% liquid', income_concentration: 0.95, debt_pressure: 'DSR 65%', insurance_protection_status: 'no_cover_recorded', active_risks: [{ code: 'no_emergency_fund', category: 'liquidity', severity: 'high' }, { code: 'high_debt_pressure', category: 'debt', severity: 'high' }], stress_test_outputs: [], confidence: 0.9, model_version: 'resilience-1.0.0' },
    }),
  },
  {
    label: '16. Negative cash flow',
    userId: uid(16),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h16-negativecashflow' },
      cash_flow: { monthly_gross_income: 5000, monthly_net_income: 4200, monthly_expenses: 5100, essential_monthly_expenses: 4000, discretionary_monthly_expenses: 1100, debt_repayments: 800, insurance_premiums: 150, monthly_surplus_or_deficit: -900, savings_rate: -0.21, income_concentration: 1, fixed_commitment_ratio: 0.95, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
    }),
  },
  {
    label: '17. Rounding-edge-case household',
    userId: uid(17),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h17-rounding' },
      cash_flow: { monthly_gross_income: 8333.335, monthly_net_income: 6249.995, monthly_expenses: 4166.665, essential_monthly_expenses: 3000.005, discretionary_monthly_expenses: 1166.66, debt_repayments: 500.005, insurance_premiums: 99.995, monthly_surplus_or_deficit: 2083.33, savings_rate: 0.33333, income_concentration: 0.6, fixed_commitment_ratio: null, data_as_of: '2026-09-01', calculation_version: 'dashboard-1.0.0' },
      balance_sheet: { ...makeContext().balance_sheet!, net_worth: 599999.995, total_assets: 899999.995 },
    }),
  },
  {
    label: '18. Missing balance sheet entirely',
    userId: uid(18),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h18-nobalancesheet' },
      balance_sheet: null,
      domain_certification: { ...makeContext().domain_certification, balance_sheet: { status: 'UNAVAILABLE', reason: 'no linked asset/liability accounts', model_versions: [], data_as_of: null } },
    }),
  },
  {
    label: '19. Missing health score',
    userId: uid(19),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h19-noscore' },
      health_score: null,
      domain_certification: { ...makeContext().domain_certification, score: { status: 'UNAVAILABLE', reason: 'score not yet calculated for this snapshot', model_versions: [], data_as_of: null } },
    }),
  },
  {
    label: '20. Domain-level UNAVAILABLE (investments) despite overall-CERTIFIED context',
    userId: uid(20),
    build: () => makeContext({
      meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: 'h20-investmentsunavailable' },
      investments: null,
      domain_certification: { ...makeContext().domain_certification, investments: { status: 'UNAVAILABLE', reason: 'no investment accounts linked', model_versions: [], data_as_of: null } },
    }),
  },
];

const NON_TERMINAL_STATUSES = new Set([
  'NOT_ELIGIBLE', 'BATCH_DISABLED', 'CONTEXT_UNAVAILABLE', 'COST_BLOCKED', 'IN_PROGRESS', 'EXISTING_READY', 'REGENERATION_RATE_LIMITED',
]);

describe('Module 11.3 — 20-household end-to-end pack pipeline certification (real service, real PGlite Postgres)', () => {
  let harness: PgliteInsightPackHarness;
  const outcomes = new Map<string, GenerateInsightPackOutcome>();

  beforeAll(async () => {
    harness = await buildPgliteInsightPackHarness();
    for (const h of HOUSEHOLDS) {
      await insertPremiumUser(harness.db, h.userId, `h20-${h.userId}@t.test`);
    }
  }, 120_000);

  afterAll(async () => {
    // Independently re-verify zero residue for every one of the 20
    // synthetic households before tearing the isolated instance down.
    for (const h of HOUSEHOLDS) {
      await harness.db.query(`delete from ai_insights where user_id=$1`, [h.userId]);
      await harness.db.query(`delete from ai_insight_packs where user_id=$1`, [h.userId]);
      await harness.db.query(`delete from user_entitlements where user_id=$1`, [h.userId]);
      await harness.db.query(`delete from auth.users where id=$1`, [h.userId]);
    }
    for (const h of HOUSEHOLDS) {
      const packs = await harness.db.query(`select id from ai_insight_packs where user_id=$1`, [h.userId]);
      const blocks = await harness.db.query(`select id from ai_insight_pack_blocks where user_id=$1`, [h.userId]);
      const insights = await harness.db.query(`select id from ai_insights where user_id=$1`, [h.userId]);
      const users = await harness.db.query(`select id from auth.users where id=$1`, [h.userId]);
      expect(packs.rows.length, `residual ai_insight_packs for ${h.label}`).toBe(0);
      expect(blocks.rows.length, `residual ai_insight_pack_blocks for ${h.label}`).toBe(0);
      expect(insights.rows.length, `residual ai_insights for ${h.label}`).toBe(0);
      expect(users.rows.length, `residual auth.users for ${h.label}`).toBe(0);
    }
    await harness.db.close();
  }, 60_000);

  it.each(HOUSEHOLDS.map((h) => [h.label, h] as const))('%s — real pipeline reaches a genuine terminal state, no crash', async (_label, household) => {
    const service = new AIPersonalisedInsightPackService(harness.dbClient, (ctx) => new MockInsightPackProvider(ctx, 'valid'), harness.gate);
    const ctx = household.build();

    let outcome: GenerateInsightPackOutcome;
    try {
      outcome = await service.generateOrGetPack({ userId: household.userId, householdId: null, context: ctx });
    } catch (e) {
      throw new Error(`Pipeline CRASHED for ${household.label}: ${(e as Error)?.stack ?? e}`);
    }
    outcomes.set(household.userId, outcome);

    expect(NON_TERMINAL_STATUSES.has(outcome.status), `${household.label} landed on a non-terminal/setup status: ${outcome.status}`).toBe(false);
    expect(['READY', 'PARTIAL', 'FAILED']).toContain(outcome.status);

    if (outcome.status === 'READY' || outcome.status === 'PARTIAL') {
      const pack = outcome.pack;
      // The SAME structural invariant migration 0123 hardens, re-verified
      // against 20 independent real generations rather than 1.
      expect(pack.validated_at, `${household.label}: validated_at`).not.toBeNull();
      if (outcome.status === 'READY') {
        expect(pack.ready_at, `${household.label}: ready_at`).not.toBeNull();
        expect(pack.grounding_status, `${household.label}: grounding_status`).toBe('PASS');
      }
      expect(pack.critical_safety_failure, `${household.label}: critical_safety_failure`).toBe(false);

      // Ground-truth re-read of the persisted blocks — no fabricated
      // "missing treated as zero" verdict slipped through for a domain this
      // household genuinely lacks.
      const { rows: blockRows } = await harness.db.query(`select block_code, status, violations_json from ai_insight_pack_blocks where pack_id=$1`, [pack.id]);
      expect(blockRows.length, `${household.label}: at least one block persisted`).toBeGreaterThan(0);
      for (const row of blockRows) {
        const b = row as { block_code: string; status: string };
        expect(b.status, `${household.label} block ${b.block_code} should never be silently UNGROUNDED for the 'valid' honest-envelope provider behaviour`).not.toBe('UNGROUNDED');
      }
    } else if (outcome.status === 'FAILED') {
      // FAILED is a legitimate real terminal state (e.g. a genuine
      // mandatory-block/safety failure) — but for the 'valid' mock
      // behaviour used here it would indicate a genuine false-positive
      // grounding violation for this household shape, which is exactly
      // the kind of real finding this certification exists to surface.
      // Fail the test loudly with the reason rather than silently accept it.
      throw new Error(`${household.label} reached FAILED with the 'valid' mock provider behaviour — failureCode=${outcome.failureCode}. This is either a genuine false-positive grounding violation for this household shape (a real finding) or a harness data-fixture bug; see completion report.`);
    } else {
      throw new Error(`${household.label} reached an unexpected non-terminal status ${(outcome as { status: string }).status} — should have been excluded by the NON_TERMINAL_STATUSES check above.`);
    }
  });

  it('exactly 20 households were exercised, each with a DISTINCT terminal outcome recorded (no silent skip)', () => {
    expect(outcomes.size).toBe(20);
  });
});
