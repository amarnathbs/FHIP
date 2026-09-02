// Module 11.2 — AIAnswerResolutionService (the "ZeroCostAnswerRouter"), the
// sole decision point for "what is the cheapest authorised way to answer
// this question?" (spec sections 2-3, 6, 8).
//
// LOCKED ROUTING ORDER (spec section 8) — every branch below is numbered to
// match the spec exactly. Steps 1-2 (authenticate/authorise) are the
// CALLER'S responsibility (resolveHouseholdContext()) before this function
// is ever invoked — this service receives an already-authorised
// {userId, householdId}, never a client-supplied id.
//
// This function NEVER calls AIModelGateway / a provider (spec sections 3,
// 54, 118). It is pure zero-cost routing: every branch that cannot be
// answered for free returns LIVE_AI_REQUIRED and stops.

import { randomUUID } from 'node:crypto';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { CountryCode } from '@/lib/services/jurisdiction';
import { classifyRequest } from '@/lib/ai/safety/classification';
import { getPolicyRule } from '@/lib/ai/safety/policy';
import { normaliseQuestion } from '@/lib/ai/resolution/normalisation';
import { matchIntent } from '@/lib/ai/resolution/intentMatcher';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import { resolveDeterministic } from '@/lib/ai/resolution/deterministicResolver';
import { resolveKnowledgeBase } from '@/lib/ai/resolution/knowledgeBaseResolver';
import { resolveStoredPersonalised } from '@/lib/ai/resolution/storedPersonalisedResolver';
import { resolveExactCache } from '@/lib/ai/resolution/exactCacheResolver';
import { recordResolutionMetric } from '@/lib/ai/observability/aiMetrics';
import { hashNormalisedQuestion } from '@/lib/ai/resolution/audit';
import type { ResolutionPolicy, ResolutionResult, ResolveRequest, ResolverAttempt } from '@/lib/ai/resolution/types';

export const RESOLUTION_ROUTER_VERSION = 'resolution-router-1.0.0';

/** Everything the router needs beyond pure logic, injected so it is unit-testable without a live DB/session. */
export interface RouterDependencies {
  buildContext(mode: 'MINIMAL' | 'DOMAIN' | 'FULL', intentCode?: string): Promise<FinancialContextObject>;
  getUserCountry(): Promise<CountryCode | null>;
  isPersonalisedAiEligible(): Promise<boolean>;
  /** Best-effort audit write. Defaults to a no-op if omitted (tests may skip it). */
  writeAudit?(result: ResolutionResult, normalisedQuestionHash: string | null): Promise<void>;
}

export interface ResolveAnswerInput {
  userId: string;
  householdId: string | null;
  request: ResolveRequest;
  /**
   * Module 11.4 (spec section 9). Omitted/'STANDARD' = unchanged Module 11.2
   * behaviour. 'ZERO_COST_ONLY' is the additive policy
   * AIStandardQuestionService always passes — see applyZeroCostPolicy() below.
   */
  policy?: ResolutionPolicy;
}

/**
 * Module 11.4 (spec section 9) — the ZERO_COST_ONLY enforcement point.
 * DETERMINISTIC / KNOWLEDGE_BASE / STORED_PERSONALISED / EXACT_CACHE results
 * pass through completely unchanged (every zero-cost path was already the
 * router's only way of answering anything — nothing about them differs
 * under this policy). Anything that would otherwise ask a caller to run a
 * provider (LIVE_AI_REQUIRED, or a compound/component result that carries
 * requires_live_ai=true) is converted to a safe, inert result: resolution
 * becomes 'UNAVAILABLE', every escalation field is forced false, and no
 * response/source_refs are returned. This is enforced on the OUTPUT of the
 * router, not merely a label change — a caller cannot recover a path to
 * LIVE_AI/consumes_custom_quota from the returned object under this policy.
 */
function applyZeroCostPolicy(result: ResolutionResult, policy: ResolutionPolicy | undefined): ResolutionResult {
  if (policy !== 'ZERO_COST_ONLY') return result;
  if (!result.requires_live_ai && result.resolution !== 'LIVE_AI_REQUIRED') return result;
  return {
    ...result,
    resolution: 'UNAVAILABLE',
    completeness: 'UNRESOLVED',
    answer_available: false,
    requires_live_ai: false,
    consumes_custom_quota: false,
    source_refs: [],
    response: null,
    components: undefined,
    resolver_trace: [...result.resolver_trace, { resolver: 'LIVE_AI', hit: false, answer: null, miss_reason: 'zero_cost_only_policy_blocked_live_ai' }],
  };
}

