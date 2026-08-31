// Module 11.0 — Canonical Financial Context Object contract.
//
// This is the ONLY shape of financial data any AI provider adapter is ever
// allowed to see (see ADR-M11-001, docs/architecture/ADR-M11-001-governed-ai-
// explanation-architecture.md). Every field here is populated by reading an
// EXISTING certified FHIP engine/service output — nothing in this file is
// computed fresh. Fields that a given household has no certified data for
// are `null`/omitted, never fabricated as zero (spec section 23: "do not
// treat missing information as zero").
//
// context_size controls how much of this object a given caller receives —
// see lib/ai/context/contextSize.ts. MINIMAL/DOMAIN modes omit whole
// sections; this type describes the FULL shape all modes are a subset of.

export type CertificationState = 'CERTIFIED' | 'PARTIAL' | 'STALE' | 'INVALID' | 'UNAVAILABLE';

export type ContextSizeMode = 'MINIMAL' | 'DOMAIN' | 'FULL';

export type ContextDomain =
  | 'cash_flow'
  | 'balance_sheet'
  | 'score'
  | 'financial_dna'
  | 'resilience'
  | 'investments'
  | 'retirement'
  | 'insurance'
  | 'goals'
  | 'forecasts'
  | 'financial_twin'
  | 'reports'
  | 'cross_border';

// ---------------------------------------------------------------------------
// Domain-level certification (spec section 24)
// ---------------------------------------------------------------------------
export interface DomainCertification {
  status: CertificationState;
  /** Human-readable reason, always present for non-CERTIFIED states. */
  reason: string | null;
  /** model_version(s) of the certified engine(s) this domain's data came from. */
  model_versions: string[];
  data_as_of: string | null;
}

export type DomainCertificationMap = Record<ContextDomain, DomainCertification>;

// ---------------------------------------------------------------------------
// Source reference (spec section 52)
// ---------------------------------------------------------------------------
export type SourceType =
  | 'dashboard_metric'
  | 'financial_snapshot'
  | 'health_score'
  | 'financial_dna'
  | 'resilience'
  | 'goal'
  | 'goal_forecast'
  | 'retirement_forecast'
  | 'financial_twin'
  | 'benchmark'
  | 'report'
  | 'knowledge_article';

export interface SourceReference {
  source_type: SourceType;
  source_id: string;
  model_version: string | null;
  data_as_of: string | null;
}

// ---------------------------------------------------------------------------
// Root metadata (spec section 7)
// ---------------------------------------------------------------------------
export interface ContextMetadata {
  context_version: string;
  generated_at: string;
  /** Opaque internal reference — never the raw auth user id — see resolveHouseholdContext(). */
  user_scope_identifier: string;
  household_scope_identifier: string;
  reporting_currency: 'AUD' | 'INR';
  country_of_residence: string | null;
  data_as_of: string | null;
  snapshot_id: string | null;
  source_snapshot_version: string | null;
  calculation_status: 'complete' | 'partial' | 'unavailable';
  integrity_status: CertificationState;
  currency_integrity_status: CertificationState;
  data_completeness: number | null;
  certification_status: CertificationState;
  request_scope: ContextSizeMode;
}

// ---------------------------------------------------------------------------
// Household (spec section 8) — allowlisted fields only
// ---------------------------------------------------------------------------
export interface HouseholdContextSection {
  country_of_residence: string | null;
  reporting_currency: 'AUD' | 'INR';
  household_type: string | null;
  life_stage: string | null;
  number_of_adults: number | null;
  number_of_dependants: number | null;
  employment_status_summary: string | null;
  housing_tenure_category: string | null;
  cross_border_indicator: boolean;
}

// ---------------------------------------------------------------------------
// Cash flow (spec section 9)
// ---------------------------------------------------------------------------
export interface CashFlowSection {
  monthly_gross_income: number;
  monthly_net_income: number;
  monthly_expenses: number;
  essential_monthly_expenses: number;
  discretionary_monthly_expenses: number;
  debt_repayments: number;
  insurance_premiums: number;
  monthly_surplus_or_deficit: number;
  savings_rate: number | null;
  income_concentration: number | null;
  fixed_commitment_ratio: number | null;
  data_as_of: string | null;
  calculation_version: string | null;
}

