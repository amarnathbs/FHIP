/**
 * Field dispositions -- BANK statements (CSV, native PDF, AI-fallback draft)
 * and the approved bank ledger / statement tables. Owner: WP-08 (bank
 * pipeline); WP-07 (Expenses-tab display). Matrix section 1.
 */
import { B, C, D, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

// Gap references (APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md, gap register).
const DC01 = gap('DC-01', 'P0', 'WP-03'); // read model done in WP-02; consumers switch in WP-03
const EXPG1 = gap('EXP-G1', 'P0', 'WP-07');
const EXPG4 = gap('EXP-G4', 'P1', 'WP-08');
const EXPG14 = gap('EXP-G14', 'P2', 'WP-08');
const EXPG15 = gap('EXP-G15', 'P2', 'WP-08');
const DC16 = gap('DC-16', 'P2', 'WP-08');

const REVIEW = 'Expenses > Import bank statement > category review';
const ACTIVITY = 'Financial Activity > transactions';

const CSV: Row[] = [
  ['sourceRowNumber', D, 'fdh_transactions.source_row'],
  ['transactionDate', B, 'fdh_transactions.transaction_date', REVIEW, DC01, 'economic date; averaged over complete covered months'],
  ['postedDate', C, 'evidence:fdh_transactions.posting_date', null, EXPG14],
  ['valueDate', C, 'evidence:fdh_transactions.value_date', null, EXPG14],
  ['descriptionRaw', C, 'evidence:fdh_transactions.description_raw (purgeable)', ACTIVITY],
  ['descriptionClean', B, 'fdh_transactions.description_clean', REVIEW, EXPG1, 'payee; the Expenses-tab actual line label'],
  ['referenceRaw', C, 'evidence:fdh_transactions.source_reference (dedup key)', null, EXPG14],
  ['amountOriginal', B, 'fdh_transactions.amount_original', REVIEW],
  ['creditDebit', B, 'fdh_transactions.credit_debit', REVIEW, null, 'direction only, never economic meaning'],
  ['balanceAfter', C, 'evidence:fdh_transactions.balance_after', null, EXPG14],
  ['transactionTypeHint', D, 'fdh_transactions.transaction_type_hint'],
];

const PDF_TXN: Row[] = [
  ['sourceRowNumber', D, 'fdh_transactions.source_row'],
  ['sourcePage', D, 'fdh_transactions.source_page'],
  ['transactionDate', B, 'fdh_transactions.transaction_date', REVIEW, DC01],
  ['descriptionRaw', C, 'evidence:fdh_transactions.description_raw (purgeable)', ACTIVITY],
  ['descriptionClean', B, 'fdh_transactions.description_clean', REVIEW, EXPG1],
  ['amountOriginal', B, 'fdh_transactions.amount_original', REVIEW],
  ['creditDebit', B, 'fdh_transactions.credit_debit', REVIEW],
  ['balanceAfter', C, 'evidence:fdh_transactions.balance_after', null, EXPG14],
  ['transactionTypeHint', D, 'fdh_transactions.transaction_type_hint'],
  ['sourceRowHash', D, 'fdh_transactions.source_row_hash'],
  ['economicFingerprint', D, 'fdh_transactions.economic_fingerprint'],
  ['dedupStatus', D, 'fdh_transactions.dedup_status', null, EXPG4, 'excluded duplicates never count (read model honours it; cascade fixed in WP-08)'],
  ['matchedTransactionId', D, 'fdh_duplicate_candidates.transaction_id_a'],
  ['matchMethod', D, 'fdh_duplicate_candidates.match_method'],
  ['dedupConfidence', D, 'fdh_duplicate_candidates.confidence'],
  ['extractionConfidence', D, 'fdh_transactions.extraction_confidence'],
];

const PDF_META: Row[] = [
  ['declaredOpeningBalance', C, 'evidence:fdh_reconciliation_results.opening_balance', 'Bank import panel > review summary (reconciliation)'],
  ['declaredClosingBalance', C, 'evidence:fdh_reconciliation_results.reported_closing_balance (D-04: a cash-asset proposal the user Applies)', null, DC16],
  ['maskedAccountIdentifier', D, 'account matching (currently dropped)', null, EXPG14],
  ['statementPeriodStart', C, 'fdh_statement_uploads.statement_period_start (coverage input)', null, EXPG14],
  ['statementPeriodEnd', C, 'fdh_statement_uploads.statement_period_end (coverage input)', null, EXPG14],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'fdh_ai_fallback_drafts.payload'],
  ['documentMissingReasonCode', D, 'fdh_ai_fallback_drafts.payload'],
  ['institutionName', D, 'fdh_financial_accounts.display_name (currently draft payload only)', null, EXPG14],
  ['maskedAccountIdentifier', D, 'account matching (currently dropped)', null, EXPG14],
  ['statementPeriodStart', C, 'fdh_statement_uploads.statement_period_start', null, EXPG14],
  ['statementPeriodEnd', C, 'fdh_statement_uploads.statement_period_end', null, EXPG14],
  ['declaredOpeningBalance', C, 'evidence:fdh_reconciliation_results.opening_balance', 'Bank import panel > review summary (reconciliation)'],
  ['declaredClosingBalance', C, 'evidence:fdh_reconciliation_results.reported_closing_balance (D-04)', null, DC16],
  ['allTransactionsListed', C, 'evidence: statement data-quality result', null, EXPG15],
  ['transactions', B, 'fdh_transactions (one row per line, through the native pipeline)', REVIEW, EXPG15, 'the 80-row AI cap must force an incomplete-extraction review'],
];

