/**
 * Financial Data Hub — canonical TypeScript domain contracts.
 *
 * One interface per table in migrations 0045-0048. Field names match the
 * database columns exactly, so a row read through Supabase is already a valid
 * domain object and there is no mapping layer to drift.
 *
 * Money is typed `number` because that is what PostgREST returns for a
 * `numeric` column and what every existing FHIP engine already uses
 * (lib/engines/money.ts). The precision guarantee lives in the DATABASE —
 * every persisted monetary column is `numeric(20,4)`, never float — and in
 * `lib/financial-data-hub/domain/money.ts`, which does all arithmetic in
 * integer minor units. See FDH1_DATABASE_SCHEMA.md section 9.
 */

import type {
  FdhAccountStatus,
  FdhAccountType,
  FdhChangedByType,
  FdhClassificationChangeSource,
  FdhClassificationMethod,
  FdhCountryCode,
  FdhCreditDebit,
  FdhDataQualityCheck,
  FdhDataQualityStatus,
  FdhDocumentType,
  FdhDuplicateMatchMethod,
  FdhDuplicateResolution,
  FdhDuplicateStatus,
  FdhEconomicTransactionType,
  FdhErrorCode,
  FdhEssentialDiscretionary,
  FdhEvidenceType,
  FdhFxRateSource,
  FdhGlobalRuleType,
  FdhGovernanceStatus,
  FdhInstitutionType,
  FdhJobStatus,
  FdhJobType,
  FdhLinkCreationMethod,
  FdhLinkStatus,
  FdhMerchantAliasSource,
  FdhMerchantAliasType,
  FdhMerchantType,
  FdhParserVersionStatus,
  FdhProcessingMethod,
  FdhProcessingStatus,
  FdhProvenanceEntityType,
  FdhPurgeStatus,
  FdhQualityStatus,
  FdhReconciliationMethod,
  FdhReconciliationStatus,
  FdhRecurringFrequency,
  FdhRecurringStatus,
  FdhReviewItemStatus,
  FdhReviewSeverity,
  FdhReviewStatus,
  FdhReviewType,
  FdhSourceType,
  FdhTransactionLinkType,
  FdhUserRuleType,
  FdhDocumentAuditActorType,
  FdhDocumentAuditEventType,
  FdhUploadSessionFailureCode,
  FdhUploadSessionStatus,
  FdhCsvDetectionStatus,
  FdhCsvCertificationStatus,
  FdhTransactionDedupStatus,
  FdhTransactionTypeHint,
  FdhCsvAmountConvention,
  FdhCsvMappingTemplateStatus,
  FdhTransactionCorrectionField,
} from '../constants/enums';

/** ISO-4217. The platform currently supports AUD/INR/USD (`currencies`). */
export type CurrencyCode = string;
/** ISO-8601 date, no time component (`YYYY-MM-DD`). */
export type IsoDate = string;
/** ISO-8601 timestamp with timezone. */
export type IsoTimestamp = string;
/** A confidence or completeness score in the closed range [0, 1]. */
export type UnitInterval = number;

/**
 * Ownership carried by every user-owned FDH row.
 *
 * `user_id` is THE tenancy boundary and matches all 45 existing owner-scoped
 * tables. `household_id` is optional, nullable context for a future sharing
 * model — it is never part of an RLS predicate today.
 */
export interface FdhOwnership {
  user_id: string;
  household_id: string | null;
}

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

export interface FdhSourceTypeRow {
  source_type_key: FdhSourceType;
  display_name: string;
  requires_parser: boolean;
  connected_source: boolean;
  active: boolean;
  created_at: IsoTimestamp;
}

