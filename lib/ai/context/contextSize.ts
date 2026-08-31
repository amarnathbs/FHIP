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
