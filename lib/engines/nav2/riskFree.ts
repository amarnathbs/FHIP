// NAV2 -- the governed RISK-FREE dataset CONTRACT and its use (PO decision
// 2026-10-03: RBI 91-day Treasury bill cut-off yield as the PRIMARY series, the
// RBI policy repo rate as the SECONDARY; config in lib/config/nav2/
// riskFreeSeriesConfig.ts).
//
// The engine never fetches, chooses or assumes a rate. It takes ONE dataset as an
// input (storage, the admin upload and the weekly refresh job are Stage 2). With no
// dataset, or a disabled one, or one that does not cover the window, Sharpe / Sortino
// / alpha answer the typed state `risk_free_missing` with NO number. A rate of zero is
// never assumed.
//
// THE DATASET (every field is part of the provenance of every ratio built on it):
//   series id and name, source ("Reserve Bank of India"), attribution text, cadence,
//   dataset version, retrieval date, terms review status ('po_accepted_2026-10-03'),
//   an `enabled` switch, the staleness constant, the verified-through date, and the
//   observations: observation date (auction / policy-effective date), annualised yield
//   in PERCENT as published, the source document, the source URL, the retrieval date,
//   notes and (for an automated read) the extraction provenance. An observation may be
//   a GAP row (an auction with no accepted bids): it records that no value exists, and
//   it never carries one.
//
// STEP-FUNCTION SEMANTICS (both series). For a given date the rate is the LATEST value
// observation dated on or before it:
//   * never a future observation (one dated after the date is invisible);
//   * never interpolated (a mid-week date carries the earlier auction's yield exactly);
//   * never stale:
//       - weekly_auction : the observation is at most `maxStalenessDays` older than the
//                          date (21 for the weekly T-bill);
//       - policy_change  : the series records CHANGES only, so the age of the last change
//                          is irrelevant; the date must be no later than the dataset's
//                          `verifiedThroughDate` plus `maxStalenessDays` (90 for the repo
//                          rate), and a series that was never verified has no rate.
//     A date outside that has NO rate and the whole ratio is withheld rather than part-filled.
// For a return interval the lookup date is the interval's START date (the rate known
// when the period began; no look-ahead).
//
// CONVERSION (spec 8.8: "converted to the same frequency", "compounding convention
// aligned"). The annualised yield y (percent) becomes the periodic risk-free return
//
//     rf_periodic = (1 + y / 100) ^ (1 / N) - 1,   N = 252 daily, 52 weekly, 12 monthly,
//
// the SAME N the volatility, Sharpe and Sortino use to annualise.

import { resolveObservationAsOf } from '@/lib/engines/investment-intelligence/sip/dateAlignment';
import { NAV2_RISK_FREE_CONFIG, type RiskFreeCadence, type RiskFreeConfig, type RiskFreeTermsStatus } from '@/lib/config/nav2/riskFreeSeriesConfig';
import type { Nav2MetricId, ReturnFrequency } from '@/lib/config/nav2/metricPolicy';
import { addDaysIso, daysBetweenIso, isValidIsoDate } from './dates';
import type { ReturnPoint } from './series';
import {
  makeProvenance,
  showDate,
  unavailable,
  type Disclosure,
  type Nav2Context,
  type Nav2Unavailable,
  type ProvenanceExtras,
  type RiskFreeProvenance,
} from './types';

export type { RiskFreeCadence, RiskFreeTermsStatus };

/** How an observation entered the dataset. */
export type RiskFreeEntryKind = 'first_load_csv' | 'admin_upload' | 'weekly_refresh_job';

/** Evidence recorded for an automated read (Stage 2 refresh job). Absent for a manual / CSV row. */
export interface RiskFreeExtractionProvenance {
  /** e.g. "2026-2027/1218". */
  pressReleaseNumber: string | null;
  method: 'parser' | 'ai' | 'parser+ai' | 'manual';
  /** Parser / extraction schema version. */
  version: string;
  /** Names of the publication checks that passed (price recompute, plausibility band, NSDP cross-check, auction date). */
  checksPassed: string[];
}