// ---------------------------------------------------------------------------
// Balance sheet (spec section 10)
// ---------------------------------------------------------------------------
export interface BalanceSheetSection {
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  liquid_assets: number;
  property_assets: number | null;
  investment_assets: number;
  retirement_assets: number;
  property_concentration: number | null;
  investment_concentration: number | null;
  debt_breakdown: { debt_type: string; balance: number }[];
  country_breakdown: { country_code: string; value: number }[];
  currency_breakdown: { currency_code: string; value: number }[];
  data_as_of: string | null;
  calculation_version: string | null;
}

// ---------------------------------------------------------------------------
// Score (spec section 11)
// ---------------------------------------------------------------------------
export interface ScoreSection {
  overall_score: number;
  score_band: string;
  pillar_scores: { code: string; score: number | null; weight: number }[];
  principal_drivers: string[];
  prior_valid_score: number | null;
  score_movement: number | null;
  confidence: number | null;
  calculation_date: string | null;
  model_version: string;
}

// ---------------------------------------------------------------------------
// Financial DNA (spec section 12)
// ---------------------------------------------------------------------------
export interface FinancialDnaSection {
  primary_profile: string | null;
  secondary_profile: string | null;
  driver_metrics: string[];
  confidence: number | null;
  classification_date: string | null;
  model_version: string;
}

// ---------------------------------------------------------------------------
// Resilience (spec section 13)
// ---------------------------------------------------------------------------
export interface ResilienceSection {
  resilience_score: number;
  resilience_status: string;
  emergency_fund_months: number | null;
  liquidity_position: string | null;
  income_concentration: number | null;
  debt_pressure: string | null;
  insurance_protection_status: string | null;
  active_risks: { code: string; category: string; severity: string }[];
  stress_test_outputs: { scenario_code: string; outcome: string }[];
  confidence: number | null;
  model_version: string;
}

// ---------------------------------------------------------------------------
// Investments (spec section 14)
// ---------------------------------------------------------------------------
export interface InvestmentsSection {
  total_investment_value: number;
  contribution_rate: number | null;
  diversification_score: number | null;
  institution_concentration: number | null;
  country_allocation: { country_code: string; value: number }[];
  dividend_monthly_income: number | null;
  data_as_of: string | null;
  calculation_version: string | null;
}

// ---------------------------------------------------------------------------
// Retirement (spec section 15)
// ---------------------------------------------------------------------------
export interface RetirementSection {
  retirement_balance: number;
  account_categories: string[]; // e.g. superannuation, smsf, epf, ppf, nps
  employer_contribution_rate: number | null;
  personal_contribution_rate: number | null;
  data_as_of: string | null;
  calculation_version: string | null;
}

// ---------------------------------------------------------------------------
// Insurance (spec section 16) — MISSING != CONFIRMED NONE
// ---------------------------------------------------------------------------
export interface InsuranceSection {
  data_status: 'complete' | 'partial' | 'missing';
  active_cover_categories: string[];
  confirmed_no_cover_categories: string[];
  missing_or_unknown_categories: string[];
  premium_burden: number | null;
  confidence: number | null;
}

// ---------------------------------------------------------------------------
// Goals (spec section 17)
// ---------------------------------------------------------------------------
export interface GoalContextEntry {
  goal_reference: string;
  goal_type: string;
  goal_status: string;
  target_amount: number;
  current_funding: number;
  contribution: number | null;
  target_date: string | null;
  track_status: string | null;
  required_contribution: number | null;
  forecast_completion_date: string | null;
  confidence: number | null;
  calculation_version: string | null;
}

