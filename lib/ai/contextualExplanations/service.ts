// Module 11.5 — AIContextualExplanationService (spec section 8).
//
// The ONE entry point an in-module Explain / Why? control calls.
//
// ============================ STRUCTURAL ISOLATION ==========================
// Spec sections 51-53 and 84/119 require that a contextual Explain click can
// never reach a provider or a quota. That is enforced ARCHITECTURALLY here,
// not by a runtime check that could be bypassed. Read the import list below:
//
//   - lib/ai/gateway/aiModelGateway  ......... NOT imported, and never may be
//   - lib/ai/providers/*  .................... NOT imported, and never may be
//   - AIQuotaAdmissionService / ai_admit_request .. NOT imported/called
//   - reserveCustomQuestion / consumeCustomQuestion .. NOT imported/called
//
// This service depends ONLY on AIStandardQuestionService (Module 11.4) and
// lib/ai/resolution/router.ts (Module 11.2), and it always calls the router
// under the ZERO_COST_ONLY policy, which converts any would-be
// LIVE_AI_REQUIRED result into an inert UNAVAILABLE inside the router itself
// (see applyZeroCostPolicy there) BEFORE this file ever sees it. There is
// therefore no branch here that could escalate, because there is nothing to
// escalate to. tests/unit/aiContextualExplanationProviderProof.test.ts asserts
// this import boundary as a test, so a future edit that adds a forbidden
// import fails CI rather than silently costing money.
//
// ============================ NO SECOND ARCHITECTURE ========================
// Spec section 4. Nothing here re-implements resolution. Delegated targets
// call AIStandardQuestionService wholesale; contextual-only targets call the
// SAME Module 11.2 router, with the SAME policy, over intent codes that
// already existed in the SAME taxonomy. The only logic that lives here is
// (a) target validation/ownership, (b) snapshot binding, and (c) deterministic
// presentation assembly — never a new way of producing an answer.

import { createClient } from '@/lib/supabase/server';
import { AIEntitlementService } from '@/lib/ai/entitlement/aiEntitlementService';
import { AI_CAPABILITY_IMPLEMENTED } from '@/lib/ai/entitlement/capabilities';
import { getPlatformControls } from '@/lib/ai/entitlement/platformControls';
import { resolveAnswer } from '@/lib/ai/resolution/router';
import type { RouterDependencies } from '@/lib/ai/resolution/router';
import { createRouterDependencies } from '@/lib/ai/resolution/routerDependencies';
import type { ResolutionResult } from '@/lib/ai/resolution/types';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { AIStandardQuestionService } from '@/lib/ai/standardQuestions/service';
import { ANSWER_ORIGIN_LABELS } from '@/lib/ai/standardQuestions/types';
import type { AnswerOrigin, StandardQuestionAnswer, StandardQuestionSourceRef } from '@/lib/ai/standardQuestions/types';
import { recordContextualExplanationAudit } from '@/lib/ai/contextualExplanations/audit';
import { recordContextualExplanationMetric } from '@/lib/ai/observability/aiMetrics';
import { CURRENT_SNAPSHOT_BOUND_REPORT_TARGETS, getContextualTarget } from '@/lib/ai/contextualExplanations/registry';
import { loadContextualTargetRegistry } from '@/lib/ai/contextualExplanations/registryDb';
import {
  CONTEXTUAL_AVAILABILITY_LABELS,
  FINANCIAL_INSIGHTS_ROUTE,
  PERSONALISED_ROLES,
  mapSupportStatus,
} from '@/lib/ai/contextualExplanations/types';
import type {
  ContextualAvailability,
  ContextualComponent,
  ContextualExplanationResponse,
  ContextualExplanationTarget,
} from '@/lib/ai/contextualExplanations/types';

// ---------------------------------------------------------------------------
// Request shape (spec sections 11, 54-56).
//
// There is deliberately NO `message`, `prompt`, `question`, `intent_code` or
// `standard_question_code` field. A caller supplies a registry target code and
// (only where the registry says the target needs one) an owned entity id. Any
// intent/question mapping is read from the SERVER-SIDE registry, never from
// the request — so a client cannot select which question gets asked, only
// which approved target it is asking about.
// ---------------------------------------------------------------------------
export interface ContextualExplanationRequest {
  target_code: string;
  /** The owned entity this target addresses (goal id / report id). Ignored when the target takes none. */
  target_id?: string | null;
  /** Optional snapshot the client believes it is viewing; verified server-side (spec section 47). */
  context_id?: string | null;
}

