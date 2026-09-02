// Module 11.5 — Contextual Explain / Why? Integration: shared type contract
// (spec sections 11-12, 15, 49, 65).
//
// Nothing in this file calls a provider, a resolver, or the DB. It is the
// static shape every other file in lib/ai/contextualExplanations/ agrees on.
//
// The vocabulary here is deliberately SEPARATE from Module 11.4's
// SupportStatus. 11.4's statuses are catalogue-question statuses; 11.5's are
// the user-facing availability states spec section 49 enumerates, and two of
// them (INSIGHT_PREPARING, HISTORICAL_EXPLANATION_UNAVAILABLE) have no 11.4
// equivalent. mapSupportStatus() below is the ONE translation point.

import type { AnswerOrigin, StandardQuestionAnswer, StandardQuestionSourceRef, SupportStatus } from '@/lib/ai/standardQuestions/types';
import type { CountryCode } from '@/lib/services/jurisdiction';

export const CONTEXTUAL_TARGET_REGISTRY_VERSION = 'contextual-target-registry-1.0.0';

// ---------------------------------------------------------------------------
// Spec section 49 — the user-safe availability vocabulary.
// ---------------------------------------------------------------------------
export const CONTEXTUAL_AVAILABILITIES = [
  'AVAILABLE',
  'PREMIUM_REQUIRED',
  'INSUFFICIENT_DATA',
  'DOMAIN_UNAVAILABLE',
  'STALE',
  'NOT_APPLICABLE',
  'INSIGHT_PREPARING',
  'FEATURE_DISABLED',
  'HISTORICAL_EXPLANATION_UNAVAILABLE',
  'TARGET_REQUIRED',
  'TARGET_NOT_FOUND',
] as const;
export type ContextualAvailability = (typeof CONTEXTUAL_AVAILABILITIES)[number];

/**
 * Spec section 49 — "Do not expose internal enum names directly if they are
 * unfriendly." The API returns the enum (a client needs to branch on it) AND
 * this already-humanised label, so no consumer surface has to invent wording.
 */
export const CONTEXTUAL_AVAILABILITY_LABELS: Record<ContextualAvailability, string> = {
  AVAILABLE: 'Available',
  PREMIUM_REQUIRED: 'Premium feature',
  INSUFFICIENT_DATA: 'FHIP needs more information before it can explain this.',
  DOMAIN_UNAVAILABLE: 'This is not available for your current financial setup.',
  STALE: 'This explanation is based on older data.',
  NOT_APPLICABLE: 'This does not apply to your situation right now.',
  INSIGHT_PREPARING: 'Your personalised insight is being prepared.',
  FEATURE_DISABLED: 'Explanations are temporarily unavailable.',
  HISTORICAL_EXPLANATION_UNAVAILABLE:
    'A personalised explanation is not available for this historical report. It would need current information, which would not match the report you are viewing.',
  TARGET_REQUIRED: 'Select an item to explain.',
  TARGET_NOT_FOUND: 'That item is not available.',
};

/**
 * The ONE translation point from Module 11.4's catalogue-question status to
 * Module 11.5's contextual availability. PACK_NOT_READY becomes the friendlier
 * INSIGHT_PREPARING (spec section 50/90) rather than being surfaced raw.
 */
export function mapSupportStatus(status: SupportStatus): ContextualAvailability {
  switch (status) {
    case 'AVAILABLE':
      return 'AVAILABLE';
    case 'PREMIUM_REQUIRED':
      return 'PREMIUM_REQUIRED';
    case 'DOMAIN_UNAVAILABLE':
      return 'DOMAIN_UNAVAILABLE';
    case 'STALE':
      return 'STALE';
    case 'NOT_APPLICABLE':
    case 'COUNTRY_NOT_APPLICABLE':
    case 'DEFERRED_CAPABILITY':
      return 'NOT_APPLICABLE';
    case 'PACK_NOT_READY':
      return 'INSIGHT_PREPARING';
    case 'FEATURE_DISABLED':
      return 'FEATURE_DISABLED';
    case 'TARGET_REQUIRED':
      return 'TARGET_REQUIRED';
    case 'TARGET_NOT_FOUND':
      return 'TARGET_NOT_FOUND';
    case 'INSUFFICIENT_DATA':
    default:
      return 'INSUFFICIENT_DATA';
  }
}

