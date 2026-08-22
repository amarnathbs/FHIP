// R4 — Central, versioned minimum-history/eligibility configuration
// (spec section 50). Every engine consults THIS module for "do I have
// enough data to compute metric X" — never a scattered `if (days > 365)`
// check inside a component or route.
//
// Bump MINIMUM_HISTORY_CONFIG_VERSION whenever any threshold changes; the
// version is part of every persisted ii_analytics_results row so a shown
// number can always be traced to the eligibility rule that allowed it.

export const MINIMUM_HISTORY_CONFIG_VERSION = 'min-history-v1';

export const MINIMUM_OBSERVATIONS = {
  /** Point-to-point / trailing return over horizon H needs a valuation at H and now. */
  trailingReturn: 2,
  /** CAGR needs a valid beginning and ending valuation, horizon >= 1 year for annualisation to be meaningful without qualification. */
  cagrMinDays: 1,
  cagrAnnualisationThresholdDays: 365,
  /** TWRR needs at least one sub-period, i.e. 2 valuation points bracketing zero or more external flows. */
  twrrMinValuationPoints: 2,
  /** Volatility / downside deviation: at least this many periodic return observations. */
  volatilityMinObservations: 12, // e.g. 12 monthly observations (~1Y) minimum
  /** Sharpe/Sortino inherit the volatility minimum plus a valid risk-free series. */
  sharpeSortinoMinObservations: 12,
  /** Beta/alpha/tracking error/information ratio: minimum paired fund+benchmark observations. */
  betaMinObservations: 12,
  trackingErrorMinObservations: 12,
  informationRatioMinObservations: 12,
  /** Capture ratios need at least this many benchmark-positive AND benchmark-negative periods each. */
  captureRatioMinPeriodsPerDirection: 3,
  /** Calmar needs at least one full drawdown cycle and >=1Y of history. */
  calmarMinDays: 365,
  /** Rolling-window series: minimum number of valid windows before a beat-% is meaningful. */
  rollingMinWindows: 6,
  /** Calendar-year return: the year must be a genuinely complete calendar year (first and last trading/valuation day both present). */
  calendarYearRequiresFullYear: true,
} as const;

export type MetricKey =
  | 'trailingReturn'
  | 'cagr'
  | 'twrr'
  | 'xirr'
  | 'volatility'
  | 'downsideDeviation'
  | 'maxDrawdown'
  | 'sharpe'
  | 'sortino'
  | 'beta'
  | 'alpha'
  | 'trackingError'
  | 'informationRatio'
  | 'upsideCapture'
  | 'downsideCapture'
  | 'calmar'
  | 'rolling1Y'
  | 'rolling3Y'
  | 'rolling5Y';

/** Horizons (in days, actual/365 convention) for scheme trailing-return support (spec section 23). */
export const RETURN_HORIZONS_DAYS: Record<string, number> = {
  '1M': 30,
  '3M': 91,
  '6M': 182,
  '1Y': 365,
  '3Y': 365 * 3,
  '5Y': 365 * 5,
  '7Y': 365 * 7,
  '10Y': 365 * 10,
};

/** Horizons at or below this are shown non-annualised (point-to-point %); above, CAGR-annualised. Spec section 24. */
export const NON_ANNUALISED_HORIZON_DAYS = 365;
