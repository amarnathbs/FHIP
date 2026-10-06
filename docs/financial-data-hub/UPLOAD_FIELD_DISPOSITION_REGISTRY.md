# UPLOAD_FIELD_DISPOSITION_REGISTRY

GENERATED -- do not edit by hand. Source: `lib/canonical-data/disposition/*.ts`.
Regenerate with `node scripts/generate-upload-field-disposition-doc.mjs`; `tests/unit/uploadFieldDispositionRegistry.test.ts` fails if this file is stale.

Every field an active upload adapter extracts, every evidence column and every activity / economic-type enum value has exactly one disposition:
**A** canonical state · **B** canonical event · **C** evidence (must be user-visible) · **D** technical metadata · **E** explicitly unsupported (with a visible explanation).
`open_gap` rows name the gap (see APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md, gap register) and the work package that closes it; `not_active` rows belong to a flow no user can reach.

## Summary

| Registry file | Owner | Entries | A | B | C | D | E | open_gap | ceiling | not_active |
|---|---|---|---|---|---|---|---|---|---|---|
| bankStatement | WP-08 | 167 | 2 | 20 | 25 | 120 | 0 | 0 | 0 | 0 |
| economicTransactionType | WP-02 | 13 | 0 | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| payslip | WP-09 | 130 | 18 | 12 | 57 | 40 | 3 | 0 | 0 | 0 |
| liabilityStatement | WP-10 | 145 | 29 | 22 | 34 | 47 | 13 | 0 | 0 | 0 |
| liabilityActivityLedger | WP-11 | 10 | 0 | 8 | 0 | 0 | 2 | 0 | 0 | 0 |
| auInvestmentStatement | WP-12 | 168 | 42 | 35 | 21 | 58 | 12 | 0 | 0 | 0 |
| retirementStatement | WP-13 | 203 | 17 | 0 | 118 | 68 | 0 | 0 | 0 | 0 |
| iiCas | WP-12 | 41 | 15 | 5 | 9 | 12 | 0 | 0 | 0 | 0 |
| insurance | WP-14 | 21 | 10 | 0 | 8 | 0 | 3 | 0 | 0 | 21 |
| **total** | | **898** | 133 | 115 | 272 | 345 | 33 | 0 | | 21 |

## Open gaps by id

| Gap | Severity | Owner WP | Fields |
|---|---|---|---|

## bankStatement (owner WP-08)

### bank_csv · ts_interface · `fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `sourceRowNumber` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | compliant | — | — |
| `postedDate` | C evidence | evidence:fdh_transactions.posting_date | Category review > Statement details | compliant | — | — |
| `valueDate` | C evidence | evidence:fdh_transactions.value_date | Category review > Statement details | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `descriptionClean` | B event | fdh_transactions.description_clean | Expenses > Actual spending (imported) | compliant | — | — |
| `referenceRaw` | C evidence | evidence:fdh_transactions.source_reference (dedup key) | Category review > Statement details | compliant | — | — |
| `amountOriginal` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | Category review > Statement details | compliant | — | — |
| `transactionTypeHint` | D metadata | fdh_transactions.transaction_type_hint | — | compliant | — | — |

### bank_pdf · ts_interface · `fdh:bank-pdf/orchestrator.ts#AcceptedPdfTransactionPlan`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `sourceRowNumber` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `sourcePage` | D metadata | fdh_transactions.source_page | — | compliant | — | — |
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `descriptionClean` | B event | fdh_transactions.description_clean | Expenses > Actual spending (imported) | compliant | — | — |
| `amountOriginal` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | Category review > Statement details | compliant | — | — |
| `transactionTypeHint` | D metadata | fdh_transactions.transaction_type_hint | — | compliant | — | — |
| `sourceRowHash` | D metadata | fdh_transactions.source_row_hash | — | compliant | — | — |
| `economicFingerprint` | D metadata | fdh_transactions.economic_fingerprint | — | compliant | — | — |
| `dedupStatus` | D metadata | fdh_transactions.dedup_status | Category review ("removed as a duplicate") + Statement details | compliant | — | — |
| `matchedTransactionId` | D metadata | fdh_duplicate_candidates.transaction_id_a | — | compliant | — | — |
| `matchMethod` | D metadata | fdh_duplicate_candidates.match_method | — | compliant | — | — |
| `dedupConfidence` | D metadata | fdh_duplicate_candidates.confidence | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_transactions.extraction_confidence | — | compliant | — | — |

### bank_pdf · ts_interface · `fdh:bank-pdf/metadata.ts#PdfStatementMetadata`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `declaredOpeningBalance` | C evidence | evidence:fdh_reconciliation_results.opening_balance | Bank import panel > review summary (reconciliation) | compliant | — | — |
| `declaredClosingBalance` | A state | assets.current_value (one cash asset per account, via the "Add your bank balance to Assets" proposal the user Applies -- fdh15_apply_asset_proposal; until then evidence fdh_reconciliation_results.reported_closing_balance, never in Net Worth) | Assets > Add your bank balance to Assets + Category review > Statement details (labelled "not in your Net Worth unless you add it as a cash asset") | compliant | — | — |
| `maskedAccountIdentifier` | D metadata | fdh_financial_accounts.masked_identifier / account_fingerprint (account matching; a mismatch raises a visible warning) | Category review > Statement details | compliant | — | — |
| `statementPeriodStart` | C evidence | fdh_statement_uploads.statement_period_start (coverage input) | Category review header + Category review > Statement details | compliant | — | — |
| `statementPeriodEnd` | C evidence | fdh_statement_uploads.statement_period_end (coverage input) | Category review header + Category review > Statement details | compliant | — | — |

### bank_ai_draft · zod_schema · `aie:bankStatement/schema.ts#bankStatementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | fdh_ai_fallback_drafts.payload | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | fdh_ai_fallback_drafts.payload | — | compliant | — | — |
| `institutionName` | D metadata | fdh_financial_accounts.display_name (names a generically-named account) | Category review > Statement details | compliant | — | — |
| `maskedAccountIdentifier` | D metadata | fdh_financial_accounts.masked_identifier / account_fingerprint (account matching) | Category review > Statement details | compliant | — | — |
| `statementPeriodStart` | C evidence | fdh_statement_uploads.statement_period_start | Category review header + Category review > Statement details | compliant | — | — |
| `statementPeriodEnd` | C evidence | fdh_statement_uploads.statement_period_end | Category review header + Category review > Statement details | compliant | — | — |
| `declaredOpeningBalance` | C evidence | evidence:fdh_reconciliation_results.opening_balance | Category review > Statement details | compliant | — | — |
| `declaredClosingBalance` | A state | assets.current_value (one cash asset per account, via the "Add your bank balance to Assets" proposal the user Applies -- fdh15_apply_asset_proposal; until then evidence fdh_reconciliation_results.reported_closing_balance, never in Net Worth) | Assets > Add your bank balance to Assets + Category review > Statement details (labelled per D-04) | compliant | — | — |
| `allTransactionsListed` | C evidence | evidence:fdh_data_quality_results(low_extraction_confidence) + a blocking review item when false | Category review > Statement details + Category review "About this statement" | compliant | — | — |
| `transactions` | B event | fdh_transactions (one row per line, through the native pipeline) | Expenses > Import bank statement > category review | compliant | — | — |

