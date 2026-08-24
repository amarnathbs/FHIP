/**
 * FDH-7 — Transaction Split Workflow (spec sections 44-48).
 *
 * REUSES FDH-1's schema and domain validator wholesale: `fdh_transaction_
 * allocations` (migration 0047) and `domain/allocations.ts#
 * checkAllocationsReconcile()`/`isValidAllocationDraft()` (both already
 * shipped, unmodified). This file adds exactly the missing piece — the
 * WRITE path (create/replace a transaction's allocation set) — which no
 * prior phase implemented (confirmed by inspection: no API route or service
 * function anywhere in the tree wrote to `fdh_transaction_allocations`
 * before this file).
 *
 * REPLACE, NOT APPEND. Each call replaces the FULL allocation set for a
 * transaction (matches the product shape spec 44 describes: a user edits one
 * split, they are not layering a second unrelated split on top). The parent
 * transaction row itself is NEVER duplicated or altered by this — no
 * `amount_original`/`credit_debit` write happens here (spec 28).
 *
 * TRANSFER SPLIT GUARD (spec 48). Splitting a transaction that is currently
 * the CONFIRMED side of an internal transfer/settlement link into anything
 * other than 100% `transfer`-typed allocations is refused with a clear,
 * deterministic error — the transfer relationship must be rejected first.
 */

import { createClient } from '@/lib/supabase/server';
import {
  transactionAllocationsRepository,
  transactionLinksRepository,
  transactionsRepository,
} from '../repositories';
import { recordDocumentAuditEvent } from './auditLog';
import { assertAllocationsReconcile, isValidAllocationDraft, FdhAllocationIntegrityError } from '../domain/allocations';
import type { FdhTransactionSplitRequestInput } from '../validation/transactions';
import type { FdhTransaction, FdhTransactionAllocation } from '../domain/types';

export class TransactionSplitError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_split' | 'transfer_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TransactionSplitError';
  }
}

const TRANSFER_LINK_TYPES = ['internal_transfer', 'credit_card_settlement'] as const;

/** Creates or replaces the split allocations for one owned transaction. */
export async function splitTransaction(
  userId: string,
  transactionId: string,
  input: FdhTransactionSplitRequestInput,
): Promise<{ transaction: FdhTransaction; allocations: FdhTransactionAllocation[] }> {
  const { data: transaction } = await transactionsRepository.getForUser(userId, transactionId);
  if (!transaction) throw new TransactionSplitError('not_found', 'transaction not found');

  // Spec 48 — transfer split guard: a CONFIRMED transfer/settlement link
  // involving this transaction requires every allocation to also be typed
  // 'transfer', or the request is refused.
  const { data: links } = await transactionLinksRepository.listForUserAll(userId);
  const confirmedTransferLink = (links ?? []).find(
    (l) =>
      l.status === 'confirmed'
      && (TRANSFER_LINK_TYPES as readonly string[]).includes(l.link_type)
      && (l.transaction_id_from === transactionId || l.transaction_id_to === transactionId),
  );
  if (confirmedTransferLink && input.allocations.some((a) => a.economic_transaction_type !== 'transfer')) {
    throw new TransactionSplitError(
      'transfer_conflict',
      'this transaction is the confirmed side of a matched transfer — reject that transfer relationship before splitting it into non-transfer categories',
    );
  }

  const draftRows = input.allocations.map((a, i) => ({
    allocation_sequence: i + 1,
    amount: a.amount,
    currency_code: transaction.currency_original,
  }));

  if (input.finalize) {
    try {
      assertAllocationsReconcile(transaction, draftRows);
    } catch (e) {
      if (e instanceof FdhAllocationIntegrityError) {
        throw new TransactionSplitError(
          'invalid_split',
          `allocations do not reconcile to the transaction amount: allocated ${e.result.allocatedTotal}, expected ${e.result.transactionTotal} (difference ${e.result.difference})`,
        );
      }
      throw e;
    }
  } else if (!isValidAllocationDraft(transaction, draftRows)) {
    throw new TransactionSplitError(
      'invalid_split',
      'draft allocations are internally invalid (over-allocated, non-positive amount, or duplicate line)',
    );
  }

  // Replace: delete the existing set for THIS transaction, then insert the
  // new one. The delete is scoped by transaction_id AND user_id — an
  // ordinary RLS-scoped query, never the service-role client — so a caller
  // can only ever touch their own rows on their own transaction.
  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from('fdh_transaction_allocations')
    .delete()
    .eq('transaction_id', transactionId)
    .eq('user_id', userId);
  if (deleteError) {
    throw new TransactionSplitError('invalid_split', `could not clear the previous split: ${deleteError.message}`);
  }

  const created: FdhTransactionAllocation[] = [];
  for (const [i, a] of input.allocations.entries()) {
    const { data: row, error } = await transactionAllocationsRepository.create(userId, {
      transaction_id: transactionId,
      allocation_sequence: i + 1,
      economic_transaction_type: a.economic_transaction_type,
      category_id: a.category_id ?? null,
      subcategory_id: a.subcategory_id ?? null,
      amount: a.amount,
      currency_code: transaction.currency_original,
      percentage: null,
      note: a.note ?? null,
    } as never);
    if (error || !row) {
      throw new TransactionSplitError('invalid_split', error?.message ?? 'could not save allocation');
    }
    created.push(row);
  }

  // review_status is deliberately left untouched here. R8's own DB trigger
  // (migration 0068) permits an authenticated-role write of `review_status
  // = 'resolved'` ONLY alongside a fresh row in `fdh_transaction_
  // corrections` — a split is not a correction and creates no such row, so
  // this service must never attempt that write (it would be rejected by
  // the trigger). Splitting and approving are deliberately separate actions
  // (spec 55 — a split is not itself an approval); the caller approves the
  // transaction as its own, subsequent, explicit step.

  await recordDocumentAuditEvent({
    userId,
    documentId: transaction.statement_upload_id,
    eventType: 'transaction_split_created',
    actorType: 'user',
    actorId: userId,
    metadata: { transaction_id: transactionId, allocation_count: created.length, finalized: input.finalize },
  });

  return { transaction, allocations: created };
}
