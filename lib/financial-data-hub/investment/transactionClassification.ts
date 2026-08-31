/**
 * FDH-11 — statement transaction type classification (spec section 25) and
 * the highest-risk financial-integrity rules (spec sections 26-31, 98-102).
 *
 * THIS is the file that proves the mandatory negative controls: a BUY is
 * never an expense, a SELL is never ordinary income, a bank<->broker
 * transfer is never expense/income, and a dividend evidenced twice (broker +
 * bank) is one income event, never two. It does this structurally, not by
 * hoping a caller remembers: `classifyAuStatementLine` returns a
 * `financialTreatment` enum that has NO 'expense'/'ordinary_income' member at
 * all for investment-side activity — there is no value this function can
 * return that a caller could misinterpret as "count this in the household
 * expense/income total".
 */

import type { AuStatementTransactionType } from './types';

/** The economic TREATMENT of a statement transaction line — deliberately NOT
 * `fdh_transactions.economic_transaction_type` (spec section 26-27: an
 * investment buy/sell must never even be representable as 'expense'/'income'
 * in this module's own vocabulary, let alone written as one). */
export type InvestmentFinancialTreatment =
  | 'investment_acquisition' // BUY, TRANSFER_IN, DRP reinvestment leg
  | 'investment_disposal' // SELL
  | 'investment_income' // DIVIDEND, DISTRIBUTION, INTEREST
  | 'cash_transfer' // bank<->broker movement, TRANSFER_IN/OUT of cash
  | 'trade_cost' // BROKERAGE, FEE — canonical treatment decided by II, not here (spec section 32)
  | 'tax_evidence' // withholding/franking — evidence only (spec section 33)
  | 'corporate_action_evidence' // spec sections 37-38 — never auto-applied
  | 'unclassified';

export interface ClassificationOutcome {
  treatment: InvestmentFinancialTreatment;
  /** True when this line's amount must NEVER be summed into the household
   * ordinary expense or ordinary income totals (FDH-8 boundary, spec section
   * 72). Always true for every treatment above — kept as an explicit,
   * independently-assertable field so a caller/test can check it without
   * having to enumerate the treatment union itself. */
  excludedFromOrdinaryExpenseIncome: true;
  reviewRequired: boolean;
  reason: string;
}

const TREATMENT_BY_TYPE: Record<AuStatementTransactionType, InvestmentFinancialTreatment> = {
  BUY: 'investment_acquisition',
  SELL: 'investment_disposal',
  DIVIDEND: 'investment_income',
  DISTRIBUTION: 'investment_income',
  INTEREST: 'investment_income',
  BROKERAGE: 'trade_cost',
  FEE: 'trade_cost',
  TRANSFER_IN: 'cash_transfer',
  TRANSFER_OUT: 'cash_transfer',
  CASH_DEPOSIT: 'cash_transfer',
  CASH_WITHDRAWAL: 'cash_transfer',
  DRP: 'investment_acquisition',
  CORPORATE_ACTION_EVIDENCE: 'corporate_action_evidence',
  OTHER: 'unclassified',
  UNKNOWN: 'unclassified',
};

/**
 * Classify one statement transaction line. This function is PURE and always
 * returns `excludedFromOrdinaryExpenseIncome: true` — the mandatory negative
 * controls (spec sections 98-102) assert this literally, so a future edit
 * that tried to add an 'expense'/'income' branch here would have to also
 * delete or falsify that literal `true`, which is a conscious, visible act,
 * not an accidental regression.
 */
export function classifyAuStatementLine(transactionType: AuStatementTransactionType): ClassificationOutcome {
  const treatment = TREATMENT_BY_TYPE[transactionType];
  const reviewRequired = treatment === 'unclassified' || treatment === 'corporate_action_evidence';
  return {
    treatment,
    excludedFromOrdinaryExpenseIncome: true,
    reviewRequired,
    reason:
      treatment === 'unclassified'
        ? `Statement transaction type "${transactionType}" could not be classified — routed to review, never guessed.`
        : treatment === 'corporate_action_evidence'
          ? 'Corporate-action evidence is never auto-applied (spec section 38) — routed to review.'
          : `"${transactionType}" classifies as ${treatment}.`,
  };
}

/**
 * Spec section 30 — dividend double-count guard. Given a broker-statement
 * dividend amount and an optional matched bank-credit amount for the SAME
 * economic event, returns the single investment-income amount to record.
 * Never sums the two — they are two pieces of evidence for one event.
 */
export function reconcileDividendIncome(brokerAmount: string, bankMatchedAmount: string | null): {
  investmentIncomeAmount: string;
  evidenceCount: number;
} {
  // Two evidence sources for the same event never produce 2x income — the
  // broker-statement figure is the canonical evidence amount; a matched bank
  // credit corroborates it (or would open a variance case if it differed —
  // that comparison is the caller's job, this function's job is only to
  // prove the amount is never doubled).
  return {
    investmentIncomeAmount: brokerAmount,
    evidenceCount: bankMatchedAmount === null ? 1 : 2,
  };
}