### bank_ai_draft · zod_schema · `aie:bankStatement/schema.ts#bankStatementTransactionSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionDate` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_transactions.description_raw | Financial Activity > transactions | compliant | — | — |
| `amount` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `creditDebit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `balanceAfter` | C evidence | evidence:fdh_transactions.balance_after | Category review > Statement details | compliant | — | — |

### bank_ledger · db_column · `db:fdh_transactions`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_transactions.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_transactions.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_transactions.household_id | — | compliant | — | — |
| `financial_account_id` | D metadata | fdh_transactions.financial_account_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_transactions.statement_upload_id | — | compliant | — | — |
| `transaction_date` | B event | fdh_transactions.transaction_date | Expenses > Import bank statement > category review | compliant | — | — |
| `posting_date` | C evidence | evidence:fdh_transactions.posting_date | Category review > Statement details | compliant | — | — |
| `value_date` | C evidence | evidence:fdh_transactions.value_date | Category review > Statement details | compliant | — | — |
| `description_raw` | C evidence | evidence:fdh_transactions.description_raw (purgeable) | Financial Activity > transactions | compliant | — | — |
| `description_clean` | B event | fdh_transactions.description_clean | Expenses > Actual spending (imported) | compliant | — | — |
| `merchant_raw` | C evidence | evidence:fdh_transactions.merchant_raw | Financial Activity > merchants | compliant | — | — |
| `merchant_id` | D metadata | fdh_transactions.merchant_id | — | compliant | — | — |
| `amount_original` | B event | fdh_transactions.amount_original | Expenses > Import bank statement > category review | compliant | — | — |
| `currency_original` | B event | fdh_transactions.currency_original (the statement currency; a CSV currency column is checked against it and a different currency is rejected with a visible reason; converted once by the read models) | Expenses > Import bank statement > category review; Import panel + Statement details: "N lines could not be read" with reasons | compliant | — | — |
| `amount_reporting_currency` | D metadata | fdh_transactions.amount_reporting_currency | — | compliant | — | — |
| `reporting_currency` | D metadata | fdh_transactions.reporting_currency | — | compliant | — | — |
| `fx_rate` | D metadata | fdh_transactions.fx_rate | — | compliant | — | — |
| `fx_rate_date` | D metadata | fdh_transactions.fx_rate_date | — | compliant | — | — |
| `fx_rate_source` | D metadata | fdh_transactions.fx_rate_source | — | compliant | — | — |
| `credit_debit` | B event | fdh_transactions.credit_debit | Expenses > Import bank statement > category review | compliant | — | — |
| `economic_transaction_type` | B event | fdh_transactions.economic_transaction_type (one read-model bucket per value) | Expenses > Import bank statement > category review | compliant | — | — |
| `category_id` | B event | fdh_transactions.category_id (canonical expense group) | Expenses > Import bank statement > category review; Expenses > Actual spending (imported) | compliant | — | — |
| `subcategory_id` | B event | fdh_transactions.subcategory_id (essential flag; planned-item key for the WP-15 averages proposal) | Expenses > Import bank statement > category review; Expenses > Actual spending (imported) | compliant | — | — |
| `recurring_flag` | D metadata | fdh_transactions.recurring_flag | — | compliant | — | — |
| `subscription_flag` | D metadata | fdh_transactions.subscription_flag | — | compliant | — | — |
| `transfer_flag` | D metadata | fdh_transactions.transfer_flag | — | compliant | — | — |
| `classification_confidence` | D metadata | fdh_transactions.classification_confidence | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_transactions.extraction_confidence | — | compliant | — | — |
| `classification_method` | D metadata | fdh_transactions.classification_method | — | compliant | — | — |
| `source_reference` | C evidence | evidence:fdh_transactions.source_reference | Category review > Statement details | compliant | — | — |
| `source_page` | D metadata | fdh_transactions.source_page | — | compliant | — | — |
| `source_row` | D metadata | fdh_transactions.source_row | — | compliant | — | — |
| `review_status` | D metadata | fdh_transactions.review_status | — | compliant | — | — |
| `user_override` | D metadata | fdh_transactions.user_override | — | compliant | — | — |
| `created_at` | D metadata | fdh_transactions.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_transactions.updated_at | — | compliant | — | — |
| `source_row_hash` | D metadata | fdh_transactions.source_row_hash | — | compliant | — | — |
| `economic_fingerprint` | D metadata | fdh_transactions.economic_fingerprint | — | compliant | — | — |
| `economic_fingerprint_version` | D metadata | fdh_transactions.economic_fingerprint_version | — | compliant | — | — |
| `dedup_status` | D metadata | fdh_transactions.dedup_status | Category review ("removed as a duplicate") + Statement details | compliant | — | — |
| `balance_after` | C evidence | evidence:fdh_transactions.balance_after | Category review > Statement details | compliant | — | — |
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
| `owner_member_id` | D metadata | fdh_statement_uploads.owner_member_id (the household member the user chose as owner; the economic owner is fdh_financial_accounts.owner_role) | — | compliant | — | — |
| `owner_business_entity_id` | D metadata | fdh_statement_uploads.owner_business_entity_id (the entity the user chose as owner (refused for bank statements today); the economic owner is fdh_financial_accounts.owner_role) | — | compliant | — | — |
| `owner_role` | D metadata | fdh_statement_uploads.owner_role (the owner role the user chose (self, spouse, joint, smsf ...); the economic owner is fdh_financial_accounts.owner_role) | — | compliant | — | — |
| `owner_selection_source` | D metadata | fdh_statement_uploads.owner_selection_source (how the owner was recorded (user_selected, backfill_from_account, backfill_from_document, legacy_unset); the economic owner is fdh_financial_accounts.owner_role) | — | compliant | — | — |
| `owner_allocation` | D metadata | fdh_statement_uploads.owner_allocation (the joint split the user chose (basis points, total 10000); AU investment statements only; the economic owner is fdh_financial_accounts.owner_role) | — | compliant | — | — |
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
| `currencyCode` | A state | income_sources.currency_code (CURRENCY_MISMATCH on update, 0210) | Income tab | compliant | — | — |
| `payFrequencySource` | D metadata | fdh_payroll_events.pay_frequency_source | — | compliant | — | — |
| `grossPaySource` | D metadata | fdh_payroll_events.gross_pay_source | — | compliant | — | — |
| `employerName` | A state | income_sources.employer_name | Income tab | compliant | — | — |
| `payPeriodStart` | C evidence | evidence:fdh_payroll_events.pay_period_start | Income > Payslip details | compliant | — | — |
| `payPeriodEnd` | C evidence | evidence:fdh_payroll_events.pay_period_end | Income > Payslip details | compliant | — | — |
| `paymentDate` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | Income > Payslip details | compliant | — | — |
| `payFrequency` | A state | income_sources.frequency (user-confirmed; semimonthly / irregular / unknown: user chooses) | Income tab | compliant | — | — |
| `grossPay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `basePay` | C evidence | evidence:fdh_payroll_events.base_pay | Income > Payslip details | compliant | — | — |
| `overtimePay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `bonusPay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `commissionPay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `allowancesTotal` | A state | income_sources.amount (inside recurring gross) | Income > Payslip details | compliant | — | — |
| `reimbursementsTotal` | E unsupported | not income (taken out of recurring gross when the payslip lines show it is inside gross) | Income > Payslip details ("Not income") | compliant | — | — |
| `otherEarnings` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `taxWithheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | Income > Payslip details | compliant | — | — |
| `employeeDeductionsTotal` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | Income > Payslip details | compliant | — | — |
| `salarySacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice (+ the recorded gross basis) | Income > Payslip details | compliant | — | — |
| `professionalTax` | C evidence | evidence:fdh_payroll_events.professional_tax | Income > Payslip details | compliant | — | — |
| `employerRetirementContribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employeeRetirementContribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | Income > Payslip details | compliant | — | — |
| `employerNpsContribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employeeNpsContribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | Income > Payslip details | compliant | — | — |
| `netPay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | compliant | — | — |
| `ytdGross` | C evidence | evidence:fdh_payroll_events.ytd_gross (never summed) | Income > Payslip details | compliant | — | — |
| `ytdTax` | C evidence | evidence:fdh_payroll_events.ytd_tax | Income > Payslip details | compliant | — | — |
| `ytdNet` | C evidence | evidence:fdh_payroll_events.ytd_net | Income > Payslip details | compliant | — | — |
| `ytdEmployerRetirement` | C evidence | evidence:fdh_payroll_events.ytd_employer_retirement | Income > Payslip details | compliant | — | — |
| `ytdEmployeeRetirement` | C evidence | evidence:fdh_payroll_events.ytd_employee_retirement | Income > Payslip details | compliant | — | — |
| `components` | C evidence | evidence:fdh_payroll_components | Income > Payslip details | compliant | — | — |
| `parserName` | D metadata | fdh_payroll_events.parser_name | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_payroll_events.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_payroll_events.extraction_confidence | — | compliant | — | — |
| `warnings` | D metadata | fdh_payroll_events.review_status (warnings force review) | — | compliant | — | — |

