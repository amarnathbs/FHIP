// Regression coverage for the archived-linked-investment stale-funding bug:
// archiving an investment (is_active: false) must not keep its stale value
// permanently credited to a goal's live funded amount. Root cause was
// loadLinkedContributionSources() in goalsData.ts querying investments/
// assets/retirement_accounts with no is_active filter, unlike every other
// reader of those tables in the codebase (dashboardData.ts, twinData.ts,
// forecastData.ts). Fixed by adding the same .eq('is_active', true) filter.
//
// This test exercises the real computeGoalsPagePayload() production code
// path (not a reimplementation of it) against an in-memory fake Supabase
// client, so it fails on the pre-fix code and passes post-fix — mirroring
// the live-DEV reproduction/re-verification performed separately against
// real DEV Supabase (see the closure report).
import { describe, it, expect } from 'vitest';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { computeLiveLinkedFundingValue, type LiveLinkedFundingSource } from '@/lib/services/goalFundingAllocation';

const GOAL_PLANNING_CONFIG = {
  trackStatusThresholds: { aheadMin: 105, onTrackMin: 100, atRiskMin: 90 },
  confidenceWeights: {
    targetAmountCompleteness: 0.15,
    targetDateCertainty: 0.1,
    currentBalanceVerification: 0.15,
    contributionHistory: 0.15,
    linkedCashFlowData: 0.15,
    assumptionReliability: 0.1,
    timeHorizon: 0.1,
    dataRecency: 0.1,
  },
  confidenceBands: [
    { min: 85, band: 'high', label: 'High' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'moderate', label: 'Moderate' },
    { min: 40, band: 'low', label: 'Low' },
    { min: 0, band: 'insufficient', label: 'Insufficient' },
  ],
  affordabilityThresholds: { comfortableMax: 0.6, manageableMax: 0.85, tightMax: 1.0 },
  priorityWeights: {
    userImportance: 0.25,
    dateUrgency: 0.2,
    protectionValue: 0.2,
    mandatoryObligation: 0.15,
    consequenceOfDelay: 0.1,
    fundingGap: 0.05,
    dependency: 0.05,
  },
  scenarioAssumptions: {
    generic: { conservative: { returnRate: 0.02, costInflation: 0.035, contributionGrowth: 0 }, base: { returnRate: 0.045, costInflation: 0.025, contributionGrowth: 0.02 }, optimistic: { returnRate: 0.07, costInflation: 0.015, contributionGrowth: 0.04 } },
    education: { conservative: { returnRate: 0.02, costInflation: 0.07, contributionGrowth: 0 }, base: { returnRate: 0.04, costInflation: 0.05, contributionGrowth: 0.02 }, optimistic: { returnRate: 0.06, costInflation: 0.035, contributionGrowth: 0.04 } },
  },
  fxAssumptions: { AUD_INR: { conservative: 54, base: 57, optimistic: 60 }, INR_AUD: { conservative: 0.0167, base: 0.0175, optimistic: 0.0185 } },
};