function boundaryResponse(intentCode: string, headline: string): NonNullable<ResolutionResult['response']> {
  return {
    resolution_type: 'BLOCKED',
    intent_code: intentCode,
    answer_type: 'boundary_response',
    headline,
    summary: headline,
    key_points: [],
    source_refs: [],
    confidence: 'HIGH',
    data_as_of: null,
    limitations: [],
    related_module: null,
    action_route: null,
    requires_live_ai: false,
    consumes_custom_quota: false,
    template_version: 'boundary-response-1.0.0',
  };
}

function baseResult(requestId: string, startedAt: number): Omit<ResolutionResult, 'resolution' | 'completeness' | 'answer_available' | 'requires_live_ai' | 'consumes_custom_quota' | 'source_refs' | 'response'> {
  return {
    request_id: requestId,
    intent_code: null,
    intent_confidence: null,
    safety_classification: null,
    certification_status: null,
    premium_required: false,
    premium_satisfied: true,
    resolver_trace: [],
    latency_ms: Date.now() - startedAt,
  };
}

function finish(result: ResolutionResult, startedAt: number): ResolutionResult {
  result.latency_ms = Date.now() - startedAt;
  const def = result.intent_code ? getIntentDefinition(result.intent_code) : null;
  recordResolutionMetric({ resolution: result.resolution, personalised: def?.personalised ?? false, intentFamily: def?.intent_family });
  return result;
}

/**
 * Resolves ONE clause (intent code or free-text question) through steps
 * 5-11 of the locked order. Exported separately from resolveAnswer() so
 * compound-request handling (spec sections 48-49) can call it once per
 * component without duplicating the pipeline.
 */
