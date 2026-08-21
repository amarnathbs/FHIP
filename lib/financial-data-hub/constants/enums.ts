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
/**
 * FROZEN — the institution-type vocabulary exactly as FDH-1 shipped it
 * (migration 0045). `tests/unit/fdh1SchemaContract.test.ts` checks this
 * against the check constraint in 0045's own SQL text, so it must never
 * change. FDH-2's widened set is `FDH_INSTITUTION_TYPES` below.
 */
export const FDH1_INSTITUTION_TYPES = [
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

/**
 * FDH-2 WIDENING (2026-08-21): adds `government_payment_source` and
 * `payment_processor`, both named explicitly in the FDH-2 specification
 * institution-type list (section 24-28) and absent from the FDH-1 set. This is
 * a forward, additive widening of the existing `check (... in (...))` — no
 * value is removed and no existing row's meaning changes. See migration
 * `0051_fdh2_institution_and_payment_rail_foundation.sql`, whose widened
 * check constraint `tests/unit/fdh2SchemaContract.test.ts` verifies this
 * list against.
 */
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
  'government_payment_source',
  'payment_processor',
  'other',
] as const;
export type FdhInstitutionType = (typeof FDH_INSTITUTION_TYPES)[number];

/**
 * Parser/data-connection coverage status for an institution. FDH-2 sets every
 * seeded institution to `master_only` — it must never imply a parser exists
 * before one is independently certified (FDH-3+).
 */
export const FDH_INSTITUTION_COVERAGE_STATUSES = [
  'master_only',
  'parser_planned',
  'parser_in_development',
  'parser_certified',
  'connected_data_future',
  'deprecated',
] as const;
export type FdhInstitutionCoverageStatus = (typeof FDH_INSTITUTION_COVERAGE_STATUSES)[number];

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

/**
 * FDH-2 WIDENING (2026-08-21): adds `user_dependent`, named explicitly in the
 * FDH-2 specification (section 12-20: "do not force ambiguous categories...
 * into a single bucket; use MIXED/USER_DEPENDENT where context matters").
 * Additive only — no existing value removed.
 */
export const FDH_ESSENTIAL_DISCRETIONARY = [
  'essential',
  'discretionary',
  'mixed',
  'user_dependent',
  'not_applicable',
] as const;
export type FdhEssentialDiscretionary = (typeof FDH_ESSENTIAL_DISCRETIONARY)[number];

/**
 * Fixed/variable spending-shape metadata. Purely descriptive — never
 * classification logic. New in FDH-2.
 */
export const FDH_FIXED_VARIABLE = [
  'fixed',
  'variable',
  'semi_variable',
  'user_dependent',
  'not_applicable',
] as const;
export type FdhFixedVariable = (typeof FDH_FIXED_VARIABLE)[number];

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
 *
 * FDH-2 WIDENING (2026-08-21): adds `narrative_pattern` (required/excluded
 * term matching — income/salary/government/transfer/fee/interest/
 * cash-withdrawal/refund/credit-card-payment/investment-transfer pattern
 * seeds) and `payment_rail_narrative` (payment-mechanism recognition, kept
 * structurally separate from economic classification). Both are bounded,
 * non-regex substring matches — see validation/classification.ts. Additive
 * only; see migration 0052_fdh2_merchant_and_governance_foundation.sql.
 */
