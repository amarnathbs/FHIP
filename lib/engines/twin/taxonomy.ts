// Module 8 taxonomy — Financial Twin (TM) and Benchmark Intelligence Engine (TM).
// Every displayed comparison must be traceable to exactly one benchmark class
// (spec section 1) so observed peer data, statutory thresholds and FHIP
// planning targets are never blended without disclosure.
import { ageFromDob } from '@/lib/engines/age';

export type BenchmarkClass = 'observed_market' | 'regulatory_statutory' | 'fhip_planning' | 'platform_peer';

export const BENCHMARK_CLASS_LABEL: Record<BenchmarkClass, string> = {
  observed_market: 'Observed market benchmark',
  regulatory_statutory: 'Regulatory or statutory benchmark',
  fhip_planning: 'FHIP planning benchmark',
  platform_peer: 'Platform peer benchmark',
};

export type EvidenceLevel = 'official_statistical' | 'regulatory' | 'research_informed' | 'platform_derived';

export type StatisticType = 'mean' | 'median' | 'p10' | 'p25' | 'p50' | 'p75' | 'p90' | 'target_min' | 'target_max' | 'threshold' | 'rate' | 'share';

export type ComparisonDirection = 'higher_better' | 'lower_better' | 'target_range' | 'context_only';

export type MetricCategory =
  | 'income_cashflow'
  | 'expenses_savings'
  | 'liquidity_resilience'
  | 'debt_commitments'
  | 'assets_networth'
  | 'investments'
  | 'retirement'
  | 'insurance'
  | 'goals'
  | 'cross_border';

export const METRIC_CATEGORY_LABEL: Record<MetricCategory, string> = {
  income_cashflow: 'Income and Cash Flow',
  expenses_savings: 'Expenses and Savings',
  liquidity_resilience: 'Liquidity and Resilience',
  debt_commitments: 'Debt and Commitments',
  assets_networth: 'Assets and Net Worth',
  investments: 'Investment Behaviour',
  retirement: 'Retirement Readiness',
  insurance: 'Insurance and Protection',
  goals: 'Goal Progress',
  cross_border: 'Cross-Border Exposure',
};

/** 1 = exact twin ... 5 = FHIP planning benchmark only (spec section 6.4). */
export type CohortTier = 1 | 2 | 3 | 4 | 5;

export const COHORT_TIER_LABEL: Record<CohortTier, string> = {
  1: 'Exact Twin',
  2: 'Strong Match',
  3: 'Moderate Match',
  4: 'Broad Match',
  5: 'Planning Benchmark',
};

export type ComparisonStatus =
  | 'materially_ahead'
  | 'ahead'
  | 'broadly_aligned'
  | 'slightly_behind'
  | 'materially_behind'
  | 'target_range_met'
  | 'context_required'
  | 'not_comparable';

export const COMPARISON_STATUS_LABEL: Record<ComparisonStatus, string> = {
  materially_ahead: 'Materially ahead',
  ahead: 'Ahead',
  broadly_aligned: 'Broadly aligned',
  slightly_behind: 'Slightly behind',
  materially_behind: 'Materially behind',
  target_range_met: 'Within planning range',
  context_required: 'Context required',
  not_comparable: 'Not comparable',
};

// ---------------------------------------------------------------------------
// Age bands (spec section 6.2)
// ---------------------------------------------------------------------------
export type AgeBand = 'AGE_18_24' | 'AGE_25_34' | 'AGE_35_44' | 'AGE_45_54' | 'AGE_55_64' | 'AGE_65_74' | 'AGE_75_PLUS';

const AGE_BAND_BOUNDS: { code: AgeBand; min: number; max: number }[] = [
  { code: 'AGE_18_24', min: 18, max: 24 },
  { code: 'AGE_25_34', min: 25, max: 34 },
  { code: 'AGE_35_44', min: 35, max: 44 },
  { code: 'AGE_45_54', min: 45, max: 54 },
  { code: 'AGE_55_64', min: 55, max: 64 },
  { code: 'AGE_65_74', min: 65, max: 74 },
  { code: 'AGE_75_PLUS', min: 75, max: 999 },
];

export function ageToAgeBand(age: number): AgeBand | null {
  const band = AGE_BAND_BOUNDS.find((b) => age >= b.min && age <= b.max);
  return band?.code ?? null;
}

// Delegates to the shared lib/engines/age.ts helper (consolidated from 3
// previously-identical duplicate implementations) — dateOfBirth is required
// here, so the shared helper's null branch never triggers.
export function ageFromDateOfBirth(dateOfBirth: string, asOf: Date = new Date()): number {
  return ageFromDob(dateOfBirth, asOf) as number;
}

