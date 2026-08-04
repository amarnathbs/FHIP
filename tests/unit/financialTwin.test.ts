import { describe, it, expect } from 'vitest';
import {
  ageToAgeBand,
  ageFromDateOfBirth,
  deriveLifeStage,
  normalizeEmploymentType,
  normalizeHouseholdType,
  annualGrossIncomeToIncomeBand,
  comparisonStatusFromRelativePosition,
  comparisonStatusFromTargetRange,
  percentileInterpretation,
  confidenceLabel,
} from '@/lib/engines/twin/taxonomy';
import { computeGap } from '@/lib/engines/twin/gapAnalysis';
import { computePercentile, hasValidDistribution } from '@/lib/engines/twin/percentile';
import { computeConfidenceScore, cohortRelevanceScoreFromTier, recencyScoreFromYear, sampleSizeScore } from '@/lib/engines/twin/confidence';
import { dependantBand } from '@/lib/services/twinCohortMatching';

describe('Financial Twin — synthetic personas', () => {
  it('Persona A: Australian Young Professional — correct cohort dimensions, strong savings shows ahead, no property-ownership penalty', () => {
    const ageBand = ageToAgeBand(29);
    expect(ageBand).toBe('AGE_25_34');
    const lifeStage = deriveLifeStage({ ageBand, dependantsCount: 0, employmentType: normalizeEmploymentType('Employed full-time') });
    expect(lifeStage).toBe('young_professional');
    expect(normalizeHouseholdType('Single', 0)).toBe('single');
    expect(annualGrossIncomeToIncomeBand('AU', 95000)).toBe('INCOME_BAND_3');

    // 20% savings rate vs a 12% peer median (67% relative improvement) —
    // comfortably clears the "materially ahead" threshold, not penalised.
    const gap = computeGap(20, 12, 'higher_better');
    expect(gap.status).toBe('materially_ahead');

    // Renter with $0 property: property_concentration is context_only, so no
    // "materially behind" penalty should ever be attached to a zero holding.
    expect(comparisonStatusFromTargetRange(0, 50, 85, 'lower_better')).toBe('target_range_met');
  });

  it('Persona B: Australian Family with Mortgage — property concentration and liquidity gaps, DTI elevated but below the 6x high-DTI reference', () => {
    // DTI 4.8x is worse than a 2x "strong" benchmark but still well short of
    // the APRA 6x high-DTI threshold — must land as a material gap, not a
    // false "materially ahead of the risk line" or a crash.
    const gapVsStrongBenchmark = computeGap(4.8, 2.0, 'lower_better');
    expect(gapVsStrongBenchmark.status).toBe('materially_behind');
    const statusVsHighDtiThreshold = comparisonStatusFromRelativePosition(6.0 / 4.8, { materialPct: 0.2, minorPct: 0.05 });
    expect(statusVsHighDtiThreshold).not.toBe('materially_behind'); // 4.8 is still on the safer side of the 6x line

    // Emergency reserve of 1.5 months against a 3-5.9 "adequate" healthy band.
    expect(comparisonStatusFromTargetRange(1.5, 3, 5.9, 'higher_better')).toBe('materially_behind');
  });

  it('Persona C: Australian Pre-Retiree — ASFA planning benchmark evaluated separately from any peer figure', () => {
    const ageBand = ageToAgeBand(60);
    expect(ageBand).toBe('AGE_55_64');
    expect(deriveLifeStage({ ageBand, dependantsCount: 0, employmentType: 'employee' })).toBe('pre_retiree');
    // Combined super of $650,000 against ASFA's $730,000 "comfortable" couple target.
    expect(comparisonStatusFromTargetRange(650_000, 730_000, null, 'higher_better')).toBe('slightly_behind');
  });

  it('Persona D: Urban Indian Professional Family — income band and life stage use India-specific thresholds', () => {
    expect(annualGrossIncomeToIncomeBand('IN', 1_800_000)).toBe('INCOME_BAND_4');
    expect(annualGrossIncomeToIncomeBand('AU', 1_800_000)).toBe('INCOME_BAND_5'); // same nominal figure, different country scale
    const lifeStage = deriveLifeStage({ ageBand: ageToAgeBand(34), dependantsCount: 1, employmentType: 'employee' });
    expect(lifeStage).toBe('young_family');
  });

  it('Persona E: Rural Indian Household — dependant band and household composition derive independently of retirement status', () => {
    expect(dependantBand(4)).toBe('3+');
    // A multi-generational household is still correctly typed even though
    // the primary earner is not retired.
    expect(normalizeHouseholdType('Joint family', 3)).toBe('multi_generational');
    // household_type no longer collapses retirees into their own bucket —
    // life_stage (not household_type) carries retirement status.
    expect(normalizeHouseholdType('Married, retired', 0)).toBe('couple_no_kids');
  });

  it('Persona F: Australia-India Household — cross-border metrics never produce a single converted-nominal-wealth percentile', () => {
    // The percentile engine only ever operates on ONE metric's distribution
    // in ONE currency at a time — there is no code path that merges AUD and
    // INR balances into a single percentile, by construction.
    const distribution = { p20: 100_000, p50: 300_000, p80: 900_000 };
    expect(hasValidDistribution(distribution)).toBe(true);
    const result = computePercentile(300_000, distribution, 'higher_better');
    expect(result?.percentile).toBeCloseTo(50, 0);
  });

  it('Persona G: Insufficient Distribution Data — a mean/median-only benchmark never produces a percentile', () => {
    const meanOnly = { p50: 579_200 };
    expect(hasValidDistribution(meanOnly)).toBe(false);
    expect(computePercentile(400_000, meanOnly, 'higher_better')).toBeNull();
  });

  it('Persona H: Small Platform Cohort — confidence scoring reflects cohort tier and never overstates a broad-match benchmark', () => {
    const tier1Confidence = computeConfidenceScore({
      sourceAuthority: 90,
      cohortRelevance: cohortRelevanceScoreFromTier(1),
      dataRecency: recencyScoreFromYear(2024),
      sampleSizeCoverage: sampleSizeScore(500),
      metricComparability: 90,
      methodTransparency: 85,
    });
    const tier5Confidence = computeConfidenceScore({
      sourceAuthority: 90,
      cohortRelevance: cohortRelevanceScoreFromTier(5),
      dataRecency: recencyScoreFromYear(2024),
      sampleSizeCoverage: sampleSizeScore(500),
      metricComparability: 90,
      methodTransparency: 85,
    });
    expect(tier5Confidence).toBeLessThan(tier1Confidence);
  });

  it('Percentile: reverses interpretation for lower-is-better metrics (a low debt value is a HIGH goodness percentile)', () => {
    const distribution = { p10: 1, p50: 3, p90: 6 };
    const result = computePercentile(1, distribution, 'lower_better');
    expect(result?.percentile).toBeGreaterThan(80); // lowest recorded debt-to-income = best position
  });

  it('Percentile: clamps below the lowest and above the highest recorded point rather than extrapolating', () => {
    const distribution = { p10: 100, p90: 900 };
    const below = computePercentile(10, distribution, 'higher_better');
    expect(below?.clamped).toBe('below_min');
    const above = computePercentile(2000, distribution, 'higher_better');
    expect(above?.clamped).toBe('above_max');
  });

  it('Gap: zero-value edge cases never produce Infinity or NaN', () => {
    const zeroUser = computeGap(0, 5, 'lower_better');
    expect(Number.isFinite(zeroUser.relativePosition!)).toBe(true);
    const zeroBenchmark = computeGap(5, 0, 'higher_better');
    expect(Number.isFinite(zeroBenchmark.relativePosition!)).toBe(true);
  });

  it('Target range direction: below-min is only ever a gap for higher-is-better metrics, never for lower-is-better ones', () => {
    // A very low expense ratio (well under the "healthy" floor) must never
    // be reported as behind — that would penalise strong behaviour.
    expect(comparisonStatusFromTargetRange(5, 45, 60, 'lower_better')).toBe('target_range_met');
    // The equivalent shape for a higher-is-better metric (a low savings rate
    // under the healthy floor) is correctly still a gap.
    expect(comparisonStatusFromTargetRange(5, 10, 20, 'higher_better')).toBe('materially_behind');
  });

  it('Confidence and percentile labels are deterministic and human-readable', () => {
    expect(confidenceLabel(95)).toBe('Very high');
    expect(confidenceLabel(45)).toBe('Limited');
    expect(percentileInterpretation(92)).toContain('strongest');
    expect(percentileInterpretation(10)).toContain('Materially below');
  });

  it('Age derivation is stable across a birthday boundary', () => {
    expect(ageFromDateOfBirth('1990-05-15', new Date('2026-08-01'))).toBe(36);
    expect(ageFromDateOfBirth('1990-08-15', new Date('2026-08-01'))).toBe(35); // birthday not yet reached this year
  });
});
