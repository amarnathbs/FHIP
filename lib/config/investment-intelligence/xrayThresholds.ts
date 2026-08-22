// Investment Intelligence R5 — centrally-configured, versioned Portfolio
// X-Ray thresholds (holdings freshness, coverage floors, mixed-date spread).
//
// As with sipThresholds.ts, every value that influences an X-Ray quality
// classification lives here and the version string is embedded in every
// persisted X-Ray result, so a threshold change is detectable as staleness
// (spec sections 61-63, 74-75).

export const XRAY_THRESHOLD_CONFIG_VERSION = 'xray-thresholds-r5-v1';

/**
 * Holdings freshness categorisation (spec section 61). Indian mutual funds
 * disclose portfolios monthly, typically within ~10 days of month end, so a
 * snapshot up to ~45 days old is genuinely CURRENT in practice.
 *
 * Old data is NEVER labelled current — that is an explicit FAIL condition.
 */
export const HOLDINGS_FRESHNESS_DAYS = {
  CURRENT_MAX: 45,
  ACCEPTABLE_MAX: 100,
  STALE_MAX: 210,
  // Beyond STALE_MAX is VERY_STALE. Absent entirely is MISSING.
} as const;

export type HoldingsFreshness = 'CURRENT' | 'ACCEPTABLE' | 'STALE' | 'VERY_STALE' | 'MISSING';

/**
 * Coverage floors. Coverage is ALWAYS displayed; these thresholds only
 * decide when a portfolio-level interpretation is additionally suppressed
 * or qualified. Partial look-through is never presented as complete.
 */
export const COVERAGE_THRESHOLDS = {
  /** Below this, portfolio-level X-Ray conclusions are suppressed entirely. */
  MIN_FOR_PORTFOLIO_CONCLUSION: 0.5,
  /** At or above this, coverage is treated as effectively complete for display purposes (still shown numerically). */
  EFFECTIVELY_COMPLETE: 0.98,
} as const;

/**
 * Mixed holdings-as-of-date spread (spec section 74). When the newest and
 * oldest contributing snapshot dates differ by more than this many days, the
 * portfolio-level aggregate carries an explicit mixed-date warning; beyond
 * the suppress threshold the aggregate interpretation is withheld.
 */
export const MIXED_DATE_SPREAD_DAYS = {
  WARN: 45,
  SUPPRESS_PORTFOLIO_CONCLUSION: 185,
} as const;

/**
 * Rounding tolerance when validating a disclosed holdings file's weight sum.
 * A file summing to 99.97% or 100.02% is rounding noise, not incomplete
 * disclosure. Anything further from 100% is treated as a genuine
 * disclosed-coverage shortfall and retained as an explicit remainder —
 * NEVER rescaled up to 100% (spec section 59, a FAIL condition).
 */
export const WEIGHT_SUM_ROUNDING_TOLERANCE_PCT = 0.5;

/** Default number of top underlying holdings reported. */
export const TOP_HOLDINGS_DEFAULT_N = 10;
export const TOP_HOLDINGS_ALLOWED_N = [5, 10, 20] as const;

/**
 * HHI convention (spec section 66). R5 computes HHI over DECIMAL weights
 * (0..1), so a single-security portfolio scores 1.0 and ten equal securities
 * score 0.1. This convention is documented, versioned, and asserted in the
 * certification pack so it can never drift to the 0..10000 percentage
 * convention without a version bump.
 */
export const HHI_CONVENTION = 'decimal_weights_0_to_1' as const;

/**
 * Approved credit-rating bands (spec section 71). A MISSING rating maps to
 * UNRATED, which is a data-availability statement, NOT a creditworthiness
 * assessment — converting a missing rating into a rating category is a FAIL
 * condition.
 */
export const CREDIT_RATING_BANDS = ['SOVEREIGN', 'AAA', 'AA', 'A', 'BELOW_A', 'UNRATED', 'OTHER_UNCLASSIFIED'] as const;
export type CreditRatingBand = (typeof CREDIT_RATING_BANDS)[number];

/**
 * Deterministic, versioned maturity buckets (spec section 72). Boundaries in
 * years, lower-inclusive / upper-exclusive.
 */
export const MATURITY_BUCKETS = [
  { key: 'LT_1Y', label: 'Under 1 year', minYears: 0, maxYears: 1 },
  { key: 'Y1_3', label: '1-3 years', minYears: 1, maxYears: 3 },
  { key: 'Y3_5', label: '3-5 years', minYears: 3, maxYears: 5 },
  { key: 'Y5_10', label: '5-10 years', minYears: 5, maxYears: 10 },
  { key: 'GT_10Y', label: 'Over 10 years', minYears: 10, maxYears: Infinity },
  { key: 'PERPETUAL_UNKNOWN', label: 'Perpetual / unknown', minYears: null, maxYears: null },
] as const;

export type MaturityBucketKey = (typeof MATURITY_BUCKETS)[number]['key'];