// ---------------------------------------------------------------------------
// Income bands — no official per-country household-income percentile survey
// is seeded in this release, so these are FHIP product-defined nominal
// annual-gross-household-income thresholds (spec section 6.3's own fallback:
// "Where valid local percentile boundaries are unavailable, use configured
// nominal bands, label them as product-defined, avoid displaying an
// unsupported percentile rank"). isProductDefined below drives that label.
// ---------------------------------------------------------------------------
export type IncomeBand = 'INCOME_BAND_1' | 'INCOME_BAND_2' | 'INCOME_BAND_3' | 'INCOME_BAND_4' | 'INCOME_BAND_5';

const INCOME_BAND_THRESHOLDS: Record<'AU' | 'IN', { band: IncomeBand; min: number }[]> = {
  AU: [
    { band: 'INCOME_BAND_1', min: 0 },
    { band: 'INCOME_BAND_2', min: 50_000 },
    { band: 'INCOME_BAND_3', min: 90_000 },
    { band: 'INCOME_BAND_4', min: 130_000 },
    { band: 'INCOME_BAND_5', min: 200_000 },
  ],
  IN: [
    { band: 'INCOME_BAND_1', min: 0 },
    { band: 'INCOME_BAND_2', min: 300_000 },
    { band: 'INCOME_BAND_3', min: 600_000 },
    { band: 'INCOME_BAND_4', min: 1_200_000 },
    { band: 'INCOME_BAND_5', min: 2_500_000 },
  ],
};

export const INCOME_BANDS_ARE_PRODUCT_DEFINED = true;

export function annualGrossIncomeToIncomeBand(countryCode: 'AU' | 'IN', annualGrossIncome: number): IncomeBand {
  const thresholds = INCOME_BAND_THRESHOLDS[countryCode];
  let selected: IncomeBand = thresholds[0].band;
  for (const t of thresholds) if (annualGrossIncome >= t.min) selected = t.band;
  return selected;
}

// ---------------------------------------------------------------------------
// Life stage — derived (not stored), same spirit as Financial DNA classifying
// from data rather than being user-entered. Deterministic priority order:
// retirement status and age dominate; dependants refine family life stages.
// ---------------------------------------------------------------------------
export type LifeStage =
  | 'young_professional'
  | 'young_family'
  | 'established_family'
  | 'established_no_kids'
  | 'pre_retiree'
  | 'retiree'
  | 'unspecified';

export const LIFE_STAGE_LABEL: Record<LifeStage, string> = {
  young_professional: 'Young professional',
  young_family: 'Young family',
  established_family: 'Established family',
  established_no_kids: 'Established household',
  pre_retiree: 'Pre-retiree',
  retiree: 'Retiree',
  unspecified: 'Unspecified life stage',
};

export function deriveLifeStage(params: { ageBand: AgeBand | null; dependantsCount: number; employmentType: EmploymentType }): LifeStage {
  const { ageBand, dependantsCount, employmentType } = params;
  if (employmentType === 'retired' || ageBand === 'AGE_65_74' || ageBand === 'AGE_75_PLUS') return 'retiree';
  if (ageBand === 'AGE_55_64') return 'pre_retiree';
  if (ageBand === 'AGE_45_54') return dependantsCount > 0 ? 'established_family' : 'established_no_kids';
  if (ageBand === 'AGE_35_44') return dependantsCount > 0 ? 'established_family' : 'young_professional';
  if (ageBand === 'AGE_25_34') return dependantsCount > 0 ? 'young_family' : 'young_professional';
  if (ageBand === 'AGE_18_24') return 'young_professional';
  return 'unspecified';
}

// ---------------------------------------------------------------------------
// Employment type / household type normalisation. Module 1's onboarding
// fields (employment_status, household_type, marital_status) are free text,
// but cohort matching needs canonical codes. These deterministic, documented
// keyword mappings classify existing free-text values with a graceful
// 'unspecified' fallback that simply broadens the cohort tier rather than
// erroring (spec Rule 7: missing/unmatched data must never become zero).
// ---------------------------------------------------------------------------
export type EmploymentType = 'employee' | 'self_employed' | 'business_owner' | 'retired' | 'unemployed' | 'student' | 'unspecified';

export function normalizeEmploymentType(raw: string | null | undefined): EmploymentType {
  if (!raw) return 'unspecified';
  const s = raw.trim().toLowerCase();
  if (s.includes('retire')) return 'retired';
  if (s.includes('student')) return 'student';
  if (s.includes('unemploy') || s.includes('not working') || s.includes('job seek')) return 'unemployed';
  if (s.includes('business owner') || s.includes('director') || s.includes('own business')) return 'business_owner';
  if (s.includes('self') || s.includes('contractor') || s.includes('freelance') || s.includes('sole trader')) return 'self_employed';
  if (s.includes('employ')) return 'employee';
  return 'unspecified';
}

