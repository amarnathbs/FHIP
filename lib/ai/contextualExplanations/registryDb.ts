// Module 11.5 — merges the code-based contextual target registry
// (lib/ai/contextualExplanations/registry.ts, the stable source of truth for
// wording, intent mappings and ownership rules) with the DB-backed
// admin-controlled subset (migration 0126, `ai_contextual_explanation_targets`
// — `enabled` only).
//
// Exactly the same shape, and the same schema-optional fallback, as Module
// 11.4's lib/ai/standardQuestions/catalogueDb.ts — deliberately, so both
// registries behave identically before and after their migration is applied.
//
// SCHEMA-OPTIONAL BY DESIGN: migration 0126 is written but not applied to
// DEV/production without explicit Product Owner authorisation (spec section
// 100). Until it is applied, "relation does not exist" (42P01 / PGRST205) is
// treated as "no admin overrides provisioned yet" and the code registry's own
// defaults are used. Any OTHER database error fails closed — a genuine outage
// must never read as "every target enabled".
//
// The DB is NEVER trusted for wording, intent codes, required domains,
// ownership type or country scope. Those stay code-defined so an admin write
// can never become an executable AI instruction, and so a compromised admin
// row cannot repoint a target at a different question.

import { createAdminClient } from '@/lib/supabase/admin';
import { CONTEXTUAL_EXPLANATION_TARGETS } from '@/lib/ai/contextualExplanations/registry';
import type { ContextualExplanationTarget } from '@/lib/ai/contextualExplanations/types';

const RELATION_NOT_PROVISIONED = new Set(['42P01', 'PGRST205']);

/**
 * Returns the effective target registry. On a genuine DB failure this returns
 * an EMPTY list (fail closed: no Explain controls at all) rather than the code
 * defaults, because in that state we cannot know whether an admin had disabled
 * a target.
 */
export async function loadContextualTargetRegistry(): Promise<ContextualExplanationTarget[]> {
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return [];
  }

  const { data, error } = await admin.from('ai_contextual_explanation_targets').select('target_code, enabled');

  if (error) {
    if (error.code && RELATION_NOT_PROVISIONED.has(error.code)) {
      // Migration 0126 not yet applied — use code defaults (see header).
      return CONTEXTUAL_EXPLANATION_TARGETS;
    }
    return [];
  }

  const overrides = new Map((data ?? []).map((r) => [r.target_code as string, Boolean(r.enabled)]));
  return CONTEXTUAL_EXPLANATION_TARGETS.map((def) => {
    const override = overrides.get(def.target_code);
    if (override === undefined) return def;
    return { ...def, enabled: override };
  });
}
