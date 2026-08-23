// Investment Intelligence R2 — Portfolio Truth / reconciliation engine
// (spec sections 24, 25). Pure functions only — no I/O; the DB-backed
// orchestration that loads transactions/snapshots and writes
// ii_portfolio_truth_status lives in documentProcessing.ts.
//
// Core question (spec section 24): do reconstructed transactions and
// statement closing holdings agree sufficiently for the position to be
// trusted? Reconciled at ACCOUNT/FOLIO + INSTRUMENT granularity, exactly
// as spec requires:
//
//   opening_units + inflows - outflows +/- adjustments = closing_units
//
// compared against the statement's own printed closing balance, within
// the configured unit_tolerance (reconciliationConfig.ts).

import { absScaled, compareScaled, subScaled, ZERO } from './decimal';
import type { IiHistoryCompleteness, IiTransactionType } from './types';
import type { ReconciliationConfig } from './reconciliationConfig';

export type UnitDirection = 'inflow' | 'outflow' | 'cash_only' | 'passthrough';

// Deterministic direction table (spec section 19's taxonomy) — documented
// once, here, rather than re-decided ad hoc anywhere else in the codebase.
const DIRECTION_TABLE: Record<IiTransactionType, UnitDirection> = {
  purchase: 'inflow',
  sip: 'inflow',
  switch_in: 'inflow',
  stp_in: 'inflow',
  transfer_in: 'inflow',
  reinvestment: 'inflow',
  redemption: 'outflow',
  switch_out: 'outflow',
  stp_out: 'outflow',
  swp: 'outflow',
  transfer_out: 'outflow',
  dividend: 'cash_only', // a non-reinvested IDCW payout has no unit impact
  fee: 'cash_only',
  tax: 'cash_only',
  transfer: 'passthrough', // undirected legacy value — sign taken as parsed
  merger: 'passthrough',
  segregation: 'passthrough',
  adjustment: 'passthrough',
  reversal: 'passthrough', // MUST be pre-signed by the parser (a reversal of an inflow prints as a negative-units line, matching real RTA convention)
  unclassified: 'passthrough',
};

export interface ReconciliationTransactionInput {
  canonicalType: IiTransactionType;
  unitsScaled: bigint | null; // parser output — magnitude as printed for direction-known types, pre-signed for 'passthrough' types
}

/** Signed unit delta this single transaction contributes to the running balance. */
export function unitDeltaForTransaction(t: ReconciliationTransactionInput): bigint {
  if (t.unitsScaled === null) return ZERO;
  const direction = DIRECTION_TABLE[t.canonicalType];
  if (direction === 'cash_only') return ZERO;
  if (direction === 'inflow') return absScaled(t.unitsScaled);
  if (direction === 'outflow') return -absScaled(t.unitsScaled);
  return t.unitsScaled; // passthrough — already signed by the parser/source
}

export interface ReconcilePositionInput {
  openingUnitsScaled: bigint | null; // null = genuinely unknown (no opening balance available)
  transactions: ReconciliationTransactionInput[]; // ALL transactions between opening and the statement's as-of date, in any order
  statementClosingUnitsScaled: bigint; // as printed on the certified holding snapshot
  historyCompleteness: IiHistoryCompleteness;
  config: ReconciliationConfig;
}

export interface ReconcilePositionResult {
  reconciledOpeningUnitsScaled: bigint | null;
  reconciledClosingUnitsScaled: bigint | null; // null only when openingUnitsScaled is null AND historyCompleteness is not complete_from_inception (i.e. no valid baseline to sum from)
  statementClosingUnitsScaled: bigint;
  unitVarianceScaled: bigint | null; // reconciledClosingUnitsScaled - statementClosingUnitsScaled, null if reconciledClosingUnitsScaled is null
  withinTolerance: boolean | null; // null when variance cannot be computed
}

export function reconcilePosition(input: ReconcilePositionInput): ReconcilePositionResult {
  const canSumFromZero = input.historyCompleteness === 'complete_from_inception';
  const opening = input.openingUnitsScaled ?? (canSumFromZero ? ZERO : null);

  if (opening === null) {
    return {
      reconciledOpeningUnitsScaled: null,
      reconciledClosingUnitsScaled: null,
      statementClosingUnitsScaled: input.statementClosingUnitsScaled,
      unitVarianceScaled: null,
      withinTolerance: null,
    };
  }

  const delta = input.transactions.reduce((sum, t) => sum + unitDeltaForTransaction(t), ZERO);
  const reconciledClosing = opening + delta;
  const variance = subScaled(reconciledClosing, input.statementClosingUnitsScaled);
  const withinTolerance = compareScaled(absScaled(variance), input.config.unitToleranceScaled) <= 0;

  return {
    reconciledOpeningUnitsScaled: opening,
    reconciledClosingUnitsScaled: reconciledClosing,
    statementClosingUnitsScaled: input.statementClosingUnitsScaled,
    unitVarianceScaled: variance,
    withinTolerance,
  };
}

/**
 * Determine history completeness (spec section 46) from what evidence is
 * actually available for this position — never guessed, never defaulted
 * to "complete" just because a value is present.
 */
export function determineHistoryCompleteness(input: {
  hasExplicitOpeningBalanceTransaction: boolean; // e.g. a synthetic "Opening Balance" line, or a document explicitly covering from scheme inception
  hasAnyTransactionHistory: boolean;
  hasClosingHoldingSnapshot: boolean;
  statementCoversFromInception: boolean;
}): IiHistoryCompleteness {
  if (input.statementCoversFromInception) return 'complete_from_inception';
  if (input.hasExplicitOpeningBalanceTransaction) return 'complete_from_known_opening_balance';
  if (input.hasAnyTransactionHistory) return 'partial_history';
  if (input.hasClosingHoldingSnapshot) return 'holdings_only';
  return 'partial_history';
}
