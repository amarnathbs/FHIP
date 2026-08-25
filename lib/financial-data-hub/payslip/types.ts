/**
 * FDH-9 — Payslip & Income Intelligence: payroll domain types.
 *
 * This module is part of the Financial Data Hub and therefore names NO Input
 * Data register anywhere (see `constants/tables.ts`'s
 * FHIP_PROTECTED_INPUT_TABLES and `tests/unit/fdh1Isolation.test.ts`). It
 * produces payroll EVIDENCE. Turning evidence into an Income proposal is the
 * job of `lib/import-bridge/`, which lives outside this tree precisely because
 * it is a platform service serving five future domains rather than an FDH
 * internal — see docs/financial-data-hub/FDH9_REUSE_AND_GAP_AUDIT.md §4.1.
 */

export const PAYROLL_COUNTRIES = ['AU', 'IN'] as const;
export type PayrollCountry = (typeof PAYROLL_COUNTRIES)[number];

export const PAY_FREQUENCIES = [
  'weekly',
  'fortnightly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual',
  'irregular',
  'unknown',
] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const PAY_FREQUENCY_SOURCES = [
  'stated_on_payslip',
  'derived_from_period',
  'derived_from_history',
  'user_confirmed',
  'unknown',
] as const;
export type PayFrequencySource = (typeof PAY_FREQUENCY_SOURCES)[number];

export const PAYROLL_COMPONENT_SIDES = [
  'earning',
  'deduction',
  'employer_contribution',
  'informational',
] as const;
export type PayrollComponentSide = (typeof PAYROLL_COMPONENT_SIDES)[number];

/** Mirrors the `component_type` check constraint in migration 0091 exactly. */
export const PAYROLL_COMPONENT_TYPES = [
  'base', 'overtime', 'bonus', 'commission', 'allowance', 'reimbursement',
  'arrears', 'other_earning',
  'basic', 'hra', 'dearness_allowance', 'special_allowance', 'conveyance', 'lta',
  'income_tax_withheld', 'professional_tax', 'salary_sacrifice',
  'employee_retirement', 'employee_nps', 'other_deduction',
  'employer_retirement', 'employer_nps',
  'unknown',
] as const;
export type PayrollComponentType = (typeof PAYROLL_COMPONENT_TYPES)[number];

export const RECONCILIATION_STATUSES = ['reconciled', 'variance', 'insufficient_data'] as const;
export type PayrollReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const BANK_MATCH_STATUSES = ['matched', 'no_match', 'multiple_candidates', 'not_attempted'] as const;
export type PayrollBankMatchStatus = (typeof BANK_MATCH_STATUSES)[number];

/**
 * One line read off a payslip.
 *
 * PRIVACY (spec section 13). `labelRaw` is the earning/deduction LABEL only
 * ("Basic", "HRA", "Overtime", "PAYG Withholding"). Employee ID, home address,
 * bank account number, TFN and PAN are never captured into this or any other
 * FDH-9 structure — `redactSensitivePayrollText` in `privacy.ts` is applied to
 * every label before it reaches here.
 */
export interface PayrollComponent {
  side: PayrollComponentSide;
  type: PayrollComponentType;
  labelRaw: string;
  amount: number;
  /** True when this figure came from the payslip's year-to-date column.
   * YTD is EVIDENCE, never another payment (spec section 35). */
  isYearToDate: boolean;
}

/**
 * The structured result of reading one payslip.
 *
 * Every money field is optional because a real payslip may simply not disclose
 * it, and `undefined` ("the document does not say") is a materially different
 * fact from `0` ("the document says zero"). Nothing in FDH-9 coerces one into
 * the other.
 */
export interface PayrollExtraction {
  country: PayrollCountry;
  currencyCode: string;

  employerName?: string;
  payPeriodStart?: string;
  payPeriodEnd?: string;
  paymentDate?: string;

  payFrequency: PayFrequency;
  payFrequencySource: PayFrequencySource;

  // Current period — earnings
  grossPay?: number;
  basePay?: number;
  overtimePay?: number;
  bonusPay?: number;
  commissionPay?: number;
  allowancesTotal?: number;
  reimbursementsTotal?: number;
  otherEarnings?: number;

  // Current period — deductions
  taxWithheld?: number;
  employeeDeductionsTotal?: number;
  salarySacrifice?: number;
  professionalTax?: number;

  // Retirement (evidence only — FDH-9 writes no retirement balance, spec 37)
  employerRetirementContribution?: number;
  employeeRetirementContribution?: number;
  employerNpsContribution?: number;
  employeeNpsContribution?: number;

  netPay?: number;

  // Year to date — held separately, never summed with the above (spec 35)
  ytdGross?: number;
  ytdTax?: number;
  ytdNet?: number;
  ytdEmployerRetirement?: number;
  ytdEmployeeRetirement?: number;

  components: PayrollComponent[];

  parserName: string;
  parserVersion: string;
  extractionConfidence: number;
  /** Machine-readable notes about what could not be read. Never a stack trace,
   * never raw document text. */
  warnings: string[];
}

export type PayslipExtractionFailureKind =
  | 'scanned_document'
  | 'ocr_required'
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'layout_unsupported'
  | 'country_not_identified'
  | 'page_limit_exceeded'
  | 'not_a_payslip'
  | 'unknown_error';

export interface PayslipExtractionSuccess {
  ok: true;
  extraction: PayrollExtraction;
}
export interface PayslipExtractionFailure {
  ok: false;
  kind: PayslipExtractionFailureKind;
  error: string;
}
export type PayslipExtractionResult = PayslipExtractionSuccess | PayslipExtractionFailure;
