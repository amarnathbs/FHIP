/**
 * FDH-12 — Retirement Statement Intelligence: the module's vocabulary.
 *
 * ISOLATION. Nothing in `lib/financial-data-hub/retirement/` imports from
 * `lib/services/`, `lib/engines/` or `lib/import-bridge/`, and nothing here
 * names a canonical Input Data register. The Hub extracts and reconciles
 * evidence; the bridge, and only the bridge, proposes canonical changes. This
 * is mechanically enforced by `tests/unit/fdh12Isolation.test.ts`.
 *
 * EVERY MONEY VALUE IN THIS FILE IS AN EXACT DECIMAL STRING, never a JS
 * number. Parsing and arithmetic go through `./money.ts` (spec sections 46,
 * 142). A `number` type on a money field here would be a defect.
 */

// ---------------------------------------------------------------------------
// Statement-level vocabulary (mirrors migration 0112's CHECK constraints)
// ---------------------------------------------------------------------------

export const RETIREMENT_STATEMENT_TYPES = [
  'super_member_statement',
  'super_annual_statement',
  'super_transaction_statement',
  'super_contribution_statement',
  'account_based_pension_statement',
  'retirement_statement_csv',
  'epf_passbook_statement',
  'nps_transaction_statement',
] as const;
export type RetirementStatementType = (typeof RETIREMENT_STATEMENT_TYPES)[number];

export const RETIREMENT_JURISDICTIONS = ['AU', 'IN'] as const;
export type RetirementJurisdiction = (typeof RETIREMENT_JURISDICTIONS)[number];

/** Mirrors the canonical `master_financial_items` retirement catalogue keys
 * rather than inventing a parallel vocabulary (spec section 21). */
export const RETIREMENT_ACCOUNT_TYPES = [
  'industry_super', 'retail_super', 'defined_benefit',
  'account_based_pension', 'allocated_pension', 'transition_to_retirement',
  'annuity', 'overseas_pension', 'retirement_savings',
  'epf', 'ppf', 'nps',
  'unknown',
] as const;
export type RetirementAccountType = (typeof RETIREMENT_ACCOUNT_TYPES)[number];

export const RETIREMENT_EXTRACTION_STATUSES = [
  'pending', 'extracted', 'extraction_failed',
  'ocr_required', 'password_required', 'manual_mapping_required',
] as const;
export type RetirementExtractionStatus = (typeof RETIREMENT_EXTRACTION_STATUSES)[number];

export const RETIREMENT_RECONCILIATION_STATUSES = [
  'reconciled', 'variance', 'insufficient_data',
] as const;
export type RetirementReconciliationStatus = (typeof RETIREMENT_RECONCILIATION_STATUSES)[number];

export const RETIREMENT_ACCOUNT_MATCH_STATUSES = [
  'matched', 'no_match', 'multiple_candidates', 'not_attempted', 'new_account_confirmed',
] as const;
export type RetirementAccountMatchStatus = (typeof RETIREMENT_ACCOUNT_MATCH_STATUSES)[number];

export const RETIREMENT_SMSF_CLASSIFICATIONS = [
  'not_smsf', 'possible_smsf', 'routed_to_smsf',
] as const;
export type RetirementSmsfClassification = (typeof RETIREMENT_SMSF_CLASSIFICATIONS)[number];

// ---------------------------------------------------------------------------
// Activity vocabulary (spec section 21, complete)
// ---------------------------------------------------------------------------

export const RETIREMENT_ACTIVITY_TYPES = [
  'EMPLOYER_CONTRIBUTION', 'PERSONAL_CONTRIBUTION', 'SALARY_SACRIFICE',
  'GOVERNMENT_CONTRIBUTION', 'ROLLOVER_IN', 'ROLLOVER_OUT',
  'INVESTMENT_EARNINGS', 'INTEREST', 'DISTRIBUTION',
  'FEE', 'INSURANCE_PREMIUM', 'TAX',
  'PENSION_PAYMENT', 'WITHDRAWAL', 'ADJUSTMENT', 'OTHER', 'UNKNOWN',
] as const;
export type RetirementActivityType = (typeof RETIREMENT_ACTIVITY_TYPES)[number];

/**
 * THE DIRECTION TABLE — the single definition of whether an activity adds to
 * or subtracts from the fund balance (spec section 46's reconciliation
 * identity). Every consumer reads it from here; no module re-derives it.
 *
 * `null` means the activity does not move the balance in a defined direction
 * (ADJUSTMENT can go either way and carries its own signed evidence; UNKNOWN
 * and OTHER are, by definition, not understood well enough to place).
 */
export const RETIREMENT_ACTIVITY_DIRECTION: Record<RetirementActivityType, 'credit' | 'debit' | null> = {
  EMPLOYER_CONTRIBUTION: 'credit',
  PERSONAL_CONTRIBUTION: 'credit',
  SALARY_SACRIFICE: 'credit',
  GOVERNMENT_CONTRIBUTION: 'credit',
  ROLLOVER_IN: 'credit',
  INVESTMENT_EARNINGS: 'credit',
  INTEREST: 'credit',
  DISTRIBUTION: 'credit',
  ROLLOVER_OUT: 'debit',
  WITHDRAWAL: 'debit',
  PENSION_PAYMENT: 'debit',
  FEE: 'debit',
  INSURANCE_PREMIUM: 'debit',
  TAX: 'debit',
  ADJUSTMENT: null,
  OTHER: null,
  UNKNOWN: null,
};

