// Module 11.6 — Rules-First Next Best Action (brief sections 40-49).
//
// CONTRACT. CERTIFIED FINANCIAL STATE (the FinancialContextObject, every
// field of which is a certified Module 1-10 output) -> DETERMINISTIC RULES
// -> ELIGIBLE ACTIONS -> SUPPRESSION -> DETERMINISTIC RANKING -> MAXIMUM 3
// -> ZERO-COST EXPLANATION. No provider, no quota, no randomness, no clock
// dependence: the same context always yields the same evaluation.

export const NBA_RULES_VERSION = 'nba-rules-1.0.0';
export const NBA_RANKING_POLICY_VERSION = 'nba-ranking-1.0.0';
export const NBA_MAX_ACTIONS = 3;

/** Closed set — every code must trace to a certified upstream status (see rules.ts). */
export const NBA_ACTION_CODES = [
  'MISSING_CRITICAL_INFORMATION',
  'STALE_INFORMATION',
  'MISSING_RETIREMENT_DATA',
  'MISSING_INSURANCE_DATA',
  'NEGATIVE_CASH_FLOW',
  'LIQUIDITY_WEAKNESS',
  'DEBT_PRESSURE',
  'INSURANCE_PROTECTION_GAP',
  'ASSET_CONCENTRATION',
  'INCOME_CONCENTRATION',
  'OFF_TRACK_GOALS',
  'SCORE_WEAKNESS',
  'SCORE_DETERIORATION',
  'CROSS_BORDER_EXPOSURE',
  'RESILIENCE_WEAKNESS',
] as const;
export type NbaActionCode = (typeof NBA_ACTION_CODES)[number];

export type NbaSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Explicit tiers (brief section 43). Order here is the ranking tie-break order after severity. */
export const NBA_TIER_ORDER = ['DATA_QUALITY', 'PROTECTION', 'LIQUIDITY', 'CASH_FLOW', 'DEBT', 'CONCENTRATION', 'PROGRESS', 'REVIEW'] as const;
export type NbaTier = (typeof NBA_TIER_ORDER)[number];

export interface NbaEvidence {
  /** Human label of the certified fact, e.g. "Emergency fund (months of essential expenses)". */
  label: string;
  /** The certified value, rendered deterministically (currency in the reporting currency, never converted here). */
  value: string;
  /** The FCO path the value was read from — provenance. */
  source_path: string;
}

export interface NbaCandidate {
  action_code: NbaActionCode;
  title: string;
  tier: NbaTier;
  severity: NbaSeverity;
  /** The certified upstream status that fired the rule (e.g. `resilience.active_risks:low_emergency_fund`). */
  source_ref: string;
  evidence: NbaEvidence[];
  related_module: string;
  action_route: string;
  /** Generic actions this specific action suppresses (brief section 45). */
  suppresses: NbaActionCode[];
}

export interface NbaAction extends NbaCandidate {
  rank: number;
  /** Zero-cost, template-composed explanation — the "Why this?" (brief section 48). */
  explanation: string;
}

export interface NbaSuppression {
  action_code: NbaActionCode;
  suppressed_by: NbaActionCode;
  reason: string;
}

export interface NbaEvaluation {
  rules_version: string;
  ranking_policy_version: string;
  snapshot_id: string | null;
  context_hash: string;
  country: string | null;
  reporting_currency: string;
  candidates: NbaCandidate[];
  suppressed: NbaSuppression[];
  /** 0..3, already ranked. Never padded. */
  actions: NbaAction[];
  /** Structural invariants, always literally these values (brief sections 47-48). */
  provider_calls: 0;
  custom_quota_consumed: 0;
}
