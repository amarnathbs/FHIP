/**
 * Dispatch for adapters read with text positions (30-10-2026). One entry today (`nab_classic`). The pipeline calls this only for an
 * adapter that names a `positionalReaderId`; every other adapter is untouched.
 *
 * The result is either a complete reading (rows, the statement's printed facts, and the reconciliation to apply) or `not_confident`,
 * in which case the caller treats the document exactly like an unsupported layout (the AI fallback path, as before). Nothing partial
 * is ever returned.
 */

import type { BalanceReconciliationResult } from '../bank-csv/reconciliation';
import type { PdfStatementMetadata } from './metadata';
import { forwardBalancesDisagree, reconcileWithCheckpoints, type CheckpointRow } from './checkpointReconciliation';
import { readNabClassicStatement, type NabCounts } from './nabClassicPositional';
import { extractPositionedPdfPages } from './positionedText';
import type { ReconstructedRow } from './rowReconstruction';
import type { PdfBankAdapter } from './adapters/types';

export interface PositionalReading {
  rows: ReconstructedRow[];
  metadata: PdfStatementMetadata;
  /** The reconciliation to apply to the accepted rows (all of them, duplicates included: the statement's arithmetic is not the database's state). */
  reconcile: (rows: readonly CheckpointRow[], currencyCode: string) => BalanceReconciliationResult;
  diagnostics: NabCounts;
}

export type PositionalReadOutcome = { kind: 'read'; reading: PositionalReading } | { kind: 'not_confident'; reason: string; page?: number };

export async function readWithPositionalReader(adapter: PdfBankAdapter, bytes: Uint8Array, password?: string): Promise<PositionalReadOutcome> {
  if (adapter.positionalReaderId !== 'nab_classic') return { kind: 'not_confident', reason: 'no_positional_reader' };
  const extracted = await extractPositionedPdfPages(bytes, password);
  if (!extracted.ok) return { kind: 'not_confident', reason: `positions_${extracted.reason}` };
  const result = readNabClassicStatement(extracted.pages);
  if (result.kind !== 'read') return { kind: 'not_confident', reason: result.reason, ...(result.page !== undefined ? { page: result.page } : {}) };
  return {
    kind: 'read',
    reading: {
      rows: result.rows,
      metadata: result.metadata,
      diagnostics: result.counts,
      reconcile: (rows, currencyCode) =>
        reconcileWithCheckpoints({
          rows,
          openingBalance: result.openingBroughtForward,
          declaredClosingBalance: result.summary.closingBalance,
          declaredTotalDebits: result.summary.totalDebits,
          declaredTotalCredits: result.summary.totalCredits,
          standaloneBalances: result.standaloneBalances,
          forwardMismatch: forwardBalancesDisagree(result.forwardLines, currencyCode),
          currencyCode,
        }),
    },
  };
}