// ---------------------------------------------------------------------------
// Forecasts (spec section 18)
// ---------------------------------------------------------------------------
export interface ForecastContextEntry {
  scenario_code: string;
  horizon_years: number | null;
  major_projected_metrics: Record<string, number | null>;
  assumption_set_id: string | null;
  model_version: string | null;
  calculation_date: string | null;
  confidence: number | null;
  /** Every consumer of this entry MUST surface this disclaimer verbatim or equivalent. */
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Financial Twin (spec section 19)
// ---------------------------------------------------------------------------
export interface FinancialTwinSection {
  peer_cohort_description: string | null;
  cohort_tier: string | null;
  metrics: {
    metric_code: string;
    user_value: number | null;
    peer_value: number | null;
    gap: number | null;
    percentile: number | null;
    comparison_status: string | null;
  }[];
  benchmark_source: string | null;
  benchmark_period: string | null;
  benchmark_version: string | null;
  benchmark_confidence: number | null;
  status: 'indicative' | 'confirmed' | 'restated' | null;
}

// ---------------------------------------------------------------------------
// Report (spec section 20)
// ---------------------------------------------------------------------------
export interface ReportContextSection {
  report_id: string;
  reporting_period: string | null;
  data_as_of: string | null;
  report_version: string | null;
  executive_metrics: Record<string, number | null>;
  major_findings: string[];
  active_risks: string[];
  goal_references: string[];
  report_confidence: number | null;
  template_version: string | null;
}

// ---------------------------------------------------------------------------
// Cross-border (spec section 21)
// ---------------------------------------------------------------------------
export interface CrossBorderSection {
  countries_present: string[];
  currencies_present: string[];
  reporting_currency: 'AUD' | 'INR';
  local_country_totals: { country_code: string; value: number }[];
  converted_totals: { country_code: string; value_in_reporting_currency: number }[];
  fx_source: string;
  fx_rate_date: string | null;
  currency_mismatch_metrics: { metric: string; value: number | null }[];
  country_concentration: number | null;
  cross_border_goals: string[];
  cross_border_debt_exposure: number | null;
}

// ---------------------------------------------------------------------------
// Data quality (spec section 22)
// ---------------------------------------------------------------------------
export interface DataQualitySection {
  complete_domains: ContextDomain[];
  incomplete_domains: ContextDomain[];
  missing_fields: string[];
  confirmed_zero_fields: string[];
  stale_fields: string[];
  rejected_records: string[];
  excluded_duplicates: string[];
  valuation_date_issues: string[];
  unsupported_calculations: string[];
  unavailable_modules: ContextDomain[];
  confidence_limitations: string[];
}

// ---------------------------------------------------------------------------
// Risks / recommendations (deterministic facts only — no AI narration here)
// ---------------------------------------------------------------------------
export interface RiskEntry {
  code: string;
  domain: ContextDomain;
  severity: string;
  description: string;
}

export interface RecommendationEntry {
  recommendation_code: string;
  category: string;
  priority: string;
  source_metric: string | null;
}

// ---------------------------------------------------------------------------
// The full Financial Context Object (spec section 6)
// ---------------------------------------------------------------------------
export interface FinancialContextObject {
  meta: ContextMetadata;
  household: HouseholdContextSection | null;
  cash_flow: CashFlowSection | null;
  balance_sheet: BalanceSheetSection | null;
  health_score: ScoreSection | null;
  financial_dna: FinancialDnaSection | null;
  resilience: ResilienceSection | null;
  investments: InvestmentsSection | null;
  retirement: RetirementSection | null;
  insurance: InsuranceSection | null;
  goals: GoalContextEntry[];
  forecasts: ForecastContextEntry[];
  financial_twin: FinancialTwinSection | null;
  risks: RiskEntry[];
  recommendations: RecommendationEntry[];
  reports: ReportContextSection[];
  cross_border: CrossBorderSection | null;
  data_quality: DataQualitySection;
  domain_certification: DomainCertificationMap;
  source_references: SourceReference[];
}

export const CONTEXT_VERSION = 'ai-context-1.0.0';
