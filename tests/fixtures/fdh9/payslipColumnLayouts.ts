/**
 * FDH-9 — SYNTHETIC AU payslip layout corpus for the year-to-date
 * mis-mapping defect (2026-09-24).
 *
 * WHY A SECOND FIXTURE FILE. `payslips.ts` certifies WHAT is read off a
 * payslip (labels, jurisdictions, component taxonomy, reconciliation). Every
 * one of its AU fixtures happens to share ONE table shape: a single header
 * row reading `Description | This Period | Year to Date`, with exactly two
 * money columns in that order. That is why a parser which simply took
 * `amounts[0]` as the period figure passed all of them — and still shipped a
 * defect that stored a YEAR-TO-DATE total as a fortnight's base pay. This
 * file certifies the SHAPE of the table instead: column order, non-money
 * columns, year-to-date sections, and the cases where the honest answer is
 * "the document does not say".
 *
 * PROVENANCE OF THE TEXT. Every payslip below is SYNTHETIC — written here,
 * from scratch, to reproduce standard AU payslip LAYOUTS. No real payslip's
 * bytes, values or personal details were read, copied or derived to build
 * them. The figures are invented; only the arrangement is realistic.
 *
 * THE ORACLE IS INDEPENDENT (spec section 64). Each fixture carries its own
 * worked arithmetic, computed by hand from the text beside it and written
 * down BEFORE the parser was run against it. Fixtures whose expectation is a
 * FAILURE — an inconsistent payslip that must still land in `variance`, a
 * gross that must stay absent rather than be invented — are the point of the
 * corpus, not an afterthought.
 */

import type { PayslipFixture } from './payslips';

/** Extra, layout-specific expectations this corpus adds on top of the oracle. */
export interface LayoutExpectation {
  /** How the document's columns must be planned. */
  columnPlanSource: 'header' | 'ytd_present_no_header' | 'current_only';
  /** Warnings that MUST be present. */
  requiredWarnings?: string[];
  /** Warnings that must NOT be present. */
  forbiddenWarnings?: string[];
  /** Expected `grossPaySource`; `null` means it must be absent entirely. */
  grossPaySource: 'stated_on_document' | 'derived_from_components' | null;
  /** YTD figures the document discloses, checked so they cannot leak into
   * the period fields unnoticed. */
  ytdEmployerRetirement?: number;
  /** Why this fixture exists. */
  proves: string;
}

export interface PayslipLayoutFixture extends PayslipFixture {
  layout: LayoutExpectation;
}

const AU_META = { country: 'AU' as const, currencyCode: 'AUD' };

