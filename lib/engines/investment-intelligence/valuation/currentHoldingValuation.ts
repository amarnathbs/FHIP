// Investment Intelligence — Document2 Finding #5 ("Current NAV / holding
// value"), 2026-10-01. Pure function, no I/O.
//
// THE ONE PLACE that decides "what is this holding worth as at date D, using
// which NAV, dated when". Every Investment Intelligence consumer that shows a
// current holding value (Holdings table, X-Ray position values, Overview
// portfolio total, Performance's mark-to-market) calls this module rather
// than re-deriving the rule ad hoc, so two screens can never disagree about
// the same holding.
//
// THE RULES
// ---------
//   1. A holding's UNITS come from the latest certified statement snapshot.
//      In a POINT-IN-TIME view (pointInTime: true) only snapshots dated on or
//      before the valuation date D count, so a later statement can never leak
//      into an earlier view. In a CURRENT view (the default) the latest
//      snapshot always counts: "D" is just today's UTC date, and a statement
//      legitimately dated "today" in India/Australia can be a calendar day
//      ahead of UTC for part of the day — hiding it would blank a real
//      holding.
//   2. The NAV is the latest ELIGIBLE NAV observation dated on or before D.
//      Eligible = quality_status null/'ok' (never stale / suspicious_jump /
//      superseded), price a finite number > 0 (a zero or negative price is a
//      data fault, never a "value of zero"), dated no later than D (a
//      future-dated NAV can never influence an earlier valuation), and, when
//      both sides state a currency, in the holding's own currency (an INR NAV
//      is never multiplied into an AUD position).
//   3. If that NAV is strictly NEWER than the statement snapshot, the
//      holding is marked to market: value = units x NAV, NAV date = that
//      NAV's OWN date. The statement NAV is kept only as evidence
//      (statementNav / statementAsOfDate) and is flagged `statementSuperseded`.
//   4. Otherwise (no eligible NAV, or none newer than the statement) the
//      statement's own value is used, and is LABELLED as a statement value
//      (basis 'statement', navSource 'statement') — never presented as a
//      market NAV.
//   5. units == 0 (fully redeemed) values to exactly 0 with basis 'redeemed';
//      no NAV is consulted, so a missing/stale/future NAV cannot resurrect or
//      block it (units 0 x any price is 0 by construction).
//   6. Staleness is DISCLOSED, never hidden: when the valuation's own date is
//      more than NAV_STALE_AFTER_DAYS before D the result carries
//      `stale: true` and a plain-language note. The number itself is not
//      changed (no interpolation, no extrapolation).
//   7. No snapshot at all -> basis 'unavailable', marketValue null. Never a
//      fabricated zero.
//   8. UNITS TRANSACTED AFTER THE STATEMENT (multi-folio fix, 2026-10-01).
//      Callers may pass `unitMovements` (signed net unit changes of the
//      position's own non-reversed transactions). Movements dated STRICTLY
//      after the statement date and on or before the valuation date are added
//      to the statement's units: units = statement units + movements. The
//      enlarged unit count is priced at the latest eligible market NAV when
//      one is newer than the statement (rule 3), otherwise at the statement's
//      own NAV (basis stays 'statement', and the note says units were added).
//      A balance that nets to exactly 0 is 'redeemed' (rule 5). A balance that
//      would go NEGATIVE, or units that cannot be priced (statement held 0
//      units and no newer NAV exists), are NOT applied: the statement figures
//      stand and `unitsAfterStatementApplied` is false with a note. Movements
//      dated on the statement's own date are already inside the statement
//      figure and are never counted twice.
//
// A fund held in SEVERAL folios is valued folio by folio with this function
// and summed by valuation/schemeValuation.ts; this module itself always values
// ONE position (one folio).
//
// This module deliberately does NOT touch XIRR/TWRR/R4/R5/R6 arithmetic; it
// only selects the valuation INPUT those figures are computed from.

import { formatDateInText } from '@/lib/engines/date';

/** A valuation whose date is more than this many days before the valuation
 *  date is disclosed as stale. Mutual fund NAVs publish every business day;
 *  7 calendar days spans a long weekend plus a holiday and still catches a
 *  genuinely missed feed. Disclosure only — never alters a value. */
export const NAV_STALE_AFTER_DAYS = 7;

