// Investment Intelligence R5 — contribution-consistency statistics, gap
// detection, and paused/stopped classification.
//
// EVERYTHING HERE IS PURELY DESCRIPTIVE (spec sections 42-44). These
// functions describe what the recorded history contains. They never advise.
// A skipped period is reported as a recorded fact — never as "you should
// catch up", never as a judgement about the investor.
//
// The single most important rule in this file: LIKELY_STOPPED can never be
// reached from ONE missed instalment. PAUSE_THRESHOLDS.LATE_MAX_MISSED and
// POSSIBLE_PAUSE_MAX_MISSED sit between EXPECTED and LIKELY_STOPPED
// precisely so a single late debit degrades to LATE, not to "stopped".
// Certification case SIP-004 asserts this directly.

import {
  CADENCE_BANDS,
  PAUSE_THRESHOLDS,
  GAP_MIN_MISSED_PERIODS,
  SIP_THRESHOLD_CONFIG_VERSION,
} from '@/lib/config/investment-intelligence/sipThresholds';
import type { SipSeries, SipCadence } from './sipDetection';

export const SIP_CONSISTENCY_METHOD_VERSION = 'sip-consistency-r5-v1';

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}
function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Nominal days per period for a cadence, or null when not periodic. */
export function nominalPeriodDays(cadence: SipCadence): number | null {
  if (cadence === 'MONTHLY') return CADENCE_BANDS.MONTHLY.nominalDays;
  if (cadence === 'QUARTERLY') return CADENCE_BANDS.QUARTERLY.nominalDays;
  if (cadence === 'WEEKLY') return CADENCE_BANDS.WEEKLY.nominalDays;
  if (cadence === 'FORTNIGHTLY') return CADENCE_BANDS.FORTNIGHTLY.nominalDays;
  if (cadence === 'ANNUAL') return CADENCE_BANDS.ANNUAL.nominalDays;
  return null;
}

export interface SipGap {
  fromDate: string;
  toDate: string;
  days: number;
  missedPeriods: number;
}

export interface SipConsistencyResult {
  status: 'ok' | 'unavailable';
  contributionCount?: number;
  /** Periods that the detected cadence implies should have occurred between first and latest contribution. */
  expectedPeriods?: number;
  observedPeriods?: number;
  skippedPeriods?: number;
  /** observedPeriods / expectedPeriods, 0..1. */
  consistencyPct?: number;
  averageContribution?: number;
  medianContribution?: number;
  minContribution?: number;
  maxContribution?: number;
  totalContributed?: number;
  firstContributionDate?: string;
  latestContributionDate?: string;
  gaps?: SipGap[];
  reason?: 'NO_CONTRIBUTIONS' | 'NON_PERIODIC_CADENCE';
  detail?: string;
  method: typeof SIP_CONSISTENCY_METHOD_VERSION;
  thresholdConfigVersion: typeof SIP_THRESHOLD_CONFIG_VERSION;
}

