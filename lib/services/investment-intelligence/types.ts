// Investment Intelligence R1 — shared TypeScript types for the data
// foundation. Mirrors R0_CANONICAL_DATA_CONTRACT.md's frozen entity shapes;
// no field exists here that isn't backed by an actual migrated column.

export type IiSourceCategory = 'statement_provider' | 'broker' | 'manual' | 'admin' | 'api_connector';

export type IiInstrumentClass =
  | 'equity'
  | 'mutual_fund'
  | 'etf'
  | 'bond'
  | 'fixed_deposit'
  | 'gold'
  | 'crypto'
  | 'cash'
  | 'other';

export type IiInstrumentStatus = 'provisional' | 'verified' | 'deprecated' | 'merged';

// FDH-11 addition: 'asx_ticker' (spec sections 39-40), country-scoped
// exactly like nse_symbol/bse_code — see migration 0106 Part G for the
// matching DB-level CHECK constraint and partial unique index widening.
export type IiIdentifierScheme = 'isin' | 'amfi_scheme_code' | 'nse_symbol' | 'bse_code' | 'sedol' | 'internal_provisional' | 'asx_ticker';

export type IiAccountType = 'demat' | 'mf_folio' | 'broker' | 'retirement' | 'bank_linked' | 'other';
export type IiAccountStatus = 'active' | 'closed' | 'archived';

export type IiSourceDocumentStatus = 'uploaded' | 'parsing' | 'parsed' | 'parse_failed' | 'superseded' | 'archived';
export type IiDocumentType = 'cas_statement' | 'demat_statement' | 'contract_note' | 'manual_entry_record' | 'other';

// R2 extends the R1 12-value taxonomy (migration 0033) with the additional
// canonical values spec section 19 requires — see migration 0040's comment
// for the exact reasoning. All 12 R1 values are kept unchanged.
export type IiTransactionType =
  | 'purchase'
  | 'sip'
  | 'redemption'
  | 'switch_in'
  | 'switch_out'
  | 'dividend'
  | 'reinvestment'
  | 'transfer'
  | 'merger'
  | 'fee'
  | 'tax'
  | 'adjustment'
  | 'stp_in'
  | 'stp_out'
  | 'swp'
  | 'transfer_in'
  | 'transfer_out'
  | 'reversal'
  | 'segregation'
  | 'unclassified'
  | 'bonus'
  | 'split'
  // R12 addition -- equity/ETF market disposal, distinct from a
  // mutual-fund 'redemption' (unit redemption from a scheme). Migration 0092.
  | 'sale';
export type IiTransactionStatus = 'parsed' | 'reconciled' | 'corrected' | 'reversed';

// --- R2 additions (spec sections 8-34) ---

export type IiParserCode = 'cams_detailed_v1' | 'kfintech_detailed_v1';

export type IiParseRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type IiSourceDocumentStatusR2 = IiSourceDocumentStatus | 'password_required' | 'reconciliation_required' | 'unsupported';

export type IiPlanType = 'direct' | 'regular' | 'not_applicable';
export type IiOptionType = 'growth' | 'idcw' | 'dividend_payout' | 'dividend_reinvestment' | 'not_applicable';

export type IiPortfolioTruthStatus =
  | 'pending'
  | 'parsed'
  | 'reconciliation_required'
  | 'certified_with_warnings'
  | 'certified'
  | 'failed'
  | 'superseded'
  | 'archived';

export type IiHistoryCompleteness = 'complete_from_inception' | 'complete_from_known_opening_balance' | 'partial_history' | 'holdings_only';

export type IiDiscrepancyType =
  | 'owner_unmatched'
  | 'account_unmatched'
  | 'instrument_unmatched'
  | 'ambiguous_instrument'
  | 'transaction_unclassified'
  | 'unit_mismatch'
  | 'value_mismatch'
  | 'duplicate_suspected'
  | 'missing_opening_history'
  | 'unsupported_document'
  | 'document_corrupt'
  | 'document_password_required'
  | 'parse_incomplete'
  | 'statement_period_gap'
  | 'other';

export type IiReconciliationSeverity = 'info' | 'low' | 'medium' | 'high' | 'blocking';

export type IiAuditEventTypeR2 =
  | IiAuditEventType
  | 'document_uploaded'
  | 'source_detected'
  | 'parse_started'
  | 'parse_failed'
  | 'parser_version_used'
  | 'account_resolved'
  | 'instrument_resolved'
  | 'reconciliation_case_created'
  | 'reconciliation_case_resolved'
  | 'portfolio_certified'
  | 'portfolio_certified_with_warnings'
  | 'portfolio_failed'
  | 'document_superseded'
  | 'document_processing_failed';

export type IiQualityStatus = 'certified' | 'warning' | 'incomplete';

export type IiPublicationTarget = 'assets' | 'investments' | 'retirement_accounts';
export type IiPublicationStatus = 'published' | 'unpublished' | 'superseded';

export type IiGoalAllocationType = 'percentage' | 'fixed_amount' | 'residual';
export type IiGoalAllocationSource = 'user' | 'system_suggested';
export type IiGoalAllocationStatus = 'active' | 'superseded' | 'removed';

export type IiInsightClassification = 'observation' | 'education' | 'simulation' | 'personalised_advice';

export type IiReconciliationStatus = 'open' | 'user_reviewing' | 'resolved' | 'dismissed';

export type IiActorType = 'user' | 'admin' | 'system' | 'professional';

export type IiAuditEventType =
  | 'upload'
  | 'parse'
  | 'parse_completed'
  | 'reconciliation_opened'
  | 'reconciliation_resolved'
  | 'user_correction'
  | 'admin_correction'
  | 'publication'
  | 'republishing'
  | 'nav_price_update'
  | 'calculation'
  | 'rule_change'
  | 'goal_allocation'
  | 'export'
  | 'permission_grant'
  | 'permission_revoke'
  | 'professional_access'
  | 'archive'
  | 'deletion';

