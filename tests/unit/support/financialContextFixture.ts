// Module 11.2 test support — a fully-populated, all-CERTIFIED
// FinancialContextObject fixture, with a deep-merge override helper so each
// test only specifies what it changes. Mirrors the real shape from
// lib/ai/context/types.ts exactly (this file intentionally has no other
// dependency on production code, so a resolver bug can never be masked by a
// shared fixture bug).

import type {
  ContextDomain,
  DomainCertification,
  DomainCertificationMap,
  FinancialContextObject,
} from '@/lib/ai/context/types';

function cert(status: DomainCertification['status'], dataAsOf: string | null = '2026-08-01'): DomainCertification {
  return { status, reason: status === 'CERTIFIED' ? null : `test-${status.toLowerCase()}`, model_versions: ['test-1.0.0'], data_as_of: dataAsOf };
}

export function allCertified(): DomainCertificationMap {
  const domains: ContextDomain[] = ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'];
  return Object.fromEntries(domains.map((d) => [d, cert('CERTIFIED')])) as DomainCertificationMap;
}

export function makeContext(overrides: Partial<FinancialContextObject> = {}): FinancialContextObject {
  const base: FinancialContextObject = {
    meta: {
      context_version: 'test-context-1.0.0',
      generated_at: '2026-08-01T00:00:00.000Z',
      user_scope_identifier: 'usr_test',
      household_scope_identifier: 'usr_test',
      reporting_currency: 'AUD',
      country_of_residence: 'AU',
      data_as_of: '2026-08-01',
      snapshot_id: null,
      source_snapshot_version: 'dashboard-1.0.0',
      calculation_status: 'complete',
      integrity_status: 'CERTIFIED',
      currency_integrity_status: 'CERTIFIED',
      data_completeness: null,
      certification_status: 'CERTIFIED',
      request_scope: 'FULL',
    },
    household: { country_of_residence: 'AU', reporting_currency: 'AUD', household_type: 'couple', life_stage: null, number_of_adults: 2, number_of_dependants: 0, employment_status_summary: 'employed', housing_tenure_category: null, cross_border_indicator: false },
    cash_flow: { monthly_gross_income: 12000, monthly_net_income: 9000, monthly_expenses: 6000, essential_monthly_expenses: 4000, discretionary_monthly_expenses: 2000, debt_repayments: 500, insurance_premiums: 100, monthly_surplus_or_deficit: 3000, savings_rate: 0.3333, income_concentration: 0.6, fixed_commitment_ratio: null, data_as_of: '2026-08-01', calculation_version: 'dashboard-1.0.0' },
    balance_sheet: { total_assets: 900000, total_liabilities: 300000, net_worth: 600000, liquid_assets: 50000, property_assets: 700000, investment_assets: 100000, retirement_assets: 50000, property_concentration: 0.78, investment_concentration: 0.4, debt_breakdown: [{ debt_type: 'mortgage', balance: 300000 }], country_breakdown: [{ country_code: 'AU', value: 900000 }], currency_breakdown: [{ currency_code: 'AUD', value: 600000 }], data_as_of: '2026-08-01', calculation_version: 'dashboard-1.0.0' },
    health_score: { overall_score: 72, score_band: 'good', pillar_scores: [{ code: 'liquidity', score: 60, weight: 0.2 }], principal_drivers: ['liquidity'], prior_valid_score: 70, score_movement: 2, confidence: 0.9, calculation_date: '2026-08-01', model_version: 'score-1.0.0' },
    financial_dna: { primary_profile: 'BUILDER', secondary_profile: 'SAVER', driver_metrics: ['savings_rate'], confidence: 0.8, classification_date: '2026-08-01', model_version: 'dna-1.0.0' },
    resilience: { resilience_score: 65, resilience_status: 'moderate', emergency_fund_months: 3.5, liquidity_position: '40% liquid', income_concentration: 0.5, debt_pressure: 'DSR 20%', insurance_protection_status: 'has_cover_recorded', active_risks: [{ code: 'low_liquidity', category: 'liquidity', severity: 'medium' }], stress_test_outputs: [], confidence: 0.85, model_version: 'resilience-1.0.0' },
    investments: { total_investment_value: 100000, contribution_rate: 0.1, diversification_score: 0.7, institution_concentration: 0.3, country_allocation: [{ country_code: 'AU', value: 100000 }], dividend_monthly_income: 200, data_as_of: '2026-08-01', calculation_version: 'dashboard-1.0.0' },
    retirement: { retirement_balance: 50000, account_categories: [], employer_contribution_rate: 0.11, personal_contribution_rate: 0.02, data_as_of: '2026-08-01', calculation_version: 'dashboard-1.0.0' },
    insurance: { data_status: 'complete', active_cover_categories: ['life'], confirmed_no_cover_categories: [], missing_or_unknown_categories: [], premium_burden: 1200, confidence: 0.7 },
    goals: [
      { goal_reference: 'g1', goal_type: 'education', goal_status: 'active', target_amount: 50000, current_funding: 20000, contribution: 500, target_date: '2030-01-01', track_status: 'on_track', required_contribution: 480, forecast_completion_date: '2029-06-01', confidence: null, calculation_version: 'goals-1.0.0' },
      { goal_reference: 'g2', goal_type: 'holiday', goal_status: 'active', target_amount: 10000, current_funding: 1000, contribution: 100, target_date: '2027-01-01', track_status: 'at_risk', required_contribution: 400, forecast_completion_date: null, confidence: null, calculation_version: 'goals-1.0.0' },
    ],
    forecasts: [{ scenario_code: 'base', horizon_years: null, major_projected_metrics: {}, assumption_set_id: null, model_version: 'forecast-1.0.0', calculation_date: '2026-07-15', confidence: null, disclaimer: 'Modelled estimate, not guaranteed.' }],
    financial_twin: { peer_cohort_description: 'Dual-income couple, 30-40, AU', cohort_tier: 'mid', metrics: [], benchmark_source: null, benchmark_period: null, benchmark_version: null, benchmark_confidence: 0.75, status: 'confirmed' },
    risks: [],
    recommendations: [],
    reports: [{ report_id: 'r1', reporting_period: '2026-07', data_as_of: '2026-07-31', report_version: '1', executive_metrics: {}, major_findings: [], active_risks: [], goal_references: [], report_confidence: 0.9, template_version: null }],
    cross_border: { countries_present: ['AU'], currencies_present: ['AUD'], reporting_currency: 'AUD', local_country_totals: [{ country_code: 'AU', value: 900000 }], converted_totals: [{ country_code: 'AU', value_in_reporting_currency: 900000 }], fx_source: 'test', fx_rate_date: null, currency_mismatch_metrics: [], country_concentration: null, cross_border_goals: [], cross_border_debt_exposure: null },
    data_quality: { complete_domains: ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'], incomplete_domains: [], missing_fields: [], confirmed_zero_fields: [], stale_fields: [], rejected_records: [], excluded_duplicates: [], valuation_date_issues: [], unsupported_calculations: [], unavailable_modules: [], confidence_limitations: [] },
    domain_certification: allCertified(),
    source_references: [],
  };

  return { ...base, ...overrides };
}
