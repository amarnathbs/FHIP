/**
 * LR-6 — pure-function tests for SMSF P&L, cash flow, contributions,
 * reporting period and CSV export. No database — these exercise the exact
 * engines app/api/smsf/[id]/report and .../export call.
 */
import { describe, expect, it } from 'vitest';
import { computeSmsfPnl } from '@/lib/engines/smsf/smsfPnl';
import { computeSmsfCashFlow } from '@/lib/engines/smsf/smsfCashFlow';
import { computeSmsfContributions } from '@/lib/engines/smsf/smsfContributions';
import {
  australianFinancialYearFor,
  periodLengthMonths,
  recentSmsfFinancialYears,
} from '@/lib/engines/smsf/smsfReportingPeriod';
import { csvSafeLabel, buildSmsfAccountantExportCsv } from '@/lib/services/smsfExport';
import type { SmsfFundReportBundle } from '@/lib/services/smsfReportData';

const income = [{ amount: 2000, frequency: 'monthly' as const, master_item_key: 'smsf_rent', owner: 'smsf' }];
const propertyLoan = [
  {
    balance: 300000,
    interest_rate: 6, // 6% p.a.
    monthly_repayment: 2000,
    debt_type: 'mortgage',
    master_item_key: 'smsf_property_loan',
  },
];

describe('computeSmsfPnl', () => {
  it('sums operating income and expense-item rows at their monthly rate', () => {
    const expenses = [{ amount: 500, frequency: 'monthly' as const, master_item_key: 'smsf_audit_fee', expense_category: 'other' }];
    const result = computeSmsfPnl({ incomeRows: income, expenseRows: expenses, propertyLoanLiabilities: [] });
    expect(result.operatingIncomeMonthly).toBe(2000);
    expect(result.operatingExpenseItemsMonthly).toBe(500);
    expect(result.estimatedLoanInterestMonthly).toBe(0);
    expect(result.netOperatingResultMonthly).toBe(1500);
  });

  it('NEG-02 — never treats loan principal as an operating expense; only the estimated interest portion enters operating expenses', () => {
    const result = computeSmsfPnl({ incomeRows: income, expenseRows: [], propertyLoanLiabilities: propertyLoan });
    // monthly rate = 6%/12 * 300000 = 1500; full repayment is 2000, so
    // principal (500) must NOT appear anywhere in operatingExpensesMonthly.
    expect(result.estimatedLoanInterestMonthly).toBeCloseTo(1500, 5);
    expect(result.operatingExpensesMonthly).toBeCloseTo(1500, 5);
    expect(result.operatingExpensesMonthly).not.toBeCloseTo(2000, 5);
  });

  it('a repayment expense row for a serviced family is excluded from operating expenses (reuses the certified debt-service dedup, not a second rule)', () => {
    const duplicateRepaymentExpense = [{ amount: 2000, frequency: 'monthly' as const, master_item_key: 'mortgage', expense_category: 'debt_repayment' }];
    const withDup = computeSmsfPnl({ incomeRows: [], expenseRows: duplicateRepaymentExpense, propertyLoanLiabilities: propertyLoan });
    expect(withDup.operatingExpenseItemsMonthly).toBe(0);
  });

  it('capital movements are always reported as not-modelled, never a fabricated non-zero figure', () => {
    const result = computeSmsfPnl({ incomeRows: [], expenseRows: [], propertyLoanLiabilities: [] });
    expect(result.capitalMovementsMonthly).toBe(0);
    expect(result.capitalMovementsModelled).toBe(false);
  });
});

describe('computeSmsfCashFlow', () => {
  it('shows the FULL loan repayment as debt service (cash-flow relevant), distinct from P&L\'s interest-only figure', () => {
    const result = computeSmsfCashFlow({
      incomeRows: income,
      expenseRows: [],
      propertyLoanLiabilities: propertyLoan,
      contributionsMonthly: 0,
    });
    expect(result.outflows.debtServiceMonthly).toBe(2000); // full repayment, not the ~1500 interest-only P&L figure
    expect(result.debtServiceBreakdown.estimatedPrincipalMonthly).toBeCloseTo(500, 5);
  });

  it('includes contributions in inflow, separate from operating income (PO lock: funding flow, not revenue)', () => {
    const result = computeSmsfCashFlow({ incomeRows: income, expenseRows: [], propertyLoanLiabilities: [], contributionsMonthly: 1000 });
    expect(result.inflows.contributionsMonthly).toBe(1000);
    expect(result.inflows.totalMonthly).toBe(3000);
  });
});

describe('computeSmsfContributions', () => {
  it('normalises employer/personal contributions to a monthly rate and never fabricates spouse/rollover data', () => {
    const result = computeSmsfContributions({ employer_contribution: 1200, personal_contribution: 300, contribution_frequency: 'quarterly' });
    expect(result.employerContributionMonthly).toBeCloseTo(400, 5);
    expect(result.personalContributionMonthly).toBeCloseTo(100, 5);
    expect(result.spouseAndRolloverNotModelled).toBe(true);
  });

  it('treats null contribution columns as zero rather than throwing (the incidental pre-LR-6 state for every SMSF fund)', () => {
    const result = computeSmsfContributions({ employer_contribution: null, personal_contribution: null, contribution_frequency: null });
    expect(result.totalContributionMonthly).toBe(0);
  });
});