export interface NavObservationRow {
  /** ISO yyyy-mm-dd. */
  date: string;
  price: number;
  currencyCode?: string | null;
  /** ii_prices_nav.quality_status; null/undefined is treated as 'ok'. */
  qualityStatus?: string | null;
}

export interface StatementPositionInput {
  /** ISO yyyy-mm-dd — the statement's as_of_date. */
  asOfDate: string;
  units: number;
  value: number;
  currencyCode?: string | null;
}

export interface UnitMovementInput {
  /** ISO yyyy-mm-dd transaction date. */
  date: string;
  /** Signed net change in units (purchase +, redemption -), already direction-resolved by the caller. */
  unitDelta: number;
}

export type NavIneligibleReason = 'future_dated' | 'quality_not_ok' | 'currency_mismatch' | 'invalid_price';

export interface NavSelection {
  nav: NavObservationRow | null;
  excluded: Record<NavIneligibleReason, number>;
}

export type ValuationBasis = 'market_nav' | 'statement' | 'redeemed' | 'unavailable';

export interface HoldingValuation {
  basis: ValuationBasis;
  units: number | null;
  /** The value to display as the holding's current value. null = unavailable. */
  marketValue: number | null;
  /** The NAV that produced marketValue (market NAV, or the statement-implied NAV for basis 'statement'). */
  nav: number | null;
  /** That NAV's OWN date — never the date of a different source. */
  navDate: string | null;
  /** 'market' = ii_prices_nav; 'statement' = implied by the statement's own value; null = none. */
  navSource: 'market' | 'statement' | null;
  /** The date the value is "as at" (navDate, or the statement date for redeemed holdings). */
  valuationDate: string | null;
  currencyCode: string | null;
  /** Statement evidence, retained even when a newer market NAV supersedes it. */
  statementAsOfDate: string | null;
  statementValue: number | null;
  statementNav: number | null;
  /** True when a newer eligible market NAV replaced the statement NAV as the current NAV. */
  statementSuperseded: boolean;
  ageDays: number | null;
  stale: boolean;
  excludedNavCounts: Record<NavIneligibleReason, number>;
  /** The statement's own unit count (before any later movements). null when unavailable. */
  statementUnits: number | null;
  /** Net units transacted strictly after the statement date and on or before the valuation date (0 when none / not supplied). */
  unitsAfterStatement: number;
  /** True when those units are included in `units` / `marketValue`. */
  unitsAfterStatementApplied: boolean;
  /** Plain-language label suitable for a tooltip / footnote. */
  note: string;
}

function emptyExcluded(): Record<NavIneligibleReason, number> {
  return { future_dated: 0, quality_not_ok: 0, currency_mismatch: 0, invalid_price: 0 };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Net units moved strictly after `statementDate` and on or before `asOf`. */
function movementsAfterStatement(
  movements: readonly UnitMovementInput[] | undefined,
  statementDate: string,
  asOf: string
): { sum: number; count: number; lastDate: string | null } {
  let sum = 0;
  let count = 0;
  let lastDate: string | null = null;
  for (const m of movements ?? []) {
    const d = m.date.slice(0, 10);
    if (d <= statementDate || d > asOf) continue;
    if (!Number.isFinite(m.unitDelta)) continue;
    sum += m.unitDelta;
    count += 1;
    if (lastDate === null || d > lastDate) lastDate = d;
  }
  return { sum: round6(sum), count, lastDate };
}

function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) / 86_400_000);
}

export function isNavQualityEligible(qualityStatus: string | null | undefined): boolean {
  return qualityStatus === null || qualityStatus === undefined || qualityStatus === 'ok';
}

/**
 * Latest eligible NAV at or before `asOfDate`. On a same-date tie the LATER
 * element of the input wins (callers order by price_date then id, so that is
 * the most recently written row). Returns null when nothing is eligible.
 */
