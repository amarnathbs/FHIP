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
import { isDuplicateExcluded, REFUND_LIKE_LINK_TYPES } from '@/lib/read-models/core/spendingRules';
import { recordDocumentAuditEvent, recordDocumentAuditEvents } from './auditLog';
import { scheduleApprovedDocumentPurge } from './purge';
import { FDH7_BULK_ACTION_CONTRACT, runBulkAction, type BulkActionItemResult, type BulkActionResult } from '../domain/approvalPolicy';
import { computeApprovedFinancialSummary, FdhApprovedSummaryError } from '../domain/approvedSummary';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { fetchAllRows, type RangeableQuery } from '../bank-csv/pagination';
import { categoriesRepository, statementUploadsRepository, transactionsRepository } from '../repositories';
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
  // WP-08 (EXP-G4): a line removed as a duplicate counts nowhere, so it is
  // never approved -- approving it is how the removed side of a 'removed_b'
  // pair used to reach every reader that does not filter dedup_status.
  if (isDuplicateExcluded(transaction.dedup_status)) {
    throw new ApprovalError('blocked', DUPLICATE_NOT_APPROVED_MESSAGE);
  }

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

const DUPLICATE_NOT_APPROVED_MESSAGE = 'this line was removed as a duplicate and is not counted, so it is not approved';
const BLOCKED_MESSAGE = 'this transaction has an unresolved review issue and cannot be approved yet';

/** Ids per `fdh7_bulk_approve_transactions` call (the RPC refuses > 5,000). */
export const BULK_APPROVE_CHUNK = 500;
/** Ids per `.in()` filter -- keeps every GET URL well under proxy limits
 * (1,000 UUIDs is ~37 KB of query string). */
export const ID_FILTER_CHUNK = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** True when an RPC failed only because its migration is not applied yet
 * (PostgREST schema-cache miss, or Postgres undefined_function). */
export function isMissingRpcError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? '');
}

interface BulkApproveOutcome {
  approved: string[];
  blocked: string[];
  alreadyApproved: string[];
  skippedDuplicates: string[];
  notFound: string[];
}

/**
 * WP-08 (EXP-G8): one set-based UPDATE per 500 ids through migration 0212's
 * `fdh7_bulk_approve_transactions` (the per-row approval guard trigger still
 * re-validates every row). Returns null when 0212 is not applied, so the
 * caller falls back to the per-row path instead of failing approvals during
 * the deploy window.
 */
async function bulkApproveViaRpc(ids: readonly string[]): Promise<BulkApproveOutcome | null> {
  const out: BulkApproveOutcome = { approved: [], blocked: [], alreadyApproved: [], skippedDuplicates: [], notFound: [] };
  if (ids.length === 0) return out;
  const supabase = await createClient();
  let first = true;
  for (const part of chunk(ids, BULK_APPROVE_CHUNK)) {
    const { data, error } = await supabase.rpc('fdh7_bulk_approve_transactions', { p_transaction_ids: part });
    if (error) {
      if (first && isMissingRpcError(error)) return null;
      throw new ApprovalError('blocked', `approval was rejected by the server: ${error.message}`, { approved_so_far: out.approved });
    }
    first = false;
    const r = (data ?? {}) as Partial<Record<'approved' | 'blocked' | 'already_approved' | 'skipped_duplicates' | 'not_found', string[]>>;
    out.approved.push(...(r.approved ?? []));
    out.blocked.push(...(r.blocked ?? []));
    out.alreadyApproved.push(...(r.already_approved ?? []));
    out.skippedDuplicates.push(...(r.skipped_duplicates ?? []));
    out.notFound.push(...(r.not_found ?? []));
  }
  return out;
}

