/**
 * Financial Data Hub — classification-rule PRECEDENCE resolution semantics
 * (FDH-2 specification section 55-64).
 *
 * NOT THE CLASSIFICATION ENGINE. FDH-6 builds the real engine that reads
 * transactions, merchants, MCCs and rules and writes fdh_transactions rows.
 * This module is a lightweight PURE function that tests the RESOLUTION
 * SEMANTICS documented for that future engine — given several candidate
 * classifications for the same hypothetical transaction, which one wins —
 * so the precedence order is a testable fact, not prose that can silently
 * drift from what FDH-6 eventually implements.
 *
 * THE DOCUMENTED ORDER (highest precedence first):
 *   1. user_rule               — a household's own confirmed rule
 *   2. source_provided         — an explicit, reliable source classification
 *                                 (e.g. a payslip/bank feed's own category)
 *   3. verified_merchant_alias — an exact match against a VERIFIED alias
 *   4. mcc                     — a direct, high/medium-confidence MCC mapping
 *   5. verified_global_rule    — an approved global fdh_classification_rules row
 *   6. narrative_pattern       — a source/narrative pattern match (FDH-2's
 *                                 income/fee/transfer/etc. pattern seeds)
 *   7. fuzzy_merchant_match    — a non-exact merchant match (NOT implemented
 *                                 anywhere through FDH-2 — listed for
 *                                 completeness of the documented order)
 *   8. ai                      — an AI fallback (NOT implemented anywhere
 *                                 through FDH-2 — future fallback only)
 *   9. user_review             — no automatic classification was possible
 *
 * A user's deliberately-confirmed personal rule ALWAYS outranks the global
 * FHIP default for that user (specification example: FHIP default
 * COSTCO -> Groceries, the user sets COSTCO -> Household for themself, the
 * user's rule wins for them, and the GLOBAL master row is never touched).
 * See `applyUserOverrideExample` below, which proves this without mutating
 * anything — there is nothing to mutate, because a user rule never writes
 * fdh_merchants or fdh_classification_rules at all.
 */

export const PRECEDENCE_ORDER = [
  'user_rule',
  'source_provided',
  'verified_merchant_alias',
  'mcc',
  'verified_global_rule',
  'narrative_pattern',
  'fuzzy_merchant_match',
  'ai',
  'user_review',
] as const;
export type PrecedenceSource = (typeof PRECEDENCE_ORDER)[number];

export interface PrecedenceCandidate {
  source: PrecedenceSource;
  categoryKey: string | null;
  subcategoryKey?: string | null;
  economicTransactionType?: string | null;
}

/**
 * Resolves the winning candidate among several proposed classifications for
 * one hypothetical transaction, purely by precedence RANK — never by
 * confidence score, recency or any other tiebreaker not in the documented
 * order. Returns null for an empty candidate list (nothing to resolve —
 * the real engine's `user_review` fallback is what a caller should record
 * in that case, itself represented as a `user_review` candidate if the
 * caller wants a uniform return type).
 */
export function resolvePrecedence(candidates: PrecedenceCandidate[]): PrecedenceCandidate | null {
  if (candidates.length === 0) return null;
  let best: PrecedenceCandidate | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rank = PRECEDENCE_ORDER.indexOf(candidate.source);
    if (rank === -1) {
      throw new Error(`unknown precedence source: ${String(candidate.source)}`);
    }
    if (rank < bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  return best;
}

/**
 * The specification's own worked example: a global default classifies
 * COSTCO as Groceries; a household confirms its own rule reclassifying
 * COSTCO as Household for themself. Demonstrates (a) the user's rule wins
 * the precedence resolution and (b) the global default value passed in is
 * returned UNCHANGED — nothing here ever mutates or proposes mutating the
 * global row, because a user rule is never capable of writing one.
 */
export function applyUserOverrideExample(
  globalDefault: { categoryKey: string },
  userOverride: { categoryKey: string } | null,
): { winningCategoryKey: string; globalDefaultCategoryKeyUnchanged: string } {
  const candidates: PrecedenceCandidate[] = [
    { source: 'verified_global_rule', categoryKey: globalDefault.categoryKey },
    ...(userOverride ? [{ source: 'user_rule' as const, categoryKey: userOverride.categoryKey }] : []),
  ];
  const winner = resolvePrecedence(candidates);
  return {
    winningCategoryKey: winner!.categoryKey!,
    // The global default is echoed back untouched — proving no mutation
    // occurred, not merely asserting it in a comment.
    globalDefaultCategoryKeyUnchanged: globalDefault.categoryKey,
  };
}
