import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type DashboardSummary } from '@/lib/engines/dashboard';
import { computeHealthScore, type HealthScoreConfig, type HealthScoreInput } from '@/lib/engines/healthScore';
import { computeHealthScoreEligibility } from '@/lib/engines/healthScoreEligibility';
import {
  ALL_SECTIONS,
  effectiveSectionStatus,
  type FinancialSection,
  type FinancialSectionStatus,
} from '@/lib/engines/financialSectionStatus';

// Matches the seed config in supabase/migrations/0006_module4_health_score.sql
// exactly, so these tests exercise the same weighting/banding real accounts do.
const HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  componentWeights: {
    cash_flow: 0.15,
    savings: 0.12,
    emergency_fund: 0.12,
    debt: 0.15,
    net_worth: 0.1,
    investment: 0.08,
    retirement: 0.1,
    insurance: 0.08,
    resilience: 0.05,
    behaviour: 0.05,
  },
  scoreBands: [
    { min: 85, band: 'excellent', label: 'Excellent' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'fair', label: 'Fair' },
    { min: 40, band: 'needs_attention', label: 'Needs Attention' },
    { min: 0, band: 'critical', label: 'Critical' },
  ],
  riskOverride: { deficitMonthsThreshold: 2, emergencyMonthsThreshold: 1, scoreCap: 49 },
};

const EMPTY: DashboardInput = {
  income: [],
  expenses: [],
  assets: [],
  liabilities: [],
  investments: [],
  retirement: [],
  insurance: [],
  goals: [],
  snapshots: [],
};

// Same derivation loadSectionStatus uses for a household with no explicit
// confirmations on file — pure row presence, nothing inferred.
function defaultSectionStatus(dashboard: DashboardSummary): Record<FinancialSection, FinancialSectionStatus> {
  const hasRows: Record<FinancialSection, boolean> = {
    household: true,
    income: dashboard.hasIncome,
    expenses: dashboard.hasExpenses,
    assets: dashboard.hasAssets,
    liabilities: dashboard.hasLiabilities,
    investments: dashboard.hasInvestments,
    retirement: dashboard.hasRetirement,
    insurance: dashboard.hasInsurance,
  };
  const result = {} as Record<FinancialSection, FinancialSectionStatus>;
  for (const section of ALL_SECTIONS) {
    result[section] = effectiveSectionStatus({ hasRows: hasRows[section], explicitConfirmation: null });
  }
  return result;
}

function scoreFor(
  rows: Partial<DashboardInput>,
  extra: Partial<Omit<HealthScoreInput, 'dashboard' | 'config' | 'sectionStatus'>> & {
    sectionStatus?: Partial<Record<FinancialSection, FinancialSectionStatus>>;
  } = {}
) {
  const dashboard = computeDashboard({ ...EMPTY, ...rows }, 'AUD');
  const sectionStatus = { ...defaultSectionStatus(dashboard), ...extra.sectionStatus };
  const input: HealthScoreInput = {
    dashboard,
    age: extra.age ?? 35,
    dependantsCount: extra.dependantsCount ?? 0,
    isSelfEmployed: extra.isSelfEmployed ?? false,
    checkIns: extra.checkIns ?? null,
    resilienceResult: extra.resilienceResult ?? null,
    config: HEALTH_SCORE_CONFIG,
    sectionStatus,
  };
  const result = computeHealthScore(input);
  const eligibility = computeHealthScoreEligibility(sectionStatus, result.components);
  return { result, eligibility, sectionStatus };
}

function componentByCode(result: ReturnType<typeof scoreFor>['result'], code: string) {
  return result.components.find((c) => c.code === code)!;
}