/** The statement each approved id belongs to, for its audit row. */
async function statementIdsFor(userId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
  const supabase = await createClient();
  const map = new Map<string, string | null>();
  for (const part of chunk(ids, ID_FILTER_CHUNK)) {
    const { data, error } = await supabase.from('fdh_transactions').select('id, statement_upload_id').eq('user_id', userId).in('id', part);
    if (error) throw new ApprovalError('invalid_state', `could not read approved transactions: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; statement_upload_id: string | null }>) map.set(row.id, row.statement_upload_id);
  }
  return map;
}

async function auditApproved(userId: string, approvedIds: readonly string[], statementId?: string): Promise<void> {
  if (approvedIds.length === 0) return;
  const docs = statementId ? null : await statementIdsFor(userId, approvedIds);
  await recordDocumentAuditEvents(approvedIds.map((id) => ({
    userId,
    documentId: statementId ?? docs?.get(id) ?? null,
    eventType: 'transaction_approved' as const,
    actorType: 'user' as const,
    actorId: userId,
    metadata: { transaction_id: id },
  })));
}

/** Bulk transaction approval (spec 49-51, 96) — see
 * `domain/approvalPolicy.ts#runBulkAction` for the explicit partial-success
 * contract. Never creates a personal/global rule merely from being batched
 * (spec 51). WP-08: set-based through 0212 when it is applied (one request
 * per 500 ids instead of three per id); the per-item result contract is
 * unchanged, and a removed duplicate is reported, never approved. */
export async function bulkApproveTransactions(userId: string, transactionIds: readonly string[]): Promise<BulkActionResult> {
  const rpc = await bulkApproveViaRpc(transactionIds);
  let result: BulkActionResult;
  if (rpc) {
    const approved = new Set(rpc.approved);
    const already = new Set(rpc.alreadyApproved);
    const blocked = new Set(rpc.blocked);
    const dups = new Set(rpc.skippedDuplicates);
    const results: BulkActionItemResult[] = transactionIds.map((id) => {
      if (approved.has(id) || already.has(id)) return { id, ok: true };
      if (dups.has(id)) return { id, ok: false, error: DUPLICATE_NOT_APPROVED_MESSAGE };
      if (blocked.has(id)) return { id, ok: false, error: BLOCKED_MESSAGE };
      return { id, ok: false, error: 'transaction not found' };
    });
    const succeeded = results.filter((r) => r.ok).length;
    result = { contract: FDH7_BULK_ACTION_CONTRACT, requested: transactionIds.length, succeeded, failed: results.length - succeeded, results };
    await auditApproved(userId, rpc.approved);
  } else {
    result = await runBulkAction(transactionIds, async (id) => {
      await approveTransaction(userId, id);
    });
  }
  await recordDocumentAuditEvent({
    userId,
    documentId: null,
    eventType: 'bulk_review_action_completed',
    actorType: 'user',
    actorId: userId,
    metadata: { requested: result.requested, succeeded: result.succeeded, failed: result.failed, set_based: Boolean(rpc) },
  });
  return result;
}

/** Every transaction on one statement with its allocations. WP-08 (EXP-G8):
 * paged past PostgREST's 1,000-row cap, allocations read 100 ids at a time.
 * Before, line 1,001 of a statement was never read -- so never approved,
 * never reverted and never in the Approved Financial Summary. */
export async function listStatementTransactionsWithAllocations(
  userId: string,
  statementId: string,
): Promise<Array<FdhTransaction & { allocations: FdhTransactionAllocation[] }>> {
  const supabase = await createClient();
  let txns: FdhTransaction[];
  try {
    txns = await fetchAllRows<FdhTransaction>(() =>
      supabase
        .from('fdh_transactions')
        .select('*')
        .eq('user_id', userId)
        .eq('statement_upload_id', statementId)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true }) as unknown as RangeableQuery<FdhTransaction>,
    );
  } catch (e) {
    throw new ApprovalError('invalid_state', `could not list transactions: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (txns.length === 0) return [];
  const byTxn = new Map<string, FdhTransactionAllocation[]>();
  for (const part of chunk(txns.map((t) => t.id), ID_FILTER_CHUNK)) {
    let allocs: FdhTransactionAllocation[];
    try {
      allocs = await fetchAllRows<FdhTransactionAllocation>(() =>
        supabase
          .from('fdh_transaction_allocations')
          .select('*')
          .eq('user_id', userId)
          .in('transaction_id', part)
          .order('transaction_id', { ascending: true })
          .order('allocation_sequence', { ascending: true }) as unknown as RangeableQuery<FdhTransactionAllocation>,
      );
    } catch (e) {
      throw new ApprovalError('invalid_state', `could not list allocations: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const a of allocs) byTxn.set(a.transaction_id, [...(byTxn.get(a.transaction_id) ?? []), a]);
  }
  return txns.map((t) => ({ ...t, allocations: byTxn.get(t.id) ?? [] }));
}

async function listConfirmedRefundLinks(userId: string, transactionIds: readonly string[]): Promise<FdhTransactionLink[]> {
  if (transactionIds.length === 0) return [];
  const supabase = await createClient();
  let data: FdhTransactionLink[];
  try {
    data = await fetchAllRows<FdhTransactionLink>(() =>
      supabase
        .from('fdh_transaction_links')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'confirmed')
        .in('link_type', [...REFUND_LIKE_LINK_TYPES])
        .order('id', { ascending: true }) as unknown as RangeableQuery<FdhTransactionLink>,
    );
  } catch (e) {
    throw new ApprovalError('invalid_state', `could not list refund links: ${e instanceof Error ? e.message : String(e)}`);
  }
  const idSet = new Set(transactionIds);
  return data.filter((l) => idSet.has(l.transaction_id_from) || (l.transaction_id_to && idSet.has(l.transaction_id_to)));
}

