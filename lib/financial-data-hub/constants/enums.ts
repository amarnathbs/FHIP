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

/**
 * FDH-5 ADDITION (spec section 15) — the PDF structural classification
 * recorded on `fdh_statement_uploads.pdf_classification` (new, additive
 * column; null for non-PDF documents). Determined from actual PDF structure
 * (page count, encryption dictionary, extractable-text-per-page ratio), never
 * from the filename.
 */
export const FDH_PDF_CLASSIFICATIONS = [
  'text_native',
  'image_only',
  'mixed_content',
  'encrypted',
  'corrupt',
  'unsupported',
] as const;
export type FdhPdfClassification = (typeof FDH_PDF_CLASSIFICATIONS)[number];

/**
 * FDH-5 ADDITION (spec section 55-56) — which extraction method(s) a given
 * `fdh_parser_versions` row has actually been certified against, kept
 * SEPARATE from `status` (development/certified/deprecated/disabled — the
 * overall lifecycle stage) so "CBA PDF V1 — native text: CERTIFIED, scanned
 * OCR: NOT CERTIFIED" is a real, queryable fact rather than one collapsed
 * boolean (spec 56's explicit requirement). Stored as
 * `fdh_parser_versions.certified_extraction_methods text[]`.
 */
export const FDH_PDF_EXTRACTION_METHODS = ['native_text', 'ocr'] as const;
export type FdhPdfExtractionMethod = (typeof FDH_PDF_EXTRACTION_METHODS)[number];

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
 * FROZEN — the complete FDH-1 processing-error taxonomy exactly as migrations
 * 0045-0048 shipped it. A user or an operator only ever sees one of these
 * codes plus a sanitised message. An internal stack trace, an SQL error, a
 * file path or a library exception must never be persisted or surfaced. See
 * FDH1_STATE_MACHINES.md section 5. `tests/unit/fdh1SchemaContract.test.ts`
 * asserts this list byte-for-byte against migration 0046's own (un-widened)
 * check constraint text — R7/FDH-4 never needed to widen it (see migration
 * 0064's header note: "error_code... already has enough headroom for R7").
 * FDH-5's additions live in `FDH_ERROR_CODES_FDH5_ADDED` below, following the
 * exact widening precedent `FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED` set.
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

/**
 * FDH-5 WIDENING (spec section 83): 5 PDF-specific error codes, additive to
 * the FDH-1 set above. Many FDH-5 error states reuse an EXISTING code
 * unchanged (PDF_INVALID/PDF_CORRUPT -> file_corrupt, PDF_PASSWORD_REQUIRED
 * -> password_required, PDF_PASSWORD_INVALID -> password_invalid,
 * PDF_TEXT_EXTRACTION_FAILED -> extraction_failed, PDF_FORMAT_UNSUPPORTED ->
 * layout_unsupported, PDF_RECONCILIATION_FAILED -> reconciliation_failed —
 * see FDH5_PDF_ARCHITECTURE.md's error-code mapping table for the complete
 * correspondence) — only the codes with no existing equivalent are added
 * here. Migration `00XX_fdh5_bank_pdf_engine_foundation.sql` (see that
 * migration's own header for its final allocated number) widens the check
 * constraint on `fdh_statement_uploads.error_code` to match;
 * `tests/unit/fdh5SchemaContract.test.ts` verifies the two never drift apart.
 */
export const FDH_ERROR_CODES_FDH5_ADDED = [
  // PDF_PAGE_LIMIT_EXCEEDED — distinct from file_too_large (a byte-size
  // limit checked before any page is ever counted).
  'page_limit_exceeded',
  // PDF_FORMAT_AMBIGUOUS — two or more PDF adapters scored within the
  // ambiguity threshold (spec 96); never silently resolved by weakening
  // detection evidence.
  'format_ambiguous',
  // PDF_EXTRACTION_LOW_CONFIDENCE — statement-level extraction confidence
  // (not any one transaction's) fell below the threshold required to
  // proceed at all (spec 45, distinct from a transaction-level
  // review_required outcome, which uses the existing review lifecycle).
  'extraction_low_confidence',
  // PDF_OCR_REQUIRED — native extraction was insufficient and OCR fallback
  // was needed but is not available in this deployment (spec 8, 41-43: OCR
  // fallback architecture is documented; no third-party OCR provider is
  // integrated in this phase — see FDH5_OCR_ARCHITECTURE.md).
  'ocr_required',
  // PDF_OCR_FAILED — reserved for a future phase that actually invokes an
  // OCR provider; no code path in this phase can currently produce it, but
  // the vocabulary slot is allocated now so a later OCR integration is an
  // additive change, not a further widening (spec 43's STOP condition).
  'ocr_failed',
] as const;

/** The complete current error-code set (FDH-1 + FDH-5). Used everywhere
 * OUTSIDE the frozen fdh1SchemaContract.test.ts assertion. */
export const FDH_ALL_ERROR_CODES = [...FDH_ERROR_CODES, ...FDH_ERROR_CODES_FDH5_ADDED] as const;
export type FdhErrorCode = (typeof FDH_ALL_ERROR_CODES)[number];

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

// =============================================================================
// FDH-3 — secure document upload, storage and purge lifecycle vocabularies.
// =============================================================================

/**
 * Allowed document upload file types (spec section 17). Restricted to what
 * upcoming parser phases actually need. XLSX is deliberately NOT included —
 * it was only "optionally" approved by the spec, and no safe-handling review
 * has been done for it, so it is left out rather than half-supported.
 */
export const FDH_ALLOWED_UPLOAD_MIME_TYPES = ['application/pdf', 'text/csv'] as const;
export type FdhAllowedUploadMimeType = (typeof FDH_ALLOWED_UPLOAD_MIME_TYPES)[number];

/**
 * `fdh_upload_sessions.upload_status` — the session-level lifecycle, distinct
 * from (and much smaller than) `fdh_statement_uploads.processing_status`.
 * A session only ever tracks getting bytes safely into storage; everything
 * after that is the document's own processing_status.
 */
export const FDH_UPLOAD_SESSION_STATUSES = [
  'session_created',
  'upload_in_progress',
  'upload_complete',
  'expired',
  'failed',
] as const;
export type FdhUploadSessionStatus = (typeof FDH_UPLOAD_SESSION_STATUSES)[number];

/**
 * `fdh_upload_sessions.failure_code` — upload-MECHANICS errors (spec section
 * 52), independently owned from `fdh_statement_uploads.error_code` (the
 * frozen FDH-1 document-PROCESSING taxonomy) precisely so migration 0058
 * never has to edit that frozen constraint. See migration 0058 for the full
 * rationale.
 */
export const FDH_UPLOAD_SESSION_FAILURE_CODES = [
  'unsupported_file_type',
  'file_too_large',
  'mime_mismatch',
  'file_corrupt',
  'password_required',
  'upload_incomplete',
  'storage_error',
  'internal_error',
] as const;
export type FdhUploadSessionFailureCode = (typeof FDH_UPLOAD_SESSION_FAILURE_CODES)[number];

/**
 * UX-facing upload substates (spec section 14). These are DERIVED display
 * values computed from `processing_status` + `error_code` + the upload
 * session's own status — never a new database enum. See
 * `lib/financial-data-hub/domain/uploadSubstate.ts`.
 */
export const FDH_UPLOAD_SUBSTATES = [
  'UPLOAD_CREATED',
  'UPLOAD_IN_PROGRESS',
  'UPLOAD_COMPLETE',
  'VALIDATION_PENDING',
  'VALIDATED',
  'FILE_REJECTED',
] as const;
export type FdhUploadSubstate = (typeof FDH_UPLOAD_SUBSTATES)[number];

/** `fdh_document_audit_events.event_type` — the controlled audit taxonomy
 * (spec section 56). FROZEN — this is exactly the set migration 0058 shipped;
 * `tests/unit/fdh3SchemaContract.test.ts` asserts it byte-for-byte against
 * that migration's own (un-widened) check constraint text. R7's additions
 * live in `FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED` below, following the
 * exact widening precedent of `FDH_INSTITUTION_TYPES` (FDH1 frozen +
 * FDH2 widened) in this same file. */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES = [
  'document_upload_created',
  'document_upload_completed',
  'document_validated',
  'document_rejected',
  'document_queued',
  'document_user_deleted',
  'document_purge_scheduled',
  'document_purged',
  'document_purge_failed',
] as const;

/**
 * R7 WIDENING (spec section 48): 10 bank-CSV-engine-specific audit event
 * types, additive to the FDH-3 set above. Migration
 * `0064_r7_bank_csv_engine_foundation.sql` widens the check constraint on
 * `fdh_document_audit_events.event_type` to match; `tests/unit/
 * r7SchemaContract.test.ts` verifies the two never drift apart, scoped to
 * migration 0064 only (the frozen fdh3SchemaContract.test.ts assertion above
 * is untouched and still checks migration 0058 in isolation).
 */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED = [
  'bank_csv_uploaded',
  'bank_csv_detection_completed',
  'bank_csv_mapping_confirmed',
  'bank_csv_processing_started',
  'bank_csv_processing_completed',
  'bank_csv_processing_failed',
  'transaction_duplicate_detected',
  'transaction_duplicate_resolved',
  'transaction_corrected',
  'import_reconciled',
] as const;

/**
 * R8 WIDENING (spec sections 32, 46-48, 53, 61): 3 classification-review
 * audit event types, additive to the FDH-3/R7 set above. Migration
 * `0067_r8_transaction_classification_engine.sql` widens the check
 * constraint on `fdh_document_audit_events.event_type` to match;
 * `tests/unit/r8SchemaContract.test.ts` verifies the two never drift apart,
 * scoped to migration 0067 only — mirroring the exact `r7SchemaContract
 * .test.ts` precedent for the R7 widening above.
 */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES_R8_ADDED = [
  'transaction_classification_run',
  'transaction_link_reviewed',
  'recurring_series_reviewed',
  'personal_rule_created',
] as const;

/**
 * FDH-5 WIDENING (spec section 85): 11 bank-PDF-engine-specific audit event
 * types, additive to the FDH-3/R7/R8 set above. The FDH-5 migration widens
 * the check constraint on `fdh_document_audit_events.event_type` to match;
 * `tests/unit/fdh5SchemaContract.test.ts` verifies the two never drift apart,
 * scoped to that migration only — mirroring the R7/R8 widening precedent.
 */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH5_ADDED = [
  'pdf_validated',
  'pdf_password_required',
  'pdf_decrypted_for_processing',
  'pdf_native_extraction_started',
  'pdf_native_extraction_completed',
  'pdf_ocr_started',
  'pdf_ocr_completed',
  'pdf_adapter_detected',
  'pdf_processing_failed',
  'pdf_review_required',
  'pdf_processing_completed',
] as const;

/**
 * FDH-7 WIDENING (spec section 74): 5 review/approval-workflow audit event
 * types, additive to the FDH-3/R7/R8/FDH-5 set above. Migration
 * `0076_fdh7_review_approval_workflow.sql` widens the check constraint on
 * `fdh_document_audit_events.event_type` to match; `tests/unit/
 * fdh7SchemaContract.test.ts` verifies the two never drift apart, scoped to
 * that migration only — mirroring the R7/R8/FDH-5 widening precedent.
 * TRANSFER_CONFIRMED/REJECTED, DUPLICATE_CONFIRMED/REJECTED, RECURRING_
 * CONFIRMED and REFUND_CONFIRMED are already fully covered by the EXISTING
 * 'transaction_link_reviewed' / 'transaction_duplicate_resolved' /
 * 'recurring_series_reviewed' event types (each already carries a
 * `decision`/`resolution` metadata field) — no new vocabulary for those.
 */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH7_ADDED = [
  'transaction_split_created',
  'transaction_approved',
  'statement_approved',
  'statement_reopened',
  'bulk_review_action_completed',
] as const;

/**
 * FDH-9 WIDENING (spec sections 32, 41-42). Migration 0091 already widened
 * `fdh_document_audit_events.event_type`'s check constraint with these six
 * values (see that migration's own "FDH-9 additions" comment) — this
 * TypeScript-side constant was never added to match at the time, which is
 * exactly the class of gap `tests/unit/fdh5SchemaContract.test.ts`-style
 * contract tests exist to catch. Found and fixed during the FDH-9 live-DEV
 * cert + Income-tab pass (2026-08-26) as a genuine pre-existing defect: every
 * one of these six event types would have failed `tsc --noEmit` the moment
 * any FDH-9 route tried to actually record one (which none did until this
 * pass, since no app/api layer existed yet — see FDH9_REUSE_AND_GAP_AUDIT.md).
 */
export const FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED = [
  'payslip_extraction_completed',
  'payslip_extraction_failed',
  'payroll_event_approved',
  'income_proposal_generated',
  'income_proposal_applied',
  'income_proposal_dismissed',
] as const;

/** The complete current audit-event-type set (FDH-3 + R7 + R8 + FDH-5 +
 * FDH-7 + FDH-9). Used everywhere OUTSIDE the frozen fdh3SchemaContract.test.ts
 * assertion — i.e. by `FdhDocumentAuditEventType` itself, so every caller
 * can use the R7/R8/FDH-5/FDH-7/FDH-9 event types without a second parallel
 * type. */
export const FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES = [
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES,
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED,
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_R8_ADDED,
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH5_ADDED,
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH7_ADDED,
  ...FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED,
] as const;
export type FdhDocumentAuditEventType = (typeof FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES)[number];

/** Every lifecycle transition is attributable to exactly one of these (spec
 * section 97). Deliberately excludes 'admin' — an admin never drives a
 * document lifecycle transition (Product Owner Decision 3). */
export const FDH_DOCUMENT_AUDIT_ACTOR_TYPES = ['user', 'system', 'service'] as const;
export type FdhDocumentAuditActorType = (typeof FDH_DOCUMENT_AUDIT_ACTOR_TYPES)[number];

// =============================================================================
// R7 — Bank CSV Engine vocabularies (migration 0064). Every value here is a
// BRAND NEW column with no frozen predecessor, so no widening pattern is
// needed for these — see migration 0064's header note.
// =============================================================================

/** `fdh_statement_uploads.detection_status` (spec section 21) — deterministic
 * format/institution detection outcome. Never a silent guess: AMBIGUOUS when
 * two adapters score similarly, never an arbitrary pick. */
export const FDH_CSV_DETECTION_STATUSES = [
  'detected',
  'ambiguous',
  'unsupported',
  'manual_mapping_required',
  'invalid',
] as const;
export type FdhCsvDetectionStatus = (typeof FDH_CSV_DETECTION_STATUSES)[number];

/** `fdh_statement_uploads.certification_status` (spec section 45) — the R7
 * import-certification conclusion, deliberately distinct from the FDH-1
 * `processing_status` lifecycle column (see migration 0064's comment). */
export const FDH_CSV_CERTIFICATION_STATUSES = [
  'certified',
  'partial',
  'review_required',
  'rejected',
] as const;
export type FdhCsvCertificationStatus = (typeof FDH_CSV_CERTIFICATION_STATUSES)[number];

/** `fdh_transactions.dedup_status` (spec section 36). */
export const FDH_TRANSACTION_DEDUP_STATUSES = [
  'unique',
  'duplicate_confirmed',
  'duplicate_candidate',
  'user_confirmed_distinct',
  'user_confirmed_duplicate',
] as const;
export type FdhTransactionDedupStatus = (typeof FDH_TRANSACTION_DEDUP_STATUSES)[number];

/** `fdh_transactions.transaction_type_hint` (spec section 40) — a
 * deterministic STRUCTURAL hint, never a final category and never AI-derived
 * (spec section 41). */
export const FDH_TRANSACTION_TYPE_HINTS = [
  'debit',
  'credit',
  'transfer_candidate',
  'fee_candidate',
  'interest_candidate',
  'atm_candidate',
  'card_payment_candidate',
  'direct_debit_candidate',
  'salary_candidate',
  'investment_transfer_candidate',
  'unknown',
] as const;
export type FdhTransactionTypeHint = (typeof FDH_TRANSACTION_TYPE_HINTS)[number];

/** `fdh_csv_mapping_templates.amount_convention` (spec section 25). */
export const FDH_CSV_AMOUNT_CONVENTIONS = [
  'single_signed',
  'debit_credit_columns',
  'dr_cr_indicator',
] as const;
export type FdhCsvAmountConvention = (typeof FDH_CSV_AMOUNT_CONVENTIONS)[number];

/** `fdh_csv_mapping_templates.status` (spec section 23). R7 implements no
 * code path that ever sets 'admin_promoted' — the value is reserved for a
 * future governed promotion workflow, not implemented here. */
export const FDH_CSV_MAPPING_TEMPLATE_STATUSES = [
  'user_draft',
  'user_confirmed',
  'admin_promoted',
  'deprecated',
] as const;
export type FdhCsvMappingTemplateStatus = (typeof FDH_CSV_MAPPING_TEMPLATE_STATUSES)[number];

/** `fdh_transaction_corrections.field_name` (spec section 47) — the closed
 * set of fields a user correction may layer over. Deliberately excludes
 * `description_raw`/`merchant_raw` (raw source evidence is never corrected,
 * only the normalised/derived fields are). */
export const FDH_TRANSACTION_CORRECTION_FIELDS = [
  'transaction_date',
  'posting_date',
  'value_date',
  'description_clean',
  'amount_original',
  'credit_debit',
  'economic_transaction_type',
  'category_id',
  'subcategory_id',
  'merchant_id',
  'currency_original',
] as const;
export type FdhTransactionCorrectionField = (typeof FDH_TRANSACTION_CORRECTION_FIELDS)[number];

/** `fdh_duplicate_candidates.user_resolution` already covers spec section 36's
 * USER_CONFIRMED_DISTINCT / USER_CONFIRMED_DUPLICATE via `kept_both` /
 * `merged`+`removed_a`/`removed_b` — see FDH_DUPLICATE_RESOLUTIONS above.
 * No new vocabulary needed for the candidate-pair table itself. */

// =============================================================================
// FDH-7 — Reconciliation, Transaction Review & User Approval Workflow
// (migration 0076). See that migration's header for why `processing_status`
// and its transition table are deliberately UNTOUCHED — FDH-7's genuine
// user-approval concept is `approved_by`, a structurally separate signal.
// =============================================================================

/** `fdh_transactions.approval_status` (spec sections 26, 52, 55). Two states
 * only — there is no third "rejected" state at the transaction level; a
 * transaction the user does not want counted is corrected/split/left
 * pending, never marked "rejected" (only a whole STATEMENT can be rejected,
 * reusing the existing `processing_status = 'rejected'`). */
export const FDH_TRANSACTION_APPROVAL_STATUSES = ['pending', 'approved'] as const;
export type FdhTransactionApprovalStatus = (typeof FDH_TRANSACTION_APPROVAL_STATUSES)[number];

// (FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH7_ADDED is declared earlier in this
// file, alongside the other FDH_DOCUMENT_AUDIT_EVENT_TYPES_*_ADDED constants,
// so it is available where FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES is assembled.)
