// Module 11.1 — server-side ai_answer_cache lookup.
//
// SCOPE. This is NOT the answer-caching feature. Module 11.1 builds no
// user-facing AI surface, so nothing here is wired into a chat flow. It exists
// for exactly one enforcement reason: the rule "a cached answer must not
// consume quota" hinges on a boolean `cacheHit`, and a boolean that the caller
// simply asserts is not a fact — it is a quota-bypass switch. This module is
// the sanctioned server-side derivation of that boolean, so a future consumer
// has one correct way to produce it and never has to invent one.
//
// Module 11.0 created ai_answer_cache as a pure schema placeholder: nothing in
// the codebase read or wrote it, and no hashing helper existed. The key scheme
// below is read off that schema's own lookup index:
//     (user_id, intent_code, normalised_question_hash) where invalidated_at is null
// with snapshot_hash / context_version / prompt_version / model_version stored
// but NOT indexed — so they are validated after the lookup, exactly as the
// schema shape implies.
//
// DELIBERATELY NOT IMPLEMENTED: semantic duplicate detection. `semantic_key`
// stays null. Module 11.0 recorded semantic matching as deferred, and a
// "similar enough" match silently suppressing quota consumption is a
// commercial decision, not an implementation detail.

import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

export interface CachedAnswerRow {
  id: string;
  user_id: string;
  household_id: string | null;
  snapshot_hash: string;
  context_version: string;
  intent_code: string;
  normalised_question_hash: string;
  prompt_version: number | null;
  model_version: string | null;
  answer_json: unknown;
  source_references: unknown;
  confidence: string | null;
  created_at: string;
  expires_at: string | null;
  invalidated_at: string | null;
}

/**
 * Normalises a question before hashing so trivially different spellings of
 * the same question hit the same cache row: lowercased, whitespace collapsed,
 * trailing punctuation trimmed. This is deliberately conservative — it is
 * textual normalisation only, never semantic similarity.
 */
export function normaliseQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!,;:\s]+$/g, '')
    .trim();
}

export function normalisedQuestionHash(question: string): string {
  return createHash('sha256').update(normaliseQuestion(question)).digest('hex');
}

export interface CacheLookupInput {
  userId: string;
  intentCode: string;
  question: string;
  /** Hash of the household's certified data as of this request; a changed snapshot invalidates a cached answer. */
  snapshotHash: string;
  contextVersion: string;
  promptVersion: number | null;
  modelVersion: string | null;
}

/**
 * Returns a still-valid cached answer, or null.
 *
 * Every mismatch returns null (i.e. "not a cache hit", i.e. quota WILL be
 * consumed). That is the fail-closed direction for this particular check:
 * wrongly reporting a hit would serve a stale answer AND give away a free
 * question, while wrongly reporting a miss only costs one unit of a
 * legitimately-owned allowance.
 */
export async function lookupCachedAnswer(input: CacheLookupInput): Promise<CachedAnswerRow | null> {
  if (!input.userId || !input.intentCode || !input.snapshotHash) return null;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return null;
  }

  const { data, error } = await admin
    .from('ai_answer_cache')
    .select('*')
    .eq('user_id', input.userId)
    .eq('intent_code', input.intentCode)
    .eq('normalised_question_hash', normalisedQuestionHash(input.question))
    .is('invalidated_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // A cache read that failed is a cache miss, never a hit.
  if (error || !data) return null;
  const row = data as CachedAnswerRow;

  // Post-lookup validation of the fields the index does not cover.
  if (row.snapshot_hash !== input.snapshotHash) return null;
  if (row.context_version !== input.contextVersion) return null;
  if (input.promptVersion !== null && row.prompt_version !== input.promptVersion) return null;
  if (input.modelVersion !== null && row.model_version !== input.modelVersion) return null;
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now()) return null;

  return row;
}

export interface CacheStoreInput extends CacheLookupInput {
  householdId: string | null;
  answerJson: unknown;
  sourceReferences: unknown;
  confidence: string | null;
  expiresAt: string | null;
}

/**
 * Stores an answer for later reuse. Best-effort: a cache write failure must
 * never fail the request whose answer was already produced successfully.
 */
export async function storeCachedAnswer(input: CacheStoreInput): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('ai_answer_cache').insert({
      user_id: input.userId,
      household_id: input.householdId,
      snapshot_hash: input.snapshotHash,
      context_version: input.contextVersion,
      intent_code: input.intentCode,
      normalised_question_hash: normalisedQuestionHash(input.question),
      semantic_key: null,
      prompt_version: input.promptVersion,
      model_version: input.modelVersion,
      answer_json: input.answerJson,
      source_references: input.sourceReferences ?? [],
      confidence: input.confidence,
      expires_at: input.expiresAt,
    });
    return !error;
  } catch {
    return false;
  }
}
