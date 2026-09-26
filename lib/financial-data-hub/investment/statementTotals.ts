/**
 * FDH-11 -- statement-TOTALS reconciliation (canonical-upload WP-12, INV-G6 /
 * INV-G8). Pure.
 *
 * Before WP-12 `fdh_investment_statements.reconciliation_status` was never
 * computed: every statement sat at the column default 'insufficient_data', and
 * the panel's "Reconciliation" line said so for a statement that did add up.
 *
 * What a single statement can prove ON ITS OWN: the holdings it prints add up
 * to the portfolio total it prints. That is checked here, in exact minor units
 * (FDH's `domain/money.ts`), with no tolerance -- a $0.01 gap is a variance.
 * A total may or may not include the broker cash line, so both readings are
 * tried and either one reconciling is 'reconciled'.
 *
 * It answers 'insufficient_data' -- never 'reconciled' -- whenever the
 * statement does not print a total, or any holding has no market value: a sum
 * over rows with unknown values proves nothing (null is never 0).
 *
 * Opening-quantity + transactions = closing-quantity reconciliation
 * (`holdingsReconciliation.ts`) needs history across statements and is done by
 * Investment Intelligence's certification after Apply, not here.
 */

import { toMinorUnits } from '../domain/money';
import type { AuInvestmentReconciliationStatus } from './types';

export interface StatementTotalsInput {
  currencyCode: string;
  positionMarketValues: readonly (string | null | undefined)[];
  cashBalance?: string | null;
  closingPortfolioValue?: string | null;
}

export interface StatementTotalsResult {
  status: AuInvestmentReconciliationStatus;
  /** Sum of the holdings' market values, in minor units, when every one is known. */
  holdingsMinor: number | null;
  closingMinor: number | null;
}

export function reconcileAuStatementTotals(input: StatementTotalsInput): StatementTotalsResult {
  const closing = input.closingPortfolioValue == null || input.closingPortfolioValue === '' ? null : Number(input.closingPortfolioValue);
  if (closing === null || !Number.isFinite(closing) || input.positionMarketValues.length === 0) {
    return { status: 'insufficient_data', holdingsMinor: null, closingMinor: null };
  }
  let holdingsMinor = 0;
  for (const v of input.positionMarketValues) {
    if (v == null || v === '' || !Number.isFinite(Number(v))) return { status: 'insufficient_data', holdingsMinor: null, closingMinor: toMinorUnits(closing, input.currencyCode) };
    holdingsMinor += toMinorUnits(Number(v), input.currencyCode);
  }
  const closingMinor = toMinorUnits(closing, input.currencyCode);
  const cashMinor = input.cashBalance == null || input.cashBalance === '' ? null : toMinorUnits(Number(input.cashBalance), input.currencyCode);
  const reconciled = holdingsMinor === closingMinor || (cashMinor !== null && holdingsMinor + cashMinor === closingMinor);
  return { status: reconciled ? 'reconciled' : 'variance', holdingsMinor, closingMinor };
}
