/**
 * Financial Data Hub — closed vocabularies.
 *
 * Every list here is the single source of truth for one `check (x in (...))`
 * constraint in migrations 0045-0048. `tests/unit/fdh1SchemaContract.test.ts`
 * parses the migration SQL and asserts the two never drift apart.
 *
 * CASING. Values are lowercase snake_case, matching all 77 pre-existing
 * tables (there is no `create type ... as enum` anywhere in this schema, and
 * no uppercase enum value anywhere either). The FDH-1 specification names
 * these in UPPER_CASE; the mapping is 1:1 and is tabulated in
 * docs/financial-data-hub/FDH1_DOMAIN_MODEL.md section 2.
 */

// --- Country / currency -----------------------------------------------------
// Reuses the platform's existing ISO-3166-1 alpha-2 / ISO-4217 convention
// (`countries.country_code`, `currencies.currency_code`, lib/constants.ts).
// No second country convention is introduced.
export const FDH_COUNTRY_CODES = ['AU', 'IN'] as const;
export type FdhCountryCode = (typeof FDH_COUNTRY_CODES)[number];

// --- Institutions and sources ----------------------------------------------
export const FDH_INSTITUTION_TYPES = [
  'bank',
  'credit_card_issuer',
  'lender',
  'broker',
  'investment_platform',
  'depository',
  'mutual_fund_platform',
  'super_fund',
  'retirement_provider',
  'payroll_source',
  'other',
] as const;
export type FdhInstitutionType = (typeof FDH_INSTITUTION_TYPES)[number];

/** How the data arrived — deliberately separate from WHO it came from. */
export const FDH_SOURCE_TYPES = [
  'csv',
  'pdf_native',
  'pdf_scanned',
  'xlsx',
  'manual_mapping',
  'cdr',
  'account_aggregator',
  'api',
  'other',
] as const;
export type FdhSourceType = (typeof FDH_SOURCE_TYPES)[number];

// --- Accounts ---------------------------------------------------------------
/**
 * The `*_source` members describe where a DOCUMENT came from. They are not
 * canonical investment accounts — Investment Intelligence owns those
 * (`ii_accounts`). See docs/financial-data-hub/FDH1_INVESTMENT_BOUNDARY.md.
 */
export const FDH_ACCOUNT_TYPES = [
  'transaction',
  'savings',
  'term_deposit',
  'credit_card',
  'home_loan',
  'personal_loan',
  'vehicle_loan',
  'brokerage_source',
  'super_source',
  'epf_source',
  'nps_source',
  'other',
] as const;
export type FdhAccountType = (typeof FDH_ACCOUNT_TYPES)[number];

export const FDH_ACCOUNT_STATUSES = ['active', 'dormant', 'closed', 'archived'] as const;
export type FdhAccountStatus = (typeof FDH_ACCOUNT_STATUSES)[number];

// --- Documents --------------------------------------------------------------
export const FDH_DOCUMENT_TYPES = [
  'bank_statement',
  'credit_card_statement',
  'loan_statement',
  'payslip',
  'investment_statement',
  'super_statement',
  'epf_statement',
  'nps_statement',
  'tax_document',
  'other',
] as const;
export type FdhDocumentType = (typeof FDH_DOCUMENT_TYPES)[number];

export const FDH_PROCESSING_STATUSES = [
  'created',
  'uploaded',
  'validating',
  'queued',
  'processing',
  'extracted',
  'review_required',
  'ready_for_approval',
  'approved',
  'rejected',
  'failed',
  'purge_pending',
  'purged',
] as const;
export type FdhProcessingStatus = (typeof FDH_PROCESSING_STATUSES)[number];

export const FDH_REVIEW_STATUSES = ['not_required', 'pending', 'in_review', 'resolved'] as const;
export type FdhReviewStatus = (typeof FDH_REVIEW_STATUSES)[number];

export const FDH_PROCESSING_METHODS = [
  'native_text',
  'ocr',
  'csv_parse',
  'xlsx_parse',
  'manual_mapping',
  'connected_feed',
] as const;
export type FdhProcessingMethod = (typeof FDH_PROCESSING_METHODS)[number];