export interface RiskFreeObservation {
  /** Auction date (T-bill) or the date a policy decision took effect (repo). The value is in force from this date. ISO. */
  observationDate: string;
  /** Annualised yield, in PERCENT as published (5.5199 means 5.5199% a year). null ONLY for a gap row. */
  yieldPercent: number | null;
  /** 'gap' = an auction with no accepted bids / none held: recorded so the week is explained, never a value. Default 'value'. */
  kind?: 'value' | 'gap';
  gapReason?: 'no_accepted_bids' | 'no_auction_held' | null;
  /** The publication the value was read from, e.g. an RBI press release number and title. Required. */
  sourceDocument: string;
  /** URL of that publication, when it has one. */
  sourceUrl: string | null;
  /** When this value was retrieved. ISO. */
  retrievedOn: string;
  notes?: string | null;
  entryKind?: RiskFreeEntryKind;
  extraction?: RiskFreeExtractionProvenance | null;
}

export interface RiskFreeDataset {
  seriesId: string;
  seriesName: string;
  source: string;
  /** e.g. "Source: Reserve Bank of India". Printed with every figure built on the series. */
  attributionText: string;
  cadence: RiskFreeCadence;
  datasetVersion: string;
  retrievedOn: string;
  termsReviewStatus: RiskFreeTermsStatus;
  /** false = every risk-free-dependent ratio is `risk_free_missing` (series disabled). Nothing is deleted. */
  enabled: boolean;
  yieldBasis: 'annualised_percent_as_published';
  conversion: 'compound_per_period_1_over_n';
  observationSemantics: 'latest_on_or_before_never_future_never_interpolated';
  /** Named constant per series (see RISK_FREE_MAX_STALENESS_DAYS). */
  maxStalenessDays: number;
  /**
   * policy_change series only: the date the series was last confirmed complete (a monetary-policy statement, or a
   * weekly NSDP check that found no change). Required for such a series to supply any rate. Ignored for weekly_auction.
   */
  verifiedThroughDate: string | null;
  observations: readonly RiskFreeObservation[];
}

/** null = no dataset is available. */
export type RiskFreeSupply = RiskFreeDataset | null;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RiskFreeIssue {
  observationDate: string | null;
  issue:
    | 'invalid_date'
    | 'future_dated'
    | 'invalid_yield'
    | 'missing_source_document'
    | 'conflicting_duplicate'
    | 'dataset_field_missing'
    | 'gap_row_carries_value'
    | 'gap_row_without_reason'
    | 'invalid_verified_through';
}

export interface CleanedRiskFreeDataset {
  /** VALUE observations only, ascending by date, one per date, only valid rows. */
  observations: RiskFreeObservation[];
  /** Valid GAP rows (no value), ascending. They explain a missing week; the lookup never uses them. */
  gaps: RiskFreeObservation[];
  issues: RiskFreeIssue[];
  /** False when a dataset-level field the contract requires is missing: the dataset is then not used. */
  usable: boolean;
}

/** A yield of 0 to 100 percent is accepted as a plausible annualised rate; anything else is a unit mistake (a decimal, a basis-point figure). */
export const RISK_FREE_MAX_YIELD_PERCENT = 100;