// Minimal in-memory fake of the subset of the PostgREST query-builder chain
// that goalsData.ts (and everything it transitively calls: dashboardData.ts,
// resilienceData.ts, financialSectionStatusData.ts) actually uses. Any table
// not explicitly seeded behaves as empty/absent, which every real call site
// already handles gracefully via `?? []` / `?.` / `?? null`.
function makeFakeSupabase(tables: Record<string, unknown[]>) {
  function from(table: string) {
    let rows = [...(tables[table] ?? [])];
    const builder: any = {
      select() { return builder; },
      eq(col: string, val: unknown) { rows = rows.filter((r: any) => r[col] === val); return builder; },
      neq(col: string, val: unknown) { rows = rows.filter((r: any) => r[col] !== val); return builder; },
      in(col: string, vals: unknown[]) { rows = rows.filter((r: any) => vals.includes(r[col])); return builder; },
      is(col: string, val: unknown) { rows = rows.filter((r: any) => r[col] === val); return builder; },
      lte(col: string, val: string | number) { rows = rows.filter((r: any) => r[col] <= val); return builder; },
      not(col: string, _op: string, val: string) {
        // Only usage in this codepath is .not('status', 'in', '(archived,cancelled)').
        const excluded = val.replace(/[()]/g, '').split(',');
        rows = rows.filter((r: any) => !excluded.includes(r[col]));
        return builder;
      },
      order() { return builder; },
      limit(n: number) { rows = rows.slice(0, n); return builder; },
      // FDH-16 fix (FDH16-DEF-001): dashboardData.ts's loadDashboard() now
      // pages every register query via .range() (previously unpaginated,
      // silently capped at PostgREST's 1000-row default on real DEV). This
      // fake builder needs the same method so tests routed through
      // computeGoalsPagePayload() -> loadDashboard() keep working; sliced
      // faithfully (not a no-op) so it stays a correct stand-in at any scale.
      range(from: number, to: number) { rows = rows.slice(from, to + 1); return builder; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      insert() { return Promise.resolve({ data: null, error: null }); },
      update() { return Promise.resolve({ data: null, error: null }); },
      then(resolve: (v: { data: unknown[]; error: null }) => void) { resolve({ data: rows, error: null }); },
    };
    return builder;
  }
  return { from } as any;
}

const USER_ID = 'user-1';
const GOAL_ID = 'goal-1';
const INVESTMENT_ID = 'inv-1';

function baseTables(overrides: { investmentIsActive: boolean; currentAmount: number }) {
  return {
    user_goals: [
      {
        id: GOAL_ID,
        user_id: USER_ID,
        goal_name: 'Education Fund',
        goal_type: 'university_education',
        goal_category: 'family_education',
        status: 'active',
        target_amount: 200000,
        current_amount: overrides.currentAmount,
        currency_code: 'AUD',
        target_amount_basis: 'today_value',
        target_date_flexibility: 'fixed',
        planned_contribution_amount: 0,
        contribution_frequency: 'monthly',
        annual_contribution_growth_pct: 0,
        inflation_adjusted: true,
        inflation_category: 'education',
        user_priority: 3,
        importance_type: 'important',
      },
    ],
    goal_types: [
      {
        type_key: 'university_education',
        category: 'family_education',
        type_label: 'University Education',
        forecast_logic_key: 'education',
        default_priority: 4,
        default_importance_type: 'important',
        default_inflation_category: 'education',
        sort_order: 520,
        is_active: true,
      },
    ],
    goal_planning_config: [{ config: GOAL_PLANNING_CONFIG, is_active: true }],
    goal_funding_sources: [
      {
        id: 'fs-1',
        goal_id: GOAL_ID,
        user_id: USER_ID,
        source_type: 'investment',
        linked_asset_id: null,
        linked_investment_id: INVESTMENT_ID,
        linked_retirement_id: null,
        allocated_amount: 66000, // stale creation-time snapshot — must NOT be trusted once archived
        allocation_percentage: 60,
        currency_code: 'AUD',
        is_active: true,
      },
    ],
    goal_milestones: [],
    investments: [
      {
        id: INVESTMENT_ID,
        user_id: USER_ID,
        current_value: 110000,
        annual_contribution: 0,
        is_active: overrides.investmentIsActive,
      },
    ],
    assets: [],
    retirement_accounts: [],
    user_profiles: [{ user_id: USER_ID, preferred_currency: 'AUD' }],
  };
}

describe('computeGoalsPagePayload — archived linked investment', () => {
  it('credits the live linked investment value while the investment is active (60% of 110,000 + 10,000 manual = 76,000)', async () => {
    const client = makeFakeSupabase(baseTables({ investmentIsActive: true, currentAmount: 10000 }));
    const { payload } = await computeGoalsPagePayload(USER_ID, client);
    const goal = payload.goals.find((g) => g.id === GOAL_ID)!;
    expect(goal.currentAmount).toBeCloseTo(76000, 5);
  });

  it('drops the linked contribution to 0 once the investment is archived, leaving the manual amount untouched', async () => {
    const client = makeFakeSupabase(baseTables({ investmentIsActive: false, currentAmount: 10000 }));
    const { payload } = await computeGoalsPagePayload(USER_ID, client);
    const goal = payload.goals.find((g) => g.id === GOAL_ID)!;
    // Pre-fix this was 76000 (the bug); post-fix it must be exactly the
    // manual ledger amount with the archived investment's stale value gone.
    expect(goal.currentAmount).toBeCloseTo(10000, 5);
  });

  it('resumes the live linked contribution automatically once the investment is un-archived (no funding-source re-link needed)', async () => {
    const client = makeFakeSupabase(baseTables({ investmentIsActive: true, currentAmount: 10000 }));
    const { payload } = await computeGoalsPagePayload(USER_ID, client);
    const goal = payload.goals.find((g) => g.id === GOAL_ID)!;
    expect(goal.currentAmount).toBeCloseTo(76000, 5);
  });
});

// Direct pure-function coverage for computeLiveLinkedFundingValue itself —
// previously untested. currentValueById simulates the is_active-filtered
// lookup: an archived record's id is simply absent from the map, which is
// exactly what the fixed loadLinkedContributionSources() now produces.
describe('computeLiveLinkedFundingValue', () => {
  it('computes a percentage-based source against the live current value', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: 60, allocatedAmount: 66000 },
    ];
    const currentValueById = new Map([['inv-1', 110000]]);
    expect(computeLiveLinkedFundingValue(sources, currentValueById)).toBe(66000);
  });

  it('treats a linked record absent from currentValueById (archived, filtered out) as contributing 0', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: 60, allocatedAmount: 66000 },
    ];
    expect(computeLiveLinkedFundingValue(sources, new Map())).toBe(0);
  });

  it('uses the stored allocated_amount unchanged for fixed-amount sources regardless of currentValueById', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'investment', linkedAssetId: null, linkedInvestmentId: 'inv-1', linkedRetirementId: null, allocationPercentage: null, allocatedAmount: 5000 },
    ];
    expect(computeLiveLinkedFundingValue(sources, new Map())).toBe(5000);
  });

  it('ignores manual/cash/expected sources entirely', () => {
    const sources: LiveLinkedFundingSource[] = [
      { sourceType: 'manual', linkedAssetId: null, linkedInvestmentId: null, linkedRetirementId: null, allocationPercentage: null, allocatedAmount: 1000 },
    ];
    expect(computeLiveLinkedFundingValue(sources, new Map())).toBe(0);
  });
});