export const FDH_QUALITY_STATUSES = ['not_assessed', 'pass', 'warning', 'fail'] as const;
export type FdhQualityStatus = (typeof FDH_QUALITY_STATUSES)[number];

// --- Ingestion jobs ---------------------------------------------------------
export const FDH_JOB_TYPES = [
  'document_validate',
  'document_classify',
  'document_extract',
  'document_reconcile',
  'transaction_classify',
  'duplicate_check',
  'transfer_match',
  'summary_build',
  'privacy_purge',
] as const;
export type FdhJobType = (typeof FDH_JOB_TYPES)[number];

export const FDH_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter',
] as const;
export type FdhJobStatus = (typeof FDH_JOB_STATUSES)[number];

// --- Errors -----------------------------------------------------------------
/**
 * The complete, controlled processing-error taxonomy. A user or an operator
 * only ever sees one of these codes plus a sanitised message. An internal
 * stack trace, an SQL error, a file path or a library exception must never be
 * persisted or surfaced. See FDH1_STATE_MACHINES.md section 5.
 */
export const FDH_ERROR_CODES = [
  'unsupported_file_type',
  'file_corrupt',
  'password_required',
  'password_invalid',
  'institution_not_identified',
  'document_type_not_identified',
  'parser_not_found',
  'layout_unsupported',
  'extraction_failed',
  'reconciliation_failed',
  'data_validation_failed',
  'malware_detected',
  'privacy_purge_failed',
  'internal_error',
] as const;
export type FdhErrorCode = (typeof FDH_ERROR_CODES)[number];

// --- Transactions -----------------------------------------------------------
/** Direction of movement on the account. NEVER an economic meaning. */
export const FDH_CREDIT_DEBIT = ['credit', 'debit'] as const;
export type FdhCreditDebit = (typeof FDH_CREDIT_DEBIT)[number];

/**
 * Economic meaning of a movement. NEVER derived from `credit_debit`.
 *
 * This is the taxonomy approved for FDH-1 and is retained unchanged.
 * Two candidate additions surfaced during architectural review —
 * `liability_settlement` and `retirement_contribution` — are recorded as
 * RECOMMENDATIONS WITH RATIONALE in
 * docs/financial-data-hub/FDH1_DOMAIN_MODEL.md section 4, and have
 * deliberately NOT been added here. Uncontrolled taxonomy expansion is worse
 * than a documented gap.
 */
export const FDH_ECONOMIC_TRANSACTION_TYPES = [
  'income',
  'expense',
  'transfer',
  'investment',
  'debt_principal',
  'debt_interest',
  'refund',
  'asset_purchase',
  'asset_sale',
  'tax',
  'fee',
  'cash_withdrawal',
  'unknown',
] as const;
export type FdhEconomicTransactionType = (typeof FDH_ECONOMIC_TRANSACTION_TYPES)[number];

export const FDH_CLASSIFICATION_METHODS = [
  'source',
  'merchant_master',
  'global_rule',
  'user_rule',
  'ai',
  'user_manual',
  'admin_master_data',
  'unclassified',
] as const;
export type FdhClassificationMethod = (typeof FDH_CLASSIFICATION_METHODS)[number];

/** `unclassified` is not a valid history entry — history records real changes. */
export const FDH_CLASSIFICATION_CHANGE_SOURCES = [
  'source',
  'merchant_master',
  'global_rule',
  'user_rule',
  'ai',
  'user_manual',
  'admin_master_data',
] as const;
export type FdhClassificationChangeSource = (typeof FDH_CLASSIFICATION_CHANGE_SOURCES)[number];

export const FDH_CHANGED_BY_TYPES = ['system', 'user', 'admin'] as const;
export type FdhChangedByType = (typeof FDH_CHANGED_BY_TYPES)[number];

export const FDH_FX_RATE_SOURCES = [
  'none',
  'user_supplied',
  'statement_supplied',
  'platform_static',
  'external_provider',
] as const;
export type FdhFxRateSource = (typeof FDH_FX_RATE_SOURCES)[number];

