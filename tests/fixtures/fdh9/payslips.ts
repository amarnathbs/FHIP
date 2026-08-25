/**
 * FDH-9 — payslip certification fixtures and their INDEPENDENT ORACLE.
 *
 * SPEC SECTION 64: "Independent oracle — expected gross, net, tax, retirement
 * contribution, bank match, income proposal and Input Data result after Apply
 * must be independently specified. DO NOT CERTIFY PRODUCTION CODE AGAINST
 * ITSELF."
 *
 * Every `expected` block below was computed BY HAND from the payslip text
 * beside it — arithmetic done independently, then written down — and NOT by
 * running the parser and recording whatever it produced. Each fixture carries
 * its own worked arithmetic in a comment so the oracle can be re-checked by a
 * reader without executing anything.
 *
 * Where a fixture exists to prove a FAILURE mode (a one-cent variance, an
 * unreconcilable payslip, a scanned document, a bank statement uploaded by
 * mistake), the expectation is the failure — a fixture that only ever passes
 * proves nothing.
 */

import type { PayFrequency, PayFrequencySource, PayrollReconciliationStatus } from '@/lib/financial-data-hub/payslip/types';

export interface PayslipOracle {
  country: 'AU' | 'IN';
  currencyCode: string;
  employerName?: string;
  payPeriodStart?: string;
  payPeriodEnd?: string;
  paymentDate?: string;
  payFrequency: PayFrequency;
  payFrequencySource: PayFrequencySource;

  grossPay?: number;
  basePay?: number;
  overtimePay?: number;
  bonusPay?: number;
  commissionPay?: number;
  allowancesTotal?: number;
  reimbursementsTotal?: number;
  otherEarnings?: number;

  taxWithheld?: number;
  employeeDeductionsTotal?: number;
  salarySacrifice?: number;
  professionalTax?: number;

  employerRetirementContribution?: number;
  employeeRetirementContribution?: number;
  employerNpsContribution?: number;
  employeeNpsContribution?: number;

  netPay?: number;

  ytdGross?: number;
  ytdTax?: number;
  ytdNet?: number;

  reconciliationStatus: PayrollReconciliationStatus;
  /** expectedNet - actualNet, exactly. */
  reconciliationVariance: number | null;
}

export interface PayslipFixture {
  id: string;
  description: string;
  text: string;
  /**
   * Upload-metadata fallbacks, supplied ONLY where the document itself carries
   * no jurisdiction signal. Document evidence always takes precedence over a
   * declared value — see `parsePayslipText`. Most fixtures deliberately omit
   * this so that country detection is genuinely exercised.
   */
  parseOptions?: { declaredCountry?: 'AU' | 'IN'; declaredCurrency?: string };
  expected: PayslipOracle;
}

/** Fixtures whose expectation is that extraction REFUSES the document. */
export interface PayslipRejectionFixture {
  id: string;
  description: string;
  text: string;
  expectedError: 'not_a_payslip' | 'country_not_identified';
}

// ===========================================================================
// AUSTRALIA
// ===========================================================================

