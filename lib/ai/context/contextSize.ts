// Module 11.0 — context-size budget contract (spec section 54).
//
// Routing from an intent to a context mode is NOT activated in 11.0 (no
// conversational routing exists yet — spec section 30), but the contract is
// implemented now so 11.1 can wire a real intent classifier straight into
// it without touching the context builder.

import type { ContextDomain, ContextSizeMode } from '@/lib/ai/context/types';

/** Which top-level FinancialContextObject sections each mode includes. */
export const DOMAINS_BY_MODE: Record<ContextSizeMode, ContextDomain[] | 'ALL'> = {
  MINIMAL: [],
  DOMAIN: [], // populated per-request via resolveDomainsForIntent()
  FULL: 'ALL',
};

const ALL_DOMAINS: ContextDomain[] = [
  'cash_flow',
  'balance_sheet',
  'score',
  'financial_dna',
  'resilience',
  'investments',
  'retirement',
  'insurance',
  'goals',
  'forecasts',
  'financial_twin',
  'reports',
  'cross_border',
];

// Illustrative intent -> domain mapping (spec section 54's own examples).
// Not exhaustive routing — future intents added in 11.1 as the real
// classifier is built; unmapped intents conservatively fall back to FULL
// rather than silently returning an empty context.
const INTENT_DOMAIN_MAP: Record<string, ContextDomain[]> = {
  emergency_fund_question: ['resilience', 'cash_flow'],
  score_summary: ['score'],
  full_financial_health_summary: ALL_DOMAINS,
  goal_progress_question: ['goals'],
  forecast_question: ['forecasts', 'balance_sheet'],
  twin_comparison_question: ['financial_twin'],
  insurance_question: ['insurance'],
  cross_border_question: ['cross_border', 'balance_sheet'],

  // Module 11.2 — deterministic answer router (lib/ai/resolution/intentTaxonomy.ts).
  // Each entry mirrors that intent's `requires_certified_domain` exactly, so
  // the router never builds more of the FinancialContextObject than a given
  // question needs (spec section 74). Intents whose taxonomy entry declares
  // an empty domain list are deliberately absent here — they use MINIMAL
  // mode, which needs no per-domain mapping at all.
  CURRENT_NET_WORTH: ['balance_sheet'],
  TOTAL_ASSETS: ['balance_sheet'],
  TOTAL_LIABILITIES: ['balance_sheet'],
  LIQUID_ASSETS: ['balance_sheet'],
  MONTHLY_GROSS_INCOME: ['cash_flow'],
  MONTHLY_NET_INCOME: ['cash_flow'],
  MONTHLY_EXPENSES: ['cash_flow'],
  ESSENTIAL_EXPENSES: ['cash_flow'],
  MONTHLY_SURPLUS: ['cash_flow'],
  SAVINGS_RATE: ['cash_flow'],
  FINANCIAL_HEALTH_SCORE: ['score'],
  FINANCIAL_HEALTH_BAND: ['score'],
  SCORE_EXPLANATION: ['score'],
  DNA_PRIMARY_PROFILE: ['financial_dna'],
  DNA_SECONDARY_PROFILE: ['financial_dna'],
  DNA_EXPLANATION: ['financial_dna'],
  RESILIENCE_STATUS: ['resilience'],
  RESILIENCE_SCORE: ['resilience'],
  EMERGENCY_FUND_MONTHS: ['resilience'],
  RESILIENCE_EXPLANATION: ['resilience'],
  INVESTMENT_TOTAL: ['investments'],
  INVESTMENT_DIVERSIFICATION: ['investments'],
  RETIREMENT_BALANCE: ['retirement'],
  INSURANCE_DATA_STATUS: ['insurance'],
  GOAL_COUNT: ['goals'],
  GOALS_ON_TRACK_COUNT: ['goals'],
  GOALS_AT_RISK_COUNT: ['goals'],
  FORECAST_LATEST_RUN_DATE: ['forecasts'],
  TWIN_COHORT: ['financial_twin'],
  TWIN_CONFIDENCE: ['financial_twin'],
  REPORT_PERIOD: ['reports'],
  REPORT_VERSION: ['reports'],
  COUNTRIES_PRESENT: ['cross_border'],
  CURRENCIES_PRESENT: ['cross_border'],

  // Module 11.4 — additive STANDARD_QUESTION_EXPLANATION_INTENTS (lib/ai/
  // resolution/intentTaxonomy.ts). Each mirrors that intent's
  // requires_certified_domain exactly, same convention as above.
  SCORE_CHANGE_EXPLANATION: ['score'],
  CASH_FLOW_EXPLANATION: ['cash_flow'],
  SAVINGS_EXPLANATION: ['cash_flow'],
  EXPENSE_EXPLANATION: ['cash_flow'],
  NET_WORTH_EXPLANATION: ['balance_sheet'],
  ASSET_CONCENTRATION_EXPLANATION: ['balance_sheet'],
  LIQUIDITY_EXPLANATION: ['resilience'],
  DEBT_EXPLANATION: ['resilience'],
  INVESTMENT_EXPLANATION: ['investments'],
  RETIREMENT_EXPLANATION: ['retirement'],
  INSURANCE_EXPLANATION: ['insurance'],
  GOAL_RISK_EXPLANATION: ['goals'],
  FORECAST_SUMMARY_EXPLANATION: ['forecasts'],
  TWIN_SUMMARY_EXPLANATION: ['financial_twin'],
  CROSS_BORDER_SUMMARY_EXPLANATION: ['cross_border'],
};

export function resolveDomainsForMode(mode: ContextSizeMode, intentCode?: string): ContextDomain[] {
  if (mode === 'FULL') return ALL_DOMAINS;
  if (mode === 'MINIMAL') return [];
  // DOMAIN mode
  if (intentCode && INTENT_DOMAIN_MAP[intentCode]) return INTENT_DOMAIN_MAP[intentCode];
  return ALL_DOMAINS; // fail-safe: unknown intent gets full context rather than an empty, misleadingly-confident one
}

export function domainIncluded(domain: ContextDomain, includedDomains: ContextDomain[]): boolean {
  return includedDomains.includes(domain);
}
