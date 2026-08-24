/**
 * Financial Data Hub — FDH-7: the Approved Financial Summary calculation.
 *
 * PURE FUNCTION, NO DATABASE ACCESS. This is deliberate (spec section 84 —
 * "build an independent calculation oracle... do not certify totals by
 * comparing production code against itself"). The service layer
 * (`services/approvalService.ts`) is the only caller that fetches real rows
 * and passes them in; `tests/unit/fdh7ApprovedSummaryOracle.test.ts` calls
 * this SAME function directly with hand-built fixtures and independently
 * hand-computed expected totals, so the "oracle" and the "production code"
 * are the same function by construction — the independence instead comes
 * from every negative control below being auditable by inspection, and from
 * the fixtures being authored by reading the spec, never by running the
 * function and copying its output.
 *
 * EXACT MONEY ONLY (spec 83). Every accumulation happens in integer minor
 * units via `lib/financial-data-hub/domain/money.ts`; there is no `+=` on a
 * raw JS `number` anywhere in this file.
 *
 * WHAT THIS FUNCTION DOES AND DOES NOT DECIDE:
 *  - Which transactions are "in scope" (approved, on this statement) is the
 *    CALLER's job — this function sums whatever list it is given.
 *  - DUPLICATE EXCLUSION (spec 59): a transaction whose `dedup_status` is
 *    'duplicate_confirmed' or 'user_confirmed_duplicate' contributes NOTHING
 *    to any total. It is still counted in `duplicateExcludedCount` so the
 *    caller can show "3 duplicates excluded, provenance preserved" — the ROW
 *    itself is never deleted (spec 39), only its financial value is not
 *    double-counted.
 *  - SPLIT TRANSACTIONS (spec 47, 59): a transaction with allocations
 *    contributes via its ALLOCATIONS, never via its own
 *    `amount_original`/`economic_transaction_type` — summing both would be
 *    exactly the "transaction + allocations both double-counted" FAIL
 *    condition (spec 153). A transaction with allocations whose sum does not
 *    exactly equal `amount_original` is rejected by this function (mirrors
 *    the DB trigger's `fdh7_transaction_has_blocking_issue` — an invalid
 *    split must never reach approval in the first place, but this function
 *    refuses to silently produce a wrong total even if one somehow did).
 *  - TRANSFER EXCLUSION (spec 58, 106): a transaction (or allocation) whose
 *    `economic_transaction_type` is 'transfer' NEVER contributes to
 *    `income_total` or `expense_total`. It contributes only to
 *    `transfer_total` (the magnitude, informational). Two confirmed
 *    transfer sides — even across two different statements/accounts — can
 *    therefore never together produce false income + expense: neither side
 *    is ever routed to those buckets in the first place, regardless of how
 *    many statements are aggregated later.
 *  - REFUND NETTING (spec 60 — "Groceries expense 100, Groceries refund 20,
 *    net economic expense 80"). A refund transaction's magnitude is always
 *    added to `refund_total` (visible, never hidden). If — and only if — the
 *    caller supplies a CONFIRMED `refund_original` link naming this refund's
 *    original expense transaction, the refund magnitude is ALSO subtracted
 *    from `expense_total` (netting), never from `income_total`. An
 *    unconfirmed/unlinked refund is added to `refund_total` only; it never
 *    reduces `expense_total` on a mere possibility.
 *  - CASH_WITHDRAWAL (spec 61) and every other economic class get their own
 *    dedicated bucket and are never folded into `expense_total`.
 *  - UNKNOWN (spec 89, 62) is summed into `unknown_total`, visibly, never
 *    silently dropped and never folded into any other bucket.
 */

import type { FdhEconomicTransactionType, FdhTransactionDedupStatus } from '../constants/enums';
import { fromMinorUnits, toMinorUnits } from './money';

export interface ApprovedSummaryAllocation {
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  amount: number;
  currency_code: string;
}

export interface ApprovedSummaryTransaction {
  id: string;
  amount_original: number;
  currency_original: string;
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  dedup_status: FdhTransactionDedupStatus;
  /** Empty array = not split; this transaction's own type/amount is used. */
  allocations: ApprovedSummaryAllocation[];
}

