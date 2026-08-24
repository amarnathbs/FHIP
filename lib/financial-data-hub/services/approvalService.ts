/**
 * FDH-7 — Transaction & Statement Approval, Reopen, and the Approved
 * Financial Summary (spec sections 26, 52-67, 108-110).
 *
 * SERVER-DERIVED, DB-ENFORCED (spec 79, 108-110). Every write here goes
 * through the ordinary RLS-scoped client — the actual gate against a forged
 * approval is the DB trigger `fdh7_guard_transaction_approval`/
 * `fdh7_guard_statement_approval` (migration 0076), not this file's own
 * pre-checks. The pre-checks exist only so a legitimate user sees a clear
 * reason instead of a raw Postgres exception (identical precedent to
 * `classificationReviewService.ts`'s narrow-transition checks).
 */

import { createClient } from '@/lib/supabase/server';
import { recordDocumentAuditEvent } from './auditLog';
import { runBulkAction, type BulkActionResult } from '../domain/approvalPolicy';
import { computeApprovedFinancialSummary, FdhApprovedSummaryError } from '../domain/approvedSummary';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { statementUploadsRepository, transactionsRepository } from '../repositories';
import type { FdhStatementUpload, FdhTransaction, FdhTransactionAllocation, FdhTransactionLink } from '../domain/types';

export class ApprovalError extends Error {
  constructor(
    readonly code: 'not_found' | 'blocked' | 'invalid_state',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** Friendly pre-check mirror of the DB function of the same name — see
 * `domain/approvalPolicy.ts`'s header for why both exist. */
async function transactionHasBlockingIssue(userId: string, transactionId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh7_transaction_has_blocking_issue', {
    p_user_id: userId,
    p_transaction_id: transactionId,
  });
  if (error) throw new ApprovalError('invalid_state', `could not evaluate review status: ${error.message}`);
  return Boolean(data);
}

async function statementHasBlockingIssue(userId: string, statementId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh7_statement_has_blocking_issue', {
    p_user_id: userId,
    p_statement_id: statementId,
  });
  if (error) throw new ApprovalError('invalid_state', `could not evaluate review status: ${error.message}`);
  return Boolean(data);
}

/** Transaction approval (spec 26, 52, 55). A deliberate, single, idempotent
 * action — approving an already-approved transaction is a no-op success
 * (spec 73), never a duplicate audit row. */
export async function approveTransaction(userId: string, transactionId: string): Promise<FdhTransaction> {
  const { data: transaction } = await transactionsRepository.getForUser(userId, transactionId);
  if (!transaction) throw new ApprovalError('not_found', 'transaction not found');
  if (transaction.approval_status === 'approved') return transaction; // idempotent (spec 73)

  if (await transactionHasBlockingIssue(userId, transactionId)) {
    throw new ApprovalError('blocked', 'this transaction has an unresolved review issue and cannot be approved yet');
  }

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from('fdh_transactions')
    .update({ approval_status: 'approved', approved_by: userId, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('user_id', userId)
    .select()
    .single<FdhTransaction>();
  if (error || !updated) {
    // The DB trigger is the real gate — a race between the pre-check above
    // and this write can still legitimately fail here (spec 110).
    throw new ApprovalError('blocked', error?.message ?? 'approval was rejected by the server');
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: transaction.statement_upload_id,
    eventType: 'transaction_approved',
    actorType: 'user',
    actorId: userId,
    metadata: { transaction_id: transactionId },
  });

  return updated;
}

/** Bulk transaction approval (spec 49-51, 96) — see
 * `domain/approvalPolicy.ts#runBulkAction` for the explicit partial-success
 * contract. Never creates a personal/global rule merely from being batched
 * (spec 51). */
export async function bulkApproveTransactions(userId: string, transactionIds: readonly string[]): Promise<BulkActionResult> {
  const result = await runBulkAction(transactionIds, async (id) => {
    await approveTransaction(userId, id);
  });
  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'bulk_review_action_completed',
    actorType: 'user',
    actorId: userId,
    metadata: { requested: result.requested, succeeded: result.succeeded, failed: result.failed },
  });
  return result;
}