### payslip_native · ts_interface · `fdh:payslip/types.ts#PayrollComponent`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `side` | C evidence | evidence:fdh_payroll_components.component_side | Income > Payslip details | compliant | — | — |
| `type` | C evidence | evidence:fdh_payroll_components.component_type | Income > Payslip details | compliant | — | — |
| `labelRaw` | C evidence | evidence:fdh_payroll_components.label_raw | Income > Payslip details | compliant | — | — |
| `amount` | C evidence | evidence:fdh_payroll_components.amount | Income > Payslip details | compliant | — | — |
| `isYearToDate` | C evidence | evidence:fdh_payroll_components.is_year_to_date | Income > Payslip details | compliant | — | — |

### payslip_ai · zod_schema · `aie:payslip/schema.ts#payslipDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `employerName` | A state | income_sources.employer_name | Income tab | compliant | — | — |
| `payPeriodStart` | C evidence | evidence:fdh_payroll_events.pay_period_start | Income > Payslip details | compliant | — | — |
| `payPeriodEnd` | C evidence | evidence:fdh_payroll_events.pay_period_end | Income > Payslip details | compliant | — | — |
| `paymentDate` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | Income > Payslip details | compliant | — | — |
| `payFrequency` | A state | income_sources.frequency (user-confirmed; semimonthly / irregular / unknown: user chooses) | Income tab | compliant | — | — |
| `grossPay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `basePay` | C evidence | evidence:fdh_payroll_events.base_pay | Income > Payslip details | compliant | — | — |
| `overtimePay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `bonusPay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `commissionPay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `allowancesTotal` | A state | income_sources.amount (inside recurring gross) | Income > Payslip details | compliant | — | — |
| `reimbursementsTotal` | E unsupported | not income (taken out of recurring gross when the payslip lines show it is inside gross) | Income > Payslip details ("Not income") | compliant | — | — |
| `otherEarnings` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `taxWithheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | Income > Payslip details | compliant | — | — |
| `employeeDeductionsTotal` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | Income > Payslip details | compliant | — | — |
| `salarySacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice (+ the recorded gross basis) | Income > Payslip details | compliant | — | — |
| `professionalTax` | C evidence | evidence:fdh_payroll_events.professional_tax | Income > Payslip details | compliant | — | — |
| `employerRetirementContribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employeeRetirementContribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | Income > Payslip details | compliant | — | — |
| `employerNpsContribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employeeNpsContribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | Income > Payslip details | compliant | — | — |
| `netPay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | compliant | — | — |

### payslip_native · db_column · `db:fdh_payroll_events`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_payroll_events.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_payroll_events.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_payroll_events.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_payroll_events.statement_upload_id | — | compliant | — | — |
| `employer_normalised` | D metadata | fdh_payroll_events.employer_normalised | — | compliant | — | — |
| `country_code` | D metadata | fdh_payroll_events.country_code | — | compliant | — | — |
| `currency_code` | A state | income_sources.currency_code (CURRENCY_MISMATCH on update, 0210) | Income tab | compliant | — | — |
| `pay_frequency_source` | D metadata | fdh_payroll_events.pay_frequency_source | — | compliant | — | — |
| `employer_name` | A state | income_sources.employer_name | Income tab | compliant | — | — |
| `pay_period_start` | C evidence | evidence:fdh_payroll_events.pay_period_start | Income > Payslip details | compliant | — | — |
| `pay_period_end` | C evidence | evidence:fdh_payroll_events.pay_period_end | Income > Payslip details | compliant | — | — |
| `payment_date` | C evidence | evidence:fdh_payroll_events.payment_date (economic date) | Income > Payslip details | compliant | — | — |
| `pay_frequency` | A state | income_sources.frequency (user-confirmed; semimonthly / irregular / unknown: user chooses) | Income tab | compliant | — | — |
| `gross_pay` | A state | income_sources.amount (recurring gross) | Income tab | compliant | — | — |
| `base_pay` | C evidence | evidence:fdh_payroll_events.base_pay | Income > Payslip details | compliant | — | — |
| `overtime_pay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `bonus_pay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `commission_pay` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `allowances_total` | A state | income_sources.amount (inside recurring gross) | Income > Payslip details | compliant | — | — |
| `reimbursements_total` | E unsupported | not income (taken out of recurring gross when the payslip lines show it is inside gross) | Income > Payslip details ("Not income") | compliant | — | — |
| `other_earnings` | B event | income_sources (the Applied payslip's row) -> selectIncome actual.variablePay: dated one-off actual income, deduped against the matched bank credit (PO D-06) | Income > Actual income (one-off pay) | compliant | — | — |
| `tax_withheld` | C evidence | evidence:fdh_payroll_events.tax_withheld | Income > Payslip details | compliant | — | — |
| `employee_deductions_total` | C evidence | evidence:fdh_payroll_events.employee_deductions_total | Income > Payslip details | compliant | — | — |
| `salary_sacrifice` | C evidence | evidence:fdh_payroll_events.salary_sacrifice (+ the recorded gross basis) | Income > Payslip details | compliant | — | — |
| `professional_tax` | C evidence | evidence:fdh_payroll_events.professional_tax | Income > Payslip details | compliant | — | — |
| `employer_retirement_contribution` | C evidence | evidence:fdh_payroll_events.employer_retirement_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employee_retirement_contribution` | C evidence | evidence:fdh_payroll_events.employee_retirement_contribution | Income > Payslip details | compliant | — | — |
| `employer_nps_contribution` | C evidence | evidence:fdh_payroll_events.employer_nps_contribution (never income) | Income > Payslip details | compliant | — | — |
| `employee_nps_contribution` | C evidence | evidence:fdh_payroll_events.employee_nps_contribution | Income > Payslip details | compliant | — | — |
| `net_pay` | A state | income_sources.net_amount (null = unknown, never gross) | Income tab | compliant | — | — |
| `ytd_gross` | C evidence | evidence:fdh_payroll_events.ytd_gross | Income > Payslip details | compliant | — | — |
| `ytd_tax` | C evidence | evidence:fdh_payroll_events.ytd_tax | Income > Payslip details | compliant | — | — |
| `ytd_net` | C evidence | evidence:fdh_payroll_events.ytd_net | Income > Payslip details | compliant | — | — |
| `ytd_employer_retirement` | C evidence | evidence:fdh_payroll_events.ytd_employer_retirement | Income > Payslip details | compliant | — | — |
| `ytd_employee_retirement` | C evidence | evidence:fdh_payroll_events.ytd_employee_retirement | Income > Payslip details | compliant | — | — |
| `parser_name` | D metadata | fdh_payroll_events.parser_name | — | compliant | — | — |
| `parser_version` | D metadata | fdh_payroll_events.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_payroll_events.extraction_confidence | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_payroll_events.reconciliation_status | — | compliant | — | — |
| `reconciliation_variance` | D metadata | fdh_payroll_events.reconciliation_variance | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_payroll_events.bank_match_status (re-matched on bank approval: fdh9_restamp_payroll_bank_match, 0210) | — | compliant | — | — |
| `bank_match_transaction_id` | D metadata | dedup link: the payslip and its bank credit are ONE income event (selectIncome) | — | compliant | — | — |
| `bank_match_confidence` | D metadata | fdh_payroll_events.bank_match_confidence | — | compliant | — | — |
| `review_status` | D metadata | fdh_payroll_events.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_payroll_events.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_payroll_events.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_payroll_events.approved_by | — | compliant | — | — |
| `superseded_by_payroll_event_id` | D metadata | fdh_payroll_events.superseded_by_payroll_event_id (fdh9_supersede_payroll_event, 0210) | — | compliant | — | — |
| `payslip_fingerprint` | D metadata | fdh_payroll_events.payslip_fingerprint | — | compliant | — | — |
| `created_at` | D metadata | fdh_payroll_events.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_payroll_events.updated_at | — | compliant | — | — |
| `gross_pay_source` | D metadata | fdh_payroll_events.gross_pay_source | — | compliant | — | — |
| `user_corrected_fields` | D metadata | fdh_payroll_events.user_corrected_fields | — | compliant | — | — |
| `last_corrected_at` | D metadata | fdh_payroll_events.last_corrected_at | — | compliant | — | — |
| `last_corrected_by` | D metadata | fdh_payroll_events.last_corrected_by | — | compliant | — | — |
| `income_owner` | A state | income_sources.owner (self / spouse, chosen at upload, fixed at approval; 0210 MEMBER_MISMATCH) | Income tab | compliant | — | — |

