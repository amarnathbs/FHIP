// Module 11.2 — versioned intent taxonomy (spec sections 10-11, 96-97).
//
// Code/config, not a database table: this is a STABLE TAXONOMY (spec section
// 97 — "prefer code/config for stable taxonomies where appropriate. Do not
// create database tables merely because an entity can be modelled as a
// table"). Every intent that answers a question about a household's own
// data is `personalised: true` and lists exactly which FinancialContextObject
// domain(s) a DETERMINISTIC resolution reads (spec section 13 — the
// resolver must retrieve, never recompute).
//
// INTENT_VERSION is bumped whenever an intent's MEANING changes (not when its
// wording changes — spec section 68 keeps those separate). Nothing in this
// codebase currently needs a version above 1.

import type { IntentDefinition } from '@/lib/ai/resolution/types';

export const INTENT_TAXONOMY_VERSION = 'intent-taxonomy-1.0.0';

function det(
  intent_code: string,
  requires_certified_domain: IntentDefinition['requires_certified_domain'],
  description: string
): IntentDefinition {
  return {
    intent_code,
    intent_version: 1,
    intent_family: 'DASHBOARD',
    personalised: true,
    requires_certified_domain,
    allowed_resolvers: ['DETERMINISTIC'],
    country_scope: null,
    required_context_mode: requires_certified_domain.length === 0 ? 'MINIMAL' : 'DOMAIN',
    safety_class: 'SAFE',
    enabled: true,
    description,
  };
}

function kb(intent_code: string, description: string, countryScope: IntentDefinition['country_scope'] = null): IntentDefinition {
  return {
    intent_code,
    intent_version: 1,
    intent_family: 'FINANCIAL_EDUCATION',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: ['KNOWLEDGE_BASE'],
    country_scope: countryScope,
    required_context_mode: 'NONE',
    safety_class: 'SAFE',
    enabled: true,
    description,
  };
}

// ---------------------------------------------------------------------------
// A. Deterministic personalised intents — spec section 64 catalogue.
// Every domain list below is populated in FinancialContextObject regardless
// of the intent's own certification state; the resolver checks
// domain_certification[domain] before trusting the value (spec section 19).
// ---------------------------------------------------------------------------
export const DETERMINISTIC_INTENTS: IntentDefinition[] = [
  det('CURRENT_NET_WORTH', ['balance_sheet'], 'Current net worth (assets minus liabilities).'),
  det('TOTAL_ASSETS', ['balance_sheet'], 'Current total recorded assets.'),
  det('TOTAL_LIABILITIES', ['balance_sheet'], 'Current total recorded liabilities.'),
  det('LIQUID_ASSETS', ['balance_sheet'], 'Current total liquid (readily accessible) assets.'),
  det('MONTHLY_GROSS_INCOME', ['cash_flow'], 'Recorded monthly gross income.'),
  det('MONTHLY_NET_INCOME', ['cash_flow'], 'Recorded monthly net (take-home) income.'),
  det('MONTHLY_EXPENSES', ['cash_flow'], 'Recorded total monthly expenses.'),
  det('ESSENTIAL_EXPENSES', ['cash_flow'], 'Recorded essential (non-discretionary) monthly expenses.'),
  det('MONTHLY_SURPLUS', ['cash_flow'], 'Recorded monthly surplus or deficit (net income minus expenses).'),
  det('SAVINGS_RATE', ['cash_flow'], 'Current savings rate.'),
  det('FINANCIAL_HEALTH_SCORE', ['score'], 'Current Financial Health Score.'),
  det('FINANCIAL_HEALTH_BAND', ['score'], 'Current Financial Health Score band/label.'),
  det('DNA_PRIMARY_PROFILE', ['financial_dna'], 'Current primary Financial DNA profile.'),
  det('DNA_SECONDARY_PROFILE', ['financial_dna'], 'Current secondary Financial DNA profile.'),
  det('RESILIENCE_STATUS', ['resilience'], 'Current Financial Resilience status band.'),
  det('RESILIENCE_SCORE', ['resilience'], 'Current Financial Resilience score.'),
  det('EMERGENCY_FUND_MONTHS', ['resilience'], 'Current emergency-fund coverage in months.'),
  det('INVESTMENT_TOTAL', ['investments'], 'Current total recorded investment value.'),
  det('INVESTMENT_DIVERSIFICATION', ['investments'], 'Current investment diversification score.'),
  det('RETIREMENT_BALANCE', ['retirement'], 'Current total recorded retirement balance.'),
  det('INSURANCE_DATA_STATUS', ['insurance'], 'Whether insurance data recorded is complete, partial or missing.'),
  det('GOAL_COUNT', ['goals'], 'Number of recorded financial goals.'),
  det('GOALS_ON_TRACK_COUNT', ['goals'], 'Number of goals currently on track per the certified forecast.'),
  det('GOALS_AT_RISK_COUNT', ['goals'], 'Number of goals currently off-track/at-risk per the certified forecast.'),
  det('FORECAST_LATEST_RUN_DATE', ['forecasts'], 'When the base-case forecast now shown was last calculated.'),
  det('TWIN_COHORT', ['financial_twin'], 'The peer cohort the Financial Twin comparison uses.'),
  det('TWIN_CONFIDENCE', ['financial_twin'], 'The confidence level of the current Financial Twin comparison.'),
  det('REPORT_PERIOD', ['reports'], 'The reporting period of the most recent report.'),
  det('REPORT_VERSION', ['reports'], 'The version number of the most recent report.'),
  det('COUNTRIES_PRESENT', ['cross_border'], 'Which countries are represented in recorded financial data.'),
  det('CURRENCIES_PRESENT', ['cross_border'], 'Which currencies are recorded in the household’s financial data.'),
  det('REPORTING_CURRENCY', [], 'The currency FHIP reports the household’s figures in.'),
  det('SNAPSHOT_DATE', [], 'The date the current financial snapshot is as of.'),
  det('DATA_COMPLETENESS', [], 'Which financial areas currently have complete, certified data.'),
  det('STALE_DATA_AREAS', [], 'Which financial areas are currently based on stale data.'),
];