export const PAYSLIP_LAYOUT_FIXTURES: PayslipLayoutFixture[] = [
  // =========================================================================
  // PL-01 — BOTH COLUMNS, period first. The control.
  // =========================================================================
  {
    id: 'PL-01',
    description: 'Both columns, period column printed FIRST (the layout every prior AU fixture used)',
    // ORACLE ARITHMETIC (by hand):
    //   earnings   2,870.00                                  = 2,870.00
    //   deductions   566.00                                  =   566.00
    //   expected net = 2,870.00 - 566.00                     = 2,304.00
    //   stated net                                            = 2,304.00 -> RECONCILED, variance 0
    //   period 22/12/2025..04/01/2026 inclusive = 14 days -> fortnightly (derived)
    text: `Payslip
Employer: Northwind Services Pty Ltd
Employee: A Person
Pay Period: 22/12/2025 - 04/01/2026
Payment Date: 06/01/2026

Description               This Pay      Year to Date
Ordinary Hours            2,870.00         75,217.63
Total Payments            2,870.00         75,217.63
PAYG Withholding            566.00         18,455.00
Total Deductions            566.00
Net Pay                   2,304.00         56,762.63
Employer Superannuation     330.05          8,650.00`,
    expected: {
      ...AU_META,
      employerName: 'Northwind Services Pty Ltd',
      payPeriodStart: '2025-12-22', payPeriodEnd: '2026-01-04', paymentDate: '2026-01-06',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 2870, basePay: 2870,
      taxWithheld: 566, employeeDeductionsTotal: 566,
      employerRetirementContribution: 330.05,
      netPay: 2304,
      ytdGross: 75217.63, ytdTax: 18455, ytdNet: 56762.63,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'stated_on_document',
      forbiddenWarnings: ['column_mapping_ambiguous', 'column_orientation_corrected', 'column_header_not_identified'],
      ytdEmployerRetirement: 8650,
      proves: 'the ordinary two-column layout still reads exactly as before',
    },
  },

  // =========================================================================
  // PL-02 — BOTH COLUMNS, YEAR TO DATE PRINTED FIRST.
  // Identical figures to PL-01; only the column ORDER differs. Before the
  // 2026-09-24 fix the parser returned `current_first` for this header too,
  // so `base_pay` became 75,217.63 — the defect, in one fixture.
  // =========================================================================
  {
    id: 'PL-02',
    description: 'Both columns, YEAR TO DATE printed FIRST — the period figure must still win',
    // ORACLE ARITHMETIC: identical to PL-01 (same figures, columns swapped).
    //   expected net = 2,870.00 - 566.00 = 2,304.00 = stated -> RECONCILED
    text: `Payslip
Employer: Northwind Services Pty Ltd
Employee: A Person
Pay Period: 22/12/2025 - 04/01/2026
Payment Date: 06/01/2026

Description           Year to Date          This Pay
Ordinary Hours           75,217.63          2,870.00
Total Payments           75,217.63          2,870.00
PAYG Withholding         18,455.00            566.00
Total Deductions                              566.00
Net Pay                  56,762.63          2,304.00`,
    expected: {
      ...AU_META,
      employerName: 'Northwind Services Pty Ltd',
      payPeriodStart: '2025-12-22', payPeriodEnd: '2026-01-04', paymentDate: '2026-01-06',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 2870, basePay: 2870,
      taxWithheld: 566, employeeDeductionsTotal: 566,
      netPay: 2304,
      ytdGross: 75217.63, ytdTax: 18455, ytdNet: 56762.63,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'stated_on_document',
      forbiddenWarnings: ['column_mapping_ambiguous'],
      proves: 'column ORDER is read from the header and actually used (defect 2)',
    },
  },

  // =========================================================================
  // PL-03 — Qty / Rate / This Pay / Year to Date.
  // The most common real AU earnings-table shape. Before the fix the QUANTITY
  // (76.00) became the period base pay and the hourly RATE became the YTD.
  // =========================================================================
  {
    id: 'PL-03',
    description: 'Qty and Rate columns precede the money columns — neither may be read as an amount',
    // ORACLE ARITHMETIC (by hand):
    //   earnings   2,870.00 ; deductions 566.00
    //   expected net = 2,304.00 = stated -> RECONCILED, variance 0
    //   76.00 (hours) and 37.7632 (rate) are NOT money and must appear nowhere.
    text: `Payslip
Employer: Northwind Services Pty Ltd
Employee: A Person
Pay Period: 22/12/2025 - 04/01/2026
Payment Date: 06/01/2026

Description        Qty      Rate      This Pay      Year to Date
Ordinary Hours   76.00   37.7632      2,870.00         75,217.63
Total Payments                        2,870.00         75,217.63
PAYG Withholding                        566.00         18,455.00
Total Deductions                        566.00
Net Pay                               2,304.00         56,762.63`,
    expected: {
      ...AU_META,
      employerName: 'Northwind Services Pty Ltd',
      payPeriodStart: '2025-12-22', payPeriodEnd: '2026-01-04', paymentDate: '2026-01-06',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 2870, basePay: 2870,
      taxWithheld: 566, employeeDeductionsTotal: 566,
      netPay: 2304,
      ytdGross: 75217.63, ytdTax: 18455, ytdNet: 56762.63,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'stated_on_document',
      forbiddenWarnings: ['column_mapping_ambiguous'],
      proves: 'non-money columns are recognised and skipped positionally (defect 3)',
    },
  },

  // =========================================================================
  // PL-04 — YEAR-TO-DATE SUMMARY SECTION.
  //
  // THE PRODUCTION SHAPE. A money-free "Year To Date" line is a SECTION
  // HEADING here, not a column header. Before the fix that line was read as
  // proof of a two-column layout, and every row beneath it was taken as the
  // CURRENT period — which is how a year-to-date total became `base_pay`.
  // =========================================================================
  {
    id: 'PL-04',
    description: 'A "Year To Date" SUMMARY SECTION — its rows are year-to-date, never this period',
    // ORACLE ARITHMETIC (by hand):
    //   period earnings   2,870.00 ; period deductions 566.00
    //   expected net = 2,304.00 = stated -> RECONCILED, variance 0
    //   The YTD block discloses gross 75,217.63 and tax 18,455.00 — both are
    //   YEAR-TO-DATE evidence and must appear in ytd_* only.
    text: `Payslip
Northwind Services Pty Ltd
ABN 11 222 333 444
Employee: A Person
Pay Period: 22/12/2025 - 04/01/2026
Payment Date: 06/01/2026

Payments                    Amount
Ordinary Hours            2,870.00
Total Payments            2,870.00

Deductions
PAYG Withholding            566.00
Total Deductions            566.00

Net Pay                   2,304.00

Year To Date
Gross Payments           75,217.63
PAYG Withholding         18,455.00`,
    parseOptions: { declaredCountry: 'AU', declaredCurrency: 'AUD' },
    expected: {
      ...AU_META,
      payPeriodStart: '2025-12-22', payPeriodEnd: '2026-01-04', paymentDate: '2026-01-06',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 2870, basePay: 2870,
      taxWithheld: 566, employeeDeductionsTotal: 566,
      netPay: 2304,
      ytdGross: 75217.63, ytdTax: 18455,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'ytd_present_no_header',
      grossPaySource: 'stated_on_document',
      requiredWarnings: ['column_header_not_identified'],
      proves: 'a YTD section heading is not a column header (defect 1 — the production shape)',
    },
  },

  // =========================================================================
  // PL-05 — YTD-ONLY DOCUMENT.
  // Nothing about this pay period is disclosed. The correct answer is to say
  // so: no period figures, no derived gross, INSUFFICIENT_DATA.
  // =========================================================================
  {
    id: 'PL-05',
    description: 'Year-to-date figures ONLY — no period figure may be manufactured from them',
    // ORACLE: the document discloses no current-period net at all, so the
    // gross-to-net identity cannot be evaluated: INSUFFICIENT_DATA, variance
    // null. Every period money field must be absent (NOT zero).
    text: `Payslip
Employer: Northwind Services Pty Ltd
Employee: A Person
Pay Period: 22/12/2025 - 04/01/2026
Payment Date: 06/01/2026

Year to Date
Gross Payments           75,217.63
PAYG Withholding         18,455.00
Net Pay                  56,762.63`,
    parseOptions: { declaredCountry: 'AU', declaredCurrency: 'AUD' },
    expected: {
      ...AU_META,
      employerName: 'Northwind Services Pty Ltd',
      payPeriodStart: '2025-12-22', payPeriodEnd: '2026-01-04', paymentDate: '2026-01-06',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      ytdGross: 75217.63, ytdTax: 18455, ytdNet: 56762.63,
      reconciliationStatus: 'insufficient_data', reconciliationVariance: null,
    },
    layout: {
      columnPlanSource: 'ytd_present_no_header',
      grossPaySource: null,
      requiredWarnings: ['gross_not_stated_on_document'],
      proves: 'a YTD-only payslip yields NO period figures and NO invented gross',
    },
  },

  // =========================================================================
  // PL-06 — PERIOD-ONLY DOCUMENT (no YTD anywhere).
  // =========================================================================
  {
    id: 'PL-06',
    description: 'No year-to-date column anywhere — every amount is this period',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 3,000.00 ; deductions 700.00
    //   expected net = 2,300.00 = stated -> RECONCILED, variance 0
    text: `Payslip
Employer: Coastal Trades Pty Ltd
Employee: M Brown
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 31/08/2026

Description                 Amount
Ordinary Hours            3,000.00
Total Payments            3,000.00
PAYG Withholding            700.00
Total Deductions            700.00
Net Pay                   2,300.00
Employer Superannuation     345.00`,
    expected: {
      ...AU_META,
      employerName: 'Coastal Trades Pty Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-08-31',
      payFrequency: 'monthly', payFrequencySource: 'derived_from_period',
      grossPay: 3000, basePay: 3000,
      taxWithheld: 700, employeeDeductionsTotal: 700,
      employerRetirementContribution: 345,
      netPay: 2300,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'current_only',
      grossPaySource: 'stated_on_document',
      forbiddenWarnings: ['column_mapping_ambiguous', 'column_header_not_identified'],
      proves: 'a single-column payslip never acquires year-to-date figures',
    },
  },

  // =========================================================================
  // PL-07 — NEGATIVE (retro reversal) AND ZERO.
  // A zero that the document PRINTS must be kept as 0; a field the document
  // omits must stay absent. The two are never collapsed.
  // =========================================================================
  {
    id: 'PL-07',
    description: 'A negative retro adjustment and a printed zero — neither is discarded or invented',
    // ORACLE ARITHMETIC (by hand):
    //   earnings 3,000.00 + (-500.00) + 0.00                 = 2,500.00
    //   deductions                                            =   600.00
    //   expected net = 2,500.00 - 600.00                      = 1,900.00
    //   stated net                                             = 1,900.00 -> RECONCILED
    //   base = 3,000.00 + (-500.00) = 2,500.00 ; overtime = 0.00 (printed)
    //   allowances: not printed at all -> must stay ABSENT, not 0
    text: `Payslip
Employer: Redgum Manufacturing Pty Ltd
Employee: S Patel
Pay Period: 03/08/2026 - 16/08/2026
Payment Date: 17/08/2026

Description                  This Pay      Year to Date
Ordinary Hours               3,000.00          9,000.00
Ordinary Hours Adjustment     -500.00           -500.00
Overtime                         0.00            120.00
Total Payments               2,500.00          8,500.00
PAYG Withholding               600.00          1,800.00
Total Deductions               600.00
Net Pay                      1,900.00          6,700.00`,
    expected: {
      ...AU_META,
      employerName: 'Redgum Manufacturing Pty Ltd',
      payPeriodStart: '2026-08-03', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-17',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 2500, basePay: 2500, overtimePay: 0,
      taxWithheld: 600, employeeDeductionsTotal: 600,
      netPay: 1900,
      ytdGross: 8500, ytdTax: 1800, ytdNet: 6700,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'stated_on_document',
      proves: 'signed reversals survive, a printed 0 stays 0, and an omitted field stays absent',
    },
  },

  // =========================================================================
  // PL-08 — DELIBERATELY INCONSISTENT. MUST land in `variance`.
  // The safety net that caught the production defect is not allowed to be
  // quieted by any of this work.
  // =========================================================================
  {
    id: 'PL-08',
    description: 'An internally inconsistent payslip MUST still be reported as a variance, never silently fixed',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  4,000.00 + 150.00                          = 4,150.00
    //   deductions 1,100.00 + 25.00                          = 1,125.00
    //   expected net = 4,150.00 - 1,125.00                   = 3,025.00
    //   stated net                                            = 3,000.00
    //   variance = expected - actual = 3,025.00 - 3,000.00   =    25.00 -> VARIANCE
    text: `Payslip
Employer: Acme Engineering Pty Ltd
Employee: Jane Citizen
Pay Period: 03/08/2026 - 16/08/2026
Payment Date: 17/08/2026

Description               This Pay      Year to Date
Ordinary Hours            4,000.00         12,000.00
Site Allowance              150.00            450.00
Total Payments            4,150.00         12,450.00
PAYG Withholding          1,100.00          3,300.00
Union Fees                   25.00             75.00
Total Deductions          1,125.00
Net Pay                   3,000.00          9,000.00`,
    expected: {
      ...AU_META,
      employerName: 'Acme Engineering Pty Ltd',
      payPeriodStart: '2026-08-03', payPeriodEnd: '2026-08-16', paymentDate: '2026-08-17',
      payFrequency: 'fortnightly', payFrequencySource: 'derived_from_period',
      grossPay: 4150, basePay: 4000, allowancesTotal: 150,
      taxWithheld: 1100, employeeDeductionsTotal: 1125,
      netPay: 3000,
      ytdGross: 12450, ytdTax: 3300, ytdNet: 9000,
      reconciliationStatus: 'variance', reconciliationVariance: 25,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'stated_on_document',
      proves: 'the gross-to-net variance safety net still fires on a document that does not add up',
    },
  },

  // =========================================================================
  // PL-09 — GROSS NOT STATED, AND THE COMPONENTS DO NOT PROVE ONE.
  // The gross must stay ABSENT. Missing is not zero, and it is not a guess.
  // =========================================================================
  {
    id: 'PL-09',
    description: 'No gross line and inconsistent components — gross must stay absent, never derived',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  1,200.00 + 850.00                          = 2,050.00
    //   deductions                                            =   410.00
    //   expected net = 2,050.00 - 410.00                     = 1,640.00
    //   stated net                                            = 1,600.00
    //   variance = 1,640.00 - 1,600.00                       =    40.00 -> VARIANCE
    //   The identity FAILS, so no gross may be derived: grossPay absent.
    text: `Payslip
Employer: Bright Realty Pty Ltd
Employee: Jane Citizen
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 02/09/2026

Description               This Pay      Year to Date
Base Salary               1,200.00          3,600.00
Commission                  850.00          2,300.00
PAYG Withholding            410.00          1,180.00
Net Pay                   1,600.00          4,720.00`,
    expected: {
      ...AU_META,
      employerName: 'Bright Realty Pty Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-09-02',
      payFrequency: 'monthly', payFrequencySource: 'derived_from_period',
      basePay: 1200, commissionPay: 850,
      taxWithheld: 410,
      netPay: 1600,
      ytdTax: 1180, ytdNet: 4720,
      reconciliationStatus: 'variance', reconciliationVariance: 40,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: null,
      requiredWarnings: ['gross_not_stated_on_document'],
      proves: 'a gross that cannot be proved from the document is left absent, not fabricated',
    },
  },

  // =========================================================================
  // PL-10 — GROSS NOT STATED, BUT THE COMPONENTS PROVE IT EXACTLY.
  // Derivation is allowed here — and is labelled as a derivation, so it can
  // never be mistaken downstream for a figure the employer printed.
  // =========================================================================
  {
    id: 'PL-10',
    description: 'No gross line, but the payslip’s own lines reproduce its own net exactly — derive, and say so',
    // ORACLE ARITHMETIC (by hand):
    //   earnings  1,200.00 + 850.00                          = 2,050.00
    //   deductions                                            =   410.00
    //   expected net = 2,050.00 - 410.00                     = 1,640.00
    //   stated net                                            = 1,640.00 -> RECONCILED
    //   identity HOLDS exactly, so grossPay = 2,050.00, flagged as derived.
    text: `Payslip
Employer: Bright Realty Pty Ltd
Employee: Jane Citizen
Pay Period: 01/08/2026 - 31/08/2026
Payment Date: 02/09/2026

Description               This Pay      Year to Date
Base Salary               1,200.00          3,600.00
Commission                  850.00          2,300.00
PAYG Withholding            410.00          1,180.00
Net Pay                   1,640.00          4,720.00`,
    expected: {
      ...AU_META,
      employerName: 'Bright Realty Pty Ltd',
      payPeriodStart: '2026-08-01', payPeriodEnd: '2026-08-31', paymentDate: '2026-09-02',
      payFrequency: 'monthly', payFrequencySource: 'derived_from_period',
      grossPay: 2050, basePay: 1200, commissionPay: 850,
      taxWithheld: 410,
      netPay: 1640,
      ytdTax: 1180, ytdNet: 4720,
      reconciliationStatus: 'reconciled', reconciliationVariance: 0,
    },
    layout: {
      columnPlanSource: 'header',
      grossPaySource: 'derived_from_components',
      requiredWarnings: ['gross_derived_from_components'],
      proves: 'a derivable gross is derived from the document’s own arithmetic and labelled as derived',
    },
  },
];