const AI_TXN: Row[] = [
  ['transactionDate', B, 'fdh_transactions.transaction_date', REVIEW, DC01],
  ['descriptionRaw', C, 'evidence:fdh_transactions.description_raw', ACTIVITY],
  ['amount', B, 'fdh_transactions.amount_original', REVIEW],
  ['creditDebit', B, 'fdh_transactions.credit_debit', REVIEW],
  ['balanceAfter', C, 'evidence:fdh_transactions.balance_after', null, EXPG14],
];

const TXN_TABLE: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'financial_account_id', 'statement_upload_id'], 'fdh_transactions'),
  ['transaction_date', B, 'fdh_transactions.transaction_date', REVIEW, DC01],
  ['posting_date', C, 'evidence:fdh_transactions.posting_date', null, EXPG14],
  ['value_date', C, 'evidence:fdh_transactions.value_date', null, EXPG14],
  ['description_raw', C, 'evidence:fdh_transactions.description_raw (purgeable)', ACTIVITY],
  ['description_clean', B, 'fdh_transactions.description_clean', REVIEW, EXPG1],
  ['merchant_raw', C, 'evidence:fdh_transactions.merchant_raw', 'Financial Activity > merchants'],
  ['merchant_id', D, 'fdh_transactions.merchant_id'],
  ['amount_original', B, 'fdh_transactions.amount_original', REVIEW],
  ['currency_original', B, 'fdh_transactions.currency_original (converted once by the read models; unsupported fails closed)', REVIEW, EXPG14],
  ...technical(['amount_reporting_currency', 'reporting_currency', 'fx_rate', 'fx_rate_date', 'fx_rate_source'], 'fdh_transactions'),
  ['credit_debit', B, 'fdh_transactions.credit_debit', REVIEW],
  ['economic_transaction_type', B, 'fdh_transactions.economic_transaction_type (one read-model bucket per value)', REVIEW],
  ['category_id', B, 'fdh_transactions.category_id (canonical expense group)', REVIEW, EXPG1],
  ['subcategory_id', B, 'fdh_transactions.subcategory_id (essential flag)', REVIEW, EXPG1],
  ...technical(['recurring_flag', 'subscription_flag', 'transfer_flag', 'classification_confidence', 'extraction_confidence', 'classification_method'], 'fdh_transactions'),
  ['source_reference', C, 'evidence:fdh_transactions.source_reference', null, EXPG14],
  ...technical(['source_page', 'source_row', 'review_status', 'user_override', 'created_at', 'updated_at', 'source_row_hash', 'economic_fingerprint', 'economic_fingerprint_version'], 'fdh_transactions'),
  ['dedup_status', D, 'fdh_transactions.dedup_status', null, EXPG4],
  ['balance_after', C, 'evidence:fdh_transactions.balance_after', null, EXPG14],
  ...technical(['transaction_type_hint', 'parser_version_id', 'mapping_template_id', 'recurring_transaction_id', 'approval_status', 'approved_at', 'approved_by'], 'fdh_transactions'),
];