describe('smsfReportingPeriod', () => {
  it('places 30 June in the FY that ends that day, and 1 July in the FY that starts that day', () => {
    const juneEnd = australianFinancialYearFor(new Date(Date.UTC(2026, 5, 30)));
    const julyStart = australianFinancialYearFor(new Date(Date.UTC(2026, 6, 1)));
    expect(juneEnd.label).toBe('FY2025-26');
    expect(julyStart.label).toBe('FY2026-27');
  });

  it('a financial year spans exactly 12 months', () => {
    const fy = australianFinancialYearFor(new Date(Date.UTC(2026, 0, 1)));
    expect(periodLengthMonths(fy)).toBe(12);
  });

  it('recentSmsfFinancialYears returns the requested count, newest first, with no gaps', () => {
    const years = recentSmsfFinancialYears(3, new Date(Date.UTC(2026, 8, 8)));
    expect(years.map((y) => y.label)).toEqual(['FY2026-27', 'FY2025-26', 'FY2024-25']);
  });
});

describe('csvSafeLabel — CSV formula-injection protection', () => {
  it('prefixes a label starting with =, +, @ or a tab/CR with a leading quote', () => {
    expect(csvSafeLabel('=CMD(calc)')).toBe("'=CMD(calc)");
    expect(csvSafeLabel('+1234')).toBe("'+1234");
    expect(csvSafeLabel('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('also guards a label starting with a bare hyphen, since a label field is free text, not a numeric field', () => {
    expect(csvSafeLabel('-DDE(...)')).toBe("'-DDE(...)");
  });

  it('leaves an ordinary label untouched', () => {
    expect(csvSafeLabel('My SMSF Fund')).toBe('My SMSF Fund');
  });
});

describe('buildSmsfAccountantExportCsv — WP-09: never corrupts a legitimate negative number', () => {
  const period = australianFinancialYearFor(new Date(Date.UTC(2026, 8, 8)));
  const bundle: SmsfFundReportBundle = {
    fund: { id: 'fund-1', fund_name: 'Test Fund', mode: 'summary', currency_code: 'AUD', retirement_account_id: 'ra-1' },
    pnl: {
      operatingIncomeMonthly: 500,
      operatingExpenseItemsMonthly: 200,
      estimatedLoanInterestMonthly: 1800,
      operatingExpensesMonthly: 2000,
      netOperatingResultMonthly: -1500, // legitimate negative operating result
      capitalMovementsMonthly: 0,
      capitalMovementsModelled: false,
    },
    cashFlow: {
      inflows: { operatingIncomeMonthly: 500, contributionsMonthly: 0, totalMonthly: 500 },
      outflows: { operatingExpenseItemsMonthly: 200, debtServiceMonthly: 2000, totalMonthly: 2200 },
      netCashFlowMonthly: -1700,
      debtServiceBreakdown: { estimatedInterestMonthly: 1800, estimatedPrincipalMonthly: 200 },
    },
    contributions: { employerContributionMonthly: 0, personalContributionMonthly: 0, totalContributionMonthly: 0, spouseAndRolloverNotModelled: true },
    reconciliation: { detailedNetValue: null, summaryBalance: null, variance: null },
    provenance: { activeHoldingCount: 0, activeMemberCount: 1, generatedAt: '2026-09-08T00:00:00.000Z' },
  };

  it('renders a negative net result as a plain numeric field, never quote-prefixed', () => {
    const csv = buildSmsfAccountantExportCsv(bundle, period);
    expect(csv).toContain('Net operating result,-1500');
    expect(csv).not.toContain("'-1500");
  });

  it('still escapes the fund name if it happens to start with a formula-injection character', () => {
    const dangerousBundle: SmsfFundReportBundle = { ...bundle, fund: { ...bundle.fund, fund_name: '=HYPERLINK("http://evil")' } };
    const csv = buildSmsfAccountantExportCsv(dangerousBundle, period);
    expect(csv).toContain("'=HYPERLINK");
  });

  it('never shows a raw balance-reconciliation variance for a fund with no Detailed Holdings yet — matches the UI\'s own honest framing (NEG-04)', () => {
    // reconciliation.variance is populated (-120000, say) even before Detailed
    // Holdings exists — smsf_compute_detailed_net_value() legitimately
    // returns 0 for a fund with zero holdings, which would otherwise render
    // as an alarming, misleading "variance" for a fund the app itself treats
    // as complete in Summary Mode alone.
    const zeroHoldingsBundle: SmsfFundReportBundle = {
      ...bundle,
      reconciliation: { detailedNetValue: 0, summaryBalance: 120000, variance: -120000 },
      provenance: { ...bundle.provenance, activeHoldingCount: 0 },
    };
    const csv = buildSmsfAccountantExportCsv(zeroHoldingsBundle, period);
    expect(csv).not.toContain('-120000');
    expect(csv.toLowerCase()).toContain('not been set up');
  });

  it('shows the real variance once Detailed Holdings has at least one active holding', () => {
    const withHoldingsBundle: SmsfFundReportBundle = {
      ...bundle,
      reconciliation: { detailedNetValue: 0, summaryBalance: 120000, variance: -120000 },
      provenance: { ...bundle.provenance, activeHoldingCount: 1 },
    };
    const csv = buildSmsfAccountantExportCsv(withHoldingsBundle, period);
    expect(csv).toContain('Variance,-120000');
  });
});
