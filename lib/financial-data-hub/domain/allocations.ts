/**
 * Financial Data Hub — split-transaction (allocation) integrity.
 *
 * The rule: when a transaction is FINALISED, its allocations must add up to
 * the transaction amount, to within one smallest currency unit.
 *
 * Why this is not a database constraint. Allocations are edited incrementally
 * — a user splitting a $180 supermarket debit adds one line at a time, and a
 * row-level constraint would reject every intermediate state, making a
 * half-entered split impossible to save. So completeness is enforced at the
 * moment of finalisation, not on every write, and drafts stay editable.
 *
 * What the database DOES enforce: each allocation amount is positive, the
 * sequence is unique per transaction, and the currency is a real currency.
 */

import type { FdhTransaction, FdhTransactionAllocation } from './types';
import { fromMinorUnits, smallestUnit, toMinorUnits } from './money';

export interface AllocationReconciliation {
  ok: boolean;
  /** Sum of the allocation amounts, in the transaction's currency. */
  allocatedTotal: number;
  /** The parent transaction's magnitude. */
  transactionTotal: number;
  /** transactionTotal - allocatedTotal. Positive means under-allocated. */
  difference: number;
  /** The tolerance applied, in currency units. */
  tolerance: number;
  reasons: AllocationProblem[];
}

export type AllocationProblem =
  | { code: 'no_allocations' }
  | { code: 'currency_mismatch'; expected: string; found: string; allocationSequence: number }
  | { code: 'non_positive_amount'; allocationSequence: number; amount: number }
  | { code: 'duplicate_sequence'; allocationSequence: number }
  | { code: 'over_allocated'; difference: number }
  | { code: 'under_allocated'; difference: number };

/**
 * Check that a set of allocations reconciles to its parent transaction.
 *
 * `toleranceUnits` is expressed in SMALLEST CURRENCY UNITS (cents, paise) and
 * defaults to 1, which absorbs a single rounding step when a user splits by
 * percentage. It is not a licence to be wrong by an arbitrary amount.
 */
export function checkAllocationsReconcile(
  transaction: Pick<FdhTransaction, 'amount_original' | 'currency_original'>,
  allocations: readonly Pick<
    FdhTransactionAllocation,
    'amount' | 'currency_code' | 'allocation_sequence'
  >[],
  toleranceUnits = 1,
): AllocationReconciliation {
  const currency = transaction.currency_original;
  const reasons: AllocationProblem[] = [];

  if (allocations.length === 0) {
    return {
      ok: false,
      allocatedTotal: 0,
      transactionTotal: transaction.amount_original,
      difference: transaction.amount_original,
      tolerance: smallestUnit(currency) * toleranceUnits,
      reasons: [{ code: 'no_allocations' }],
    };
  }

  const seen = new Set<number>();
  let allocatedMinor = 0;

  for (const allocation of allocations) {
    if (allocation.currency_code !== currency) {
      reasons.push({
        code: 'currency_mismatch',
        expected: currency,
        found: allocation.currency_code,
        allocationSequence: allocation.allocation_sequence,
      });
      // Do not add a foreign-currency amount into the running total: doing so
      // would produce a meaningless sum and could mask the real difference.
      continue;
    }
    if (!(allocation.amount > 0)) {
      reasons.push({
        code: 'non_positive_amount',
        allocationSequence: allocation.allocation_sequence,
        amount: allocation.amount,
      });
      continue;
    }
    if (seen.has(allocation.allocation_sequence)) {
      reasons.push({
        code: 'duplicate_sequence',
        allocationSequence: allocation.allocation_sequence,
      });
      continue;
    }
    seen.add(allocation.allocation_sequence);
    allocatedMinor += toMinorUnits(allocation.amount, currency);
  }

  const transactionMinor = toMinorUnits(transaction.amount_original, currency);
  const differenceMinor = transactionMinor - allocatedMinor;

  if (differenceMinor > toleranceUnits) {
    reasons.push({ code: 'under_allocated', difference: fromMinorUnits(differenceMinor, currency) });
  } else if (differenceMinor < -toleranceUnits) {
    reasons.push({ code: 'over_allocated', difference: fromMinorUnits(differenceMinor, currency) });
  }

  return {
    ok: reasons.length === 0,
    allocatedTotal: fromMinorUnits(allocatedMinor, currency),
    transactionTotal: transaction.amount_original,
    difference: fromMinorUnits(differenceMinor, currency),
    tolerance: smallestUnit(currency) * toleranceUnits,
    reasons,
  };
}

export class FdhAllocationIntegrityError extends Error {
  constructor(readonly result: AllocationReconciliation) {
    super(
      `FDH allocation integrity: ${result.reasons.map((r) => r.code).join(', ')} `
        + `(allocated ${result.allocatedTotal} of ${result.transactionTotal})`,
    );
    this.name = 'FdhAllocationIntegrityError';
  }
}

/** Throws unless the allocations reconcile. Call this at finalisation only. */
export function assertAllocationsReconcile(
  transaction: Pick<FdhTransaction, 'amount_original' | 'currency_original'>,
  allocations: readonly Pick<
    FdhTransactionAllocation,
    'amount' | 'currency_code' | 'allocation_sequence'
  >[],
  toleranceUnits = 1,
): void {
  const result = checkAllocationsReconcile(transaction, allocations, toleranceUnits);
  if (!result.ok) throw new FdhAllocationIntegrityError(result);
}

/**
 * Whether a DRAFT set of allocations is acceptable. A draft may be incomplete
 * (that is the point) but must never be internally invalid: no negative
 * amounts, no duplicate sequences, no foreign currency, and never MORE than
 * the parent transaction.
 */
export function isValidAllocationDraft(
  transaction: Pick<FdhTransaction, 'amount_original' | 'currency_original'>,
  allocations: readonly Pick<
    FdhTransactionAllocation,
    'amount' | 'currency_code' | 'allocation_sequence'
  >[],
  toleranceUnits = 1,
): boolean {
  if (allocations.length === 0) return true;
  const result = checkAllocationsReconcile(transaction, allocations, toleranceUnits);
  return result.reasons.every((r) => r.code === 'under_allocated');
}