### payslip_native · db_column · `db:fdh_payroll_components`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_payroll_components.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_payroll_components.user_id | — | compliant | — | — |
| `payroll_event_id` | D metadata | fdh_payroll_components.payroll_event_id | — | compliant | — | — |
| `component_side` | C evidence | evidence:fdh_payroll_components.component_side | Income > Payslip details | compliant | — | — |
| `component_type` | C evidence | evidence:fdh_payroll_components.component_type | Income > Payslip details | compliant | — | — |
| `label_raw` | C evidence | evidence:fdh_payroll_components.label_raw | Income > Payslip details | compliant | — | — |
| `amount` | C evidence | evidence:fdh_payroll_components.amount | Income > Payslip details | compliant | — | — |
| `is_year_to_date` | C evidence | evidence:fdh_payroll_components.is_year_to_date | Income > Payslip details | compliant | — | — |
| `created_at` | D metadata | fdh_payroll_components.created_at | — | compliant | — | — |

## liabilityStatement (owner WP-10)

### liability_native · ts_interface · `fdh:liability/types.ts#LiabilityStatementExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `statementType` | D metadata | fdh_liability_statements.statement_type | — | compliant | — | — |
| `country` | A state | liabilities.country_code | Liabilities tab | compliant | — | — |
| `currencyCode` | A state | liabilities.currency_code (AUD/INR only; any other currency is refused with a visible reason) | Liabilities tab | compliant | — | — |
| `facilityType` | A state | liabilities.debt_type | Liabilities tab | compliant | — | — |
| `nickname` | E unsupported | not persisted (a display nickname is not a canonical fact) | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `institutionName` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `maskedIdentifier` | A state | liabilities.masked_identifier | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `statementPeriodStart` | C evidence | evidence:fdh_liability_statements.statement_period_start | Liabilities tab → Statement history | compliant | — | — |
| `statementPeriodEnd` | C evidence | evidence:fdh_liability_statements.statement_period_end | Liabilities tab → Statement history | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_liability_statements.statement_date | Liabilities tab → Statement history | compliant | — | — |
| `dueDate` | A state | liabilities.due_date | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `openingBalance` | C evidence | evidence:fdh_liability_statements.opening_balance | Liabilities tab → Statement history | compliant | — | — |
| `closingBalance` | A state | liabilities.balance (card) | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `creditLimit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimumPayment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | compliant | — | — |
| `interestRate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab; Liabilities tab → Statement history | compliant | — | — |
| `availableCredit` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `openingPrincipal` | C evidence | evidence:fdh_liability_statements.opening_principal | Liabilities tab → Statement history | compliant | — | — |
| `closingPrincipal` | A state | liabilities.balance (loan) | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `rateType` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `repaymentFrequency` | E unsupported | not read from statements (proposal reads null) | Liabilities tab → Import Statement (review) ("Not shown on statement"); Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `maturityDate` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `arrearsAmount` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `activities` | B event | fdh_transactions (card/loan facility ledger row, 0209) | Liabilities tab → Statement history | compliant | — | — |
| `parserName` | D metadata | fdh_liability_statements.parser_name | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_liability_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_liability_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | E unsupported | fdh_liability_statements.extraction_warnings (excluded rows and unchecked figures, with the reason) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history (notes) | compliant | — | — |

### liability_native · ts_interface · `fdh:liability/types.ts#LiabilityStatementActivity`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | Liabilities tab → Statement history | compliant | — | — |
| `activityDate` | B event | fdh_transactions.transaction_date | Liabilities tab → Statement history | compliant | — | — |
| `amount` | B event | fdh_transactions.amount_original | Liabilities tab → Statement history | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | Liabilities tab → Statement history | compliant | — | — |
| `merchantRaw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw (copied to the ledger row) | Financial Activity (transaction detail) | compliant | — | — |
| `principalComponent` | B event | fdh_transaction_allocations (debt_principal) | Liabilities tab → Statement history | compliant | — | — |
| `interestComponent` | B event | fdh_transaction_allocations (debt_interest) | Liabilities tab → Statement history | compliant | — | — |
| `feeComponent` | B event | fdh_transaction_allocations (fee) | Liabilities tab → Statement history | compliant | — | — |
| `gstAmountRaw` | C evidence | evidence:fdh_liability_statement_activities.gst_amount_raw (never summed) | Liabilities tab → Statement history | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_liability_statement_activities.source_row_number | — | compliant | — | — |

### liability_ai · zod_schema · `aie:liability/schema.ts#liabilityStatementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `institutionName` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `maskedIdentifier` | A state | liabilities.masked_identifier | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `statementPeriodStart` | C evidence | evidence:fdh_liability_statements.statement_period_start | Liabilities tab → Statement history | compliant | — | — |
| `statementPeriodEnd` | C evidence | evidence:fdh_liability_statements.statement_period_end | Liabilities tab → Statement history | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_liability_statements.statement_date | Liabilities tab → Statement history | compliant | — | — |
| `dueDate` | A state | liabilities.due_date | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `openingBalance` | C evidence | evidence:fdh_liability_statements.opening_balance | Liabilities tab → Statement history | compliant | — | — |
| `closingBalance` | A state | liabilities.balance (card) | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `creditLimit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimumPayment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | compliant | — | — |
| `interestRate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab; Liabilities tab → Statement history | compliant | — | — |
| `allActivitiesListed` | C evidence | evidence: AI draft completeness flag | Liabilities tab → Import Statement (AI draft review) | compliant | — | — |
| `activities` | B event | fdh_transactions (card/loan facility ledger row, 0209) | Liabilities tab → Statement history | compliant | — | — |