// ---------------------------------------------------------------------------
// B. Knowledge Base intents — spec section 65 catalogue. Resolution comes
// from the approved Resources glossary (lib/ai/resolution/knowledgeBaseResolver.ts),
// never a hardcoded string here — this taxonomy only declares that the
// intent EXISTS and what country scope (if any) it is restricted to.
// ---------------------------------------------------------------------------
export const KNOWLEDGE_INTENTS: IntentDefinition[] = [
  kb('NET_WORTH_DEFINITION', 'What is net worth?'),
  kb('CASH_FLOW_DEFINITION', 'What is cash flow?'),
  kb('SAVINGS_RATE_DEFINITION', 'What is a savings rate?'),
  kb('DEBT_TO_INCOME_DEFINITION', 'What is debt-to-income?'),
  kb('DEBT_SERVICE_RATIO_DEFINITION', 'What is debt-service ratio?'),
  kb('EMERGENCY_FUND_DEFINITION', 'What is an emergency fund?'),
  kb('FINANCIAL_HEALTH_SCORE_DEFINITION', 'What is the Financial Health Score?'),
  kb('FINANCIAL_DNA_DEFINITION', 'What is Financial DNA?'),
  kb('FINANCIAL_RESILIENCE_DEFINITION', 'What is Financial Resilience?'),
  kb('DIVERSIFICATION_DEFINITION', 'What is diversification?'),
  kb('INVESTMENT_CONCENTRATION_DEFINITION', 'What is investment concentration?'),
  kb('FINANCIAL_GOAL_DEFINITION', 'What is a financial goal?'),
  kb('FORECASTING_DEFINITION', 'What is forecasting?'),
  kb('FINANCIAL_TWIN_DEFINITION', 'What is Financial Twin?'),
  kb('BENCHMARK_DEFINITION', 'What is a benchmark?'),
  kb('REPORTING_CURRENCY_DEFINITION', 'What does reporting currency mean?'),
  kb('CROSS_BORDER_EXPOSURE_DEFINITION', 'What is cross-border currency exposure?'),
  kb('SUPERANNUATION_DEFINITION', 'What is superannuation?', ['AU']),
  kb('SMSF_DEFINITION', 'What is an SMSF?', ['AU']),
  kb('EPF_DEFINITION', 'What is EPF?', ['IN']),
  kb('PPF_DEFINITION', 'What is PPF?', ['IN']),
  kb('NPS_DEFINITION', 'What is NPS?', ['IN']),
];

