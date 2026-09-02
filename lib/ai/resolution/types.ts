// Module 11.2 — Deterministic Answer Router & Zero-Cost Response Resolution.
//
// Central type contract for the resolution router (spec sections 6-8, 15).
// This module defines the shape every resolver returns and the shape the
// router itself returns to a caller. Nothing here calls a provider, consumes
// quota, or performs a canonical financial write.

import type { CertificationState, ContextDomain, SourceReference } from '@/lib/ai/context/types';
import type { SafetyClassification } from '@/lib/ai/structuredOutput';
import type { CountryCode } from '@/lib/services/jurisdiction';

// ---------------------------------------------------------------------------
// Resolution outcomes (spec section 7)
// ---------------------------------------------------------------------------
export const RESOLUTION_TYPES = [
  'DETERMINISTIC',
  'KNOWLEDGE_BASE',
  'STORED_PERSONALISED',
  'EXACT_CACHE',
  'LIVE_AI_REQUIRED',
  'UNSUPPORTED',
  'BLOCKED',
  'UNAVAILABLE',
] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

/** Whether a request's zero-cost resolution fully or only partly covered it (spec section 48). */
export type ResolutionCompleteness = 'FULLY_RESOLVED' | 'PARTIALLY_RESOLVED' | 'UNRESOLVED';

// ---------------------------------------------------------------------------
// Required-context mode (spec section 6/74) — deliberately mirrors
// ContextSizeMode but is named separately: NONE means "do not build a
// FinancialContextObject at all" (Knowledge Base / safety-boundary / a
// non-personalised static answer), which ContextSizeMode itself cannot
// express (its narrowest value, MINIMAL, still means "build one, with zero
// domains").
// ---------------------------------------------------------------------------
export type RequiredContextMode = 'NONE' | 'MINIMAL' | 'DOMAIN' | 'FULL';

// ---------------------------------------------------------------------------
// Intent taxonomy (spec sections 10-11)
// ---------------------------------------------------------------------------
export type IntentFamily =
  | 'ACCOUNT_APP'
  | 'FINANCIAL_EDUCATION'
  | 'DASHBOARD'
  | 'CASH_FLOW'
  | 'ASSETS'
  | 'LIABILITIES'
  | 'NET_WORTH'
  | 'LIQUIDITY'
  | 'DEBT'
  | 'SCORE'
  | 'DNA'
  | 'RESILIENCE'
  | 'INVESTMENTS'
  | 'RETIREMENT'
  | 'INSURANCE'
  | 'GOALS'
  | 'FORECAST'
  | 'TWIN'
  | 'REPORT'
  | 'CROSS_BORDER'
  | 'DATA_QUALITY'
  | 'METHODOLOGY'
  | 'PROGRESS'
  | 'SCENARIO_REQUEST'
  | 'PRODUCT_ADVICE'
  | 'TAX_ADVICE'
  | 'LEGAL_ADVICE'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export type SafetyClass = 'SAFE' | 'ADVICE_BOUNDARY' | 'RESTRICTED';

export type ResolverKind = 'DETERMINISTIC' | 'KNOWLEDGE_BASE' | 'STORED_PERSONALISED' | 'EXACT_CACHE' | 'LIVE_AI';

/** Section 11 — one row of the versioned intent registry. Code/config, not a DB table (spec section 97). */
export interface IntentDefinition {
  intent_code: string;
  intent_version: number;
  intent_family: IntentFamily;
  /** True when a correct answer necessarily depends on one household's own data. */
  personalised: boolean;
  /** Which FinancialContextObject domain(s) a DETERMINISTIC resolution for this intent reads. Empty for non-personalised intents. */
  requires_certified_domain: ContextDomain[];
  allowed_resolvers: ResolverKind[];
  /** null = no country restriction (globally applicable intent). */
  country_scope: CountryCode[] | null;
  required_context_mode: RequiredContextMode;
  safety_class: SafetyClass;
  enabled: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Standard response envelope (spec section 15)
// ---------------------------------------------------------------------------
export interface ResolvedAnswerEnvelope {
  resolution_type: ResolutionType;
  intent_code: string | null;
  answer_type: string;
  headline: string;
  summary: string;
  key_points: string[];
  source_refs: SourceReference[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  data_as_of: string | null;
  limitations: string[];
  related_module: string | null;
  action_route: string | null;
  requires_live_ai: boolean;
  consumes_custom_quota: boolean;
  template_version: string | null;
}

// ---------------------------------------------------------------------------
// One resolver's verdict for one intent (internal — the router composes these
// into the final ResolutionResult below).
// ---------------------------------------------------------------------------
export interface ResolverAttempt {
  resolver: ResolverKind;
  hit: boolean;
  answer: ResolvedAnswerEnvelope | null;
  /** Why this resolver did not produce an answer (only meaningful when hit=false). */
  miss_reason: string | null;
}

// ---------------------------------------------------------------------------
// Final router result (spec section 3)
// ---------------------------------------------------------------------------
export interface ResolutionResult {
  request_id: string;
  resolution: ResolutionType;
  completeness: ResolutionCompleteness;
  answer_available: boolean;
  requires_live_ai: boolean;
  consumes_custom_quota: boolean;
  source_refs: SourceReference[];
  response: ResolvedAnswerEnvelope | null;
  /** Populated only for a compound/multi-question request (spec section 48-49). */
  components?: ResolutionResult[];
  intent_code: string | null;
  intent_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  safety_classification: SafetyClassification | null;
  certification_status: CertificationState | null;
  premium_required: boolean;
  premium_satisfied: boolean;
  resolver_trace: ResolverAttempt[];
  latency_ms: number;
}

// ---------------------------------------------------------------------------
// Request shape (spec sections 45-46, 61-62)
// ---------------------------------------------------------------------------
export interface ResolveRequest {
  /** Preferred: a structured intent code from a known FHIP UI button. */
  intent_code?: string;
  /** Free text — normalised/matched for DEV testing and any surface without a structured intent yet. */
  question?: string;
}
