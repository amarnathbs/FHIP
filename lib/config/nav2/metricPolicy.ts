// NAV2 -- the ONE central, versioned policy for user-held scheme analytics
// (spec sections 5.3, 8, 11). Every threshold, convention and buffer the NAV2
// engine and window planner consult lives here; no engine file carries its own
// `if (days > 365)`. Bump NAV2_POLICY_VERSION whenever any value changes: the
// version is part of every result's provenance and of every cache key, so a
// shown number can always be traced to the rule that allowed it and a policy
// change invalidates exactly the results it affects.
//
// Values marked INITIAL are the spec's own recommended starting points
// ("subject to validation"). Values marked PO-CONFIRM are NOT in the spec; they
// are the engineering choice made to fill a gap the spec leaves open, and are
// listed for the Product Owner in docs/nav2/NAV2_METRIC_DEFINITION_REGISTER.md.

export const NAV2_POLICY_VERSION = 'nav2-policy-v1';
export const NAV2_ENGINE_VERSION = 'nav2-engine-v1';

export type ReturnFrequency = 'daily' | 'weekly' | 'monthly';

/**
 * Risk-free series staleness (PO decision 2026-10-03). A rate is "in force" only while it is fresh enough; a date
 * with no fresh rate has NO rate, and every ratio that needs it answers `risk_free_missing`, so a silently broken
 * refresh is visible as missing data rather than as a quietly aging number.
 *   - RBI 91-day T-bill cut-off yield (cadence weekly_auction): measured from the latest AUCTION observation on
 *     or before the date. 21 days = three weekly cycles: a missed auction plus a holiday week, no more.
 *   - RBI policy repo rate (cadence policy_change): the dataset records only CHANGES (the repo rate can stay
 *     unchanged for years), so age since the last change says nothing about freshness. The window is measured
 *     from the dataset's `verifiedThroughDate` instead (the date the series was last confirmed complete, e.g. a
 *     monetary-policy statement or a weekly NSDP check that found no change). 90 days covers the gap between
 *     meetings plus one missed check. PO-CONFIRM.
 */
export const RISK_FREE_MAX_STALENESS_DAYS = {
  RBI_91D_TBILL_CUTOFF_YIELD: 21,
  RBI_POLICY_REPO_RATE: 90,
} as const;

export interface RollingHorizon {
  id: string;
  /** Calendar months subtracted from each end date to find the window start. */
  months: number;
}

export interface Nav2Policy {
  version: string;

  /** CAGR convention (spec 8.2): mean Gregorian year. XIRR keeps its own certified /365 (spec 9.2). */
  daysPerYear: number;
  /** CAGR is shown only for a period of at least this many actual days (spec 8.2: "at least one year"). */
  cagrMinDays: number;
  /** Previous-valid-NAV lookup window for any boundary (spec 5.3 / 8.1): "10 calendar days before target date". */
  boundaryLookupDays: number;
  /** A gap between consecutive NAVs wider than this many calendar days is a material gap (disclosed; never interpolated). PO-CONFIRM. */
  materialGapDays: number;

  /** Annualisation factors (spec 8.7). */
  periodsPerYear: Record<ReturnFrequency, number>;
  /**
   * A return series is "consistent" for its declared frequency only while every interval is at most this many
   * calendar days (spec 8.7: never blindly apply sqrt(252) to irregular intervals). Daily allows the longest
   * Indian market-closure runs (long weekend plus holiday). PO-CONFIRM.
   */
  maxReturnIntervalDays: Record<ReturnFrequency, number>;
  /** The typical (median) interval of a return series must sit inside its declared frequency's band, so a weekly series cannot be passed off as daily. PO-CONFIRM. */
  medianIntervalDays: Record<ReturnFrequency, { min: number; max: number }>;

