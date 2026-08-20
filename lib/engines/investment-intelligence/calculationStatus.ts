// R4 — Calculation-result status vocabulary (spec section 104) and the
// deterministic mapping from each engine's metric-specific `reason` union
// onto that shared vocabulary.
//
// The rule this module exists to enforce (spec section 105): a malformed,
// suppressed, or unsupported calculation may NEVER surface as
// `CALCULATED`. Every non-CALCULATED status carries a reason drawn from
// the R4 DataQualityFlag vocabulary plus a human-readable detail, so a
// missing input is always visibly missing and never a silent 0.00%.

import type { DataQualityFlag } from './dataQuality';
import type { XirrUnavailableReason } from './xirr';
import type { TwrrUnavailableReason } from './twrr';
import type { RiskUnavailableReason } from './riskMetrics';

export type CalculationStatus =
  /** A real, reproducible number was produced from sufficient certified input. */
  | 'CALCULATED'
  /** Not enough certified history to support the metric at all. */
  | 'INSUFFICIENT_HISTORY'
  /** Reference data (NAV series, benchmark series/mapping, risk-free rate) is absent. */
  | 'MISSING_REFERENCE_DATA'
  /** A previously-persisted result whose inputs or engine version have since changed. */
  | 'STALE'
  /** The calculation was attempted and errored — never shown as a number. */
  | 'FAILED'
  /** The metric is meaningless for this scope (e.g. active return with no benchmark concept). */
  | 'NOT_APPLICABLE'
  /** A defensible number could not be chosen (e.g. multiple IRR roots, ambiguous mapping). */
  | 'AMBIGUOUS';

export interface CalculationOutcome<T = unknown> {
  status: CalculationStatus;
  /** Present only when status === 'CALCULATED'. */
  value?: T;
  /** Coarse UI-facing classification; present whenever status !== 'CALCULATED'. */
  qualityFlag?: DataQualityFlag;
  /** The metric-specific machine reason from the underlying engine, preserved for traceability. */
  engineReason?: string;
  /** Human-readable explanation shown in place of the number. */
  detail?: string;
}

/** XIRR reason -> (status, flag). */
const XIRR_MAP: Record<XirrUnavailableReason, { status: CalculationStatus; flag: DataQualityFlag }> = {
  ALL_SAME_SIGN: { status: 'NOT_APPLICABLE', flag: 'INSUFFICIENT_HISTORY' },
  NO_TERMINAL_VALUE: { status: 'INSUFFICIENT_HISTORY', flag: 'PARTIAL_TRANSACTION_HISTORY' },
  INVALID_DATES: { status: 'FAILED', flag: 'PARTIAL_TRANSACTION_HISTORY' },
  INSUFFICIENT_HISTORY: { status: 'INSUFFICIENT_HISTORY', flag: 'INSUFFICIENT_HISTORY' },
  NOT_BRACKETED: { status: 'FAILED', flag: 'PARTIAL_TRANSACTION_HISTORY' },
  NO_CONVERGENCE: { status: 'FAILED', flag: 'PARTIAL_TRANSACTION_HISTORY' },
  MULTIPLE_ROOTS_AMBIGUOUS: { status: 'AMBIGUOUS', flag: 'PARTIAL_TRANSACTION_HISTORY' },
};

const TWRR_MAP: Record<TwrrUnavailableReason, { status: CalculationStatus; flag: DataQualityFlag }> = {
  INSUFFICIENT_VALUATION_HISTORY: { status: 'INSUFFICIENT_HISTORY', flag: 'NAV_HISTORY_INCOMPLETE' },
  MISSING_BOUNDARY_VALUATION: { status: 'MISSING_REFERENCE_DATA', flag: 'NAV_HISTORY_INCOMPLETE' },
  INVALID_INPUT: { status: 'FAILED', flag: 'NAV_HISTORY_INCOMPLETE' },
  NEGATIVE_OR_ZERO_SUBPERIOD_START: { status: 'FAILED', flag: 'NAV_HISTORY_INCOMPLETE' },
};