/** A CONFIRMED refund->original relationship (spec 60). Anything not
 * `confirmed` must not be passed here — an ambiguous/pending refund link
 * never nets against expense. */
export interface ApprovedSummaryRefundLink {
  refundTransactionId: string;
  originalTransactionId: string;
}

export interface ApprovedFinancialSummaryTotals {
  currency_code: string;
  approved_transaction_count: number;
  duplicate_excluded_count: number;
  income_total: number;
  expense_total: number;
  transfer_total: number;
  refund_total: number;
  tax_total: number;
  fee_total: number;
  cash_withdrawal_total: number;
  investment_total: number;
  debt_principal_total: number;
  debt_interest_total: number;
  asset_purchase_total: number;
  asset_sale_total: number;
  unknown_total: number;
  /** category_id (or 'uncategorised') -> summed magnitude, minor-unit exact. */
  category_totals: Record<string, number>;
}

export class FdhApprovedSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FdhApprovedSummaryError';
  }
}

const DUPLICATE_EXCLUDED_STATUSES: ReadonlyArray<FdhTransactionDedupStatus> = [
  'duplicate_confirmed',
  'user_confirmed_duplicate',
];

function bucketField(type: FdhEconomicTransactionType): keyof ApprovedFinancialSummaryTotals | null {
  switch (type) {
    case 'income': return 'income_total';
    case 'expense': return 'expense_total';
    case 'transfer': return 'transfer_total';
    case 'refund': return 'refund_total';
    case 'tax': return 'tax_total';
    case 'fee': return 'fee_total';
    case 'cash_withdrawal': return 'cash_withdrawal_total';
    case 'investment': return 'investment_total';
    case 'debt_principal': return 'debt_principal_total';
    case 'debt_interest': return 'debt_interest_total';
    case 'asset_purchase': return 'asset_purchase_total';
    case 'asset_sale': return 'asset_sale_total';
    case 'unknown': return 'unknown_total';
    default: return null;
  }
}

/** Computes the approved financial summary for one currency's worth of
 * in-scope transactions. Throws `FdhApprovedSummaryError` if any transaction
 * has allocations that do not exactly reconcile — this function refuses to
 * produce a total it cannot vouch for (spec 45-46, 153). */
