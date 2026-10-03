// NAV2 -- the typed result contract shared by every engine function (spec
// sections 10, 11, 13). Pure types and tiny constructors; no I/O, no clock.
//
// THE RULE THIS FILE ENFORCES BY CONSTRUCTION: a result is either
//   { state: 'available', value, provenance, disclosures }
// or
//   { state: <one of the eight typed unavailable states>, reason, detail, provenance }
// and an unavailable result has NO `value` key at all (the type forbids it), so
// an insufficient, missing or blocked input can never be rendered as 0, 0% or
// "n/a-looking number". Spec 11: "Do not convert insufficient data into zero."
//
// Two result FAMILIES are kept apart at the type level (spec 2): a scheme
// performance result describes the fund's own NAV series; an investor-experience
// result describes the user's money. They never share a field.

import {
  NAV2_ENGINE_VERSION,
  NAV2_METRICS,
  type Nav2MetricId,
  type Nav2Policy,
  type ResultFamily,
} from '@/lib/config/nav2/metricPolicy';
import { formatDateShort } from '@/lib/engines/date';

export type Nav2UnavailableState =
  | 'insufficient_history'
  | 'history_hydrating'
  | 'benchmark_missing'
  | 'risk_free_missing'
  | 'currency_mismatch'
  | 'identity_unresolved'
  | 'data_quality_hold'
  | 'not_applicable';

export type Nav2State = 'available' | Nav2UnavailableState;

export const NAV2_UNAVAILABLE_STATES: readonly Nav2UnavailableState[] = [
  'insufficient_history',
  'history_hydrating',
  'benchmark_missing',
  'risk_free_missing',
  'currency_mismatch',
  'identity_unresolved',
  'data_quality_hold',
  'not_applicable',
];

/** Machine reason behind a non-available state. The state is what the UI keys on; the reason is for tracing and tests. */
export type Nav2Reason =
  // history / coverage
  | 'window_not_covered'
  | 'too_few_observations'
  | 'too_few_returns'
  | 'boundary_not_found'
  | 'material_gap_in_window'
  | 'irregular_return_intervals'
  | 'history_hydrating'
  // arithmetic guards
  | 'non_positive_nav'
  | 'invalid_dates'
  | 'invalid_input'
  | 'zero_volatility'
  | 'zero_downside_deviation'
  | 'zero_benchmark_variance'
  | 'zero_variance'
  | 'period_under_one_year'
  | 'unsupported_period'
  | 'not_a_number'
  // benchmark
  | 'no_benchmark_mapping'
  | 'benchmark_not_entitled'
  | 'benchmark_catalogue_not_verified'
  | 'benchmark_price_index'
  | 'benchmark_return_type_unknown'
  | 'benchmark_no_series'
  | 'benchmark_mapping_not_effective'
  | 'benchmark_changed_in_window'
  | 'benchmark_history_incomplete'
  | 'benchmark_overlap_insufficient'
  // risk-free
  | 'risk_free_dataset_not_configured'
  | 'risk_free_series_disabled'
  | 'risk_free_coverage_incomplete'
  | 'risk_free_stale'
  // identity / quality
  | 'identity_unresolved'
  | 'identity_ambiguous'
  | 'currency_mismatch'
  | 'conflicting_nav_values'
  | 'scheme_not_held_in_scope'
  | 'no_comparable_peer'
  | 'category_unknown'
  | 'no_terminal_value'
  | 'xirr_unavailable'
  | 'no_valuation';

export type Nav2DisclosureCode =
  | 'below_preferred_observations'
  | 'short_period'
  | 'boundary_substitution'
  | 'material_gap_disclosed'
  | 'nav_only_distribution_option'
  | 'benchmark_basis'
  | 'risk_free_series_used'
  | 'risk_free_terms_pending'
  | 'unrecoverable_history_period'
  | 'cagr_not_shown_under_one_year'
  | 'rolling_summary_withheld'
  | 'statement_value'
  | 'stale_nav'
  | 'not_a_recommendation';

export interface Disclosure {
  code: Nav2DisclosureCode;
  /** Plain words. Any date inside is already day-first (dd-mm-yyyy INR, dd/mm/yyyy otherwise). */
  detail: string;
}

export interface BenchmarkProvenance {
  benchmarkId: string;
  benchmarkKey: string;
  label: string;
  /** 'declared' or 'category_reference'. A category reference carries its honest basisLabel. */
  basis: 'declared' | 'category_reference';
  basisLabel: string;
  returnType: string;
  datasetVersion: string | null;
  licenceStatus: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  observationFirstDate: string | null;
  observationLastDate: string | null;
  commonObservationCount: number;
}

/**
 * "Which risk-free series was used", in full, so a Sharpe / Sortino / alpha can print the rate, its date, its
 * source and the window (PO decision 2026-10-03). Every field comes from the governed dataset or from the
 * rows the calculation actually used; none is typed in by a screen.
 */
