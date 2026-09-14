/**
 * AIE-1.3 — FDH bank-statement adapter: the deterministic parser bridge
 * (AIE13-AI-01/02/03, execution-sequence step 5).
 *
 * REUSE, NOT REIMPLEMENTATION. Every actual classification/extraction/
 * reconciliation primitive below is imported UNCHANGED from FDH-5
 * (`lib/financial-data-hub/bank-pdf/**`) and R7 (`bank-csv/**`) — this file
 * adds ZERO new PDF parsing, dedup, or reconciliation logic. It exists only
 * to translate `runBankPdfPipeline`'s already-certified output shape into
 * AIE-1.1's `RegisteredParser` / `AieFieldCandidate` contract, matching the
 * exact `AIE_1_1_IMPLEMENTATION.md` prediction: "a future AIE-1.3 is expected
 * to wrap them behind this interface, not discard them."
 *
 * WHY THIS IS SYNCHRONOUS (matching `RegisteredParser.parse`'s contract)
 * even though FDH-5's own `runBankPdfPipeline` is `async`: the ONLY async
 * step in that pipeline is `classifyPdf()` (byte-level PDF-structure
 * detection: encrypted / corrupt / image-only / text-native — see that
 * module's own header). Every step AFTER obtaining `pages: string[]` is
 * already pure and synchronous (`detectPdfBankAdapter`,
 * `extractPdfStatementMetadata`, `flattenPdfLines`, `reconstructRows`,
 * `normalizePdfRow`, `computeSourceRowHash`, `computeEconomicFingerprint`,
 * `decideDedup`, `reconcileBalances`, `computeDateCoverage`). The caller
 * (`app/api/aie/fdh-bank/intake/route.ts`) runs `classifyPdf` ONCE (exactly
 * mirroring how the generic `/api/aie/intake` route runs
 * `extractPdfTextLocally` before ever calling `sniffDocument`/`parse`) and
 * hands this module the resulting `pages` as plain text — so this parser
 * genuinely never touches raw bytes, satisfying AIE-1.1's own architecture
 * invariant ("raw bytes never reach this module") for the classifier/parser
 * layer, not just in spirit.
 *
 * SCANNED (IMAGE_ONLY) STATEMENTS. Verified against this repository's own
 * code, not assumed: `lib/financial-data-hub/bank-pdf/ocr.ts` exports only
 * an eligibility CLASSIFIER (`determineOcrEligibility` ->
 * `'not_required' | 'eligible_not_available'`) — no OCR engine is wired into
 * `classifyPdf`, `runBankPdfPipeline`, or `bankPdfProcessingService.ts`
 * anywhere in this repository today (confirmed by
 * `grep -rn "from.*bank-pdf/ocr"` returning zero call sites outside its own
 * unit test). FDH-5 already terminally REJECTS an image-only PDF
 * (`error_code: 'ocr_required'`) rather than silently guessing. This adapter
 * inherits that exact, already-disclosed limitation unchanged — mandatory
 * end-to-end scenario 3 ("scanned statement using selective OCR") is
 * therefore NOT implemented by this pass, and is reported as such rather
 * than claimed.
 */

