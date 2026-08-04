// Benchmark source-confidence scoring (spec section 11). Each factor is
// scored 0-100 by the caller (who has the actual source/cohort/recency
// facts); this function only applies the fixed weighting so the formula
// itself stays in one deterministic, testable place.
export interface ConfidenceFactors {
  sourceAuthority: number; // 25%
  cohortRelevance: number; // 25%
  dataRecency: number; // 20%
  sampleSizeCoverage: number; // 15%
  metricComparability: number; // 10%
  methodTransparency: number; // 5%
}

const WEIGHTS: Record<keyof ConfidenceFactors, number> = {
  sourceAuthority: 0.25,
  cohortRelevance: 0.25,
  dataRecency: 0.2,
  sampleSizeCoverage: 0.15,
  metricComparability: 0.1,
  methodTransparency: 0.05,
};

export function computeConfidenceScore(factors: ConfidenceFactors): number {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  let score = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof ConfidenceFactors)[]) {
    score += clamp(factors[key]) * WEIGHTS[key];
  }
  return Math.round(score * 10) / 10;
}

/** Recency score decays from 100 (this year) to 40 at 6+ years old — a source period older than 3 years still scores moderately per spec's "Old Source" empty-state wording. */
export function recencyScoreFromYear(sourceYear: number, asOfYear: number = new Date().getFullYear()): number {
  const ageYears = Math.max(0, asOfYear - sourceYear);
  if (ageYears <= 1) return 100;
  if (ageYears <= 3) return 80;
  if (ageYears <= 6) return 60;
  return 40;
}

export function sampleSizeScore(sampleSize: number | null): number {
  if (sampleSize === null) return 50;
  if (sampleSize >= 10_000) return 100;
  if (sampleSize >= 1_000) return 85;
  if (sampleSize >= 100) return 65;
  if (sampleSize >= 30) return 45;
  return 25;
}

export function cohortRelevanceScoreFromTier(tier: 1 | 2 | 3 | 4 | 5): number {
  return { 1: 100, 2: 85, 3: 65, 4: 45, 5: 30 }[tier];
}