export const AU_FIXTURES: PayslipFixture[] = [
  {
    id: 'AU-01',
    description: 'Fortnightly, ordinary + overtime + allowance, PAYG, employer super, full YTD column',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  4,000.00 + 300.00 + 150.00            = 4,450.00
    //   deductions 1,100.00 +  25.00                    = 1,125.00
    //   expected net = 4,450.00 - 1,125.00              = 3,325.00
    //   stated net                                       = 3,325.00  -> RECONCILED, variance 0
    text: `ACME ENGINEERING PTY LTD
Payslip
Employer: Acme Engineering Pty Ltd
ABN 12 345 678 901
Employee: Jane Citizen
Pay Period: 03/08/2026 - 16/08/2026
Payment Date: 17/08/2026
Pay Frequency: Fortnightly

Description             This Period      Year to Date
Ordinary Hours             4,000.00         12,000.00
Overtime                     300.00            900.00
Site Allowance               150.00            450.00
Total Earnings             4,450.00         13,350.00

Deductions
PAYG Withholding           1,100.00          3,300.00
Union Fees                    25.00             75.00
Total Deductions           1,125.00

Net Pay                    3,325.00         10,025.00

Superannuation
Employer Superannuation      511.75          1,535.25`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Acme Engineering Pty Ltd',
      payPeriodStart: '2026-08-03', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-17',
      payFrequency: 'fortnightly', payFrequencySource: 'stated_on_payslip',
      grossPay: 4450, basePay: 4000, overtimePay: 300, allowancesTotal: 150,
      taxWithheld: 1100, employeeDeductionsTotal: 1125,
      employerRetirementContribution: 511.75,
      netPay: 3325,
      ytdGross: 13350, ytdTax: 3300, ytdNet: 10025,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'AU-02',
    description: 'Weekly, with an expense REIMBURSEMENT that reaches the bank but is not gross income',
    // ORACLE ARITHMETIC (by hand):
    //   stated gross earnings excludes the reimbursement:
    //     1,600.00 + 45.00                              = 1,645.00
    //   net includes it, because it is really paid:
    //     earnings 1,600.00 + 45.00 + 120.00            = 1,765.00
    //     deductions                                      =   380.00
    //     expected net = 1,765.00 - 380.00              = 1,385.00
    //   stated net                                       = 1,385.00  -> RECONCILED
    text: `Payslip
Employer: Northline Logistics Pty Ltd
Employee: A Driver
Pay Period: 10/08/2026 - 16/08/2026
Payment Date: 18/08/2026
Pay Frequency: Weekly

Description                Amount           YTD
Ordinary Hours           1,600.00     25,600.00
Meal Allowance              45.00        720.00
Expense Reimbursement      120.00        340.00
Gross Earnings           1,645.00     26,320.00

PAYG Withholding           380.00      6,080.00
Total Deductions           380.00

Net Pay                  1,385.00

Employer Superannuation    189.18      3,026.88`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Northline Logistics Pty Ltd',
      payPeriodStart: '2026-08-10', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-18',
      payFrequency: 'weekly', payFrequencySource: 'stated_on_payslip',
      grossPay: 1645, basePay: 1600, allowancesTotal: 45, reimbursementsTotal: 120,
      taxWithheld: 380, employeeDeductionsTotal: 380,
      employerRetirementContribution: 189.18,
      netPay: 1385,
      ytdGross: 26320, ytdTax: 6080,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'AU-03',
    description: 'Monthly, performance bonus + salary sacrifice (pre-tax), employer super',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  9,000.00 + 2,500.00                   = 11,500.00
    //   deductions 3,200.00 + 500.00                    =  3,700.00
    //   expected net = 11,500.00 - 3,700.00             =  7,800.00
    //   stated net                                       =  7,800.00 -> RECONCILED
    text: `Payslip
Employer: Harbour Financial Services Pty Ltd
Employee: R Nguyen
Pay Period: 01/07/2026 - 31/07/2026
Payment Date: 31/07/2026
Pay Frequency: Monthly

Description               This Period    Year to Date
Base Salary                  9,000.00        9,000.00
Performance Bonus            2,500.00        2,500.00
Total Earnings              11,500.00       11,500.00

PAYG Withholding             3,200.00        3,200.00
Salary Sacrifice Super         500.00          500.00
Total Deductions             3,700.00

Net Pay                      7,800.00        7,800.00

Employer Superannuation      1,322.50        1,322.50`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Harbour Financial Services Pty Ltd',
      payPeriodStart: '2026-07-01', payPeriodEnd: '2026-07-31', paymentDate: '2026-07-31',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 11500, basePay: 9000, bonusPay: 2500,
      taxWithheld: 3200, employeeDeductionsTotal: 3700, salarySacrifice: 500,
      employerRetirementContribution: 1322.5,
      netPay: 7800,
      ytdGross: 11500, ytdTax: 3200, ytdNet: 7800,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'AU-04',
    description: 'ONE CENT variance — spec section 19 requires a 0.01 discrepancy to be detectable',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  4,000.00 + 300.00 + 150.00            = 4,450.00
    //   deductions 1,100.00 + 25.00                     = 1,125.00
    //   expected net                                     = 3,325.00
    //   stated net                                       = 3,325.01
    //   variance = expected - actual = 3,325.00 - 3,325.01 = -0.01  -> VARIANCE
    text: `Payslip
Employer: Acme Engineering Pty Ltd
Employee: Jane Citizen
Pay Period: 03/08/2026 - 16/08/2026
Payment Date: 17/08/2026
Pay Frequency: Fortnightly

Description             This Period      Year to Date
Ordinary Hours             4,000.00         12,000.00
Overtime                     300.00            900.00
Site Allowance               150.00            450.00
Total Earnings             4,450.00         13,350.00

PAYG Withholding           1,100.00          3,300.00
Union Fees                    25.00             75.00
Total Deductions           1,125.00

Net Pay                    3,325.01         10,025.01`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Acme Engineering Pty Ltd',
      payPeriodStart: '2026-08-03', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-17',
      payFrequency: 'fortnightly', payFrequencySource: 'stated_on_payslip',
      grossPay: 4450, basePay: 4000, overtimePay: 300, allowancesTotal: 150,
      taxWithheld: 1100, employeeDeductionsTotal: 1125,
      netPay: 3325.01,
      ytdGross: 13350, ytdTax: 3300, ytdNet: 10025.01,
      reconciliationStatus: 'variance', reconciliationVariance: -0.01,
    },
  },

  {
    id: 'AU-05',
    description: 'No deduction detail at all — INSUFFICIENT_DATA is the correct answer, not a guess',
    // ORACLE: gross and net are known, but nothing discloses what was deducted.
    // No component deduction lines and no deduction total => the identity
    // cannot be evaluated. Correct status is INSUFFICIENT_DATA, variance null.
    text: `Pay Statement
Employer: Coastal Trades Pty Ltd
Employee: M Brown
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 31/08/2026
Pay Frequency: Monthly

Gross Earnings             8,000.00
Net Pay                    6,100.00`,
    // This payslip carries NO jurisdiction marker — no PAYG, no super, no ABN.
    // FDH-9 refuses to guess from the bare "$"-free text, so the country comes
    // from the upload metadata the user supplied on the Income tab. Certified
    // both ways: with the declared country it parses; without one it is
    // refused (see the "refuses to assume a jurisdiction" test).
    parseOptions: { declaredCountry: 'AU', declaredCurrency: 'AUD' },
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Coastal Trades Pty Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-08-31',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 8000,
      netPay: 6100,
      reconciliationStatus: 'insufficient_data', reconciliationVariance: null,
    },
  },

  {
    id: 'AU-06',
    description: 'Second employer, same household — commission-based, no super line',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  1,200.00 + 850.00                     = 2,050.00
    //   deductions                                       =   410.00
    //   expected net = 2,050.00 - 410.00                = 1,640.00
    //   stated net                                       = 1,640.00 -> RECONCILED
    text: `Payslip
Employer: Bright Realty Pty Ltd
Employee: Jane Citizen
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 02/09/2026
Pay Frequency: Monthly

Description             This Period      Year to Date
Base Salary                1,200.00          3,600.00
Commission                   850.00          2,300.00
Total Earnings             2,050.00          5,900.00

PAYG Withholding             410.00          1,180.00
Total Deductions             410.00

Net Pay                    1,640.00          4,720.00`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Bright Realty Pty Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-09-02',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 2050, basePay: 1200, commissionPay: 850,
      taxWithheld: 410, employeeDeductionsTotal: 410,
      netPay: 1640,
      ytdGross: 5900, ytdTax: 1180, ytdNet: 4720,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'AU-07',
    description: 'Frequency NOT stated — must be derived from the 14-day period, not assumed monthly',
    // ORACLE: period 03/08/2026..16/08/2026 inclusive = 14 days -> fortnightly,
    // source derived_from_period (NOT stated_on_payslip).
    //   earnings 3,000.00 ; deductions 700.00 ; expected net 2,300.00 = stated
    text: `Payslip
Employer: Redgum Manufacturing Pty Ltd
Employee: S Patel
Pay Period: 03/08/2026 - 16/08/2026
Payment Date: 17/08/2026

Description             This Period      Year to Date
Ordinary Hours             3,000.00          9,000.00
Total Earnings             3,000.00          9,000.00

PAYG Withholding             700.00          2,100.00
Total Deductions             700.00

Net Pay                    2,300.00          6,900.00`,
    expected: {
      country: 'AU', currencyCode: 'AUD',
      employerName: 'Redgum Manufacturing Pty Ltd',
      payPeriodStart: '2026-08-03', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-17',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 3000, basePay: 3000,
      taxWithheld: 700, employeeDeductionsTotal: 700,
      netPay: 2300,
      ytdGross: 9000, ytdTax: 2100, ytdNet: 6900,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },
];