export interface FdhFinancialInstitution {
  id: string;
  country_code: FdhCountryCode;
  institution_code: string;
  institution_name: string;
  institution_type: FdhInstitutionType;
  active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhCategory {
  id: string;
  category_key: string;
  display_name: string;
  description: string | null;
  economic_type: FdhEconomicTransactionType;
  country_applicability: FdhCountryCode[];
  essential_discretionary: FdhEssentialDiscretionary | null;
  tax_reporting_flag: boolean;
  /** Forward-looking metadata for the FDH-15 bridge. Read by nothing today. */
  fhip_mapping_key: string | null;
  display_order: number;
  icon_key: string | null;
  active: boolean;
  version: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhSubcategory {
  id: string;
  category_id: string;
  subcategory_key: string;
  display_name: string;
  description: string | null;
  country_applicability: FdhCountryCode[];
  essential_discretionary: FdhEssentialDiscretionary | null;
  fhip_mapping_key: string | null;
  display_order: number;
  active: boolean;
  version: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhMerchant {
  id: string;
  canonical_name: string;
  display_name: string;
  country_code: FdhCountryCode | null;
  merchant_type: FdhMerchantType | null;
  default_category_id: string | null;
  default_subcategory_id: string | null;
  mcc: string | null;
  subscription_possible: boolean;
  essential_discretionary: FdhEssentialDiscretionary | null;
  verification_status: FdhGovernanceStatus;
  merged_into_merchant_id: string | null;
  active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;

  // --- FDH-2 (migration 0052) — merchant-level LIKELIHOOD metadata only.
  // Never asserts a specific transaction IS recurring; R8's recurring
  // detection treats these as one input signal among several.
  recurring_possible: boolean | null;
  typical_frequency: string | null;
  fixed_amount_expected: boolean | null;
  variable_amount_possible: boolean | null;
  recurring_type: string | null;
  is_payment_processor: boolean | null;
}

export interface FdhMerchantAlias {
  id: string;
  merchant_id: string;
  country_code: FdhCountryCode | null;
  alias_normalised: string;
  alias_type: FdhMerchantAliasType;
  source: FdhMerchantAliasSource;
  confidence: UnitInterval | null;
  verified: boolean;
  created_at: IsoTimestamp;
}

/** A centrally governed global rule. Never created by a user correction. */
export interface FdhClassificationRule {
  id: string;
  rule_key: string;
  rule_type: FdhGlobalRuleType;
  country_applicability: FdhCountryCode[];
  match_definition: FdhRuleMatchDefinition;
  action_definition: FdhRuleActionDefinition;
  priority: number;
  status: FdhGovernanceStatus;
  active: boolean;
  version: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhParserRegistry {
  id: string;
  parser_key: string;
  institution_id: string | null;
  document_type: FdhDocumentType;
  source_format: FdhSourceType;
  country_code: FdhCountryCode | null;
  active: boolean;
  created_at: IsoTimestamp;
}

export interface FdhParserVersion {
  id: string;
  parser_id: string;
  version: string;
  status: FdhParserVersionStatus;
  introduced_at: IsoTimestamp | null;
  retired_at: IsoTimestamp | null;
  supported_layout_reference: string | null;
  notes: string | null;
  created_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Safe, structured rule definitions
// ---------------------------------------------------------------------------

/**
 * A rule's matching condition, as DATA. Never an executable expression, never
 * a user- or admin-supplied regular expression. The classification engine that
 * will interpret these is FDH-6 scope.
 */
export type FdhRuleMatchDefinition =
  | { match_kind: 'merchant_exact'; merchant_id: string }
  | { match_kind: 'merchant_alias'; alias_normalised: string; country_code?: FdhCountryCode }
  | { match_kind: 'mcc'; mcc: string }
  | { match_kind: 'description_contains'; needle_normalised: string; case_sensitive?: boolean }
  | { match_kind: 'institution_narrative'; institution_id: string; narrative_normalised: string }
  | { match_kind: 'source_provided_category'; source_category_key: string }
  | { match_kind: 'account_scoped_default'; financial_account_id: string }
  /** FDH-2 addition (`lib/financial-data-hub/validation/classification.ts`).
   * Widened here in R8 — this domain type had drifted behind the Zod schema
   * (which already supported it) since no consumer needed the full shape
   * until now. */
  | {
      match_kind: 'narrative_pattern';
      required_terms_normalised: string[];
      excluded_terms_normalised?: string[];
      source_context?: FdhDocumentType;
      country_code?: FdhCountryCode;
    }
  /** FDH-2 addition. Never paired with a `classify` action. */
  | { match_kind: 'payment_rail_narrative'; rail_key: string; narrative_terms_normalised: string[] };

/** What a matching rule does. Also pure data. Widened in R8 to match the
 * FDH-2-era Zod schema (`fdhRuleActionDefinitionSchema`), which already
 * supported `flag_candidate`/`annotate_payment_rail` before any consumer
 * needed the full shape. */
export type FdhRuleActionDefinition =
  | {
      action_kind: 'classify';
      economic_transaction_type?: FdhEconomicTransactionType;
      category_id?: string;
      subcategory_id?: string;
      merchant_id?: string;
      set_transfer_flag?: boolean;
      set_subscription_flag?: boolean;
    }
  /** Structurally non-authoritative — never carries an economic type,
   * category or subcategory (spec section 32/34: a rule may SUGGEST a
   * transfer/settlement/investment-funding candidate, never COMMIT one). */
  | {
      action_kind: 'flag_candidate';
      candidate_type:
        | 'transfer_candidate'
        | 'liability_settlement_candidate'
        | 'investment_funding_candidate'
        | 'possible_duplicate_review';
      note?: string;
    }
  | { action_kind: 'annotate_payment_rail'; rail_key: string };

// ---------------------------------------------------------------------------
// User-owned data
// ---------------------------------------------------------------------------

export interface FdhFinancialAccount extends FdhOwnership {
  id: string;
  institution_id: string | null;
  account_type: FdhAccountType;
  country_code: FdhCountryCode;
  currency_code: CurrencyCode;
  display_name: string;
  /** Display-safe remnant only. Never a full account number. */
  masked_identifier: string | null;
  /**
   * Reserved for a future non-reversible deterministic identifier. NOT
   * populated in FDH-1: no key-management/HMAC infrastructure exists yet.
   */
  account_fingerprint: string | null;
  status: FdhAccountStatus;
  opened_at: IsoDate | null;
  closed_at: IsoDate | null;
  last_statement_date: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhStatementUpload extends FdhOwnership {
  id: string;
  financial_account_id: string | null;
  institution_id: string | null;
  source_type: FdhSourceType;
  document_type: FdhDocumentType | null;
  country_code: FdhCountryCode | null;
  currency_code: CurrencyCode | null;
  /** Purgeable. */
  original_filename_sanitised: string | null;
  file_hash: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  statement_period_start: IsoDate | null;
  statement_period_end: IsoDate | null;
  statement_as_of_date: IsoDate | null;
  processing_status: FdhProcessingStatus;
  review_status: FdhReviewStatus;
  parser_id: string | null;
  parser_version_id: string | null;
  processing_method: FdhProcessingMethod | null;
  reconciliation_status: FdhReconciliationStatus;
  overall_quality_status: FdhQualityStatus;
  error_code: FdhErrorCode | null;
  /** Metadata pointer only. No storage backend exists in FDH-1. Purgeable. */
  raw_document_storage_reference: string | null;
  raw_document_purge_status: FdhPurgeStatus;
  raw_document_purge_due_at: IsoTimestamp | null;
  raw_document_purged_at: IsoTimestamp | null;
  purge_reason: string | null;
  purge_attempt_count: number;
  last_purge_error_sanitised: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
  approved_at: IsoTimestamp | null;
  /** FDH-3 (migration 0058). Currently always 'supabase_storage'. */
  storage_provider: string;
  uploaded_at: IsoTimestamp | null;
  validated_at: IsoTimestamp | null;
  processing_started_at: IsoTimestamp | null;
  processing_completed_at: IsoTimestamp | null;
  purge_requested_at: IsoTimestamp | null;
  /** Soft duplicate-document pointer — see migration 0058's "DUPLICATE
   * DETECTION" note for why this replaced a hard uniqueness constraint. */
  duplicate_of_document_id: string | null;

  // --- R7 (migration 0064) ---------------------------------------------
  delimiter_detected: string | null;
  encoding_detected: string | null;
  header_row_index: number | null;
  detection_status: FdhCsvDetectionStatus | null;
  detection_confidence: UnitInterval | null;
  detection_evidence: Record<string, unknown> | null;
  mapping_template_id: string | null;
  certification_status: FdhCsvCertificationStatus | null;
  declared_row_count: number | null;
  parsed_row_count: number | null;
  certified_row_count: number | null;
  duplicate_row_count: number;
  adapter_key: string | null;
  adapter_version: string | null;
}

/**
 * FDH-3 — a short-lived, single-document upload credential (migration 0058).
 * Never a reusable permanent credential; see `domain/uploadSession.ts`.
 */
export interface FdhUploadSession {
  id: string;
  /** No `household_id` — unlike most FDH tables, `fdh_upload_sessions`
   * (migration 0058) carries only `user_id`; a short-lived upload credential
   * has no need for the optional household-context column. */
  user_id: string;
  document_id: string;
  allowed_mime_type: string;
  expected_max_size_bytes: number;
  storage_bucket: string;
  storage_key: string;
  upload_status: FdhUploadSessionStatus;
  failure_code: FdhUploadSessionFailureCode | null;
  created_at: IsoTimestamp;
  expires_at: IsoTimestamp;
  completed_at: IsoTimestamp | null;
  expired_at: IsoTimestamp | null;
}

/**
 * FDH-3 — an append-only document-lifecycle audit event (migration 0058).
 * `metadata` must never carry document content, a signed URL, a password or
 * a stack trace — see FDH3_SECURITY_THREAT_MODEL.md "PII in logs".
 */
export interface FdhDocumentAuditEvent {
  id: string;
  user_id: string | null;
  document_id: string | null;
  event_type: FdhDocumentAuditEventType;
  actor_type: FdhDocumentAuditActorType;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: IsoTimestamp;
}

export interface FdhIngestionJob {
  id: string;
  user_id: string;
  statement_upload_id: string;
  job_type: FdhJobType;
  status: FdhJobStatus;
  attempt: number;
  max_attempts: number;
  started_at: IsoTimestamp | null;
  completed_at: IsoTimestamp | null;
  error_code: FdhErrorCode | null;
  error_message_sanitised: string | null;
  worker_reference: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhTransaction extends FdhOwnership {
  id: string;
  financial_account_id: string;
  statement_upload_id: string | null;

  transaction_date: IsoDate;
  posting_date: IsoDate | null;
  value_date: IsoDate | null;

  /** Verbatim source narrative. Purgeable — never required. */
  description_raw: string | null;
  description_clean: string | null;
  /** Verbatim source merchant string. Purgeable — never required. */
  merchant_raw: string | null;
  merchant_id: string | null;

  /** A strictly positive MAGNITUDE. Direction lives in `credit_debit`. */
  amount_original: number;
  currency_original: CurrencyCode;
  amount_reporting_currency: number | null;
  reporting_currency: CurrencyCode | null;
  fx_rate: number | null;
  fx_rate_date: IsoDate | null;
  fx_rate_source: FdhFxRateSource | null;

  /** Direction of movement. NEVER an economic meaning. */
  credit_debit: FdhCreditDebit;
  /** Economic meaning. NEVER derived from `credit_debit`. */
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;

  recurring_flag: boolean;
  subscription_flag: boolean;
  transfer_flag: boolean;

  /** "Did we categorise it correctly?" — distinct from extraction. */
  classification_confidence: UnitInterval | null;
  /** "Did we read the document correctly?" — distinct from classification. */
  extraction_confidence: UnitInterval | null;
  classification_method: FdhClassificationMethod | null;

  source_reference: string | null;
  source_page: number | null;
  source_row: number | null;

  review_status: FdhReviewStatus;
  /** True once a human has settled this row. Survives reprocessing. */
  user_override: boolean;

  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;

  // --- R7 (migration 0064) ---------------------------------------------
  /** Layer-2 dedup: stable fingerprint of the exact source row. */
  source_row_hash: string | null;
  /** Layer-3 dedup: economic identity fingerprint. Excludes import batch. */
  economic_fingerprint: string | null;
  economic_fingerprint_version: string | null;
  dedup_status: FdhTransactionDedupStatus;
  /** Row-level running balance, when the source provides one. */
  balance_after: number | null;
  /** Structural, non-authoritative type hint. Never a final category. */
  transaction_type_hint: FdhTransactionTypeHint;
  parser_version_id: string | null;
  mapping_template_id: string | null;

  // --- R8 (migration 0067) ---------------------------------------------
  /** Which fdh_recurring_transactions series this row belongs to, if any.
   * System-authoritative — an authenticated client may never write it. */
  recurring_transaction_id: string | null;
}

export interface FdhTransactionAllocation {
  id: string;
  user_id: string;
  transaction_id: string;
  allocation_sequence: number;
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;
  /** Positive magnitude, same direction as the parent transaction. */
  amount: number;
  currency_code: CurrencyCode;
  percentage: number | null;
  note: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhTransactionLink {
  id: string;
  user_id: string;
  transaction_id_from: string;
  /** Null while the counterpart has not been imported yet. */
  transaction_id_to: string | null;
  link_type: FdhTransactionLinkType;
  confidence: UnitInterval | null;
  status: FdhLinkStatus;
  created_by_method: FdhLinkCreationMethod;
  user_confirmed: boolean;
  /** R8 (migration 0067): structured deterministic evidence for the link. */
  match_evidence: Record<string, unknown> | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhDuplicateCandidate {
  id: string;
  user_id: string;
  transaction_id_a: string;
  transaction_id_b: string;
  match_method: FdhDuplicateMatchMethod;
  confidence: UnitInterval | null;
  status: FdhDuplicateStatus;
  reason_code: string | null;
  user_resolution: FdhDuplicateResolution | null;
  created_at: IsoTimestamp;
  resolved_at: IsoTimestamp | null;
}

/** A household's own rule. Never promoted to a global rule automatically. */
export interface FdhUserClassificationRule extends FdhOwnership {
  id: string;
  rule_type: FdhUserRuleType;
  match_definition: FdhRuleMatchDefinition;
  action_definition: FdhRuleActionDefinition;
  priority: number;
  active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Append-only. Insert and select only; no update, no delete. */
export interface FdhClassificationHistory {
  id: string;
  user_id: string;
  transaction_id: string;
  previous_economic_transaction_type: FdhEconomicTransactionType | null;
  new_economic_transaction_type: FdhEconomicTransactionType;
  previous_category_id: string | null;
  new_category_id: string | null;
  previous_subcategory_id: string | null;
  new_subcategory_id: string | null;
  classification_method: FdhClassificationChangeSource;
  confidence: UnitInterval | null;
  changed_by_type: FdhChangedByType;
  changed_by_user: string | null;
  global_rule_id: string | null;
  user_rule_id: string | null;
  created_at: IsoTimestamp;
}

export interface FdhRecurringTransaction extends FdhOwnership {
  id: string;
  merchant_id: string | null;
  financial_account_id: string | null;
  frequency: FdhRecurringFrequency;
  expected_amount: number | null;
  amount_tolerance: number | null;
  currency_code: CurrencyCode | null;
  next_expected_date: IsoDate | null;
  status: FdhRecurringStatus;
  confidence: UnitInterval | null;
  user_confirmed: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FdhReviewItem extends FdhOwnership {
  id: string;
  statement_upload_id: string | null;
  transaction_id: string | null;
  review_type: FdhReviewType;
  severity: FdhReviewSeverity;
  status: FdhReviewItemStatus;
  /** A message key. Never a sentence containing financial detail. */
  title_code: string;
  /** Structured identifiers and codes. Never raw document text. */
  context_json: FdhReviewItemContext | null;
  created_at: IsoTimestamp;
  resolved_at: IsoTimestamp | null;
  resolved_by: string | null;
  resolution_code: string | null;
}

/**
 * Closed shape. Deliberately admits no free-text field, so raw statement
 * narrative cannot be smuggled into a review item and survive the purge.
 */
export interface FdhReviewItemContext {
  related_transaction_ids?: string[];
  related_statement_upload_ids?: string[];
  check_codes?: FdhDataQualityCheck[];
  counts?: Record<string, number>;
  confidence?: UnitInterval;
}

export interface FdhReconciliationResult {
  id: string;
  user_id: string;
  statement_upload_id: string;
  opening_balance: number | null;
  extracted_credits: number | null;
  extracted_debits: number | null;
  expected_closing_balance: number | null;
  reported_closing_balance: number | null;
  variance: number | null;
  /** Explicit and stored. Not a hidden fudge factor. Defaults to 0. */
  variance_tolerance: number;
  currency_code: CurrencyCode | null;
  status: FdhReconciliationStatus;
  reconciliation_method: FdhReconciliationMethod | null;
  created_at: IsoTimestamp;
}

export interface FdhDataQualityResult {
  id: string;
  user_id: string;
  statement_upload_id: string;
  check_code: FdhDataQualityCheck;
  status: FdhDataQualityStatus;
  score: UnitInterval | null;
  details_sanitised: string | null;
  created_at: IsoTimestamp;
}

export interface FdhDataProvenance extends FdhOwnership {
  id: string;
  entity_type: FdhProvenanceEntityType;
  /** Polymorphic by design; `entity_type` names the table. No FK. */
  entity_id: string;
  source_type: FdhSourceType;
  source_id: string | null;
  source_statement_id: string | null;
  source_transaction_id: string | null;
  calculation_period_start: IsoDate | null;
  calculation_period_end: IsoDate | null;
  as_of_date: IsoDate | null;
  parser_id: string | null;
  parser_version_id: string | null;
  mapping_rule_version: string | null;
  /**
   * The third, structurally distinct confidence dimension: how completely the
   * evidence supports this derived fact. FDH-1 stores it and hardcodes no
   * scoring rule (FDH-9 owns the model).
   */
  evidence_completeness: UnitInterval | null;
  user_verified: boolean;
  manual_override: boolean;
  created_at: IsoTimestamp;
}

export interface FdhEvidenceLink {
  id: string;
  user_id: string;
  provenance_id: string;
  evidence_type: FdhEvidenceType;
  evidence_statement_upload_id: string | null;
  evidence_transaction_id: string | null;
  evidence_weight: UnitInterval | null;
  note_sanitised: string | null;
  created_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// R7 — Bank CSV Engine (migration 0064)
// ---------------------------------------------------------------------------

/** A confirmed generic-CSV column mapping (spec section 22-23). */
export interface FdhCsvMappingTemplate {
  id: string;
  user_id: string;
  household_id: string | null;
  institution_id: string | null;
  source_fingerprint: string;
  country_code: FdhCountryCode | null;
  version: number;
  status: FdhCsvMappingTemplateStatus;
  amount_convention: FdhCsvAmountConvention;
  date_format: string;
  delimiter: string;
  column_mapping: FdhCsvColumnMapping;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

/** Source column header (or index-as-string fallback) for each canonical
 * field, or null when the source has no such column. */
export interface FdhCsvColumnMapping {
  transaction_date: string;
  posting_date?: string | null;
  value_date?: string | null;
  description: string;
  amount?: string | null;
  debit?: string | null;
  credit?: string | null;
  dr_cr_indicator?: string | null;
  balance?: string | null;
  reference?: string | null;
  currency?: string | null;
}

/** A layered user correction over a normalised transaction field (spec
 * section 47). The raw source value is never overwritten; this is an
 * additional fact layered on top. */
export interface FdhTransactionCorrection {
  id: string;
  user_id: string;
  transaction_id: string;
  field_name: FdhTransactionCorrectionField;
  previous_value: unknown;
  corrected_value: unknown;
  reason: string | null;
  corrected_at: IsoTimestamp;
  created_at: IsoTimestamp;
}