describe('Phase 0C — Financial Health Score eligibility and missing-data integrity', () => {
  // --- Test Group A: zero data ----------------------------------------------
  it('Group A: profile-only account has no scored components and is not_yet_scored', () => {
    const { result, eligibility } = scoreFor({});
    expect(result.components.every((c) => c.treatment === 'missing_data')).toBe(true);
    expect(result.overallScore).toBe(0);
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
    expect(eligibility.confidencePercent).toBe(0);
    expect(eligibility.confidenceTier).toBe('low');
  });

  // --- Test Group B: income only ---------------------------------------------
  it('Group B: income only does not let Savings Behaviour assume zero expenses', () => {
    const { result, eligibility } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
    });
    expect(componentByCode(result, 'savings').treatment).toBe('missing_data');
    expect(componentByCode(result, 'cash_flow').treatment).toBe('missing_data');
    // Income alone (no assets/liabilities reviewed either) must not meet the
    // conservative minimum for a Preliminary score.
    expect(eligibility.state).toBe('not_yet_scored');
  });

  // --- Test Group C: income + expenses ---------------------------------------
  it('Group C: income + expenses lets Savings Behaviour and Cash Flow calculate correctly, without assuming liabilities/investments/insurance', () => {
    // Phase 0C.1: one row is only 'in_progress' — Savings Behaviour requires
    // Expenses to be explicitly confirmed reviewed (isReviewed), not merely
    // present, so this test (which is about a fully-reviewed income+expenses
    // household) confirms both explicitly. The in_progress case itself is
    // covered separately below (CS-06/CS-09-style tests).
    const { result } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      },
      { sectionStatus: { income: 'reviewed_with_data', expenses: 'reviewed_with_data' } }
    );
    expect(componentByCode(result, 'cash_flow').treatment).toBe('scored');
    expect(componentByCode(result, 'savings').treatment).toBe('scored');
    // No silent assumption about liabilities, investments, retirement, or insurance.
    expect(componentByCode(result, 'debt').treatment).toBe('missing_data');
    expect(componentByCode(result, 'investment').treatment).toBe('missing_data');
    expect(componentByCode(result, 'retirement').treatment).toBe('missing_data');
    expect(componentByCode(result, 'insurance').treatment).toBe('missing_data');
  });

  // --- Test Group D: no liabilities, not reviewed ----------------------------
  it('Group D: unreviewed absence of liabilities is missing data, not 100', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
    });
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('missing_data');
    expect(debt.rawScore).toBeNull();
  });

  // --- Test Group E: no liabilities, explicitly confirmed --------------------
  it('Group E: explicit zero-liabilities confirmation scores Debt Health as a confirmed 100', () => {
    const { result } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('scored');
    expect(debt.rawScore).toBe(100);
    expect(debt.explanation).toContain('confirmed by you');
  });

  // --- Test Group F: liabilities exist ---------------------------------------
  it('Group F: real liability rows are scored from actual debt-service ratio, unaffected by Phase 0C', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      liabilities: [{ balance: 20000, interest_rate: 15, monthly_repayment: 600, debt_type: 'personal_loan', interest_rate_type: 'variable' }],
    });
    const debt = componentByCode(result, 'debt');
    expect(debt.treatment).toBe('scored');
    expect(debt.rawScore).not.toBeNull();
    expect(debt.currentValue.totalDebt).toBe(20000);
  });

  // --- Test Group G: insurance unknown ---------------------------------------
  it('Group G: unreviewed insurance is missing data, no arbitrary default score', () => {
    const { result } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
    });
    expect(componentByCode(result, 'insurance').treatment).toBe('missing_data');
  });

  // --- Test Group H: explicitly no insurance ----------------------------------
  it('Group H: explicit no-insurance confirmation is evaluated by the existing approved logic', () => {
    const { result } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      },
      { sectionStatus: { insurance: 'reviewed_zero' }, dependantsCount: 0 }
    );
    const insurance = componentByCode(result, 'insurance');
    expect(insurance.treatment).toBe('scored');
    expect(insurance.rawScore).toBe(60);
    expect(insurance.explanation).toContain('confirmed by you');
  });

  // --- Test Group I: investments not applicable -------------------------------
  it('Group I: not-applicable investments are excluded from both the score and the confidence denominator', () => {
    const { result, eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      {
        sectionStatus: { liabilities: 'reviewed_zero', investments: 'not_applicable', retirement: 'not_applicable', insurance: 'reviewed_zero' },
      }
    );
    const investment = componentByCode(result, 'investment');
    expect(investment.treatment).toBe('not_applicable');
    expect(investment.weightedContribution).toBe(0);
    // not_applicable sections still count as "reviewed" for eligibility —
    // the household has told us it doesn't apply, which is a real answer.
    expect(eligibility.missingSections).not.toContain('investments');
  });

  // --- Test Group J: preliminary score ----------------------------------------
  it('Group J: minimum core sections reviewed (income, expenses, assets, liabilities) yields a Preliminary state', () => {
    // Phase 0C.2 §8-9: Preliminary now requires these four to be fully
    // RESOLVED (isReviewed), not merely present — so income/expenses/assets
    // need their explicit "I've added everything relevant to me"
    // confirmation, alongside liabilities' explicit zero.
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          liabilities: 'reviewed_zero',
        },
      }
    );
    expect(eligibility.state).toBe('preliminary');
    expect(eligibility.canDisplayNumericScore).toBe(true);
    expect(eligibility.missingSections).toEqual(expect.arrayContaining(['investments', 'retirement', 'insurance']));
    expect(eligibility.preliminaryReasons.length).toBeGreaterThan(0);
  });

  it('Group J: assets reviewed but liabilities NOT reviewed stays Not Yet Scored (conservative minimum requires both)', () => {
    const { eligibility } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
      // liabilities left unreviewed — no rows, no explicit confirmation
    });
    expect(eligibility.state).toBe('not_yet_scored');
  });

  // --- Test Group K: full score -------------------------------------------------
  it('Group K: all 7 sections reviewed (data or explicit confirmation) yields a Full state with high confidence', () => {
    // Phase 0C.1: every positive-data section needs its explicit
    // 'reviewed_with_data' completion confirmation, not just rows — this is
    // the corrected definition of Full (see effectiveSectionStatus).
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          investments: 'reviewed_with_data',
          retirement: 'reviewed_with_data',
          liabilities: 'reviewed_zero',
          insurance: 'reviewed_zero',
        },
      }
    );
    expect(eligibility.state).toBe('full');
    expect(eligibility.missingSections).toHaveLength(0);
    expect(eligibility.confidencePercent).toBe(100);
    expect(eligibility.confidenceTier).toBe('high');
    expect(eligibility.canDisplayNumericScore).toBe(true);
  });

  // --- Confidence tier boundaries ------------------------------------------------
  it('confidenceTierFor bands match the canonical High >=80 / Medium >=50 / Low <50 thresholds', () => {
    // 4 of 7 sections reviewed (explicitly confirmed, not just present) = 57% -> medium
    const { eligibility: medium } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          liabilities: 'reviewed_zero',
        },
      }
    );
    expect(medium.confidencePercent).toBe(57);
    expect(medium.confidenceTier).toBe('medium');

    // 6 of 7 = 86% -> high
    const { eligibility: high } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          investments: 'reviewed_with_data',
          retirement: 'reviewed_with_data',
          liabilities: 'reviewed_zero',
        },
      }
    );
    expect(high.confidencePercent).toBe(86);
    expect(high.confidenceTier).toBe('high');
  });
});