async function resolveClause(
  deps: RouterDependencies,
  input: { userId: string; householdId: string | null; intentCode?: string; question?: string },
  requestId: string,
  startedAt: number
): Promise<ResolutionResult> {
  const rawText = input.question ?? (input.intentCode ? getIntentDefinition(input.intentCode)?.description ?? input.intentCode : '');
  const normalised = input.question ? normaliseQuestion(input.question) : null;

  // ---------------------------------------------------------------------
  // STEP 5 — safety / request-classification pre-check (spec sections 50-51,
  // 87-88). Structured intent codes for a boundary family skip straight to
  // BLOCKED without needing free text; free text always runs the real
  // classifier so a UI-independent caller gets the same protection.
  // ---------------------------------------------------------------------
  const structuredDef = input.intentCode ? getIntentDefinition(input.intentCode) : null;
  if (structuredDef?.safety_class === 'RESTRICTED') {
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'BLOCKED',
      completeness: 'UNRESOLVED',
      answer_available: true,
      requires_live_ai: false,
      consumes_custom_quota: false,
      source_refs: [],
      response: boundaryResponse(structuredDef.intent_code, structuredDef.description),
      intent_code: structuredDef.intent_code,
    };
    return finish(result, startedAt);
  }

  const classification = classifyRequest(rawText, 'user_question');
  const policyRule = getPolicyRule(classification.classification);

  if (policyRule.blocked) {
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'BLOCKED',
      completeness: 'UNRESOLVED',
      answer_available: true,
      requires_live_ai: false,
      consumes_custom_quota: false,
      source_refs: [],
      response: boundaryResponse(classification.classification, classification.blockReason ?? policyRule.disclosureText ?? 'This request cannot be processed by FHIP AI.'),
      safety_classification: classification.classification,
    };
    return finish(result, startedAt);
  }

  if (classification.classification === 'SCENARIO_REQUEST') {
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'UNSUPPORTED',
      completeness: 'UNRESOLVED',
      answer_available: false,
      requires_live_ai: false,
      consumes_custom_quota: false,
      source_refs: [],
      response: {
        resolution_type: 'UNSUPPORTED',
        intent_code: 'SCENARIO_REQUEST',
        answer_type: 'future_capability',
        headline: 'Scenario modelling is not available yet.',
        summary: 'This looks like a "what if" scenario question. FHIP does not run scenario modelling in this release.',
        key_points: [],
        source_refs: [],
        confidence: 'HIGH',
        data_as_of: null,
        limitations: ['Scenario Coach is planned for a future phase.'],
        related_module: 'forecasting',
        action_route: '/forecasting',
        requires_live_ai: false,
        consumes_custom_quota: false,
        template_version: 'scenario-boundary-1.0.0',
      },
      safety_classification: classification.classification,
      intent_code: 'SCENARIO_REQUEST',
    };
    return finish(result, startedAt);
  }

  // ---------------------------------------------------------------------
  // STEP 6/4 — resolve the intent code (structured input wins; free text is
  // matched via lib/ai/resolution/intentMatcher.ts; an unmatched free-text
  // question is UNKNOWN, never guessed — spec section 47).
  // ---------------------------------------------------------------------
  let intentCode = input.intentCode ?? null;
  let confidence: ResolutionResult['intent_confidence'] = intentCode ? 'HIGH' : null;
  if (!intentCode && normalised) {
    const match = matchIntent(normalised);
    intentCode = match?.intentCode ?? null;
    confidence = match?.confidence ?? null;
  }

  const def = intentCode ? getIntentDefinition(intentCode) : null;
  const trace: ResolverAttempt[] = [];

  // A SCENARIO_REQUEST intent can be reached two ways — classifyRequest()'s
  // own (narrower) "what if"/"scenario" detection above, or
  // lib/ai/resolution/intentMatcher.ts's broader hypothetical-framing
  // detection ("what happens if...", "if I retire at...") matching AFTER
  // classifyRequest already passed the text through as GENERAL_EDUCATION.
  // Both must land on the identical UNSUPPORTED/"recognised, not executed"
  // result (spec section 86) — handled once, here, regardless of route.
  if (intentCode === 'SCENARIO_REQUEST') {
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'UNSUPPORTED',
      completeness: 'UNRESOLVED',
      answer_available: false,
      requires_live_ai: false,
      consumes_custom_quota: false,
      source_refs: [],
      response: {
        resolution_type: 'UNSUPPORTED',
        intent_code: 'SCENARIO_REQUEST',
        answer_type: 'future_capability',
        headline: 'Scenario modelling is not available yet.',
        summary: 'This looks like a "what if" scenario question. FHIP does not run scenario modelling in this release.',
        key_points: [],
        source_refs: [],
        confidence: 'HIGH',
        data_as_of: null,
        limitations: ['Scenario Coach is planned for a future phase.'],
        related_module: 'forecasting',
        action_route: '/forecasting',
        requires_live_ai: false,
        consumes_custom_quota: false,
        template_version: 'scenario-boundary-1.0.0',
      },
      safety_classification: classification.classification,
      intent_code: 'SCENARIO_REQUEST',
      intent_confidence: confidence,
    };
    return finish(result, startedAt);
  }

  if (!def || !def.enabled) {
    // A genuinely UNKNOWN free-text question (no intent matched at all) is
    // routed to LIVE_AI_REQUIRED — a human may still be able to answer it
    // with a live model in a future phase (spec section 47), and future
    // quota WOULD be required for that. A matched-but-disabled/removed
    // intent code, by contrast, is a hard UNSUPPORTED refusal that consumes
    // no quota — the request will never reach a provider under this code.
    const isUnknown = !intentCode;
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: isUnknown ? 'LIVE_AI_REQUIRED' : 'UNSUPPORTED',
      completeness: 'UNRESOLVED',
      answer_available: false,
      requires_live_ai: isUnknown,
      consumes_custom_quota: isUnknown,
      source_refs: [],
      response: null,
      intent_code: intentCode,
      intent_confidence: confidence,
      safety_classification: classification.classification,
    };
    return finish(result, startedAt);
  }

  // ---------------------------------------------------------------------
  // STEP 7 — deterministic resolution.
  // ---------------------------------------------------------------------
  let context: FinancialContextObject | null = null;
  if (def.allowed_resolvers.includes('DETERMINISTIC')) {
    context = await deps.buildContext(def.required_context_mode === 'NONE' ? 'MINIMAL' : (def.required_context_mode as 'MINIMAL' | 'DOMAIN' | 'FULL'), intentCode!);
    const attempt = resolveDeterministic({ intentCode: intentCode!, context });
    trace.push(attempt);
    if (attempt.hit && attempt.answer) {
      const result: ResolutionResult = {
        ...baseResult(requestId, startedAt),
        resolution: 'DETERMINISTIC',
        completeness: 'FULLY_RESOLVED',
        answer_available: true,
        requires_live_ai: false,
        consumes_custom_quota: false,
        source_refs: attempt.answer.source_refs,
        response: attempt.answer,
        intent_code: intentCode,
        intent_confidence: confidence,
        safety_classification: classification.classification,
        certification_status: context.domain_certification[def.requires_certified_domain[0]]?.status ?? context.meta.certification_status,
        resolver_trace: trace,
      };
      return finish(result, startedAt);
    }
    // A certification failure on a personalised domain is UNAVAILABLE, not a
    // silent fall-through to Knowledge Base / LIVE_AI (spec sections 20-21,
    // 108-110) — Knowledge Base could never legitimately answer a
    // personalised "what is MY X" question anyway (spec section 34).
    if (def.personalised && !def.allowed_resolvers.some((r) => r !== 'DETERMINISTIC')) {
      const result: ResolutionResult = {
        ...baseResult(requestId, startedAt),
        resolution: 'UNAVAILABLE',
        completeness: 'UNRESOLVED',
        answer_available: false,
        requires_live_ai: false,
        consumes_custom_quota: false,
        source_refs: [],
        response: null,
        intent_code: intentCode,
        intent_confidence: confidence,
        safety_classification: classification.classification,
        certification_status: context.meta.certification_status,
        resolver_trace: trace,
      };
      return finish(result, startedAt);
    }
  }

  // ---------------------------------------------------------------------
  // STEP 8 — approved Knowledge Base resolution.
  // ---------------------------------------------------------------------
  if (def.allowed_resolvers.includes('KNOWLEDGE_BASE')) {
    const userCountry = await deps.getUserCountry();
    const attempt = await resolveKnowledgeBase({ intentCode: intentCode!, userCountry });
    trace.push(attempt);
    if (attempt.hit && attempt.answer) {
      const result: ResolutionResult = {
        ...baseResult(requestId, startedAt),
        resolution: 'KNOWLEDGE_BASE',
        completeness: 'FULLY_RESOLVED',
        answer_available: true,
        requires_live_ai: false,
        consumes_custom_quota: false,
        source_refs: attempt.answer.source_refs,
        response: attempt.answer,
        intent_code: intentCode,
        intent_confidence: confidence,
        safety_classification: classification.classification,
        resolver_trace: trace,
      };
      return finish(result, startedAt);
    }
  }

  // ---------------------------------------------------------------------
  // STEP 9/10 — stored personalised answer, then exact cache. Both require
  // a FinancialContextObject scoped to the intent's certified domain(s) —
  // built here (not in step 7) for intents that skip DETERMINISTIC entirely
  // (the WHY-explanation intents).
  // ---------------------------------------------------------------------
  if (def.allowed_resolvers.includes('STORED_PERSONALISED') || def.allowed_resolvers.includes('EXACT_CACHE')) {
    if (!context) context = await deps.buildContext(def.required_context_mode === 'NONE' ? 'MINIMAL' : (def.required_context_mode as 'MINIMAL' | 'DOMAIN' | 'FULL'), intentCode!);
    const personalisedAiEligible = await deps.isPersonalisedAiEligible();

    if (def.allowed_resolvers.includes('STORED_PERSONALISED')) {
      const attempt = await resolveStoredPersonalised({ intentCode: intentCode!, userId: input.userId, context, personalisedAiEligible });
      trace.push(attempt);
      if (attempt.hit && attempt.answer) {
        const result: ResolutionResult = {
          ...baseResult(requestId, startedAt),
          resolution: 'STORED_PERSONALISED',
          completeness: 'FULLY_RESOLVED',
          answer_available: true,
          requires_live_ai: false,
          consumes_custom_quota: false,
          source_refs: attempt.answer.source_refs,
          response: attempt.answer,
          intent_code: intentCode,
          intent_confidence: confidence,
          safety_classification: classification.classification,
          premium_required: def.personalised,
          premium_satisfied: personalisedAiEligible,
          resolver_trace: trace,
        };
        return finish(result, startedAt);
      }
    }

    if (def.allowed_resolvers.includes('EXACT_CACHE') && input.question) {
      const attempt = await resolveExactCache({ intentCode: intentCode!, userId: input.userId, householdId: input.householdId, question: input.question, context, personalisedAiEligible });
      trace.push(attempt);
      if (attempt.hit && attempt.answer) {
        const result: ResolutionResult = {
          ...baseResult(requestId, startedAt),
          resolution: 'EXACT_CACHE',
          completeness: 'FULLY_RESOLVED',
          answer_available: true,
          requires_live_ai: false,
          consumes_custom_quota: false,
          source_refs: attempt.answer.source_refs,
          response: attempt.answer,
          intent_code: intentCode,
          intent_confidence: confidence,
          safety_classification: classification.classification,
          premium_required: def.personalised,
          premium_satisfied: personalisedAiEligible,
          resolver_trace: trace,
        };
        return finish(result, startedAt);
      }
    }

    // ---------------------------------------------------------------------
    // STEP 11 — every zero-cost source missed: LIVE_AI_REQUIRED. Provider is
    // NEVER called in Module 11.2 (spec sections 3, 54, 118).
    // ---------------------------------------------------------------------
    const personalisedAiEligibleFinal = personalisedAiEligible;
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'LIVE_AI_REQUIRED',
      completeness: 'UNRESOLVED',
      answer_available: false,
      requires_live_ai: true,
      consumes_custom_quota: true,
      source_refs: [],
      response: null,
      intent_code: intentCode,
      intent_confidence: confidence,
      safety_classification: classification.classification,
      premium_required: def.personalised,
      premium_satisfied: personalisedAiEligibleFinal,
      resolver_trace: trace,
    };
    return finish(result, startedAt);
  }

  // Deterministic-only intent that missed and Knowledge-Base-only intent
  // that missed both fall through here to LIVE_AI_REQUIRED — genuinely
  // zero-cost sources are exhausted (spec section 8, step 11).
  const finalResult: ResolutionResult = {
    ...baseResult(requestId, startedAt),
    resolution: 'LIVE_AI_REQUIRED',
    completeness: 'UNRESOLVED',
    answer_available: false,
    requires_live_ai: true,
    consumes_custom_quota: true,
    source_refs: [],
    response: null,
    intent_code: intentCode,
    intent_confidence: confidence,
    safety_classification: classification.classification,
    resolver_trace: trace,
  };
  return finish(finalResult, startedAt);
}