export function calculateSipConsistency(series: SipSeries): SipConsistencyResult {
  const base = { method: SIP_CONSISTENCY_METHOD_VERSION, thresholdConfigVersion: SIP_THRESHOLD_CONFIG_VERSION } as const;
  const txns = series.contributions;
  if (txns.length === 0) {
    return { status: 'unavailable', reason: 'NO_CONTRIBUTIONS', detail: 'No contributions recorded.', ...base };
  }

  const amounts = txns.map((t) => Math.abs(t.grossAmount));
  const stats = {
    contributionCount: txns.length,
    averageContribution: amounts.reduce((s, a) => s + a, 0) / amounts.length,
    medianContribution: median(amounts),
    minContribution: Math.min(...amounts),
    maxContribution: Math.max(...amounts),
    totalContributed: amounts.reduce((s, a) => s + a, 0),
    firstContributionDate: series.firstContributionDate,
    latestContributionDate: series.latestContributionDate,
  };

  const periodDays = nominalPeriodDays(series.cadence);
  if (periodDays === null) {
    // Still report the descriptive amount statistics; period-based
    // consistency is genuinely not defined without a cadence, and is
    // reported unavailable rather than invented.
    return {
      status: 'ok',
      ...stats,
      gaps: [],
      reason: 'NON_PERIODIC_CADENCE',
      detail: 'This series does not follow a regular interval, so an expected-versus-observed period count is not meaningful and is not shown.',
      ...base,
    };
  }

  const spanDays = daysBetween(series.firstContributionDate, series.latestContributionDate);
  // Periods that should have occurred INCLUSIVE of the first one.
  const expectedPeriods = Math.max(1, Math.round(spanDays / periodDays) + 1);
  const observedPeriods = txns.length;
  const skippedPeriods = Math.max(0, expectedPeriods - observedPeriods);

  const gaps: SipGap[] = [];
  for (let i = 1; i < txns.length; i++) {
    const d = daysBetween(txns[i - 1].transactionDate, txns[i].transactionDate);
    const missed = d / periodDays - 1;
    if (missed >= GAP_MIN_MISSED_PERIODS - 1) {
      // A gap is an interval materially longer than one nominal period.
      if (d / periodDays >= GAP_MIN_MISSED_PERIODS) {
        gaps.push({ fromDate: txns[i - 1].transactionDate, toDate: txns[i].transactionDate, days: d, missedPeriods: Math.max(0, Math.round(missed)) });
      }
    }
  }

  return {
    status: 'ok',
    ...stats,
    expectedPeriods,
    observedPeriods,
    skippedPeriods,
    consistencyPct: expectedPeriods > 0 ? Math.min(1, observedPeriods / expectedPeriods) : undefined,
    gaps,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Paused / stopped classification
// ---------------------------------------------------------------------------

export type SipActivityStatus = 'EXPECTED' | 'LATE' | 'POSSIBLE_PAUSE' | 'LIKELY_STOPPED' | 'UNKNOWN';

export interface SipActivityResult {
  status: SipActivityStatus;
  /** Periods elapsed since the latest contribution, relative to the series cadence. */
  periodsSinceLatest?: number;
  daysSinceLatest?: number;
  /** Strictly observational wording, safe to render verbatim. */
  statement: string;
  thresholdConfigVersion: typeof SIP_THRESHOLD_CONFIG_VERSION;
  method: typeof SIP_CONSISTENCY_METHOD_VERSION;
}

/**
 * Classify whether a series looks active, late, paused, or likely stopped as
 * at `asOfDate`.
 *
 * Deliberate design (spec section 44): the classification is expressed in
 * MISSED PERIODS relative to the series' own cadence, so a quarterly SIP is
 * never judged against a monthly yardstick, and LIKELY_STOPPED requires more
 * than POSSIBLE_PAUSE_MAX_MISSED (= 3) periods — never one.
 */
export function classifySipActivity(series: SipSeries, asOfDate: string): SipActivityResult {
  const base = { thresholdConfigVersion: SIP_THRESHOLD_CONFIG_VERSION, method: SIP_CONSISTENCY_METHOD_VERSION } as const;
  const periodDays = nominalPeriodDays(series.cadence);
  const daysSinceLatest = daysBetween(series.latestContributionDate, asOfDate);

  if (periodDays === null) {
    return {
      status: 'UNKNOWN',
      daysSinceLatest,
      statement: `This series does not follow a regular interval, so no expected next-contribution date can be derived. The most recent recorded contribution was on ${series.latestContributionDate}.`,
      ...base,
    };
  }

  const periodsSinceLatest = daysSinceLatest / periodDays;
  let status: SipActivityStatus;
  let statement: string;

  if (periodsSinceLatest <= PAUSE_THRESHOLDS.EXPECTED_MAX_MISSED) {
    status = 'EXPECTED';
    statement = `The most recent recorded contribution was on ${series.latestContributionDate}, which is within the expected interval for this series.`;
  } else if (periodsSinceLatest <= PAUSE_THRESHOLDS.LATE_MAX_MISSED) {
    status = 'LATE';
    statement = `The most recent recorded contribution was on ${series.latestContributionDate}. No later contribution has been recorded yet as at ${asOfDate}.`;
  } else if (periodsSinceLatest <= PAUSE_THRESHOLDS.POSSIBLE_PAUSE_MAX_MISSED) {
    status = 'POSSIBLE_PAUSE';
    statement = `No contribution has been recorded for this series since ${series.latestContributionDate}, a gap of about ${Math.floor(periodsSinceLatest)} expected interval(s) as at ${asOfDate}. The records available do not indicate whether the mandate was paused or whether later data has simply not been imported.`;
  } else {
    status = 'LIKELY_STOPPED';
    statement = `No contribution has been recorded for this series since ${series.latestContributionDate}, a gap of about ${Math.floor(periodsSinceLatest)} expected intervals as at ${asOfDate}. Based on the imported records alone, no recent activity is present for this series.`;
  }

  return { status, periodsSinceLatest, daysSinceLatest, statement, ...base };
}

export const __sipConsistencyInternals = { daysBetween, median };
