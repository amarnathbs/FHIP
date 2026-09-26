# UPLOAD_FIELD_DISPOSITION_REGISTRY

GENERATED -- do not edit by hand. Source: `lib/canonical-data/disposition/*.ts`.
Regenerate with `node scripts/generate-upload-field-disposition-doc.mjs`; `tests/unit/uploadFieldDispositionRegistry.test.ts` fails if this file is stale.

Every field an active upload adapter extracts, every evidence column and every activity / economic-type enum value has exactly one disposition:
**A** canonical state · **B** canonical event · **C** evidence (must be user-visible) · **D** technical metadata · **E** explicitly unsupported (with a visible explanation).
`open_gap` rows name the gap (see APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md, gap register) and the work package that closes it; `not_active` rows belong to a flow no user can reach.

## Summary

| Registry file | Owner | Entries | A | B | C | D | E | open_gap | ceiling | not_active |
|---|---|---|---|---|---|---|---|---|---|---|
| bankStatement | WP-08 | 162 | 0 | 20 | 27 | 115 | 0 | 33 | 33 | 0 |
| economicTransactionType | WP-02 | 13 | 0 | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| payslip | WP-09 | 130 | 18 | 12 | 57 | 40 | 3 | 87 | 87 | 0 |
| liabilityStatement | WP-10 | 139 | 29 | 22 | 34 | 41 | 13 | 94 | 94 | 0 |
| liabilityActivityLedger | WP-11 | 10 | 0 | 10 | 0 | 0 | 0 | 10 | 10 | 0 |
| auInvestmentStatement | WP-12 | 167 | 42 | 31 | 24 | 56 | 14 | 74 | 74 | 0 |
| retirementStatement | WP-13 | 201 | 17 | 0 | 115 | 66 | 3 | 131 | 131 | 0 |
| iiCas | WP-12 | 41 | 15 | 5 | 9 | 12 | 0 | 0 | 0 | 0 |
| insurance | WP-14 | 21 | 10 | 0 | 8 | 0 | 3 | 0 | 0 | 21 |
| **total** | | **884** | 131 | 113 | 274 | 330 | 36 | 429 | | 21 |

## Open gaps by id

| Gap | Severity | Owner WP | Fields |
|---|---|---|---|
| DC-01 | P0 | WP-03 | 4 |
| DC-16 | P2 | WP-08 | 2 |
| EXP-G1 | P0 | WP-07 | 5 |
| EXP-G14 | P2 | WP-08 | 18 |
| EXP-G15 | P2 | WP-08 | 2 |
| EXP-G4 | P1 | WP-08 | 2 |
| G1 | P0 | WP-11 | 30 |
| G13 | P3 | WP-11 | 2 |
| G2 | P1 | WP-11 | 9 |
| G4 | P1 | WP-10 | 2 |
| G5 | P1 | WP-10, WP-11 | 12 |
| G6 | P2 | WP-10 | 16 |
| G7 | P1 | WP-07, WP-11 | 30 |
| GAP-01 | P0 | WP-03 | 1 |
| GAP-03 | P1 | WP-09 | 2 |
| GAP-04 | P1 | WP-09 | 3 |
| GAP-05 | P1 | WP-09 | 1 |
| GAP-07 | P2 | WP-09 | 60 |
| GAP-08 | P2 | WP-09 | 12 |
| GAP-09 | P2 | WP-03 | 3 |
| GAP-10 | P2 | WP-09 | 1 |
| GAP-12 | P3 | WP-09 | 3 |
| GAP-15 | P3 | WP-09 | 1 |
| GAP-RET-01 | P1 | WP-13 | 6 |
| GAP-RET-03 | P1 | WP-13 | 56 |
| GAP-RET-04 | P2 | WP-13 | 42 |
| GAP-RET-05 | P2 | WP-13 | 8 |
| GAP-RET-06 | P2 | WP-13 | 9 |
| GAP-RET-07 | P2 | WP-13 | 5 |
| GAP-RET-08 | P2 | WP-07 | 3 |
| GAP-RET-09 | P2 | WP-13 | 2 |
| INV-G1 | P0 | WP-12 | 2 |
| INV-G11 | P3 | WP-12 | 1 |
| INV-G2 | P0 | WP-12 | 6 |
| INV-G3 | P0 | WP-12 | 5 |
| INV-G4 | P1 | WP-12 | 9 |
| INV-G6 | P1 | WP-12 | 6 |
| INV-G7 | P2 | WP-12 | 19 |
| INV-G8 | P2 | WP-12 | 9 |
| INV-G9 | P2 | WP-12 | 17 |
| X-01 | P1 | WP-11 | 3 |

## bankStatement (owner WP-08)

### bank_csv · ts_interface · `fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `sourceRowNumber` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | open_gap | DC-01 (P0) | WP-03 |
| `postedDate` | C evidence | evidence:fdh_transactions.posting_date | — | open_gap | EXP-G14 (P2) | WP-08 |
| `valueDate` | C evidence | evidence:fdh_transactions.value_date | — | open_gap | EXP-G14 (P2) | WP-08 |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `descriptionClean` | B event | fdh_transactions.description_clean | Expenses > Import bank statement > category review | open_gap | EXP-G1 (P0) | WP-07 |
| `referenceRaw` | C evidence | evidence:fdh_transactions.source_reference (dedup key) | — | open_gap | EXP-G14 (P2) | WP-08 |
| `amountOriginal` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | — | open_gap | EXP-G14 (P2) | WP-08 |
| `transactionTypeHint` | D metadata | fdh_transactions.transaction_type_hint | — | compliant | — | — |

### bank_pdf · ts_interface · `fdh:bank-pdf/orchestrator.ts#AcceptedPdfTransactionPlan`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `sourceRowNumber` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `sourcePage` | D metadata | fdh_transactions.source_page | — | compliant | — | — |
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | open_gap | DC-01 (P0) | WP-03 |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `descriptionClean` | B event | fdh_transactions.description_clean | Expenses > Import bank statement > category review | open_gap | EXP-G1 (P0) | WP-07 |
| `amountOriginal` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | — | open_gap | EXP-G14 (P2) | WP-08 |
| `transactionTypeHint` | D metadata | fdh_transactions.transaction_type_hint | — | compliant | — | — |
| `sourceRowHash` | D metadata | fdh_transactions.source_row_hash | — | compliant | — | — |
| `economicFingerprint` | D metadata | fdh_transactions.economic_fingerprint | — | compliant | — | — |
| `dedupStatus` | D metadata | fdh_transactions.dedup_status | — | open_gap | EXP-G4 (P1) | WP-08 |
| `matchedTransactionId` | D metadata | fdh_duplicate_candidates.transaction_id_a | — | compliant | — | — |
| `matchMethod` | D metadata | fdh_duplicate_candidates.match_method | — | compliant | — | — |
| `dedupConfidence` | D metadata | fdh_duplicate_candidates.confidence | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_transactions.extraction_confidence | — | compliant | — | — |

### bank_pdf · ts_interface · `fdh:bank-pdf/metadata.ts#PdfStatementMetadata`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `declaredOpeningBalance` | C evidence | evidence:fdh_reconciliation_results.opening_balance | Bank import panel > review summary (reconciliation) | compliant | — | — |
| `declaredClosingBalance` | C evidence | evidence:fdh_reconciliation_results.reported_closing_balance (D-04: a cash-asset proposal the user Applies) | — | open_gap | DC-16 (P2) | WP-08 |
| `maskedAccountIdentifier` | D metadata | account matching (currently dropped) | — | open_gap | EXP-G14 (P2) | WP-08 |
| `statementPeriodStart` | C evidence | fdh_statement_uploads.statement_period_start (coverage input) | — | open_gap | EXP-G14 (P2) | WP-08 |
| `statementPeriodEnd` | C evidence | fdh_statement_uploads.statement_period_end (coverage input) | — | open_gap | EXP-G14 (P2) | WP-08 |

### bank_ai_draft · zod_schema · `aie:bankStatement/schema.ts#bankStatementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | fdh_ai_fallback_drafts.payload | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | fdh_ai_fallback_drafts.payload | — | compliant | — | — |
| `institutionName` | D metadata | fdh_financial_accounts.display_name (currently draft payload only) | — | open_gap | EXP-G14 (P2) | WP-08 |
| `maskedAccountIdentifier` | D metadata | account matching (currently dropped) | — | open_gap | EXP-G14 (P2) | WP-08 |
| `statementPeriodStart` | C evidence | fdh_statement_uploads.statement_period_start | — | open_gap | EXP-G14 (P2) | WP-08 |
| `statementPeriodEnd` | C evidence | fdh_statement_uploads.statement_period_end | — | open_gap | EXP-G14 (P2) | WP-08 |
| `declaredOpeningBalance` | C evidence | evidence:fdh_reconciliation_results.opening_balance | Bank import panel > review summary (reconciliation) | compliant | — | — |
| `declaredClosingBalance` | C evidence | evidence:fdh_reconciliation_results.reported_closing_balance (D-04) | — | open_gap | DC-16 (P2) | WP-08 |
| `allTransactionsListed` | C evidence | evidence: statement data-quality result | — | open_gap | EXP-G15 (P2) | WP-08 |
| `transactions` | B event | fdh_transactions (one row per line, through the native pipeline) | Expenses > Import bank statement > category review | open_gap | EXP-G15 (P2) | WP-08 |

### bank_ai_draft · zod_schema · `aie:bankStatement/schema.ts#bankStatementTransactionSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | open_gap | DC-01 (P0) | WP-03 |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw | Financial Activity > transactions | compliant | — | — |
| `amount` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | — | open_gap | EXP-G14 (P2) | WP-08 |

