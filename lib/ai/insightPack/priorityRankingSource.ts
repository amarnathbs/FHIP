// Module 11 remediation R1 — the production `PriorityRankingSource` binding.
//
// Kept in its own tiny module (rather than inside priorityRanking.ts) so the
// CONTRACT file stays free of any dependency on whichever deterministic
// engine produces the ranking, and so this one binding site is the only
// thing R5 (Module 11.6 Next Best Action) has to change.
//
// R1 STATE: no deterministic ranking engine exists yet on this branch, so
// the production source is EMPTY. Under an empty canonical list the
// provenance validator (priorityRanking.ts) rejects ANY priority item a
// provider returns as `invented_priority_area`, and the pack service never
// writes a PRIORITY_REVIEW_AREAS_EXPLANATION stored answer. That is the
// deliberate fail-closed state: until FHIP itself ranks, nobody ranks.

import type { PriorityRankingSource } from '@/lib/ai/insightPack/priorityRanking';

export const EMPTY_PRIORITY_RANKING_SOURCE: PriorityRankingSource = () => [];

/** The source AIPersonalisedInsightPackService / AIInsightPackBatchOrchestrator use when none is injected. */
export const defaultPriorityRankingSource: PriorityRankingSource = EMPTY_PRIORITY_RANKING_SOURCE;
