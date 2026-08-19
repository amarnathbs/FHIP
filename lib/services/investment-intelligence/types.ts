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

export type IiIdentifierScheme = 'isin' | 'amfi_scheme_code' | 'nse_symbol' | 'bse_code' | 'sedol' | 'internal_provisional';

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
  | 'unclassified';
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