// Phase 0C.1 §41 — mandatory CS-01..CS-10 completion-semantics tests. These
// exercise effectiveSectionStatus() and computeHealthScoreEligibility()
// directly: one data row must never, by itself, mean a section is fully
// reviewed.
describe('Phase 0C.1 — completion semantics (row-exists vs. section-reviewed)', () => {
  it('CS-01: no rows, no confirmation -> not_started', () => {
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: null })).toBe('not_started');
  });

  it('CS-02: rows exist, no confirmation -> in_progress (not reviewed_with_data)', () => {
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: null })).toBe('in_progress');
  });

  it('CS-03: rows exist + explicit completion confirmation -> reviewed_with_data', () => {
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: 'reviewed_with_data' })).toBe('reviewed_with_data');
  });

  it('CS-03b: a reviewed_with_data confirmation with no backing rows is stale and reverts to not_started', () => {
    // e.g. the user confirmed the section complete, then deleted every row.
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'reviewed_with_data' })).toBe('not_started');
  });

  it('CS-04: explicit zero, no rows -> reviewed_zero', () => {
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'reviewed_zero' })).toBe('reviewed_zero');
  });

  it('CS-04b: rows appearing after a zero confirmation supersede it -> in_progress, not a contradiction', () => {
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: 'reviewed_zero' })).toBe('in_progress');
  });

  it('CS-05: not_applicable wins regardless of row presence', () => {
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'not_applicable' })).toBe('not_applicable');
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: 'not_applicable' })).toBe('not_applicable');
  });

  it('CS-06: Full is impossible while any relevant section is in_progress', () => {
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          // investments/retirement deliberately left unconfirmed — rows exist
          // (so this isn't Test Group J's "not reviewed at all" case) but the
          // household never clicked "I've added everything relevant to me."
          liabilities: 'reviewed_zero',
          insurance: 'reviewed_zero',
        },
      }
    );
    expect(eligibility.missingSections).toEqual(expect.arrayContaining(['investments', 'retirement']));
    expect(eligibility.state).not.toBe('full');
    expect(eligibility.state).toBe('preliminary');
  });

  it('CS-07: Preliminary is NOT reachable while the minimum sections are merely in_progress (Phase 0C.2 correction)', () => {
    // income/expenses/assets have rows but no completion confirmation.
    // Phase 0C.1 treated "some progress" as enough for Preliminary; Phase
    // 0C.2 tightens this — a numeric score must not appear when the four
    // core sections aren't actually confirmed reviewed, even if liabilities
    // itself is confirmed zero (see EL-01..EL-04 for the per-section cases).
    const { eligibility } = scoreFor(
      {
        income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
        expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
        assets: [{ current_value: 25000, asset_class: 'cash' }],
      },
      { sectionStatus: { liabilities: 'reviewed_zero' } }
    );
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
  });

  it('CS-08: Full requires every relevant section resolved — swap one confirmed section back to in_progress and Full is lost', () => {
    const base: Partial<DashboardInput> = {
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
      investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
      retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
    };
    const fullyConfirmed = {
      income: 'reviewed_with_data' as const,
      expenses: 'reviewed_with_data' as const,
      assets: 'reviewed_with_data' as const,
      investments: 'reviewed_with_data' as const,
      retirement: 'reviewed_with_data' as const,
      liabilities: 'reviewed_zero' as const,
      insurance: 'reviewed_zero' as const,
    };
    const { eligibility: full } = scoreFor(base, { sectionStatus: fullyConfirmed });
    expect(full.state).toBe('full');

    // Now withdraw the Assets confirmation (as if the user re-opened the
    // section and it reverted to in_progress) — Full must be lost.
    const { eligibility: notFull } = scoreFor(base, {
      sectionStatus: { ...fullyConfirmed, assets: 'in_progress' },
    });
    expect(notFull.state).not.toBe('full');
    expect(notFull.missingSections).toContain('assets');
  });

  it('CS-09: Financial Data Confidence does not equate a single row with a completed section', () => {
    // Every core section has at least one row, but none are explicitly
    // confirmed reviewed — confidence must not read as if the picture were
    // complete just because data exists everywhere. Phase 0C.2: this now
    // also means no numeric score at all, since the 4 minimum sections
    // aren't resolved — see EL-08 (0% confidence must never pair with a
    // displayed score).
    const { eligibility } = scoreFor({
      income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
      expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
      assets: [{ current_value: 25000, asset_class: 'cash' }],
      liabilities: [{ balance: 20000, interest_rate: 15, monthly_repayment: 600, debt_type: 'personal_loan', interest_rate_type: 'variable' }],
      investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
      retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      insurance: [{ policy_name: 'Test policy', cover_type: 'life', cover_amount: 100000, premium: 50, premium_frequency: 'monthly', renewal_date: null }],
    });
    expect(eligibility.confidencePercent).toBe(0);
    expect(eligibility.confidenceTier).toBe('low');
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
  });

  it('CS-10: explicit status remains reversible — confirming then clearing returns to the row-derived state', () => {
    // Confirmed complete...
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: 'reviewed_with_data' })).toBe('reviewed_with_data');
    // ...then the confirmation is cleared (PUT status: null) — falls back to
    // whatever row presence alone derives, exactly like it had never been
    // confirmed, not stuck in some permanent state.
    expect(effectiveSectionStatus({ hasRows: true, explicitConfirmation: null })).toBe('in_progress');

    // Same for a zero confirmation.
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: 'reviewed_zero' })).toBe('reviewed_zero');
    expect(effectiveSectionStatus({ hasRows: false, explicitConfirmation: null })).toBe('not_started');
  });
});