// --- R3 additions (FHIP Publishing Integration & No-Double-Counting) ---

// investments.owner / assets.owner / retirement_accounts.owner is a ROLE
// ENUM (migration 0004), NOT a household_members.id FK. This corrects the
// R0_FHIP_PUBLISHING_CONTRACT.md OWNER section's imprecise phrasing
// ("resolved to a household_members.id, published into investments.owner")
// against the actual schema — see R3_FHIP_MAPPING_SPEC.md.
export const FHIP_OWNER_VALUES = ['self', 'spouse', 'joint', 'child', 'family_trust', 'company', 'smsf', 'other'] as const;
export type FhipOwner = (typeof FHIP_OWNER_VALUES)[number];

// household_members.relationship (migration 0009) — the source vocabulary
// Investment Intelligence must map FROM.
export type HouseholdMemberRelationship = 'self' | 'spouse' | 'partner' | 'child' | 'parent' | 'other_dependant' | 'other';

export type IiPublicationStatusR3 = 'published' | 'unpublished' | 'superseded' | 'failed';

export type IiCostBaseStatus = 'certified' | 'partial' | 'unknown' | 'not_available';
export type IiAnnualContributionSource = 'confirmed_user_plan' | 'none';
export type IiRiskBand = 'conservative' | 'balanced' | 'growth' | 'high_growth' | 'unknown';
export type IiLinkageType = 'new_position' | 'linked_manual_row';
export type IiInvestmentSourceType = 'manual' | 'investment_intelligence_published';

// Publication eligibility gate outcome (spec section 10). NOT_ELIGIBLE and
// REVIEW_REQUIRED are computed/ephemeral (never persisted as an
// ii_fhip_publications row) — nothing is written to the database until the
// user confirms a publish that has cleared this gate.
export type IiEligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'REVIEW_REQUIRED';

export interface IiEligibilityReason {
  code: string;
  message: string;
}

export interface IiEligibilityResult {
  status: IiEligibilityStatus;
  blockingReasons: IiEligibilityReason[];
  warningReasons: IiEligibilityReason[];
}

// One candidate existing manual FHIP row that might be the same economic
// investment as the certified position being published (spec section 27).
export interface IiDuplicateCandidate {
  investmentId: string;
  matchScore: number; // 0-1, transparency only — never used to auto-merge
  matchedOn: string[]; // e.g. ['owner', 'category', 'institution', 'country', 'currency', 'approximate_value']
  existingValue: number;
  existingCurrency: string;
  existingInstitution: string | null;
  existingOwner: string;
}

export type IiRegisterAction = 'ADD_NEW' | 'REPLACE_LINK_EXISTING' | 'LEAVE_UNCHANGED' | 'REQUIRES_REVIEW';

export interface IiFinancialImpact {
  currentIncludedValue: number; // value currently counted toward net worth for this slot (0 if none)
  newPublishedValue: number; // the certified value about to be included
  manualValueBeingSuperseded: number; // 0 unless linking to an existing manual row
  netChange: number; // newPublishedValue - manualValueBeingSuperseded (never the full newPublishedValue on a confirmed duplicate)
  currency: string;
}

export type IiAuditEventTypeR3 =
  | IiAuditEventTypeR2
  | 'publication_previewed'
  | 'publication_created'
  | 'publication_confirmed'
  | 'manual_duplicate_linked'
  | 'manual_record_superseded'
  | 'publication_refreshed'
  | 'publication_superseded'
  | 'publication_unpublished'
  | 'publication_republished'
  | 'publication_failed'
  | 'conflict_detected'
  | 'conflict_resolved';

// ---------------------------------------------------------------------------
// R9 — Goals, Forecasting & Review Centre. See R9_ARCHITECTURE.md and
// R9_REVIEW_CENTRE_RULES.md. Note the Review Centre reuses the EXISTING
// IiInsightClassification taxonomy (observation/education/simulation/
// personalised_advice) rather than inventing a parallel one — R9 review
// items are restricted at the validation layer (and the migration 0067
// check constraint) to the first three; personalised_advice is never
// produced by the deterministic review engine (spec sections 40-42).
export type IiReviewType = 'data_quality' | 'goal' | 'portfolio' | 'performance' | 'sip' | 'tax_cost';
export type IiReviewSeverity = 'info' | 'low' | 'medium' | 'high';
export type IiReviewComplianceClassification = Exclude<IiInsightClassification, 'personalised_advice'>;
export type IiReviewSourceModule =
  | 'goals'
  | 'forecasting'
  | 'retirement'
  | 'ii_publishing'
  | 'ii_r4_performance'
  | 'ii_r5_sip_xray'
  | 'ii_r6_tax'
  | 'ii_data_quality';
export type IiReviewStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed' | 'superseded';

export interface IiReviewItem {
  id: string;
  user_id: string;
  review_type: IiReviewType;
  category: string;
  severity: IiReviewSeverity;
  compliance_classification: IiReviewComplianceClassification;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  source_module: IiReviewSourceModule;
  source_record_id: string | null;
  source_record_version: string | null;
  review_engine_version: string;
  rule_key: string;
  rule_version: string;
  identity_key: string;
  as_of_date: string;
  status: IiReviewStatus;
  superseded_by_id: string | null;
  user_note: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type IiAuditEventTypeR9 =
  | IiAuditEventTypeR3
  | 'goal_allocation_created'
  | 'goal_allocation_changed'
  | 'goal_allocation_removed'
  | 'forecast_integration_run'
  | 'review_item_created'
  | 'review_item_resolved'
  | 'review_acknowledged'
  | 'review_dismissed';