  minimums: {
    /** Daily return needs 2 valid observations. INITIAL. */
    dailyReturnObservations: number;
    /** Volatility: at least 30 aligned periodic returns; prefer 60+. INITIAL. */
    volatilityReturns: number;
    volatilityPreferredReturns: number;
    /** Sharpe / Sortino: at least 60 daily returns plus matched risk-free data. INITIAL. */
    sharpeSortinoReturns: number;
    /** Beta / alpha: at least 60 common returns; prefer 252 for a one-year claim. INITIAL. */
    betaAlphaReturns: number;
    betaAlphaPreferredReturns: number;
    /** Correlation: at least 30 common returns; prominently disclose below 60. INITIAL. */
    correlationReturns: number;
    correlationDisclosureBelowReturns: number;
    /** A rolling series needs at least one complete window; its SUMMARY statistics need a materially larger set. PO-CONFIRM for the summary figure. */
    rollingMinWindows: number;
    rollingSummaryMinWindows: number;
    /** Max drawdown needs 2 observations; a period shorter than this many calendar days is disclosed as short. INITIAL (2) / PO-CONFIRM (90). */
    drawdownObservations: number;
    drawdownShortPeriodDays: number;
  };

  /** Rolling horizons (spec 8.5): 1 month, 3 months, 6 months, 1 year, 3 years, 5 years. */
  rollingHorizons: readonly RollingHorizon[];
  /** A rolling window of at least this many calendar months is shown annualised; shorter ones as an absolute return. PO-CONFIRM. */
  rollingAnnualiseFromMonths: number;

  /** Approved SMA / EMA periods, in OBSERVATIONS, not calendar days (spec 8.13). */
  movingAveragePeriods: readonly number[];
  /** ROC is defined in observations (spec 8.15); any whole number from 1 to this. PO-CONFIRM. */
  rocMaxPeriod: number;

  /** A standard deviation at or below this is treated as zero variance (no ratio is produced). PO-CONFIRM. */
  zeroVarianceEpsilon: number;

  /** Required-history-window buffers (spec 5.3), consumed by the Phase B planner. */
  windowPlanning: {
    /** Buffer before a point-to-point boundary, an earliest transaction, a snapshot, an as-of date. INITIAL: 10. */
    boundaryBufferDays: number;
    /** Calendar days of data needed BEFORE the first rolling endpoint, per horizon id. INITIAL. */
    rollingPrecedingDays: Record<string, number>;
    /** Calendar days per trading observation when converting an N-observation requirement to a calendar span (5 trading days per 7 calendar days, rounded up). PO-CONFIRM. */
    calendarDaysPerObservation: number;
    /** Extra observations, beyond N, requested for an EMA's warm-up (spec 5.3 "plus a warm-up allowance for EMA"). PO-CONFIRM. */
    emaWarmupExtraObservations: number;
    /** A mandatory reconstruction buffer before the earliest known date (spec 5.1). INITIAL: same 10 days. */
    reconstructionBufferDays: number;
  };

  /** Largest age, in days, a risk-free observation may have and still be in force, by series id. */
  riskFreeMaxStalenessDays: Record<string, number>;

  /**
   * Beta and alpha benchmark rules (PO decision 04-10-2026). The read-time CATEGORY REFERENCE table is UNVERIFIED and no
   * licensed series exists, so beta and alpha are shown ONLY for a DECLARED benchmark (admin / factsheet published) that is
   * verified, total-return, entitled and has a series; otherwise `benchmark_missing`. Flip only when the category table is
   * verified AND the PO says so.
   */
  benchmark: { allowCategoryReference: boolean };

  /** Declared conventions (spec 8.8, 8.9, 8.12), carried verbatim into provenance. */
  conventions: {
    riskFreeConversion: 'compound_per_period_1_over_n';
    sharpe: 'mean_excess_over_sample_sd_excess';
    sortino: 'target_is_matched_risk_free_all_periods_population_denominator';
    alphaAnnualisation: 'arithmetic_periodic_alpha_times_periods_per_year';
    standardDeviation: 'sample_n_minus_1';
    drawdownRecovery: 'first_observation_at_or_above_prior_peak';
    highLowTie: 'earliest_occurrence';
    rankingTie: 'instrument_id_ascending';
  };
}

