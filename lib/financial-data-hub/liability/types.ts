/**
 * FDH-10 — Credit Cards & Loans Intelligence: liability-statement domain types.
 *
 * This module is part of the Financial Data Hub and therefore names NO
 * protected Input Data register directly (see `constants/tables.ts`'s
 * FHIP_PROTECTED_INPUT_TABLES and `tests/unit/fdh1Isolation.test.ts`) — it
 * produces STATEMENT EVIDENCE. Turning evidence into a Liability proposal is
 * the job of `lib/import-bridge/adapters/liabilityAdapter.ts`, which lives
 * outside this tree for the exact reason FDH-9's income adapter does (see
 * docs/financial-data-hub/FDH10_REUSE_AND_GAP_AUDIT.md).
 *
 * Mirrors the shape FDH-9 established for payroll evidence
 * (`lib/financial-data-hub/payslip/types.ts`) so the two intelligence
 * pipelines read the same way to a future maintainer.
 */

export const LIABILITY_STATEMENT_COUNTRIES = ['AU', 'IN'] as const;
export type LiabilityStatementCountry = (typeof LIABILITY_STATEMENT_COUNTRIES)[number];

export const LIABILITY_STATEMENT_TYPES = ['credit_card', 'loan'] as const;
export type LiabilityStatementType = (typeof LIABILITY_STATEMENT_TYPES)[number];

/**
 * Facility types FDH-10 recognises (spec section 12). Deliberately a superset
 * of `fdh_financial_accounts.account_type`'s pre-existing FDH-1 vocabulary
 * ('credit_card', 'home_loan', 'personal_loan', 'vehicle_loan') widened
 * additively for the four the Product Owner named that FDH-1 did not yet
 * anticipate: investment_property_loan, other_term_loan, line_of_credit,
 * overdraft.
 */
export const LIABILITY_FACILITY_TYPES = [
  'credit_card',
  'personal_loan',
  'home_loan',
  'investment_property_loan',
  'vehicle_loan',
  'other_term_loan',
  'line_of_credit',
  'overdraft',
] as const;
export type LiabilityFacilityType = (typeof LIABILITY_FACILITY_TYPES)[number];

/** Mirrors `lib/validation/liability.ts`'s `debt_type` — the canonical
 * Liability register's own (smaller, pre-FDH-10) vocabulary. A facility type
 * that has no canonical equivalent yet must not be silently coerced onto one
 * that does (spec section 12's "only where supported by current taxonomy"). */
export const CANONICAL_DEBT_TYPES = [
  'mortgage', 'personal_loan', 'credit_card', 'auto_loan', 'student_loan',
  'investment_property_loan', 'line_of_credit', 'overdraft', 'other_term_loan', 'other',
] as const;
export type CanonicalDebtType = (typeof CANONICAL_DEBT_TYPES)[number];

/** Facility type -> canonical `liabilities.debt_type`. `other_term_loan`
 * genuinely has no better home than 'other_term_loan' itself now that it has
 * been added to the canonical vocabulary (spec section 12). */
export const FACILITY_TO_DEBT_TYPE: Record<LiabilityFacilityType, CanonicalDebtType> = {
  credit_card: 'credit_card',
  personal_loan: 'personal_loan',
  home_loan: 'mortgage',
  investment_property_loan: 'investment_property_loan',
  vehicle_loan: 'auto_loan',
  other_term_loan: 'other_term_loan',
  line_of_credit: 'line_of_credit',
  overdraft: 'overdraft',
};

/** Statement-activity vocabulary (spec section 20) — deliberately distinct
 * from `fdh_transactions.economic_transaction_type` (FDH-1's ledger-meaning
 * vocabulary). This is what the SOURCE DOCUMENT calls the line; economic
 * meaning is derived from it by `creditCardEconomics.ts`/
 * `repaymentDecomposition.ts`, never assumed to be the same axis. */
export const LIABILITY_ACTIVITY_TYPES = [
  'PURCHASE', 'REFUND', 'PAYMENT', 'CASH_ADVANCE', 'INTEREST', 'FEE',
  'PRINCIPAL', 'LOAN_ADVANCE', 'ADJUSTMENT', 'OTHER',
] as const;
export type LiabilityActivityType = (typeof LIABILITY_ACTIVITY_TYPES)[number];

export const RECONCILIATION_STATUSES = ['reconciled', 'variance', 'insufficient_data'] as const;
export type LiabilityReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const BANK_MATCH_STATUSES = [
  'matched', 'no_match', 'multiple_candidates', 'not_attempted', 'bank_evidence_not_available',
] as const;
export type LiabilityBankMatchStatus = (typeof BANK_MATCH_STATUSES)[number];

export const RATE_TYPES = ['purchase', 'cash_advance', 'promotional', 'loan_variable', 'loan_fixed'] as const;
export type LiabilityRateType = (typeof RATE_TYPES)[number];

/** One line read off a credit-card or loan statement. */
export interface LiabilityStatementActivity {
  activityType: LiabilityActivityType;
  activityDate: string;
  /** Positive magnitude — direction/meaning is derived, never encoded here
   * (mirrors `fdh_transactions.amount_original`'s own convention). */
  amount: number;
  descriptionRaw?: string;
  merchantRaw?: string;
  /** Statement-supplied components of a PAYMENT line, where disclosed (spec
   * sections 14, 34) — e.g. an EMI statement's principal/interest/fee split.
   * Statement-provided values take precedence over any derived split. */
  principalComponent?: number;
  interestComponent?: number;
  feeComponent?: number;
  sourceRowNumber?: number;
}

/** The structured result of reading one credit-card or loan statement. */
export interface LiabilityStatementExtraction {
  statementType: LiabilityStatementType;
  country: LiabilityStatementCountry;
  currencyCode: string;
  facilityType: LiabilityFacilityType;

  institutionName?: string;
  /** Masked/last-4 identifier only — never a full account/card number (spec
   * section 13). Enforced additionally at the DB boundary, mirroring
   * `fdh_financial_accounts.chk_fdh_accounts_masked_identifier`. */
  maskedIdentifier?: string;
  nickname?: string;

  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;

  openingBalance?: number;
  closingBalance?: number;

  // Credit card
  creditLimit?: number;
  availableCredit?: number;
  minimumPayment?: number;

  // Loan
  openingPrincipal?: number;
  closingPrincipal?: number;
  interestRate?: number;
  rateType?: LiabilityRateType;
  repaymentFrequency?: string;
  maturityDate?: string;
  arrearsAmount?: number;

  activities: LiabilityStatementActivity[];

  parserName: string;
  parserVersion: string;
  extractionConfidence: number;
  warnings: string[];
}

export type LiabilityExtractionFailureKind =
  | 'scanned_document'
  | 'ocr_required'
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'layout_unsupported'
  | 'country_not_identified'
  | 'statement_type_not_identified'
  /** No registered adapter's header signature cleared the minimum-confidence
   * bar (spec section 28's `detectStatement` step failing outright) — never
   * silently falls back to a guessed column mapping. */
  | 'manual_mapping_required'
  /** Two or more adapters scored within the confidence gap of each other
   * (mirrors R7's own AMBIGUOUS bank-CSV outcome) — never auto-picks either. */
  | 'ambiguous_format'
  | 'unknown_error';

export interface LiabilityExtractionSuccess {
  ok: true;
  extraction: LiabilityStatementExtraction;
}
export interface LiabilityExtractionFailure {
  ok: false;
  kind: LiabilityExtractionFailureKind;
  error: string;
}
export type LiabilityExtractionResult = LiabilityExtractionSuccess | LiabilityExtractionFailure;
