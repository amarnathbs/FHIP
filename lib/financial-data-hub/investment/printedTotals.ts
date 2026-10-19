/**
 * Australian investment statements, PDF route: the portfolio total and cash balance a statement PRINTS, found in the document's own
 * text by label, with no model involved.
 *
 * WHY. The AI reading of a holdings statement deliberately does not ask the model for totals (a total derived from the very rows
 * being written is not independent evidence). Without a printed total the existing `reconcileAuStatementTotals` can only say
 * "insufficient data" for an AI-read statement, so the "holdings add up to the total" rule could never be checked for exactly the
 * statements that needed a model. The total is therefore taken from the TEXT, by a strict label match, and kept with the saved
 * draft on the server. It is never read from the model and never accepted from the browser: confirm takes it from the draft the
 * server issued. Anything ambiguous (two different totals, a total that is not alone on its line) is not used at all.
 */

import { minorToDecimalString, parseMoney, toLines } from '../pdf-statements';

export interface PrintedPortfolioTotals {
  closingPortfolioValue: string | null;
  cashBalance: string | null;
}

const TOTAL_RE = /^(?:total portfolio value|portfolio total|total value|total)\s*:?\s*(.+)$/i;
const CASH_RE = /^(?:cash(?: account)?(?: balance)?|cash holding)\s*:?\s*(.+)$/i;

function single(values: Set<number>): string | null {
  return values.size === 1 ? minorToDecimalString([...values][0]) : null;
}

export function findPrintedPortfolioTotals(documentText: string): PrintedPortfolioTotals {
  const totals = new Set<number>();
  const cash = new Set<number>();
  for (const line of toLines([documentText])) {
    const t = line.text.match(TOTAL_RE);
    if (t) {
      const m = parseMoney(t[1], { requireDecimals: true });
      if (m && m.minor >= 0) totals.add(m.minor);
      continue;
    }
    const c = line.text.match(CASH_RE);
    if (c) {
      const m = parseMoney(c[1], { requireDecimals: true });
      if (m && m.minor >= 0) cash.add(m.minor);
    }
  }
  return { closingPortfolioValue: single(totals), cashBalance: single(cash) };
}