// ---------------------------------------------------------------------------
// C. Personalised WHY / explanation intents — spec sections 34-38. These are
// deliberately NOT deterministic: they require a causal driver the engine
// must have explicitly supplied. The deterministic resolver may answer them
// ONLY when the relevant engine payload carries structured drivers; the
// taxonomy allows both DETERMINISTIC (driver-based) and STORED_PERSONALISED/
// LIVE_AI so the router can fall through correctly (spec sections 35-36).
// ---------------------------------------------------------------------------
export const WHY_EXPLANATION_INTENTS: IntentDefinition[] = [
  {
    intent_code: 'SCORE_EXPLANATION',
    intent_version: 1,
    intent_family: 'SCORE',
    personalised: true,
    requires_certified_domain: ['score'],
    allowed_resolvers: ['DETERMINISTIC', 'STORED_PERSONALISED', 'EXACT_CACHE', 'LIVE_AI'],
    country_scope: null,
    required_context_mode: 'DOMAIN',
    safety_class: 'SAFE',
    enabled: true,
    description: 'Why the Financial Health Score is at its current level (driver-based only).',
  },
  {
    intent_code: 'DNA_EXPLANATION',
    intent_version: 1,
    intent_family: 'DNA',
    personalised: true,
    requires_certified_domain: ['financial_dna'],
    allowed_resolvers: ['DETERMINISTIC', 'STORED_PERSONALISED', 'EXACT_CACHE', 'LIVE_AI'],
    country_scope: null,
    required_context_mode: 'DOMAIN',
    safety_class: 'SAFE',
    enabled: true,
    description: 'Why the household is classified into its current Financial DNA profile (driver-based only).',
  },
  {
    intent_code: 'RESILIENCE_EXPLANATION',
    intent_version: 1,
    intent_family: 'RESILIENCE',
    personalised: true,
    requires_certified_domain: ['resilience'],
    allowed_resolvers: ['DETERMINISTIC', 'STORED_PERSONALISED', 'EXACT_CACHE', 'LIVE_AI'],
    country_scope: null,
    required_context_mode: 'DOMAIN',
    safety_class: 'SAFE',
    enabled: true,
    description: 'Why Financial Resilience is at its current status (driver-based only).',
  },
];

// ---------------------------------------------------------------------------
// D. Non-answerable-here classifications — spec sections 50-51, 86-88.
// These never reach a resolver; the router's safety pre-check (which reuses
// lib/ai/safety/classification.ts) returns BLOCKED or a scenario/unsupported
// result before any resolver runs.
// ---------------------------------------------------------------------------
export const BOUNDARY_INTENTS: IntentDefinition[] = [
  {
    intent_code: 'SCENARIO_REQUEST',
    intent_version: 1,
    intent_family: 'SCENARIO_REQUEST',
    personalised: true,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'SAFE',
    enabled: true,
    description: 'A hypothetical/what-if question. Scenario Coach is not built in Module 11.2 — recognised, not executed.',
  },
  {
    intent_code: 'PRODUCT_ADVICE_REQUEST',
    intent_version: 1,
    intent_family: 'PRODUCT_ADVICE',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'RESTRICTED',
    enabled: true,
    description: 'A request to recommend a specific financial product. Always blocked with a static boundary response.',
  },
  {
    intent_code: 'TAX_ADVICE_REQUEST',
    intent_version: 1,
    intent_family: 'TAX_ADVICE',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'RESTRICTED',
    enabled: true,
    description: 'A personalised tax-advice request. Always blocked with a static boundary response.',
  },
  {
    intent_code: 'LEGAL_ADVICE_REQUEST',
    intent_version: 1,
    intent_family: 'LEGAL_ADVICE',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'RESTRICTED',
    enabled: true,
    description: 'A personalised legal-advice request. Always blocked with a static boundary response.',
  },
  {
    intent_code: 'MONEY_MOVEMENT_REQUEST',
    intent_version: 1,
    intent_family: 'UNSUPPORTED',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'RESTRICTED',
    enabled: true,
    description: 'A request to move or transact money. FHIP never executes financial transactions.',
  },
  {
    intent_code: 'DATA_WRITE_REQUEST',
    intent_version: 1,
    intent_family: 'UNSUPPORTED',
    personalised: false,
    requires_certified_domain: [],
    allowed_resolvers: [],
    country_scope: null,
    required_context_mode: 'NONE',
    safety_class: 'RESTRICTED',
    enabled: true,
    description: 'A request for the AI resolver to modify canonical financial records. Always blocked.',
  },
];

export const ALL_INTENTS: IntentDefinition[] = [
  ...DETERMINISTIC_INTENTS,
  ...KNOWLEDGE_INTENTS,
  ...WHY_EXPLANATION_INTENTS,
  ...BOUNDARY_INTENTS,
];

const BY_CODE = new Map(ALL_INTENTS.map((i) => [i.intent_code, i]));

export function getIntentDefinition(intentCode: string): IntentDefinition | null {
  return BY_CODE.get(intentCode) ?? null;
}

/** Section 11: never rely on free-text comparison to check resolver eligibility. */
export function isResolverAllowed(intentCode: string, resolver: IntentDefinition['allowed_resolvers'][number]): boolean {
  const def = getIntentDefinition(intentCode);
  return Boolean(def?.enabled && def.allowed_resolvers.includes(resolver));
}