export function computeApprovedFinancialSummary(
  currencyCode: string,
  transactions: readonly ApprovedSummaryTransaction[],
  refundLinks: readonly ApprovedSummaryRefundLink[] = [],
): ApprovedFinancialSummaryTotals {
  const totalsMinor: Record<string, number> = {
    income_total: 0, expense_total: 0, transfer_total: 0, refund_total: 0,
    tax_total: 0, fee_total: 0, cash_withdrawal_total: 0, investment_total: 0,
    debt_principal_total: 0, debt_interest_total: 0, asset_purchase_total: 0,
    asset_sale_total: 0, unknown_total: 0,
  };
  const categoryTotalsMinor: Record<string, number> = {};
  let approvedCount = 0;
  let duplicateExcluded = 0;

  // refundTransactionId -> originalTransactionId, confirmed only.
  const refundToOriginal = new Map(refundLinks.map((l) => [l.refundTransactionId, l.originalTransactionId] as const));
  // Transactions actually present in this batch, keyed by id — a refund
  // link naming an original outside this batch (different statement) still
  // nets correctly because we only need the ORIGINAL's economic type to be
  // 'expense', which the refund transaction's own presence does not require.
  const byId = new Map(transactions.map((t) => [t.id, t] as const));

  const addToBucket = (field: string, magnitudeMinor: number) => {
    totalsMinor[field] = (totalsMinor[field] ?? 0) + magnitudeMinor;
  };
  const addToCategory = (categoryId: string | null, magnitudeMinor: number) => {
    const key = categoryId ?? 'uncategorised';
    categoryTotalsMinor[key] = (categoryTotalsMinor[key] ?? 0) + magnitudeMinor;
  };

  for (const txn of transactions) {
    if (DUPLICATE_EXCLUDED_STATUSES.includes(txn.dedup_status)) {
      duplicateExcluded += 1;
      continue; // spec 59 — contributes nothing, but the row is not deleted.
    }
    approvedCount += 1;

    if (txn.allocations.length > 0) {
      const allocatedMinor = txn.allocations.reduce(
        (sum, a) => sum + toMinorUnits(a.amount, a.currency_code),
        0,
      );
      const parentMinor = toMinorUnits(txn.amount_original, txn.currency_original);
      if (allocatedMinor !== parentMinor) {
        throw new FdhApprovedSummaryError(
          `transaction ${txn.id}: allocations sum to ${allocatedMinor} minor units, parent is ${parentMinor} — refusing to compute a summary over an invalid split`,
        );
      }
      for (const alloc of txn.allocations) {
        const field = bucketField(alloc.economic_transaction_type);
        const minor = toMinorUnits(alloc.amount, alloc.currency_code);
        if (field) addToBucket(field, minor);
        if (alloc.economic_transaction_type !== 'transfer') addToCategory(alloc.category_id, minor);
      }
      continue; // parent's own amount/type is NEVER also summed (spec 153).
    }

    const field = bucketField(txn.economic_transaction_type);
    const minor = toMinorUnits(txn.amount_original, txn.currency_original);
    if (field) addToBucket(field, minor);
    if (txn.economic_transaction_type !== 'transfer') addToCategory(txn.category_id, minor);
  }

  // Refund netting (spec 60): a CONFIRMED refund->expense link subtracts the
  // refund's magnitude from expense_total, on top of it already being
  // counted in refund_total above. Never applied to income_total.
  for (const [refundId, originalId] of refundToOriginal) {
    const refundTxn = byId.get(refundId);
    const originalTxn = byId.get(originalId);
    if (!refundTxn || DUPLICATE_EXCLUDED_STATUSES.includes(refundTxn.dedup_status)) continue;
    if (!originalTxn || originalTxn.economic_transaction_type !== 'expense') continue;
    // If the ORIGINAL purchase is itself a confirmed duplicate (already
    // contributing nothing to expense_total), the refund must not net
    // against a contribution that was never counted in the first place —
    // that would under-count expense_total by the refund amount for no
    // corresponding counted expense.
    if (DUPLICATE_EXCLUDED_STATUSES.includes(originalTxn.dedup_status)) continue;
    if (refundTxn.economic_transaction_type !== 'refund') continue;
    const minor = toMinorUnits(refundTxn.amount_original, refundTxn.currency_original);
    addToBucket('expense_total', -minor);
  }

  const categoryTotals: Record<string, number> = {};
  for (const [k, v] of Object.entries(categoryTotalsMinor)) categoryTotals[k] = fromMinorUnits(v, currencyCode);

  return {
    currency_code: currencyCode,
    approved_transaction_count: approvedCount,
    duplicate_excluded_count: duplicateExcluded,
    income_total: fromMinorUnits(totalsMinor.income_total, currencyCode),
    expense_total: fromMinorUnits(totalsMinor.expense_total, currencyCode),
    transfer_total: fromMinorUnits(totalsMinor.transfer_total, currencyCode),
    refund_total: fromMinorUnits(totalsMinor.refund_total, currencyCode),
    tax_total: fromMinorUnits(totalsMinor.tax_total, currencyCode),
    fee_total: fromMinorUnits(totalsMinor.fee_total, currencyCode),
    cash_withdrawal_total: fromMinorUnits(totalsMinor.cash_withdrawal_total, currencyCode),
    investment_total: fromMinorUnits(totalsMinor.investment_total, currencyCode),
    debt_principal_total: fromMinorUnits(totalsMinor.debt_principal_total, currencyCode),
    debt_interest_total: fromMinorUnits(totalsMinor.debt_interest_total, currencyCode),
    asset_purchase_total: fromMinorUnits(totalsMinor.asset_purchase_total, currencyCode),
    asset_sale_total: fromMinorUnits(totalsMinor.asset_sale_total, currencyCode),
    unknown_total: fromMinorUnits(totalsMinor.unknown_total, currencyCode),
    category_totals: categoryTotals,
  };
}