const RISK_MAP: Record<RiskUnavailableReason, { status: CalculationStatus; flag: DataQualityFlag }> = {
  INSUFFICIENT_HISTORY: { status: 'INSUFFICIENT_HISTORY', flag: 'INSUFFICIENT_HISTORY' },
  ZERO_VOLATILITY: { status: 'NOT_APPLICABLE', flag: 'COMPLETE' },
  ZERO_BENCHMARK_VARIANCE: { status: 'NOT_APPLICABLE', flag: 'BENCHMARK_HISTORY_INCOMPLETE' },
  ZERO_TRACKING_ERROR: { status: 'NOT_APPLICABLE', flag: 'COMPLETE' },
  ZERO_DRAWDOWN: { status: 'NOT_APPLICABLE', flag: 'COMPLETE' },
  MISSING_RISK_FREE_DATA: { status: 'MISSING_REFERENCE_DATA', flag: 'RISK_FREE_DATA_MISSING' },
  INVALID_INPUT: { status: 'FAILED', flag: 'INSUFFICIENT_HISTORY' },
  INSUFFICIENT_DIRECTIONAL_PERIODS: { status: 'INSUFFICIENT_HISTORY', flag: 'INSUFFICIENT_HISTORY' },
};

function classify(
  map: Record<string, { status: CalculationStatus; flag: DataQualityFlag }>,
  reason: string | undefined,
  detail: string | undefined
): CalculationOutcome<never> {
  const hit = reason ? map[reason] : undefined;
  return {
    status: hit?.status ?? 'FAILED',
    qualityFlag: hit?.flag ?? 'INSUFFICIENT_HISTORY',
    engineReason: reason,
    detail: detail ?? 'This figure is not available for the selected period.',
  };
}

/** Wrap an xirr() result into the shared status vocabulary. */
export function fromXirr<T>(
  r: { status: 'ok' | 'unavailable'; reason?: XirrUnavailableReason; detail?: string },
  buildValue: () => T
): CalculationOutcome<T> {
  if (r.status === 'ok') return { status: 'CALCULATED', value: buildValue() };
  return classify(XIRR_MAP, r.reason, r.detail) as CalculationOutcome<T>;
}

/** Wrap a twrr() result into the shared status vocabulary. */
export function fromTwrr<T>(
  r: { status: 'ok' | 'unavailable'; reason?: TwrrUnavailableReason; detail?: string },
  buildValue: () => T
): CalculationOutcome<T> {
  if (r.status === 'ok') return { status: 'CALCULATED', value: buildValue() };
  return classify(TWRR_MAP, r.reason, r.detail) as CalculationOutcome<T>;
}

/** Wrap any riskMetrics MetricResult into the shared status vocabulary. */
export function fromRiskMetric<T>(
  r: { status: 'ok' | 'unavailable'; reason?: RiskUnavailableReason; detail?: string; value?: T }
): CalculationOutcome<T> {
  if (r.status === 'ok' && r.value !== undefined) return { status: 'CALCULATED', value: r.value };
  return classify(RISK_MAP, r.reason, r.detail) as CalculationOutcome<T>;
}

/** Explicit constructor for reference-data gaps discovered in the repository layer. */
export function missingReferenceData<T>(flag: DataQualityFlag, detail: string): CalculationOutcome<T> {
  return { status: 'MISSING_REFERENCE_DATA', qualityFlag: flag, detail };
}

/** Explicit constructor for history-completeness gate rejections (spec section 11). */
export function insufficientHistory<T>(flag: DataQualityFlag, detail: string): CalculationOutcome<T> {
  return { status: 'INSUFFICIENT_HISTORY', qualityFlag: flag, detail };
}

/** Explicit constructor for a caught exception. Never becomes CALCULATED. */
export function failed<T>(detail: string): CalculationOutcome<T> {
  return { status: 'FAILED', qualityFlag: 'INSUFFICIENT_HISTORY', detail };
}

/**
 * Mark an otherwise-valid persisted outcome as STALE (spec section 57).
 * The value is deliberately RETAINED so the UI can show "as previously
 * calculated on <date>" with a staleness warning, but the status makes it
 * impossible to present the figure as current without disclosure.
 */
export function markStale<T>(outcome: CalculationOutcome<T>, detail: string): CalculationOutcome<T> {
  return { ...outcome, status: 'STALE', detail };
}

/** True only for statuses that may render an actual number in the UI. */
export function isDisplayableNumber(status: CalculationStatus): boolean {
  return status === 'CALCULATED' || status === 'STALE';
}

/** Maps a status onto the ii_analytics_results.quality_status check constraint. */
export function toPersistedQualityStatus(status: CalculationStatus): 'ok' | 'unavailable' | 'stale' {
  if (status === 'CALCULATED') return 'ok';
  if (status === 'STALE') return 'stale';
  return 'unavailable';
}