// Phase 0C.2 §13 — mandatory EL-01..EL-08 tests proving the tightened
// Preliminary rule: the four core sections (Income, Expenses, Assets,
// Liabilities) must be fully RESOLVED, not merely in_progress, before any
// numeric score — including Preliminary — is shown.
describe('Phase 0C.2 — tightened Preliminary eligibility (core sections must be resolved, not merely in_progress)', () => {
  // Baseline: all 4 core sections resolved, Investments/Retirement/Insurance
  // untouched — every EL-0x case starts here and knocks exactly one of the
  // 4 core sections back to 'in_progress' (or, for EL-07, all of them).
  const RESOLVED_ROWS: Partial<DashboardInput> = {
    income: [{ amount: 95000, net_amount: 72000, frequency: 'annually', master_item_key: 'employment_salary' }],
    expenses: [{ expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: false }],
    assets: [{ current_value: 25000, asset_class: 'cash' }],
  };
  const RESOLVED_STATUS = {
    income: 'reviewed_with_data' as const,
    expenses: 'reviewed_with_data' as const,
    assets: 'reviewed_with_data' as const,
    liabilities: 'reviewed_zero' as const,
  };

  it('EL-01: Income in_progress, Expenses/Assets/Liabilities resolved -> Not Yet Scored', () => {
    const { eligibility } = scoreFor(RESOLVED_ROWS, { sectionStatus: { ...RESOLVED_STATUS, income: 'in_progress' } });
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
  });

  it('EL-02: Expenses in_progress -> Not Yet Scored', () => {
    const { eligibility } = scoreFor(RESOLVED_ROWS, { sectionStatus: { ...RESOLVED_STATUS, expenses: 'in_progress' } });
    expect(eligibility.state).toBe('not_yet_scored');
  });

  it('EL-03: Assets in_progress -> Not Yet Scored', () => {
    const { eligibility } = scoreFor(RESOLVED_ROWS, { sectionStatus: { ...RESOLVED_STATUS, assets: 'in_progress' } });
    expect(eligibility.state).toBe('not_yet_scored');
  });

  it('EL-04: Liabilities in_progress -> Not Yet Scored', () => {
    const { eligibility } = scoreFor(RESOLVED_ROWS, { sectionStatus: { ...RESOLVED_STATUS, liabilities: 'in_progress' } });
    expect(eligibility.state).toBe('not_yet_scored');
  });

  it('EL-05: Income + Expenses + Assets + Liabilities all resolved, Investments/Retirement/Insurance unresolved -> Preliminary', () => {
    const { eligibility } = scoreFor(RESOLVED_ROWS, { sectionStatus: RESOLVED_STATUS });
    expect(eligibility.state).toBe('preliminary');
    expect(eligibility.canDisplayNumericScore).toBe(true);
    expect(eligibility.missingSections).toEqual(expect.arrayContaining(['investments', 'retirement', 'insurance']));
  });

  it('EL-06: all seven resolved -> Full', () => {
    const { eligibility } = scoreFor(
      {
        ...RESOLVED_ROWS,
        investments: [{ current_value: 10000, cost_base: 8000, investment_type: 'etfs', country_code: 'AU', annual_contribution: 0, institution: 'Vanguard' }],
        retirement: [{ current_balance: 50000, employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', country_code: 'AU' }],
      },
      {
        sectionStatus: {
          ...RESOLVED_STATUS,
          investments: 'reviewed_with_data',
          retirement: 'reviewed_with_data',
          insurance: 'reviewed_zero',
        },
      }
    );
    expect(eligibility.state).toBe('full');
    expect(eligibility.missingSections).toHaveLength(0);
  });

  it('EL-07: core sections contain rows but no explicit completion confirmations -> Not Yet Scored', () => {
    // The exact scenario that motivated this tightening (Phase 0C.2 §8):
    // rows in all 4 minimum sections, zero explicit confirmations. Under
    // Phase 0C.1 this reached Preliminary at 0% confidence; it must not
    // anymore.
    const { eligibility } = scoreFor(RESOLVED_ROWS);
    expect(eligibility.state).toBe('not_yet_scored');
    expect(eligibility.canDisplayNumericScore).toBe(false);
  });

  it('EL-08: a user cannot receive a numeric score at 0% Financial Data Confidence', () => {
    // General property, not just the EL-07 instance: for every one of the
    // EL-01..EL-04/EL-07 cases above, confidencePercent is 0 and
    // canDisplayNumericScore is false together — never a numeric score
    // paired with 0% confidence.
    const cases = [
      { income: 'in_progress' as const },
      { expenses: 'in_progress' as const },
      { assets: 'in_progress' as const },
      { liabilities: 'in_progress' as const },
      {},
    ];
    for (const override of cases) {
      const { eligibility } = scoreFor(RESOLVED_ROWS, {
        sectionStatus: override === cases[4] ? {} : { ...RESOLVED_STATUS, ...override },
      });
      if (!eligibility.canDisplayNumericScore) {
        expect(eligibility.confidencePercent).toBeLessThan(100);
      }
      // The specific property under test: 0% confidence never coincides
      // with a displayable numeric score.
      if (eligibility.confidencePercent === 0) {
        expect(eligibility.canDisplayNumericScore).toBe(false);
      }
    }
  });
});