export const FDH_GLOBAL_RULE_TYPES = [
  'merchant_exact',
  'merchant_alias',
  'mcc',
  'description_contains',
  'institution_narrative',
  'source_provided_category',
  'narrative_pattern',
  'payment_rail_narrative',
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

// =============================================================================
// FDH-2 — category/MCC/institution/merchant/rule/governance vocabularies.
// =============================================================================

/** Where a provenance-recorded fact came from. Shared by every FDH-2 table
 * carrying `source_key`, via `fdh_source_registry.source_category`. */
export const FDH_SOURCE_CATEGORIES = [
  'official_mcc_reference',
  'institution_official_website',
  'public_company_information',
  'government_official_source',
  'fhip_design_decision',
  'industry_public_documentation',
  'other',
] as const;
export type FdhSourceCategory = (typeof FDH_SOURCE_CATEGORIES)[number];

/** Broad, non-overlapping MCC grouping used only for display/browse, never for
 * classification by itself. */
export const FDH_MCC_BROAD_GROUPS = [
  'retail_merchandise',
  'grocery_supermarket',
  'food_beverage',
  'fuel_automotive',
  'utilities_telecom',
  'transport_travel',
  'health_medical',
  'education',
  'financial_services',
  'government_services',
  'insurance',
  'entertainment_recreation',
  'professional_services',
  'wholesale_business',
  'other',
] as const;
export type FdhMccBroadGroup = (typeof FDH_MCC_BROAD_GROUPS)[number];

export const FDH_MCC_MAPPING_CONFIDENCE = ['high', 'medium', 'low', 'context_required'] as const;
export type FdhMccMappingConfidence = (typeof FDH_MCC_MAPPING_CONFIDENCE)[number];

export const FDH_MCC_MAPPING_TYPES = ['direct', 'broad_group_only', 'ambiguous_unmapped'] as const;
export type FdhMccMappingType = (typeof FDH_MCC_MAPPING_TYPES)[number];

/** Alias-library provenance for BOTH institution and merchant aliases. */
export const FDH_ALIAS_SOURCES = ['admin_curated', 'imported_dataset', 'external_reference'] as const;
export type FdhAliasSource = (typeof FDH_ALIAS_SOURCES)[number];

/** Structured merchant/MCC confidence states. Never a fabricated precise
 * percentage — see FDH-2 specification section 83-93. */
export const FDH_MCC_CONFIDENCE_STATES = ['verified', 'high', 'medium', 'low'] as const;
export type FdhMccConfidenceState = (typeof FDH_MCC_CONFIDENCE_STATES)[number];

/** Merchant-level recurrence LIKELIHOOD only — never "this transaction IS
 * recurring". Detection is a future engine (FDH-6). */
export const FDH_RECURRING_TYPES = [
  'subscription',
  'utility',
  'insurance',
  'membership',
  'loan_or_financial',
  'telecom',
  'rent_or_housing',
  'government',
  'other_recurring',
  'not_normally_recurring',
  'unknown',
] as const;
export type FdhRecurringType = (typeof FDH_RECURRING_TYPES)[number];

/** A payment MECHANISM — deliberately never an economic category. */
export const FDH_PAYMENT_RAIL_CATEGORIES = [
  'card',
  'direct_debit',
  'direct_credit',
  'bill_payment',
  'p2p_transfer',
  'atm',
  'wire',
  'cash',
  'other',
] as const;
export type FdhPaymentRailCategory = (typeof FDH_PAYMENT_RAIL_CATEGORIES)[number];

/** An institution may hold several capabilities without duplicating the
 * institution row. Deliberately the same closed vocabulary as
 * `FDH_INSTITUTION_TYPES`, so a capability can never name something the
 * primary `institution_type` column itself could not hold. */
export const FDH_INSTITUTION_CAPABILITY_TYPES = FDH_INSTITUTION_TYPES;
export type FdhInstitutionCapabilityType = FdhInstitutionType;

/**
 * The global-learning governance workflow's candidate kinds. A candidate is
 * always AGGREGATE evidence about a proposed merchant/alias/rule change —
 * never a bag of one user's raw transaction text.
 */
export const FDH_GLOBAL_LEARNING_CANDIDATE_TYPES = [
  'merchant_alias',
  'merchant_new',
  'classification_rule',
] as const;
export type FdhGlobalLearningCandidateType = (typeof FDH_GLOBAL_LEARNING_CANDIDATE_TYPES)[number];

export const FDH_GLOBAL_LEARNING_STATUSES = [
  'open',
  'admin_review',
  'approved',
  'rejected',
  'merged',
] as const;
export type FdhGlobalLearningStatus = (typeof FDH_GLOBAL_LEARNING_STATUSES)[number];

/** A conservative, explainable heuristic gate — never complex AI-based PII
 * detection (FDH-2 specification section 55-64/83-93). */
export const FDH_PII_SCREENING_STATUSES = ['not_screened', 'passed', 'flagged', 'rejected'] as const;
export type FdhPiiScreeningStatus = (typeof FDH_PII_SCREENING_STATUSES)[number];

/**
 * The two NEW discriminated-union members FDH-2 adds to
 * `fdhRuleMatchDefinitionSchema` (validation/classification.ts).
 * `narrative_pattern` covers required/excluded term matching for
 * income/salary/government/transfer/fee/interest/cash-withdrawal/refund/
 * credit-card-payment/investment-transfer pattern seeds — the FDH-1
 * `description_contains` member only supported one needle and cannot express
 * "PAY" excluded-unless-"PAYROLL" style rules. `payment_rail_narrative`
 * recognises a payment MECHANISM narrative (UPI/, BPAY, EFTPOS, NEFT, ...)
 * strictly separately from any economic classification.
 */
export const FDH_RULE_MATCH_KINDS_FDH2 = ['narrative_pattern', 'payment_rail_narrative'] as const;
export type FdhRuleMatchKindFdh2 = (typeof FDH_RULE_MATCH_KINDS_FDH2)[number];

/**
 * The two NEW discriminated-union members FDH-2 adds to
 * `fdhRuleActionDefinitionSchema`. Both are structurally NON-authoritative:
 * `flag_candidate` never sets `economic_transaction_type`, `category_id` or
 * `subcategory_id` directly — it names a `candidate_type` a future engine
 * (FDH-6) must independently confirm (amount/date/account matching for
 * transfers, settlement matching for credit-card payments, funding matching
 * for investment transfers). `annotate_payment_rail` records which payment
 * mechanism was observed without asserting any economic meaning.
 */
export const FDH_RULE_CANDIDATE_TYPES = [
  'transfer_candidate',
  'liability_settlement_candidate',
  'investment_funding_candidate',
  'possible_duplicate_review',
] as const;
export type FdhRuleCandidateType = (typeof FDH_RULE_CANDIDATE_TYPES)[number];

export const FDH_RULE_ACTION_KINDS_FDH2 = ['flag_candidate', 'annotate_payment_rail'] as const;
export type FdhRuleActionKindFdh2 = (typeof FDH_RULE_ACTION_KINDS_FDH2)[number];