### liability_ai · zod_schema · `aie:liability/schema.ts#liabilityStatementActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | Liabilities tab → Statement history | compliant | — | — |
| `activityDate` | B event | fdh_transactions.transaction_date | Liabilities tab → Statement history | compliant | — | — |
| `amount` | B event | fdh_transactions.amount_original | Liabilities tab → Statement history | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | Liabilities tab → Statement history | compliant | — | — |
| `merchantRaw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw (copied to the ledger row) | Financial Activity (transaction detail) | compliant | — | — |
| `principalComponent` | B event | fdh_transaction_allocations (debt_principal) | Liabilities tab → Statement history | compliant | — | — |
| `interestComponent` | B event | fdh_transaction_allocations (debt_interest) | Liabilities tab → Statement history | compliant | — | — |
| `feeComponent` | B event | fdh_transaction_allocations (fee) | Liabilities tab → Statement history | compliant | — | — |

### liability_native · db_column · `db:fdh_liability_statements`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_liability_statements.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_liability_statements.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_liability_statements.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_liability_statements.statement_upload_id | — | compliant | — | — |
| `financial_account_id` | D metadata | fdh_liability_statements.financial_account_id (set by the Apply RPC) | — | compliant | — | — |
| `liability_id` | D metadata | fdh_liability_statements.liability_id (set by the Apply RPC) | — | compliant | — | — |
| `statement_type` | D metadata | fdh_liability_statements.statement_type | — | compliant | — | — |
| `facility_type` | A state | liabilities.debt_type | Liabilities tab | compliant | — | — |
| `country_code` | A state | liabilities.country_code | Liabilities tab | compliant | — | — |
| `currency_code` | A state | liabilities.currency_code (AUD/INR only; any other currency is refused with a visible reason) | Liabilities tab | compliant | — | — |
| `institution_name` | A state | liabilities.lender | Liabilities tab | compliant | — | — |
| `masked_identifier` | A state | liabilities.masked_identifier | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `statement_period_start` | C evidence | evidence:fdh_liability_statements.statement_period_start | Liabilities tab → Statement history | compliant | — | — |
| `statement_period_end` | C evidence | evidence:fdh_liability_statements.statement_period_end | Liabilities tab → Statement history | compliant | — | — |
| `statement_date` | C evidence | evidence:fdh_liability_statements.statement_date | Liabilities tab → Statement history | compliant | — | — |
| `due_date` | A state | liabilities.due_date | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `opening_balance` | C evidence | evidence:fdh_liability_statements.opening_balance | Liabilities tab → Statement history | compliant | — | — |
| `closing_balance` | A state | liabilities.balance (card) | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `credit_limit` | A state | liabilities.credit_limit (not in Net Worth) | Liabilities tab | compliant | — | — |
| `minimum_payment` | A state | liabilities.minimum_payment (monthly_repayment only when ticked; D-08) | Liabilities tab | compliant | — | — |
| `interest_rate` | A state | liabilities.interest_rate (loan) / card APR in statement history | Liabilities tab; Liabilities tab → Statement history | compliant | — | — |
| `available_credit` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `opening_principal` | C evidence | evidence:fdh_liability_statements.opening_principal | Liabilities tab → Statement history | compliant | — | — |
| `closing_principal` | A state | liabilities.balance (loan) | Liabilities tab (grid field + "Imported from credit card / loan statement" badge) | compliant | — | — |
| `rate_type` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `repayment_frequency` | E unsupported | not read from statements (proposal reads null) | Liabilities tab → Import Statement (review) ("Not shown on statement"); Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `maturity_date` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `arrears_amount` | E unsupported | not read from statements | Liabilities tab → Statement history ("Not read from statements …") | compliant | — | — |
| `purchases_total` | C evidence | evidence:fdh_liability_statements.purchases_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `cash_advances_total` | C evidence | evidence:fdh_liability_statements.cash_advances_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `interest_total` | C evidence | evidence:fdh_liability_statements.interest_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `fees_total` | C evidence | evidence:fdh_liability_statements.fees_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `payments_total` | C evidence | evidence:fdh_liability_statements.payments_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `refunds_total` | C evidence | evidence:fdh_liability_statements.refunds_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `adjustments_total` | C evidence | evidence:fdh_liability_statements.adjustments_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `drawdowns_total` | C evidence | evidence:fdh_liability_statements.drawdowns_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `capitalised_total` | C evidence | evidence:fdh_liability_statements.capitalised_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
| `principal_repayments_total` | C evidence | evidence:fdh_liability_statements.principal_repayments_total (equals the ledger sum per type; computeStatementTotals) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history | compliant | — | — |
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
| `extraction_warnings` | E unsupported | fdh_liability_statements.extraction_warnings (excluded rows and unchecked figures, with the reason) | Liabilities tab → Import Statement (review); Liabilities tab → Statement history (notes) | compliant | — | — |
| `ledger_status` | D metadata | fdh_liability_statements.ledger_status (not_applied / applied / rejected; set by the Apply RPC, shown in Statement history) | — | compliant | — | — |
| `ledger_applied_at` | D metadata | fdh_liability_statements.ledger_applied_at | — | compliant | — | — |
| `ledger_rejected_reason` | D metadata | fdh_liability_statements.ledger_rejected_reason ("You rejected this statement" in Statement history) | — | compliant | — | — |

### liability_native · db_column · `db:fdh_liability_statement_activities`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_liability_statement_activities.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_liability_statement_activities.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_liability_statement_activities.statement_id | — | compliant | — | — |
| `activity_type` | B event | fdh_transactions.economic_transaction_type (see liabilityActivityLedger) | Liabilities tab → Statement history | compliant | — | — |
| `activity_date` | B event | fdh_transactions.transaction_date | Liabilities tab → Statement history | compliant | — | — |
| `amount` | B event | fdh_transactions.amount_original | Liabilities tab → Statement history | compliant | — | — |
| `description_raw` | C evidence | evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row) | Liabilities tab → Statement history | compliant | — | — |
| `merchant_raw` | C evidence | evidence:fdh_liability_statement_activities.merchant_raw (copied to the ledger row) | Financial Activity (transaction detail) | compliant | — | — |
| `principal_component` | B event | fdh_transaction_allocations (debt_principal) | Liabilities tab → Statement history | compliant | — | — |
| `interest_component` | B event | fdh_transaction_allocations (debt_interest) | Liabilities tab → Statement history | compliant | — | — |
| `fee_component` | B event | fdh_transaction_allocations (fee) | Liabilities tab → Statement history | compliant | — | — |
| `currency_code` | B event | fdh_transactions.currency_original | Liabilities tab → Statement history | compliant | — | — |
| `description_clean` | C evidence | evidence:fdh_liability_statement_activities.description_clean | Financial Activity (transaction detail) | compliant | — | — |
| `merchant_id` | D metadata | fdh_liability_statement_activities.merchant_id (category lives on the ledger row) | — | compliant | — | — |
| `category_id` | B event | fdh_transactions.category_id (R8 category only, never economic type) | Financial Activity | compliant | — | — |
| `linked_transaction_id` | D metadata | the bank leg of a PAYMENT (re-verified and confirmed as a settlement link by the Apply RPC) | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_liability_statement_activities.bank_match_status (shown per repayment in review and history) | — | compliant | — | — |
| `review_status` | D metadata | fdh_liability_statement_activities.review_status | — | compliant | — | — |
| `source_row_number` | D metadata | fdh_liability_statement_activities.source_row_number | — | compliant | — | — |
| `created_at` | D metadata | fdh_liability_statement_activities.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_liability_statement_activities.updated_at | — | compliant | — | — |
| `ledger_transaction_id` | D metadata | the fdh_transactions row this activity became (0207; set by the Apply RPC) | — | compliant | — | — |
| `gst_amount_raw` | C evidence | evidence:fdh_liability_statement_activities.gst_amount_raw (never summed) | Liabilities tab → Statement history | compliant | — | — |
| `bank_match_candidate_ids` | D metadata | the possible bank debits of an ambiguous repayment (review picker; the choice is re-verified) | — | compliant | — | — |
| `ledger_disposition` | D metadata | fdh_liability_statement_activities.ledger_disposition (recorded / duplicate / not counted / rejected; shown in Statement history) | — | compliant | — | — |
| `ledger_duplicate_of_transaction_id` | D metadata | the earlier ledger row an overlapping statement line duplicates (never inserted twice) | — | compliant | — | — |

## liabilityActivityLedger (owner WP-11)

### liability_ledger · enum_value · `enum:LIABILITY_ACTIVITY_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `PURCHASE` | B event | fdh_transactions(card facility debit, type=expense, R8-categorised) | Liabilities tab → Statement history | compliant | — | — |
| `REFUND` | B event | fdh_transactions(card facility credit, type=refund; optional refund_original link) | Liabilities tab → Statement history | compliant | — | — |
| `PAYMENT` | B event | fdh_transactions(facility credit, type=transfer) + fdh_transaction_links(credit_card_settlement \| loan_payment, confirmed) | Liabilities tab → Statement history | compliant | — | — |
| `CASH_ADVANCE` | B event | fdh_transactions(facility debit, type=cash_withdrawal) | Liabilities tab → Statement history | compliant | — | — |
| `INTEREST` | B event | fdh_transactions(facility debit, type=debt_interest) | Liabilities tab → Statement history | compliant | — | — |
| `FEE` | B event | fdh_transactions(facility debit, type=fee) | Liabilities tab → Statement history | compliant | — | — |
| `PRINCIPAL` | B event | fdh_transactions(loan credit, type=debt_principal) | Liabilities tab → Statement history | compliant | — | — |
| `LOAN_ADVANCE` | B event | fdh_transactions(loan debit, type=transfer) | Liabilities tab → Statement history | compliant | — | — |
| `ADJUSTMENT` | E unsupported | not counted: fdh_liability_statement_activities.ledger_disposition = excluded_unclassified (Apply is BLOCKING_REVIEW until the user acknowledges it) | Liabilities tab → Statement history ("Not counted — we cannot tell what it is") | compliant | — | — |
| `OTHER` | E unsupported | not counted: fdh_liability_statement_activities.ledger_disposition = excluded_unclassified (Apply is BLOCKING_REVIEW until the user acknowledges it) | Liabilities tab → Statement history ("Not counted — we cannot tell what it is") | compliant | — | — |