export interface RiskFreeProvenance {
  seriesId: string;
  seriesName: string;
  source: string;
  /** Printed with any figure built on the series, e.g. "Source: Reserve Bank of India". */
  attributionText: string;
  /** 'weekly_auction' (T-bill) or 'policy_change' (repo rate). */
  cadence: 'weekly_auction' | 'policy_change';
  datasetVersion: string;
  /** When the dataset's observations were retrieved from the source. */
  retrievedOn: string;
  /** policy_change series: the date the series was last confirmed complete. null for a weekly_auction series. */
  verifiedThroughDate: string | null;
  /** e.g. 'po_accepted_2026-10-03' (the PO accepted the publisher's missing reuse licence as a risk), or 'confirmed_in_writing'. */
  termsReviewStatus: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  periodsPerYear: number;
  /** Always 'compound_per_period_1_over_n': periodic = (1 + y)^(1 / periodsPerYear) - 1. */
  conversion: 'compound_per_period_1_over_n';
  /** The largest age, in days, an observation may have and still be in force (named constant per series). */
  maxStalenessDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  /** Dates of the observations (auctions / policy decisions) actually used: earliest and latest. */
  observationFirstDate: string | null;
  observationLastDate: string | null;
  distinctObservationCount: number;
  /** Annualised yield, in percent, in force at the start and at the end of the window, and the extremes used. */
  yieldPercentAtWindowStart: number | null;
  yieldPercentAtWindowEnd: number | null;
  minYieldPercent: number | null;
  maxYieldPercent: number | null;
  /** One printable sentence naming the rate, the dates, the source and the conversion. */
  disclosureText: string;
}

export interface Nav2Provenance {
  metricId: Nav2MetricId;
  family: ResultFamily;
  definitionVersion: string;
  policyVersion: string;
  engineVersion: string;
  instrumentId: string | null;
  requestedWindow: { start: string | null; end: string | null };
  actualWindow: { start: string | null; end: string | null };
  /** Observations (or returns, or windows) the figure rests on. */
  observationCount: number;
  /** Declared conventions, verbatim: annualisation, day count, downside convention, ... */
  convention: Record<string, string | number | boolean | null>;
  navSeries?: { checksum: string; firstDate: string | null; lastDate: string | null; count: number };
  benchmark?: BenchmarkProvenance;
  riskFree?: RiskFreeProvenance;
}

export interface Nav2Available<T> {
  state: 'available';
  value: T;
  provenance: Nav2Provenance;
  disclosures: Disclosure[];
}

export interface Nav2Unavailable {
  state: Nav2UnavailableState;
  reason: Nav2Reason;
  /** One plain sentence saying why. Shown in place of a number. */
  detail: string;
  provenance: Nav2Provenance;
  disclosures: Disclosure[];
  /** Forbidden: an unavailable result carries no value. */
  value?: never;
}

export type Nav2Result<T> = Nav2Available<T> | Nav2Unavailable;

/** The currency decides the date text: INR dd-mm-yyyy, anything else dd/mm/yyyy (lib/engines/date.ts). */
export interface Nav2Context {
  policy: Nav2Policy;
  currency: 'INR' | 'AUD';
}

export function showDate(ctx: Pick<Nav2Context, 'currency'>, iso: string | null): string {
  return iso ? formatDateShort(iso.slice(0, 10), ctx.currency) : 'not available';
}

export interface ProvenanceExtras {
  instrumentId?: string | null;
  requested?: { start: string | null; end: string | null };
  actual?: { start: string | null; end: string | null };
  observationCount?: number;
  convention?: Nav2Provenance['convention'];
  navSeries?: Nav2Provenance['navSeries'];
  benchmark?: BenchmarkProvenance;
  riskFree?: RiskFreeProvenance;
}

export function makeProvenance(ctx: Nav2Context, metricId: Nav2MetricId, extras: ProvenanceExtras = {}): Nav2Provenance {
  const def = NAV2_METRICS[metricId];
  return {
    metricId,
    family: def.family,
    definitionVersion: def.version,
    policyVersion: ctx.policy.version,
    engineVersion: NAV2_ENGINE_VERSION,
    instrumentId: extras.instrumentId ?? null,
    requestedWindow: extras.requested ?? { start: null, end: null },
    actualWindow: extras.actual ?? { start: null, end: null },
    observationCount: extras.observationCount ?? 0,
    convention: extras.convention ?? {},
    ...(extras.navSeries ? { navSeries: extras.navSeries } : {}),
    ...(extras.benchmark ? { benchmark: extras.benchmark } : {}),
    ...(extras.riskFree ? { riskFree: extras.riskFree } : {}),
  };
}

export function available<T>(value: T, provenance: Nav2Provenance, disclosures: Disclosure[] = []): Nav2Available<T> {
  return { state: 'available', value, provenance, disclosures };
}

export function unavailable(
  state: Nav2UnavailableState,
  reason: Nav2Reason,
  detail: string,
  provenance: Nav2Provenance,
  disclosures: Disclosure[] = []
): Nav2Unavailable {
  return { state, reason, detail, provenance, disclosures };
}

export function isAvailable<T>(r: Nav2Result<T>): r is Nav2Available<T> {
  return r.state === 'available';
}

/** Re-state an unavailable result for another metric (e.g. alpha inherits beta's blocker) keeping reason and detail. */
export function propagateUnavailable(from: Nav2Unavailable, provenance: Nav2Provenance): Nav2Unavailable {
  return { state: from.state, reason: from.reason, detail: from.detail, provenance, disclosures: from.disclosures };
}