export const NAV2_POLICY: Nav2Policy = {
  version: NAV2_POLICY_VERSION,
  daysPerYear: 365.2425,
  cagrMinDays: 365,
  boundaryLookupDays: 10,
  materialGapDays: 10,
  periodsPerYear: { daily: 252, weekly: 52, monthly: 12 },
  maxReturnIntervalDays: { daily: 10, weekly: 14, monthly: 45 },
  medianIntervalDays: { daily: { min: 0, max: 4 }, weekly: { min: 5, max: 9 }, monthly: { min: 25, max: 35 } },
  minimums: {
    dailyReturnObservations: 2,
    volatilityReturns: 30,
    volatilityPreferredReturns: 60,
    sharpeSortinoReturns: 60,
    betaAlphaReturns: 60,
    betaAlphaPreferredReturns: 252,
    correlationReturns: 30,
    correlationDisclosureBelowReturns: 60,
    rollingMinWindows: 1,
    rollingSummaryMinWindows: 60,
    drawdownObservations: 2,
    drawdownShortPeriodDays: 90,
  },
  rollingHorizons: [
    { id: '1M', months: 1 },
    { id: '3M', months: 3 },
    { id: '6M', months: 6 },
    { id: '1Y', months: 12 },
    { id: '3Y', months: 36 },
    { id: '5Y', months: 60 },
  ],
  rollingAnnualiseFromMonths: 12,
  movingAveragePeriods: [20, 50, 100, 200],
  rocMaxPeriod: 1000,
  zeroVarianceEpsilon: 1e-12,
  windowPlanning: {
    boundaryBufferDays: 10,
    rollingPrecedingDays: { '1M': 45, '3M': 110, '6M': 210, '1Y': 380, '3Y': 1125, '5Y': 1855 },
    calendarDaysPerObservation: 1.5,
    emaWarmupExtraObservations: 20,
    reconstructionBufferDays: 10,
  },
  riskFreeMaxStalenessDays: { ...RISK_FREE_MAX_STALENESS_DAYS },
  benchmark: { allowCategoryReference: false },
  conventions: {
    riskFreeConversion: 'compound_per_period_1_over_n',
    sharpe: 'mean_excess_over_sample_sd_excess',
    sortino: 'target_is_matched_risk_free_all_periods_population_denominator',
    alphaAnnualisation: 'arithmetic_periodic_alpha_times_periods_per_year',
    standardDeviation: 'sample_n_minus_1',
    drawdownRecovery: 'first_observation_at_or_above_prior_peak',
    highLowTie: 'earliest_occurrence',
    rankingTie: 'instrument_id_ascending',
  },
};