export function cleanRiskFreeDataset(ds: RiskFreeDataset): CleanedRiskFreeDataset {
  const issues: RiskFreeIssue[] = [];
  for (const f of ['seriesId', 'seriesName', 'source', 'attributionText', 'datasetVersion'] as const) {
    if (!ds[f] || String(ds[f]).trim() === '') issues.push({ observationDate: null, issue: 'dataset_field_missing' });
  }
  if (!isValidIsoDate(ds.retrievedOn)) issues.push({ observationDate: null, issue: 'dataset_field_missing' });
  if (ds.verifiedThroughDate !== null && !isValidIsoDate(ds.verifiedThroughDate)) issues.push({ observationDate: null, issue: 'invalid_verified_through' });

  const values = new Map<string, RiskFreeObservation[]>();
  const gapRows = new Map<string, RiskFreeObservation>();
  for (const o of ds.observations) {
    if (!isValidIsoDate(o.observationDate)) {
      issues.push({ observationDate: o.observationDate, issue: 'invalid_date' });
      continue;
    }
    // An observation cannot be dated after the day it was retrieved: that is a future-dated rate.
    if (o.observationDate > o.retrievedOn || o.observationDate > ds.retrievedOn) {
      issues.push({ observationDate: o.observationDate, issue: 'future_dated' });
      continue;
    }
    if (!o.sourceDocument || o.sourceDocument.trim() === '') {
      issues.push({ observationDate: o.observationDate, issue: 'missing_source_document' });
      continue;
    }
    if (o.kind === 'gap') {
      if (o.yieldPercent !== null) {
        issues.push({ observationDate: o.observationDate, issue: 'gap_row_carries_value' });
        continue;
      }
      if (!o.gapReason) {
        issues.push({ observationDate: o.observationDate, issue: 'gap_row_without_reason' });
        continue;
      }
      gapRows.set(o.observationDate, o);
      continue;
    }
    if (o.yieldPercent === null || !Number.isFinite(o.yieldPercent) || o.yieldPercent < 0 || o.yieldPercent > RISK_FREE_MAX_YIELD_PERCENT) {
      issues.push({ observationDate: o.observationDate, issue: 'invalid_yield' });
      continue;
    }
    const list = values.get(o.observationDate);
    if (list) list.push(o);
    else values.set(o.observationDate, [o]);
  }
  const observations: RiskFreeObservation[] = [];
  for (const date of [...values.keys()].sort()) {
    const list = values.get(date)!;
    if (new Set(list.map((o) => o.yieldPercent)).size === 1) observations.push(list[0]);
    else issues.push({ observationDate: date, issue: 'conflicting_duplicate' });
  }
  const gaps = [...gapRows.keys()].sort().map((d) => gapRows.get(d)!);
  return { observations, gaps, issues, usable: !issues.some((i) => i.issue === 'dataset_field_missing' || i.issue === 'invalid_verified_through') };
}

// ---------------------------------------------------------------------------
// Lookup and conversion
// ---------------------------------------------------------------------------

export interface RiskFreeLookupRule {
  cadence: RiskFreeCadence;
  maxStalenessDays: number;
  verifiedThroughDate: string | null;
}

export type RiskFreeLookup =
  | { ok: true; observation: RiskFreeObservation; ageDays: number }
  | { ok: false; reason: 'none_on_or_before' | 'stale' };

/**
 * The rate in force on `date`. Reuses the R5 on-or-before rule (resolveObservationAsOf), so there is one
 * implementation of "latest NAV / level / rate on or before a date, never a future one, never interpolated".
 */
export function riskFreeObservationOn(observations: readonly RiskFreeObservation[], date: string, rule: RiskFreeLookupRule): RiskFreeLookup {
  const series = observations.map((o) => ({ date: o.observationDate, value: o.yieldPercent as number }));
  const anyBefore = observations.some((o) => o.observationDate <= date);
  if (rule.cadence === 'policy_change') {
    // Changes only: the age of the last change is irrelevant; freshness is the verification date.
    if (!anyBefore) return { ok: false, reason: 'none_on_or_before' };
    if (rule.verifiedThroughDate === null || date > addDaysIso(rule.verifiedThroughDate, rule.maxStalenessDays)) return { ok: false, reason: 'stale' };
    const hit = resolveObservationAsOf(series, date, 366 * 100);
    const found = hit.status === 'ok' && hit.observation ? observations.find((o) => o.observationDate === hit.observation!.date) : undefined;
    return found ? { ok: true, observation: found, ageDays: hit.offsetDays ?? 0 } : { ok: false, reason: 'none_on_or_before' };
  }
  const hit = resolveObservationAsOf(series, date, rule.maxStalenessDays);
  if (hit.status === 'ok' && hit.observation) {
    return { ok: true, observation: observations.find((o) => o.observationDate === hit.observation!.date)!, ageDays: hit.offsetDays ?? 0 };
  }
  return { ok: false, reason: anyBefore ? 'stale' : 'none_on_or_before' };
}