const UPLOAD_TABLE: Row[] = [
  ...technical([
    'id', 'user_id', 'household_id', 'financial_account_id', 'institution_id', 'source_type', 'document_type', 'country_code',
    'currency_code',
  ], 'fdh_statement_uploads'),
  ['original_filename_sanitised', C, 'evidence:fdh_statement_uploads.original_filename_sanitised', 'Financial Data Hub > documents'],
  ...technical(['file_hash', 'mime_type', 'file_size_bytes'], 'fdh_statement_uploads'),
  ['statement_period_start', C, 'fdh_statement_uploads.statement_period_start (coverage input)', 'Category review header'],
  ['statement_period_end', C, 'fdh_statement_uploads.statement_period_end (coverage input)', 'Category review header'],
  ...technical([
    'statement_as_of_date', 'processing_status', 'review_status', 'parser_id', 'parser_version_id', 'processing_method',
    'reconciliation_status', 'overall_quality_status', 'error_code', 'raw_document_storage_reference', 'raw_document_purge_status',
    'raw_document_purge_due_at', 'raw_document_purged_at', 'purge_reason', 'purge_attempt_count', 'last_purge_error_sanitised',
    'created_at', 'updated_at', 'approved_at', 'storage_provider', 'uploaded_at', 'validated_at', 'processing_started_at',
    'processing_completed_at', 'purge_requested_at', 'duplicate_of_document_id', 'delimiter_detected', 'encoding_detected',
    'header_row_index', 'detection_status', 'detection_confidence', 'detection_evidence', 'mapping_template_id',
    'certification_status', 'declared_row_count', 'parsed_row_count', 'certified_row_count', 'duplicate_row_count', 'adapter_key',
    'adapter_version', 'page_count', 'pdf_classification', 'extraction_confidence', 'approved_by', 'approval_version', 'reopened_at',
    'reopened_by', 'reopen_reason', 'malware_scan_status', 'malware_scan_object_ref', 'malware_scan_admission_deadline_at',
    'malware_scan_decided_at',
  ], 'fdh_statement_uploads'),
];

export const bankStatementRegistry: RegistryFile = {
  id: 'bankStatement',
  ownerWp: 'WP-08',
  OPEN_GAP_CEILING: 33,
  entries: [
    ...rows('bank_csv', 'ts_interface', 'fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate', CSV),
    ...rows('bank_pdf', 'ts_interface', 'fdh:bank-pdf/orchestrator.ts#AcceptedPdfTransactionPlan', PDF_TXN),
    ...rows('bank_pdf', 'ts_interface', 'fdh:bank-pdf/metadata.ts#PdfStatementMetadata', PDF_META),
    ...rows('bank_ai_draft', 'zod_schema', 'aie:bankStatement/schema.ts#bankStatementDocumentFactsSchema', AI_DOC),
    ...rows('bank_ai_draft', 'zod_schema', 'aie:bankStatement/schema.ts#bankStatementTransactionSchema', AI_TXN),
    ...rows('bank_ledger', 'db_column', 'db:fdh_transactions', TXN_TABLE),
    ...rows('bank_ledger', 'db_column', 'db:fdh_statement_uploads', UPLOAD_TABLE),
  ],
};
