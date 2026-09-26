/**
 * WP-04 -- Score, DNA, Resilience, Goals and section status on ONE canonical
 * snapshot per request, with no failed read or unknown ratio scored as zero.
 *
 * Every test runs the real loaders (healthScoreData / financialDnaData /
 * resilienceData / goalsData / financialSectionStatusData) against the
 * in-memory PostgREST fake, using the golden pair (Household M entered by
 * hand, Household I imported, identical economics).
 *
 * NEGATIVE CONTROL: run unchanged against the base branch
 * (feature/canonical-upload-foundation @ f79374f); the failures it produced
 * there are listed in the WP-04 report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/read-models/snapshot', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/read-models/snapshot')>();
  return { ...mod, buildCanonicalFinancialSnapshot: vi.fn(mod.buildCanonicalFinancialSnapshot) };
});
vi.mock('@/lib/engines/dashboard', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/engines/dashboard')>();
  return { ...mod, computeDashboard: vi.fn(mod.computeDashboard) };
});

import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { buildHealthScoreInput, loadHealthScore } from '@/lib/services/healthScoreData';
import { buildDnaInput } from '@/lib/services/financialDnaData';
import { buildResilienceInput } from '@/lib/services/resilienceData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { loadDashboard } from '@/lib/services/dashboardData';
import { loadSectionStatus } from '@/lib/services/financialSectionStatusData';
import { computeHealthScore, type HealthScoreConfig } from '@/lib/engines/healthScore';
import { classifyFinancialDna, type DnaConfig } from '@/lib/engines/financialDna';
import { computeResilience, type ResilienceConfig } from '@/lib/engines/resilience';
import { ALL_SECTIONS, effectiveSectionStatus, type FinancialSection, type FinancialSectionStatus } from '@/lib/engines/financialSectionStatus';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, USER } from './readModels/helpers/fixtures';
import { householdI, householdM } from './readModels/helpers/goldenPair';

// Seed configs -- copied from the engines' own unit tests (which mirror the
// seed migrations 0006 / 0007 / 0008 / 0009).
const HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  componentWeights: { cash_flow: 0.15, savings: 0.12, emergency_fund: 0.12, debt: 0.15, net_worth: 0.1, investment: 0.08, retirement: 0.1, insurance: 0.08, resilience: 0.05, behaviour: 0.05 },
  scoreBands: [
    { min: 85, band: 'excellent', label: 'Excellent' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'fair', label: 'Fair' },
    { min: 40, band: 'needs_attention', label: 'Needs Attention' },
    { min: 0, band: 'critical', label: 'Critical' },
  ],
  riskOverride: { deficitMonthsThreshold: 2, emergencyMonthsThreshold: 1, scoreCap: 49 },
};
const DNA_CONFIG: DnaConfig = {
  dimensionWeights: { savings_discipline: 0.15, spending_pattern: 0.12, debt_structure: 0.15, asset_allocation: 0.15, investment_behaviour: 0.12, liquidity_position: 0.1, retirement_preparation: 0.08, income_capacity: 0.08, protection_planning: 0.05 },
  secondaryThreshold: { minScore: 55, maxGapFromPrimary: 20 },
  profileChangeThreshold: 5,
  confidenceWeights: { dataCompleteness: 0.4, signalConsistency: 0.3, separation: 0.2, recency: 0.1 },
  confidenceBands: [
    { min: 85, band: 'very_high', label: 'Very high' },
    { min: 70, band: 'high', label: 'High' },
    { min: 55, band: 'moderate', label: 'Moderate' },
    { min: 40, band: 'low', label: 'Low' },
    { min: 0, band: 'insufficient', label: 'Insufficient for confirmed classification' },
  ],
};
const RESILIENCE_CONFIG: ResilienceConfig = {
  componentWeights: { emergency_fund: 0.25, liquidity: 0.15, income_resilience: 0.15, insurance_protection: 0.2, debt_pressure: 0.15, concentration_risk: 0.1 },
  scoreBands: [
    { min: 85, band: 'highly_resilient', label: 'Highly Resilient' },
    { min: 70, band: 'resilient', label: 'Resilient' },
    { min: 55, band: 'moderately_vulnerable', label: 'Moderately Vulnerable' },
    { min: 40, band: 'vulnerable', label: 'Vulnerable' },
    { min: 0, band: 'fragile', label: 'Fragile' },
  ],
  confidenceWeights: { incomeCompleteness: 0.15, expenseCompleteness: 0.15, liquidAssetCompleteness: 0.2, liabilityCompleteness: 0.15, insuranceCompleteness: 0.2, dataRecency: 0.1, verificationHistory: 0.05 },
  riskOverride: { scoreCapPrimary: 49, scoreCapSecondary: 59, criticalLiquidityWeeks: 2, refinanceExposureMonths: 6 },
};
const GOAL_CONFIG = { affordabilityThresholds: { comfortableMax: 0.6, manageableMax: 0.85, tightMax: 1.0 } };

function withConfigs(t: Record<string, Row[]>): Record<string, Row[]> {
  return tables(t, {
    health_score_config: [{ config: HEALTH_SCORE_CONFIG, is_active: true }],
    financial_dna_config: [{ config: DNA_CONFIG, is_active: true }],
    resilience_config: [{ config: RESILIENCE_CONFIG, is_active: true }],
    goal_planning_config: [{ config: GOAL_CONFIG, is_active: true }],
    // Both households have explicitly confirmed their income and expenses
    // (Phase 0C: the savings component needs a REVIEWED expenses section).
    // For Household I this confirmation only counts once its imported
    // expenses count as data (DC-05): otherwise it stays 'not_started'.
    user_financial_section_status: [
      { user_id: USER, section: 'income', status: 'reviewed_with_data' },
      { user_id: USER, section: 'expenses', status: 'reviewed_with_data' },
    ],
  });
}

const client = (t: Record<string, Row[]>, options: Parameters<typeof makeFakeSupabase>[1] = {}) => makeFakeSupabase(withConfigs(t), options).client as never;

afterEach(() => {
  vi.mocked(buildCanonicalFinancialSnapshot).mockClear();
  vi.mocked(computeDashboard).mockClear();
});

describe('the imported-only Household I gets the same downstream answers as Household M', () => {
  for (const [name, household] of [['M', householdM], ['I', householdI]] as const) {
    it(`${name}: Score cash_flow and savings are scored, not missing`, async () => {
      const input = await buildHealthScoreInput(USER, client(household()));
      const score = computeHealthScore(input);
      for (const code of ['cash_flow', 'savings'] as const) {
        expect(score.components.find((c) => c.code === code)?.treatment, `${name}.${code}`).toBe('scored');
      }
    });
  }

  it('Score, DNA, Resilience, Goals surplus and section status are IDENTICAL for M and I', async () => {
    const run = async (t: Record<string, Row[]>) => {
      const c = client(t);
      const score = computeHealthScore(await buildHealthScoreInput(USER, c));
      const dna = classifyFinancialDna(await buildDnaInput(USER, c));
      const resilience = computeResilience(await buildResilienceInput(USER, c));
      const goals = (await computeGoalsPagePayload(USER, c)).payload;
      const status = await loadSectionStatus(USER, await loadDashboard(USER, c), c);
      return { score, dna, resilience, goals, status };
    };
    const m = await run(householdM());
    const i = await run(householdI());

    expect(i.score.components.map((c) => [c.code, c.treatment, c.rawScore])).toEqual(m.score.components.map((c) => [c.code, c.treatment, c.rawScore]));
    expect(i.score.overallScore).toBe(m.score.overallScore);

    expect(i.dna.status).not.toBe('insufficient_data');
    expect(i.dna.primaryProfileCode).toBe(m.dna.primaryProfileCode);

    expect(i.resilience.confidence).toBeGreaterThan(0);
    expect(i.resilience.components.find((c) => c.code === 'emergency_fund')?.treatment).toBe('scored');
    expect(i.resilience.overallScore).toBe(m.resilience.overallScore);

    expect(i.goals.affordability.monthlySurplus).toBe(1900);
    expect(m.goals.affordability.monthlySurplus).toBe(1900);

    expect(i.status.expenses).toBe('reviewed_with_data');
    expect(i.status).toEqual(m.status);
  });
});

describe('one canonical snapshot per request (DC-15)', () => {
  it('a Score request builds the snapshot ONCE and computes the Dashboard ONCE (it used to run it twice)', async () => {
    await loadHealthScore(USER, client(householdI()));
    expect(vi.mocked(buildCanonicalFinancialSnapshot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(computeDashboard)).toHaveBeenCalledTimes(1);
  });

  it('the Goals payload builds it once too (Dashboard + Resilience used to be two computations)', async () => {
    await computeGoalsPagePayload(USER, client(householdI()));
    expect(vi.mocked(computeDashboard)).toHaveBeenCalledTimes(1);
  });
});

describe('a failed read or an unknown ratio is never scored as zero (DC-14)', () => {
  it('a forced FX-read error gives MISSING components, not a score from zeros', async () => {
    const input = await buildHealthScoreInput(USER, client(householdM(), { failOn: new Set(['forecast_global_assumptions']) }));
    const score = computeHealthScore(input);
    for (const code of ['cash_flow', 'savings', 'emergency_fund', 'debt'] as const) {
      const c = score.components.find((x) => x.code === code);
      expect(c?.treatment, code).not.toBe('scored');
      expect(c?.rawScore, code).toBeNull();
    }
  });

  it('a null debt-service ratio (liabilities on file, no income) is a missing Debt component -- it used to score 100', () => {
    const empty: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [] };
    const dashboard = computeDashboard({
      ...empty,
      expenses: [{ expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true }],
      liabilities: [{ balance: 20000, interest_rate: 9, monthly_repayment: 600, debt_type: 'personal_loan' }],
    }, 'AUD');
    expect(dashboard.debtServiceRatio).toBeNull();
    const sectionStatus = {} as Record<FinancialSection, FinancialSectionStatus>;
    const hasRows: Record<FinancialSection, boolean> = { household: true, income: false, expenses: true, assets: false, liabilities: true, investments: false, retirement: false, insurance: false };
    for (const s of ALL_SECTIONS) sectionStatus[s] = effectiveSectionStatus({ hasRows: hasRows[s], explicitConfirmation: null });
    const score = computeHealthScore({ dashboard, age: 40, dependantsCount: 0, isSelfEmployed: false, checkIns: null, resilienceResult: null, config: HEALTH_SCORE_CONFIG, sectionStatus });
    const debt = score.components.find((c) => c.code === 'debt');
    expect(debt?.treatment).toBe('missing_data');
    expect(debt?.rawScore).toBeNull();
  });

  it('an unreadable commitments list makes the Resilience emergency-fund component missing, not flattered', async () => {
    const input = await buildResilienceInput(USER, client(householdM(), { failOn: new Set(['future_financial_commitments']) }));
    expect(input.commitmentsAvailable).toBe(false);
    const result = computeResilience(input);
    expect(result.components.find((c) => c.code === 'emergency_fund')?.rawScore).toBeNull();
  });

  it('an unreadable linked funding source fails the Goals load explicitly instead of counting $0', async () => {
    const t = tables(householdM(), {
      user_goals: [{ id: 'g1', user_id: USER, goal_name: 'House', goal_type: 'home_deposit', target_amount: 100000, current_amount: 0, currency_code: 'AUD', status: 'active', target_date: null, priority: 'high' }],
      goal_funding_sources: [{ id: 'fs', user_id: USER, goal_id: 'g1', source_type: 'investment', linked_investment_id: 'inv', linked_asset_id: null, linked_retirement_id: null, allocation_percentage: 50, allocated_amount: 0, is_active: true }],
    });
    // The Investments read model fails (its holdings read), while the plain
    // register read the Dashboard also makes still succeeds -- so the only
    // thing that can fail this load is the linked-source path itself.
    await expect(computeGoalsPagePayload(USER, client(t, { failOn: new Set(['ii_holding_snapshots']) }))).rejects.toThrow(/investments could not be read/);
  });
});
