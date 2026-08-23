// Investment Intelligence R5 — THE single, centralised, deterministic
// date-alignment rule for mapping a cash-flow date onto an observation
// series (benchmark index levels or scheme NAVs).
//
// Spec section 34 requires ONE documented rule used consistently everywhere,
// rather than letting each component invent its own. Every R5 component that
// needs "what was the index/NAV on this contribution date?" MUST call
// resolveObservationOnOrAfter()/resolveObservationAsOf() from this module.
// Nothing in R5 is permitted to index a series directly.
//
// THE RULE (SIP_DATE_ALIGNMENT_VERSION = 'next-available-on-or-after-v1'):
//
//   For a CONTRIBUTION date d (money going in), use the first observation
//   on or after d, within MAX_FORWARD_SEARCH_DAYS. Rationale: a contribution
//   instructed on a non-trading day is actually executed at the next
//   available trading day's price. Searching FORWARD is the economically
//   correct direction for an execution price, and it can never "see the
//   future" beyond a few days of market closure.
//
//   For a VALUATION date d (marking a position to market, e.g. the analysis
//   end date), use the last observation on or BEFORE d, within
//   MAX_BACKWARD_SEARCH_DAYS. Rationale: you cannot value a portfolio at a
//   price that has not been published yet. Searching backward is the only
//   direction that avoids look-ahead bias.
//
//   If no observation exists within the search window, the result is
//   UNAVAILABLE — never the nearest-at-any-distance, and never interpolated.
//   R5 does not fabricate index levels (a FAIL condition).
//
// The two directions are deliberately DIFFERENT because they answer
// different economic questions. Using one rule for both would either
// value a portfolio at an unpublished future price or execute a purchase at
// a stale past price.

export const SIP_DATE_ALIGNMENT_VERSION = 'next-available-on-or-after-v1';

/** A contribution instructed on a Friday before a long weekend must still
 *  find Monday/Tuesday. Ten calendar days comfortably covers the longest
 *  Indian market closure runs without ever spanning a whole month. */
export const MAX_FORWARD_SEARCH_DAYS = 10;

/** A valuation date falling on a weekend/holiday must still find the last
 *  published level. Same window, backward. */
export const MAX_BACKWARD_SEARCH_DAYS = 10;

export interface Observation {
  /** ISO yyyy-mm-dd. Series are keyed by calendar date, never by index position. */
  date: string;
  value: number;
}

export type AlignmentReason = 'NO_OBSERVATION_IN_WINDOW' | 'EMPTY_SERIES' | 'INVALID_DATE';

export interface AlignmentResult {
  status: 'ok' | 'unavailable';
  /** The observation actually used. */
  observation?: Observation;
  /** Calendar days between the requested date and the observation used (>= 0). */
  offsetDays?: number;
  reason?: AlignmentReason;
  method: typeof SIP_DATE_ALIGNMENT_VERSION;
}

function toUtc(iso: string): number {
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  return t;
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.round((toUtc(bIso) - toUtc(aIso)) / 86_400_000);
}

/**
 * Sort a series ascending by date once, so callers can reuse it. Pure.
 */
export function sortSeries(series: Observation[]): Observation[] {
  return [...series].sort((a, b) => toUtc(a.date) - toUtc(b.date));
}

/**
 * CONTRIBUTION alignment: first observation on or after `date`.
 * Use for every SIP contribution, every simulation instalment, and every
 * synthetic benchmark unit purchase.
 */
export function resolveObservationOnOrAfter(sortedSeries: Observation[], date: string): AlignmentResult {
  if (!sortedSeries || sortedSeries.length === 0) {
    return { status: 'unavailable', reason: 'EMPTY_SERIES', method: SIP_DATE_ALIGNMENT_VERSION };
  }
  if (Number.isNaN(toUtc(date))) {
    return { status: 'unavailable', reason: 'INVALID_DATE', method: SIP_DATE_ALIGNMENT_VERSION };
  }
  for (const obs of sortedSeries) {
    const delta = daysBetween(date, obs.date);
    if (delta < 0) continue;
    if (delta > MAX_FORWARD_SEARCH_DAYS) break;
    return { status: 'ok', observation: obs, offsetDays: delta, method: SIP_DATE_ALIGNMENT_VERSION };
  }
  return { status: 'unavailable', reason: 'NO_OBSERVATION_IN_WINDOW', method: SIP_DATE_ALIGNMENT_VERSION };
}

/**
 * VALUATION alignment: last observation on or before `date`.
 * Use for terminal values, as-of-date marks, and any point-in-time
 * valuation. Never used for a contribution.
 */
export function resolveObservationAsOf(sortedSeries: Observation[], date: string): AlignmentResult {
  if (!sortedSeries || sortedSeries.length === 0) {
    return { status: 'unavailable', reason: 'EMPTY_SERIES', method: SIP_DATE_ALIGNMENT_VERSION };
  }
  if (Number.isNaN(toUtc(date))) {
    return { status: 'unavailable', reason: 'INVALID_DATE', method: SIP_DATE_ALIGNMENT_VERSION };
  }
  for (let i = sortedSeries.length - 1; i >= 0; i--) {
    const obs = sortedSeries[i];
    const delta = daysBetween(obs.date, date);
    if (delta < 0) continue;
    if (delta > MAX_BACKWARD_SEARCH_DAYS) break;
    return { status: 'ok', observation: obs, offsetDays: delta, method: SIP_DATE_ALIGNMENT_VERSION };
  }
  return { status: 'unavailable', reason: 'NO_OBSERVATION_IN_WINDOW', method: SIP_DATE_ALIGNMENT_VERSION };
}

export const __dateAlignmentInternals = { daysBetween, toUtc };
