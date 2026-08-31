/**
 * FDH-11 — Australia HOLDINGS reconciliation (spec sections 47-50, 61-62,
 * 93, 103).
 *
 * Opening quantity + buys + transfers in + corporate actions - sells -
 * transfers out = Closing quantity. Uses `quantity.ts`'s exact bigint-scaled
 * arithmetic throughout — never a JS float comparison (spec section 49's
 * negative control: 120.0000 vs 120.0001 must report VARIANCE, not vanish
 * into rounding).
 *
 * This module NEVER decides to overwrite a canonical holding (spec sections
 * 59, 62, 103) — it only classifies the statement's closing quantity against
 * what the known transaction evidence explains, so the caller can present
 * "+20 explained by BUY" or "unexplained -> REVIEW_REQUIRED" (spec section
 * 61) and, separately, decide whether to import missing transactions.
 */

import { parseExactQuantity, quantityEquals, sumExactQuantities, scaledQuantityToString } from './quantity';
import type { AuInvestmentReconciliationStatus } from './types';

export interface HoldingsReconciliationTransactionInput {
  /** Signed contribution to quantity — positive for BUY/TRANSFER_IN/DRP/bonus/
   * split-in, negative for SELL/TRANSFER_OUT. Computed by the caller from
   * `transactionClassification.ts`'s treatment, never inferred here. */
  signedQuantity: string;
}

export interface HoldingsReconciliationInput {
  /** Known opening quantity, if any (from an earlier certified snapshot or
   * an explicit statement-disclosed opening balance). `null` means the
   * history is not known to start from zero — see `historyCompleteness`. */
  openingQuantityKnown: string | null;
  transactions: readonly HoldingsReconciliationTransactionInput[];
  statementClosingQuantity: string;
  /** Whether the transaction evidence available is believed to cover the
   * FULL period between the opening reference point and the statement's
   * closing date. When false, an unexplained difference is INSUFFICIENT_DATA
   * rather than VARIANCE (spec section 50: "do not force reconciliation
   * where source evidence is incomplete"). */
  historyComplete: boolean;
  /** Exact-match by default (spec section 49) — a caller may supply a
   * genuinely justified tolerance (e.g. a known unit-rounding convention),
   * never a blanket currency-style tolerance borrowed from money.ts. */
  toleranceScaled?: bigint;
}

export interface HoldingsReconciliationResult {
  status: AuInvestmentReconciliationStatus;
  derivedClosingQuantity: string | null;
  statementClosingQuantity: string;
  varianceQuantity: string | null;
  withinTolerance: boolean;
  error: string | null;
}

export function reconcileAuHoldings(input: HoldingsReconciliationInput): HoldingsReconciliationResult {
  const closingParsed = parseExactQuantity(input.statementClosingQuantity);
  if (!closingParsed.ok || closingParsed.scaled === null) {
    return {
      status: 'insufficient_data',
      derivedClosingQuantity: null,
      statementClosingQuantity: input.statementClosingQuantity,
      varianceQuantity: null,
      withinTolerance: false,
      error: closingParsed.error,
    };
  }

  if (input.openingQuantityKnown === null || !input.historyComplete) {
    return {
      status: 'insufficient_data',
      derivedClosingQuantity: null,
      statementClosingQuantity: input.statementClosingQuantity,
      varianceQuantity: null,
      withinTolerance: false,
      error: null,
    };
  }

  const openingParsed = parseExactQuantity(input.openingQuantityKnown);
  if (!openingParsed.ok || openingParsed.scaled === null) {
    return {
      status: 'insufficient_data',
      derivedClosingQuantity: null,
      statementClosingQuantity: input.statementClosingQuantity,
      varianceQuantity: null,
      withinTolerance: false,
      error: openingParsed.error,
    };
  }

  const txnScaled: bigint[] = [];
  for (const t of input.transactions) {
    const p = parseExactQuantity(t.signedQuantity);
    if (!p.ok || p.scaled === null) {
      return {
        status: 'insufficient_data',
        derivedClosingQuantity: null,
        statementClosingQuantity: input.statementClosingQuantity,
        varianceQuantity: null,
        withinTolerance: false,
        error: p.error,
      };
    }
    txnScaled.push(p.scaled);
  }

  const derivedClosingScaled = openingParsed.scaled + sumExactQuantities(txnScaled);
  const tolerance = input.toleranceScaled ?? BigInt(0);
  const withinTolerance = quantityEquals(derivedClosingScaled, closingParsed.scaled, tolerance);
  const varianceScaled = closingParsed.scaled - derivedClosingScaled;

  return {
    status: withinTolerance ? 'reconciled' : 'variance',
    derivedClosingQuantity: scaledQuantityToString(derivedClosingScaled),
    statementClosingQuantity: input.statementClosingQuantity,
    varianceQuantity: scaledQuantityToString(varianceScaled),
    withinTolerance,
    error: null,
  };
}
