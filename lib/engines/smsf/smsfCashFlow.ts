// ---------------------------------------------------------------------------
// LR-6 WP-03 — SMSF cash flow.
//
// Deliberately decomposes the SAME property-loan repayment differently from
// smsfPnl.ts's operating result, on purpose — that IS the separation this
// work package asks for: P&L excludes principal (it is not an operating
// cost), cash flow shows the FULL scheduled repayment because that is the
// real amount that leaves the fund's bank account each period (PO lock:
// "Full repayment remains cash-flow relevant"). This is standard operating-
// P&L-vs-cash-flow practice, not a double count, because the two figures are
// never summed together into one number anywhere in this module or its
// callers.
// ---------------------------------------------------------------------------

import { toMonthly } from '../money';
import { servicedDebtFamilies, isDuplicateDebtServiceExpense } from '../debtServiceContext';
import { estimatedMonthlyPrincipal, estimatedMonthlyInterest, type SmsfIncomeRow, type SmsfExpenseRow, type SmsfPropertyLoanLiability } from './smsfPnl';

export interface SmsfCashFlowInput {
  incomeRows: SmsfIncomeRow[];
  expenseRows: SmsfExpenseRow[];
  propertyLoanLiabilities: SmsfPropertyLoanLiability[];
  /** From the linked retirement_accounts row(s) — see smsfContributions.ts. */
  contributionsMonthly: number;
}

export interface SmsfCashFlowResult {
  inflows: {
    operatingIncomeMonthly: number;
    contributionsMonthly: number;
    totalMonthly: number;
  };
  outflows: {
    operatingExpenseItemsMonthly: number;
    /** The loan's full scheduled repayment (interest + principal combined) — a single cash event. */
    debtServiceMonthly: number;
    totalMonthly: number;
  };
  netCashFlowMonthly: number;
  /** Diagnostic split of debtServiceMonthly — informational only, never summed on top of debtServiceMonthly. */
  debtServiceBreakdown: {
    estimatedInterestMonthly: number;
    estimatedPrincipalMonthly: number;
  };
}

export function computeSmsfCashFlow(input: SmsfCashFlowInput): SmsfCashFlowResult {
  const serviced = servicedDebtFamilies(input.propertyLoanLiabilities);

  const operatingIncomeMonthly = input.incomeRows.reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);

  const operatingExpenseItemsMonthly = input.expenseRows
    .filter((row) => !isDuplicateDebtServiceExpense(row, serviced))
    .reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);

  const debtServiceMonthly = input.propertyLoanLiabilities.reduce((sum, l) => sum + (l.monthly_repayment ?? 0), 0);

  const estimatedInterestMonthly = input.propertyLoanLiabilities.reduce((sum, l) => sum + estimatedMonthlyInterest(l), 0);
  const estimatedPrincipalMonthly = input.propertyLoanLiabilities.reduce((sum, l) => sum + estimatedMonthlyPrincipal(l), 0);

  const totalInflow = operatingIncomeMonthly + input.contributionsMonthly;
  const totalOutflow = operatingExpenseItemsMonthly + debtServiceMonthly;

  return {
    inflows: {
      operatingIncomeMonthly,
      contributionsMonthly: input.contributionsMonthly,
      totalMonthly: totalInflow,
    },
    outflows: {
      operatingExpenseItemsMonthly,
      debtServiceMonthly,
      totalMonthly: totalOutflow,
    },
    netCashFlowMonthly: totalInflow - totalOutflow,
    debtServiceBreakdown: {
      estimatedInterestMonthly,
      estimatedPrincipalMonthly,
    },
  };
}
