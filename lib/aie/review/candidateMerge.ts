/**
 * AIE-1.5 — merges a run's original, immutable field candidates with the
 * latest accepted user corrections for reconciliation/display purposes.
 *
 * VALID-12 ("never mutate the original field candidate/evidence"): this
 * function is pure and returns a NEW array. It never writes back to
 * `aie_field_candidate` — the original deterministic/AI-extracted value
 * stays exactly as first recorded, forever queryable, and the correction
 * lives only in `aie_review_decision` (see repository.ts's
 * `listLatestCorrectionsForRun`). TRI-05/VALID-09 ("keep source fact and
 * user assertion distinguishable"): the merged view tags each corrected
 * entry with `sourceReference.userCorrected` rather than silently
 * overwriting `sourceMethod` (which stays whatever AIE-1.1 core originally
 * recorded — 'deterministic' | 'ai' | 'ocr' — since that column's CHECK
 * constraint has no 'user' value and this merge is in-memory only anyway).
 */

import type { AieFieldCandidate } from '../types';
import type { LatestCorrectionRow } from '../db/repository';

export function mergeCandidatesWithCorrections(originalCandidates: readonly AieFieldCandidate[], corrections: readonly LatestCorrectionRow[]): AieFieldCandidate[] {
  const correctionByField = new Map(corrections.map((c) => [c.fieldName, c]));
  const seen = new Set<string>();
  const merged: AieFieldCandidate[] = [];

  for (const c of originalCandidates) {
    seen.add(c.fieldName);
    const correction = correctionByField.get(c.fieldName);
    if (!correction) {
      merged.push(c);
      continue;
    }
    merged.push({
      fieldName: c.fieldName,
      valueRaw: correction.valueNormalized,
      isNull: false,
      sourceMethod: c.sourceMethod,
      sourceReference: { ...(c.sourceReference ?? {}), userCorrected: true, correctionDecisionId: correction.decisionId, originalValueRaw: c.valueRaw },
    });
  }

  // A correction for a field that had NO original candidate at all (the
  // parser never found it — e.g. a required field entirely absent from the
  // document) still needs to participate in reconciliation once corrected.
  for (const correction of corrections) {
    if (seen.has(correction.fieldName)) continue;
    merged.push({
      fieldName: correction.fieldName,
      valueRaw: correction.valueNormalized,
      isNull: false,
      sourceMethod: 'deterministic',
      sourceReference: { userCorrected: true, correctionDecisionId: correction.decisionId, originalValueRaw: null },
    });
  }

  return merged;
}
