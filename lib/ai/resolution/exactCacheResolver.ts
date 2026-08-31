// Module 11.2 — ExactCacheResolver (spec sections 30-32, 57).
//
// Wraps Module 11.1's `ai_answer_cache` lookup/store helpers
// (lib/ai/cache/answerCache.ts) rather than re-implementing cache key
// derivation — that module already IS the sanctioned exact-key scheme
// (user_id, intent_code, normalised_question_hash, snapshot_hash,
// context_version, prompt_version, model_version). This resolver adds only
// what 11.2 needs on top: the entitlement gate for personalised content, and
// deriving `snapshot_hash` from the intent's certified domain(s) via
// computeSnapshotHash() rather than trusting a caller-supplied hash.
//
// NO SEMANTIC CACHE (spec section 32): matching is exact on the normalised
// question text only (see lib/ai/cache/answerCache.ts's own
// normaliseQuestion — textual, not semantic). `semantic_key` stays null.

import { CONTEXT_VERSION, type FinancialContextObject } from '@/lib/ai/context/types';
import { lookupCachedAnswer, storeCachedAnswer, type CachedAnswerRow } from '@/lib/ai/cache/answerCache';
import { computeSnapshotHash } from '@/lib/ai/resolution/snapshotHash';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import type { ResolvedAnswerEnvelope, ResolverAttempt } from '@/lib/ai/resolution/types';

export const EXACT_CACHE_RESOLVER_VERSION = 'exact-cache-resolver-1.0.0';

function envelope(intentCode: string, row: CachedAnswerRow): ResolvedAnswerEnvelope {
  const stored = row.answer_json as Partial<ResolvedAnswerEnvelope> | null;
  return {
    resolution_type: 'EXACT_CACHE',
    intent_code: intentCode,
    answer_type: stored?.answer_type ?? 'cached_answer',
    headline: stored?.headline ?? '',
    summary: stored?.summary ?? '',
    key_points: stored?.key_points ?? [],
    source_refs: Array.isArray(row.source_references) ? (row.source_references as ResolvedAnswerEnvelope['source_refs']) : [],
    confidence: (row.confidence?.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW') ?? null,
    data_as_of: stored?.data_as_of ?? null,
    limitations: stored?.limitations ?? [],
    related_module: stored?.related_module ?? null,
    action_route: stored?.action_route ?? null,
    requires_live_ai: false,
    consumes_custom_quota: false,
    template_version: EXACT_CACHE_RESOLVER_VERSION,
  };
}

export interface ExactCacheResolveInput {
  intentCode: string;
  userId: string;
  householdId: string | null;
  question: string;
  context: FinancialContextObject | null;
  personalisedAiEligible: boolean;
}

export async function resolveExactCache(input: ExactCacheResolveInput): Promise<ResolverAttempt> {
  const def = getIntentDefinition(input.intentCode);
  if (!def || !def.allowed_resolvers.includes('EXACT_CACHE')) {
    return { resolver: 'EXACT_CACHE', hit: false, answer: null, miss_reason: 'intent_not_cacheable' };
  }
  if (def.personalised && !input.personalisedAiEligible) {
    return { resolver: 'EXACT_CACHE', hit: false, answer: null, miss_reason: 'premium_required' };
  }
  if (!input.context) {
    return { resolver: 'EXACT_CACHE', hit: false, answer: null, miss_reason: 'no_context_to_scope_cache' };
  }

  const snapshotHash = computeSnapshotHash(input.context, def.requires_certified_domain);
  const row = await lookupCachedAnswer({
    userId: input.userId,
    intentCode: input.intentCode,
    question: input.question,
    snapshotHash,
    contextVersion: CONTEXT_VERSION,
    promptVersion: null,
    modelVersion: null,
  });

  if (!row) return { resolver: 'EXACT_CACHE', hit: false, answer: null, miss_reason: 'no_cache_hit' };
  return { resolver: 'EXACT_CACHE', hit: true, answer: envelope(input.intentCode, row), miss_reason: null };
}

/** Stores a zero-cost-eligible answer for later exact reuse (spec section 30). Best-effort. */
export async function storeExactCacheAnswer(input: {
  intentCode: string;
  userId: string;
  householdId: string | null;
  question: string;
  context: FinancialContextObject;
  answer: ResolvedAnswerEnvelope;
}): Promise<boolean> {
  const def = getIntentDefinition(input.intentCode);
  if (!def) return false;
  const snapshotHash = computeSnapshotHash(input.context, def.requires_certified_domain);
  return storeCachedAnswer({
    userId: input.userId,
    householdId: input.householdId,
    intentCode: input.intentCode,
    question: input.question,
    snapshotHash,
    contextVersion: CONTEXT_VERSION,
    promptVersion: null,
    modelVersion: null,
    answerJson: input.answer,
    sourceReferences: input.answer.source_refs,
    confidence: input.answer.confidence,
    expiresAt: null,
  });
}