export function selectLatestEligibleNav(
  rows: readonly NavObservationRow[],
  opts: { asOfDate: string; currencyCode?: string | null }
): NavSelection {
  const excluded = emptyExcluded();
  let best: NavObservationRow | null = null;
  const asOf = opts.asOfDate.slice(0, 10);
  const wantCurrency = opts.currencyCode ? opts.currencyCode.toUpperCase() : null;
  for (const row of rows) {
    const date = row.date.slice(0, 10);
    if (date > asOf) {
      excluded.future_dated += 1;
      continue;
    }
    if (!isNavQualityEligible(row.qualityStatus)) {
      excluded.quality_not_ok += 1;
      continue;
    }
    if (!Number.isFinite(row.price) || row.price <= 0) {
      excluded.invalid_price += 1;
      continue;
    }
    if (wantCurrency && row.currencyCode && row.currencyCode.toUpperCase() !== wantCurrency) {
      excluded.currency_mismatch += 1;
      continue;
    }
    if (best === null || date >= best.date.slice(0, 10)) best = { ...row, date };
  }
  return { nav: best, excluded };
}

/**
 * Latest statement snapshot dated on or before `asOfDate`. Ties on date keep
 * the later element of the input (callers order by as_of_date then id).
 */
export function selectStatementAsOf(
  statements: readonly StatementPositionInput[],
  asOfDate: string,
  pointInTime = true
): StatementPositionInput | null {
  const asOf = asOfDate.slice(0, 10);
  let best: StatementPositionInput | null = null;
  for (const s of statements) {
    const d = s.asOfDate.slice(0, 10);
    if (pointInTime && d > asOf) continue;
    if (best === null || d >= best.asOfDate.slice(0, 10)) best = { ...s, asOfDate: d };
  }
  return best;
}

