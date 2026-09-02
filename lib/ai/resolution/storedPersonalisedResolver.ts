// Module 11.2 — StoredPersonalisedAnswerResolver (spec sections 27-29).
//
// Prepares for Module 11.3 (Monthly AI Insight Pack) / 11.4 (standard
// personalised questions): reads `ai_insights` for a previously-generated
// personalised explanation, never writes one — nothing in Module 11.2
// generates AI content. There are genuinely few/no real rows to find today
// (spec section 27 explicitly accepts this); the architecture and its
// snapshot-compatibility rule are exercised with synthetic fixtures.
//
// CONVENTION THIS MODULE DEFINES (nothing upstream populates ai_insights.
// future_ai_explanation yet, so 11.2 is free to define how a future producer
// and this consumer agree on matching): `metric_code` is set to the intent
// code the explanation answers. `snapshot_id` links to the metric the
// explanation was generated for.
//
// SNAPSHOT COMPATIBILITY (spec sections 28-29). `ai_insights` has no
// `snapshot_hash` column (that concept was only built for `ai_answer_cache`
// in Module 11.0). Rather than add a column purely to duplicate a check this
// resolver can already perform precisely, compatibility is derived by
// comparing the insight's own recorded `current_value` against the metric's
// LIVE certified value from the current FinancialContextObject: if they no
// longer match, the household's data has moved since the explanation was
// generated, and the stored answer is stale — never served (fails closed,
// same direction as spec section 30's cache-lookup failure policy).

import { createAdminClient } from '@/lib/supabase/admin';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import type { ResolvedAnswerEnvelope, ResolverAttempt } from '@/lib/ai/resolution/types';

export const STORED_RESOLVER_VERSION = 'stored-personalised-resolver-1.0.0';

export interface AiInsightRow {
  id: string;
  user_id: string;
  household_id: string | null;
  metric_code: string | null;
  current_value: number | null;
  future_ai_explanation: string | null;
  confidence: string | null;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
}

function valuesMatch(stored: number | null, live: unknown): boolean {
  if (stored === null) return true; // nothing recorded to compare against — accept on temporal validity alone
  if (typeof live !== 'number') return false;
  return Math.abs(stored - live) < 1e-6;
}

function extractLiveValueForIntent(intentCode: string, ctx: FinancialContextObject): unknown {
  // Deliberately duplicated as a tiny local lookup rather than importing
  // deterministicResolver's EXTRACTORS map (which is not exported — it is
  // that resolver's own private implementation detail): this function only
  // needs the numeric headline value for a handful of WHY-adjacent metric
  // intents, not the full extraction/certification machinery.
  switch (intentCode) {
    case 'SCORE_EXPLANATION':
      return ctx.health_score?.overall_score ?? null;
    case 'DNA_EXPLANATION':
      return null; // DNA profile is not numeric — temporal validity governs instead
    case 'RESILIENCE_EXPLANATION':
      return ctx.resilience?.resilience_score ?? null;
    default:
      return null;
  }
}

function envelope(intentCode: string, row: AiInsightRow): ResolvedAnswerEnvelope {
  return {
    resolution_type: 'STORED_PERSONALISED',
    intent_code: intentCode,
    answer_type: 'stored_personalised_answer',
    headline: row.future_ai_explanation ?? '',
    summary: row.future_ai_explanation ?? '',
    key_points: [],
    source_refs: [{ source_type: 'financial_snapshot', source_id: row.id, model_version: null, data_as_of: row.created_at }],
    confidence: (row.confidence?.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW') ?? 'MEDIUM',
    data_as_of: row.created_at,
    limitations: [],
    related_module: null,
    action_route: null,
    requires_live_ai: false,
    consumes_custom_quota: false,
    template_version: STORED_RESOLVER_VERSION,
  };
}

export interface StoredPersonalisedResolveInput {
  intentCode: string;
  userId: string;
  context: FinancialContextObject | null;
  /** From AIEntitlementService.isPersonalisedAIEligible() — Premium-only per spec section 52. */
  personalisedAiEligible: boolean;
}

export async function resolveStoredPersonalised(input: StoredPersonalisedResolveInput): Promise<ResolverAttempt> {
  const def = getIntentDefinition(input.intentCode);
  if (!def || !def.allowed_resolvers.includes('STORED_PERSONALISED')) {
    return { resolver: 'STORED_PERSONALISED', hit: false, answer: null, miss_reason: 'intent_not_stored_personalised' };
  }
  if (!input.personalisedAiEligible) {
    return { resolver: 'STORED_PERSONALISED', hit: false, answer: null, miss_reason: 'premium_required' };
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from('ai_insights')
    .select('id, user_id, household_id, metric_code, current_value, future_ai_explanation, confidence, valid_from, valid_until, created_at')
    .eq('user_id', input.userId) // tenant scope — never another household's row (spec section 28)
    .eq('metric_code', input.intentCode)
    .not('future_ai_explanation', 'is', null)
    .lte('valid_from', nowIso)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) return { resolver: 'STORED_PERSONALISED', hit: false, answer: null, miss_reason: 'stored_answer_read_failed' };

  const rows = (data ?? []) as AiInsightRow[];
  const liveValue = input.context ? extractLiveValueForIntent(input.intentCode, input.context) : null;

  for (const row of rows) {
    if (row.valid_until && row.valid_until <= nowIso) continue; // expired
    if (!valuesMatch(row.current_value, liveValue)) continue; // stale snapshot (spec section 29)
    return { resolver: 'STORED_PERSONALISED', hit: true, answer: envelope(input.intentCode, row), miss_reason: null };
  }

  return { resolver: 'STORED_PERSONALISED', hit: false, answer: null, miss_reason: 'no_valid_stored_answer' };
}