/** WP-08 (EXP-G18): the Approved Financial Summary names each category by its
 * display name, never its UUID. */
export async function categoryAggregateLabels(categoryIds: readonly string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const { data } = await categoriesRepository.listActiveAll();
  const byId = new Map((data ?? []).map((c) => [c.id, c.display_name] as const));
  for (const id of categoryIds) {
    labels.set(id, id === 'uncategorised' ? 'Uncategorised' : byId.get(id) ?? 'Category no longer offered');
  }
  return labels;
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
  // transaction. Each row is re-validated independently (spec 50) -- by the
  // RPC's own blocking check and again by the per-row guard trigger.
  // WP-08: an excluded duplicate is never part of the cascade (EXP-G4), and
  // the cascade is set-based when 0212 is applied (EXP-G8).
  const pendingIds = transactions
    .filter((t) => t.approval_status !== 'approved' && !isDuplicateExcluded(t.dedup_status))
    .map((t) => t.id);
  const blockedIds: string[] = [];
  const rpc = await bulkApproveViaRpc(pendingIds);
  if (rpc) {
    blockedIds.push(...rpc.blocked, ...rpc.notFound);
    await auditApproved(userId, rpc.approved, statementId);
  } else {
    for (const id of pendingIds) {
      try {
        await approveTransaction(userId, id);
      } catch {
        blockedIds.push(id);
      }
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
  const labels = await categoryAggregateLabels(Object.keys(totals.category_totals));
  for (const [categoryId, total] of Object.entries(totals.category_totals)) {
    categoryAggregates[categoryId] = { label: labels.get(categoryId) ?? categoryId, total };
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

  // LR-1 (Strict Raw-File Deletion): the Approved Financial Summary above and
  // every underlying transaction/allocation is now durably written — the
  // structured staging this statement's raw source document exists to
  // produce. The raw file is no longer needed for anything, so its purge is
  // scheduled immediately here, right after that staging write and before
  // returning to the caller — never left to a multi-day "evidence" grace
  // window. Uses the admin-client purge service (`services/purge.ts`), which
  // independently verifies storage absence before ever marking the row
  // purged; failure to schedule must not fail an otherwise-successful
  // approval, since the LR-1 hard 60-minute backstop
  // (`enforceRawFileHardBackstop`, run from the purge-sweep cron) will still
  // catch this document regardless.
  try {
    await scheduleApprovedDocumentPurge(approvedStatement);
  } catch {
    // Deliberately swallowed — see comment above. Never surfaced to the user
    // as an approval failure.
  }

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
  // WP-08 (EXP-G8): ONE set-based UPDATE (the guard trigger clears
  // approved_at/approved_by on every row), then a count check -- before,
  // an unpaged select reverted only the first 1,000 lines and a zero-row
  // write was never noticed.
  const { error: revertError, count: revertedCount } = await supabase
    .from('fdh_transactions')
    .update({ approval_status: 'pending' }, { count: 'exact' })
    .eq('user_id', userId)
    .eq('statement_upload_id', statementId)
    .eq('approval_status', 'approved');
  if (revertError) {
    throw new ApprovalError('invalid_state', `could not revert the statement's approvals: ${revertError.message}`);
  }
  const { count: stillApproved, error: countError } = await supabase
    .from('fdh_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('statement_upload_id', statementId)
    .eq('approval_status', 'approved');
  if (countError || (stillApproved ?? 0) > 0) {
    throw new ApprovalError('invalid_state', `could not revert every approval on this statement (${stillApproved ?? 'unknown'} still approved)`);
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
    metadata: { previous_approval_version: statement.approval_version, reverted_transaction_count: revertedCount ?? null },
  });

  return reopened;
}

export { FdhApprovedSummaryError };
