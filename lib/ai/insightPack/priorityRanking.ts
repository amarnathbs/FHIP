// Module 11 remediation R1 — Ranking provenance contract for the Insight
// Pack's `priority_review_areas` output (the block SQ-AI-003 "What should I
// focus on first?" and SQ-AI-025 "three most important things this month"
// read from).
//
// THE DEFECT THIS FILE CLOSES (R1 finding, 2026-09-22). Before this file
// existed the full lineage was:
//
//   canonical engines -> FinancialContextObject.recommendations   (ALWAYS [])
//                      -> prompt payload                            (no ranked items, no ordering instruction)
//                      -> provider output priority_review_areas     (free-text string[], provider-authored)
//                      -> grounding validator                       (no ordering/provenance check at all)
//                      -> ai_insight_pack_blocks.priority_review_areas
//                      -> ai_insights[PRIORITY_REVIEW_AREAS_EXPLANATION]
//                      -> SQ-AI-003 / SQ-AI-025
//
// i.e. the PROVIDER was the sole ranking authority for "what to focus on
// first". With the mock provider that ranking was a hard-coded empty list,
// so nothing user-visible was ever wrong — but the moment a real provider is
// activated (R2) the LLM would have ranked. The brief's section 7 requires
// the opposite:
//
//   deterministic ordered recommendations
//   -> provider receives IMMUTABLE ranked items
//   -> provider may only EXPLAIN each item
//   -> output preserves action_code / rank
//   -> grounding validator verifies rank equality.
//
// This file is that contract. It has NO knowledge of how the ranked items
// are produced — the producer is injected (`PriorityRankingSource`). Until
// Module 11.6 exists the production source is `EMPTY_PRIORITY_RANKING_SOURCE`
// (see priorityRankingSource.ts), under which the validator REJECTS any
// priority item the provider emits ("invented_priority_area") — the fail-
// closed direction. R5 (Module 11.6) replaces that source with the
// deterministic Next Best Action engine; nothing in this contract changes.

import type { FinancialContextObject } from '@/lib/ai/context/types';

export const PRIORITY_RANKING_CONTRACT_VERSION = 'priority-ranking-1.0.0';

/** The maximum number of ranked items a pack may carry — matches Module 11.6's own "maximum three" rule (brief section 44). */
export const MAX_RANKED_PRIORITY_AREAS = 3;

/**
 * One deterministic, pre-ranked item. `rank` is 1-based and contiguous;
 * `action_code` is the stable machine identifier the provider must echo
 * verbatim; `source_ref` names the certified upstream fact that produced it
 * (e.g. `resilience.active_risks:low_emergency_fund`) so provenance is
 * auditable without re-running the engine.
 */
export interface RankedPriorityArea {
  rank: number;
  action_code: string;
  title: string;
  source_ref: string;
}

/**
 * What the provider is allowed to return per item: the rank and
 * action_code it was given (unchanged) plus its own plain-English
 * explanation. It may NOT return a title, a new code, a new rank, or an
 * item that was not supplied.
 */
export interface ProviderPriorityItem {
  rank: number;
  action_code: string;
  explanation: string;
}

/** A deterministic producer of the immutable ranked list for one household context. Must be pure. */
export type PriorityRankingSource = (ctx: FinancialContextObject) => RankedPriorityArea[];

export interface RankingViolation {
  code:
    | 'invented_priority_area'
    | 'dropped_priority_area'
    | 'reordered_priority_area'
    | 'rank_mismatch'
    | 'duplicate_priority_area'
    | 'canonical_ranking_invalid';
  detail: string;
}

/**
 * Structural sanity check on the CANONICAL list itself (never on provider
 * output): ranks must be exactly 1..n in order, action codes unique, n <= 3.
 * A producer that violates this is a defect in the producer, and the pack
 * must not be generated on top of it — returns the violations rather than
 * throwing so the caller can fail the generation closed with an audit code.
 */
export function assertCanonicalRanking(items: readonly RankedPriorityArea[]): RankingViolation[] {
  const violations: RankingViolation[] = [];
  if (items.length > MAX_RANKED_PRIORITY_AREAS) {
    violations.push({ code: 'canonical_ranking_invalid', detail: `Canonical ranking carries ${items.length} items; maximum is ${MAX_RANKED_PRIORITY_AREAS}.` });
  }
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (item.rank !== i + 1) {
      violations.push({ code: 'canonical_ranking_invalid', detail: `Canonical item at position ${i} carries rank ${item.rank}; expected ${i + 1}.` });
    }
    if (!item.action_code || seen.has(item.action_code)) {
      violations.push({ code: 'canonical_ranking_invalid', detail: `Canonical action_code "${item.action_code}" is empty or duplicated.` });
    }
    seen.add(item.action_code);
  });
  return violations;
}