async function listStatementTransactionsWithAllocations(
  userId: string,
  statementId: string,
): Promise<Array<FdhTransaction & { allocations: FdhTransactionAllocation[] }>> {
  const supabase = await createClient();
  const { data: txns, error } = await supabase
    .from('fdh_transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('statement_upload_id', statementId)
    .returns<FdhTransaction[]>();
  if (error) throw new ApprovalError('invalid_state', `could not list transactions: ${error.message}`);
  const ids = (txns ?? []).map((t) => t.id);
  if (ids.length === 0) return [];
  const { data: allocs, error: allocError } = await supabase
    .from('fdh_transaction_allocations')
    .select('*')
    .eq('user_id', userId)
    .in('transaction_id', ids)
    .returns<FdhTransactionAllocation[]>();
  if (allocError) throw new ApprovalError('invalid_state', `could not list allocations: ${allocError.message}`);
  const byTxn = new Map<string, FdhTransactionAllocation[]>();
  for (const a of allocs ?? []) byTxn.set(a.transaction_id, [...(byTxn.get(a.transaction_id) ?? []), a]);
  return (txns ?? []).map((t) => ({ ...t, allocations: byTxn.get(t.id) ?? [] }));
}

async function listConfirmedRefundLinks(userId: string, transactionIds: readonly string[]): Promise<FdhTransactionLink[]> {
  if (transactionIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_transaction_links')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'confirmed')
    .in('link_type', ['refund_original', 'reversal_original'])
    .returns<FdhTransactionLink[]>();
  if (error) throw new ApprovalError('invalid_state', `could not list refund links: ${error.message}`);
  const idSet = new Set(transactionIds);
  return (data ?? []).filter((l) => idSet.has(l.transaction_id_from) || (l.transaction_id_to && idSet.has(l.transaction_id_to)));
}

/**
 * Statement approval (spec 52-58, 63). In one action:
 *  1. Cascade-approves every currently-clean transaction on the statement
 *     (spec 56 — the summary shown before final approval reflects exactly
 *     what gets approved).
 *  2. Re-checks the statement-level blocking policy; if anything still
 *     blocks, returns the exact blocked transaction ids/reasons rather than
 *     partially approving (spec 54 — "return explicit reasons if approval
 *     is blocked").
 *  3. Advances `processing_status` through the EXISTING, unmodified FDH-3
 *     lifecycle guard (`assertDocumentTransition`) to `approved` if not
 *     already there — reused, never reimplemented.
 *  4. Sets `approved_by` (the DB trigger stamps `approved_at` and
 *     increments `approval_version`).
 *  5. Computes and persists the Approved Financial Summary via the pure,
 *     independently-testable `computeApprovedFinancialSummary` oracle.
 */
export async function approveStatement(
  userId: string,
  statementId: string,
): Promise<{ statement: FdhStatementUpload; blockedTransactionIds: string[] }> {
  const { data: statement } = await statementUploadsRepository.getForUser(userId, statementId);
  if (!statement) throw new ApprovalError('not_found', 'statement not found');
  if (statement.approved_by) {
    return { statement, blockedTransactionIds: [] }; // idempotent (spec 73)
  }

  const transactions = await listStatementTransactionsWithAllocations(userId, statementId);

  // Step 1: cascade-approve every currently clean, not-yet-approved
  // transaction. Each call re-validates independently (spec 50).
  const blockedIds: string[] = [];
  for (const t of transactions) {
    if (t.approval_status === 'approved') continue;
    try {
      await approveTransaction(userId, t.id);
    } catch {
      blockedIds.push(t.id);
    }
  }

  // Step 2: statement-level re-check (reconciliation, statement-scoped
  // review items, and any transaction still blocked after step 1).
  if (await statementHasBlockingIssue(userId, statementId)) {
    throw new ApprovalError(
      'blocked',
      'this statement has unresolved review issues and cannot be approved yet',
      { blocked_transaction_ids: blockedIds },
    );
  }

  // Step 3: advance the document lifecycle to 'approved' if it is not
  // already there (reused, unmodified guard).
  const supabase = await createClient();
  let currentProcessingStatus = statement.processing_status;
  if (currentProcessingStatus === 'review_required') {
    assertDocumentTransition('review_required', 'ready_for_approval');
    await supabase.from('fdh_statement_uploads').update({ processing_status: 'ready_for_approval' }).eq('id', statementId).eq('user_id', userId);
    currentProcessingStatus = 'ready_for_approval';
  }
  if (currentProcessingStatus === 'ready_for_approval') {
    assertDocumentTransition('ready_for_approval', 'approved');
    await supabase.from('fdh_statement_uploads').update({ processing_status: 'approved' }).eq('id', statementId).eq('user_id', userId);
  } else if (currentProcessingStatus !== 'approved') {
    throw new ApprovalError('invalid_state', `a statement in processing_status '${currentProcessingStatus}' cannot be approved`);
  }

  // Step 4: the genuine user-approval stamp. The DB trigger re-validates
  // (defense in depth) and stamps approved_at/increments approval_version.
  const { data: approvedStatement, error: approveError } = await supabase
    .from('fdh_statement_uploads')
    .update({ approved_by: userId, updated_at: new Date().toISOString() })
    .eq('id', statementId)
    .eq('user_id', userId)
    .select()
    .single<FdhStatementUpload>();
  if (approveError || !approvedStatement) {
    throw new ApprovalError('blocked', approveError?.message ?? 'approval was rejected by the server');
  }

  // Step 5: Approved Financial Summary (spec 57-58, 84).
  const refundLinks = await listConfirmedRefundLinks(userId, transactions.map((t) => t.id));
  const currency = statement.currency_code ?? transactions[0]?.currency_original ?? 'AUD';
  const totals = computeApprovedFinancialSummary(
    currency,
    transactions.map((t) => ({
      id: t.id,
      amount_original: t.amount_original,
      currency_original: t.currency_original,
      economic_transaction_type: t.economic_transaction_type,
      category_id: t.category_id,
      dedup_status: t.dedup_status,
      allocations: t.allocations.map((a) => ({
        economic_transaction_type: a.economic_transaction_type,
        category_id: a.category_id,
        amount: a.amount,
        currency_code: a.currency_code,
      })),
    })),
    refundLinks
      .filter((l) => l.transaction_id_to)
      .map((l) => ({ refundTransactionId: l.transaction_id_from, originalTransactionId: l.transaction_id_to as string })),
  );

  const categoryAggregates: Record<string, { label: string; total: number }> = {};
  for (const [categoryId, total] of Object.entries(totals.category_totals)) {
    categoryAggregates[categoryId] = { label: categoryId, total };
  }

  const { error: summaryError } = await supabase.from('fdh_approved_financial_summaries').insert({
    user_id: userId,
    household_id: statement.household_id,
    statement_upload_id: statementId,
    financial_account_id: statement.financial_account_id,
    approval_version: approvedStatement.approval_version,
    period_start: statement.statement_period_start,
    period_end: statement.statement_period_end,
    currency_code: currency,
    approved_transaction_count: totals.approved_transaction_count,
    unresolved_transaction_count: transactions.length - totals.approved_transaction_count - totals.duplicate_excluded_count,
    income_total: totals.income_total,
    expense_total: totals.expense_total,
    transfer_total: totals.transfer_total,
    refund_total: totals.refund_total,
    tax_total: totals.tax_total,
    fee_total: totals.fee_total,
    cash_withdrawal_total: totals.cash_withdrawal_total,
    investment_total: totals.investment_total,
    debt_principal_total: totals.debt_principal_total,
    debt_interest_total: totals.debt_interest_total,
    asset_purchase_total: totals.asset_purchase_total,
    asset_sale_total: totals.asset_sale_total,
    unknown_total: totals.unknown_total,
    category_aggregates: categoryAggregates,
    approved_by: userId,
  });
  if (summaryError) {
    throw new ApprovalError('invalid_state', `approved, but could not persist the summary: ${summaryError.message}`);
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: statementId,
    eventType: 'statement_approved',
    actorType: 'user',
    actorId: userId,
    metadata: { approval_version: approvedStatement.approval_version, approved_transaction_count: totals.approved_transaction_count },
  });

  return { statement: approvedStatement, blockedTransactionIds: [] };
}

/** Reopen (spec 63-64) — explicit user action, preserves every prior
 * approval record (marks it superseded, never deletes it). */
export async function reopenStatement(userId: string, statementId: string, reason: string): Promise<FdhStatementUpload> {
  const { data: statement } = await statementUploadsRepository.getForUser(userId, statementId);
  if (!statement) throw new ApprovalError('not_found', 'statement not found');
  if (!statement.approved_by) {
    throw new ApprovalError('invalid_state', 'only an approved statement can be reopened');
  }

  const supabase = await createClient();

  // Preserve, never erase (spec 63): mark the current summary superseded.
  const { error: supersedeError } = await supabase
    .from('fdh_approved_financial_summaries')
    .update({ superseded: true })
    .eq('statement_upload_id', statementId)
    .eq('user_id', userId)
    .eq('approval_version', statement.approval_version);
  if (supersedeError) {
    throw new ApprovalError('invalid_state', `could not mark the prior summary superseded: ${supersedeError.message}`);
  }

  // Revert every transaction's approval so corrections can be made again.
  const { data: txns } = await supabase
    .from('fdh_transactions')
    .select('id, approval_status')
    .eq('user_id', userId)
    .eq('statement_upload_id', statementId)
    .returns<Array<{ id: string; approval_status: string }>>();
  for (const t of txns ?? []) {
    if (t.approval_status === 'approved') {
      await supabase.from('fdh_transactions').update({ approval_status: 'pending' }).eq('id', t.id).eq('user_id', userId);
    }
  }

  const { data: reopened, error } = await supabase
    .from('fdh_statement_uploads')
    .update({ approved_by: null, reopened_by: userId, reopen_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', statementId)
    .eq('user_id', userId)
    .select()
    .single<FdhStatementUpload>();
  if (error || !reopened) {
    throw new ApprovalError('invalid_state', error?.message ?? 'could not reopen the statement');
  }

  await recordDocumentAuditEvent({
    userId,
    documentId: statementId,
    eventType: 'statement_reopened',
    actorType: 'user',
    actorId: userId,
    metadata: { previous_approval_version: statement.approval_version },
  });

  return reopened;
}

export { FdhApprovedSummaryError };