/** A policy override for tests and for a future per-environment tuning; always re-stamps the version suffix so provenance shows it. */
export function withPolicyOverrides(overrides: DeepPartial<Nav2Policy>, label: string): Nav2Policy {
  const merged = mergeDeep(NAV2_POLICY as unknown as Record<string, unknown>, overrides as unknown as Record<string, unknown>) as unknown as Nav2Policy;
  return { ...merged, version: `${NAV2_POLICY_VERSION}+${label}` };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeDeep(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) out[k] = mergeDeep(b as Record<string, unknown>, v as Record<string, unknown>);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metric definition register (central). Every metric the engine can emit has
// ONE entry here: its id, its definition version, the family it belongs to and
// its one-line formula. The long-form register (docs/nav2/
// NAV2_METRIC_DEFINITION_REGISTER.md) is checked against this list by a test,
// so a metric cannot exist in code without a documented definition or the
// reverse. A definition version is bumped when the FORMULA or CONVENTION of
// that metric changes (not for a policy threshold, which is NAV2_POLICY_VERSION).
// ---------------------------------------------------------------------------

export type ResultFamily = 'scheme_performance' | 'investor_experience';

export interface MetricDefinition {
  id: string;
  family: ResultFamily;
  version: string;
  formula: string;
}

export const NAV2_METRICS = {
  absolute_return: { id: 'absolute_return', family: 'scheme_performance', version: 'nav2-absolute-return-v1', formula: 'P1 / P0 - 1' },
  cagr: { id: 'cagr', family: 'scheme_performance', version: 'nav2-cagr-actual-days-v1', formula: '(P1 / P0) ^ (365.2425 / actualDays) - 1' },
  point_to_point: { id: 'point_to_point', family: 'scheme_performance', version: 'nav2-point-to-point-v1', formula: 'previous-valid NAV on or before each requested boundary; absolute return and CAGR from those NAVs' },
  daily_simple_return: { id: 'daily_simple_return', family: 'scheme_performance', version: 'nav2-daily-simple-return-v1', formula: 'P_t / P_(t-1) - 1 over consecutive valid observations' },
  daily_log_return: { id: 'daily_log_return', family: 'scheme_performance', version: 'nav2-daily-log-return-v1', formula: 'ln(P_t / P_(t-1)); cumulative simple = exp(sum) - 1' },
  rolling_return: { id: 'rolling_return', family: 'scheme_performance', version: 'nav2-rolling-return-v1', formula: 'for each end date t: return from the latest NAV on or before (t - horizon); absolute under 12 months, CAGR from 12 months' },
  volatility: { id: 'volatility', family: 'scheme_performance', version: 'nav2-volatility-v1', formula: 'sample_sd(simple returns) x sqrt(periodsPerYear)' },
  sharpe_ratio: { id: 'sharpe_ratio', family: 'scheme_performance', version: 'nav2-sharpe-excess-v1', formula: 'mean(r - rf) / sample_sd(r - rf), rf = (1 + y)^(1 / periodsPerYear) - 1 from the series yield y in force at each interval start; annualised x sqrt(periodsPerYear)' },
  sortino_ratio: { id: 'sortino_ratio', family: 'scheme_performance', version: 'nav2-sortino-all-periods-v1', formula: 'mean(r - MAR) / sqrt(mean(min(0, r - MAR)^2)) with MAR = matched risk-free, mean over ALL periods' },
  max_drawdown: { id: 'max_drawdown', family: 'scheme_performance', version: 'nav2-max-drawdown-v1', formula: 'min over t of P_t / max(P_0..P_t) - 1, with peak, trough and recovery dates' },
  beta: { id: 'beta', family: 'scheme_performance', version: 'nav2-beta-v1', formula: 'cov(r_scheme, r_benchmark) / var(r_benchmark) on common dates' },
  jensen_alpha: { id: 'jensen_alpha', family: 'scheme_performance', version: 'nav2-jensen-alpha-arithmetic-v1', formula: 'mean(r_s) - [rf + beta x (mean(r_b) - rf)]; annualised arithmetically' },
  sma: { id: 'sma', family: 'scheme_performance', version: 'nav2-sma-v1', formula: 'mean of the last N valid observations' },
  ema: { id: 'ema', family: 'scheme_performance', version: 'nav2-ema-sma-seed-v1', formula: 'EMA_t = P_t x 2/(N+1) + EMA_(t-1) x (1 - 2/(N+1)), seeded with the first N-observation SMA' },
  roc: { id: 'roc', family: 'scheme_performance', version: 'nav2-roc-observations-v1', formula: 'P_t / P_(t-N) - 1, N valid observations' },
  correlation: { id: 'correlation', family: 'scheme_performance', version: 'nav2-correlation-returns-v1', formula: 'Pearson correlation of aligned periodic returns (never NAV levels)' },
  held_ranking: { id: 'held_ranking', family: 'scheme_performance', version: 'nav2-held-ranking-v1', formula: 'rank among the household\'s OWN schemes of one metric, within a comparable group, ties by instrument id' },
  nav_extremes: { id: 'nav_extremes', family: 'scheme_performance', version: 'nav2-nav-extremes-v1', formula: 'highest and lowest eligible NAV with earliest occurrence date' },
  nav_average: { id: 'nav_average', family: 'scheme_performance', version: 'nav2-nav-average-v1', formula: 'arithmetic mean and median of eligible NAV observations' },
  xirr: { id: 'xirr', family: 'investor_experience', version: 'xirr-newton-bisection-v1', formula: 'rate x such that sum CF_i / (1+x)^((date_i - date_0)/365) = 0 (the certified R4 engine)' },
  current_value: { id: 'current_value', family: 'investor_experience', version: 'nav2-current-value-v1', formula: 'canonical units x latest eligible NAV, valued by the certified valueHoldingAsOf rule' },
  invested_amount: { id: 'invested_amount', family: 'investor_experience', version: 'nav2-invested-amount-v1', formula: 'sum of purchase cash flows' },
  gain_loss: { id: 'gain_loss', family: 'investor_experience', version: 'nav2-gain-loss-v1', formula: 'current value + amounts received - amounts invested' },
} as const satisfies Record<string, MetricDefinition>;

export type Nav2MetricId = keyof typeof NAV2_METRICS;