/**
 * The exact text block appended to the provider prompt. The items are
 * rendered as DATA (a JSON array) after an explicit, unambiguous instruction
 * that they are immutable. The instruction lives here — next to the
 * validator that enforces it — rather than only in the DB prompt template,
 * so the two can never drift apart: whatever version of PR-AI-013 is
 * active, the provider always receives this exact contract text.
 */
export function buildRankedPriorityPromptSection(items: readonly RankedPriorityArea[]): string {
  const header =
    'RANKED_PRIORITY_AREAS (IMMUTABLE — pre-ranked by FHIP\'s deterministic engine). ' +
    'For the envelope field `priority_review_areas`, return EXACTLY these items, in EXACTLY this order, ' +
    'echoing each `rank` and `action_code` verbatim, and add ONLY a plain-English `explanation` for each. ' +
    'Do NOT reorder, re-rank, add, remove, merge or rename any item. ' +
    'If the list below is empty, return an empty `priority_review_areas` array and do not invent priorities.';
  const payload = items.map((i) => ({ rank: i.rank, action_code: i.action_code, title: i.title }));
  return `${header}\n${JSON.stringify(payload)}`;
}

/**
 * Brief section 8 — the negative test's oracle. Given the canonical
 * deterministic order and what the provider actually returned, produce the
 * list of provenance violations. Any violation means the provider attempted
 * to become the ranking authority and the caller must reject (this
 * implementation REJECTS rather than silently normalising — a provider that
 * reorders is a provider that is not following instructions, and the safer
 * response is to surface that, not paper over it).
 *
 * Deliberately checks the whole sequence, not just membership:
 *   - an item not in the canonical list      -> invented_priority_area
 *   - a canonical item missing from output   -> dropped_priority_area
 *   - same set, different order              -> reordered_priority_area
 *   - right code at right position, wrong rank number -> rank_mismatch
 *   - the same action_code twice             -> duplicate_priority_area
 */
export function validatePriorityRankingProvenance(
  provided: readonly ProviderPriorityItem[],
  canonical: readonly RankedPriorityArea[]
): RankingViolation[] {
  const violations: RankingViolation[] = [];
  const canonicalCodes = canonical.map((c) => c.action_code);
  const canonicalSet = new Set(canonicalCodes);

  const seen = new Set<string>();
  for (const p of provided) {
    if (seen.has(p.action_code)) {
      violations.push({ code: 'duplicate_priority_area', detail: `Provider returned action_code "${p.action_code}" more than once.` });
    }
    seen.add(p.action_code);
    if (!canonicalSet.has(p.action_code)) {
      violations.push({ code: 'invented_priority_area', detail: `Provider returned action_code "${p.action_code}" which is not in the deterministic ranked list.` });
    }
  }
  for (const c of canonical) {
    if (!seen.has(c.action_code)) {
      violations.push({ code: 'dropped_priority_area', detail: `Provider omitted canonical action_code "${c.action_code}" (rank ${c.rank}).` });
    }
  }
  if (violations.length > 0) return violations;

  // Same set — now the order and the rank numbers must both match exactly.
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical[i];
    const p = provided[i];
    if (p.action_code !== c.action_code) {
      violations.push({
        code: 'reordered_priority_area',
        detail: `Provider placed "${p.action_code}" at position ${i + 1}; deterministic order requires "${c.action_code}" there.`,
      });
      continue;
    }
    if (p.rank !== c.rank) {
      violations.push({ code: 'rank_mismatch', detail: `Provider labelled "${p.action_code}" rank ${p.rank}; deterministic rank is ${c.rank}.` });
    }
  }
  return violations;
}

/**
 * The ONLY way `priority_review_areas` prose reaches the answer store
 * (ai_insights / SQ-AI-003 / SQ-AI-025): composed HERE, in CANONICAL order,
 * from the canonical titles plus the provider's per-item explanation looked
 * up by action_code. The provider's own array order is never used for
 * presentation, even after validation has proven it identical — the
 * canonical list is the single source of truth by construction.
 *
 * Returns null when there is nothing ranked, so a caller never writes an
 * "explanation" of an empty list.
 */
export function composeCanonicalPriorityExplanation(
  canonical: readonly RankedPriorityArea[],
  provided: readonly ProviderPriorityItem[]
): string | null {
  if (canonical.length === 0) return null;
  const byCode = new Map(provided.map((p) => [p.action_code, p.explanation.trim()]));
  return canonical
    .map((c) => {
      const explanation = byCode.get(c.action_code);
      return explanation ? `${c.rank}. ${c.title}: ${explanation}` : `${c.rank}. ${c.title}.`;
    })
    .join(' ');
}