export function valueHoldingAsOf(input: {
  statements: readonly StatementPositionInput[];
  navs: readonly NavObservationRow[];
  /** ISO yyyy-mm-dd valuation date ("today" for a current view, the point-in-time date otherwise). */
  asOfDate: string;
  /** Fallback currency when the statement does not carry one. */
  currencyCode?: string | null;
  /** true = a historical view: statements dated after asOfDate are ignored. Default false (current view). */
  pointInTime?: boolean;
  /** Rule 8: this position's own unit movements (any dates; only those after the statement are used). */
  unitMovements?: readonly UnitMovementInput[];
}): HoldingValuation {
  const asOf = input.asOfDate.slice(0, 10);
  const statement = selectStatementAsOf(input.statements, asOf, input.pointInTime === true);

  if (!statement) {
    return {
      basis: 'unavailable',
      units: null,
      marketValue: null,
      nav: null,
      navDate: null,
      navSource: null,
      valuationDate: null,
      currencyCode: input.currencyCode ?? null,
      statementAsOfDate: null,
      statementValue: null,
      statementNav: null,
      statementSuperseded: false,
      ageDays: null,
      stale: false,
      excludedNavCounts: emptyExcluded(),
      statementUnits: null,
      unitsAfterStatement: 0,
      unitsAfterStatementApplied: false,
      note: input.pointInTime
        ? `No certified statement valuation exists on or before ${formatDateInText(asOf, input.currencyCode)}, so no value is shown.`
        : 'No certified statement valuation exists for this holding, so no value is shown.',
    };
  }

  const currencyCode = statement.currencyCode ?? input.currencyCode ?? null;
  // Dates in the notes below are day-first (dd-mm-yyyy INR / dd/mm/yyyy otherwise), never ISO year-first.
  const dt = (iso: string | null | undefined) => formatDateInText(iso, currencyCode);
  const statementUnits = Number(statement.units);
  const statementValue = Number(statement.value);
  const statementNav = statementUnits > 0 ? statementValue / statementUnits : null;

  // Rule 8 - units transacted after the statement. Nothing here changes a
  // position with no later movements (the overwhelmingly common case): `units`
  // stays the statement's own count and every figure below is byte-identical
  // to the pre-rule-8 behaviour.
  const mv = movementsAfterStatement(input.unitMovements, statement.asOfDate, asOf);
  let units = statementUnits;
  let applied = false;
  let movementNote = '';
  const fmtUnits = (n: number) => String(Math.round(Math.abs(n) * 10_000) / 10_000);
  if (mv.count > 0 && mv.sum !== 0) {
    const total = round6(statementUnits + mv.sum);
    if (total < 0) {
      movementNote = ` ${fmtUnits(mv.sum)} units transacted after the statement net to a negative balance, so they were not applied.`;
    } else {
      units = total;
      applied = true;
    }
  }

  const evidence = {
    statementAsOfDate: statement.asOfDate,
    statementValue,
    statementNav,
    currencyCode,
    statementUnits,
    unitsAfterStatement: mv.sum,
  };

  const { nav: latestNav, excluded } = selectLatestEligibleNav(input.navs, { asOfDate: asOf, currencyCode });
  const newerNav = latestNav && latestNav.date > statement.asOfDate ? latestNav : null;

  // Units after the statement that cannot be priced: statement held 0 units
  // (no statement NAV to reuse) and no newer market NAV exists.
  if (applied && !newerNav && statementNav === null && units > 0) {
    applied = false;
    units = statementUnits;
    movementNote = ` ${fmtUnits(mv.sum)} units transacted after the statement could not be priced (no market NAV newer than the statement), so they are not included.`;
  }
  const appliedNote = applied
    ? ` Includes ${mv.sum >= 0 ? '+' : '-'}${fmtUnits(mv.sum)} units transacted after the statement date (${mv.count} transaction${mv.count === 1 ? '' : 's'}, latest ${dt(mv.lastDate)}).`
    : movementNote;

  // Rule 5 - fully redeemed: exactly 0, no NAV consulted.
  if (units === 0) {
    return {
      basis: 'redeemed',
      ...evidence,
      units,
      unitsAfterStatementApplied: applied,
      marketValue: 0,
      nav: null,
      navDate: null,
      navSource: null,
      valuationDate: applied && mv.lastDate ? mv.lastDate : statement.asOfDate,
      statementSuperseded: false,
      ageDays: null,
      stale: false,
      excludedNavCounts: emptyExcluded(),
      note: applied
        ? `Fully redeemed: the statement dated ${dt(statement.asOfDate)} held ${fmtUnits(statementUnits)} units and later transactions (latest ${dt(mv.lastDate)}) redeemed them all. The value is 0.`
        : `Fully redeemed as at ${dt(statement.asOfDate)} (0 units). No NAV is needed; the value is 0.${appliedNote}`,
    };
  }

  // Rule 3 - a strictly newer eligible market NAV supersedes the statement NAV.
  if (newerNav) {
    const ageDays = Math.max(0, dayNumber(asOf) - dayNumber(newerNav.date));
    const stale = ageDays > NAV_STALE_AFTER_DAYS;
    return {
      basis: 'market_nav',
      ...evidence,
      units,
      unitsAfterStatementApplied: applied,
      marketValue: units * newerNav.price,
      nav: newerNav.price,
      navDate: newerNav.date,
      navSource: 'market',
      valuationDate: newerNav.date,
      statementSuperseded: true,
      ageDays,
      stale,
      excludedNavCounts: excluded,
      note:
        (stale
          ? `Latest NAV on file is dated ${dt(newerNav.date)}, ${ageDays} days before ${dt(asOf)}; it may be out of date. The statement dated ${dt(statement.asOfDate)} is superseded.`
          : `Valued at the latest NAV, dated ${dt(newerNav.date)}. The statement dated ${dt(statement.asOfDate)} is superseded as the current NAV.`) + appliedNote,
    };
  }

  // Rule 4 - statement value, labelled as such. With rule-8 units the value is
  // (statement units + later movements) x the statement's own NAV; the basis
  // stays 'statement' because no market NAV newer than it exists.
  const ageDays = Math.max(0, dayNumber(asOf) - dayNumber(statement.asOfDate));
  const stale = ageDays > NAV_STALE_AFTER_DAYS;
  return {
    basis: 'statement',
    ...evidence,
    units,
    unitsAfterStatementApplied: applied,
    marketValue: applied ? units * (statementNav as number) : statementValue,
    nav: statementNav,
    navDate: statement.asOfDate,
    navSource: 'statement',
    valuationDate: statement.asOfDate,
    statementSuperseded: false,
    ageDays,
    stale,
    excludedNavCounts: excluded,
    note:
      (stale
        ? `Value and NAV come from your statement dated ${dt(statement.asOfDate)} (${ageDays} days before ${dt(asOf)}); no newer market NAV is on file, so this may be out of date.`
        : `Value and NAV come from your statement dated ${dt(statement.asOfDate)}; no newer market NAV is on file.`) + appliedNote,
  };
}
