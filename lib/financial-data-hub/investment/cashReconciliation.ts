/**
 * FDH-11 — Australia BROKER CASH reconciliation (spec sections 51-52, 96).
 *
 * Opening cash + deposits + sale settlements + dividends + interest -
 * purchases - withdrawals - fees = Closing cash, subject to source evidence.
 * Uses `lib/financial-data-hub/domain/money.ts`'s exact minor-unit arithmetic
 * (this IS money, unlike holdings — spec section 96).
 */

import { toMinorUnits, moneyEquals } from '../domain/money';
import type { AuInvestmentReconciliationStatus } from './types';

export interface CashReconciliationInput {
  currencyCode: string;
  openingCashKnown: string | null;
  deposits: readonly string[];
  saleSettlements: readonly string[];
  dividendsAndDistributions: readonly string[];
  interest: readonly string[];
  purchases: readonly string[];
  withdrawals: readonly string[];
  fees: readonly string[];
  statementClosingCash: string;
  historyComplete: boolean;
  /** Default zero — spec section 52's negative control ($0.01 variance must
   * be detected) requires exact comparison by default. */
  toleranceMinorUnits?: number;
}

export interface CashReconciliationResult {
  status: AuInvestmentReconciliationStatus;
  derivedClosingCash: number | null;
  statementClosingCash: number;
  varianceAmount: number | null;
  withinTolerance: boolean;
}

function sum(values: readonly string[], currencyCode: string): number {
  return values.reduce((acc, v) => acc + toMinorUnits(Number(v), currencyCode), 0);
}

export function reconcileAuBrokerCash(input: CashReconciliationInput): CashReconciliationResult {
  const statementClosing = Number(input.statementClosingCash);

  if (input.openingCashKnown === null || !input.historyComplete) {
    return {
      status: 'insufficient_data',
      derivedClosingCash: null,
      statementClosingCash: statementClosing,
      varianceAmount: null,
      withinTolerance: false,
    };
  }

  const openingMinor = toMinorUnits(Number(input.openingCashKnown), input.currencyCode);
  const inflowsMinor =
    sum(input.deposits, input.currencyCode) +
    sum(input.saleSettlements, input.currencyCode) +
    sum(input.dividendsAndDistributions, input.currencyCode) +
    sum(input.interest, input.currencyCode);
  const outflowsMinor =
    sum(input.purchases, input.currencyCode) +
    sum(input.withdrawals, input.currencyCode) +
    sum(input.fees, input.currencyCode);

  const derivedClosingMinor = openingMinor + inflowsMinor - outflowsMinor;
  const derivedClosing = derivedClosingMinor / 10 ** 2; // reporting only — comparison below stays in minor units
  const tolerance = input.toleranceMinorUnits ?? 0;
  const withinTolerance = moneyEquals(derivedClosing, statementClosing, input.currencyCode, tolerance);

  return {
    status: withinTolerance ? 'reconciled' : 'variance',
    derivedClosingCash: derivedClosing,
    statementClosingCash: statementClosing,
    varianceAmount: Number((statementClosing - derivedClosing).toFixed(4)),
    withinTolerance,
  };
}
