// Deterministic section-inclusion rules (spec section 9). Kept separate from
// data-fetching so eligibility can be unit-tested without a database.

export type FreeSectionCode =
  | 'executive_summary'
  | 'cash_flow'
  | 'net_worth'
  | 'health_score'
  | 'financial_dna'
  | 'resilience'
  | 'goals'
  | 'commitments_timeline'
  | 'forecast'
  | 'financial_twin'
  | 'cross_border'
  | 'actions'
  | 'data_quality'
  | 'methodology';

// Premium-only sections (lib/engines/reportSectionsPremium.ts) — only ever
// built when the report's plan tier is 'premium'.
export type PremiumSectionCode =
  | 'twelve_month_trends'
  | 'score_diagnostic_full'
  | 'financial_dna_full'
  | 'investment_analysis'
  | 'retirement_readiness'
  | 'insurance_analysis'
  | 'goal_forecast_detail'
  | 'scenario_forecasting'
  | 'financial_twin_full'
  | 'cross_border_full'
  | 'stress_testing'
  | 'personal_action_plan'
  | 'appendices';

export type SectionCode = FreeSectionCode | PremiumSectionCode;

export type SectionStatus = 'included' | 'unavailable' | 'omitted';

export interface SectionEligibility {
  code: SectionCode;
  status: SectionStatus;
  reason: string | null;
}

export interface EligibilityInput {
  hasIncome: boolean;
  hasExpenses: boolean;
  hasAssets: boolean;
  hasLiabilities: boolean;
  hasHealthScore: boolean;
  hasDnaProfile: boolean;
  hasResilienceResult: boolean;
  hasActiveGoals: boolean;
  hasFinancialTwin: boolean; // true once the user has generated at least one Financial Twin run (Module 8)
  countriesInUseCount: number;
  hasActions: boolean;
}

export function computeSectionEligibility(input: EligibilityInput): SectionEligibility[] {
  const results: SectionEligibility[] = [];
  const add = (code: SectionCode, status: SectionStatus, reason: string | null = null) =>
    results.push({ code, status, reason });

  add('executive_summary', 'included');

  add(
    'cash_flow',
    input.hasIncome && input.hasExpenses ? 'included' : 'unavailable',
    input.hasIncome && input.hasExpenses ? null : 'Add income and expenses to include this section.'
  );

  add(
    'net_worth',
    input.hasAssets || input.hasLiabilities ? 'included' : 'unavailable',
    input.hasAssets || input.hasLiabilities ? null : 'Add assets or liabilities to include this section.'
  );

  add(
    'health_score',
    input.hasHealthScore ? 'included' : 'unavailable',
    input.hasHealthScore ? null : 'A Financial Health Score has not been calculated for this period.'
  );

  add(
    'financial_dna',
    input.hasDnaProfile ? 'included' : 'unavailable',
    input.hasDnaProfile ? null : 'A Financial DNA profile is not yet available.'
  );

  add(
    'resilience',
    input.hasResilienceResult ? 'included' : 'unavailable',
    input.hasResilienceResult ? null : 'A Financial Resilience result is not yet available.'
  );

  add(
    'goals',
    'included' // goals section is always included; it states "no active goals" when none exist rather than being omitted (persona G)
  );

  add(
    'commitments_timeline',
    'included' // always included, same reasoning as goals — states "no material upcoming commitments" when none exist
  );

  add(
    'forecast',
    input.hasActiveGoals ? 'included' : 'unavailable',
    input.hasActiveGoals ? null : 'No active goals with a forecast were found for this period.'
  );

  add(
    'financial_twin',
    input.hasFinancialTwin ? 'included' : 'unavailable',
    input.hasFinancialTwin ? null : 'No Financial Twin has been generated yet — visit the Financial Twin page to create one.'
  );

  add(
    'cross_border',
    input.countriesInUseCount > 1 ? 'included' : 'omitted',
    input.countriesInUseCount > 1 ? null : 'Recorded in a single country for this period.'
  );

  add(
    'actions',
    input.hasActions ? 'included' : 'unavailable',
    input.hasActions ? null : 'No deterministic recommendations were available for this period.'
  );

  add('data_quality', 'included');
  add('methodology', 'included');

  return results;
}

export interface OfficialReportEligibility {
  eligible: boolean;
  reason: string | null;
}

// Rule 2: a full Monthly Financial Health Report requires a valid Financial
// Health Score for the selected period (Persona F).
export function isEligibleForOfficialMonthlyReport(input: EligibilityInput): OfficialReportEligibility {
  if (!input.hasHealthScore) {
    return {
      eligible: false,
      reason: 'A Financial Health Score has not been calculated for this period yet. Calculate your score before generating the official monthly report.',
    };
  }
  if (!input.hasIncome || !input.hasExpenses) {
    return {
      eligible: false,
      reason: 'A monthly financial-health report requires income, expenses, assets, liabilities and a Financial Health Score for the selected period.',
    };
  }
  return { eligible: true, reason: null };
}