import { detectPdfBankAdapter } from '@/lib/financial-data-hub/bank-pdf/detection';
import { extractPdfStatementMetadata } from '@/lib/financial-data-hub/bank-pdf/metadata';
import { flattenPdfLines, reconstructRows } from '@/lib/financial-data-hub/bank-pdf/rowReconstruction';
import { normalizePdfRow } from '@/lib/financial-data-hub/bank-pdf/normalize';
import { computeEconomicFingerprint, computeSourceRowHash } from '@/lib/financial-data-hub/bank-csv/fingerprint';
import { decideDedup, addToDedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';
import { reconcileBalances, computeDateCoverage, rangesOverlap } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import { PDF_MAX_TRANSACTION_ROWS } from '@/lib/financial-data-hub/bank-pdf/constants';
import type { AcceptedPdfTransactionPlan, RejectedPdfRowPlan } from '@/lib/financial-data-hub/bank-pdf/orchestrator';
import type { RegisteredParser, DeterministicParserResult } from '../../classifier/registry';
import type { AieFieldCandidate } from '../../types';
import {
  ACCOUNT_AMBIGUOUS_FIELD_NAME,
  ADAPTER_ID_FIELD_NAME,
  DATE_RANGE_OVERLAP_FIELD_NAME,
  INSTITUTION_HINT_FIELD_NAME,
  RECONCILIATION_METHOD_FIELD_NAME,
  RECONCILIATION_STATUS_FIELD_NAME,
  RECONCILIATION_VARIANCE_FIELD_NAME,
  TRANSACTION_ROW_FIELD_PREFIX,
  type FdhBankStatementParseContext,
} from './types';

export const FDH_BANK_STATEMENT_ADAPTER_ID = 'aie_fdh_bank_statement_bridge_v1';
export const FDH_BANK_STATEMENT_ADAPTER_VERSION = '1';

/** JSON-serialisable per-row candidate — never a bare string, so
 * `sourceReference` (page/row coordinates, AIE13-AI-08's "require source
 * evidence reference") survives the `AieFieldCandidate.valueRaw: string`
 * constraint without losing structure. */
function rowCandidate(t: AcceptedPdfTransactionPlan): AieFieldCandidate {
  return {
    fieldName: `${TRANSACTION_ROW_FIELD_PREFIX}${t.sourceRowNumber}`,
    valueRaw: JSON.stringify({
      transactionDate: t.transactionDate,
      descriptionClean: t.descriptionClean,
      amountOriginal: t.amountOriginal,
      creditDebit: t.creditDebit,
      balanceAfter: t.balanceAfter,
      dedupStatus: t.dedupStatus,
    }),
    isNull: false,
    sourceMethod: 'deterministic',
    sourceReference: { sourcePage: t.sourcePage, sourceRowNumber: t.sourceRowNumber, economicFingerprint: t.economicFingerprint },
  };
}

/**
 * Builds ONE request-scoped `RegisteredParser` bound to a single intake's
 * account/dedup context. See `types.ts`'s header for why this is a factory
 * rather than a process-wide singleton.
 */
export function createFdhBankStatementParser(ctx: FdhBankStatementParseContext): RegisteredParser {
  return {
    adapterId: FDH_BANK_STATEMENT_ADAPTER_ID,
    version: FDH_BANK_STATEMENT_ADAPTER_VERSION,
    moduleHint: 'fdh_bank',

    // REG-02: sniff on already-extracted text only, never the filename.
    sniff(extractedText: string): boolean {
      const detection = detectPdfBankAdapter(extractedText);
      return detection.status === 'detected' || detection.status === 'ambiguous';
    },

    parse(extractedText: string): DeterministicParserResult {
      const detection = detectPdfBankAdapter(extractedText);

      // NOTE: `detection.adapter` is `null` for BOTH 'ambiguous' and
      // 'unsupported_layout' — 'ambiguous' MUST be checked first, or an
      // ambiguous (two-candidates-too-close-to-call) statement would be
      // silently mis-filed as unsupported and lose its AI-eligible-gap
      // declaration entirely.
      if (detection.status === 'ambiguous') {
        // The ONE genuinely non-transaction-data gap this adapter ever
        // declares AI-eligible (AIE13-AI-02) — see reconciliation.ts's
        // header for why the AI candidate this produces can still never
        // change the pipeline outcome (AIE13-AI-10 / P4).
        return {
          outcome: 'partial',
          candidates: [{ fieldName: ACCOUNT_AMBIGUOUS_FIELD_NAME, valueRaw: 'false', isNull: false, sourceMethod: 'deterministic' }],
          aiEligibleGaps: [INSTITUTION_HINT_FIELD_NAME],
          failureReason: 'ambiguous_layout',
        };
      }

      if (detection.status === 'unsupported_layout' || !detection.adapter) {
        // AIE13-BASE-04 / non-negotiable prohibition: "no unsupported
        // institution/layout certification without corpus evidence" — never
        // silently guessed, never AI-eligible either (AI cannot certify a
        // layout FDH-5 itself has not certified).
        return { outcome: 'failed', candidates: [], aiEligibleGaps: [], failureReason: 'unsupported_layout' };
      }

      const adapter = detection.adapter;
      const fullText = extractedText;
      const statementMetadata = extractPdfStatementMetadata(fullText, adapter);
      // `flattenPdfLines` expects the same `pages: string[]` shape FDH-5's
      // own pipeline passes it. This bridge is only ever invoked with the
      // single already-concatenated document text AIE-1.1's own local
      // extraction step produces, so it is treated as one page — this is a
      // disclosed precision loss relative to FDH-5's own per-page pipeline
      // (page-break continuation still works via `headerFooterPatterns`,
      // but `sourcePage` numbers reported downstream are always `1` through
      // this bridge). The full-fidelity per-page path remains FDH-5's own
      // existing, unmodified `runBankPdfPipeline`/upload route, which this
      // adapter's commit step (`atomicImport.ts`) calls for the actual
      // canonical write.
      const lines = flattenPdfLines([fullText], adapter);
      const { rows, unparseableBlocks } = reconstructRows(lines, adapter);

      if (rows.length > PDF_MAX_TRANSACTION_ROWS) {
        return { outcome: 'failed', candidates: [], aiEligibleGaps: [], failureReason: 'page_limit_exceeded' };
      }

      const accepted: AcceptedPdfTransactionPlan[] = [];
      const rejected: RejectedPdfRowPlan[] = [];

      for (const row of rows) {
        const result = normalizePdfRow(row, adapter.dateFormat, adapter.amountConvention);
        if (!result.ok) {
          rejected.push({ sourceRowNumber: row.rowIndex, reason: result.reason });
          continue;
        }
        const t = result.transaction;
        const sourceRowHash = computeSourceRowHash(ctx.statementUploadId, row.rowIndex, [
          row.dateRaw,
          row.descriptionRaw,
          row.amountRaw,
          row.balanceRaw ?? '',
        ]);
        const economicFingerprint = computeEconomicFingerprint({
          financialAccountId: ctx.financialAccountId,
          currencyCode: ctx.currencyCode,
          transaction: t,
        });
        const hasStrongEvidence = t.balanceAfter !== null;
        const decision = decideDedup({ economicFingerprint, hasStrongEvidence }, ctx.dedupIndex);

        accepted.push({
          sourceRowNumber: row.rowIndex,
          sourcePage: row.pageNumber,
          transactionDate: t.transactionDate,
          descriptionRaw: t.descriptionRaw,
          descriptionClean: t.descriptionClean,
          amountOriginal: t.amountOriginal,
          creditDebit: t.creditDebit,
          balanceAfter: t.balanceAfter,
          transactionTypeHint: t.transactionTypeHint,
          sourceRowHash,
          economicFingerprint,
          dedupStatus: decision.status,
          matchedTransactionId: decision.matchedTransactionId,
          matchMethod: decision.matchMethod,
          dedupConfidence: decision.confidence,
          extractionConfidence: result.extractionConfidence,
        });

        addToDedupIndex(ctx.dedupIndex, economicFingerprint, {
          transactionId: `pending-row-${row.rowIndex}`,
          hasStrongEvidence,
        });
      }

      const nonDuplicateAccepted = accepted.filter((a) => a.dedupStatus !== 'duplicate_confirmed');
      const reconciliation = reconcileBalances(
        nonDuplicateAccepted.map((a) => ({
          sourceRowNumber: a.sourceRowNumber,
          amountOriginal: a.amountOriginal,
          creditDebit: a.creditDebit,
          balanceAfter: a.balanceAfter,
        })),
        ctx.currencyCode,
      );
      const dateCoverage = computeDateCoverage(
        nonDuplicateAccepted.map((a) => a.transactionDate),
        ctx.declaredPeriodStart ?? statementMetadata.statementPeriodStart ?? null,
        ctx.declaredPeriodEnd ?? statementMetadata.statementPeriodEnd ?? null,
      );

      // PDF/CSV + PDF/PDF overlap (AIE13-DUP / non-negotiable prohibition:
      // "no duplicate transaction import from PDF/PDF or PDF/CSV overlap") —
      // reuses R7's own pure interval-arithmetic check, unchanged.
      const overlapsPrior =
        dateCoverage.earliestDate && dateCoverage.latestDate
          ? [...ctx.priorStatementRanges.values()].some((r) =>
              rangesOverlap(r, { start: dateCoverage.earliestDate as string, end: dateCoverage.latestDate as string }),
            )
          : false;

      const candidates: AieFieldCandidate[] = [
        { fieldName: ADAPTER_ID_FIELD_NAME, valueRaw: adapter.id, isNull: false, sourceMethod: 'deterministic' },
        { fieldName: RECONCILIATION_STATUS_FIELD_NAME, valueRaw: reconciliation.status, isNull: false, sourceMethod: 'deterministic' },
        { fieldName: RECONCILIATION_METHOD_FIELD_NAME, valueRaw: reconciliation.method, isNull: false, sourceMethod: 'deterministic' },
        {
          fieldName: RECONCILIATION_VARIANCE_FIELD_NAME,
          valueRaw: reconciliation.variance === null ? null : String(reconciliation.variance),
          isNull: reconciliation.variance === null,
          sourceMethod: 'deterministic',
        },
        { fieldName: DATE_RANGE_OVERLAP_FIELD_NAME, valueRaw: String(overlapsPrior), isNull: false, sourceMethod: 'deterministic' },
        ...accepted.map(rowCandidate),
      ];

      const outcome: DeterministicParserResult['outcome'] =
        rejected.length === 0 && unparseableBlocks.length === 0 ? 'complete' : accepted.length > 0 ? 'partial' : 'failed';

      return {
        outcome,
        documentClass: 'fdh_bank_statement',
        candidates,
        // Every remaining gap on a DETECTED, certified layout is a
        // transaction-data fact (a rejected row's missing date/amount/sign)
        // — AIE13-AI-06 forbids AI from inventing exactly these, so
        // `aiEligibleGaps` is always empty once an adapter is unambiguously
        // detected, regardless of how many rows were rejected.
        aiEligibleGaps: [],
        failureReason: outcome === 'failed' ? 'all_rows_rejected' : undefined,
      };
    },
  };
}
