// ---------------------------------------------------------------------------
// LR-6 WP-02/WP-03 — SMSF P&L and cash flow.
//
// SOURCE DATA (deliberately reused, not duplicated):
//   - income_sources / expense_items rows tagged owner='smsf' are already a
//     real, live, canonical data source — LR-FI-1 (lib/engines/
//     householdContext.ts) already excludes them from household operating
//     cash flow; this module is the first place that AGGREGATES them, on the
//     SMSF side, into an operating result. No new table, no new column.
//   - The SMSF fund's own linked property loan (property_liability_links,
//     link_type='smsf_property_loan') supplies debt-service figures, reusing
//     the same certified debt-service classification LR-FI-2 built
//     (lib/engines/debtServiceContext.ts) — never a second, ad-hoc rule.
//   - toMonthly() (lib/engines/money.ts) is the same recurring-amount
//     normalisation every other engine in this codebase uses.
//
// WHAT THIS DELIBERATELY DOES NOT MODEL (real, disclosed data-model limits):
//   - Contributions/rollovers: reported separately (smsfContributions.ts),
//     never folded into operating income here — PO lock: "Contributions/
//     rollovers are funding flows, not ordinary operating revenue."
//   - Capital movements (asset purchase/sale gains): smsf_holdings has no
//     acquisition date or transaction history, only a current value
//     (confirmed by migration 0084's own column list) — there is no data to
//     compute a realised capital movement from, so this always reports 0
//     with an explicit "not modelled" flag rather than silently omitting the
//     line.
//   - Loan INTEREST is estimated from the liability's own interest_rate and
//     current balance (`rate/12 * balance`) — the exact monthly-rate formula
//     estimateMonthsToPayoff() (lib/engines/dashboard.ts) already uses for
//     amortisation, reused here rather than invented fresh. No certified
//     principal/interest amortisation schedule exists anywhere in this
//     codebase, so this is a disclosed estimate, not an exact ledger figure.
//   - Loan PRINCIPAL is never treated as an operating expense (PO lock,
//     NEG-02) — it is cash-flow relevant only (see computeSmsfCashFlow).
// ---------------------------------------------------------------------------

import { toMonthly, type Frequency } from '../money';
import type { IncomeRow, ExpenseRow, LiabilityRow } from '../dashboard';
import { servicedDebtFamilies, isDuplicateDebtServiceExpense, type ServicedDebtFamilies } from '../debtServiceContext';

/** Only the fields this engine actually reads — a test/caller does not need to fabricate an entire IncomeRow. */
export type SmsfIncomeRow = Pick<IncomeRow, 'amount' | 'frequency'>;
/** Only the fields this engine actually reads (plus the debt-service dedup discriminators). */
export type SmsfExpenseRow = Pick<ExpenseRow, 'amount' | 'frequency' | 'master_item_key' | 'expense_category'>;
export type SmsfPropertyLoanLiability = Pick<LiabilityRow, 'balance' | 'interest_rate' | 'monthly_repayment' | 'debt_type' | 'master_item_key'>;

export interface SmsfPnlInput {
  /** owner='smsf' income_sources rows for this household (see caller for fund-attribution scope). */
  incomeRows: SmsfIncomeRow[];
  /** owner='smsf' expense_items rows for this household. */
  expenseRows: SmsfExpenseRow[];
  /** The fund's linked property-loan liabilities (property_liability_links, link_type='smsf_property_loan'). */
  propertyLoanLiabilities: SmsfPropertyLoanLiability[];
}

export interface SmsfPnlResult {
  operatingIncomeMonthly: number;
  /** Expense-item outflows only (deduped against any serviced loan repayment) — excludes derived loan interest. */
  operatingExpenseItemsMonthly: number;
  /** rate/12 * balance across propertyLoanLiabilities — a disclosed estimate, not a ledger figure. */
  estimatedLoanInterestMonthly: number;
  /** operatingExpenseItemsMonthly + estimatedLoanInterestMonthly. */
  operatingExpensesMonthly: number;
  /** operatingIncomeMonthly - operatingExpensesMonthly. */
  netOperatingResultMonthly: number;
  /** Always 0 in this release — smsf_holdings carries no transaction history to compute a realised gain from. */
  capitalMovementsMonthly: 0;
  capitalMovementsModelled: false;
}

function sumMonthly(rows: { amount: number; frequency: Frequency }[]): number {
  return rows.reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);
}

function estimatedMonthlyInterest(l: Pick<SmsfPropertyLoanLiability, 'balance' | 'interest_rate'>): number {
  const monthlyRate = (l.interest_rate ?? 0) / 100 / 12;
  return Math.max(0, monthlyRate * l.balance);
}

export function computeSmsfPnl(input: SmsfPnlInput): SmsfPnlResult {
  const serviced: ServicedDebtFamilies = servicedDebtFamilies(input.propertyLoanLiabilities);

  const operatingIncomeMonthly = sumMonthly(input.incomeRows);

  const operatingExpenseItemsMonthly = input.expenseRows
    .filter((row) => !isDuplicateDebtServiceExpense(row, serviced))
    .reduce((sum, r) => sum + toMonthly(r.amount, r.frequency), 0);

  const estimatedLoanInterestMonthly = input.propertyLoanLiabilities.reduce(
    (sum, l) => sum + estimatedMonthlyInterest(l),
    0
  );

  const operatingExpensesMonthly = operatingExpenseItemsMonthly + estimatedLoanInterestMonthly;

  return {
    operatingIncomeMonthly,
    operatingExpenseItemsMonthly,
    estimatedLoanInterestMonthly,
    operatingExpensesMonthly,
    netOperatingResultMonthly: operatingIncomeMonthly - operatingExpensesMonthly,
    capitalMovementsMonthly: 0,
    capitalMovementsModelled: false,
  };
}

/** Exported for reuse by cash flow / export — the principal component of a loan's repayment (never an operating expense). */
export function estimatedMonthlyPrincipal(l: Pick<SmsfPropertyLoanLiability, 'balance' | 'interest_rate' | 'monthly_repayment'>): number {
  return Math.max(0, (l.monthly_repayment ?? 0) - estimatedMonthlyInterest(l));
}

export { estimatedMonthlyInterest };
