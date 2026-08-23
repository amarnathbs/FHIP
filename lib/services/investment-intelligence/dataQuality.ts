// Investment Intelligence R2 — data-quality / confidence model (spec
// section 28).
//
// "No mysterious black-box score — if an aggregate confidence score is
// introduced, document its deterministic formula. Prefer transparent
// status components over a single unexplained percentage."
//
// R2's decision: DO NOT introduce a single blended confidence percentage
// at all. This module assembles the explainable, independently-meaningful
// components spec section 28 lists, as a structured object — the ONE
// number this codebase DOES compute (parserConfidence, in
// parsers/registry.ts's computeParserConfidence) already has its exact
// formula documented there and is surfaced as ONE of these components, not
// blended into a further opaque aggregate.

import type { IiHistoryCompleteness } from './types';

export type TransactionCompletenessStatus = 'complete' | 'partial' | 'unknown';
export type HoldingsReconciliationStatus = 'matched' | 'within_tolerance' | 'material_mismatch' | 'not_evaluated';

export interface DataQualityComponents {
  sourceConfidence: number | null; // from parser's canHandle() detection
  parserConfidence: number | null; // parsers/registry.ts's computeParserConfidence — formula documented there
  ownerMappingConfidence: number | null; // 1.0 if owner_member_id resolved directly, lower/null if ambiguous or unresolved
  instrumentMappingConfidence: number | null; // from schemeResolution.ts's per-match confidence (1.0 isin/amfi, 0.85 normalised-name, 0.9 alias-map)
  transactionCompleteness: TransactionCompletenessStatus;
  holdingsReconciliation: HoldingsReconciliationStatus;
  statementFreshnessDays: number | null;
  historyCompleteness: IiHistoryCompleteness | null;
}

export function deriveTransactionCompleteness(historyCompleteness: IiHistoryCompleteness | null): TransactionCompletenessStatus {
  if (historyCompleteness === 'complete_from_inception' || historyCompleteness === 'complete_from_known_opening_balance') return 'complete';
  if (historyCompleteness === 'partial_history') return 'partial';
  return 'unknown';
}

export function deriveHoldingsReconciliationStatus(withinTolerance: boolean | null, unitVarianceIsZero: boolean | null): HoldingsReconciliationStatus {
  if (withinTolerance === null) return 'not_evaluated';
  if (!withinTolerance) return 'material_mismatch';
  return unitVarianceIsZero ? 'matched' : 'within_tolerance';
}
