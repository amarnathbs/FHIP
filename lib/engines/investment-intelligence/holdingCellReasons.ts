// Document2 (4) F3 / F11. A Holdings table cell that cannot show a figure must say WHICH prerequisite is missing, in a few words,
// not a bare dash. These are the short reasons printed under the dash; the long sentence stays in the cell's tooltip / the ledger.

export interface MissingReason {
  /** Few words, printed under the dash. */
  short: string;
  /** The whole sentence, for a tooltip. */
  long: string;
}

interface XirrLike {
  status: string;
  qualityFlag?: string;
  engineReason?: string;
  detail?: string;
}

/** Why the "Your return (XIRR)" cell is a dash. null when the figure is shown. */
export function xirrMissingReason(x: XirrLike): MissingReason | null {
  if (x.status === 'CALCULATED') return null;
  const long = x.detail ?? 'Your own return could not be worked out for this holding.';
  if (/unresolved data-quality|did not reconcile/i.test(long)) return { short: 'Statement does not agree with its transactions', long };
  if (x.engineReason === 'INSUFFICIENT_HISTORY' || x.qualityFlag === 'PARTIAL_TRANSACTION_HISTORY') {
    if (/opening balance|history begins|complete acquisition|point-in-time|snapshot|completeness/i.test(long)) return { short: 'Purchase history before the first statement is missing', long };
  }
  if (x.engineReason === 'NO_TERMINAL_VALUE') return { short: 'No holding value to measure against', long };
  if (x.engineReason === 'ALL_SAME_SIGN') return { short: 'Needs both a purchase and a current value', long };
  if (x.qualityFlag === 'PARTIAL_TRANSACTION_HISTORY') return { short: 'Purchase history is incomplete', long };
  return { short: 'Could not be worked out; see the ledger', long };
}

/** Why the units / value cells are dashes (no figure at all for the position). */
export function valueMissingReason(row: { dataQualityStatus: string; dataQualityDetail: string | null; unitBalance: number | null; marketValue: number | null; nav: number | null }): MissingReason | null {
  if (row.marketValue !== null && row.unitBalance !== null) return null;
  if (row.dataQualityStatus === 'unresolved') {
    return { short: 'Withheld: statement does not agree with its transactions', long: row.dataQualityDetail ?? 'This holding has an unresolved data-quality issue, so its units and value are not shown until it is resolved.' };
  }
  if (row.unitBalance === null) return { short: 'No statement with units on file', long: 'There is no statement showing the units held, so the value cannot be worked out. Upload a statement for this folio.' };
  if (row.nav === null) return { short: 'No published price on file', long: 'No usable published NAV exists for this fund on or before the valuation date, so the value cannot be worked out.' };
  return { short: 'Value could not be worked out', long: 'The value could not be worked out for this holding.' };
}
