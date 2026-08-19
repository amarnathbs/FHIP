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
  | 'adjustment';
export type IiTransactionStatus = 'parsed' | 'reconciled' | 'corrected' | 'reversed';

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