/** Spec section 110 — contextual answers are shorter than the full library answer. */
const MAX_CONTEXTUAL_KEY_POINTS = 3;
const MAX_CONTEXTUAL_SUMMARY_SENTENCES = 4;

function trimToSentences(text: string, max: number): string {
  // Deterministic presentation trim (spec sections 109-110). A plain sentence
  // split of ALREADY-APPROVED, already-validated prose — never a model
  // rewrite, never new content, never reordered.
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= max) return text.trim();
  return sentences.slice(0, max).join(' ');
}

function contextualiseAnswer(answer: StandardQuestionAnswer | null): StandardQuestionAnswer | null {
  if (!answer) return null;
  return {
    headline: answer.headline,
    summary: trimToSentences(answer.summary, MAX_CONTEXTUAL_SUMMARY_SENTENCES),
    key_points: answer.key_points.slice(0, MAX_CONTEXTUAL_KEY_POINTS),
    limitations: answer.limitations.slice(0, MAX_CONTEXTUAL_KEY_POINTS),
  };
}

function originFor(resolutionType: ResolutionResult['resolution']): AnswerOrigin | null {
  if (resolutionType === 'DETERMINISTIC') return 'DETERMINISTIC';
  if (resolutionType === 'KNOWLEDGE_BASE') return 'KNOWLEDGE_BASE';
  if (resolutionType === 'STORED_PERSONALISED' || resolutionType === 'EXACT_CACHE') return 'STORED_PERSONALISED';
  return null;
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

// ---------------------------------------------------------------------------
// Report binding (spec sections 13, 46-48, 64).
// ---------------------------------------------------------------------------
export interface ReportBinding {
  reportId: string;
  reportMonth: string | null;
  asOfDate: string | null;
  versionNumber: number | null;
  dataCompletenessPct: number | null;
  reportingCurrency: string | null;
  financialSnapshotId: string | null;
  /** True only when this report is bound to the household's CURRENT financial snapshot. */
  isCurrentSnapshot: boolean;
}

/**
 * Loads a report the AUTHENTICATED user owns, and decides whether it
 * represents the household's current snapshot or a historical one.
 *
 * OWNERSHIP (spec sections 13, 122). Two independent barriers:
 *   1. createClient() is the request-scoped, RLS-enforcing client — the
 *      `reports` table's own "own reports" policy already restricts rows to
 *      auth.uid().
 *   2. An explicit .eq('user_id', userId) on top of it.
 * A report id belonging to another household therefore returns no row and is
 * reported as TARGET_NOT_FOUND — indistinguishable from an id that does not
 * exist at all, so this never confirms the existence of another user's report.
 *
 * FAIL CLOSED: a report with no financial_snapshot_id cannot be PROVEN to be
 * current, so it is treated as historical rather than assumed current. That is
 * the safe direction — it withholds a current-data explanation rather than
 * attaching today's figures to an unknown-vintage report.
 */
export async function loadReportBinding(userId: string, reportId: string): Promise<ReportBinding | null> {
  const supabase = await createClient();

  const { data: report } = await supabase
    .from('reports')
    .select('id, report_month, as_of_date, version_number, data_completeness_pct, reporting_currency, financial_snapshot_id')
    .eq('id', reportId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!report) return null;

  const { data: latestSnapshot } = await supabase
    .from('financial_snapshots')
    .select('id')
    .eq('user_id', userId)
    .order('snapshot_month', { ascending: false })
    .limit(1)
    .maybeSingle();

  const reportSnapshotId = (report.financial_snapshot_id as string | null) ?? null;
  const currentSnapshotId = (latestSnapshot?.id as string | undefined) ?? null;

  return {
    reportId: report.id as string,
    reportMonth: (report.report_month as string | null) ?? null,
    asOfDate: (report.as_of_date as string | null) ?? null,
    versionNumber: (report.version_number as number | null) ?? null,
    dataCompletenessPct: (report.data_completeness_pct as number | null) ?? null,
    reportingCurrency: (report.reporting_currency as string | null) ?? null,
    financialSnapshotId: reportSnapshotId,
    isCurrentSnapshot: reportSnapshotId !== null && currentSnapshotId !== null && reportSnapshotId === currentSnapshotId,
  };
}

/** Spec section 64 — a historical report explanation must never read as current information. */
function sourceContextLabel(binding: ReportBinding | null): string | null {
  if (!binding) return null;
  const when = binding.reportMonth ?? binding.asOfDate;
  if (!when) return 'Based on your saved report';
  const label = formatReportMonth(when);
  return binding.isCurrentSnapshot ? `Based on your ${label} report (your current position)` : `Based on your ${label} report`;
}

function formatReportMonth(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------
interface EnvelopeOpts {
  answer?: StandardQuestionAnswer | null;
  answerOrigins?: AnswerOrigin[];
  sourceRefs?: StandardQuestionSourceRef[];
  dataAsOf?: string | null;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  eligibleTargets?: { id: string; label: string }[];
  binding?: ReportBinding | null;
}

function envelope(
  target: ContextualExplanationTarget,
  status: ContextualAvailability,
  targetId: string | null,
  opts: EnvelopeOpts = {}
): ContextualExplanationResponse {
  const origins = opts.answerOrigins ?? [];
  const binding = opts.binding ?? null;
  return {
    module: target.module_code,
    target_code: target.target_code,
    target_id: targetId,
    status,
    status_label: CONTEXTUAL_AVAILABILITY_LABELS[status],
    question: target.display_question,
    answer: opts.answer ?? null,
    answer_origins: origins,
    answer_origin_labels: origins.map((o) => ANSWER_ORIGIN_LABELS[o]),
    source_refs: opts.sourceRefs ?? [],
    data_as_of: opts.dataAsOf ?? null,
    confidence: opts.confidence ?? null,
    source_context_label: sourceContextLabel(binding),
    historical_context: binding ? !binding.isCurrentSnapshot : false,
    related_module: target.related_module,
    action_route: target.action_route,
    insights_route: FINANCIAL_INSIGHTS_ROUTE,
    provider_called: false,
    custom_quota_consumed: false,
    ...(opts.eligibleTargets ? { eligible_targets: opts.eligibleTargets } : {}),
  };
}

// ---------------------------------------------------------------------------
// Contextual-only composition (spec section 10).
// ---------------------------------------------------------------------------
interface ComponentOutcome {
  component: ContextualComponent;
  result: ResolutionResult;
}

async function resolveComponents(
  deps: RouterDependencies,
  userId: string,
  householdId: string | null,
  components: ContextualComponent[]
): Promise<ComponentOutcome[]> {
  const outcomes: ComponentOutcome[] = [];
  for (const component of components) {
    // Sequential, matching AIStandardQuestionService: components of one target
    // commonly share the same context build, and sequential execution keeps DB
    // load and query counts predictable for the performance benchmark.
    const result = await resolveAnswer(deps, {
      userId,
      householdId,
      request: { intent_code: component.intent_code },
      // ALWAYS. There is no code path in this file that omits this or passes
      // 'STANDARD' (spec sections 14, 51).
      policy: 'ZERO_COST_ONLY',
    });
    outcomes.push({ component, result });
  }
  return outcomes;
}

function missReasonToAvailability(missReason: string | null): ContextualAvailability {
  if (!missReason) return 'INSUFFICIENT_DATA';
  if (missReason.startsWith('certification_invalid') || missReason.startsWith('certification_unavailable')) return 'DOMAIN_UNAVAILABLE';
  if (missReason === 'premium_required') return 'PREMIUM_REQUIRED';
  if (missReason === 'no_valid_stored_answer' || missReason === 'stored_answer_read_failed') return 'INSIGHT_PREPARING';
  return 'INSUFFICIENT_DATA';
}

function composeContextual(outcomes: ComponentOutcome[]): {
  answer: StandardQuestionAnswer;
  origins: AnswerOrigin[];
  sourceRefs: StandardQuestionSourceRef[];
  dataAsOf: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  personalisedResolved: boolean;
  storedUsed: boolean;
} {
  const origins = new Set<AnswerOrigin>();
  const sourceRefs: StandardQuestionSourceRef[] = [];
  const summaryParts: string[] = [];
  const keyPoints: string[] = [];
  const limitations: string[] = [];
  let headline = '';
  let dataAsOf: string | null = null;
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null = null;
  let personalisedResolved = false;
  let storedUsed = false;

  for (const { component, result } of outcomes) {
    if (!result.answer_available || !result.response) continue;
    const origin = originFor(result.resolution);
    if (origin) origins.add(origin);
    if (origin === 'STORED_PERSONALISED') storedUsed = true;
    if (PERSONALISED_ROLES.has(component.role)) personalisedResolved = true;

    sourceRefs.push(...result.source_refs.map((r) => ({ source_type: r.source_type, source_id: r.source_id, data_as_of: r.data_as_of })));
    if (result.response.data_as_of && (!dataAsOf || result.response.data_as_of > dataAsOf)) dataAsOf = result.response.data_as_of;
    limitations.push(...result.response.limitations);

    if (component.role === 'explanation') {
      if (!headline) headline = result.response.headline;
      if (result.response.summary) summaryParts.unshift(result.response.summary);
      confidence = result.response.confidence ?? confidence;
    } else if (component.role === 'metric') {
      if (!headline) headline = result.response.headline;
      summaryParts.push(result.response.headline);
    } else {
      if (result.response.summary) keyPoints.push(result.response.summary);
    }
  }

  const displayOrigins: AnswerOrigin[] = origins.size > 1 ? ['COMPOSED_ZERO_COST'] : [...origins];
  return {
    answer: {
      headline: headline || 'Here is what FHIP can tell you.',
      summary: trimToSentences(dedupe(summaryParts).join(' '), MAX_CONTEXTUAL_SUMMARY_SENTENCES),
      key_points: dedupe(keyPoints).slice(0, MAX_CONTEXTUAL_KEY_POINTS),
      limitations: dedupe(limitations).slice(0, MAX_CONTEXTUAL_KEY_POINTS),
    },
    origins: displayOrigins,
    sourceRefs,
    dataAsOf,
    confidence,
    personalisedResolved,
    storedUsed,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------
export const AIContextualExplanationService = {
  /**
   * Spec section 54 — POST /api/ai/contextual-explanations/resolve.
   *
   * Ordered exactly as spec section 8 lists the responsibilities:
   *   1-2. authenticate/authorise  (done by the caller's resolveHouseholdContext)
   *   3.   validate the target exists and is enabled
   *   4.   feature switches
   *   5.   Premium entitlement (server-authoritative)
   *   6.   validate the target entity is owned by this household
   *   7.   resolve zero-cost
   *   8.   structured envelope
   *   9-10. audit + analytics
   */
  async resolveExplanation(
    userId: string,
    householdId: string | null,
    request: ContextualExplanationRequest
  ): Promise<ContextualExplanationResponse | { unknownTarget: true }> {
    const startedAt = Date.now();

    // Spec section 55 — "Unknown target: reject." Checked against the CODE
    // registry first (the stable source of truth for whether a target exists
    // at all) and signalled distinctly from every availability state, so the
    // route can answer 404 rather than pretending an invented target exists
    // but is merely unavailable.
    if (!getContextualTarget(request.target_code)) return { unknownTarget: true };

    // The effective definition additionally honours the admin `enabled`
    // override (migration 0126). An admin-disabled target is a real target
    // that is switched off — a controlled unavailable state, not a 404. A
    // registry read failure returns [] (fail closed), which lands on the same
    // FEATURE_DISABLED branch below rather than serving an explanation.
    const effective = await loadContextualTargetRegistry();
    const target = effective.find((x) => x.target_code === request.target_code) ?? { ...getContextualTarget(request.target_code)!, enabled: false };

    // Spec sections 60-61 — a SELECTION is a control a user actually clicked.
    // Recorded here on entry, before any outcome is known, so it counts the
    // user's action rather than the answer's success.
    recordContextualExplanationMetric({ event: 'selected', module: target.module_code, targetCode: target.target_code });

    const targetId = target.target_entity_type ? (typeof request.target_id === 'string' && request.target_id ? request.target_id : null) : null;

    const finish = async (response: ContextualExplanationResponse, storedUsed = false): Promise<ContextualExplanationResponse> => {
      await recordContextualExplanationAudit({
        userId,
        householdId,
        targetCode: target.target_code,
        moduleCode: target.module_code,
        intentCode: target.intent_code,
        standardQuestionCode: target.standard_question_code,
        targetEntityId: targetId,
        historicalContext: response.historical_context,
        status: response.status,
        answerOrigins: response.answer_origins,
        dataAsOf: response.data_as_of,
        latencyMs: Date.now() - startedAt,
      });
      recordContextualExplanationMetric({
        event:
          response.status === 'AVAILABLE'
            ? 'resolved'
            : response.status === 'PREMIUM_REQUIRED'
              ? 'premium_blocked'
              : 'unavailable',
        module: target.module_code,
        targetCode: target.target_code,
        availability: response.status,
        resolutionOrigin: response.answer_origins[0],
        historicalContext: response.historical_context,
        storedAnswerUsed: storedUsed,
      });
      return response;
    };

    // Spec section 55 — a DISABLED target is a controlled unavailable state,
    // not a rejection (it is a real target the admin has switched off).
    if (!target.enabled) {
      return finish(envelope(target, 'FEATURE_DISABLED', targetId));
    }

    // -----------------------------------------------------------------------
    // Feature switches (spec sections 58-59).
    //
    // Note what is NOT consulted here: live_provider_enabled. Module 11.5
    // never invokes a provider, so the live-provider kill switch must not
    // disable it (spec sections 59, 92). Asserted by test, not just comment.
    // -----------------------------------------------------------------------
    const controls = await getPlatformControls().catch(() => null);
    if (controls && (!controls.ai_globally_enabled || controls.contextual_explanations_enabled === false)) {
      return finish(envelope(target, 'FEATURE_DISABLED', targetId));
    }

    // -----------------------------------------------------------------------
    // Premium entitlement — SERVER-AUTHORITATIVE (spec section 20). Hiding the
    // button in the UI is presentation only; this is the decision. No field of
    // the request participates: a client-supplied "premium" flag has nowhere
    // to be read from, because ContextualExplanationRequest has no such field.
    // -----------------------------------------------------------------------
    const eligible = await AIEntitlementService.isPersonalisedAIEligible(userId, householdId ?? undefined);
    const capabilityOn = AI_CAPABILITY_IMPLEMENTED.AI_CONTEXTUAL_EXPLANATIONS;
    if (target.premium_required && (!eligible || !capabilityOn)) {
      return finish(envelope(target, 'PREMIUM_REQUIRED', targetId));
    }

    // -----------------------------------------------------------------------
    // Target ownership + snapshot binding (spec sections 13, 46-48).
    // -----------------------------------------------------------------------
    let binding: ReportBinding | null = null;
    if (target.target_entity_type === 'report') {
      if (!targetId) return finish(envelope(target, 'TARGET_REQUIRED', null));
      binding = await loadReportBinding(userId, targetId);
      // Cross-tenant, deleted, or non-existent — all the same answer.
      if (!binding) return finish(envelope(target, 'TARGET_NOT_FOUND', targetId));

      // Spec section 47 — when the client states which snapshot it believes it
      // is viewing, the SERVER verifies the relationship rather than trusting
      // it. A mismatch means the client's view and the requested report do not
      // agree, which must never be resolved as if they did.
      if (request.context_id && request.context_id !== binding.financialSnapshotId) {
        return finish(envelope(target, 'TARGET_NOT_FOUND', targetId, { binding }));
      }

      // Spec sections 46/48 — a target whose answer would be composed from
      // CURRENT household figures cannot be served for a HISTORICAL report.
      // Returning today's score for a six-month-old report is exactly the
      // cross-context substitution section 48 forbids, so this is refused
      // with the dedicated user-safe state rather than answered.
      if (!binding.isCurrentSnapshot && CURRENT_SNAPSHOT_BOUND_REPORT_TARGETS.has(target.target_code)) {
        return finish(envelope(target, 'HISTORICAL_EXPLANATION_UNAVAILABLE', targetId, { binding }));
      }
    }

    // -----------------------------------------------------------------------
    // Resolution — path A0: REPORT_OVERVIEW, resolved strictly from the
    // requested report's OWN record (spec sections 45-48).
    //
    // WHY THIS IS NOT COMPOSED FROM THE REPORT_PERIOD / REPORT_VERSION
    // INTENTS. Those intents are, by their own definition in
    // lib/ai/resolution/deterministicResolver.ts, hardwired to
    // `ctx.reports[0]` — the household's MOST RECENT report. Composing them
    // for a target that names a SPECIFIC report_id would answer about the
    // wrong report entirely: open a March report and be told September's
    // period. That is precisely the cross-context substitution spec section 48
    // forbids, so this path reads the ownership-checked binding row instead —
    // still a pure field read of certified data, never a recalculation.
    // -----------------------------------------------------------------------
    if (target.target_code === 'REPORT_OVERVIEW' && binding) {
      const overview = await this.resolveReportOverview(createRouterDependencies(userId, householdId), userId, householdId, target, binding);
      return finish(overview, overview.answer_origins.includes('COMPOSED_ZERO_COST'));
    }

    // -----------------------------------------------------------------------
    // Resolution — path A: delegate wholesale to Module 11.4 (spec section 9).
    // -----------------------------------------------------------------------
    if (target.standard_question_code) {
      const sq = await AIStandardQuestionService.resolveQuestion(
        userId,
        householdId,
        target.standard_question_code,
        target.target_entity_type === 'goal' && targetId ? { goalId: targetId } : undefined
      );

      // A goal target with no goal selected: 11.4 returns AVAILABLE plus the
      // caller's OWN eligible goals. Surfaced as TARGET_REQUIRED so the panel
      // asks which goal rather than showing a blank answer.
      if (target.target_entity_type === 'goal' && !targetId && sq.eligible_targets) {
        return finish(envelope(target, 'TARGET_REQUIRED', null, { eligibleTargets: sq.eligible_targets }));
      }

      const status = mapSupportStatus(sq.status);
      const storedUsed = sq.answer_origins.includes('STORED_PERSONALISED') || sq.answer_origins.includes('COMPOSED_ZERO_COST');
      return finish(
        envelope(target, status, targetId, {
          answer: status === 'AVAILABLE' ? contextualiseAnswer(sq.answer) : null,
          answerOrigins: status === 'AVAILABLE' ? sq.answer_origins : [],
          sourceRefs: status === 'AVAILABLE' ? sq.source_refs : [],
          dataAsOf: sq.data_as_of,
          confidence: sq.confidence,
          binding,
        }),
        storedUsed
      );
    }

    // -----------------------------------------------------------------------
    // Resolution — path B: contextual-only composition over existing intents.
    // -----------------------------------------------------------------------
    const deps = createRouterDependencies(userId, householdId);
    let ctx: FinancialContextObject;
    try {
      ctx = await deps.buildContext('FULL');
    } catch {
      return finish(envelope(target, 'INSUFFICIENT_DATA', targetId, { binding }));
    }

    for (const domain of target.required_domains) {
      const cert = ctx.domain_certification[domain as keyof typeof ctx.domain_certification];
      if (cert && (cert.status === 'INVALID' || cert.status === 'UNAVAILABLE')) {
        return finish(envelope(target, 'DOMAIN_UNAVAILABLE', targetId, { binding }));
      }
    }

    const outcomes = await resolveComponents(deps, userId, householdId, target.components);

    const failedRequired = outcomes.filter((o) => o.component.required && !o.result.answer_available);
    if (failedRequired.length > 0) {
      const reason = failedRequired[0].result.resolver_trace.find((t) => !t.hit)?.miss_reason ?? null;
      return finish(envelope(target, missReasonToAvailability(reason), targetId, { binding }));
    }

    const composed = composeContextual(outcomes);

    // ---------------------------------------------------------------------
    // PERSONALISATION GATE (spec section 125's fail condition: "Generic
    // Knowledge content is presented as personalised WHY answer").
    //
    // A target only becomes AVAILABLE when at least one component carrying
    // the household's OWN data actually resolved. If every optional
    // personalised component missed and only a Knowledge Base definition
    // survived, the honest answer is "not available", never a glossary entry
    // dressed up as a personal explanation.
    // ---------------------------------------------------------------------
    if (!composed.personalisedResolved) {
      return finish(envelope(target, 'INSUFFICIENT_DATA', targetId, { binding }));
    }

    return finish(
      envelope(target, 'AVAILABLE', targetId, {
        answer: composed.answer,
        answerOrigins: composed.origins,
        sourceRefs: composed.sourceRefs,
        dataAsOf: composed.dataAsOf ?? binding?.asOfDate ?? null,
        confidence: composed.confidence,
        binding,
      }),
      composed.storedUsed
    );
  },

  /**
   * REPORT_OVERVIEW (spec sections 45-48, 64).
   *
   * Deterministic facts come from the ALREADY OWNERSHIP-CHECKED report row —
   * this report's period, as-of date, version, currency and recorded data
   * completeness. Nothing is recalculated and nothing is read from another
   * report.
   *
   * The stored household-level `report_reading_summary` commentary is added
   * ONLY when the report is bound to the current snapshot. That block is
   * generated against the household's CURRENT position, so attaching it to a
   * historical report would be a cross-context substitution — the same defect
   * this method exists to avoid. For a historical report the answer is the
   * report's own certified facts, clearly labelled with its own period.
   */
  async resolveReportOverview(
    deps: RouterDependencies,
    userId: string,
    householdId: string | null,
    target: ContextualExplanationTarget,
    binding: ReportBinding
  ): Promise<ContextualExplanationResponse> {
    const period = binding.reportMonth ? formatReportMonth(binding.reportMonth) : null;
    if (!period) return envelope(target, 'INSUFFICIENT_DATA', binding.reportId, { binding });

    const keyPoints = [
      binding.asOfDate ? `Financial position as at ${binding.asOfDate}.` : '',
      binding.versionNumber !== null ? `Report version ${binding.versionNumber}.` : '',
      binding.dataCompletenessPct !== null ? `Recorded data completeness at the time: ${binding.dataCompletenessPct}%.` : '',
    ].filter(Boolean);

    const origins: AnswerOrigin[] = ['DETERMINISTIC'];
    const sourceRefs: StandardQuestionSourceRef[] = [{ source_type: 'report', source_id: binding.reportId, data_as_of: binding.asOfDate }];
    let summary = binding.isCurrentSnapshot
      ? `This report covers ${period} and reflects your current recorded financial position.`
      : `This report covers ${period}. It is a saved snapshot of your position at that time, not your position today.`;
    let storedUsed = false;
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null = 'HIGH';

    if (binding.isCurrentSnapshot) {
      const stored = await resolveAnswer(deps, {
        userId,
        householdId,
        request: { intent_code: 'REPORT_READING_EXPLANATION' },
        policy: 'ZERO_COST_ONLY',
      });
      if (stored.answer_available && stored.response) {
        origins.length = 0;
        origins.push('COMPOSED_ZERO_COST');
        summary = trimToSentences(`${stored.response.summary} ${summary}`.trim(), MAX_CONTEXTUAL_SUMMARY_SENTENCES);
        sourceRefs.push(...stored.source_refs.map((r) => ({ source_type: r.source_type, source_id: r.source_id, data_as_of: r.data_as_of })));
        confidence = stored.response.confidence ?? confidence;
        storedUsed = true;
      }
    }

    void storedUsed; // origin already records it (COMPOSED_ZERO_COST); kept explicit for readability

    return envelope(target, 'AVAILABLE', binding.reportId, {
      answer: {
        headline: `Your ${period} report.`,
        summary,
        key_points: keyPoints.slice(0, MAX_CONTEXTUAL_KEY_POINTS),
        limitations: binding.isCurrentSnapshot
          ? []
          : ['This explanation describes the saved report only. Your current position may have changed since it was generated.'],
      },
      answerOrigins: origins,
      sourceRefs,
      dataAsOf: binding.asOfDate,
      confidence,
      binding,
    });
  },
};

