// Module 11 remediation R1 — the pieces of the Insight Pack pipeline that
// the single-call service (insightPackService.ts) and the batch
// orchestrator (batchOrchestrator.ts) MUST share verbatim, so the two
// transports can never diverge on (a) what the provider is told about the
// deterministic ranking, or (b) how validated output reaches the Module
// 11.2 answer store.

import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import { BLOCK_INTENT_MAP, type PackBlockCode, type ProviderPackBlock, type ProviderPackEnvelope } from '@/lib/ai/insightPack/types';
import { CERTIFIED_METRIC_CODES, type PackGroundingSummary } from '@/lib/ai/insightPack/groundingValidation';
import { MANDATORY_BLOCK_CODES, PACK_BLOCK_CODES } from '@/lib/ai/insightPack/types';
import {
  buildRankedPriorityPromptSection,
  composeCanonicalPriorityExplanation,
  type RankedPriorityArea,
} from '@/lib/ai/insightPack/priorityRanking';

export const PRIORITY_REVIEW_AREAS_INTENT = 'PRIORITY_REVIEW_AREAS_EXPLANATION';

/** The two fixed section markers of the rendered user prompt. Exported so the mock providers parse exactly what production renders. */
export const CONTEXT_MARKER = '\n\nCONTEXT:\n';
export const RANKED_MARKER = '\n\nRANKED_PRIORITY_AREAS';

/**
 * The user-turn prompt: developer template + the certified context as DATA
 * + the immutable ranked list as DATA. The ranked section is appended
 * unconditionally (even when empty) so the provider is always told, in the
 * same words, that it may not rank.
 */
export function buildPackUserPrompt(prompt: PromptTemplateRow, ctx: FinancialContextObject, canonical: readonly RankedPriorityArea[]): string {
  return `${prompt.developer_prompt}${OUTPUT_CONTRACT_MARKER}${buildOutputContractSection()}${CONTEXT_MARKER}${JSON.stringify(ctx)}${RANKED_MARKER}${buildRankedPriorityPromptSection(canonical).slice('RANKED_PRIORITY_AREAS'.length)}`;
}

export const OUTPUT_CONTRACT_MARKER = '\n\nOUTPUT_CONTRACT:\n';

/**
 * R2 — the closed output contract, rendered from the SAME constants the
 * validator enforces (never a hand-written duplicate that can drift):
 * which blocks exist, which are mandatory (return them even if only as
 * status UNAVAILABLE with a limitation), and the closed metric_code
 * vocabulary. Added after the first real-provider DEV run rejected every
 * block that cited a context field name instead of a certified code.
 */
export function buildOutputContractSection(): string {
  return [
    `Block keys (return every key; use null for a block you do not populate): ${PACK_BLOCK_CODES.join(', ')}.`,
    `MANDATORY blocks — always return these four, populated when the certified data supports them, otherwise with status "UNAVAILABLE" and a plain-English limitation, never omitted: ${MANDATORY_BLOCK_CODES.join(', ')}.`,
    `metric_claims.metric_code must be one of EXACTLY these certified codes (any other value is rejected): ${CERTIFIED_METRIC_CODES.join(', ')}. ` +
      'monthly_surplus = cash_flow.monthly_surplus_or_deficit; overall_score = health_score.overall_score; insurance_premium_burden = insurance.premium_burden. ' +
      'Do not cite a metric that is null/absent in the context.',
    'source_refs entries must copy source_type and source_id verbatim from context.source_references.',
  ].join('\n');
}

/**
 * Inverse of buildPackUserPrompt() for a consumer that only ever sees
 * rendered prompt TEXT (a real batch API, or the mock providers that
 * imitate one). Returns the context JSON text and the ranked items exactly
 * as the provider would have to read them.
 */
export function splitPackUserPrompt(userPrompt: string): { contextJson: string; rankedItems: { rank: number; action_code: string; title: string }[] } {
  const ctxIdx = userPrompt.indexOf(CONTEXT_MARKER);
  if (ctxIdx === -1) throw new Error('Rendered pack prompt is missing the CONTEXT: marker.');
  const afterCtx = userPrompt.slice(ctxIdx + CONTEXT_MARKER.length);
  const rankedIdx = afterCtx.indexOf(RANKED_MARKER);
  const contextJson = rankedIdx === -1 ? afterCtx : afterCtx.slice(0, rankedIdx);
  let rankedItems: { rank: number; action_code: string; title: string }[] = [];
  if (rankedIdx !== -1) {
    const rankedSection = afterCtx.slice(rankedIdx + RANKED_MARKER.length);
    const nl = rankedSection.indexOf('\n');
    const jsonLine = nl === -1 ? '[]' : rankedSection.slice(nl + 1).trim();
    rankedItems = JSON.parse(jsonLine) as { rank: number; action_code: string; title: string }[];
  }
  return { contextJson, rankedItems };
}

export interface StoredAnswerCandidate {
  metricCode: string;
  currentValue: number | null;
  explanation: string;
  confidence: string | null;
}

/**
 * Spec sections 29/59 — which (intent, explanation) pairs a validated pack
 * may feed into ai_insights. Two rules, both fail-closed:
 *
 *   1. Every block-backed intent is written ONLY from a GROUNDED block
 *      (unchanged from the original 11.3 behaviour).
 *   2. R1: PRIORITY_REVIEW_AREAS_EXPLANATION is NEVER written from the
 *      provider's free-text block. It is written only when FHIP's own
 *      canonical ranking is non-empty AND ranking provenance is GROUNDED,
 *      and its text is composed in canonical order by
 *      composeCanonicalPriorityExplanation(). A provider that ranked, or a
 *      world in which FHIP has not ranked, produces NO stored "focus first"
 *      answer at all.
 */
export function storedAnswersFromValidatedPack(
  provided: ReadonlyMap<PackBlockCode, ProviderPackBlock>,
  grounding: PackGroundingSummary,
  envelope: ProviderPackEnvelope,
  canonical: readonly RankedPriorityArea[]
): StoredAnswerCandidate[] {
  const out: StoredAnswerCandidate[] = [];
  for (const [blockCode, intentCode] of BLOCK_INTENT_MAP) {
    if (intentCode === PRIORITY_REVIEW_AREAS_INTENT) continue; // rule 2 — handled below, never from prose
    const g = grounding.blockResults.get(blockCode);
    const block = provided.get(blockCode);
    if (!g || g.status !== 'GROUNDED' || !block) continue;
    out.push({
      metricCode: intentCode,
      currentValue: block.metric_claims[0]?.source_value ?? null,
      explanation: block.explanation || block.short_answer,
      confidence: block.confidence,
    });
  }

  if (canonical.length > 0 && grounding.rankingProvenance.status === 'GROUNDED') {
    const explanation = composeCanonicalPriorityExplanation(canonical, envelope.priority_review_areas);
    if (explanation) {
      const block = provided.get('priority_review_areas');
      out.push({
        metricCode: PRIORITY_REVIEW_AREAS_INTENT,
        currentValue: null,
        explanation,
        confidence: block?.confidence ?? null,
      });
    }
  }
  return out;
}