// ---------------------------------------------------------------------------
// Modules a contextual target may belong to (spec section 11). A closed
// vocabulary — a client cannot invent one.
// ---------------------------------------------------------------------------
export const CONTEXTUAL_MODULES = ['dashboard', 'score', 'dna', 'resilience', 'goals', 'forecast', 'twin', 'reports'] as const;
export type ContextualModule = (typeof CONTEXTUAL_MODULES)[number];

/**
 * Spec section 13 — which owned entity (if any) a target must be scoped to.
 * `null` means the target addresses the household's current position and takes
 * no entity id at all.
 */
export type ContextualTargetEntityType = 'goal' | 'report' | null;

/**
 * One zero-cost component a contextual-only target composes. Identical in
 * spirit to Module 11.4's QuestionComponent, plus an explicit `required` flag:
 * an OPTIONAL component may miss without making the whole explanation
 * unavailable (spec sections 32/43 — show the certified classification even
 * before a personalised block exists, rather than a blanket "unavailable").
 *
 * `required: false` never lowers the honesty bar: a target still only becomes
 * AVAILABLE when at least one PERSONALISED component resolved (see
 * PERSONALISED_ROLES / the service's personalisation gate), so a Knowledge
 * Base definition can never stand alone as a personalised WHY answer
 * (spec section 125's fail condition).
 */
export interface ContextualComponent {
  role: 'metric' | 'definition' | 'explanation';
  intent_code: string;
  required: boolean;
}

/** A component role that carries the household's OWN data (never generic education). */
export const PERSONALISED_ROLES: ReadonlySet<ContextualComponent['role']> = new Set<ContextualComponent['role']>(['metric', 'explanation']);

/**
 * Spec section 12 — the versioned contextual target registry entry.
 *
 * Exactly one of `standard_question_code` / `components` is populated:
 *   - `standard_question_code` -> delegate wholesale to Module 11.4's
 *     AIStandardQuestionService (spec section 9 — reuse, never re-implement).
 *   - `components`             -> a narrow contextual-only composition over
 *     ALREADY-EXISTING Module 11.2 intent codes (spec section 10).
 */
export interface ContextualExplanationTarget {
  target_code: string;
  module_code: ContextualModule;
  /** The action wording rendered on the control (spec sections 16, 66). */
  display_label: string;
  /** What the panel shows as the question being answered. */
  display_question: string;
  /** Stable contextual intent code — never UI text (spec section 11). */
  intent_code: string;
  standard_question_code: string | null;
  components: ContextualComponent[];
  required_domains: string[];
  target_entity_type: ContextualTargetEntityType;
  stored_pack_block_codes: string[];
  country_scope: CountryCode[] | null;
  /** Human-readable statement of when this target is answerable (spec section 12). */
  availability_rule: string;
  related_module: string;
  action_route: string;
  premium_required: boolean;
  enabled: boolean;
  version: number;
  introduced_version: string;
}

// ---------------------------------------------------------------------------
// Spec section 15 — the runtime-validated contextual response envelope.
// ---------------------------------------------------------------------------
export interface ContextualExplanationResponse {
  module: ContextualModule;
  target_code: string;
  target_id: string | null;
  status: ContextualAvailability;
  status_label: string;
  question: string;
  answer: StandardQuestionAnswer | null;
  answer_origins: AnswerOrigin[];
  answer_origin_labels: string[];
  source_refs: StandardQuestionSourceRef[];
  data_as_of: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  /** Spec section 64 — set for a historical report so the panel never reads as current. */
  source_context_label: string | null;
  /** True when this explanation is bound to a historical (non-current) snapshot. */
  historical_context: boolean;
  related_module: string;
  action_route: string;
  /** Spec section 19 — the path from contextual Explain into the wider library. */
  insights_route: string;
  provider_called: false;
  custom_quota_consumed: false;
  /** Only present for a target that needs a caller-supplied owned entity (spec section 13). */
  eligible_targets?: { id: string; label: string }[];
}

/** Spec section 19 — the Module 11.4 library route a contextual panel links out to. */
export const FINANCIAL_INSIGHTS_ROUTE = '/ai-insights';
