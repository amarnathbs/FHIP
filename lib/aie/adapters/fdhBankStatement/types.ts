/**
 * AIE-1.3 — FDH bank-statement adapter: shared type vocabulary.
 *
 * ARCHITECTURE NOTE, DISCLOSED. AIE-1.1's global `aieParserRegistry`
 * (`lib/aie/classifier/registry.ts`) assumes a STATELESS `RegisteredParser`
 * (`sniff(text)`/`parse(text)`, no injected dependencies). FDH bank-statement
 * transaction-row reconstruction is NOT stateless: exact-duplicate and
 * PDF/CSV-overlap detection require an account-scoped `DedupIndex` and prior
 * statement date ranges loaded from `fdh_transactions` (async, keyed by
 * `financial_account_id`, which is only known once account identity has been
 * resolved for THIS specific intake). This adapter therefore does not
 * register a single process-wide singleton the way AIE-1.1 itself expects —
 * it exposes `createFdhBankStatementParser(deps)` (parser.ts), a FACTORY that
 * produces one request-scoped `RegisteredParser` conforming to the exact same
 * interface, called directly by `app/api/aie/fdh-bank/intake/route.ts` rather
 * than through `sniffDocument()`'s stateless global lookup. A second,
 * genuinely-stateless classification-only parser IS registered into the
 * global registry (see `index.ts`) for institution/layout sniffing, which
 * has no such per-account dependency — this satisfies AIE13-AI-01 ("wrap
 * existing certified bank adapters as AIE deterministic parsers where
 * applicable") for the part of FDH-5 that is genuinely stateless, while being
 * honest that full transaction-row extraction needs the richer, request-
 * scoped bridge below it.
 */

import type { PdfBankAdapter } from '@/lib/financial-data-hub/bank-pdf/adapters/types';
import type { PdfDetectionResult } from '@/lib/financial-data-hub/bank-pdf/detection';
import type { BalanceReconciliationResult, DateCoverageResult } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import type { AcceptedPdfTransactionPlan, RejectedPdfRowPlan } from '@/lib/financial-data-hub/bank-pdf/orchestrator';

/** Field candidate names this adapter ever produces — used by both the
 * parser (parser.ts) and the reconciliation rule (reconciliation.ts) so the
 * two stay in lockstep without a third shared string-literal source. None of
 * these are transaction-level facts encoded as AI-eligible (AIE13-AI-06):
 * the ONLY name ever placed in `aiEligibleGaps` is
 * `INSTITUTION_HINT_FIELD_NAME`, and even then only as an informational
 * candidate for human/PC5 review — see reconciliation.ts's header for why it
 * can never change the pipeline outcome. */
export const RECONCILIATION_STATUS_FIELD_NAME = '__fdh_bank_reconciliation_status';
export const RECONCILIATION_VARIANCE_FIELD_NAME = '__fdh_bank_reconciliation_variance';
export const RECONCILIATION_METHOD_FIELD_NAME = '__fdh_bank_reconciliation_method';
export const DATE_RANGE_OVERLAP_FIELD_NAME = '__fdh_bank_date_range_overlap';
export const ACCOUNT_AMBIGUOUS_FIELD_NAME = '__fdh_bank_account_ambiguous';
export const ADAPTER_ID_FIELD_NAME = 'detected_adapter_id';
export const TRANSACTION_ROW_FIELD_PREFIX = 'transaction_row_';
/** The one, narrow, non-transaction-data AI-eligible gap this adapter ever
 * declares (AIE13-AI-02/AI-05/AI-06): which of two-or-more already-CERTIFIED
 * institution layouts an ambiguous statement most likely belongs to. Never a
 * date/amount/sign/balance/currency/account-identity field. */
export const INSTITUTION_HINT_FIELD_NAME = 'bank_institution_hint';

export interface FdhBankStatementParseContext {
  financialAccountId: string;
  currencyCode: string;
  statementUploadId: string;
  declaredPeriodStart?: string | null;
  declaredPeriodEnd?: string | null;
  /** Loaded via `bank-csv/repository.ts#loadDedupIndexForAccount` — reused
   * unchanged, scoped to this one account (spec DUP-03 precedent). */
  dedupIndex: import('@/lib/financial-data-hub/bank-csv/dedup').DedupIndex;
  /** Loaded via `bank-csv/repository.ts#loadPriorStatementDateRanges` —
   * reused unchanged; drives PDF/CSV overlap detection (AIE13-DUP scope). */
  priorStatementRanges: Map<string, import('@/lib/financial-data-hub/bank-csv/reconciliation').DateRange>;
}

export interface FdhBankStatementParseOutcome {
  detection: PdfDetectionResult;
  adapter: PdfBankAdapter | null;
  accepted: AcceptedPdfTransactionPlan[];
  rejected: RejectedPdfRowPlan[];
  unparseableBlockCount: number;
  reconciliation: BalanceReconciliationResult | null;
  dateCoverage: DateCoverageResult | null;
  overlapsPriorStatement: boolean;
}
