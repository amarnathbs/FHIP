// Module 11.4 — merges the code-based catalogue (lib/ai/standardQuestions/
// catalogue.ts, the stable source of truth for wording/mappings) with the
// DB-backed admin-controlled subset (migration 0124, `ai_standard_questions`
// — enabled/display_order only, spec sections 53-59, 61).
//
// SCHEMA-OPTIONAL BY DESIGN: this phase's migration is written but NOT
// applied to DEV/production without explicit Product Owner authorisation
// (spec section 60). Until it is applied, `relation "ai_standard_questions"
// does not exist` (Postgres 42P01) is treated as "no admin overrides
// provisioned yet" and the code catalogue's own defaults (every question
// enabled) are used — this is a deliberate incremental-rollout fallback, not
// a masked outage. Any OTHER database error is NOT treated this way: a
// genuine DB outage fails closed (spec section 71 — "no fabricated
// availability").
import { createAdminClient } from '@/lib/supabase/admin';
import { STANDARD_QUESTIONS } from '@/lib/ai/standardQuestions/catalogue';
import type { StandardQuestionDefinition } from '@/lib/ai/standardQuestions/types';

// The Postgres wire-protocol code for "relation does not exist" (42P01) is
// what a raw SQL client sees. PostgREST — what supabase-js actually talks
// to — instead surfaces its OWN schema-cache-miss code, PGRST205, for a
// table it cannot find (confirmed live against real DEV: migration 0124 not
// applied there yet raises PGRST205, never 42P01, from `.from(...).select()`
// through supabase-js). Both are treated identically as "not provisioned yet".
const RELATION_NOT_PROVISIONED = new Set(['42P01', 'PGRST205']);

export interface CatalogueLoadResult {
  questions: StandardQuestionDefinition[];
  /** False only on a genuine DB outage (never on "table not yet migrated") — spec section 71. */
  ok: boolean;
}

/**
 * Reads admin overrides for `enabled`/`display_order` and merges them onto
 * the code catalogue. Never trusts the DB for wording, mappings, or any
 * other field — those remain code-defined so an admin write can never turn
 * into an executable AI instruction (spec section 59).
 */
export async function loadStandardQuestionCatalogue(): Promise<CatalogueLoadResult> {
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { questions: [], ok: false };
  }

  const { data, error } = await admin
    .from('ai_standard_questions')
    .select('question_code, enabled, display_order');

  if (error) {
    if (error.code && RELATION_NOT_PROVISIONED.has(error.code)) {
      // Migration 0124 not yet applied — use code defaults (see header comment).
      return { questions: STANDARD_QUESTIONS, ok: true };
    }
    return { questions: [], ok: false };
  }

  const overrides = new Map((data ?? []).map((r) => [r.question_code as string, r as { enabled: boolean; display_order: number }]));
  const merged = STANDARD_QUESTIONS.map((def) => {
    const override = overrides.get(def.standard_question_code);
    if (!override) return def;
    return { ...def, enabled: override.enabled, display_order: override.display_order };
  });
  return { questions: merged, ok: true };
}
