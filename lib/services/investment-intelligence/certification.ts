// Investment Intelligence R2 — certification rules (spec sections 27, 29).
//
// "CERTIFIED must never mean 'parser ran without crashing' — it means the
// defined portfolio-truth checks passed." This module is the ONE place
// that decision is made, as a pure, fully-tested function — every caller
// (documentProcessing.ts, the certify API route) goes through this rather
// than each independently deciding what counts as a blocker.
//
// Documented blocker list (exactly spec section 29's "likely blockers"):
//   unsupported statement / source undetected, parser fatal error,
//   unresolved legal owner, unresolved material instrument, unexplained
//   closing-unit mismatch (outside tolerance), corrupted document, invalid
//   canonical record, cross-household mapping conflict, a MATERIAL
//   unclassified transaction, and any still-open BLOCKING-severity
//   reconciliation case.
//
// Documented permitted-warning list (spec section 29's "may permit
// CERTIFIED_WITH_WARNINGS"): incomplete historical transaction period
// while closing holdings reconcile (or cannot yet be evaluated because no
// opening balance exists), a holdings-only position (no transaction
// history at all, but a certified closing snapshot exists), a stale
// statement date, and a non-material unclassified informational line.
//
// A blocking issue is NEVER silently downgraded to a warning (spec
// section 29) — every blocking code below unconditionally forces
// 'reconciliation_required', regardless of how many/few warnings also
// apply.

import type { IiHistoryCompleteness, IiPortfolioTruthStatus } from './types';
import type { ReconcilePositionResult } from './reconciliation';

export interface CertificationReason {
  code: string;
  message: string;
}

export interface CertificationInput {
  sourceDetected: boolean;
  parserFatalError: boolean;
  documentCorrupt: boolean;
  ownerUnresolved: boolean;
  instrumentUnresolved: boolean; // includes ambiguous-instrument
  crossHouseholdConflict: boolean;
  invalidCanonicalRecord: boolean;
  hasOpenBlockingReconciliationCase: boolean;
  hasMaterialUnclassifiedTransaction: boolean;
  hasNonMaterialUnclassifiedTransaction: boolean;
  reconciliation: ReconcilePositionResult;
  historyCompleteness: IiHistoryCompleteness;
  staleStatementDays: number | null;
  staleThresholdDays: number;
}

export interface CertificationOutcome {
  status: IiPortfolioTruthStatus;
  blockingReasons: CertificationReason[];
  warningReasons: CertificationReason[];
}

export function evaluateCertification(input: CertificationInput): CertificationOutcome {
  const blocking: CertificationReason[] = [];

  if (input.documentCorrupt) blocking.push({ code: 'document_corrupt', message: 'The source document could not be safely read.' });
  if (!input.sourceDetected) blocking.push({ code: 'source_undetected', message: 'The statement source/format could not be confidently identified.' });
  if (input.parserFatalError) blocking.push({ code: 'parser_fatal_error', message: 'The parser encountered a fatal error while reading this document.' });
  if (input.ownerUnresolved) blocking.push({ code: 'unresolved_owner', message: 'The statement holder could not be mapped to a household member.' });
  if (input.instrumentUnresolved) blocking.push({ code: 'unresolved_instrument', message: 'One or more schemes on this statement could not be resolved to a canonical instrument.' });
  if (input.crossHouseholdConflict) blocking.push({ code: 'cross_household_conflict', message: 'This position maps to more than one household.' });
  if (input.invalidCanonicalRecord) blocking.push({ code: 'invalid_canonical_record', message: 'A canonical record failed validation before it could be certified.' });
  if (input.hasOpenBlockingReconciliationCase) blocking.push({ code: 'open_blocking_reconciliation_case', message: 'An unresolved blocking-severity reconciliation case exists for this position.' });
  if (input.hasMaterialUnclassifiedTransaction) blocking.push({ code: 'material_unclassified_transaction', message: 'A transaction with a material amount/unit impact could not be classified.' });
  if (input.reconciliation.withinTolerance === false) {
    blocking.push({
      code: 'unit_variance_exceeds_tolerance',
      message: `Reconstructed closing units do not match the statement's closing balance within tolerance (variance: ${input.reconciliation.unitVarianceScaled}).`,
    });
  }

  if (blocking.length > 0) {
    return { status: 'reconciliation_required', blockingReasons: blocking, warningReasons: [] };
  }

  const warnings: CertificationReason[] = [];

  if (input.historyCompleteness === 'partial_history' || input.historyCompleteness === 'complete_from_known_opening_balance') {
    warnings.push({ code: 'incomplete_transaction_history', message: 'Transaction history is not complete from scheme inception, though closing holdings reconcile against the available window.' });
  }
  if (input.historyCompleteness === 'holdings_only') {
    warnings.push({ code: 'holdings_only_no_transaction_history', message: 'Only a closing holding snapshot is available — no transaction history could be reconstructed for this position.' });
  }
  if (input.reconciliation.withinTolerance === null) {
    warnings.push({ code: 'reconciliation_not_evaluated_no_opening_balance', message: 'Reconciliation could not be evaluated because no opening balance is available for this position.' });
  }
  if (input.staleStatementDays !== null && input.staleStatementDays > input.staleThresholdDays) {
    warnings.push({ code: 'stale_statement_date', message: `The latest certified statement for this position is ${input.staleStatementDays} days old.` });
  }
  if (input.hasNonMaterialUnclassifiedTransaction) {
    warnings.push({ code: 'non_material_unclassified_line', message: 'A non-material, informational statement line could not be classified.' });
  }

  if (warnings.length > 0) {
    return { status: 'certified_with_warnings', blockingReasons: [], warningReasons: warnings };
  }

  return { status: 'certified', blockingReasons: [], warningReasons: [] };
}