export type HouseholdTypeCode = 'single' | 'couple_no_kids' | 'couple_with_kids' | 'single_parent' | 'multi_generational' | 'unspecified';

// Household type describes COMPOSITION only (single/couple/family) — it is
// deliberately independent of retirement status, which life_stage already
// captures. Collapsing every retiree into one bucket would lose the
// single-vs-couple distinction that retirement benchmarks (e.g. ASFA's
// single/couple targets) genuinely need.
export function normalizeHouseholdType(raw: string | null | undefined, dependantsCount: number): HouseholdTypeCode {
  const s = (raw ?? '').trim().toLowerCase();
  const hasKids = dependantsCount > 0;
  if (s.includes('multi') || s.includes('extended') || s.includes('joint family')) return 'multi_generational';
  if (s.includes('single parent') || s.includes('sole parent')) return 'single_parent';
  if (s.includes('single')) return hasKids ? 'single_parent' : 'single';
  if (s.includes('couple') || s.includes('married') || s.includes('partner') || s.includes('retire') || s.includes('family')) {
    return hasKids ? 'couple_with_kids' : 'couple_no_kids';
  }
  if (hasKids) return 'couple_with_kids';
  return 'unspecified';
}

// ---------------------------------------------------------------------------
// Confidence bands (spec section 11)
// ---------------------------------------------------------------------------
export function confidenceLabel(score: number): string {
  if (score >= 90) return 'Very high';
  if (score >= 75) return 'High';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Limited';
  return 'Insufficient for a direct comparison';
}

// ---------------------------------------------------------------------------
// Comparison status thresholds (spec section 14). Default materiality bands;
// individual metrics may override via MetricDefinition.materialityOverride
// since "a 5% difference in net worth is less meaningful than a five
// percentage-point difference in a savings rate" (spec's own caveat).
// ---------------------------------------------------------------------------
export interface MaterialityThresholds {
  materialPct: number; // e.g. 0.20 = 20%
  minorPct: number; // e.g. 0.05 = 5%
}

export const DEFAULT_MATERIALITY: MaterialityThresholds = { materialPct: 0.2, minorPct: 0.05 };

/** relativePosition: user/benchmark for higher-better metrics, benchmark/user for lower-better (spec section 13). */
export function comparisonStatusFromRelativePosition(
  relativePosition: number,
  thresholds: MaterialityThresholds = DEFAULT_MATERIALITY
): ComparisonStatus {
  const diff = relativePosition - 1;
  if (diff >= thresholds.materialPct) return 'materially_ahead';
  if (diff >= thresholds.minorPct) return 'ahead';
  if (diff > -thresholds.minorPct) return 'broadly_aligned';
  if (diff > -thresholds.materialPct) return 'slightly_behind';
  return 'materially_behind';
}

// direction matters here: for a higher-is-better metric, min/max describe a
// floor to clear and a ceiling where "more" becomes ambiguous rather than
// bad (spec's emergency-fund example: 12+ months may be excess cash, not a
// problem). For a lower-is-better metric (an expense or debt ratio), it's
// the opposite — the band's max is the ceiling not to exceed, and a value
// BELOW the band's min is not a shortfall at all, it's better than the
// healthy range asks for, so it must never be reported as "behind".
export function comparisonStatusFromTargetRange(
  value: number,
  min: number | null,
  max: number | null,
  direction: 'higher_better' | 'lower_better' | 'target_range' = 'target_range'
): ComparisonStatus {
  if (direction === 'lower_better') {
    if (max !== null && value > max) {
      const excessPct = max > 0 ? (value - max) / Math.abs(max) : 1;
      return excessPct >= DEFAULT_MATERIALITY.materialPct ? 'materially_behind' : 'slightly_behind';
    }
    return 'target_range_met';
  }
  if (min !== null && value < min) {
    const shortfallPct = min > 0 ? (min - value) / Math.abs(min) : 1;
    return shortfallPct >= DEFAULT_MATERIALITY.materialPct ? 'materially_behind' : 'slightly_behind';
  }
  if (max !== null && value > max) return 'context_required';
  return 'target_range_met';
}

// ---------------------------------------------------------------------------
// Percentile bands (spec section 5 / "Section E")
// ---------------------------------------------------------------------------
export function percentileInterpretation(percentile: number): string {
  if (percentile >= 90) return 'Among the strongest positions in the available comparison group';
  if (percentile >= 75) return 'Above most comparable households';
  if (percentile >= 40) return 'Broadly within the middle range';
  if (percentile >= 25) return 'Below many comparable households';
  return 'Materially below the available benchmark distribution';
}