// ===========================================================================
// INDIA
// ===========================================================================

export const IN_FIXTURES: PayslipFixture[] = [
  {
    id: 'IN-01',
    description: 'Monthly: Basic/HRA/DA/Special/Conveyance, TDS, employee+employer PF, NPS, professional tax',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 50,000 + 20,000 + 5,000 + 15,000 + 1,600 = 91,600.00
    //   deductions 8,500 + 6,000 + 200 + 2,000            = 16,700.00
    //   expected net = 91,600 - 16,700                    = 74,900.00
    //   stated net                                         = 74,900.00 -> RECONCILED
    //   allowances total = 20,000 + 5,000 + 15,000 + 1,600 = 41,600.00
    text: `Salary Slip
Employer: Sunrise Technologies Private Limited
Employee: A Sharma
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 31/08/2026
Pay Frequency: Monthly

Earnings                  This Period    Year to Date
Basic                       50,000.00      250,000.00
House Rent Allowance        20,000.00      100,000.00
Dearness Allowance           5,000.00       25,000.00
Special Allowance           15,000.00       75,000.00
Conveyance Allowance         1,600.00        8,000.00
Gross Earnings              91,600.00      458,000.00

Deductions
TDS                          8,500.00       42,500.00
Employee Provident Fund      6,000.00       30,000.00
Professional Tax               200.00        1,000.00
Employee NPS                 2,000.00       10,000.00
Total Deductions            16,700.00

Net Pay                     74,900.00

Employer Provident Fund      6,000.00       30,000.00
Employer NPS                 2,000.00       10,000.00`,
    expected: {
      country: 'IN', currencyCode: 'INR',
      employerName: 'Sunrise Technologies Private Limited',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-08-31',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 91600, basePay: 50000, allowancesTotal: 41600,
      taxWithheld: 8500, employeeDeductionsTotal: 16700, professionalTax: 200,
      employeeRetirementContribution: 6000, employerRetirementContribution: 6000,
      employeeNpsContribution: 2000, employerNpsContribution: 2000,
      netPay: 74900,
      ytdGross: 458000, ytdTax: 42500,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'IN-02',
    description: 'INDIAN DIGIT GROUPING (lakh): 1,50,000 must parse as 150000, not 150 or 1.5',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 1,50,000 + 60,000 + 40,000 = 150,000 + 60,000 + 40,000 = 250,000.00
    //   deductions 45,000 + 1,800 + 200                                 =  47,000.00
    //   expected net = 250,000 - 47,000                                 = 203,000.00
    //   stated net                                                       = 203,000.00 -> RECONCILED
    //   allowances = 60,000 + 40,000                                    = 100,000.00
    text: `Salary Slip
Employer: Meridian Analytics Pvt Ltd
Employee: K Iyer
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 30/08/2026
Pay Frequency: Monthly

Earnings                  This Period    Year to Date
Basic                     1,50,000.00    7,50,000.00
House Rent Allowance         60,000.00    3,00,000.00
Special Allowance            40,000.00    2,00,000.00
Gross Earnings            2,50,000.00   12,50,000.00

Deductions
TDS                          45,000.00    2,25,000.00
Employee Provident Fund       1,800.00        9,000.00
Professional Tax                200.00        1,000.00
Total Deductions             47,000.00

Net Pay                   2,03,000.00

Employer Provident Fund       1,800.00        9,000.00`,
    expected: {
      country: 'IN', currencyCode: 'INR',
      employerName: 'Meridian Analytics Pvt Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-08-30',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 250000, basePay: 150000, allowancesTotal: 100000,
      taxWithheld: 45000, employeeDeductionsTotal: 47000, professionalTax: 200,
      employeeRetirementContribution: 1800, employerRetirementContribution: 1800,
      netPay: 203000,
      ytdGross: 1250000, ytdTax: 225000,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'IN-03',
    description: 'Bonus + arrears, no NPS disclosed — variable pay must not become recurring income',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 40,000 + 16,000 + 25,000 + 8,000 = 89,000.00
    //     (basic 40,000; HRA 16,000; bonus 25,000; arrears 8,000)
    //   deductions 12,000 + 4,800 + 200           = 17,000.00
    //   expected net = 89,000 - 17,000            = 72,000.00
    //   stated net                                 = 72,000.00 -> RECONCILED
    text: `Salary Slip
Employer: Peninsula Foods Private Limited
Employee: D Rao
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 31/08/2026
Pay Frequency: Monthly

Earnings                  This Period    Year to Date
Basic                       40,000.00      200,000.00
House Rent Allowance        16,000.00       80,000.00
Annual Bonus                25,000.00       25,000.00
Arrears                      8,000.00        8,000.00
Gross Earnings              89,000.00      313,000.00

Deductions
TDS                         12,000.00       60,000.00
Employee Provident Fund      4,800.00       24,000.00
Professional Tax               200.00        1,000.00
Total Deductions            17,000.00

Net Pay                     72,000.00

Employer Provident Fund      4,800.00       24,000.00`,
    expected: {
      country: 'IN', currencyCode: 'INR',
      employerName: 'Peninsula Foods Private Limited',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-08-31',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 89000, basePay: 40000, allowancesTotal: 16000,
      bonusPay: 25000, otherEarnings: 8000,
      taxWithheld: 12000, employeeDeductionsTotal: 17000, professionalTax: 200,
      employeeRetirementContribution: 4800, employerRetirementContribution: 4800,
      netPay: 72000,
      ytdGross: 313000, ytdTax: 60000,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },

  {
    id: 'IN-04',
    description: 'Second Indian employer — multiple employment sources in one household',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 25,000 + 10,000        = 35,000.00
    //   deductions 2,000 + 3,000 + 200  =  5,200.00
    //   expected net = 35,000 - 5,200   = 29,800.00
    //   stated net                       = 29,800.00 -> RECONCILED
    text: `Salary Slip
Employer: Lakeview Consulting LLP
Employee: A Sharma
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 05/09/2026
Pay Frequency: Monthly

Earnings                  This Period    Year to Date
Basic                       25,000.00      125,000.00
Special Allowance           10,000.00       50,000.00
Gross Earnings              35,000.00      175,000.00

Deductions
TDS                          2,000.00       10,000.00
Employee Provident Fund      3,000.00       15,000.00
Professional Tax               200.00        1,000.00
Total Deductions             5,200.00

Net Pay                     29,800.00`,
    expected: {
      country: 'IN', currencyCode: 'INR',
      employerName: 'Lakeview Consulting LLP',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-09-05',
      payFrequency: 'monthly', payFrequencySource: 'stated_on_payslip',
      grossPay: 35000, basePay: 25000, allowancesTotal: 10000,
      taxWithheld: 2000, employeeDeductionsTotal: 5200, professionalTax: 200,
      employeeRetirementContribution: 3000,
      netPay: 29800,
      ytdGross: 175000, ytdTax: 10000,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
  },
];

export const ALL_PAYSLIP_FIXTURES: PayslipFixture[] = [...AU_FIXTURES, ...IN_FIXTURES];

// ===========================================================================
// REJECTION FIXTURES — the expectation is a refusal
// ===========================================================================

export const REJECTION_FIXTURES: PayslipRejectionFixture[] = [
  {
    id: 'REJ-01',
    description: 'A bank statement uploaded into the payslip flow must be refused, not parsed',
    text: `Everyday Account Statement
Account 123-456 78901234
Date        Description              Debit     Credit    Balance
01/08/2026  WOOLWORTHS 1234          85.20               2,410.55
03/08/2026  ACME PAYROLL                      3,325.00   5,735.55`,
    expectedError: 'not_a_payslip',
  },
  {
    id: 'REJ-02',
    description: 'A payslip with no jurisdiction signal at all must not be assumed to be AU',
    text: `Payslip
Employee: Someone
Gross Earnings   1,000.00
Net Pay            800.00`,
    expectedError: 'country_not_identified',
  },
];
