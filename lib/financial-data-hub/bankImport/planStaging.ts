/**
 * Document2 (4) WP-G (F15) -- the STAGED PLAN of a bank import: what a "read" slice hands to the "persist" and "finalize" slices.
 *
 * The read slice parses the statement ONCE (it needs the file, the dedup index of the account and, for a protected PDF, a password
 * that is never stored), decides every line (which are new, which are confirmed duplicates, which are duplicate candidates), and
 * stages two things in `fdh_bank_import_job_chunks`:
 *   - one `plan_meta` row: the facts the finalize step needs (reconciliation, counts, rejected lines, statement metadata ...);
 *   - `plan_rows` batches: the insert-ready `fdh_transactions` rows, 250 per batch.
 * Later slices only READ the staging, so a killed slice never re-decides anything and the duplicate decisions are frozen at plan
 * time. Pure: no I/O.
 */

import type { BalanceReconciliationResult } from '../bank-csv/reconciliation';
import type { PdfPipelineStatus } from '../bank-pdf/orchestrator';
import type { PdfStatementMetadata } from '../bank-pdf/metadata';
import type { AiReadingContext } from '../services/bankPdfProcessingService';
import type { DuplicateCandidateRef } from '../services/bankCsvProcessingService';
import { BANK_IMPORT_STAGE_CHUNK, type BankImportSourceKind } from './jobModel';

export interface StagedOverlap {
  overlappingStatementCount: number;
  overlapFrom: string;
  overlapTo: string;
}

export interface StagedCsvFacts {
  detectionStatus: string;
  declaredRowCount: number;
  parsedRowCount: number;
  rejected: Array<{ sourceRowNumber: number; reason: string }>;
  reconciliation: BalanceReconciliationResult | null;
  parserVersion: string;
}

export interface StagedPdfFacts {
  status: PdfPipelineStatus;
  rejected: Array<{ sourceRowNumber: number; reason: string }>;
  unparseableBlockCount: number;
  reconciliation: BalanceReconciliationResult | null;
  statementMetadata: PdfStatementMetadata | null;
  parserVersion: string;
  pageCount: number | null;
  statementExtractionConfidence: number | null;
}

export interface StagedPlanMeta {
  version: 1;
  sourceKind: BankImportSourceKind;
  /** native: read off the file by a certified parser; ai_confirmed: a person-checked AI reading. */
  origin: 'native' | 'ai_confirmed';
  acceptedCount: number;
  rowsToInsertCount: number;
  duplicateConfirmedCount: number;
  rowChunkCount: number;
  duplicateCandidates: DuplicateCandidateRef[];
  overlap: StagedOverlap | null;
  economicFingerprintVersion: string;
  csv?: StagedCsvFacts;
  pdf?: StagedPdfFacts;
  aiContext?: AiReadingContext;
}

export function chunkRows<T>(rows: readonly T[], size: number = BANK_IMPORT_STAGE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** What each persist batch still has to write: the staged rows whose source row is not stored yet. */
export function rowsStillToWrite<T extends { source_row?: unknown }>(staged: readonly T[], storedSourceRows: ReadonlySet<number>): T[] {
  return staged.filter((r) => typeof r.source_row !== 'number' || !storedSourceRows.has(r.source_row));
}

/** The text a person sees as the progress of the saving phase. */
export function persistProgress(stored: number, total: number): { done: number; total: number } {
  return { done: Math.min(stored, total), total };
}
