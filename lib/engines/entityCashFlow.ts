/**
 * Entity cash flow (DOCUMENT2 (4) review, WP-C, F22 / F23 / F23b): the operating result and the cash flow of ONE entity (an SMSF fund or a
 * registered Company, Family Trust or HUF) from its OWN income and expense records and its OWN liabilities (migrations 0289, 0296, 0297).
 *
 * THE RULES (PO):
 *  - Entity cash flow is never in personal Income, Expenses, DTI or DSR. This module is only ever fed entity records.
 *  - Loan PRINCIPAL is cash flow, never an expense. The P&L carries estimated INTEREST only; the cash flow carries the full scheduled repayment
 *    once (interest and principal together). The two are never summed, so nothing is counted twice.
 *  - One economic flow, one record: callers pass each flow once (a moved legacy row is retired, a property has one rent record).
 *  - MISSING != ZERO: a row in a currency that cannot be converted is left out and counted in `unconvertedCount`, never zeroed silently.
 *
 * PURE: no I/O, no clock.
 */
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { convertToReportingCurrency, type SupportedCurrency } from '@/lib/engines/fx';

export interface EntityFlowRow {
  amount: number;
  frequency: Frequency;
  currency: string;
  /** income_type or expense_type, used to group the figures. */
  type: string;
}

export interface EntityLoanRow {
  balance: number;
  interestRatePercent: number | null;
  monthlyRepayment: number | null;
  currency: string;
}

export interface EntityCashFlowInput {
  /** The currency the figures are shown in (the entity currency). */
  currency: SupportedCurrency;
  fxRateAudInr: number;
  income: readonly EntityFlowRow[];
  expenses: readonly EntityFlowRow[];
  loans: readonly EntityLoanRow[];
  /** SMSF only: contributions are an inflow of the cash flow and never operating income. */
  contributionsMonthly?: number;
}

export interface EntityCashFlowResult {
  currency: SupportedCurrency;
  incomeMonthly: number;
  expensesMonthly: number;
  /** rate / 12 * balance across the loans, a disclosed estimate, not a ledger figure. */
  estimatedInterestMonthly: number;
  estimatedPrincipalMonthly: number;
  /** The loans' full scheduled repayment (interest and principal together). */
  debtServiceMonthly: number;
  /** income - expenses - estimated interest (principal is not an operating cost). */
  netOperatingResultMonthly: number;
  contributionsMonthly: number;
  /** income + contributions - expenses - the full repayment. */
  netCashFlowMonthly: number;
  incomeByType: Record<string, number>;
  expensesByType: Record<string, number>;
  unconvertedCount: number;
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const supported = (c: string): c is SupportedCurrency => c === 'AUD' || c === 'INR';

export function estimatedMonthlyInterest(l: Pick<EntityLoanRow, 'balance' | 'interestRatePercent'>): number {
  return Math.max(0, ((l.interestRatePercent ?? 0) / 100 / 12) * l.balance);
}

export function computeEntityCashFlow(input: EntityCashFlowInput): EntityCashFlowResult {
  let unconvertedCount = 0;
  const conv = (amount: number, currency: string): number | null => {
    if (!supported(currency)) return null;
    return convertToReportingCurrency(amount, currency, input.currency, input.fxRateAudInr);
  };

  const monthlyOf = (rows: readonly EntityFlowRow[]): { total: number; byType: Record<string, number> } => {
    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const m = conv(toMonthly(r.amount, r.frequency), r.currency);
      if (m === null) {
        unconvertedCount += 1;
        continue;
      }
      total += m;
      byType[r.type] = (byType[r.type] ?? 0) + m;
    }
    for (const k of Object.keys(byType)) byType[k] = cents(byType[k]);
    return { total, byType };
  };

  const income = monthlyOf(input.income);
  const expenses = monthlyOf(input.expenses);

  let interest = 0;
  let repayment = 0;
  for (const l of input.loans) {
    const i = conv(estimatedMonthlyInterest(l), l.currency);
    const r = conv(l.monthlyRepayment ?? 0, l.currency);
    if (i === null || r === null) {
      unconvertedCount += 1;
      continue;
    }
    interest += i;
    repayment += r;
  }
  const principal = Math.max(0, repayment - interest);
  const contributions = input.contributionsMonthly ?? 0;

  return {
    currency: input.currency,
    incomeMonthly: cents(income.total),
    expensesMonthly: cents(expenses.total),
    estimatedInterestMonthly: cents(interest),
    estimatedPrincipalMonthly: cents(principal),
    debtServiceMonthly: cents(repayment),
    netOperatingResultMonthly: cents(income.total - expenses.total - interest),
    contributionsMonthly: cents(contributions),
    netCashFlowMonthly: cents(income.total + contributions - expenses.total - repayment),
    incomeByType: income.byType,
    expensesByType: expenses.byType,
    unconvertedCount,
  };
}
