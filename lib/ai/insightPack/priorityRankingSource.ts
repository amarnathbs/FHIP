// Module 11 remediation R1/R5 — the production `PriorityRankingSource` binding.
//
// Kept in its own tiny module (rather than inside priorityRanking.ts) so the
// CONTRACT file stays free of any dependency on the engine that produces
// the ranking, and so this one binding site is the only thing that changed
// between R1 (empty source) and R5 (Module 11.6).
//
// R5 STATE: the Insight Pack's `priority_review_areas` are FHIP's own
// deterministic Next Best Actions (lib/ai/nba/engine.ts) — the same engine,
// same rules version and same ranking policy that serve
// /api/ai/next-best-actions and SQ-AI-003/025. The provider only narrates
// each item; the R1 validator rejects any reorder/invent/drop.

import type { PriorityRankingSource, RankedPriorityArea } from '@/lib/ai/insightPack/priorityRanking';
import { evaluateNextBestActions } from '@/lib/ai/nba/engine';

export const EMPTY_PRIORITY_RANKING_SOURCE: PriorityRankingSource = () => [];

/** Module 11.6 as the single ranking authority: rank/action_code/title/source_ref from the deterministic engine. */
export const nbaPriorityRankingSource: PriorityRankingSource = (ctx) =>
  evaluateNextBestActions(ctx).actions.map((a): RankedPriorityArea => ({ rank: a.rank, action_code: a.action_code, title: a.title, source_ref: a.source_ref }));

/** The source AIPersonalisedInsightPackService / AIInsightPackBatchOrchestrator use when none is injected. */
export const defaultPriorityRankingSource: PriorityRankingSource = nbaPriorityRankingSource;
