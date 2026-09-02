// Module 11.4 — AIStandardQuestionService (spec section 8).
//
// The ONE entry point a consumer surface calls to answer a standard
// question. It NEVER imports lib/ai/gateway/aiModelGateway.ts (grep the
// import list below — there is no such import, and none may ever be added)
// and NEVER calls reserveCustomQuestion()/consumeCustomQuestion() /
// admitAiRequest() (spec sections 25, 51) — architectural separation, not a
// runtime check that could be bypassed.
//
// Every resolution goes through the EXISTING Module 11.2 router
// (lib/ai/resolution/router.ts) under the additive ZERO_COST_ONLY policy
// (spec section 9): DETERMINISTIC/KNOWLEDGE_BASE/STORED_PERSONALISED/
// EXACT_CACHE only, LIVE_AI_REQUIRED converted to a safe UNAVAILABLE by the
// router itself before this service ever sees it.

import { createAdminClient } from '@/lib/supabase/admin';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { AI_CAPABILITY_IMPLEMENTED } from '@/lib/ai/entitlement/capabilities';
import { getPlatformControls } from '@/lib/ai/entitlement/platformControls';
import { resolveAnswer } from '@/lib/ai/resolution/router';
import type { RouterDependencies } from '@/lib/ai/resolution/router';
import { createRouterDependencies } from '@/lib/ai/resolution/routerDependencies';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import type { ResolutionResult } from '@/lib/ai/resolution/types';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { loadStandardQuestionCatalogue } from '@/lib/ai/standardQuestions/catalogueDb';
import { getQuestionDefinition } from '@/lib/ai/standardQuestions/catalogue';
import { recordStandardQuestionAudit } from '@/lib/ai/standardQuestions/audit';
import type {
  AnswerOrigin,
  CatalogueEntryWithAvailability,
  QuestionComponent,
  StandardQuestionAnswer,
  StandardQuestionDefinition,
  StandardQuestionResponse,
  StandardQuestionSourceRef,
  SupportStatus,
} from '@/lib/ai/standardQuestions/types';
import { ANSWER_ORIGIN_LABELS } from '@/lib/ai/standardQuestions/types';

const AT_RISK_STATUSES = new Set(['at_risk', 'off_track']);

function originFor(resolutionType: ResolutionResult['resolution']): AnswerOrigin | null {
  if (resolutionType === 'DETERMINISTIC') return 'DETERMINISTIC';
  if (resolutionType === 'KNOWLEDGE_BASE') return 'KNOWLEDGE_BASE';
  if (resolutionType === 'STORED_PERSONALISED' || resolutionType === 'EXACT_CACHE') return 'STORED_PERSONALISED';
  return null;
}