/** rf_periodic = (1 + y/100)^(1/N) - 1 with N the periods per year of the return frequency (252 / 52 / 12). */
export function periodicRiskFreeReturn(yieldPercent: number, periodsPerYear: number): number {
  return Math.pow(1 + yieldPercent / 100, 1 / periodsPerYear) - 1;
}

/**
 * The dataset the calculation may use, from the config: the selected series, with the master switch and a
 * declined terms status honoured (either turns the dataset OFF without removing it). null = no dataset for
 * the selected series was supplied.
 */
export function selectRiskFreeSupply(datasets: readonly RiskFreeDataset[], config: RiskFreeConfig = NAV2_RISK_FREE_CONFIG): RiskFreeSupply {
  const ds = datasets.find((d) => d.seriesId === config.selectedSeriesId);
  if (!ds) return null;
  if (!config.enabled || config.termsReviewStatus === 'declined' || ds.termsReviewStatus === 'declined') return { ...ds, enabled: false };
  return ds;
}

// ---------------------------------------------------------------------------
// Freshness signal for the admin dashboard (a silently broken refresh must be visible)
// ---------------------------------------------------------------------------

export interface RiskFreeFreshness {
  seriesId: string;
  state: 'no_data' | 'fresh' | 'stale';
  basis: 'last_observation' | 'verification';
  lastObservationDate: string | null;
  verifiedThroughDate: string | null;
  /** Days since the date the freshness rule is measured from (last auction for the T-bill, verification for the repo rate). null when there is none. */
  daysSince: number | null;
  /** The named window; `stale` once `daysSince` exceeds it. */
  staleAfterDays: number;
}

/** Days since the last observation (weekly_auction) or the last verification (policy_change), against the series' named window. */
export function riskFreeFreshness(ds: RiskFreeDataset, todayIso: string): RiskFreeFreshness {
  const cleaned = cleanRiskFreeDataset(ds);
  const last = cleaned.observations.length ? cleaned.observations[cleaned.observations.length - 1].observationDate : null;
  const basis = ds.cadence === 'policy_change' ? 'verification' : 'last_observation';
  const from = basis === 'verification' ? ds.verifiedThroughDate : last;
  const daysSince = from === null ? null : daysBetweenIso(from, todayIso);
  const state = last === null || from === null ? 'no_data' : daysSince! > ds.maxStalenessDays ? 'stale' : 'fresh';
  return { seriesId: ds.seriesId, state, basis, lastObservationDate: last, verifiedThroughDate: ds.verifiedThroughDate, daysSince, staleAfterDays: ds.maxStalenessDays };
}

// ---------------------------------------------------------------------------
// Matching a return series to the dataset
// ---------------------------------------------------------------------------

export type RiskFreeMatch =
  | { ok: true; periodic: number[]; provenance: RiskFreeProvenance; disclosures: Disclosure[] }
  | { ok: false; result: Nav2Unavailable };

const trimPct = (n: number): string => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');

