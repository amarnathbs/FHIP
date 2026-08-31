// Module 11.2 — deterministic (non-LLM) free-text intent matching (spec
// sections 45-47, 83-86).
//
// Exact/regex phrase matching only, over the ALREADY-normalised question
// text (lib/ai/resolution/normalisation.ts). No embeddings, no fuzzy/edit-
// distance scoring, no guessing: a question that matches nothing here comes
// back UNKNOWN, and the router routes UNKNOWN to LIVE_AI_REQUIRED rather
// than picking the "closest" deterministic intent (spec section 47).
//
// Structured intents (spec sections 45-46) bypass this file entirely — a
// caller that already knows `intent_code` never has it re-derived from
// prose.

import type { NormalisedQuestion } from '@/lib/ai/resolution/normalisation';

export interface IntentMatch {
  intentCode: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// Every pattern is matched against normalised.text, which is already
// lowercased/framing-stripped/synonym-substituted. Patterns are intentionally
// literal/narrow — a broad catch-all regex here would be exactly the kind of
// guess spec section 47 forbids.
const DETERMINISTIC_PATTERNS: Array<[string, RegExp[]]> = [
  ['CURRENT_NET_WORTH', [/\bmy (current )?net worth\b/]],
  ['TOTAL_ASSETS', [/\b(total|my) assets?\b/, /\bhow much (are my|do i have in) assets\b/]],
  ['TOTAL_LIABILITIES', [/\btotal liabilities\b/, /\bhow much (do i owe|are my liabilities)\b/]],
  ['LIQUID_ASSETS', [/\bliquid assets?\b/, /\bhow much (cash|liquid money) do i have\b/]],
  ['MONTHLY_GROSS_INCOME', [/\b(monthly )?gross income\b/]],
  ['MONTHLY_NET_INCOME', [/\b(monthly )?net income\b/]],
  ['MONTHLY_EXPENSES', [/\bmonthly expenses\b/, /\bwhat are my (monthly )?expenses\b/]],
  ['ESSENTIAL_EXPENSES', [/\bessential (monthly )?expenses\b/]],
  ['MONTHLY_SURPLUS', [/\bmonthly surplus\b/, /\bmonthly (surplus|deficit)\b/]],
  ['SAVINGS_RATE', [/\bmy savings rate\b/, /\bwhat is my savings rate\b/]],
  ['FINANCIAL_HEALTH_SCORE', [/\bwhat is my financial health score\b/, /\bmy (current )?(financial health )?score\b/]],
  ['FINANCIAL_HEALTH_BAND', [/\bscore band\b/, /\bwhat band is my (financial health )?score\b/]],
  ['DNA_PRIMARY_PROFILE', [/\bwhat is my financial dna\b/, /\bmy (primary )?(financial )?dna profile\b/]],
  ['DNA_SECONDARY_PROFILE', [/\bmy secondary (financial )?dna profile\b/]],
  ['RESILIENCE_STATUS', [/\bwhat is my resilience status\b/, /\bmy (financial )?resilience status\b/]],
  ['RESILIENCE_SCORE', [/\bmy resilience score\b/]],
  ['EMERGENCY_FUND_MONTHS', [/\bemergency fund\b.*\b(months|coverage)\b/, /\bhow many months? of emergency (savings|fund)\b/, /\bemergency.?fund coverage\b/]],
  ['INVESTMENT_TOTAL', [/\bhow much (do i have )?in investments\b/, /\btotal investments?\b/]],
  ['INVESTMENT_DIVERSIFICATION', [/\b(investment )?diversification score\b/]],
  ['RETIREMENT_BALANCE', [/\bretirement balance\b/, /\bhow much (do i have )?in retirement\b/]],
  ['INSURANCE_DATA_STATUS', [/\binsurance data status\b/, /\bis my insurance (data|information) complete\b/]],
  ['GOAL_COUNT', [/\bhow many goals\b/]],
  ['GOALS_ON_TRACK_COUNT', [/\bgoals? (are )?on track\b/, /\bhow many goals? (are|is).*on track\b/]],
  ['GOALS_AT_RISK_COUNT', [/\bgoals? at risk\b/, /\bhow many goals? (are|is).*(at risk|off track)\b/]],
  ['FORECAST_LATEST_RUN_DATE', [/\bwhen was my forecast (last )?calculated\b/, /\bforecast last (run|calculated|updated)\b/]],
  ['TWIN_COHORT', [/\bwhat cohort am i\b/, /\btwin (peer )?cohort\b/]],
  ['TWIN_CONFIDENCE', [/\btwin confidence\b/, /\bhow confident is my (financial )?twin\b/]],
  ['REPORT_PERIOD', [/\bwhat period is (this|my) report\b/, /\breport period\b/]],
  ['REPORT_VERSION', [/\breport version\b/, /\bwhat version is (this|my) report\b/]],
  ['COUNTRIES_PRESENT', [/\bwhich countries\b/, /\bcountries (are )?represented\b/]],
  ['CURRENCIES_PRESENT', [/\bwhat currencies\b/, /\bcurrencies (are )?recorded\b/]],
  ['REPORTING_CURRENCY', [/\bmy reporting currency\b/, /\bwhat currency is (this|my) report\b/]],
  ['SNAPSHOT_DATE', [/\bsnapshot (date|is from)\b/, /\bwhen is my (financial )?snapshot from\b/]],
  ['DATA_COMPLETENESS', [/\bis (any of )?my (information|data) missing\b/, /\bdata completeness\b/, /\bwhich areas (are )?incomplete\b/]],
  ['STALE_DATA_AREAS', [/\bis my data stale\b/, /\bstale data\b/]],
];

const KNOWLEDGE_PATTERNS: Array<[string, RegExp[]]> = [
  ['NET_WORTH_DEFINITION', [/^what is net worth\??$/]],
  ['CASH_FLOW_DEFINITION', [/^what is cash flow\??$/]],
  ['SAVINGS_RATE_DEFINITION', [/^what is a savings rate\??$/, /^what does savings rate mean\??$/]],
  ['DEBT_TO_INCOME_DEFINITION', [/^what is debt.?to.?income\??$/, /^what does debt.?to.?income mean\??$/]],
  ['DEBT_SERVICE_RATIO_DEFINITION', [/^what is debt.?service ratio\??$/]],
  ['EMERGENCY_FUND_DEFINITION', [/^what is an? emergency fund\??$/]],
  ['FINANCIAL_HEALTH_SCORE_DEFINITION', [/^what is (the )?financial health score\??$/]],
  ['FINANCIAL_DNA_DEFINITION', [/^what is financial dna\??$/, /^what does financial dna mean\??$/]],
  ['FINANCIAL_RESILIENCE_DEFINITION', [/^what is financial resilience\??$/]],
  ['DIVERSIFICATION_DEFINITION', [/^what is diversification\??$/]],
  ['INVESTMENT_CONCENTRATION_DEFINITION', [/^what is an? investment concentration\??$/, /^what is asset concentration\??$/]],
  ['FINANCIAL_GOAL_DEFINITION', [/^what is a financial goal\??$/]],
  ['FORECASTING_DEFINITION', [/^what is forecasting\??$/]],
  ['FINANCIAL_TWIN_DEFINITION', [/^what is (the )?financial twin\??$/]],
  ['BENCHMARK_DEFINITION', [/^what is a benchmark\??$/]],
  ['REPORTING_CURRENCY_DEFINITION', [/^what does reporting currency mean\??$/]],
  ['CROSS_BORDER_EXPOSURE_DEFINITION', [/^what is cross.?border currency exposure\??$/]],
  ['SUPERANNUATION_DEFINITION', [/^what is superannuation\??$/]],
  ['SMSF_DEFINITION', [/^what is an? smsf\??$/]],
  ['EPF_DEFINITION', [/^what is epf\??$/]],
  ['PPF_DEFINITION', [/^what is ppf\??$/]],
  ['NPS_DEFINITION', [/^what is nps\??$/]],
];

const WHY_PATTERNS: Array<[string, RegExp[]]> = [
  ['SCORE_EXPLANATION', [/\bwhy (is|did) my (financial health )?score\b/]],
  ['DNA_EXPLANATION', [/\bwhy am i classified\b/, /\bwhy (is|was) my (financial )?dna\b/]],
  ['RESILIENCE_EXPLANATION', [/\bwhy (is|did) my resilience\b/, /\bwhy is my emergency fund (too )?low\b/]],
];

function matchAgainst(text: string, table: Array<[string, RegExp[]]>): IntentMatch | null {
  for (const [intentCode, patterns] of table) {
    if (patterns.some((p) => p.test(text))) return { intentCode, confidence: 'HIGH' };
  }
  return null;
}

/**
 * Returns the best confident match, or null (UNKNOWN — spec section 47: "do
 * not guess"). `normalised.isWhyQuestion` is checked FIRST and independently
 * of the deterministic table, so a why-phrased question about net worth
 * ("why is my net worth so low") never matches CURRENT_NET_WORTH (spec
 * section 83's negative example) — it either matches a WHY intent or falls
 * through to UNKNOWN, never a plain factual intent it did not ask for.
 */
export function matchIntent(normalised: NormalisedQuestion): IntentMatch | null {
  if (normalised.isHypothetical) return { intentCode: 'SCENARIO_REQUEST', confidence: 'HIGH' };
  if (normalised.isWhyQuestion) return matchAgainst(normalised.text, WHY_PATTERNS);

  return matchAgainst(normalised.text, DETERMINISTIC_PATTERNS) ?? matchAgainst(normalised.text, KNOWLEDGE_PATTERNS);
}
