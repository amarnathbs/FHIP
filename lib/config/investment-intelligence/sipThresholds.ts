// Investment Intelligence R5 — centrally-configured, versioned SIP thresholds.
//
// Every threshold that influences a SIP classification lives HERE, not
// scattered as magic numbers across detection/pause/cadence code. The
// version string below is embedded in every persisted R5 SIP analytics
// result, so a threshold change is detectable as staleness rather than
// silently re-labelling historical results (spec sections 44, 55-57).
//
// Bump SIP_THRESHOLD_CONFIG_VERSION whenever ANY value below changes.

export const SIP_THRESHOLD_CONFIG_VERSION = 'sip-thresholds-r5-v1';

/**
 * Cadence classification windows, in days between consecutive contributions.
 * A series is classified to a cadence only when its observed intervals fall
 * within the band; anything else is OTHER_RECURRING or IRREGULAR. Nothing is
 * ever "forced to monthly" (spec section 43).
 */
export const CADENCE_BANDS = {
  // A monthly SIP debited on the 5th of each month produces intervals of
  // 28-31 days; a weekend/holiday shift widens that a little.
  MONTHLY: { minDays: 24, maxDays: 38, nominalDays: 30.4375, periodsPerYear: 12 },
  QUARTERLY: { minDays: 80, maxDays: 105, nominalDays: 91.3125, periodsPerYear: 4 },
  WEEKLY: { minDays: 5, maxDays: 9, nominalDays: 7, periodsPerYear: 52 },
  FORTNIGHTLY: { minDays: 12, maxDays: 17, nominalDays: 14, periodsPerYear: 26 },
  ANNUAL: { minDays: 350, maxDays: 380, nominalDays: 365.25, periodsPerYear: 1 },
} as const;

export type CadenceKey = keyof typeof CADENCE_BANDS;

/**
 * Minimum number of contributions before a recurring pattern may be inferred
 * at all. Two purchases are a coincidence; the project's deliberately
 * conservative floor is three, so a pair of manual purchases one month apart
 * can never become an inferred SIP (spec section 41).
 */
export const MIN_CONTRIBUTIONS_FOR_INFERENCE = 3;

/**
 * Fraction of consecutive intervals that must fall inside a single cadence
 * band for that cadence to be assigned. Below this the series is
 * OTHER_RECURRING (recurring, but no clean cadence) or IRREGULAR.
 */
export const MIN_INTERVAL_CONSISTENCY_FOR_CADENCE = 0.7;

/**
 * Amount-stability tolerance used by HIGH_CONFIDENCE inference: contributions
 * are "similar" when each is within this relative band of the series median.
 * A step-up SIP legitimately breaches this, which is why a breach downgrades
 * confidence rather than rejecting the series outright.
 */
export const AMOUNT_SIMILARITY_TOLERANCE = 0.05; // ±5% of median

/**
 * Pause / stopped classification (spec section 44). Expressed in MISSED
 * PERIODS relative to the series' own detected cadence — never in absolute
 * days, so a quarterly SIP is not judged by a monthly yardstick.
 *
 * Deliberate design: LIKELY_STOPPED requires strictly more than one missed
 * period. A single missing instalment can NEVER produce "stopped" — that is
 * an explicit spec prohibition and is asserted directly in the R5 test pack.
 */
export const PAUSE_THRESHOLDS = {
  /** Up to this many periods overdue is still just "expected/on-time". */
  EXPECTED_MAX_MISSED: 0.5,
  /** Beyond EXPECTED, up to here is LATE (grace for debit-date drift). */
  LATE_MAX_MISSED: 1.0,
  /** Beyond LATE, up to here is POSSIBLE_PAUSE. */
  POSSIBLE_PAUSE_MAX_MISSED: 3.0,
  /** Strictly beyond POSSIBLE_PAUSE is LIKELY_STOPPED. Always > 1 period. */
} as const;

/**
 * Gap detection: an interval longer than this many nominal cadence periods
 * is reported as an explicit gap in the contribution history.
 */
export const GAP_MIN_MISSED_PERIODS = 1.5;

/**
 * Historical step-up simulation variants offered (spec section 46). These are
 * ILLUSTRATIVE VARIANTS shown side by side; R5 never states which one the
 * user should choose.
 */
export const SIMULATION_STEP_UP_VARIANTS = [0, 0.05, 0.1] as const;

/**
 * Contribution rounding applied inside a step-up simulation. Real SIP
 * mandates are whole-rupee; the simulation rounds each stepped-up
 * contribution to the nearest whole currency unit and persists the fact that
 * it did so (spec section 47).
 */
export const SIMULATION_CONTRIBUTION_ROUNDING = 'nearest_whole_unit' as const;