// --- Links / duplicates -----------------------------------------------------
export const FDH_TRANSACTION_LINK_TYPES = [
  'internal_transfer',
  'credit_card_settlement',
  'refund_original',
  'reversal_original',
  'duplicate',
  'investment_funding',
  'loan_payment',
  'other',
] as const;
export type FdhTransactionLinkType = (typeof FDH_TRANSACTION_LINK_TYPES)[number];

export const FDH_LINK_STATUSES = ['pending', 'confirmed', 'rejected', 'superseded'] as const;
export type FdhLinkStatus = (typeof FDH_LINK_STATUSES)[number];

export const FDH_LINK_CREATION_METHODS = [
  'system_rule',
  'algorithm',
  'ai',
  'user_manual',
  'admin',
] as const;
export type FdhLinkCreationMethod = (typeof FDH_LINK_CREATION_METHODS)[number];

export const FDH_DUPLICATE_MATCH_METHODS = [
  'exact_hash',
  'fuzzy_amount_date',
  'statement_overlap',
  'user_reported',
] as const;
export type FdhDuplicateMatchMethod = (typeof FDH_DUPLICATE_MATCH_METHODS)[number];

export const FDH_DUPLICATE_STATUSES = [
  'pending',
  'confirmed_duplicate',
  'not_duplicate',
  'auto_confirmed',
] as const;
export type FdhDuplicateStatus = (typeof FDH_DUPLICATE_STATUSES)[number];

export const FDH_DUPLICATE_RESOLUTIONS = ['kept_both', 'removed_a', 'removed_b', 'merged'] as const;
export type FdhDuplicateResolution = (typeof FDH_DUPLICATE_RESOLUTIONS)[number];

// --- Review -----------------------------------------------------------------
export const FDH_REVIEW_TYPES = [
  'low_extraction_confidence',
  'low_classification_confidence',
  'unknown_merchant',
  'possible_transfer',
  'missing_counterpart_account',
  'possible_duplicate',
  'reconciliation_failure',
  'transaction_split',
  'income_evidence',
  'other',
] as const;
export type FdhReviewType = (typeof FDH_REVIEW_TYPES)[number];

export const FDH_REVIEW_SEVERITIES = ['info', 'warning', 'blocking'] as const;
export type FdhReviewSeverity = (typeof FDH_REVIEW_SEVERITIES)[number];

export const FDH_REVIEW_ITEM_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'dismissed',
  'expired',
] as const;
export type FdhReviewItemStatus = (typeof FDH_REVIEW_ITEM_STATUSES)[number];

// --- Reconciliation / quality ----------------------------------------------
export const FDH_RECONCILIATION_STATUSES = [
  'not_available',
  'pending',
  'reconciled',
  'failed',
  'user_accepted_exception',
] as const;
export type FdhReconciliationStatus = (typeof FDH_RECONCILIATION_STATUSES)[number];

export const FDH_RECONCILIATION_METHODS = [
  'balance_rollforward',
  'transaction_count',
  'none',
] as const;
export type FdhReconciliationMethod = (typeof FDH_RECONCILIATION_METHODS)[number];

export const FDH_DATA_QUALITY_CHECKS = [
  'statement_period_found',
  'account_identified',
  'balance_reconciled',
  'transaction_count_valid',
  'duplicate_file',
  'low_extraction_confidence',
  'unsupported_layout',
  'date_ambiguity',
  'currency_ambiguity',
] as const;
export type FdhDataQualityCheck = (typeof FDH_DATA_QUALITY_CHECKS)[number];

export const FDH_DATA_QUALITY_STATUSES = ['pass', 'warning', 'fail', 'not_applicable'] as const;
export type FdhDataQualityStatus = (typeof FDH_DATA_QUALITY_STATUSES)[number];

// --- Master data / classification rules ------------------------------------
export const FDH_MERCHANT_TYPES = [
  'retail',
  'grocery',
  'utility',
  'telecom',
  'subscription',
  'transport',
  'fuel',
  'health',
  'education',
  'insurance',
  'financial_institution',
  'government',
  'entertainment',
  'hospitality',
  'other',
] as const;
export type FdhMerchantType = (typeof FDH_MERCHANT_TYPES)[number];