// Splits on a bare top-level " and " so a compound request (spec sections
// 48-49) can be resolved component-by-component. Deliberately conservative:
// only splits when BOTH sides look like independent questions (each at
// least 3 words) to avoid slicing a single question that merely contains
// the word "and" (e.g. "assets and liabilities total" stays one clause if
// splitting would leave a fragment too short to be its own question).
function splitCompound(question: string): string[] | null {
  const parts = question.split(/\s+and\s+/i);
  if (parts.length !== 2) return null;
  const [a, b] = parts.map((p) => p.trim());
  if (a.split(/\s+/).length < 3 || b.split(/\s+/).length < 3) return null;
  return [a, b.match(/^(what|why|how|when|which|is|are|do|does)\b/i) ? b : `what is my ${b}`];
}

export async function resolveAnswer(deps: RouterDependencies, input: ResolveAnswerInput): Promise<ResolutionResult> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  if (!input.request.intent_code && !input.request.question) {
    const result: ResolutionResult = {
      ...baseResult(requestId, startedAt),
      resolution: 'UNSUPPORTED',
      completeness: 'UNRESOLVED',
      answer_available: false,
      requires_live_ai: false,
      consumes_custom_quota: false,
      source_refs: [],
      response: null,
    };
    return finish(result, startedAt);
  }

  const compoundParts = !input.request.intent_code && input.request.question ? splitCompound(input.request.question) : null;

  let result: ResolutionResult;
  if (compoundParts) {
    const components = await Promise.all(
      compoundParts.map((q) => resolveClause(deps, { userId: input.userId, householdId: input.householdId, question: q }, randomUUID(), startedAt))
    );
    const allResolved = components.every((c) => c.answer_available);
    const anyResolved = components.some((c) => c.answer_available);
    result = {
      ...baseResult(requestId, startedAt),
      resolution: allResolved ? components[0].resolution : anyResolved ? 'LIVE_AI_REQUIRED' : 'LIVE_AI_REQUIRED',
      completeness: allResolved ? 'FULLY_RESOLVED' : anyResolved ? 'PARTIALLY_RESOLVED' : 'UNRESOLVED',
      answer_available: anyResolved,
      requires_live_ai: components.some((c) => c.requires_live_ai),
      consumes_custom_quota: false,
      source_refs: components.flatMap((c) => c.source_refs),
      response: components.find((c) => c.answer_available)?.response ?? null,
      components,
    };
  } else {
    result = await resolveClause(deps, { userId: input.userId, householdId: input.householdId, intentCode: input.request.intent_code, question: input.request.question }, requestId, startedAt);
  }

  result = applyZeroCostPolicy(result, input.policy);

  if (deps.writeAudit) {
    const normalisedHash = input.request.question ? hashNormalisedQuestion(normaliseQuestion(input.request.question).text) : null;
    await deps.writeAudit(result, normalisedHash);
  }

  return result;
}