## auInvestmentStatement (owner WP-12)

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuInvestmentStatementExtraction`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `statementType` | C evidence | evidence:fdh_investment_statements.statement_type | Investments tab: Imported statements | compliant | — | — |
| `country` | D metadata | fdh_investment_statements.investment_jurisdiction | — | compliant | — | — |
| `currencyCode` | A state | ii_accounts.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `institutionName` | A state | ii_accounts.institution_name | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `maskedAccountIdentifier` | A state | ii_accounts.account_number_masked ("Add as new account") | AU import panel (statement review) | compliant | — | — |
| `nickname` | D metadata | fdh_investment_statements.nickname (no extractor sets it; never a financial fact) | — | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_investment_statements.statement_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statementPeriodStart` | C evidence | evidence:fdh_investment_statements.statement_start_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statementPeriodEnd` | C evidence | evidence:fdh_investment_statements.statement_end_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `openingPortfolioValue` | C evidence | evidence:fdh_investment_statements.opening_portfolio_value (from an "Opening value" line) | AU import panel (statement review) | compliant | — | — |
| `closingPortfolioValue` | C evidence | evidence:fdh_investment_statements.closing_portfolio_value (from a "Total" line; reconciles the holdings) | AU import panel (statement review) | compliant | — | — |
| `cashBalance` | E unsupported | broker cash unsupported for now (D-11): stored as evidence, never counted | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `positions` | A state | ii_holding_snapshots | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `transactions` | B event | ii_transactions | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `parserName` | D metadata | fdh_investment_statements.parser | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_investment_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_investment_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | E unsupported | fdh_investment_statements.extraction_warnings (0207): "N rows could not be read" | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuStatementPositionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `securityNameRaw` | A state | ii_instruments.instrument_name ("Create security") | AU import panel (statement review) | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `unitPrice` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `marketValue` | A state | ii_holding_snapshots.value (null refused with a visible reason, never 0) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `valuationDate` | A state | ii_holding_snapshots.as_of_date (parsed; unreadable -> statement date + warning) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `exchange` | A state | ii_instrument_identifiers (defaults ASX) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `currencyCode` | A state | ii_holding_snapshots.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_investment_statement_positions.source_row_number | — | compliant | — | — |

### au_investment_native · ts_interface · `fdh:investment/types.ts#AuStatementTransactionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionType` | B event | ii_transactions.transaction_type (+ the corroborated bank leg re-typed via fdh_transactions) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `tradeDate` | B event | ii_transactions.transaction_date | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `settlementDate` | C evidence | evidence:fdh_investment_statement_activities.settlement_date | AU import panel (statement review) | compliant | — | — |
| `securityNameRaw` | A state | ii_instruments (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `unitPrice` | B event | ii_transactions.price_per_unit | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `currencyCode` | B event | ii_transactions.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `descriptionRaw` | B event | ii_transactions.source_description (DISTRIBUTION keeps its name here) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `brokerageRaw` | B event | ii_transactions.fees (parsed) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `frankingCreditRaw` | C evidence | evidence:fdh_investment_statement_activities.franking_credit_raw (tax evidence, parsed) | AU import panel (statement review) | compliant | — | — |
| `withholdingTaxRaw` | B event | ii_transactions.taxes (parsed) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_investment_statement_activities.source_row_number (+ in-statement occurrence in the fingerprint) | — | compliant | — | — |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `institutionName` | A state | ii_accounts.institution_name | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_investment_statements.statement_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statementPeriodStart` | C evidence | evidence:fdh_investment_statements.statement_start_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statementPeriodEnd` | C evidence | evidence:fdh_investment_statements.statement_end_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `allRowsListed` | C evidence | fdh_investment_statements.extraction_warnings: ai_reported_rows_incomplete (40-row cap), persisted at confirm | AU import panel (statement review) (draft and saved statement) | compliant | — | — |
| `holdings` | A state | ii_holding_snapshots | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `transactions` | B event | ii_transactions | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentHoldingSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `securityNameRaw` | A state | ii_instruments.instrument_name ("Create security") | AU import panel (statement review) | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `unitPrice` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `marketValue` | A state | ii_holding_snapshots.value (null refused with a visible reason, never 0) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `valuationDate` | A state | ii_holding_snapshots.as_of_date (parsed; unreadable -> statement date + warning) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |

### au_investment_ai · zod_schema · `aie:auInvestment/schema.ts#auInvestmentActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `transactionType` | B event | ii_transactions.transaction_type (+ the corroborated bank leg re-typed via fdh_transactions) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `tradeDate` | B event | ii_transactions.transaction_date | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `settlementDate` | C evidence | evidence:fdh_investment_statement_activities.settlement_date | AU import panel (statement review) | compliant | — | — |
| `securityNameRaw` | A state | ii_instruments (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `tickerRaw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `unitPrice` | B event | ii_transactions.price_per_unit | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `brokerage` | B event | ii_transactions.fees | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |

### au_investment_native · enum_value · `enum:AU_STATEMENT_TRANSACTION_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `BUY` | B event | ii_transactions(purchase); the corroborated bank funding leg -> investment (spending 0) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `SELL` | B event | ii_transactions(sale); the corroborated bank proceeds leg -> asset_sale (ordinary income 0) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `DIVIDEND` | B event | ii_transactions(dividend); the bank credit stays the single household-income leg (corroboration only) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `DISTRIBUTION` | B event | ii_transactions(dividend, source_description DISTRIBUTION); bank credit = the one income leg | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `INTEREST` | E unsupported | broker cash interest: skipped with the D-11 reason | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
| `BROKERAGE` | B event | ii_transactions(fee); a line naming no security is skipped with a reason | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `FEE` | B event | ii_transactions(fee); a line naming no security is skipped with a reason | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `TRANSFER_IN` | B event | ii_transactions(transfer_in) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `TRANSFER_OUT` | B event | ii_transactions(transfer_out) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `CASH_DEPOSIT` | E unsupported | broker cash: skipped with the D-11 reason; the bank leg -> investment (spending 0) | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
| `CASH_WITHDRAWAL` | E unsupported | broker cash: skipped with the D-11 reason; the bank leg -> transfer (income 0) | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
| `DRP` | B event | ii_transactions(reinvestment) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `CORPORATE_ACTION_EVIDENCE` | E unsupported | never auto-applied: skipped with a reason | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
| `OTHER` | E unsupported | skipped with a reason | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
| `UNKNOWN` | E unsupported | skipped with a reason | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |

### au_investment_native · db_column · `db:fdh_investment_statements`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_investment_statements.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_investment_statements.user_id | — | compliant | — | — |
| `household_id` | D metadata | fdh_investment_statements.household_id | — | compliant | — | — |
| `statement_upload_id` | D metadata | fdh_investment_statements.statement_upload_id | — | compliant | — | — |
| `canonical_account_id` | D metadata | fdh_investment_statements.canonical_account_id | — | compliant | — | — |
| `statement_type` | C evidence | evidence:fdh_investment_statements.statement_type | Investments tab: Imported statements | compliant | — | — |
| `investment_jurisdiction` | D metadata | fdh_investment_statements.investment_jurisdiction | — | compliant | — | — |
| `institution_name` | A state | ii_accounts.institution_name | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `masked_account_identifier` | A state | ii_accounts.account_number_masked | AU import panel (statement review) | compliant | — | — |
| `nickname` | D metadata | fdh_investment_statements.nickname (no extractor sets it) | — | compliant | — | — |
| `base_currency` | A state | ii_accounts.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `statement_date` | C evidence | evidence:fdh_investment_statements.statement_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statement_start_date` | C evidence | evidence:fdh_investment_statements.statement_start_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `statement_end_date` | C evidence | evidence:fdh_investment_statements.statement_end_date | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `opening_portfolio_value` | C evidence | evidence:fdh_investment_statements.opening_portfolio_value | AU import panel (statement review) | compliant | — | — |
| `closing_portfolio_value` | C evidence | evidence:fdh_investment_statements.closing_portfolio_value | AU import panel (statement review) | compliant | — | — |
| `cash_balance` | E unsupported | broker cash unsupported for now (D-11): shown, never counted | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |
| `parser` | D metadata | fdh_investment_statements.parser | — | compliant | — | — |
| `parser_version` | D metadata | fdh_investment_statements.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_investment_statements.extraction_confidence | — | compliant | — | — |
| `extraction_status` | D metadata | fdh_investment_statements.extraction_status | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_investment_statements.reconciliation_status (statement totals, computed at persist; shown in the panel) | — | compliant | — | — |
| `review_status` | D metadata | fdh_investment_statements.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_investment_statements.approval_status | — | compliant | — | — |
| `approved_at` | D metadata | fdh_investment_statements.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_investment_statements.approved_by | — | compliant | — | — |
| `duplicate_of_statement_id` | D metadata | fdh_investment_statements.duplicate_of_statement_id | — | compliant | — | — |
| `supersedes_statement_id` | D metadata | fdh_investment_statements.supersedes_statement_id | — | compliant | — | — |
| `source_provenance` | D metadata | fdh_investment_statements.source_provenance | — | compliant | — | — |
| `created_at` | D metadata | fdh_investment_statements.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_investment_statements.updated_at | — | compliant | — | — |
| `extraction_warnings` | E unsupported | fdh_investment_statements.extraction_warnings (0207) | AU import panel (statement review); Investments tab: Imported statements | compliant | — | — |

### au_investment_native · db_column · `db:fdh_investment_statement_positions`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_investment_statement_positions.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_investment_statement_positions.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_investment_statement_positions.statement_id | — | compliant | — | — |
| `security_name_raw` | A state | ii_instruments.instrument_name ("Create security") | AU import panel (statement review) | compliant | — | — |
| `ticker_raw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | A state | ii_holding_snapshots.units | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `unit_price` | A state | ii_holding_snapshots.source_nav (price_source statement_price) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `market_value` | A state | ii_holding_snapshots.value (null refused with a visible reason, never 0) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `valuation_date` | A state | ii_holding_snapshots.as_of_date (parsed; unreadable -> statement date + warning) | Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth") | compliant | — | — |
| `exchange` | A state | ii_instrument_identifiers | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `currency_code` | A state | ii_holding_snapshots.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `security_match_status` | D metadata | fdh_investment_statement_positions.security_match_status | — | compliant | — | — |
| `matched_instrument_id` | D metadata | fdh_investment_statement_positions.matched_instrument_id | — | compliant | — | — |
| `apply_status` | D metadata | fdh_investment_statement_positions.apply_status (created 'pending'; 0213 default + backfill) | — | compliant | — | — |
| `apply_rejected_reason` | E unsupported | fdh_investment_statement_positions.apply_rejected_reason (0213): why a holding was not added | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
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
| `activity_type` | B event | ii_transactions.transaction_type (+ the corroborated bank leg re-typed via fdh_transactions) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `trade_date` | B event | ii_transactions.transaction_date | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `settlement_date` | C evidence | evidence:fdh_investment_statement_activities.settlement_date | AU import panel (statement review) | compliant | — | — |
| `security_name_raw` | A state | ii_instruments (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `ticker_raw` | A state | ii_instrument_identifiers (match input) | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `quantity` | B event | ii_transactions.units | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `unit_price` | B event | ii_transactions.price_per_unit | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `amount` | B event | ii_transactions.gross_amount | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `isin` | A state | ii_instrument_identifiers | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `currency_code` | B event | ii_transactions.currency_code | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `description_raw` | B event | ii_transactions.source_description | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `brokerage_raw` | B event | ii_transactions.fees | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `franking_credit_raw` | C evidence | evidence:fdh_investment_statement_activities.franking_credit_raw | AU import panel (statement review) | compliant | — | — |
| `withholding_tax_raw` | B event | ii_transactions.taxes | Investment Intelligence screens; Investments tab once added to Net Worth | compliant | — | — |
| `security_match_status` | D metadata | fdh_investment_statement_activities.security_match_status | — | compliant | — | — |
| `matched_instrument_id` | D metadata | fdh_investment_statement_activities.matched_instrument_id | — | compliant | — | — |
| `linked_transaction_id` | D metadata | the corroborated bank leg (fdh_transactions; one-to-one, re-verified by the read models) | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_investment_statement_activities.bank_match_status (shown as "bank payment found") | — | compliant | — | — |
| `bank_match_candidates` | D metadata | fdh_investment_statement_activities.bank_match_candidates | — | compliant | — | — |
| `review_status` | D metadata | fdh_investment_statement_activities.review_status | — | compliant | — | — |
| `apply_status` | D metadata | fdh_investment_statement_activities.apply_status | — | compliant | — | — |
| `canonical_transaction_id` | D metadata | fdh_investment_statement_activities.canonical_transaction_id | — | compliant | — | — |
| `applied_at` | D metadata | fdh_investment_statement_activities.applied_at | — | compliant | — | — |
| `applied_by` | D metadata | fdh_investment_statement_activities.applied_by | — | compliant | — | — |
| `apply_rejected_reason` | E unsupported | the skip / rejection reason, rendered to the user | AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only") | compliant | — | — |
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
| `maskedAccountIdentifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementStartDate` | C evidence | evidence:fdh_retirement_statements.statement_start_date (annualises contribution totals, D-12) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementEndDate` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `openingBalance` | C evidence | evidence:fdh_retirement_statements.opening_balance | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `closingBalance` | A state | retirement_accounts.current_balance | Retirement tab ("Imported from retirement statement" badge, WP-07) | compliant | — | — |
| `employerContributions` | A state | retirement_accounts.employer_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `personalContributions` | A state | retirement_accounts.personal_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `salarySacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `governmentContributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rolloversIn` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rolloversOut` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `pensionPayments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `investmentEarnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (repeated lines summed; never a household expense) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `insurancePremiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ytdEmployerContributions` | C evidence | evidence:fdh_retirement_statements.ytd_employer_contributions (labelled YTD) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ytdPersonalContributions` | C evidence | evidence:fdh_retirement_statements.ytd_personal_contributions (labelled YTD) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `activities` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `positions` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `parserName` | D metadata | fdh_retirement_statements.parser | — | compliant | — | — |
| `parserVersion` | D metadata | fdh_retirement_statements.parser_version | — | compliant | — | — |
| `extractionConfidence` | D metadata | fdh_retirement_statements.extraction_confidence | — | compliant | — | — |
| `warnings` | C evidence | fdh_retirement_statements.extraction_warnings (0207; persisted by WP-13, write-guarded by 0211) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |

### retirement_native · ts_interface · `fdh:retirement/types.ts#RetirementActivityEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `activityDate` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `employerNameRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `isSummaryTotal` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `isYearToDate` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |
| `currencyCode` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `effectivePeriodStart` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `effectivePeriodEnd` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_retirement_statement_activities.source_row_number | — | compliant | — | — |

### retirement_native · ts_interface · `fdh:retirement/types.ts#RetirementPositionEvidence`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `optionNameRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `assetClassRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `unitPrice` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `marketValue` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `valuationDate` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `tickerRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `isin` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `currencyCode` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `sourceRowNumber` | D metadata | fdh_retirement_statement_positions.source_row_number | — | compliant | — | — |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementDocumentFactsSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `schemaVersion` | D metadata | aie run evidence | — | compliant | — | — |
| `documentMissingReasonCode` | D metadata | aie run evidence | — | compliant | — | — |
| `fundName` | A state | retirement_accounts.account_name (add new) | Retirement tab | compliant | — | — |
| `maskedAccountIdentifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementDate` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementStartDate` | C evidence | evidence:fdh_retirement_statements.statement_start_date (annualises contribution totals, D-12) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statementEndDate` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `openingBalance` | C evidence | evidence:fdh_retirement_statements.opening_balance | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `closingBalance` | A state | retirement_accounts.current_balance | Retirement tab ("Imported from retirement statement" badge, WP-07) | compliant | — | — |
| `employerContributions` | A state | retirement_accounts.employer_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `personalContributions` | A state | retirement_accounts.personal_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `salarySacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `governmentContributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rolloversIn` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rolloversOut` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `pensionPayments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `investmentEarnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (repeated lines summed; never a household expense) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `insurancePremiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `activities` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `positions` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementActivitySchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `activityType` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `activityDate` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `descriptionRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `employerNameRaw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `isSummaryTotal` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `isYearToDate` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |

### retirement_ai · zod_schema · `aie:retirement/schema.ts#retirementPositionSchema`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `optionNameRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `assetClassRaw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `unitPrice` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `marketValue` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `valuationDate` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |

### retirement_native · enum_value · `enum:RETIREMENT_ACTIVITY_TYPES`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `EMPLOYER_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); payslip + fund are ONE effect, never income | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `PERSONAL_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); the matched bank debit is a transfer (user-confirmed, fdh12_confirm_retirement_bank_leg) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `SALARY_SACRIFICE` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `GOVERNMENT_CONTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ROLLOVER_IN` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); fund A -> fund B is income 0 / expense 0 / net worth 0 | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ROLLOVER_OUT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); neutral | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `INVESTMENT_EARNINGS` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `INTEREST` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `DISTRIBUTION` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `FEE` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); never a household expense | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `INSURANCE_PREMIUM` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `TAX` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `PENSION_PAYMENT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); household income via the bank credit, once (user-confirmed) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `WITHDRAWAL` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); the bank credit is a transfer (user-confirmed) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ADJUSTMENT` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `OTHER` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `UNKNOWN` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger); shown for review, never classified silently | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |

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
| `nickname` | C evidence | evidence:fdh_retirement_statements.nickname (user-correctable label) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `currency_code` | A state | retirement_accounts.currency_code | Retirement tab | compliant | — | — |
| `fund_name` | A state | retirement_accounts.account_name (add new) | Retirement tab | compliant | — | — |
| `masked_account_identifier` | C evidence | evidence:fdh_retirement_statements.masked_account_identifier | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statement_date` | C evidence | evidence:fdh_retirement_statements.statement_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statement_start_date` | C evidence | evidence:fdh_retirement_statements.statement_start_date (annualises contribution totals, D-12) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `statement_end_date` | C evidence | evidence:fdh_retirement_statements.statement_end_date (balance as-of; an older statement never silently regresses the balance) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `opening_balance` | C evidence | evidence:fdh_retirement_statements.opening_balance | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `closing_balance` | A state | retirement_accounts.current_balance | Retirement tab ("Imported from retirement statement" badge, WP-07) | compliant | — | — |
| `employer_contributions` | A state | retirement_accounts.employer_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `personal_contributions` | A state | retirement_accounts.personal_contribution (annualised, only when ticked, with contribution_frequency; D-12) | Retirement tab > import review (comparison, ticked fields only) | compliant | — | — |
| `salary_sacrifice` | C evidence | evidence:fdh_retirement_statements.salary_sacrifice | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `government_contributions` | C evidence | evidence:fdh_retirement_statements.government_contributions | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rollovers_in` | C evidence | evidence:fdh_retirement_statements.rollovers_in (neutral: income 0 / expense 0 / net worth 0) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `rollovers_out` | C evidence | evidence:fdh_retirement_statements.rollovers_out (neutral) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `withdrawals` | C evidence | evidence:fdh_retirement_statements.withdrawals (the bank credit is the household leg) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `pension_payments` | C evidence | evidence:fdh_retirement_statements.pension_payments (household income via the bank credit, once) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `investment_earnings` | C evidence | evidence:fdh_retirement_statements.investment_earnings | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `fees` | C evidence | evidence:fdh_retirement_statements.fees (repeated lines summed; never a household expense) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `insurance_premiums` | C evidence | evidence:fdh_retirement_statements.insurance_premiums | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `tax` | C evidence | evidence:fdh_retirement_statements.tax | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ytd_employer_contributions` | C evidence | evidence:fdh_retirement_statements.ytd_employer_contributions | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ytd_personal_contributions` | C evidence | evidence:fdh_retirement_statements.ytd_personal_contributions | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `parser` | D metadata | fdh_retirement_statements.parser | — | compliant | — | — |
| `parser_version` | D metadata | fdh_retirement_statements.parser_version | — | compliant | — | — |
| `extraction_confidence` | D metadata | fdh_retirement_statements.extraction_confidence | — | compliant | — | — |
| `extraction_status` | D metadata | fdh_retirement_statements.extraction_status | — | compliant | — | — |
| `reconciliation_status` | D metadata | fdh_retirement_statements.reconciliation_status (system-authoritative on INSERT and UPDATE, 0211) | — | compliant | — | — |
| `reconciliation_variance` | D metadata | fdh_retirement_statements.reconciliation_variance | — | compliant | — | — |
| `account_match_status` | D metadata | fdh_retirement_statements.account_match_status | — | compliant | — | — |
| `account_match_candidates` | D metadata | fdh_retirement_statements.account_match_candidates | — | compliant | — | — |
| `smsf_classification` | D metadata | fdh_retirement_statements.smsf_classification | — | compliant | — | — |
| `smsf_evidence` | D metadata | fdh_retirement_statements.smsf_evidence | — | compliant | — | — |
| `review_status` | D metadata | fdh_retirement_statements.review_status | — | compliant | — | — |
| `approval_status` | D metadata | fdh_retirement_statements.approval_status (system-authoritative on INSERT and UPDATE, 0211) | — | compliant | — | — |
| `approved_at` | D metadata | fdh_retirement_statements.approved_at | — | compliant | — | — |
| `approved_by` | D metadata | fdh_retirement_statements.approved_by | — | compliant | — | — |
| `duplicate_of_statement_id` | D metadata | fdh_retirement_statements.duplicate_of_statement_id | — | compliant | — | — |
| `supersedes_statement_id` | D metadata | fdh_retirement_statements.supersedes_statement_id | — | compliant | — | — |
| `source_provenance` | D metadata | fdh_retirement_statements.source_provenance | — | compliant | — | — |
| `created_at` | D metadata | fdh_retirement_statements.created_at | — | compliant | — | — |
| `updated_at` | D metadata | fdh_retirement_statements.updated_at | — | compliant | — | — |
| `extraction_warnings` | C evidence | fdh_retirement_statements.extraction_warnings (0207; write-guarded by 0211) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |

### retirement_native · db_column · `db:fdh_retirement_statement_activities`

| Field | Disposition | Destination | User-visible at | Status | Gap | Owner |
|---|---|---|---|---|---|---|
| `id` | D metadata | fdh_retirement_statement_activities.id | — | compliant | — | — |
| `user_id` | D metadata | fdh_retirement_statement_activities.user_id | — | compliant | — | — |
| `statement_id` | D metadata | fdh_retirement_statement_activities.statement_id | — | compliant | — | — |
| `activity_type` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `amount` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `activity_date` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `description_raw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `employer_name_raw` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `is_summary_total` | D metadata | fdh_retirement_statement_activities.is_summary_total | — | compliant | — | — |
| `is_year_to_date` | D metadata | fdh_retirement_statement_activities.is_year_to_date | — | compliant | — | — |
| `effective_period_start` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `effective_period_end` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `currency_code` | C evidence | evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `employer_normalised` | D metadata | fdh_retirement_statement_activities.employer_normalised | — | compliant | — | — |
| `payslip_match_status` | D metadata | fdh_retirement_statement_activities.payslip_match_status | — | compliant | — | — |
| `matched_payroll_event_id` | D metadata | fdh_retirement_statement_activities.matched_payroll_event_id | — | compliant | — | — |
| `payslip_match_variance` | D metadata | fdh_retirement_statement_activities.payslip_match_variance | — | compliant | — | — |
| `payslip_match_candidates` | D metadata | fdh_retirement_statement_activities.payslip_match_candidates | — | compliant | — | — |
| `bank_match_status` | D metadata | fdh_retirement_statement_activities.bank_match_status (re-matched after a later bank approval, WP-13) | — | compliant | — | — |
| `linked_transaction_id` | D metadata | the matched bank leg (reclassified only with the user's confirmation, 0211) | — | compliant | — | — |
| `bank_leg_confirmed_at` | D metadata | fdh_retirement_statement_activities.bank_leg_confirmed_at (the user's confirmation, 0211) | — | compliant | — | — |
| `bank_leg_confirmed_type` | D metadata | fdh_retirement_statement_activities.bank_leg_confirmed_type (transfer \| income; the bank leg's type after confirmation, 0211) | — | compliant | — | — |
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
| `option_name_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `asset_class_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `units` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `unit_price` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `market_value` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `valuation_date` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `ticker_raw` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `isin` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
| `currency_code` | C evidence | evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth) | Retirement tab > Imported retirement statements (statement details) and the import review | compliant | — | — |
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

