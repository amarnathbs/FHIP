// Module 11.4 — Standard Personalised Question Library & Zero-Cost Premium
// AI Experience: shared type contract (spec sections 8, 10, 19-21).
//
// Nothing in this file calls a provider, a resolver, or the DB. It is the
// static shape every other file in lib/ai/standardQuestions/ agrees on.

import type { CountryCode } from '@/lib/services/jurisdiction';

export const STANDARD_QUESTION_CATALOGUE_VERSION = 'standard-question-catalogue-1.0.0';

// ---------------------------------------------------------------------------
// Support statuses (spec section 12) — the catalogue may declare all 25
// question definitions; whether one is ACTIVE for a given household is a
// separate, honestly-evaluated question answered per-request.
// ---------------------------------------------------------------------------
export const SUPPORT_STATUSES = [
  'AVAILABLE',
  'INSUFFICIENT_DATA',
  'DOMAIN_UNAVAILABLE',
  'STALE',
  'NOT_APPLICABLE',
  'COUNTRY_NOT_APPLICABLE',
  'PACK_NOT_READY',
  'DEFERRED_CAPABILITY',
  'FEATURE_DISABLED',
  'PREMIUM_REQUIRED',
  'TARGET_REQUIRED',
  'TARGET_NOT_FOUND',
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** Section 19-21 answer-origin vocabulary. Backend value; never shown raw to a user. */
export const ANSWER_ORIGINS = ['DETERMINISTIC', 'KNOWLEDGE_BASE', 'STORED_PERSONALISED', 'COMPOSED_ZERO_COST'] as const;
export type AnswerOrigin = (typeof ANSWER_ORIGINS)[number];

/** Section 21 — the ONLY user-safe labels an answer_origin may render as. */
export const ANSWER_ORIGIN_LABELS: Record<AnswerOrigin, string> = {
  DETERMINISTIC: 'From your FHIP data',
  KNOWLEDGE_BASE: 'FHIP guide',
  STORED_PERSONALISED: 'Personalised AI insight',
  COMPOSED_ZERO_COST: 'Personalised AI insight + your FHIP data',
};

export const QUESTION_CATEGORIES = [
  'FINANCIAL_OVERVIEW',
  'SCORE_AND_BEHAVIOUR',
  'CASH_FLOW',
  'BALANCE_SHEET_AND_LIQUIDITY',
  'INVESTMENTS_AND_RETIREMENT',
  'PROTECTION',
  'GOALS_AND_FORECAST',
  'BENCHMARK_AND_CROSS_BORDER',
] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

/** One zero-cost component a question composes (spec sections 17-18). */
export interface QuestionComponent {
  role: 'metric' | 'definition' | 'explanation';
  intent_code: string;
}

/** Spec section 10 — the versioned catalogue entry shape. */
export interface StandardQuestionDefinition {
  standard_question_code: string;
  question_version: number;
  display_text: string;
  short_label: string;
  category: QuestionCategory;
  description: string;
  personalised: boolean;
  premium_required: boolean;
  country_scope: CountryCode[] | null;
  required_domains: string[];
  primary_intent_code: string | null;
  secondary_intent_codes: string[];
  /** Ordered zero-cost components composed into the final answer. */
  components: QuestionComponent[];
  preferred_resolution_sources: AnswerOrigin[];
  stored_pack_block_codes: string[];
  related_module: string;
  action_route: string;
  display_order: number;
  /** True when this question needs a caller-supplied, ownership-checked target (spec section 27-28). */
  requires_target: 'goal' | null;
  enabled: boolean;
  introduced_version: string;
}

export interface StandardQuestionAnswer {
  headline: string;
  summary: string;
  key_points: string[];
  limitations: string[];
}

export interface StandardQuestionSourceRef {
  source_type: string;
  source_id: string;
  data_as_of: string | null;
}

/** Section 19 — the runtime-validated response envelope. */
export interface StandardQuestionResponse {
  standard_question_code: string;
  question: string;
  status: SupportStatus;
  answer: StandardQuestionAnswer | null;
  answer_origins: AnswerOrigin[];
  answer_origin_labels: string[];
  source_refs: StandardQuestionSourceRef[];
  data_as_of: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  related_module: string;
  action_route: string;
  provider_called: false;
  custom_quota_consumed: false;
  /** Only present for a supported-but-not-yet-selected target question (spec section 28). */
  eligible_targets?: { id: string; label: string }[];
}

export interface CatalogueEntryWithAvailability extends StandardQuestionDefinition {
  question: string;
  status: SupportStatus;
}
