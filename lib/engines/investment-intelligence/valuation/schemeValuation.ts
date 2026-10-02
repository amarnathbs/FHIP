// Investment Intelligence - multi-folio fix (2026-10-01). Pure, no I/O.
//
// A mutual fund (one ii_instruments row) can be held in SEVERAL folios (several
// ii_accounts rows, e.g. two HDFC Flexi Cap folios). Holdings is a per-folio
// view and always was. Every SCHEME-level view (Performance scheme XIRR,
// X-Ray exposure, portfolio totals) must instead treat the fund as ONE holding
// whose value is the SUM of its folios.
//
// Before this module those consumers grouped statements by instrument only,
// then picked the single latest statement of any folio, so a second folio's
// units and value silently dropped out (or the earlier folio replaced the
// later one), while the transaction flows of BOTH folios were still counted.
//
// THE RULE
// --------
//   * Each folio is valued on its own, by the one shared rule
//     (currentHoldingValuation.ts: valueHoldingAsOf) from ITS OWN statements
//     and ITS OWN later unit movements. A folio is never valued from another
//     folio's statement.
//   * The scheme's units / value are the SUM over folios that have a valuation.
//   * A folio with no statement on or before a point-in-time date is
//     'unavailable' and contributes nothing (never a fabricated 0).
//   * Exposure is counted once: callers emit ONE position per scheme carrying
//     the summed value.
//
// This module only assembles the valuation INPUT. It performs no return,
// XIRR, TWRR or exposure arithmetic.

import {
  valueHoldingAsOf,
  type HoldingValuation,
  type NavIneligibleReason,
  type NavObservationRow,
  type StatementPositionInput,
  type UnitMovementInput,
  type ValuationBasis,
} from './currentHoldingValuation';

/** Used when a row carries no account id (a legacy fixture): all such rows form one folio. */
export const UNKNOWN_FOLIO_KEY = '';

export interface FolioValuationInput {
  /** The folio's ii_accounts.id (UNKNOWN_FOLIO_KEY when the source row carries none). */
  folioKey: string;
  /** This folio's own statements, ascending by date (a tie on date: the later element wins). */
  statements: readonly StatementPositionInput[];
  /** This folio's own unit movements (only those after its statement are used). */
  unitMovements?: readonly UnitMovementInput[];
}

export interface FolioValuation {
  folioKey: string;
  valuation: HoldingValuation;
}

export interface SchemeValuation {
  /**
   * 'unavailable' = no folio has a valuation; 'redeemed' = every valued folio is
   * fully redeemed; 'market_nav' = at least one live folio is marked to a market
   * NAV; otherwise 'statement'.
   */
  basis: ValuationBasis;
  folioCount: number;
  /** Folios that have a valuation (basis other than 'unavailable'). */
  valuedFolioCount: number;
  /** Valued folios still holding units. */
  liveFolioCount: number;
  /** Sum of folio units; null when no folio is valued. */
  units: number | null;
  /** Sum of folio values; null when no folio is valued. */
  marketValue: number | null;
  /** The latest valuation date among valued folios; null when none. */
  valuationDate: string | null;
  currencyCode: string | null;
  /** True when any LIVE folio rests on a stale NAV/statement. */
  stale: boolean;
  /** Net units transacted after the statements and included, summed over folios. */
  unitsAfterStatement: number;
  /** Worst-case NAV exclusion counts over folios (the same NAV rows are offered to every folio). */
  excludedNavCounts: Record<NavIneligibleReason, number>;
  folios: FolioValuation[];
  note: string;
}

const REASONS: NavIneligibleReason[] = ['future_dated', 'quality_not_ok', 'currency_mismatch', 'invalid_price'];

export function valueSchemeAcrossFolios(input: {
  folios: readonly FolioValuationInput[];
  navs: readonly NavObservationRow[];
  asOfDate: string;
  currencyCode?: string | null;
  pointInTime?: boolean;
}): SchemeValuation {
  const folios: FolioValuation[] = [...input.folios]
    .sort((a, b) => (a.folioKey < b.folioKey ? -1 : a.folioKey > b.folioKey ? 1 : 0))
    .map((f) => ({
      folioKey: f.folioKey,
      valuation: valueHoldingAsOf({
        statements: f.statements,
        navs: input.navs,
        asOfDate: input.asOfDate,
        currencyCode: input.currencyCode ?? null,
        pointInTime: input.pointInTime,
        unitMovements: f.unitMovements,
      }),
    }));

  const valued = folios.filter((f) => f.valuation.basis !== 'unavailable');
  const live = valued.filter((f) => f.valuation.basis !== 'redeemed');

  const excludedNavCounts = { future_dated: 0, quality_not_ok: 0, currency_mismatch: 0, invalid_price: 0 } as Record<NavIneligibleReason, number>;
  for (const f of folios) for (const r of REASONS) excludedNavCounts[r] = Math.max(excludedNavCounts[r], f.valuation.excludedNavCounts[r]);

  let basis: ValuationBasis = 'unavailable';
  if (valued.length > 0) {
    if (live.length === 0) basis = 'redeemed';
    else basis = live.some((f) => f.valuation.basis === 'market_nav') ? 'market_nav' : 'statement';
  }

  const sum = (pick: (v: HoldingValuation) => number | null): number | null => {
    let total: number | null = null;
    for (const f of valued) {
      const x = pick(f.valuation);
      if (x === null) continue;
      total = total === null ? x : total + x;
    }
    return total;
  };

  const dates = valued.map((f) => f.valuation.valuationDate).filter((d): d is string => !!d).sort();
  const currencyCode = valued.find((f) => f.valuation.currencyCode)?.valuation.currencyCode ?? input.currencyCode ?? null;
  const unitsAfterStatement = valued.reduce((acc, f) => acc + (f.valuation.unitsAfterStatementApplied ? f.valuation.unitsAfterStatement : 0), 0);

  const note =
    folios.length <= 1
      ? (folios[0]?.valuation.note ?? 'No folio is held.')
      : `Held in ${folios.length} folios; value is the sum of each folio's own valuation (${valued.length} valued, ${live.length} still holding units).`;

  return {
    basis,
    folioCount: folios.length,
    valuedFolioCount: valued.length,
    liveFolioCount: live.length,
    units: sum((v) => v.units),
    marketValue: sum((v) => v.marketValue),
    valuationDate: dates.length ? dates[dates.length - 1] : null,
    currencyCode,
    stale: live.some((f) => f.valuation.stale),
    unitsAfterStatement,
    excludedNavCounts,
    folios,
    note,
  };
}

/**
 * Dated market value of a scheme across its folios, for weights / drawdown /
 * portfolio valuation series. One point per distinct statement date of ANY
 * folio; the value at a date is the sum, over folios, of each folio's latest
 * statement value on or before that date (a folio with no statement yet
 * contributes nothing). With a single folio this is exactly that folio's own
 * points, unchanged.
 */
export function aggregateFolioValuationPoints(
  folios: ReadonlyArray<{ points: ReadonlyArray<{ date: string; value: number }> }>
): Array<{ date: string; value: number }> {
  const nonEmpty = folios.filter((f) => f.points.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0].points.map((p) => ({ date: p.date, value: p.value }));
  const dates = [...new Set(nonEmpty.flatMap((f) => f.points.map((p) => p.date.slice(0, 10))))].sort();
  return dates.map((d) => {
    let total = 0;
    for (const f of nonEmpty) {
      let last: number | null = null;
      for (const p of f.points) {
        if (p.date.slice(0, 10) <= d) last = p.value;
        else break;
      }
      if (last !== null) total += last;
    }
    return { date: d, value: total };
  });
}