/**
 * ACTIVITY TYPES THAT ARE INTERNAL TO THE FUND (spec sections 39-42, 75-76,
 * 81).
 *
 * An internal activity moves money inside the retirement account and produces
 * NO household bank event. Investment earnings retained in the fund, an
 * administration fee deducted from the balance, an insurance premium paid out
 * of super, and contributions tax are all internal.
 *
 * FDH-12 has no write path to income, expenses or bank transactions at all, so
 * this table is not what prevents a false household expense — nothing could
 * create one. What it drives is (a) bank matching, which never even looks for
 * a corroborating bank transaction for an internal activity, so an
 * unmatched-bank state is never raised as a review item for one (spec section
 * 81), and (b) the UI copy that explains to the user why no cash movement
 * appears.
 */
export const RETIREMENT_ACTIVITY_IS_INTERNAL: Record<RetirementActivityType, boolean> = {
  EMPLOYER_CONTRIBUTION: true,   // paid by the employer directly to the fund
  SALARY_SACRIFICE: true,        // deducted pre-tax by payroll, never household cash
  GOVERNMENT_CONTRIBUTION: true, // paid by the ATO / government directly
  INVESTMENT_EARNINGS: true,
  INTEREST: true,
  DISTRIBUTION: true,
  FEE: true,
  INSURANCE_PREMIUM: true,
  TAX: true,
  ROLLOVER_IN: true,             // fund-to-fund; never touches household cash
  ROLLOVER_OUT: true,
  ADJUSTMENT: true,
  UNKNOWN: true,                 // fail closed: do not go looking for a bank match
  // These genuinely cross the boundary between the fund and household cash,
  // and so MAY have a corroborating bank transaction (spec sections 77-80).
  PERSONAL_CONTRIBUTION: false,  // bank -> super
  WITHDRAWAL: false,             // super -> bank
  PENSION_PAYMENT: false,        // super -> bank
  OTHER: false,
};

// ---------------------------------------------------------------------------
// Extraction result types
// ---------------------------------------------------------------------------

/** One line of statement activity, as read. */
export interface RetirementActivityEvidence {
  activityType: RetirementActivityType;
  /** Exact decimal string, positive magnitude. Direction comes from
   * RETIREMENT_ACTIVITY_DIRECTION, never from a sign here. */
  amount: string;
  currencyCode: string;
  activityDate?: string;
  effectivePeriodStart?: string;
  effectivePeriodEnd?: string;
  descriptionRaw?: string;
  employerNameRaw?: string;
  /** True when this line is a printed subtotal rather than an individual
   * economic event (spec sections 116-118). */
  isSummaryTotal: boolean;
  /** True when this line is a year-to-date figure (spec sections 114-115). */
  isYearToDate: boolean;
  sourceRowNumber?: number;
}

/** One investment option held inside the fund. Evidence only — see
 * migration 0112 PART D. */
export interface RetirementPositionEvidence {
  optionNameRaw: string;
  assetClassRaw?: string;
  tickerRaw?: string;
  isin?: string;
  units?: string;
  unitPrice?: string;
  marketValue?: string;
  currencyCode: string;
  valuationDate?: string;
  sourceRowNumber?: number;
}

export interface RetirementStatementExtraction {
  statementType: RetirementStatementType;
  jurisdiction: RetirementJurisdiction;
  accountType: RetirementAccountType;
  fundName?: string;
  maskedAccountIdentifier?: string;
  currencyCode: string;

  statementDate?: string;
  statementStartDate?: string;
  statementEndDate?: string;

  /** Exact decimal strings throughout. Absent (undefined) means "the statement
   * did not show it" — NEVER '0' (spec sections 49, 94). */
  openingBalance?: string;
  closingBalance?: string;
  employerContributions?: string;
  personalContributions?: string;
  salarySacrifice?: string;
  governmentContributions?: string;
  rolloversIn?: string;
  rolloversOut?: string;
  withdrawals?: string;
  pensionPayments?: string;
  investmentEarnings?: string;
  fees?: string;
  insurancePremiums?: string;
  tax?: string;
  ytdEmployerContributions?: string;
  ytdPersonalContributions?: string;

  activities: RetirementActivityEvidence[];
  positions: RetirementPositionEvidence[];

  parserName: string;
  parserVersion: string;
  extractionConfidence: number;
  warnings: string[];
}

export type RetirementExtractionFailureKind =
  | 'scanned_document'
  | 'ocr_required'
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'layout_unsupported'
  | 'manual_mapping_required'
  | 'ambiguous_format'
  | 'zero_balance_suspected'
  | 'unknown_error';

export interface RetirementExtractionSuccess {
  ok: true;
  extraction: RetirementStatementExtraction;
}
export interface RetirementExtractionFailure {
  ok: false;
  kind: RetirementExtractionFailureKind;
  error: string;
}
export type RetirementExtractionResult =
  | RetirementExtractionSuccess
  | RetirementExtractionFailure;

/**
 * COVERAGE HONESTY (spec section 83). A format may be described to the user
 * only by the state actually certified for it. `certified` means a real
 * fixture of that layout is exercised by
 * `tests/unit/fdh12AuSuperStatements.test.ts` and produces correct values.
 */
export const RETIREMENT_COVERAGE_STATES = [
  'certified',
  'generic_supported',
  'manual_mapping_required',
  'ocr_required',
  'unsupported',
] as const;
export type RetirementCoverageState = (typeof RETIREMENT_COVERAGE_STATES)[number];
