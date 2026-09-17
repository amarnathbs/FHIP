/**
 * AIE-1.5 — assembles the read-side view models (`AieReviewRunSummary`,
 * `AieReviewItemView`, `AieReviewCandidateView`) the API routes/frontend
 * consume. Pure aggregation over repository reads — no writes happen here.
 *
 * MASK-01/TRI-07: every candidate's `displayValue` defaults to whatever the
 * underlying `value_raw` already is — which, for anything the masking step
 * touched, is already a `[MASKED:...]` placeholder token (masking happens
 * BEFORE the value is used to build an AI payload, but the ORIGINAL
 * document-extracted candidates recorded by a deterministic parser are the
 * real, unmasked values the parser itself read off the document — the
 * masking step in `lib/aie/orchestrator.ts` only ever masks the TEXT sent
 * to the AI fallback, not `aie_field_candidate` rows). Concretely: today,
 * the only field-level values genuinely at risk of carrying a raw
 * identifier are adapter-specific evidence-only fields an adapter's OWN
 * parser has chosen to mask before ever creating the candidate (Insurance's
 * `policyNumberMasked` — already irreversibly partial-masked at the
 * source, see parser.ts). This function does not invent additional
 * masking on top of what the adapter/orchestrator already applied — see
 * `lib/aie/review/reveal.ts`'s header for the honest limitation on what
 * "reveal" can and cannot un-mask.
 */

import type { AieFieldCandidate } from '../types';
import type { LatestCorrectionRow } from '../db/repository';
import type { AieReviewCandidateView } from './types';

export function buildCandidateViews(originalCandidates: readonly AieFieldCandidate[], corrections: readonly LatestCorrectionRow[]): AieReviewCandidateView[] {
  const correctionByField = new Map(corrections.map((c) => [c.fieldName, c]));
  return originalCandidates.map((c) => {
    const correction = correctionByField.get(c.fieldName);
    if (correction) {
      return {
        fieldName: c.fieldName,
        displayValue: correction.valueNormalized,
        isNull: false,
        sourceMethod: c.sourceMethod,
        userCorrected: true,
        originalValueRaw: c.valueRaw,
      };
    }
    return {
      fieldName: c.fieldName,
      displayValue: c.isNull ? null : c.valueRaw,
      isNull: c.isNull,
      sourceMethod: c.sourceMethod,
      userCorrected: false,
      originalValueRaw: c.valueRaw,
    };
  });
}