function splitIntoUpToN(text: string, n: number): string[] {
  // Deterministic, non-AI presentation split only (spec section 18/46) — a
  // plain sentence split, never a model rewrite. Used solely to present the
  // ALREADY-GENERATED, already-approved priority-review prose as up to N
  // items; it invents no new content and reorders nothing.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.slice(0, n);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!item.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

interface ComponentOutcome {
  component: QuestionComponent;
  result: ResolutionResult;
}

/** Priority order used when more than one component missed (worst/most informative first). */
function worstStatus(reasons: SupportStatus[]): SupportStatus {
  const priority: SupportStatus[] = [
    'PREMIUM_REQUIRED',
    'FEATURE_DISABLED',
    'COUNTRY_NOT_APPLICABLE',
    'DOMAIN_UNAVAILABLE',
    'NOT_APPLICABLE',
    'PACK_NOT_READY',
    'STALE',
    'INSUFFICIENT_DATA',
  ];
  for (const p of priority) if (reasons.includes(p)) return p;
  return reasons[0] ?? 'INSUFFICIENT_DATA';
}

function missReasonToStatus(missReason: string | null, resolverUsed: 'DETERMINISTIC' | 'KNOWLEDGE_BASE' | 'STORED_PERSONALISED'): SupportStatus {
  if (!missReason) return 'INSUFFICIENT_DATA';
  if (missReason.startsWith('certification_invalid') || missReason.startsWith('certification_unavailable')) return 'DOMAIN_UNAVAILABLE';
  if (missReason === 'premium_required') return 'PREMIUM_REQUIRED';
  if (missReason === 'KNOWLEDGE_NOT_AVAILABLE' || missReason === 'knowledge_source_read_failed') return 'INSUFFICIENT_DATA';
  if (resolverUsed === 'STORED_PERSONALISED' && (missReason === 'no_valid_stored_answer' || missReason === 'stored_answer_read_failed')) return 'PACK_NOT_READY';
  return 'INSUFFICIENT_DATA';
}

function envelopeSourceRefs(result: ResolutionResult): StandardQuestionSourceRef[] {
  return result.source_refs.map((r) => ({ source_type: r.source_type, source_id: r.source_id, data_as_of: r.data_as_of }));
}

async function resolveComponents(
  deps: RouterDependencies,
  userId: string,
  householdId: string | null,
  components: QuestionComponent[]
): Promise<ComponentOutcome[]> {
  const outcomes: ComponentOutcome[] = [];
  for (const component of components) {
    // Sequential, not Promise.all: components of the same question commonly
    // share the same FinancialContextObject build inside resolveClause, and
    // sequential execution keeps DB load/ordering predictable for the
    // certification scripts that count queries (spec section 97-99).
    const result = await resolveAnswer(deps, {
      userId,
      householdId,
      request: { intent_code: component.intent_code },
      policy: 'ZERO_COST_ONLY',
    });
    outcomes.push({ component, result });
  }
  return outcomes;
}

function composeAnswer(outcomes: ComponentOutcome[]): { answer: StandardQuestionAnswer; origins: AnswerOrigin[]; sourceRefs: StandardQuestionSourceRef[]; dataAsOf: string | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null } {
  const origins = new Set<AnswerOrigin>();
  const sourceRefs: StandardQuestionSourceRef[] = [];
  let headline = '';
  const summaryParts: string[] = [];
  const keyPoints: string[] = [];
  const limitations: string[] = [];
  let dataAsOf: string | null = null;
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null = null;

  for (const { component, result } of outcomes) {
    if (!result.answer_available || !result.response) continue;
    const origin = originFor(result.resolution);
    if (origin) origins.add(origin);
    sourceRefs.push(...envelopeSourceRefs(result));
    if (result.response.data_as_of && (!dataAsOf || result.response.data_as_of > dataAsOf)) dataAsOf = result.response.data_as_of;
    limitations.push(...result.response.limitations);

    if (component.role === 'explanation') {
      if (!headline) headline = result.response.headline;
      if (result.response.summary) summaryParts.unshift(result.response.summary);
      confidence = result.response.confidence ?? confidence;
    } else if (component.role === 'metric') {
      if (!headline) headline = result.response.headline;
      summaryParts.push(result.response.headline);
    } else if (component.role === 'definition') {
      if (result.response.summary) keyPoints.push(result.response.summary);
    }
  }

  // More than one distinct backend origin contributed -> the combined label
  // (spec section 21); the underlying origins are still tracked on the
  // ResolutionResult/audit trail even when the displayed set is collapsed.
  const displayOrigins: AnswerOrigin[] = origins.size > 1 ? ['COMPOSED_ZERO_COST'] : [...origins];
  return {
    answer: {
      headline: headline || 'Here is what FHIP can tell you.',
      summary: dedupe(summaryParts).join(' '),
      key_points: dedupe(keyPoints).slice(0, 5),
      limitations: dedupe(limitations).slice(0, 5),
    },
    origins: displayOrigins,
    sourceRefs,
    dataAsOf,
    confidence,
  };
}

async function getCurrentPackStatus(userId: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('ai_insight_packs')
      .select('status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.status as string | undefined) ?? null;
  } catch {
    return null;
  }
}

function response(def: StandardQuestionDefinition, status: SupportStatus, opts: Partial<StandardQuestionResponse> = {}): StandardQuestionResponse {
  return {
    standard_question_code: def.standard_question_code,
    question: def.display_text,
    status,
    answer: opts.answer ?? null,
    answer_origins: opts.answer_origins ?? [],
    answer_origin_labels: (opts.answer_origins ?? []).map((o) => ANSWER_ORIGIN_LABELS[o]),
    source_refs: opts.source_refs ?? [],
    data_as_of: opts.data_as_of ?? null,
    confidence: opts.confidence ?? null,
    related_module: def.related_module,
    action_route: def.action_route,
    provider_called: false,
    custom_quota_consumed: false,
    ...(opts.eligible_targets ? { eligible_targets: opts.eligible_targets } : {}),
  };
}

export interface ResolveTarget {
  goalId?: string;
}

export const AIStandardQuestionService = {
  /**
   * Spec section 26 — GET /api/ai/standard-questions. Evaluates AVAILABLE/
   * NOT_APPLICABLE/etc for every enabled catalogue entry against this one
   * household. Builds ONE FinancialContextObject (FULL) and reuses it for
   * every question's availability check rather than 25 separate builds
   * (spec section 97-99 performance note).
   */
  async listCatalogue(userId: string, householdId: string | null): Promise<{ entitled: boolean; questions: CatalogueEntryWithAvailability[] }> {
    const eligible = await AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined);
    const capabilityOn = AI_CAPABILITY_IMPLEMENTED.AI_STANDARD_QUESTIONS; // built/enabled check only — never the entitlement decision itself
    const { questions } = await loadStandardQuestionCatalogue();

    if (!eligible || !capabilityOn) {
      return {
        entitled: false,
        questions: questions
          .filter((q) => q.enabled)
          .map((def) => ({ ...def, question: def.display_text, status: 'PREMIUM_REQUIRED' as SupportStatus })),
      };
    }

    const deps = createRouterDependencies(userId, householdId);
    let ctx: FinancialContextObject;
    try {
      ctx = await deps.buildContext('FULL');
    } catch {
      return {
        entitled: true,
        questions: questions.filter((q) => q.enabled).map((def) => ({ ...def, question: def.display_text, status: 'INSUFFICIENT_DATA' as SupportStatus })),
      };
    }

    const packStatus = await getCurrentPackStatus(userId);

    const evaluated = await Promise.all(
      questions
        .filter((def) => def.enabled)
        .map(async (def) => ({ ...def, question: def.display_text, status: await this.evaluateAvailability(def, ctx, packStatus) }))
    );
    return { entitled: true, questions: evaluated };
  },

  /** A cheap, no-resolution availability estimate used only for the catalogue listing (spec section 12). */
  async evaluateAvailability(def: StandardQuestionDefinition, ctx: FinancialContextObject, packStatus: string | null): Promise<SupportStatus> {
    if (def.standard_question_code === 'SQ-AI-013') return 'DEFERRED_CAPABILITY';
    if (def.standard_question_code === 'SQ-AI-005' && (ctx.health_score?.prior_valid_score === null || ctx.health_score?.prior_valid_score === undefined)) return 'NOT_APPLICABLE';
    if (def.standard_question_code === 'SQ-AI-021') {
      const goalsCert = ctx.domain_certification.goals?.status;
      if (goalsCert === 'INVALID' || goalsCert === 'UNAVAILABLE') return 'DOMAIN_UNAVAILABLE';
      const offTrack = ctx.goals.filter((g) => g.track_status && AT_RISK_STATUSES.has(g.track_status));
      return offTrack.length === 0 ? 'NOT_APPLICABLE' : 'AVAILABLE';
    }
    for (const domain of def.required_domains) {
      const cert = ctx.domain_certification[domain as keyof typeof ctx.domain_certification];
      if (cert && (cert.status === 'INVALID' || cert.status === 'UNAVAILABLE')) return 'DOMAIN_UNAVAILABLE';
    }
    // If the question depends on a stored-personalised explanation and no
    // pack has ever reached this household, surface the preparing/ not-ready
    // states honestly rather than defaulting everything to AVAILABLE.
    const dependsOnPack = def.components.some((c) => c.role === 'explanation');
    if (dependsOnPack) {
      if (!packStatus) return 'PACK_NOT_READY';
      if (['PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING'].includes(packStatus)) return 'PACK_NOT_READY';
    }
    return 'AVAILABLE';
  },

  /**
   * Spec section 27 — POST /api/ai/standard-questions/{code}/resolve. The
   * one real resolution path. Never accepts arbitrary prompt text — only a
   * catalogue question_code and (for SQ-AI-021 only) a household-owned
   * goal_id.
   */
  async resolveQuestion(userId: string, householdId: string | null, questionCode: string, target?: ResolveTarget): Promise<StandardQuestionResponse> {
    const { questions } = await loadStandardQuestionCatalogue();
    const def = questions.find((q) => q.standard_question_code === questionCode) ?? getQuestionDefinition(questionCode);
    if (!def || !def.enabled) {
      const fallback = getQuestionDefinition(questionCode);
      const r = response(fallback ?? placeholderDef(questionCode), 'FEATURE_DISABLED');
      await recordStandardQuestionAudit({ userId, householdId, questionCode, questionVersion: fallback?.question_version ?? null, status: r.status, answerOrigins: [] });
      return r;
    }

    const eligible = await AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined);
    const capabilityOn = AI_CAPABILITY_IMPLEMENTED.AI_STANDARD_QUESTIONS;
    if (def.premium_required && (!eligible || !capabilityOn)) {
      const r = response(def, 'PREMIUM_REQUIRED');
      await recordStandardQuestionAudit({ userId, householdId, questionCode, questionVersion: def.question_version, status: r.status, answerOrigins: [] });
      return r;
    }

    const controls = await getPlatformControls().catch(() => null);
    if (controls && !controls.ai_globally_enabled) {
      const r = response(def, 'FEATURE_DISABLED');
      await recordStandardQuestionAudit({ userId, householdId, questionCode, questionVersion: def.question_version, status: r.status, answerOrigins: [] });
      return r;
    }

    const deps = createRouterDependencies(userId, householdId);
    let ctx: FinancialContextObject;
    try {
      ctx = await deps.buildContext('FULL');
    } catch {
      const r = response(def, 'INSUFFICIENT_DATA');
      await recordStandardQuestionAudit({ userId, householdId, questionCode, questionVersion: def.question_version, status: r.status, answerOrigins: [] });
      return r;
    }

    const result = await this.resolveDefinition(deps, userId, householdId, def, ctx, target);
    await recordStandardQuestionAudit({
      userId,
      householdId,
      questionCode: def.standard_question_code,
      questionVersion: def.question_version,
      status: result.status,
      answerOrigins: result.answer_origins,
      dataAsOf: result.data_as_of,
    });
    return result;
  },

  async resolveDefinition(
    deps: RouterDependencies,
    userId: string,
    householdId: string | null,
    def: StandardQuestionDefinition,
    ctx: FinancialContextObject,
    target?: ResolveTarget
  ): Promise<StandardQuestionResponse> {
    // ------------------------------------------------------------------
    // Special-cased questions (spec sections 13-15, 86, 91) — never routed
    // through the generic composition engine because each needs a rule the
    // generic engine cannot express without inventing a ranking/calculation.
    // ------------------------------------------------------------------
    if (def.standard_question_code === 'SQ-AI-013') {
      // No canonical, ALREADY-COMPUTED, per-household stress result exists
      // in the certified FinancialContextObject today (resilience.
      // stress_test_outputs is unconditionally empty in
      // lib/ai/context/financialContextObject.ts) — the on-demand stress
      // engine exists (lib/engines/resilienceStress.ts,
      // /api/resilience/scenario) but running it FROM this service would be
      // exactly the "new calculation at question-resolution time" spec
      // sections 13/90 forbid. DEFERRED_CAPABILITY, unconditionally.
      return response(def, 'DEFERRED_CAPABILITY');
    }

    if (def.standard_question_code === 'SQ-AI-021') {
      return this.resolveGoalRiskQuestion(userId, householdId, def, ctx, target);
    }

    if (def.standard_question_code === 'SQ-AI-005' && (ctx.health_score?.prior_valid_score === null || ctx.health_score?.prior_valid_score === undefined)) {
      return response(def, 'NOT_APPLICABLE');
    }

    if (def.required_domains.length > 0) {
      for (const domain of def.required_domains) {
        const cert = ctx.domain_certification[domain as keyof typeof ctx.domain_certification];
        if (cert && (cert.status === 'INVALID' || cert.status === 'UNAVAILABLE')) return response(def, 'DOMAIN_UNAVAILABLE');
      }
    }

    // Every remaining catalogue entry (all except SQ-AI-013/021, handled
    // above) declares its own non-empty `components` array in
    // lib/ai/standardQuestions/catalogue.ts — this never mutates `def`
    // (a shared, module-level catalogue object) to stay request-safe.
    const outcomes = await resolveComponents(deps, userId, householdId, def.components);
    const requiredOutcomes = outcomes; // every declared component is required for this phase's questions
    const allResolved = requiredOutcomes.every((o) => o.result.answer_available);

    if (!allResolved) {
      const statuses = requiredOutcomes
        .filter((o) => !o.result.answer_available)
        .map((o) => {
          const missReason = o.result.resolver_trace.find((t) => !t.hit)?.miss_reason ?? null;
          const resolverUsed = o.component.role === 'metric' ? 'DETERMINISTIC' : o.component.role === 'definition' ? 'KNOWLEDGE_BASE' : 'STORED_PERSONALISED';
          return missReasonToStatus(missReason, resolverUsed);
        });
      return response(def, worstStatus(statuses));
    }

    const composed = composeAnswer(outcomes);
    if (def.standard_question_code === 'SQ-AI-025') {
      composed.answer.key_points = splitIntoUpToN(composed.answer.summary || composed.answer.headline, 3);
    }

    return response(def, 'AVAILABLE', {
      answer: composed.answer,
      answer_origins: composed.origins,
      source_refs: composed.sourceRefs,
      data_as_of: composed.dataAsOf,
      confidence: composed.confidence,
    });
  },

  /**
   * SQ-AI-021 (spec sections 27-28, 91). Never a stored/AI explanation —
   * purely certified per-goal deterministic fields, so "answer refers only
   * to Goal A" is trivially true (no prose to accidentally blend goals).
   * Ownership is enforced by construction: `ctx.goals` only ever contains
   * the authenticated user's own household's goals (buildFinancialContextObject
   * reads exclusively from the caller's own session) — a goal_id belonging
   * to another user can never appear in this array, so it is rejected as
   * "not found", identically to a goal_id that does not exist at all
   * (spec section 65: never distinguish "exists but not yours" from
   * "does not exist").
   */
  resolveGoalRiskQuestion(
    _userId: string,
    _householdId: string | null,
    def: StandardQuestionDefinition,
    ctx: FinancialContextObject,
    target?: ResolveTarget
  ): StandardQuestionResponse {
    const goalsCert = ctx.domain_certification.goals?.status;
    if (goalsCert === 'INVALID' || goalsCert === 'UNAVAILABLE') return response(def, 'DOMAIN_UNAVAILABLE');

    const offTrack = ctx.goals.filter((g) => g.track_status && AT_RISK_STATUSES.has(g.track_status));
    if (offTrack.length === 0) return response(def, 'NOT_APPLICABLE');

    if (!target?.goalId) {
      return response(def, 'AVAILABLE', {
        eligible_targets: offTrack.map((g) => ({ id: g.goal_reference, label: g.goal_type })),
      });
    }

    const goal = offTrack.find((g) => g.goal_reference === target.goalId);
    if (!goal) return response(def, 'TARGET_NOT_FOUND');

    const gapText =
      goal.required_contribution !== null && goal.contribution !== null
        ? `The certified forecast currently expects a contribution of about ${goal.required_contribution} per period to get this goal back on track, against a recorded contribution of ${goal.contribution}.`
        : 'FHIP does not have enough certified data to state the exact contribution gap for this goal.';

    return response(def, 'AVAILABLE', {
      answer: {
        headline: `This goal (${goal.goal_type}) is currently ${goal.track_status?.replace('_', ' ')}.`,
        summary: gapText,
        key_points: [
          `Target: ${goal.target_amount}`,
          `Current funding: ${goal.current_funding}`,
          goal.forecast_completion_date ? `Forecast completion: ${goal.forecast_completion_date}` : '',
        ].filter(Boolean),
        limitations: goal.confidence !== null && goal.confidence < 0.5 ? ['This goal’s forecast currently has low confidence.'] : [],
      },
      answer_origins: ['DETERMINISTIC'],
      source_refs: [{ source_type: 'goal', source_id: goal.goal_reference, data_as_of: null }],
      confidence: goal.confidence !== null ? (goal.confidence >= 0.75 ? 'HIGH' : goal.confidence >= 0.5 ? 'MEDIUM' : 'LOW') : null,
    });
  },
};

function placeholderDef(questionCode: string): StandardQuestionDefinition {
  return {
    standard_question_code: questionCode,
    question_version: 0,
    display_text: 'This question is not available.',
    short_label: 'Unavailable',
    category: 'FINANCIAL_OVERVIEW',
    description: '',
    personalised: false,
    premium_required: true,
    country_scope: null,
    required_domains: [],
    primary_intent_code: null,
    secondary_intent_codes: [],
    components: [],
    preferred_resolution_sources: [],
    stored_pack_block_codes: [],
    related_module: 'dashboard',
    action_route: '/dashboard',
    display_order: 999,
    requires_target: null,
    enabled: false,
    introduced_version: 'unknown',
  };
}

// Re-exported so getIntentDefinition stays a single import in tests that
// want to assert every catalogue intent code genuinely exists.
export { getIntentDefinition };