### bank_ledger · db_column · `db:fdh_transactions`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_transactions.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_transactions.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_transactions.household_id | — | compliant | — | — |
| `financial_account_id` | D metadata | fdh_transactions.financial_account_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_transactions.statement_upload_id | — | compliant | — | — |
| `transaction_date` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | open_gap | DC-01 (P0) | WP-03 |
| `posting_date` | C evidence | evidence:fdh_transactions.posting_date | — | open_gap | EXP-G14 (P2) | WP-08 |
| `value_date` | C evidence | evidence:fdh_transactions.value_date | — | open_gap | EXP-G14 (P2) | WP-08 |
| `description_raw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `description_clean` | B event | fdh_transactions.description_clean | Expenses > Import bank statement > category review | open_gap | EXP-G1 (P0) | WP-07 |
| `merchant_raw` | C evidence | evidence:fdh_transactions.merchant_raw | Financial Activity > merchants | compliant | — | — |
| `merchant_id` | D metadata | fdh_transactions.merchant_id | — | compliant | — | — |
| `amount_original` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `currency_original` | B event | fdh_transactions.currency_original (converted once by the read models; unsupported fails closed) | Expenses > Import bank statement > category review | open_gap | EXP-G14 (P2) | WP-08 |
| `amount_reporting_currency` | D metadata | fdh_transactions.amount_reporting_currency | — | compliant | — | — |
| `reporting_currency` | D metadata | fdh_transactions.reporting_currency | — | compliant | — | — |
| `fx_rate` | D metadata | fdh_transactions.fx_rate | — | compliant | — | — |
| `fx_rate_date` | D metadata | fdh_transactions.fx_rate_date | — | compliant | — | — |
| `fx_rate_source` | D metadata | fdh_transactions.fx_rate_source | — | compliant | — | — |
| `credit_debit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `economic_transaction_type` | B event | fdh_transactions.economic_transaction_type (one read-model bucket per value) | Expenses > Import bank statement > category review | compliant | — | — |
| `category_id` | B event | fdh_transactions.category_id (canonical expense group) | Expenses > Import bank statement > category review | open_gap | EXP-G1 (P0) | WP-07 |
| `subcategory_id` | B event | fdh_transactions.subcategory_id (essential flag) | Expenses > Import bank statement > category review | open_gap | EXP-G1 (P0) | WP-07 |
| `recurring_flag` | D metadata | fdh_transactions.recurring_flag | — | compliant | — | — |
| `subscription_flag` | D metadata | fdh_transactions.subscription_flag | — | compliant | — | — |
| `transfer_flag` | D metadata | fdh_transactions.transfer_flag | — | compliant | — | — |
| `classification_confidence` | D metadata | fdh_transactions.classification_confidence | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_transactions.extraction_confidence | — | compliant | — | — |
| `classification_method` | D metadata | fdh_transactions.classification_method | — | compliant | — | — |
| `source_reference` | C evidence | evidence:fdh_transactions.source_reference | — | open_gap | EXP-G14 (P2) | WP-08 |
| `source_page` | D metadata | fdh_transactions.source_page | — | compliant | — | — |
| `source_row` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `review_status` | D metadata | fdh_transactions.review_status | — | compliant | — | — |
| `user_override` | D metadata | fdh_transactions.user_override | — | compliant | — | — |
| `created_at` | D metadata | fdh_transactions.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_transactions.updated_at | — | compliant | — | — |
| `source_row_hash` | D metadata | fdh_transactions.source_row_hash | — | compliant | — | — |
| `economic_fingerprint` | D metadata | fdh_transactions.economic_fingerprint | — | compliant | — | — |
| `economic_fingerprint_version` | D metadata | fdh_transactions.economic_fingerprint_version | — | compliant | — | — |
| `dedup_status` | D metadata | fdh_transactions.dedup_status | — | open_gap | EXP-G4 (P1) | WP-08 |
| `balance_after` | C evidence | evidence:fdh_transactions.balance_after | — | open_gap | EXP-G14 (P2) | WP-08 |
| `transaction_type_hint` | D metadata | fdh_transactions.transaction_type_hint | — | compliant | — | — |
| `parser_version_id` | D metadata | fdh_transactions.parser_version_id | — | compliant | — | — |
| `mapping_template_id` | D metadata | fdh_transactions.mapping_template_id | — | compliant | — | — |
| `recurring_transaction_id` | D metadata | fdh_transactions.recurring_transaction_id | — | compliant | — | — |
| `approval_status` | D metadata | fdh_transactions.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_transactions.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_transactions.approved_by | — | compliant | — | — |

### bank_ledger · db_column · `db:fdh_statement_uploads`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_statement_uploads.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_statement_uploads.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_statement_uploads.household_id | — | compliant | — | — |
| `financial_account_id` | D metadata | fdh_statement_uploads.financial_account_id | — | compliant | — | — |
| `institution_id` | D metadata | fdh_statement_uploads.institution_id | — | compliant | — | — |
| `source_type` | D metadata | fdh_statement_uploads.source_type | — | compliant | — | — |
| `document_type` | D metadata | fdh_statement_uploads.document_type | — | compliant | — | — |
| `country_code` | D metadata | fdh_statement_uploads.country_code | — | compliant | — | — |
| `currency_code` | D metadata | fdh_statement_uploads.currency_code | — | compliant | — | — |
| `original_filename_sanitised` | C evidence | evidence:fdh_statement_uploads.original_filename_sanitised | Financial Data Hub > documents | compliant | — | — |
| `file_hash` | D metadata | fdh_statement_uploads.file_hash | — | compliant | — | — |
| `mime_type` | D metadata | fdh_statement_uploads.mime_type | — | compliant | — | — |
| `file_size_bytes` | D metadata | fdh_statement_uploads.file_size_bytes | — | compliant | — | — |
| `statement_period_start` | C evidence | fdh_statement_uploads.statement_period_start (coverage input) | Category review header | compliant | — | — |
| `statement_period_end` | C evidence | fdh_statement_uploads.statement_period_end (coverage input) | Category review header | compliant | — | — |
| `statement_as_of_date` | D metadata | fdh_statement_uploads.statement_as_of_date | — | compliant | — | — |
| `processing_status` | D metadata | fdh_statement_uploads.processing_status | — | compliant | — | — |
| `review_status` | D metadata | fdh_statement_uploads.review_status | — | compliant | — | — |
| `parser_id` | D metadata | fdh_statement_uploads.parser_id | — | compliant | — | — |
| `parser_version_id` | D metadata | fdh_statement_uploads.parser_version_id | — | compliant | — | — |
| `processing_method` | D metadata | fdh_statement_uploads.processing_method | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_statement_uploads.reconciliation_status | — | compliant | — | — |
| `overall_quality_status` | D metadata | fdh_statement_uploads.overall_quality_status | — | compliant | — | — |
| `error_code` | D metadata | fdh_statement_uploads.error_code | — | compliant | — | — |
| `raw_document_storage_reference` | D metadata | fdh_statement_uploads.raw_document_storage_reference | — | compliant | — | — |
| `raw_document_purge_status` | D metadata | fdh_statement_uploads.raw_document_purge_status | — | compliant | — | — |
| `raw_document_purge_due_at` | D metadata | fdh_statement_uploads.raw_document_purge_due_at | — | compliant | — | — |
| `raw_document_purged_at` | D metadata | fdh_statement_uploads.raw_document_purged_at | — | compliant | — | — |
| `purge_reason` | D metadata | fdh_statement_uploads.purge_reason | — | compliant | — | — |
| `purge_attempt_count` | D metadata | fdh_statement_uploads.purge_attempt_count | — | compliant | — | — |
| `last_purge_error_sanitised` | D metadata | fdh_statement_uploads.last_purge_error_sanitised | — | compliant | — | — |
| `created_at` | D metadata | fdh_statement_uploads.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_statement_uploads.updated_at | — | compliant | — | — |
| `approved_at` | D metadata | fdh_statement_uploads.approved_at | — | compliant | — | — |
| `storage_provider` | D metadata | fdh_statement_uploads.storage_provider | — | compliant | — | — |
| `uploaded_at` | D metadata | fdh_statement_uploads.uploaded_at | — | compliant | — | — |
| `validated_at` | D metadata | fdh_statement_uploads.validated_at | — | compliant | — | — |
| `processing_started_at` | D metadata | fdh_statement_uploads.processing_started_at | — | compliant | — | — |
| `processing_completed_at` | D metadata | fdh_statement_uploads.processing_completed_at | — | compliant | — | — |
| `purge_requested_at` | D metadata | fdh_statement_uploads.purge_requested_at | — | compliant | — | — |
| `duplicate_of_document_id` | D metadata | fdh_statement_uploads.duplicate_of_document_id | — | compliant | — | — |
| `delimiter_detected` | D metadata | fdh_statement_uploads.delimiter_detected | — | compliant | — | — |
| `encoding_detected` | D metadata | fdh_statement_uploads.encoding_detected | — | compliant | — | — |
| `header_row_index` | D metadata | fdh_statement_uploads.header_row_index | — | compliant | — | — |
| `detection_status` | D metadata | fdh_statement_uploads.detection_status | — | compliant | — | — |
| `detection_confidence` | D metadata | fdh_statement_uploads.detection_confidence | — | compliant | — | — |
| `detection_evidence` | D metadata | fdh_statement_uploads.detection_evidence | — | compliant | — | — |
| `mapping_template_id` | D metadata | fdh_statement_uploads.mapping_template_id | — | compliant | — | — |
| `certification_status` | D metadata | fdh_statement_uploads.certification_status | — | compliant | — | — |
| `declared_row_count` | D metadata | fdh_statement_uploads.declared_row_count | — | compliant | — | — |
| `parsed_row_count` | D metadata | fdh_statement_uploads.parsed_row_count | — | compliant | — | — |
| `certified_row_count` | D metadata | fdh_statement_uploads.certified_row_count | — | compliant | — | — |
| `duplicate_row_count` | D metadata | fdh_statement_uploads.duplicate_row_count | — | compliant | — | — |
| `adapter_key` | D metadata | fdh_statement_uploads.adapter_key | — | compliant | — | — |
| `adapter_version` | D metadata | fdh_statement_uploads.adapter_version | — | compliant | — | — |
| `page_count` | D metadata | fdh_statement_uploads.page_count | — | compliant | — | — |
| `pdf_classification` | D metadata | fdh_statement_uploads.pdf_classification | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_statement_uploads.extraction_confidence | — | compliant | — | — |
| `approved_by` | D metadata | fdh_statement_uploads.approved_by | — | compliant | — | — |
| `approval_version` | D metadata | fdh_statement_uploads.approval_version | — | compliant | — | — |
| `reopened_at` | D metadata | fdh_statement_uploads.reopened_at | — | compliant | — | — |
| `reopened_by` | D metadata | fdh_statement_uploads.reopened_by | — | compliant | — | — |
| `reopen_reason` | D metadata | fdh_statement_uploads.reopen_reason | — | compliant | — | — |
| `malware_scan_status` | D metadata | fdh_statement_uploads.malware_scan_status | — | compliant | — | — |
| `malware_scan_object_ref` | D metadata | fdh_statement_uploads.malware_scan_object_ref | — | compliant | — | — |
| `malware_scan_admission_deadline_at` | D metadata | fdh_statement_uploads.malware_scan_admission_deadline_at | — | compliant | — | — |
| `malware_scan_decided_at` | D metadata | fdh_statement_uploads.malware_scan_decided_at | — | compliant | — | — |

