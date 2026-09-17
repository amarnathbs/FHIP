// PC6 (M6) — reference-data quality rules.
//
// N.5: "stale detection; holiday/missing-date semantics; correction/amendment
//       provenance".
// N.11: "unusual jumps/outliers; NAV freshness; risk-free freshness".
//
// Everything here is PURE and deterministic: same inputs, same verdicts, no
// clock reads, no I/O. The caller supplies `asOfDate`, so a clock-skewed box
// cannot change a verdict, and a certification run can replay a past day
// exactly.
//
// NOT AN ANALYTICS ENGINE. These functions decide whether a reference SERIES
// is fit to be used; they never compute a return, a risk metric, or anything
// a user sees as performance. Those come from the already-certified R4/R5
// engines under lib/engines/investment-intelligence/ and are not reimplemented
// here (N.12).

export const PC6_QUALITY_RULES_VERSION = 'pc6-reference-quality-v1';

// ---------------------------------------------------------------------------
// Staleness (N.5, N.11)
// ---------------------------------------------------------------------------

export type FreshnessState = 'fresh' | 'stale' | 'never_ingested';

export interface FreshnessVerdict {
  state: FreshnessState;
  /** Calendar days between the latest as-of date and `asOfDate`. Null when never ingested. */
  ageDays: number | null;
  latestAsOf: string | null;
  thresholdDays: number;
  detail: string;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00.000Z`);
  const b = Date.parse(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`PC6: invalid ISO date in daysBetween('${fromIso}','${toIso}')`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Freshness of one series.
 *
 * DELIBERATELY JUDGED PER SERIES, NOT PER FILE. AMFI's NAVAll.txt is
 * republished every business day, but each row carries that SCHEME's own last
 * published NAV date. On 2026-09-15 the live file spanned 2008-10-02 to
 * 2026-09-14: a wound-up scheme's final NAV from 2008 sits in a file
 * downloaded today. Treating "the file is from today" as "every scheme is
 * fresh" would present an 18-year-old price as current. So freshness is
 * always computed from the SERIES' own latest as-of date.
 *
 * `never_ingested` is a distinct state from `stale`, because they need
 * different operator actions: one is a missing mapping, the other a broken or
 * ended feed. Neither is ever reported as a zero or an "ok".
 */
export function assessFreshness(latestAsOf: string | null, asOfDate: string, thresholdDays: number): FreshnessVerdict {
  if (!latestAsOf) {
    return {
      state: 'never_ingested',
      ageDays: null,
      latestAsOf: null,
      thresholdDays,
      detail: 'No observation has ever been ingested for this series.',
    };
  }
  const ageDays = daysBetween(latestAsOf, asOfDate);
  const stale = ageDays > thresholdDays;
  return {
    state: stale ? 'stale' : 'fresh',
    ageDays,
    latestAsOf,
    thresholdDays,
    detail: stale
      ? `Latest observation is ${latestAsOf}, ${ageDays} day(s) before the as-of date ${asOfDate}, beyond the ${thresholdDays}-day threshold.`
      : `Latest observation is ${latestAsOf}, ${ageDays} day(s) before the as-of date ${asOfDate}.`,
  };
}

// ---------------------------------------------------------------------------
// Missing-date / holiday semantics (N.5)
// ---------------------------------------------------------------------------

export type GapClassification = 'contiguous' | 'weekend_only' | 'short_gap' | 'long_gap';

export interface SeriesGap {
  previousDate: string;
  nextDate: string;
  missingCalendarDays: number;
  /** Calendar days in the gap that are not a Saturday or Sunday. */
  missingWeekdays: number;
  classification: GapClassification;
}

function isWeekend(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Classify the holes in a dated series.
 *
 * PC6 DOES NOT MAINTAIN AN INDIAN TRADING-HOLIDAY CALENDAR, and does not
 * pretend to. Neither AMFI nor any other source consulted for this phase
 * publishes one in a form PC6 ingests, so inventing one would be exactly the
 * kind of fabricated reference fact N.8 forbids for benchmarks. What PC6 does
 * instead is honest and sufficient for the operator surface:
 *
 *   * weekends are recognised arithmetically (no calendar needed);
 *   * any remaining weekday hole is reported as a GAP, not silently filled;
 *   * `long_gap` (more than one missing weekday in a row) is surfaced to the
 *     admin surface for a human to judge — a festival cluster like Diwali and
 *     a broken feed look the same from here, and PC6 says so rather than
 *     guessing which it is.
 *
 * NOTHING IS EVER INTERPOLATED. The consuming engines already use
 * last-observation-on-or-before semantics (benchmarkService.valueOnOrBefore,
 * sip/dateAlignment), so a hole degrades coverage honestly instead of
 * becoming a manufactured price.
 */
export function classifyGaps(sortedDates: string[]): SeriesGap[] {
  const gaps: SeriesGap[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = sortedDates[i - 1];
    const next = sortedDates[i];
    const span = daysBetween(prev, next);
    if (span <= 1) continue;
    let missingWeekdays = 0;
    for (let d = 1; d < span; d++) {
      const iso = new Date(Date.parse(`${prev}T00:00:00.000Z`) + d * 86_400_000).toISOString().slice(0, 10);
      if (!isWeekend(iso)) missingWeekdays++;
    }
    const classification: GapClassification =
      missingWeekdays === 0 ? 'weekend_only' : missingWeekdays === 1 ? 'short_gap' : 'long_gap';
    gaps.push({ previousDate: prev, nextDate: next, missingCalendarDays: span - 1, missingWeekdays, classification });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Outlier / unusual-jump detection (N.11)
// ---------------------------------------------------------------------------

/** Matches ii_prices_nav.quality_status' CHECK domain (migration 0043). */
export type NavQualityStatus = 'ok' | 'suspicious_jump' | 'stale' | 'superseded';

export interface JumpFinding {
  date: string;
  previousDate: string;
  previousValue: number;
  value: number;
  /** Fractional change, e.g. 0.42 for +42%. */
  changeRatio: number;
  /** Change per elapsed day, so a 5-day gap is not flagged like a 1-day move. */
  perDayRatio: number;
  reason: 'JUMP' | 'ZERO_TO_NONZERO' | 'NONZERO_TO_ZERO';
}

export interface JumpThresholds {
  /** Per-day fractional move beyond which a point is flagged. Default 0.20 (20%). */
  perDayThreshold: number;
  /** Absolute single-step move that is always flagged regardless of elapsed days. */
  absoluteThreshold: number;
}

export const DEFAULT_JUMP_THRESHOLDS: JumpThresholds = {
  perDayThreshold: 0.2,
  absoluteThreshold: 0.5,
};

/**
 * Flag implausible moves for OPERATOR REVIEW. This never deletes, corrects or
 * hides a value: a flagged point is stored with quality_status
 * 'suspicious_jump' and shown as such. PC6 has no authority to decide that a
 * published NAV is wrong — a real 40% move happens (segregated portfolios,
 * a fund that writes off a defaulted holding). The job is to make it visible,
 * not to silently reject it.
 *
 * Zero crossings get their own reasons because a ratio against zero is
 * undefined, and because 0.0000 is a REAL published value for wound-up
 * segregated portfolios (Franklin India schemes carry it in the live file).
 */
export function detectJumps(
  points: Array<{ date: string; value: number }>,
  thresholds: JumpThresholds = DEFAULT_JUMP_THRESHOLDS
): JumpFinding[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: JumpFinding[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const elapsed = Math.max(1, daysBetween(prev.date, cur.date));
    if (prev.value === 0 && cur.value > 0) {
      out.push({ date: cur.date, previousDate: prev.date, previousValue: prev.value, value: cur.value, changeRatio: Infinity, perDayRatio: Infinity, reason: 'ZERO_TO_NONZERO' });
      continue;
    }
    if (prev.value > 0 && cur.value === 0) {
      out.push({ date: cur.date, previousDate: prev.date, previousValue: prev.value, value: cur.value, changeRatio: -1, perDayRatio: -1 / elapsed, reason: 'NONZERO_TO_ZERO' });
      continue;
    }
    if (prev.value <= 0) continue;
    const changeRatio = cur.value / prev.value - 1;
    const perDayRatio = changeRatio / elapsed;
    if (Math.abs(perDayRatio) > thresholds.perDayThreshold || Math.abs(changeRatio) > thresholds.absoluteThreshold) {
      out.push({ date: cur.date, previousDate: prev.date, previousValue: prev.value, value: cur.value, changeRatio, perDayRatio, reason: 'JUMP' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Correction / amendment semantics (N.5, N.9, N.11)
// ---------------------------------------------------------------------------

export interface ExistingObservation {
  value: string;
  recordChecksum: string;
  quality_status: NavQualityStatus;
}

export interface IncomingObservation {
  value: string;
  recordChecksum: string;
}

export type UpsertAction =
  | { action: 'insert'; reason: 'NEW' }
  | { action: 'skip'; reason: 'UNCHANGED' }
  | { action: 'supersede'; reason: 'SOURCE_CORRECTION'; previousValue: string };

/**
 * Decide what a re-import should do with an observation that already exists.
 *
 * IDEMPOTENCY IS BY CONTENT, NOT BY PRESENCE (N.4/N.5 "make import
 * idempotent"). Re-running the same file changes nothing at all — not even a
 * row version — because the checksum matches and the action is `skip`.
 *
 * A DIFFERENT value for the same (scheme, date) is a SOURCE CORRECTION, and is
 * never an in-place overwrite: the prior row is marked 'superseded' and the
 * new value is inserted alongside it with a pointer back. The history of what
 * the source said, and when it changed its mind, is itself evidence (D.3
 * immutable source evidence) and is what the admin correction surface reads.
 */
export function decideUpsert(existing: ExistingObservation | null, incoming: IncomingObservation): UpsertAction {
  if (!existing) return { action: 'insert', reason: 'NEW' };
  if (existing.recordChecksum === incoming.recordChecksum) return { action: 'skip', reason: 'UNCHANGED' };
  return { action: 'supersede', reason: 'SOURCE_CORRECTION', previousValue: existing.value };
}

// ---------------------------------------------------------------------------
// D.7 — the boundary this whole phase exists to protect
// ---------------------------------------------------------------------------

export interface StatementFact {
  /** What the user's own statement printed. Immutable. */
  navOnStatement: string;
  statementDate: string;
}

export interface MarketFact {
  navFromPc6: string;
  marketAsOfDate: string;
  sourceKey: string;
}

export interface DualNavPresentation {
  statement: StatementFact;
  market: MarketFact | null;
  /** True when the two disagree. A disagreement is DISPLAYED, never resolved. */
  differs: boolean;
  /** Copy the UI must show so neither number is mistaken for the other (N.6). */
  asOfLabel: string;
}

/**
 * Build the side-by-side presentation of a statement NAV and a PC6 market NAV.
 *
 * THIS FUNCTION EXISTS TO MAKE D.7 UNBREAKABLE BY CONSTRUCTION. There is no
 * parameter here that could overwrite `statement`, and no code path that
 * returns a single merged NAV. A caller that wants "the NAV" must choose which
 * of the two it means, and must carry the as-of date that goes with it.
 *
 * D.7: "a statement's printed NAV/units/value are source facts; PC6 market
 * data may provide LATER valuation/comparison but must NEVER rewrite what a
 * statement said."
 */
export function presentDualNav(statement: StatementFact, market: MarketFact | null): DualNavPresentation {
  const differs = market !== null && market.navFromPc6 !== statement.navOnStatement;
  return {
    statement,
    market,
    differs,
    asOfLabel: market
      ? `Statement NAV ${statement.navOnStatement} as at ${statement.statementDate}; market NAV ${market.navFromPc6} as at ${market.marketAsOfDate} (source: ${market.sourceKey}).`
      : `Statement NAV ${statement.navOnStatement} as at ${statement.statementDate}. No external market NAV is available for this scheme.`,
  };
}
