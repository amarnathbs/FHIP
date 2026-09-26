/**
 * Stage-2 INTEGRATION (feature/canonical-upload-integration): cross-package
 * oracles on the MERGED tree.
 *
 * Each package proved its own consumer on its own branch, against the
 * consumers of the OTHER packages as they were at the foundation. This file
 * proves they agree with each other now that they are merged:
 *
 *   WP-03 Dashboard  loadDashboard()                 (lib/services/dashboardData.ts)
 *   WP-05 Twin       loadTwinSourceData()            (lib/services/twinData.ts)
 *   WP-05 Forecast   runForecast('net_worth' | 'resilience' | 'retirement')
 *   WP-06 Report     resolveReportSourceData()       (lib/services/reportSnapshotResolver.ts)
 *
 * all driven by the WP-02 read models over WP-03's golden pair
 * (tests/unit/readModels/helpers/goldenPair.ts): Household M types its
 * finances by hand, Household I imports the same economics (payslip + the
 * matched bank salary, card 200 + 20 repaid 220, loan 2,000 = 1,550 principal
 * + 430 interest + 20 fee, all in the PREVIOUS calendar month). The oracle
 * numbers are the PO brief's, computed by hand in goldenPair.ts's header.
 *
 * NEGATIVE CONTROL: run unchanged against the stage-1 foundation
 * (feature/canonical-upload-foundation f79374f), where loadDashboard() was
 * the legacy current-calendar-month loader, the [NC] tests fail with
 * assertion failures (the imported household's previous-month statements
 * were invisible, so I != M and I != the oracle).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
// The Score / Resilience / DNA / Goals engines, the Twin run store, the
// forecast chapter and the II chapters are not under test here (each has its
// own suite); the Dashboard, Twin, Forecast baseline and Report source ARE.
vi.mock('@/lib/services/healthScoreData', () => ({
  loadHealthScore: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Stable', components: [], recommendations: [], previousScore: null, scoreChange: null, history: [] }),
}));
vi.mock('@/lib/services/resilienceData', () => ({
  loadResilience: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Resilient', components: [], componentScores: [], risks: [], previousScore: null, scoreChange: null, history: [], eligibility: 'full' }),
}));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({
    payload: {
      goals: [],
      summary: { activeGoalsCount: 0, totalTargetAmount: 0, totalCurrentAmount: 0, overallProgressPct: 0, totalMonthlyContribution: 0, onTrackCount: 0, atRiskCount: 0, offTrackCount: 0, achievedCount: 0, nextGoalDue: null },
      affordability: { status: 'insufficient_data', monthlySurplus: null, totalPlannedGoalContributions: 0, unallocatedAmount: null, overallocatedAmount: null, usageRatio: null, warning: null },
      modelVersion: 'test',
      goalTypes: [],
    },
  }),
}));
vi.mock('@/lib/services/financialTwinService', () => ({ listTwinRuns: vi.fn().mockResolvedValue([]), getTwinRunDetail: vi.fn() }));
vi.mock('@/lib/services/recommendationsData', () => ({ buildReportActionMatches: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/services/forecastReportData', () => ({ buildForecastReportData: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/investmentIntelligenceReportData', () => ({
  loadInvestmentPerformanceForReport: vi.fn().mockResolvedValue(null),
  loadSipForReport: vi.fn().mockResolvedValue(null),
  loadXrayForReport: vi.fn().mockResolvedValue(null),
  loadTaxForReport: vi.fn().mockResolvedValue(null),
  loadReviewItemsForReport: vi.fn().mockResolvedValue(null),
}));

import type { DashboardSummary } from '@/lib/engines/dashboard';
import { loadDashboard } from '@/lib/services/dashboardData';
import { loadTwinSourceData } from '@/lib/services/twinData';
import { runForecast } from '@/lib/services/forecastData';
import { resolveReportSourceData } from '@/lib/services/reportSnapshotResolver';
import { buildPremiumSections } from '@/lib/engines/reportSectionsPremium';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { loadResilience } from '@/lib/services/resilienceData';
import { loadFinancialDna } from '@/lib/services/financialDnaData';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, incomeSource, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';
import { householdI, householdM, P_DAY, P_END, P_START } from './readModels/helpers/goldenPair';
// WP-05/06's golden household M (it holds investments, so the premium investment chapter has rows).
import { householdM as goldenM } from './helpers/canonicalGoldenHouseholds';

// The brief's golden-pair oracle (goldenPair.ts header; identical to the WP-03
// Dashboard oracle in dashboardCanonicalReadModel.test.ts).
const ORACLE = {
  grossMonthlyIncome: 9000,
  netMonthlyIncome: 7000,
  totalMonthlyExpenses: 3100, // groceries 800 (= 580 bank + 200 + 20 card) + restaurants 300 + rent 2,000
  essentialMonthlyExpenses: 2800,
  debtMonthlyRepayments: 2000, // the loan payment ONCE (D-09); the revolving card minimum excluded (D-08)
  monthlySurplus: 1900,
  netWorth: 12000 - 31500,
} as const;
const FIELDS = Object.keys(ORACLE) as (keyof typeof ORACLE)[];

const HOUSEHOLDS = [['M (manual)', householdM], ['I (imported)', householdI]] as const;

async function dashboardOf(t: Record<string, Row[]>): Promise<DashboardSummary> {
  return loadDashboard(USER, makeFakeSupabase(t).client as never);
}

function pick(d: Pick<DashboardSummary, keyof typeof ORACLE>) {
  return Object.fromEntries(FIELDS.map((f) => [f, d[f]]));
}

// ---------------------------------------------------------------------------
// Forecast harness (the WP-05 pattern: the REAL runForecast(), forecast
// writes captured instead of stored).
// ---------------------------------------------------------------------------
const PROFILE_ID = 'fp-1';
const SCENARIO_ID = 'sc-1';

function withForecastProfile(t: Record<string, Row[]>): Record<string, Row[]> {
  return tables(t, {
    forecast_profiles: [{
      id: PROFILE_ID, user_id: USER, status: 'active', name: 'My Forecast', base_currency: 'AUD', country_code: 'AU',
      forecast_start_date: P_START, retirement_age: null, retirement_date: null, retirement_timing_override_months: null, created_at: '2026-01-01T00:00:00Z',
    }],
    forecast_scenarios: [{ id: SCENARIO_ID, user_id: USER, forecast_profile_id: PROFILE_ID, scenario_name: 'Base scenario', scenario_type: 'base', is_default: true, is_active: true }],
  });
}

function forecastClient(t: Record<string, Row[]>) {
  const fake = makeFakeSupabase(withForecastProfile(t));
  const results: Row[] = [];
  const runsBuilder = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: (row: Row) => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...row }, error: null }) }) }),
      update: (patch: Row) => ({
        eq: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p: any = Promise.resolve({ error: null });
          p.select = () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...patch }, error: null }) });
          return p;
        },
      }),
    };
    return b;
  };
  const client = {
    from(table: string) {
      if (table === 'forecast_runs') return runsBuilder();
      if (table === 'forecast_results') return { insert: (rows: Row[]) => { results.push(...rows); return Promise.resolve({ error: null }); } };
      if (table === 'forecast_explanations') return { insert: () => Promise.resolve({ error: null }) };
      return fake.client.from(table);
    },
  };
  return { client, results };
}

async function forecastPeriod1(forecastType: 'net_worth' | 'resilience', t: Record<string, Row[]>) {
  const { client, results } = forecastClient(t);
  await runForecast(USER, { scenarioId: SCENARIO_ID, forecastType, months: 12 }, client as never);
  const p1 = results.filter((r) => r.period_number === 1);
  if (p1.length === 0) throw new Error(`no period-1 ${forecastType} result was written`);
  return p1;
}

// ---------------------------------------------------------------------------

describe('cross-package: the golden pair gives the brief oracle on the Dashboard (WP-03 over WP-02 + WP-09/11 inputs)', () => {
  for (const [name, build] of HOUSEHOLDS) {
    it(`[NC] ${name}: Dashboard = oracle`, async () => {
      const d = await dashboardOf(build());
      for (const f of FIELDS) expect(d[f], `${name}.${f}`).toBeCloseTo(ORACLE[f], 6);
    });
  }
});

describe('cross-package: Dashboard = Twin = Report = Forecast inputs for the same household', () => {
  for (const [name, build] of HOUSEHOLDS) {
    it(`[NC] ${name}: the Twin's figures are the Dashboard's (WP-05 over WP-03)`, async () => {
      const t = build();
      const [d, tw] = await Promise.all([dashboardOf(t), loadTwinSourceData(USER, makeFakeSupabase(t).client as never)]);
      if (tw.status !== 'ok') throw new Error('country unresolved');
      expect(pick(tw.data.dashboard)).toEqual(pick(d));
      for (const f of FIELDS) expect(tw.data.dashboard[f], `${name}.twin.${f}`).toBeCloseTo(ORACLE[f], 6);
    });

    it(`[NC] ${name}: the Report's source figures are the Dashboard's (WP-06 over WP-03)`, async () => {
      const t = build();
      const d = await dashboardOf(t);
      const source = await resolveReportSourceData(USER, undefined, makeFakeSupabase(t).client as never);
      expect(pick(source.dashboard)).toEqual(pick(d));
      for (const f of FIELDS) expect(source.dashboard[f], `${name}.report.${f}`).toBeCloseTo(ORACLE[f], 6);
    });

    it(`${name}: the Net Worth forecast opens at the Dashboard Net Worth (WP-05 over WP-03)`, async () => {
      const t = build();
      const d = await dashboardOf(t);
      const p1 = await forecastPeriod1('net_worth', t);
      const total = p1.find((r) => r.component === 'net_worth') ?? p1[0];
      expect(total.opening_value).toBeCloseTo(d.netWorth, 2);
      expect(total.opening_value).toBeCloseTo(ORACLE.netWorth, 2);
    });
  }

  it('[NC] M and I give the SAME resilience forecast baseline (WP-05 over WP-03)', async () => {
    const [m, i] = await Promise.all([forecastPeriod1('resilience', householdM()), forecastPeriod1('resilience', householdI())]);
    const IDS = new Set(['forecast_run_id', 'id', 'created_at']);
    const strip = (rows: Row[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !IDS.has(k))));
    expect(strip(i)).toEqual(strip(m));
  });
});

describe('cross-package economic oracles (merged WP-02/03/09/11 rules)', () => {
  const bankOnly = (extra: Record<string, Row[]>) => tables(profile(), taxonomy(), {
    fdh_financial_accounts: [account('bank')],
    fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END)],
  }, extra);

  it('planned vs actual are never blindly added: planned groceries 800 + the same 800 imported = 800, not 1,600 (D-02)', async () => {
    const t = bankOnly({
      expense_items: [expenseItem('g', 'Groceries', 800, 'monthly', { master_item_key: 'groceries', is_essential: true })],
      fdh_transactions: [txn({ account: 'bank', statement: 'sb', date: P_DAY, amount: 800, type: 'expense', category: CAT.food, subcategory: SUB.groceries })],
    });
    const d = await dashboardOf(t);
    expect(d.totalMonthlyExpenses).toBe(800);
    // The same household through the Report: still 800.
    const source = await resolveReportSourceData(USER, undefined, makeFakeSupabase(t).client as never);
    expect(source.dashboard.totalMonthlyExpenses).toBe(800);
  });

  it('[NC] planned vs actual, current month: planned groceries 800 + an 800 import dated THIS month = 800 on the Dashboard and the Report, not 1,600', async () => {
    // The pre-programme loader added this calendar month's approved bank
    // spending ON TOP of expense_items (1,600). The canonical model never adds
    // the two sides; an incomplete month is shown, never averaged.
    const now = new Date();
    const curDay = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const t = tables(profile(), taxonomy(), {
      expense_items: [expenseItem('g', 'Groceries', 800, 'monthly', { master_item_key: 'groceries', is_essential: true })],
      fdh_financial_accounts: [account('bank')],
      fdh_statement_uploads: [statement('sb', 'bank', curDay, curDay)],
      fdh_transactions: [txn({ account: 'bank', statement: 'sb', date: curDay, amount: 800, type: 'expense', category: CAT.food, subcategory: SUB.groceries })],
    });
    expect((await dashboardOf(t)).totalMonthlyExpenses).toBe(800);
    const source = await resolveReportSourceData(USER, undefined, makeFakeSupabase(t).client as never);
    expect(source.dashboard.totalMonthlyExpenses).toBe(800);
  });

  it("[NC] prior-month statements count: last month's approved statement moves the Dashboard AND the Report by the same amount", async () => {
    const base = () => tables(profile(), taxonomy(), {
      income_sources: [incomeSource('s', 'Salary', 9000, 'monthly', { net_amount: 7000 })],
      expense_items: [expenseItem('rent', 'Rent', 2000, 'monthly', { master_item_key: 'rent', is_essential: true })],
      fdh_financial_accounts: [account('bank')],
    });
    const approved = tables(base(), {
      fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END)],
      fdh_transactions: [txn({ account: 'bank', statement: 'sb', date: P_DAY, amount: 350, type: 'expense', category: CAT.food, subcategory: SUB.groceries })],
    });
    const [before, after] = await Promise.all([dashboardOf(base()), dashboardOf(approved)]);
    expect(before.monthlySurplus - after.monthlySurplus).toBe(350);
    const [rBefore, rAfter] = await Promise.all([
      resolveReportSourceData(USER, undefined, makeFakeSupabase(base()).client as never),
      resolveReportSourceData(USER, undefined, makeFakeSupabase(approved).client as never),
    ]);
    expect(rBefore.dashboard.monthlySurplus - rAfter.dashboard.monthlySurplus).toBe(350);
  });

  it('[NC] card 200 + 20 repaid 220, loan 2,000 = 1,550 + 430 + 20, payslip + bank salary: I counts each ONCE', async () => {
    const d = await dashboardOf(householdI());
    // Spending 3,100 includes the card's 220 once (never 440); debt service is
    // the loan's 2,000 once (never 2,450); income is the payslip's 7,000 net
    // once (never 14,000 with the matched bank credit).
    expect(d.totalMonthlyExpenses).toBe(3100);
    expect(d.debtMonthlyRepayments).toBe(2000);
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(5100);
    expect(d.netMonthlyIncome).toBe(7000);
    expect(d.dataStatus?.costOfDebtMonthly).toBe(450);
  });
});

describe('integration seam WP-03 (DC-14 fail-closed FX) x WP-06 (report resolves with the appendix unavailable)', () => {
  // The premium section builders read the full Score / Resilience / DNA
  // payloads; the stubs above are Twin-shaped, so here (as in WP-06's own
  // suite) those engines are "not under test" and resolve to null.
  beforeEach(() => {
    vi.mocked(loadHealthScore).mockRejectedValueOnce(new Error('not under test'));
    vi.mocked(loadResilience).mockRejectedValueOnce(new Error('not under test'));
    vi.mocked(loadFinancialDna).mockRejectedValueOnce(new Error('not under test'));
  });

  it('[NC] an unreadable FX assumption: the report still resolves, the appendix AND the investment chapter are unavailable -- nothing is converted at an assumed rate', async () => {
    const t = tables(goldenM(), { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] });
    const { client } = makeFakeSupabase(t, { failOn: new Set(['forecast_global_assumptions']) });
    const source = await resolveReportSourceData(USER, undefined, client as never);
    expect(source.premium?.fxRateAudInr).toBeNull();
    const sections = buildPremiumSections(source, false);
    expect(sections.find((s) => s.sectionCode === 'appendices')?.sectionStatus).toBe('unavailable');
    const inv = sections.find((s) => s.sectionCode === 'investment_analysis')!;
    expect(inv.sectionStatus).toBe('unavailable');
    expect(inv.sectionData).toEqual({});
  });

  it("with the FX assumption readable, the same household's investment chapter is included at the snapshot's rate", async () => {
    const t = tables(goldenM(), { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] });
    const source = await resolveReportSourceData(USER, undefined, makeFakeSupabase(t).client as never);
    expect(typeof source.premium?.fxRateAudInr).toBe('number');
    const inv = buildPremiumSections(source, false).find((s) => s.sectionCode === 'investment_analysis')!;
    expect(inv.sectionStatus).toBe('included');
    expect(inv.sectionData.totalCurrentValue).toBe(source.dashboard.totalInvestments);
  });
});