/** Governance lifecycle for centrally-owned master data. */
export const FDH_GOVERNANCE_STATUSES = [
  'proposed',
  'admin_review',
  'approved',
  'rejected',
  'merged',
] as const;
export type FdhGovernanceStatus = (typeof FDH_GOVERNANCE_STATUSES)[number];

export const FDH_ESSENTIAL_DISCRETIONARY = [
  'essential',
  'discretionary',
  'mixed',
  'not_applicable',
] as const;
export type FdhEssentialDiscretionary = (typeof FDH_ESSENTIAL_DISCRETIONARY)[number];

export const FDH_MERCHANT_ALIAS_TYPES = [
  'statement_narrative',
  'trading_name',
  'legal_name',
  'domain',
  'upi_handle',
  'bpay_biller',
  'other',
] as const;
export type FdhMerchantAliasType = (typeof FDH_MERCHANT_ALIAS_TYPES)[number];

export const FDH_MERCHANT_ALIAS_SOURCES = [
  'admin_curated',
  'imported_dataset',
  'derived_from_user_data',
  'external_reference',
] as const;
export type FdhMerchantAliasSource = (typeof FDH_MERCHANT_ALIAS_SOURCES)[number];

/**
 * Global rule types. `description_regex` is deliberately absent: an
 * admin-supplied unbounded regular expression evaluated over every user's
 * transaction narratives is a denial-of-service vector, and it is not needed
 * for any FDH-2 use case identified so far.
 */
export const FDH_GLOBAL_RULE_TYPES = [
  'merchant_exact',
  'merchant_alias',
  'mcc',
  'description_contains',
  'institution_narrative',
  'source_provided_category',
] as const;
export type FdhGlobalRuleType = (typeof FDH_GLOBAL_RULE_TYPES)[number];

/** User rules add an account-scoped default; they too carry no regex. */
export const FDH_USER_RULE_TYPES = [
  ...FDH_GLOBAL_RULE_TYPES,
  'account_scoped_default',
] as const;
export type FdhUserRuleType = (typeof FDH_USER_RULE_TYPES)[number];

// --- Recurring --------------------------------------------------------------
export const FDH_RECURRING_FREQUENCIES = [
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'annual',
  'irregular',
] as const;
export type FdhRecurringFrequency = (typeof FDH_RECURRING_FREQUENCIES)[number];

export const FDH_RECURRING_STATUSES = ['candidate', 'active', 'paused', 'ended'] as const;
export type FdhRecurringStatus = (typeof FDH_RECURRING_STATUSES)[number];

// --- Parsers ----------------------------------------------------------------
export const FDH_PARSER_VERSION_STATUSES = [
  'development',
  'certified',
  'deprecated',
  'disabled',
] as const;
export type FdhParserVersionStatus = (typeof FDH_PARSER_VERSION_STATUSES)[number];

// --- Privacy / purge --------------------------------------------------------
export const FDH_PURGE_STATUSES = [
  'not_required',
  'pending',
  'in_progress',
  'purged',
  'failed',
  'legal_hold',
] as const;
export type FdhPurgeStatus = (typeof FDH_PURGE_STATUSES)[number];

// --- Provenance / evidence --------------------------------------------------
export const FDH_PROVENANCE_ENTITY_TYPES = [
  'fdh_transaction',
  'fdh_transaction_allocation',
  'fdh_financial_account',
  'fdh_statement_upload',
  'fdh_recurring_transaction',
  'derived_fact',
] as const;
export type FdhProvenanceEntityType = (typeof FDH_PROVENANCE_ENTITY_TYPES)[number];

export const FDH_EVIDENCE_TYPES = [
  'bank_transaction',
  'payslip_document',
  'statement_document',
  'user_attestation',
  'external_reference',
  'other',
] as const;
export type FdhEvidenceType = (typeof FDH_EVIDENCE_TYPES)[number];