## economicTransactionType (owner WP-02)

### economic_type · enum_value · `enum:FDH_ECONOMIC_TRANSACTION_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `income` | B event | fdh_transactions(bucket=income) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `expense` | B event | fdh_transactions(bucket=spending) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `transfer` | B event | fdh_transactions(bucket=transfer) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `investment` | B event | fdh_transactions(bucket=investment) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `debt_principal` | B event | fdh_transactions(bucket=debt_principal) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `debt_interest` | B event | fdh_transactions(bucket=spending) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `refund` | B event | fdh_transactions(bucket=refund) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `asset_purchase` | B event | fdh_transactions(bucket=asset_purchase) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `asset_sale` | B event | fdh_transactions(bucket=asset_sale) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `tax` | B event | fdh_transactions(bucket=spending) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `fee` | B event | fdh_transactions(bucket=spending) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `cash_withdrawal` | B event | fdh_transactions(bucket=cash_withdrawal) | Expenses > actual (imported) / Income > actual | compliant | — | — |
| `unknown` | B event | fdh_transactions(bucket=unknown) | Expenses > actual (imported) / Income > actual | compliant | — | — |

## payslip (owner WP-09)

### payslip_native · ts_interface · `fdh:payslip/types.ts#PayrollExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `country` | D metadata | fdh_payroll_events.country_code | — | compliant | — | — |
| `currencyCode` | A state | income_sources.currency_code | Income tab | open_gap | GAP-03 (P1) | WP-09 |
| `payFrequencySource` | D metadata | fdh_payroll_events.pay_frequency_source | — | compliant | — | — |
| `grossPaySource` | D metadata | fdh_payroll_events.gross_pay_source | — | compliant | — | — |
| `employerName` | A state | income_sources.employer_name | Income tab | open_gap | GAP-04 (P1) | WP-09 |
| `payPeriodStart` | C evidence | evidence:fdh_payroll_events.pay_period_start | — | open_gap | GAP-07 (P2) | WP-09 |
| `payPeriodEnd` | C evidence | evidence:fdh_payroll_events.pay_period_end | — | open_gap | GAP-07 (P2) | WP-09 |
| `paymentDate` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | — | open_gap | GAP-07 (P2) | WP-09 |
| `payFrequency` | A state | income_sources.frequency (user-confirmed) | Income tab | open_gap | GAP-12 (P3) | WP-09 |
| `grossPay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `basePay` | C evidence | evidence:fdh_payroll_events.base_pay | — | open_gap | GAP-07 (P2) | WP-09 |
| `overtimePay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `bonusPay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `commissionPay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `allowancesTotal` | A state | income_sources.amount (inside recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `reimbursementsTotal` | E unsupported | not income (subtracted from recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `otherEarnings` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `taxWithheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | — | open_gap | GAP-07 (P2) | WP-09 |
| `employeeDeductionsTotal` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | — | open_gap | GAP-07 (P2) | WP-09 |
| `salarySacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice | — | open_gap | GAP-07 (P2) | WP-09 |
| `professionalTax` | C evidence | evidence:fdh_payroll_events.professional_tax | — | open_gap | GAP-07 (P2) | WP-09 |
| `employerRetirementContribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Import from payslip (evidence only) | compliant | — | — |
| `employeeRetirementContribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `employerNpsContribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | — | open_gap | GAP-07 (P2) | WP-09 |
| `employeeNpsContribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `netPay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | open_gap | GAP-09 (P2) | WP-03 |
| `ytdGross` | C evidence | evidence:fdh_payroll_events.ytd_gross (never summed) | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytdTax` | C evidence | evidence:fdh_payroll_events.ytd_tax | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytdNet` | C evidence | evidence:fdh_payroll_events.ytd_net | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytdEmployerRetirement` | C evidence | evidence:fdh_payroll_events.ytd_employer_retirement | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytdEmployeeRetirement` | C evidence | evidence:fdh_payroll_events.ytd_employee_retirement | — | open_gap | GAP-07 (P2) | WP-09 |
| `components` | C evidence | evidence:fdh_payroll_components | — | open_gap | GAP-07 (P2) | WP-09 |
| `parserName` | D metadata | fdh_payroll_events.parser_name | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_payroll_events.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_payroll_events.extraction_confidence | — | compliant | — | — |
| `warnings` | D metadata | fdh_payroll_events.review_status (warnings force review) | — | compliant | — | — |

### payslip_native · ts_interface · `fdh:payslip/types.ts#PayrollComponent`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `side` | C evidence | evidence:fdh_payroll_components.component_side | — | open_gap | GAP-07 (P2) | WP-09 |
| `type` | C evidence | evidence:fdh_payroll_components.component_type | — | open_gap | GAP-07 (P2) | WP-09 |
| `labelRaw` | C evidence | evidence:fdh_payroll_components.label_raw | — | open_gap | GAP-07 (P2) | WP-09 |
| `amount` | C evidence | evidence:fdh_payroll_components.amount | — | open_gap | GAP-07 (P2) | WP-09 |
| `isYearToDate` | C evidence | evidence:fdh_payroll_components.is_year_to_date | — | open_gap | GAP-07 (P2) | WP-09 |

### payslip_ai · zod_schema · `aie:payslip/schema.ts#payslipDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `employerName` | A state | income_sources.employer_name | Income tab | open_gap | GAP-04 (P1) | WP-09 |
| `payPeriodStart` | C evidence | evidence:fdh_payroll_events.pay_period_start | — | open_gap | GAP-07 (P2) | WP-09 |
| `payPeriodEnd` | C evidence | evidence:fdh_payroll_events.pay_period_end | — | open_gap | GAP-07 (P2) | WP-09 |
| `paymentDate` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | — | open_gap | GAP-07 (P2) | WP-09 |
| `payFrequency` | A state | income_sources.frequency (user-confirmed) | Income tab | open_gap | GAP-12 (P3) | WP-09 |
| `grossPay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `basePay` | C evidence | evidence:fdh_payroll_events.base_pay | — | open_gap | GAP-07 (P2) | WP-09 |
| `overtimePay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `bonusPay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `commissionPay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `allowancesTotal` | A state | income_sources.amount (inside recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `reimbursementsTotal` | E unsupported | not income (subtracted from recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `otherEarnings` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `taxWithheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | — | open_gap | GAP-07 (P2) | WP-09 |
| `employeeDeductionsTotal` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | — | open_gap | GAP-07 (P2) | WP-09 |
| `salarySacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice | — | open_gap | GAP-07 (P2) | WP-09 |
| `professionalTax` | C evidence | evidence:fdh_payroll_events.professional_tax | — | open_gap | GAP-07 (P2) | WP-09 |
| `employerRetirementContribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Import from payslip (evidence only) | compliant | — | — |
| `employeeRetirementContribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `employerNpsContribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | — | open_gap | GAP-07 (P2) | WP-09 |
| `employeeNpsContribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `netPay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | open_gap | GAP-09 (P2) | WP-03 |

### payslip_native · db_column · `db:fdh_payroll_events`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_payroll_events.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_payroll_events.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_payroll_events.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_payroll_events.statement_upload_id | — | compliant | — | — |
| `employer_normalised` | D metadata | fdh_payroll_events.employer_normalised | — | compliant | — | — |
| `country_code` | D metadata | fdh_payroll_events.country_code | — | compliant | — | — |
| `currency_code` | A state | income_sources.currency_code | Income tab | open_gap | GAP-03 (P1) | WP-09 |
| `pay_frequency_source` | D metadata | fdh_payroll_events.pay_frequency_source | — | compliant | — | — |
| `employer_name` | A state | income_sources.employer_name | Income tab | open_gap | GAP-04 (P1) | WP-09 |
| `pay_period_start` | C evidence | evidence:fdh_payroll_events.pay_period_start | — | open_gap | GAP-07 (P2) | WP-09 |
| `pay_period_end` | C evidence | evidence:fdh_payroll_events.pay_period_end | — | open_gap | GAP-07 (P2) | WP-09 |
| `payment_date` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | — | open_gap | GAP-07 (P2) | WP-09 |
| `pay_frequency` | A state | income_sources.frequency (user-confirmed) | Income tab | open_gap | GAP-12 (P3) | WP-09 |
| `gross_pay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `base_pay` | C evidence | evidence:fdh_payroll_events.base_pay | — | open_gap | GAP-07 (P2) | WP-09 |
| `overtime_pay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `bonus_pay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `commission_pay` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `allowances_total` | A state | income_sources.amount (inside recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `reimbursements_total` | E unsupported | not income (subtracted from recurring gross) | — | open_gap | GAP-07 (P2) | WP-09 |
| `other_earnings` | B event | fdh_transactions(income, one-off, dated, deduped against the matched bank credit -- D-06) | — | open_gap | GAP-08 (P2) | WP-09 |
| `tax_withheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | — | open_gap | GAP-07 (P2) | WP-09 |
| `employee_deductions_total` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | — | open_gap | GAP-07 (P2) | WP-09 |
| `salary_sacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice | — | open_gap | GAP-07 (P2) | WP-09 |
| `professional_tax` | C evidence | evidence:fdh_payroll_events.professional_tax | — | open_gap | GAP-07 (P2) | WP-09 |
| `employer_retirement_contribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Import from payslip (evidence only) | compliant | — | — |
| `employee_retirement_contribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `employer_nps_contribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | — | open_gap | GAP-07 (P2) | WP-09 |
| `employee_nps_contribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | — | open_gap | GAP-07 (P2) | WP-09 |
| `net_pay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | open_gap | GAP-09 (P2) | WP-03 |
| `ytd_gross` | C evidence | evidence:fdh_payroll_events.ytd_gross | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytd_tax` | C evidence | evidence:fdh_payroll_events.ytd_tax | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytd_net` | C evidence | evidence:fdh_payroll_events.ytd_net | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytd_employer_retirement` | C evidence | evidence:fdh_payroll_events.ytd_employer_retirement | — | open_gap | GAP-07 (P2) | WP-09 |
| `ytd_employee_retirement` | C evidence | evidence:fdh_payroll_events.ytd_employee_retirement | — | open_gap | GAP-07 (P2) | WP-09 |
| `parser_name` | D metadata | fdh_payroll_events.parser_name | — | compliant | — | — |
| `parser_version` | D metadata | fdh_payroll_events.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_payroll_events.extraction_confidence | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_payroll_events.reconciliation_status | — | compliant | — | — |
| `reconciliation_variance` | D metadata | fdh_payroll_events.reconciliation_variance | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_payroll_events.bank_match_status | — | open_gap | GAP-10 (P2) | WP-09 |
| `bank_match_transaction_id` | D metadata | dedup link: the payslip and its bank credit are ONE income event (selectIncome) | — | open_gap | GAP-01 (P0) | WP-03 |
| `bank_match_confidence` | D metadata | fdh_payroll_events.bank_match_confidence | — | compliant | — | — |
| `review_status` | D metadata | fdh_payroll_events.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_payroll_events.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_payroll_events.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_payroll_events.approved_by | — | compliant | — | — |
| `superseded_by_payroll_event_id` | D metadata | fdh_payroll_events.superseded_by_payroll_event_id | — | open_gap | GAP-15 (P3) | WP-09 |
| `payslip_fingerprint` | D metadata | fdh_payroll_events.payslip_fingerprint | — | compliant | — | — |
| `created_at` | D metadata | fdh_payroll_events.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_payroll_events.updated_at | — | compliant | — | — |
| `gross_pay_source` | D metadata | fdh_payroll_events.gross_pay_source | — | compliant | — | — |
| `user_corrected_fields` | D metadata | fdh_payroll_events.user_corrected_fields | — | compliant | — | — |
| `last_corrected_at` | D metadata | fdh_payroll_events.last_corrected_at | — | compliant | — | — |
| `last_corrected_by` | D metadata | fdh_payroll_events.last_corrected_by | — | compliant | — | — |
| `income_owner` | A state | income_sources.owner (self / spouse, chosen at upload) | — | open_gap | GAP-05 (P1) | WP-09 |

### payslip_native · db_column · `db:fdh_payroll_components`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_payroll_components.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_payroll_components.user_id | — | compliant | — | — |
| `payroll_event_id` | D metadata | fdh_payroll_components.payroll_event_id | — | compliant | — | — |
| `component_side` | C evidence | evidence:fdh_payroll_components.component_side | — | open_gap | GAP-07 (P2) | WP-09 |
| `component_type` | C evidence | evidence:fdh_payroll_components.component_type | — | open_gap | GAP-07 (P2) | WP-09 |
| `label_raw` | C evidence | evidence:fdh_payroll_components.label_raw | — | open_gap | GAP-07 (P2) | WP-09 |
| `amount` | C evidence | evidence:fdh_payroll_components.amount | — | open_gap | GAP-07 (P2) | WP-09 |
| `is_year_to_date` | C evidence | evidence:fdh_payroll_components.is_year_to_date | — | open_gap | GAP-07 (P2) | WP-09 |
| `created_at` | D metadata | fdh_payroll_components.created_at | — | compliant | — | — |

## liabilityStatement (owner WP-10)

### liability_native · ts_interface · `fdh:liability/types.ts#LiabilityStatementExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `statementType` | D metadata | fdh_liability_statements.statement_type | — | compliant | — | — |
| `country` | A state | liabilities.country_code | Liabilities tab | compliant | — | — |
| `currencyCode` | A state | liabilities.currency_code (unsupported currency refused) | Liabilities tab | open_gap | G13 (P3) | WP-11 |
| `facilityType` | A state | liabilities.debt_type | Liabilities tab | compliant | — | — |
| `nickname` | E unsupported | not persisted (a display nickname is not a canonical fact) | — | open_gap | G6 (P2) | WP-10 |
| `institutionName` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `maskedIdentifier` | A state | liabilities.masked_identifier | — | open_gap | G7 (P1) | WP-07 |
| `statementPeriodStart` | C evidence | evidence:fdh_liability_statements.statement_period_start | — | open_gap | G7 (P1) | WP-11 |
| `statementPeriodEnd` | C evidence | evidence:fdh_liability_statements.statement_period_end | — | open_gap | G7 (P1) | WP-11 |
| `statementDate` | C evidence | evidence:fdh_liability_statements.statement_date | — | open_gap | G7 (P1) | WP-11 |
| `dueDate` | A state | liabilities.due_date | — | open_gap | G7 (P1) | WP-07 |
| `openingBalance` | C evidence | evidence:fdh_liability_statements.opening_balance | — | open_gap | G7 (P1) | WP-11 |
| `closingBalance` | A state | liabilities.balance (card) | Liabilities tab | open_gap | G7 (P1) | WP-07 |
| `creditLimit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimumPayment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | open_gap | X-01 (P1) | WP-11 |
| `interestRate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab | open_gap | G7 (P1) | WP-11 |
| `availableCredit` | E unsupported | not populated (shown as "Not shown on statement") | — | open_gap | G6 (P2) | WP-10 |
| `openingPrincipal` | C evidence | evidence:fdh_liability_statements.opening_principal | — | open_gap | G7 (P1) | WP-11 |
| `closingPrincipal` | A state | liabilities.balance (loan) | Liabilities tab | open_gap | G7 (P1) | WP-07 |
| `rateType` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `repaymentFrequency` | E unsupported | not populated (proposal reads null) | — | open_gap | G6 (P2) | WP-10 |
| `maturityDate` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `arrearsAmount` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `activities` | B event | fdh_transactions (card/loan facility ledger row, WP-11) | — | open_gap | G1 (P0) | WP-11 |
| `parserName` | D metadata | fdh_liability_statements.parser_name | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_liability_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_liability_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | E unsupported | fdh_liability_statements.extraction_warnings (0207) | — | open_gap | G6 (P2) | WP-10 |

### liability_native · ts_interface · `fdh:liability/types.ts#LiabilityStatementActivity`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | — | open_gap | G1 (P0) | WP-11 |
| `activityDate` | B event | fdh_transactions.transaction_date | — | open_gap | G1 (P0) | WP-11 |
| `amount` | B event | fdh_transactions.amount_original | — | open_gap | G1 (P0) | WP-11 |
| `descriptionRaw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | — | open_gap | G1 (P0) | WP-11 |
| `merchantRaw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw | — | open_gap | G1 (P0) | WP-11 |
| `principalComponent` | B event | fdh_transaction_allocations (debt_principal) | — | open_gap | G2 (P1) | WP-11 |
| `interestComponent` | B event | fdh_transaction_allocations (debt_interest) | — | open_gap | G2 (P1) | WP-11 |
| `feeComponent` | B event | fdh_transaction_allocations (fee) | — | open_gap | G2 (P1) | WP-11 |
| `gstAmountRaw` | C evidence | evidence:fdh_liability_statement_activities.gst_amount_raw (0207; never summed) | — | open_gap | G6 (P2) | WP-10 |
| `sourceRowNumber` | D metadata | fdh_liability_statement_activities.source_row_number | — | compliant | — | — |

### liability_ai · zod_schema · `aie:liability/schema.ts#liabilityStatementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `institutionName` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `maskedIdentifier` | A state | liabilities.masked_identifier | — | open_gap | G7 (P1) | WP-07 |
| `statementPeriodStart` | C evidence | evidence:fdh_liability_statements.statement_period_start | — | open_gap | G7 (P1) | WP-11 |
| `statementPeriodEnd` | C evidence | evidence:fdh_liability_statements.statement_period_end | — | open_gap | G7 (P1) | WP-11 |
| `statementDate` | C evidence | evidence:fdh_liability_statements.statement_date | — | open_gap | G7 (P1) | WP-11 |
| `dueDate` | A state | liabilities.due_date | — | open_gap | G7 (P1) | WP-07 |
| `openingBalance` | C evidence | evidence:fdh_liability_statements.opening_balance | — | open_gap | G7 (P1) | WP-11 |
| `closingBalance` | A state | liabilities.balance (card) | Liabilities tab | open_gap | G7 (P1) | WP-07 |
| `creditLimit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimumPayment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | open_gap | X-01 (P1) | WP-11 |
| `interestRate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab | open_gap | G7 (P1) | WP-11 |
| `allActivitiesListed` | C evidence | evidence: AI draft completeness flag | — | open_gap | G6 (P2) | WP-10 |
| `activities` | B event | fdh_transactions (card/loan facility ledger row, WP-11) | — | open_gap | G1 (P0) | WP-11 |

### liability_ai · zod_schema · `aie:liability/schema.ts#liabilityStatementActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | — | open_gap | G1 (P0) | WP-11 |
| `activityDate` | B event | fdh_transactions.transaction_date | — | open_gap | G1 (P0) | WP-11 |
| `amount` | B event | fdh_transactions.amount_original | — | open_gap | G1 (P0) | WP-11 |
| `descriptionRaw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | — | open_gap | G1 (P0) | WP-11 |
| `merchantRaw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw | — | open_gap | G1 (P0) | WP-11 |
| `principalComponent` | B event | fdh_transaction_allocations (debt_principal) | — | open_gap | G2 (P1) | WP-11 |
| `interestComponent` | B event | fdh_transaction_allocations (debt_interest) | — | open_gap | G2 (P1) | WP-11 |
| `feeComponent` | B event | fdh_transaction_allocations (fee) | — | open_gap | G2 (P1) | WP-11 |

### liability_native · db_column · `db:fdh_liability_statements`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_liability_statements.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_liability_statements.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_liability_statements.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_liability_statements.statement_upload_id | — | compliant | — | — |
| `financial_account_id` | D metadata | fdh_liability_statements.financial_account_id (set by the Apply RPC) | — | open_gap | G7 (P1) | WP-11 |
| `liability_id` | D metadata | fdh_liability_statements.liability_id (set by the Apply RPC) | — | open_gap | G7 (P1) | WP-11 |
| `statement_type` | D metadata | fdh_liability_statements.statement_type | — | compliant | — | — |
| `facility_type` | A state | liabilities.debt_type | Liabilities tab | compliant | — | — |
| `country_code` | A state | liabilities.country_code | Liabilities tab | compliant | — | — |
| `currency_code` | A state | liabilities.currency_code (unsupported currency refused) | Liabilities tab | open_gap | G13 (P3) | WP-11 |
| `institution_name` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `masked_identifier` | A state | liabilities.masked_identifier | — | open_gap | G7 (P1) | WP-07 |
| `statement_period_start` | C evidence | evidence:fdh_liability_statements.statement_period_start | — | open_gap | G7 (P1) | WP-11 |
| `statement_period_end` | C evidence | evidence:fdh_liability_statements.statement_period_end | — | open_gap | G7 (P1) | WP-11 |
| `statement_date` | C evidence | evidence:fdh_liability_statements.statement_date | — | open_gap | G7 (P1) | WP-11 |
| `due_date` | A state | liabilities.due_date | — | open_gap | G7 (P1) | WP-07 |
| `opening_balance` | C evidence | evidence:fdh_liability_statements.opening_balance | — | open_gap | G7 (P1) | WP-11 |
| `closing_balance` | A state | liabilities.balance (card) | Liabilities tab | open_gap | G7 (P1) | WP-07 |
| `credit_limit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimum_payment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | open_gap | X-01 (P1) | WP-11 |
| `interest_rate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab | open_gap | G7 (P1) | WP-11 |
| `available_credit` | E unsupported | not populated (shown as "Not shown on statement") | — | open_gap | G6 (P2) | WP-10 |
| `opening_principal` | C evidence | evidence:fdh_liability_statements.opening_principal | — | open_gap | G7 (P1) | WP-11 |
| `closing_principal` | A state | liabilities.balance (loan) | Liabilities tab | open_gap | G7 (P1) | WP-07 |
| `rate_type` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `repayment_frequency` | E unsupported | not populated (proposal reads null) | — | open_gap | G6 (P2) | WP-10 |
| `maturity_date` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `arrears_amount` | E unsupported | not populated | — | open_gap | G6 (P2) | WP-10 |
| `purchases_total` | C evidence | evidence:fdh_liability_statements.purchases_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `cash_advances_total` | C evidence | evidence:fdh_liability_statements.cash_advances_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `interest_total` | C evidence | evidence:fdh_liability_statements.interest_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `fees_total` | C evidence | evidence:fdh_liability_statements.fees_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `payments_total` | C evidence | evidence:fdh_liability_statements.payments_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `refunds_total` | C evidence | evidence:fdh_liability_statements.refunds_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `adjustments_total` | C evidence | evidence:fdh_liability_statements.adjustments_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `drawdowns_total` | C evidence | evidence:fdh_liability_statements.drawdowns_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `capitalised_total` | C evidence | evidence:fdh_liability_statements.capitalised_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `principal_repayments_total` | C evidence | evidence:fdh_liability_statements.principal_repayments_total (must equal the ledger sum per type) | — | open_gap | G5 (P1) | WP-10 |
| `reconciliation_status` | D metadata | fdh_liability_statements.reconciliation_status | — | compliant | — | — |
| `reconciliation_variance` | D metadata | fdh_liability_statements.reconciliation_variance | — | compliant | — | — |
| `parser_name` | D metadata | fdh_liability_statements.parser_name | — | compliant | — | — |
| `parser_version` | D metadata | fdh_liability_statements.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_liability_statements.extraction_confidence | — | compliant | — | — |
| `review_status` | D metadata | fdh_liability_statements.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_liability_statements.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_liability_statements.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_liability_statements.approved_by | — | compliant | — | — |
| `duplicate_of_statement_id` | D metadata | fdh_liability_statements.duplicate_of_statement_id | — | compliant | — | — |
| `supersedes_statement_id` | D metadata | fdh_liability_statements.supersedes_statement_id | — | compliant | — | — |
| `created_at` | D metadata | fdh_liability_statements.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_liability_statements.updated_at | — | compliant | — | — |
| `user_corrected_fields` | D metadata | fdh_liability_statements.user_corrected_fields | — | compliant | — | — |
| `last_corrected_at` | D metadata | fdh_liability_statements.last_corrected_at | — | compliant | — | — |
| `last_corrected_by` | D metadata | fdh_liability_statements.last_corrected_by | — | compliant | — | — |
| `extraction_warnings` | E unsupported | fdh_liability_statements.extraction_warnings (0207; rendered by WP-11) | — | open_gap | G6 (P2) | WP-10 |

### liability_native · db_column · `db:fdh_liability_statement_activities`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_liability_statement_activities.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_liability_statement_activities.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_liability_statement_activities.statement_id | — | compliant | — | — |
| `activity_type` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | — | open_gap | G1 (P0) | WP-11 |
| `activity_date` | B event | fdh_transactions.transaction_date | — | open_gap | G1 (P0) | WP-11 |
| `amount` | B event | fdh_transactions.amount_original | — | open_gap | G1 (P0) | WP-11 |
| `description_raw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | — | open_gap | G1 (P0) | WP-11 |
| `merchant_raw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw | — | open_gap | G1 (P0) | WP-11 |
| `principal_component` | B event | fdh_transaction_allocations (debt_principal) | — | open_gap | G2 (P1) | WP-11 |
| `interest_component` | B event | fdh_transaction_allocations (debt_interest) | — | open_gap | G2 (P1) | WP-11 |
| `fee_component` | B event | fdh_transaction_allocations (fee) | — | open_gap | G2 (P1) | WP-11 |
| `currency_code` | B event | fdh_transactions.currency_original | — | open_gap | G1 (P0) | WP-11 |
| `description_clean` | C evidence | evidence:fdh_liability_statement_activities.description_clean | — | open_gap | G1 (P0) | WP-11 |
| `merchant_id` | D metadata | fdh_liability_statement_activities.merchant_id (category lives on the ledger row) | — | open_gap | G1 (P0) | WP-11 |
| `category_id` | B event | fdh_transactions.category_id (R8 category only, never economic type) | — | open_gap | G1 (P0) | WP-11 |
| `linked_transaction_id` | D metadata | the bank leg of a PAYMENT (source of the confirmed settlement link) | — | open_gap | G4 (P1) | WP-10 |
| `bank_match_status` | D metadata | fdh_liability_statement_activities.bank_match_status | — | open_gap | G4 (P1) | WP-10 |
| `review_status` | D metadata | fdh_liability_statement_activities.review_status | — | compliant | — | — |
| `source_row_number` | D metadata | fdh_liability_statement_activities.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_liability_statement_activities.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_liability_statement_activities.updated_at | — | compliant | — | — |
| `ledger_transaction_id` | D metadata | the fdh_transactions row this activity became (0207; set by WP-11) | — | open_gap | G1 (P0) | WP-11 |
| `gst_amount_raw` | C evidence | evidence:fdh_liability_statement_activities.gst_amount_raw (0207; never summed) | — | open_gap | G6 (P2) | WP-10 |

## liabilityActivityLedger (owner WP-11)

### liability_ledger · enum_value · `enum:LIABILITY_ACTIVITY_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `PURCHASE` | B event | fdh_transactions(card facility debit, type=expense, R8-categorised) | — | open_gap | G1 (P0) | WP-11 |
| `REFUND` | B event | fdh_transactions(card facility credit, type=refund; optional refund_original link) | — | open_gap | G1 (P0) | WP-11 |
| `PAYMENT` | B event | fdh_transactions(facility credit, type=transfer) + fdh_transaction_links(credit_card_settlement \| loan_payment, confirmed) | — | open_gap | G1 (P0) | WP-11 |
| `CASH_ADVANCE` | B event | fdh_transactions(facility debit, type=cash_withdrawal) | — | open_gap | G1 (P0) | WP-11 |
| `INTEREST` | B event | fdh_transactions(facility debit, type=debt_interest) | — | open_gap | G1 (P0) | WP-11 |
| `FEE` | B event | fdh_transactions(facility debit, type=fee) | — | open_gap | G1 (P0) | WP-11 |
| `PRINCIPAL` | B event | fdh_transactions(loan credit, type=debt_principal) | — | open_gap | G1 (P0) | WP-11 |
| `LOAN_ADVANCE` | B event | fdh_transactions(loan debit, type=transfer) | — | open_gap | G1 (P0) | WP-11 |
| `ADJUSTMENT` | B event | fdh_transactions(after the user resolves it; Apply is blocked until then) | — | open_gap | G5 (P1) | WP-11 |
| `OTHER` | B event | fdh_transactions(after the user resolves it; Apply is blocked until then) | — | open_gap | G5 (P1) | WP-11 |

## auInvestmentStatement (owner WP-12)

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuInvestmentStatementExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `statementType` | C evidence | evidence:fdh_investment_statements.statement_type (import history) | — | open_gap | INV-G9 (P2) | WP-12 |
| `country` | D metadata | fdh_investment_statements.investment_jurisdiction | — | compliant | — | — |
| `currencyCode` | A state | ii_accounts.currency_code | Investment Intelligence screens | compliant | — | — |
| `institutionName` | A state | ii_accounts.institution_name | Investment Intelligence screens | compliant | — | — |
| `maskedAccountIdentifier` | A state | ii_accounts.account_number_masked ("Add as new account") | — | open_gap | INV-G3 (P0) | WP-12 |
| `nickname` | E unsupported | not persisted as a canonical fact | — | open_gap | INV-G9 (P2) | WP-12 |
| `statementDate` | C evidence | evidence:fdh_investment_statements.statement_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statementPeriodStart` | C evidence | evidence:fdh_investment_statements.statement_start_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statementPeriodEnd` | C evidence | evidence:fdh_investment_statements.statement_end_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `openingPortfolioValue` | C evidence | evidence:fdh_investment_statements.opening_portfolio_value (reconciliation input) | — | open_gap | INV-G8 (P2) | WP-12 |
| `closingPortfolioValue` | C evidence | evidence:fdh_investment_statements.closing_portfolio_value (reconciliation input) | — | open_gap | INV-G8 (P2) | WP-12 |
| `cashBalance` | E unsupported | broker cash unsupported for now (D-11), shown with visible text | — | open_gap | INV-G8 (P2) | WP-12 |
| `positions` | A state | ii_holding_snapshots | — | open_gap | INV-G2 (P0) | WP-12 |
| `transactions` | B event | ii_transactions | — | open_gap | INV-G1 (P0) | WP-12 |
| `parserName` | D metadata | fdh_investment_statements.parser | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_investment_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_investment_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | E unsupported | fdh_investment_statements.extraction_warnings (0207) | — | open_gap | INV-G6 (P1) | WP-12 |

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuStatementPositionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `securityNameRaw` | A state | ii_instruments.instrument_name ("Create security") | — | open_gap | INV-G3 (P0) | WP-12 |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | — | open_gap | INV-G2 (P0) | WP-12 |
| `unitPrice` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | — | open_gap | INV-G7 (P2) | WP-12 |
| `marketValue` | A state | ii_holding_snapshots.value (null refused, never 0) | — | open_gap | INV-G7 (P2) | WP-12 |
| `valuationDate` | A state | ii_holding_snapshots.as_of_date (parsed) | — | open_gap | INV-G6 (P1) | WP-12 |
| `exchange` | A state | ii_instrument_identifiers (defaults ASX) | Investment Intelligence screens | compliant | — | — |
| `currencyCode` | A state | ii_holding_snapshots.currency_code | Investment Intelligence screens | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_investment_statement_positions.source_row_number | — | compliant | — | — |

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuStatementTransactionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionType` | B event | ii_transactions.transaction_type (+ bank leg corroboration) | — | open_gap | INV-G4 (P1) | WP-12 |
| `tradeDate` | B event | ii_transactions.transaction_date | Investment Intelligence screens | compliant | — | — |
| `settlementDate` | C evidence | evidence:fdh_investment_statement_activities.settlement_date (import history) | — | open_gap | INV-G7 (P2) | WP-12 |
| `securityNameRaw` | A state | ii_instruments (match input) | Investment Intelligence screens | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens | compliant | — | — |
| `unitPrice` | B event | ii_transactions.price_per_unit | Investment Intelligence screens | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `currencyCode` | B event | ii_transactions.currency_code | Investment Intelligence screens | compliant | — | — |
| `descriptionRaw` | C evidence | ii_transactions.source_description | — | open_gap | INV-G7 (P2) | WP-12 |
| `brokerageRaw` | B event | ii_transactions.fees (parsed) | — | open_gap | INV-G7 (P2) | WP-12 |
| `frankingCreditRaw` | C evidence | evidence: franking credit (tax), visible | — | open_gap | INV-G7 (P2) | WP-12 |
| `withholdingTaxRaw` | C evidence | ii_transactions.taxes | — | open_gap | INV-G7 (P2) | WP-12 |
| `sourceRowNumber` | D metadata | fdh_investment_statement_activities.source_row_number | — | compliant | — | — |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `institutionName` | A state | ii_accounts.institution_name | Investment Intelligence screens | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_investment_statements.statement_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statementPeriodStart` | C evidence | evidence:fdh_investment_statements.statement_start_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statementPeriodEnd` | C evidence | evidence:fdh_investment_statements.statement_end_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `allRowsListed` | E unsupported | incomplete extraction must block Apply (40-row cap) | — | open_gap | INV-G11 (P3) | WP-12 |
| `holdings` | A state | ii_holding_snapshots | — | open_gap | INV-G2 (P0) | WP-12 |
| `transactions` | B event | ii_transactions | — | open_gap | INV-G1 (P0) | WP-12 |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentHoldingSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `securityNameRaw` | A state | ii_instruments.instrument_name ("Create security") | — | open_gap | INV-G3 (P0) | WP-12 |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | — | open_gap | INV-G2 (P0) | WP-12 |
| `unitPrice` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | — | open_gap | INV-G7 (P2) | WP-12 |
| `marketValue` | A state | ii_holding_snapshots.value (null refused, never 0) | — | open_gap | INV-G7 (P2) | WP-12 |
| `valuationDate` | A state | ii_holding_snapshots.as_of_date (parsed) | — | open_gap | INV-G6 (P1) | WP-12 |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionType` | B event | ii_transactions.transaction_type (+ bank leg corroboration) | — | open_gap | INV-G4 (P1) | WP-12 |
| `tradeDate` | B event | ii_transactions.transaction_date | Investment Intelligence screens | compliant | — | — |
| `settlementDate` | C evidence | evidence:fdh_investment_statement_activities.settlement_date (import history) | — | open_gap | INV-G7 (P2) | WP-12 |
| `securityNameRaw` | A state | ii_instruments (match input) | Investment Intelligence screens | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens | compliant | — | — |
| `unitPrice` | B event | ii_transactions.price_per_unit | Investment Intelligence screens | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens | compliant | — | — |
| `brokerage` | B event | ii_transactions.fees | — | open_gap | INV-G7 (P2) | WP-12 |

### au_investment_native · enum_value · `enum:AU_STATEMENT_TRANSACTION_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `BUY` | B event | ii_transactions(purchase); the bank funding leg is investment (spending 0) | — | open_gap | INV-G4 (P1) | WP-12 |
| `SELL` | B event | ii_transactions(sale); the bank proceeds leg is asset_sale (ordinary income 0) | — | open_gap | INV-G4 (P1) | WP-12 |
| `DIVIDEND` | B event | ii_transactions(dividend); the bank credit is the single household-income leg | — | open_gap | INV-G4 (P1) | WP-12 |
| `DISTRIBUTION` | B event | ii_transactions(distribution subtype; today recorded as dividend) | — | open_gap | INV-G7 (P2) | WP-12 |
| `INTEREST` | E unsupported | broker cash interest: skipped, reason shown (D-11) | — | open_gap | INV-G8 (P2) | WP-12 |
| `BROKERAGE` | B event | ii_transactions(fee) | Investment Intelligence screens | compliant | — | — |
| `FEE` | B event | ii_transactions(fee) | Investment Intelligence screens | compliant | — | — |
| `TRANSFER_IN` | B event | ii_transactions(transfer_in) | Investment Intelligence screens | compliant | — | — |
| `TRANSFER_OUT` | B event | ii_transactions(transfer_out) | Investment Intelligence screens | compliant | — | — |
| `CASH_DEPOSIT` | E unsupported | broker cash: skipped, reason shown (D-11) | — | open_gap | INV-G8 (P2) | WP-12 |
| `CASH_WITHDRAWAL` | E unsupported | broker cash: skipped, reason shown (D-11) | — | open_gap | INV-G8 (P2) | WP-12 |
| `DRP` | B event | ii_transactions(reinvestment) | Investment Intelligence screens | compliant | — | — |
| `CORPORATE_ACTION_EVIDENCE` | E unsupported | skipped; the reason must be shown | — | open_gap | INV-G9 (P2) | WP-12 |
| `OTHER` | E unsupported | skipped; the reason must be shown | — | open_gap | INV-G9 (P2) | WP-12 |
| `UNKNOWN` | E unsupported | skipped; the reason must be shown | — | open_gap | INV-G9 (P2) | WP-12 |

### au_investment_native · db_column · `db:fdh_investment_statements`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_investment_statements.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_investment_statements.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_investment_statements.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_investment_statements.statement_upload_id | — | compliant | — | — |
| `canonical_account_id` | D metadata | fdh_investment_statements.canonical_account_id | — | compliant | — | — |
| `statement_type` | C evidence | evidence:fdh_investment_statements.statement_type | — | open_gap | INV-G9 (P2) | WP-12 |
| `investment_jurisdiction` | D metadata | fdh_investment_statements.investment_jurisdiction | — | compliant | — | — |
| `institution_name` | A state | ii_accounts.institution_name | Investment Intelligence screens | compliant | — | — |
| `masked_account_identifier` | A state | ii_accounts.account_number_masked | — | open_gap | INV-G3 (P0) | WP-12 |
| `nickname` | E unsupported | never set | — | open_gap | INV-G9 (P2) | WP-12 |
| `base_currency` | A state | ii_accounts.currency_code | Investment Intelligence screens | compliant | — | — |
| `statement_date` | C evidence | evidence:fdh_investment_statements.statement_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statement_start_date` | C evidence | evidence:fdh_investment_statements.statement_start_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `statement_end_date` | C evidence | evidence:fdh_investment_statements.statement_end_date | — | open_gap | INV-G9 (P2) | WP-12 |
| `opening_portfolio_value` | C evidence | evidence:fdh_investment_statements.opening_portfolio_value | — | open_gap | INV-G8 (P2) | WP-12 |
| `closing_portfolio_value` | C evidence | evidence:fdh_investment_statements.closing_portfolio_value | — | open_gap | INV-G8 (P2) | WP-12 |
| `cash_balance` | E unsupported | broker cash unsupported for now (D-11) | — | open_gap | INV-G8 (P2) | WP-12 |
| `parser` | D metadata | fdh_investment_statements.parser | — | compliant | — | — |
| `parser_version` | D metadata | fdh_investment_statements.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_investment_statements.extraction_confidence | — | compliant | — | — |
| `extraction_status` | D metadata | fdh_investment_statements.extraction_status | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_investment_statements.reconciliation_status (computed at persist) | — | open_gap | INV-G6 (P1) | WP-12 |
| `review_status` | D metadata | fdh_investment_statements.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_investment_statements.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_investment_statements.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_investment_statements.approved_by | — | compliant | — | — |
| `duplicate_of_statement_id` | D metadata | fdh_investment_statements.duplicate_of_statement_id | — | compliant | — | — |
| `supersedes_statement_id` | D metadata | fdh_investment_statements.supersedes_statement_id | — | compliant | — | — |
| `source_provenance` | D metadata | fdh_investment_statements.source_provenance | — | compliant | — | — |
| `created_at` | D metadata | fdh_investment_statements.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_investment_statements.updated_at | — | compliant | — | — |
| `extraction_warnings` | E unsupported | fdh_investment_statements.extraction_warnings (0207) | — | open_gap | INV-G6 (P1) | WP-12 |

### au_investment_native · db_column · `db:fdh_investment_statement_positions`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_investment_statement_positions.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_investment_statement_positions.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_investment_statement_positions.statement_id | — | compliant | — | — |
| `security_name_raw` | A state | ii_instruments.instrument_name ("Create security") | — | open_gap | INV-G3 (P0) | WP-12 |
| `ticker_raw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | — | open_gap | INV-G2 (P0) | WP-12 |
| `unit_price` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | — | open_gap | INV-G7 (P2) | WP-12 |
| `market_value` | A state | ii_holding_snapshots.value (null refused, never 0) | — | open_gap | INV-G7 (P2) | WP-12 |
| `valuation_date` | A state | ii_holding_snapshots.as_of_date (parsed) | — | open_gap | INV-G6 (P1) | WP-12 |
| `exchange` | A state | ii_instrument_identifiers | Investment Intelligence screens | compliant | — | — |
| `currency_code` | A state | ii_holding_snapshots.currency_code | Investment Intelligence screens | compliant | — | — |
| `security_match_status` | D metadata | fdh_investment_statement_positions.security_match_status | — | compliant | — | — |
| `matched_instrument_id` | D metadata | fdh_investment_statement_positions.matched_instrument_id | — | compliant | — | — |
| `apply_status` | D metadata | fdh_investment_statement_positions.apply_status (must start pending) | — | open_gap | INV-G2 (P0) | WP-12 |
| `canonical_holding_snapshot_id` | D metadata | fdh_investment_statement_positions.canonical_holding_snapshot_id | — | compliant | — | — |
| `applied_at` | D metadata | fdh_investment_statement_positions.applied_at | — | compliant | — | — |
| `applied_by` | D metadata | fdh_investment_statement_positions.applied_by | — | compliant | — | — |
| `source_row_number` | D metadata | fdh_investment_statement_positions.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_investment_statement_positions.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_investment_statement_positions.updated_at | — | compliant | — | — |

### au_investment_native · db_column · `db:fdh_investment_statement_activities`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_investment_statement_activities.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_investment_statement_activities.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_investment_statement_activities.statement_id | — | compliant | — | — |
| `activity_type` | B event | ii_transactions.transaction_type (+ bank leg corroboration) | — | open_gap | INV-G4 (P1) | WP-12 |
| `trade_date` | B event | ii_transactions.transaction_date | Investment Intelligence screens | compliant | — | — |
| `settlement_date` | C evidence | evidence:fdh_investment_statement_activities.settlement_date (import history) | — | open_gap | INV-G7 (P2) | WP-12 |
| `security_name_raw` | A state | ii_instruments (match input) | Investment Intelligence screens | compliant | — | — |
| `ticker_raw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens | compliant | — | — |
| `unit_price` | B event | ii_transactions.price_per_unit | Investment Intelligence screens | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers | Investment Intelligence screens | compliant | — | — |
| `currency_code` | B event | ii_transactions.currency_code | Investment Intelligence screens | compliant | — | — |
| `description_raw` | C evidence | ii_transactions.source_description | — | open_gap | INV-G7 (P2) | WP-12 |
| `brokerage_raw` | B event | ii_transactions.fees | — | open_gap | INV-G7 (P2) | WP-12 |
| `franking_credit_raw` | C evidence | evidence: franking credit, visible | — | open_gap | INV-G7 (P2) | WP-12 |
| `withholding_tax_raw` | C evidence | ii_transactions.taxes | — | open_gap | INV-G7 (P2) | WP-12 |
| `security_match_status` | D metadata | fdh_investment_statement_activities.security_match_status | — | compliant | — | — |
| `matched_instrument_id` | D metadata | fdh_investment_statement_activities.matched_instrument_id | — | compliant | — | — |
| `linked_transaction_id` | D metadata | the corroborated bank leg | — | open_gap | INV-G4 (P1) | WP-12 |
| `bank_match_status` | D metadata | fdh_investment_statement_activities.bank_match_status | — | open_gap | INV-G4 (P1) | WP-12 |
| `bank_match_candidates` | D metadata | fdh_investment_statement_activities.bank_match_candidates | — | open_gap | INV-G4 (P1) | WP-12 |
| `review_status` | D metadata | fdh_investment_statement_activities.review_status | — | compliant | — | — |
| `apply_status` | D metadata | fdh_investment_statement_activities.apply_status | — | compliant | — | — |
| `canonical_transaction_id` | D metadata | fdh_investment_statement_activities.canonical_transaction_id | — | compliant | — | — |
| `applied_at` | D metadata | fdh_investment_statement_activities.applied_at | — | compliant | — | — |
| `applied_by` | D metadata | fdh_investment_statement_activities.applied_by | — | compliant | — | — |
| `apply_rejected_reason` | E unsupported | the skip / rejection reason, rendered to the user | — | open_gap | INV-G9 (P2) | WP-12 |
| `source_row_number` | D metadata | fdh_investment_statement_activities.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_investment_statement_activities.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_investment_statement_activities.updated_at | — | compliant | — | — |

## retirementStatement (owner WP-13)

### retirement_native · ts_interface · `fdh:retirement/types.ts#RetirementStatementExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `statementType` | D metadata | fdh_retirement_statements.statement_type | — | compliant | — | — |
| `jurisdiction` | D metadata | fdh_retirement_statements.retirement_jurisdiction (-> country_code on add new) | — | compliant | — | — |
| `accountType` | A state | retirement_accounts.account_type (add new) | Retirement tab | compliant | — | — |
| `currencyCode` | A state | retirement_accounts.currency_code | Retirement tab | compliant | — | — |
| `fundName` | A state | retirement_accounts.account_name (add new) | Retirement tab | compliant | — | — |
| `maskedAccountIdentifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `statementDate` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statementStartDate` | C evidence | evidence:fdh_retirement_statements.statement_start_date | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statementEndDate` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `openingBalance` | C evidence | evidence:fdh_retirement_statements.opening_balance | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `closingBalance` | A state | retirement_accounts.current_balance | Retirement tab | open_gap | GAP-RET-08 (P2) | WP-07 |
| `employerContributions` | A state | retirement_accounts.employer_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `personalContributions` | A state | retirement_accounts.personal_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `salarySacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `governmentContributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rolloversIn` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rolloversOut` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `pensionPayments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `investmentEarnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (never a household expense) | — | open_gap | GAP-RET-05 (P2) | WP-13 |
| `insurancePremiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `ytdEmployerContributions` | C evidence | evidence:fdh_retirement_statements.ytd_employer_contributions (labelled YTD) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `ytdPersonalContributions` | C evidence | evidence:fdh_retirement_statements.ytd_personal_contributions (labelled YTD) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `activities` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `positions` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `parserName` | D metadata | fdh_retirement_statements.parser | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_retirement_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_retirement_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | E unsupported | fdh_retirement_statements.extraction_warnings (0207) | — | open_gap | GAP-RET-05 (P2) | WP-13 |

### retirement_native · ts_interface · `fdh:retirement/types.ts#RetirementActivityEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `activityDate` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `descriptionRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `employerNameRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `isSummaryTotal` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `isYearToDate` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |
| `currencyCode` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `effectivePeriodStart` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `effectivePeriodEnd` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `sourceRowNumber` | D metadata | fdh_retirement_statement_activities.source_row_number | — | compliant | — | — |

### retirement_native · ts_interface · `fdh:retirement/types.ts#RetirementPositionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `optionNameRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `assetClassRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `unitPrice` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `marketValue` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `valuationDate` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `tickerRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `isin` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `currencyCode` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `sourceRowNumber` | D metadata | fdh_retirement_statement_positions.source_row_number | — | compliant | — | — |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `fundName` | A state | retirement_accounts.account_name (add new) | Retirement tab | compliant | — | — |
| `maskedAccountIdentifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `statementDate` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statementStartDate` | C evidence | evidence:fdh_retirement_statements.statement_start_date | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statementEndDate` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `openingBalance` | C evidence | evidence:fdh_retirement_statements.opening_balance | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `closingBalance` | A state | retirement_accounts.current_balance | Retirement tab | open_gap | GAP-RET-08 (P2) | WP-07 |
| `employerContributions` | A state | retirement_accounts.employer_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `personalContributions` | A state | retirement_accounts.personal_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `salarySacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `governmentContributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rolloversIn` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rolloversOut` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `pensionPayments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `investmentEarnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (never a household expense) | — | open_gap | GAP-RET-05 (P2) | WP-13 |
| `insurancePremiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `activities` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `positions` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `activityDate` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `descriptionRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `employerNameRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `isSummaryTotal` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `isYearToDate` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementPositionSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `optionNameRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `assetClassRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `unitPrice` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `marketValue` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `valuationDate` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |

### retirement_native · enum_value · `enum:RETIREMENT_ACTIVITY_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `EMPLOYER_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); payslip + fund are ONE effect, never income | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `PERSONAL_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); the matched bank debit is a transfer (user-confirmed) | — | open_gap | GAP-RET-07 (P2) | WP-13 |
| `SALARY_SACRIFICE` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `GOVERNMENT_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `ROLLOVER_IN` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); fund A -> fund B is income 0 / expense 0 / net worth 0 | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `ROLLOVER_OUT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); neutral | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `INVESTMENT_EARNINGS` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `INTEREST` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `DISTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `FEE` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); never a household expense | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `INSURANCE_PREMIUM` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `TAX` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `PENSION_PAYMENT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); household income via the bank credit, once | — | open_gap | GAP-RET-07 (P2) | WP-13 |
| `WITHDRAWAL` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); the bank credit is a transfer / retirement income (user-confirmed) | — | open_gap | GAP-RET-07 (P2) | WP-13 |
| `ADJUSTMENT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review | — | open_gap | GAP-RET-05 (P2) | WP-13 |
| `OTHER` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review | — | open_gap | GAP-RET-05 (P2) | WP-13 |
| `UNKNOWN` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review, never classified silently | — | open_gap | GAP-RET-05 (P2) | WP-13 |

### retirement_native · db_column · `db:fdh_retirement_statements`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_retirement_statements.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_retirement_statements.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_retirement_statements.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_retirement_statements.statement_upload_id | — | compliant | — | — |
| `canonical_account_id` | D metadata | fdh_retirement_statements.canonical_account_id | — | compliant | — | — |
| `retirement_member_id` | A state | retirement_accounts.retirement_member_id | Retirement tab | compliant | — | — |
| `statement_type` | D metadata | fdh_retirement_statements.statement_type | — | compliant | — | — |
| `retirement_jurisdiction` | D metadata | fdh_retirement_statements.retirement_jurisdiction | — | compliant | — | — |
| `account_type` | A state | retirement_accounts.account_type | Retirement tab | compliant | — | — |
| `nickname` | E unsupported | not persisted as a canonical fact | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `currency_code` | A state | retirement_accounts.currency_code | Retirement tab | compliant | — | — |
| `fund_name` | A state | retirement_accounts.account_name (add new) | Retirement tab | compliant | — | — |
| `masked_account_identifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `statement_date` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statement_start_date` | C evidence | evidence:fdh_retirement_statements.statement_start_date | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `statement_end_date` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of) | — | open_gap | GAP-RET-06 (P2) | WP-13 |
| `opening_balance` | C evidence | evidence:fdh_retirement_statements.opening_balance | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `closing_balance` | A state | retirement_accounts.current_balance | Retirement tab | open_gap | GAP-RET-08 (P2) | WP-07 |
| `employer_contributions` | A state | retirement_accounts.employer_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `personal_contributions` | A state | retirement_accounts.personal_contribution (only when ticked, with contribution_frequency; D-12) | — | open_gap | GAP-RET-01 (P1) | WP-13 |
| `salary_sacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `government_contributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rollovers_in` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `rollovers_out` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `pension_payments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `investment_earnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (never a household expense) | — | open_gap | GAP-RET-05 (P2) | WP-13 |
| `insurance_premiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `ytd_employer_contributions` | C evidence | evidence:fdh_retirement_statements.ytd_employer_contributions | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `ytd_personal_contributions` | C evidence | evidence:fdh_retirement_statements.ytd_personal_contributions | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `parser` | D metadata | fdh_retirement_statements.parser | — | compliant | — | — |
| `parser_version` | D metadata | fdh_retirement_statements.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_retirement_statements.extraction_confidence | — | compliant | — | — |
| `extraction_status` | D metadata | fdh_retirement_statements.extraction_status | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_retirement_statements.reconciliation_status (INSERT-forgeable until 0211) | — | open_gap | GAP-RET-09 (P2) | WP-13 |
| `reconciliation_variance` | D metadata | fdh_retirement_statements.reconciliation_variance | — | compliant | — | — |
| `account_match_status` | D metadata | fdh_retirement_statements.account_match_status | — | compliant | — | — |
| `account_match_candidates` | D metadata | fdh_retirement_statements.account_match_candidates | — | compliant | — | — |
| `smsf_classification` | D metadata | fdh_retirement_statements.smsf_classification | — | compliant | — | — |
| `smsf_evidence` | D metadata | fdh_retirement_statements.smsf_evidence | — | compliant | — | — |
| `review_status` | D metadata | fdh_retirement_statements.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_retirement_statements.approval_status (INSERT-forgeable until 0211) | — | open_gap | GAP-RET-09 (P2) | WP-13 |
| `approved_at` | D metadata | fdh_retirement_statements.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_retirement_statements.approved_by | — | compliant | — | — |
| `duplicate_of_statement_id` | D metadata | fdh_retirement_statements.duplicate_of_statement_id | — | compliant | — | — |
| `supersedes_statement_id` | D metadata | fdh_retirement_statements.supersedes_statement_id | — | compliant | — | — |
| `source_provenance` | D metadata | fdh_retirement_statements.source_provenance | — | compliant | — | — |
| `created_at` | D metadata | fdh_retirement_statements.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_retirement_statements.updated_at | — | compliant | — | — |
| `extraction_warnings` | E unsupported | fdh_retirement_statements.extraction_warnings (0207) | — | open_gap | GAP-RET-05 (P2) | WP-13 |

### retirement_native · db_column · `db:fdh_retirement_statement_activities`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_retirement_statement_activities.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_retirement_statement_activities.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_retirement_statement_activities.statement_id | — | compliant | — | — |
| `activity_type` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `activity_date` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `description_raw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `employer_name_raw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `is_summary_total` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `is_year_to_date` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |
| `effective_period_start` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `effective_period_end` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `currency_code` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `employer_normalised` | D metadata | fdh_retirement_statement_activities.employer_normalised | — | compliant | — | — |
| `payslip_match_status` | D metadata | fdh_retirement_statement_activities.payslip_match_status | — | compliant | — | — |
| `matched_payroll_event_id` | D metadata | fdh_retirement_statement_activities.matched_payroll_event_id | — | compliant | — | — |
| `payslip_match_variance` | D metadata | fdh_retirement_statement_activities.payslip_match_variance | — | compliant | — | — |
| `payslip_match_candidates` | D metadata | fdh_retirement_statement_activities.payslip_match_candidates | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_retirement_statement_activities.bank_match_status | — | open_gap | GAP-RET-07 (P2) | WP-13 |
| `linked_transaction_id` | D metadata | the matched bank leg (reclassified only with the user's confirmation) | — | open_gap | GAP-RET-07 (P2) | WP-13 |
| `bank_match_candidates` | D metadata | fdh_retirement_statement_activities.bank_match_candidates | — | compliant | — | — |
| `rollover_counterpart_activity_id` | D metadata | fdh_retirement_statement_activities.rollover_counterpart_activity_id | — | compliant | — | — |
| `rollover_match_status` | D metadata | fdh_retirement_statement_activities.rollover_match_status | — | compliant | — | — |
| `review_status` | D metadata | fdh_retirement_statement_activities.review_status | — | compliant | — | — |
| `activity_fingerprint` | D metadata | fdh_retirement_statement_activities.activity_fingerprint | — | compliant | — | — |
| `duplicate_of_activity_id` | D metadata | fdh_retirement_statement_activities.duplicate_of_activity_id | — | compliant | — | — |
| `source_row_number` | D metadata | fdh_retirement_statement_activities.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_retirement_statement_activities.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_retirement_statement_activities.updated_at | — | compliant | — | — |

### retirement_native · db_column · `db:fdh_retirement_statement_positions`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_retirement_statement_positions.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_retirement_statement_positions.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_retirement_statement_positions.statement_id | — | compliant | — | — |
| `option_name_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `asset_class_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `unit_price` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `market_value` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-03 (P1) | WP-13 |
| `valuation_date` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `ticker_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `isin` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `currency_code` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | — | open_gap | GAP-RET-04 (P2) | WP-13 |
| `source_row_number` | D metadata | fdh_retirement_statement_positions.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_retirement_statement_positions.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_retirement_statement_positions.updated_at | — | compliant | — | — |

## iiCas (owner WP-12)

### ii_cas · ts_interface · `ii:parsers/types.ts#ParsedAccountRecord`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `folioNumber` | A state | ii_accounts.folio_number | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `accountNumberMasked` | A state | ii_accounts.account_number_masked | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `amcName` | A state | ii_accounts.institution_name | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `holderName` | C evidence | ii_* account evidence (holder) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `panMasked` | C evidence | ii_* account evidence (masked PAN only, never full) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `jointHolders` | C evidence | ii_* account evidence (joint holders) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `holdingModeRaw` | C evidence | ii_* account evidence (holding mode as printed) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `raw` | D metadata | in-memory parse provenance (never logged) | — | compliant | — | — |

### ii_cas · ts_interface · `ii:parsers/types.ts#ParsedInstrumentRecord`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `rawSchemeName` | A state | ii_instruments.instrument_name | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `normalisedSchemeName` | D metadata | scheme resolution key | — | compliant | — | — |
| `amcName` | A state | ii_instruments (fund house) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `planType` | A state | ii_instruments.plan_type | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `optionType` | A state | ii_instruments.option_type | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (ISIN) | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `amfiSchemeCode` | A state | ii_instrument_identifiers (AMFI code) | Investment Intelligence screens; Investments tab once published | compliant | — | — |

### ii_cas · ts_interface · `ii:parsers/types.ts#ParsedTransactionRecord`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `folioNumber` | D metadata | links the transaction to its ii_accounts row | — | compliant | — | — |
| `scheme` | A state | ii_instruments | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `transactionDateIso` | B event | ii_transactions.transaction_date | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `rawTransactionTypeText` | C evidence | ii_transactions.source_description | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `canonicalType` | B event | ii_transactions.transaction_type | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `classificationConfidence` | D metadata | parse quality | — | compliant | — | — |
| `amountScaled` | B event | ii_transactions.gross_amount | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `unitsScaled` | B event | ii_transactions.units | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `navScaled` | B event | ii_transactions.price_per_unit | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `balanceUnitsAfterScaled` | D metadata | reconciliation input only (never stored as a transaction field) | — | compliant | — | — |
| `sourceReference` | D metadata | ii_transactions fingerprint input | — | compliant | — | — |
| `sourceDescription` | C evidence | ii_transactions.source_description | Investment Intelligence screens; Investments tab once published | compliant | — | — |

### ii_cas · ts_interface · `ii:parsers/types.ts#ParsedHoldingRecord`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `folioNumber` | D metadata | links the holding to its ii_accounts row | — | compliant | — | — |
| `scheme` | A state | ii_instruments | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `asOfDateIso` | A state | ii_holding_snapshots.as_of_date | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `unitsScaled` | A state | ii_holding_snapshots.units | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `valueScaled` | A state | ii_holding_snapshots.value | Investment Intelligence screens; Investments tab once published | compliant | — | — |
| `navScaled` | A state | ii_holding_snapshots.source_nav | Investment Intelligence screens; Investments tab once published | compliant | — | — |

### ii_cas · ts_interface · `ii:parsers/types.ts#ParseMetadata`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `sourceKey` | D metadata | ii source document detection | — | compliant | — | — |
| `sourceConfidence` | D metadata | ii source document detection | — | compliant | — | — |
| `documentTypeDetected` | D metadata | ii source document detection | — | compliant | — | — |
| `formatVersionDetected` | D metadata | ii source document detection | — | compliant | — | — |
| `statementPeriodStartIso` | C evidence | ii source document statement period | Investment Intelligence > documents | compliant | — | — |
| `statementPeriodEndIso` | C evidence | ii source document statement period | Investment Intelligence > documents | compliant | — | — |
| `statementAsOfDateIso` | C evidence | ii source document as-of date | Investment Intelligence > documents | compliant | — | — |
| `extractionMethod` | D metadata | ii parse run | — | compliant | — | — |

## insurance (owner WP-14)

### insurance · field_list · `aie:insurance/types.ts#CANONICAL_INSURANCE_FIELD_NAMES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `policyName` | A state | insurance_policies.policy_name | — | not_active | — | — |
| `coverType` | A state | insurance_policies.cover_type (raw label lost when "other": INS-05, latent) | — | not_active | — | — |
| `coverAmount` | A state | insurance_policies.cover_amount | — | not_active | — | — |
| `premium` | A state | insurance_policies.premium | — | not_active | — | — |
| `premiumFrequency` | A state | insurance_policies.premium_frequency | — | not_active | — | — |
| `currencyCode` | A state | insurance_policies.currency_code | — | not_active | — | — |
| `renewalDate` | A state | insurance_policies.renewal_date | — | not_active | — | — |
| `waitingPeriodDays` | A state | insurance_policies.waiting_period_days (unit lost: INS-01, latent) | — | not_active | — | — |
| `benefitPeriod` | A state | insurance_policies.benefit_period | — | not_active | — | — |
| `provider` | A state | insurance_policies.provider | — | not_active | — | — |

### insurance · field_list · `aie:insurance/types.ts#EVIDENCE_ONLY_INSURANCE_FIELD_NAMES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `documentSubClass` | C evidence | aie_field_candidate (document sub-class) | — | not_active | — | — |
| `policyNumberMasked` | C evidence | aie_field_candidate (INS-03, latent: not visible after accept) | — | not_active | — | — |
| `policyOwnerName` | C evidence | aie_field_candidate (INS-03, latent) | — | not_active | — | — |
| `insuredPersonName` | C evidence | aie_field_candidate (INS-03, latent) | — | not_active | — | — |
| `beneficiaryName` | C evidence | aie_field_candidate (INS-03, latent) | — | not_active | — | — |
| `exclusionsText` | C evidence | aie_field_candidate (INS-03, latent) | — | not_active | — | — |
| `excessAmount` | C evidence | aie_field_candidate (INS-03, latent) | — | not_active | — | — |
| `printedAnnualPremiumTotal` | C evidence | reconciliation cross-check | — | not_active | — | — |
| `multiComponentPolicyDetected` | E unsupported | blocks acceptance | — | not_active | — | — |
| `unreadablePrintedFactCount` | E unsupported | blocks acceptance | — | not_active | — | — |
| `unreadablePrintedFactEvidence` | E unsupported | blocks acceptance | — | not_active | — | — |