export function matchRiskFree(
  returns: readonly ReturnPoint[],
  supply: RiskFreeSupply,
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  extras: ProvenanceExtras,
  frequency: ReturnFrequency
): RiskFreeMatch {
  const miss = (reason: 'risk_free_dataset_not_configured' | 'risk_free_series_disabled' | 'risk_free_coverage_incomplete' | 'risk_free_stale', detail: string): RiskFreeMatch => ({
    ok: false,
    result: unavailable('risk_free_missing', reason, detail, makeProvenance(ctx, metricId, extras)),
  });
  if (supply === null) return miss('risk_free_dataset_not_configured', 'Risk-free rate data is unavailable, so this ratio is not shown. No rate has been assumed.');
  const cleaned = cleanRiskFreeDataset(supply);
  if (!cleaned.usable) return miss('risk_free_dataset_not_configured', 'Risk-free rate data is unavailable (the dataset is incomplete), so this ratio is not shown. No rate has been assumed.');
  if (!supply.enabled) return miss('risk_free_series_disabled', 'Risk-free rate data is switched off, so this ratio is not shown. No rate has been assumed.');

  const rule: RiskFreeLookupRule = { cadence: supply.cadence, maxStalenessDays: supply.maxStalenessDays, verifiedThroughDate: supply.verifiedThroughDate };
  const ppy = ctx.policy.periodsPerYear[frequency];
  const periodic: number[] = [];
  const used = new Map<string, RiskFreeObservation>();
  let first: RiskFreeObservation | null = null;
  let last: RiskFreeObservation | null = null;
  for (const r of returns) {
    const hit = riskFreeObservationOn(cleaned.observations, r.startDate, rule);
    if (!hit.ok) {
      return hit.reason === 'stale'
        ? miss('risk_free_stale', supply.cadence === 'policy_change'
            ? `The rate series was last confirmed up to ${showDate(ctx, supply.verifiedThroughDate)}, more than ${supply.maxStalenessDays} days before ${showDate(ctx, r.startDate)}, so this ratio is not shown. No rate has been carried forward or estimated.`
            : `The latest risk-free rate on file is more than ${supply.maxStalenessDays} days older than ${showDate(ctx, r.startDate)}, so this ratio is not shown. No rate has been carried forward or estimated.`)
        : miss('risk_free_coverage_incomplete', `Risk-free rate data does not reach back to ${showDate(ctx, r.startDate)}, so this ratio is not shown. No rate has been assumed for the missing part.`);
    }
    if (first === null) first = hit.observation;
    last = hit.observation;
    used.set(hit.observation.observationDate, hit.observation);
    periodic.push(periodicRiskFreeReturn(hit.observation.yieldPercent as number, ppy));
  }
  const usedList = [...used.values()].sort((a, b) => (a.observationDate < b.observationDate ? -1 : 1));
  const yields = usedList.map((o) => o.yieldPercent as number);
  const windowStart = returns.length ? returns[0].startDate : null;
  const windowEnd = returns.length ? returns[returns.length - 1].date : null;
  const what = supply.cadence === 'policy_change' ? 'decision' : 'auction';
  const disclosureText =
    `Risk-free rate: ${supply.seriesName}. ${trimPct(first!.yieldPercent as number)}% a year was in force at the start of the period (${what} of ${showDate(ctx, first!.observationDate)})` +
    `${used.size > 1 ? ` and ${trimPct(last!.yieldPercent as number)}% at its end (${what} of ${showDate(ctx, last!.observationDate)})` : ''}, ` +
    `taken as the latest published rate on or before each date, never interpolated, and converted to a ${frequency} rate as (1 + yield) ^ (1 / ${ppy}) - 1. ${supply.attributionText}.`;
  const provenance: RiskFreeProvenance = {
    seriesId: supply.seriesId,
    seriesName: supply.seriesName,
    source: supply.source,
    attributionText: supply.attributionText,
    cadence: supply.cadence,
    datasetVersion: supply.datasetVersion,
    retrievedOn: supply.retrievedOn,
    verifiedThroughDate: supply.verifiedThroughDate,
    termsReviewStatus: supply.termsReviewStatus,
    frequency,
    periodsPerYear: ppy,
    conversion: supply.conversion,
    maxStalenessDays: supply.maxStalenessDays,
    windowStart,
    windowEnd,
    observationFirstDate: usedList[0].observationDate,
    observationLastDate: usedList[usedList.length - 1].observationDate,
    distinctObservationCount: usedList.length,
    yieldPercentAtWindowStart: first!.yieldPercent,
    yieldPercentAtWindowEnd: last!.yieldPercent,
    minYieldPercent: Math.min(...yields),
    maxYieldPercent: Math.max(...yields),
    disclosureText,
  };
  const disclosures: Disclosure[] = [{ code: 'risk_free_series_used', detail: disclosureText }];
  if (supply.termsReviewStatus === 'pending_confirmation') {
    disclosures.push({ code: 'risk_free_terms_pending', detail: `${supply.attributionText}. The publisher's reuse terms are still being confirmed.` });
  }
  return { ok: true, periodic, provenance, disclosures };
}
