/**
 * Financial Data Hub — category-totals review of one imported bank statement
 * (PO scope 2026-09-26). The user confirms category TOTALS instead of every
 * line; only the lines that genuinely need a person are listed one by one.
 *
 * NOT A NEW APPROVAL ENGINE. Every approval below goes through FDH-7's
 * existing, certified services — `bulkApproveTransactions` (which calls
 * `approveTransaction` per id: the `fdh7_transaction_has_blocking_issue` RPC
 * pre-check, then the RLS-scoped update the `fdh7_guard_transaction_approval`
 * trigger re-validates) and `approveStatement` (the whole-statement cascade,
 * lifecycle advance, Approved Financial Summary and raw-file purge). Every
 * category choice goes through R7's audited `correctTransaction` plus the one
 * sanctioned service-role stamp (`recordUserClassificationDecision`), and a
 * remembered payee goes through R8's `createPersonalClassificationRule` and
 * the unchanged, idempotent `classifyUserTransactions` engine.
 *
 * OWNERSHIP. Every read here uses the RLS-scoped session client AND an
 * explicit `.eq('user_id', userId)`; a statement or transaction id belonging
 * to someone else simply is not found (404), never acted on.
 */

import { createClient } from '@/lib/supabase/server';
import { fetchAllRows, type RangeableQuery } from '../bank-csv/pagination';
import {
  buildCategoryReview,
  derivePayeeKey,
  DUPLICATE_EXCLUDED_DEDUP_STATUSES,
  linkDecisionForChosenType,
  pendingIdsForGroup,
  type CategoryReview,
  type CategoryReviewBlockers,
  type CategoryReviewTransaction,
} from '../domain/categoryReview';
import { toMinorUnits } from '../domain/money';
import { categoriesRepository, subcategoriesRepository, transactionsRepository, userClassificationRulesRepository } from '../repositories';
import { ApprovalError, approveStatement, bulkApproveTransactions } from './approvalService';
import { correctTransaction } from './bankTransactionActionsService';
import { createPersonalClassificationRule, reviewTransactionLink } from './classificationReviewService';
import { classifyUserTransactions, recordUserClassificationDecision } from './transactionClassificationService';
import type { BulkActionItemResult } from '../domain/approvalPolicy';
import type { FdhEconomicTransactionType } from '../constants/enums';
import type { FdhRuleActionDefinition, FdhRuleMatchDefinition } from '../domain/types';

export class CategoryReviewError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_input' | 'invalid_state',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CategoryReviewError';
  }
}

export interface StatementCategoryReview extends CategoryReview {
  statement: {
    id: string;
    period_start: string | null;
    period_end: string | null;
    currency: string | null;
    file_name: string | null;
    source_type: string | null;
    statement_approved: boolean;
  };
}

const TXN_COLUMNS =
  'id, transaction_date, description_clean, amount_original, currency_original, credit_debit, ' +
  'economic_transaction_type, category_id, classification_method, classification_confidence, user_override, ' +
  'review_status, approval_status, dedup_status';

interface StatementRow {
  id: string;
  statement_period_start: string | null;
  statement_period_end: string | null;
  currency_code: string | null;
  original_filename_sanitised: string | null;
  source_type: string | null;
  approved_by: string | null;
}

async function loadStatement(userId: string, statementId: string): Promise<StatementRow> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_statement_uploads')
    .select('id, statement_period_start, statement_period_end, currency_code, original_filename_sanitised, source_type, approved_by')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle<StatementRow>();
  if (error) throw new CategoryReviewError('invalid_state', 'We could not load this statement.');
  if (!data) throw new CategoryReviewError('not_found', 'This statement was not found.');
  return data;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Loads the statement's rows plus every fact the FDH-7 approval gate checks,
 * in bulk (never one RPC per line). */
async function loadReviewInputs(userId: string, statementId: string): Promise<{
  transactions: CategoryReviewTransaction[];
  blockers: CategoryReviewBlockers;
}> {
  const supabase = await createClient();
  const transactions = await fetchAllRows<CategoryReviewTransaction>(() =>
    supabase
      .from('fdh_transactions')
      .select(TXN_COLUMNS)
      .eq('user_id', userId)
      .eq('statement_upload_id', statementId)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true }) as unknown as RangeableQuery<CategoryReviewTransaction>,
  );
  const ids = new Set(transactions.map((t) => t.id));

  const [links, duplicates, reviewItems] = await Promise.all([
    fetchAllRows<{ id: string; transaction_id_from: string; transaction_id_to: string | null; link_type: string }>(() =>
      supabase
        .from('fdh_transaction_links')
        .select('id, transaction_id_from, transaction_id_to, link_type')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .order('id', { ascending: true }) as unknown as RangeableQuery<{ id: string; transaction_id_from: string; transaction_id_to: string | null; link_type: string }>,
    ),
    fetchAllRows<{ id: string; transaction_id_a: string; transaction_id_b: string }>(() =>
      supabase
        .from('fdh_duplicate_candidates')
        .select('id, transaction_id_a, transaction_id_b')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .order('id', { ascending: true }) as unknown as RangeableQuery<{ id: string; transaction_id_a: string; transaction_id_b: string }>,
    ),
    fetchAllRows<{ id: string; transaction_id: string | null }>(() =>
      supabase
        .from('fdh_review_items')
        .select('id, transaction_id')
        .eq('user_id', userId)
        .eq('severity', 'blocking')
        .in('status', ['open', 'in_progress'])
        .order('id', { ascending: true }) as unknown as RangeableQuery<{ id: string; transaction_id: string | null }>,
    ),
  ]);

  const pendingLinkTypesByTxn = new Map<string, string[]>();
  for (const l of links) {
    for (const side of [l.transaction_id_from, l.transaction_id_to]) {
      if (side && ids.has(side)) pendingLinkTypesByTxn.set(side, [...(pendingLinkTypesByTxn.get(side) ?? []), l.link_type]);
    }
  }
  const pendingDuplicateTxnIds = new Set<string>();
  for (const d of duplicates) {
    if (ids.has(d.transaction_id_a)) pendingDuplicateTxnIds.add(d.transaction_id_a);
    if (ids.has(d.transaction_id_b)) pendingDuplicateTxnIds.add(d.transaction_id_b);
  }
  const blockingReviewItemTxnIds = new Set(reviewItems.map((r) => r.transaction_id).filter((id): id is string => Boolean(id && ids.has(id))));

  // A split whose allocations do not add up to the parent blocks approval.
  const invalidSplitTxnIds = new Set<string>();
  const allocSum = new Map<string, number>();
  for (const part of chunk([...ids], 100)) {
    const { data, error } = await supabase
      .from('fdh_transaction_allocations')
      .select('transaction_id, amount, currency_code')
      .eq('user_id', userId)
      .in('transaction_id', part);
    if (error) throw new CategoryReviewError('invalid_state', 'We could not load this statement.');
    for (const a of (data ?? []) as Array<{ transaction_id: string; amount: number | string; currency_code: string }>) {
      allocSum.set(a.transaction_id, (allocSum.get(a.transaction_id) ?? 0) + toMinorUnits(Number(a.amount), a.currency_code));
    }
  }
  for (const t of transactions) {
    const sum = allocSum.get(t.id);
    if (sum !== undefined && sum !== toMinorUnits(Number(t.amount_original), t.currency_original)) invalidSplitTxnIds.add(t.id);
  }

  return { transactions, blockers: { pendingLinkTypesByTxn, pendingDuplicateTxnIds, blockingReviewItemTxnIds, invalidSplitTxnIds } };
}

/** The category-totals review for one of the user's own statements. */
export async function getStatementCategoryReview(userId: string, statementId: string): Promise<StatementCategoryReview> {
  const statement = await loadStatement(userId, statementId);
  const [{ transactions, blockers }, categoriesResult] = await Promise.all([
    loadReviewInputs(userId, statementId),
    categoriesRepository.listActiveAll(),
  ]);
  if (categoriesResult.error) throw new CategoryReviewError('invalid_state', 'We could not load the category list.');
  const review = buildCategoryReview(transactions, categoriesResult.data ?? [], blockers);
  return {
    ...review,
    statement: {
      id: statement.id,
      period_start: statement.statement_period_start,
      period_end: statement.statement_period_end,
      currency: statement.currency_code,
      file_name: statement.original_filename_sanitised,
      source_type: statement.source_type,
      statement_approved: Boolean(statement.approved_by),
    },
  };
}

export interface GroupApprovalResult {
  outcome: 'approved' | 'partly_approved' | 'blocked' | 'already_approved';
  approved: number;
  failed: number;
  results: BulkActionItemResult[];
  statement_finalised: boolean;
}

/** Once every line on a statement is approved, completes the statement
 * itself through the existing `approveStatement` (lifecycle, Approved
 * Financial Summary, raw-file purge). Best-effort: the transactions are
 * already approved and counted whether or not this succeeds. */
async function finaliseStatementIfComplete(userId: string, statementId: string): Promise<boolean> {
  const { transactions } = await loadReviewInputs(userId, statementId);
  const counted = transactions.filter((t) => !DUPLICATE_EXCLUDED_DEDUP_STATUSES.includes(t.dedup_status));
  if (counted.length === 0 || counted.some((t) => t.approval_status !== 'approved')) return false;
  try {
    await approveStatement(userId, statementId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Approves EXACTLY the still-pending transactions of one category group on
 * one statement. Idempotent: a group with nothing left pending is a no-op
 * (`already_approved`), not a second approval and not a second audit row.
 */
export async function approveCategoryGroup(userId: string, statementId: string, groupKey: string): Promise<GroupApprovalResult> {
  const review = await getStatementCategoryReview(userId, statementId);
  const ids = pendingIdsForGroup(review, groupKey);
  if (ids === null) {
    throw new CategoryReviewError('not_found', 'That category is no longer on this statement. Refresh the page and try again.');
  }
  if (ids.length === 0) {
    return { outcome: 'already_approved', approved: 0, failed: 0, results: [], statement_finalised: false };
  }

  const result = await bulkApproveTransactions(userId, ids);
  const statementFinalised = result.succeeded > 0 ? await finaliseStatementIfComplete(userId, statementId) : false;
  return {
    outcome: result.failed === 0 ? 'approved' : result.succeeded === 0 ? 'blocked' : 'partly_approved',
    approved: result.succeeded,
    failed: result.failed,
    results: result.results,
    statement_finalised: statementFinalised,
  };
}

export interface ApproveAllResult {
  outcome: 'approved' | 'already_approved';
  approved: number;
}

/**
 * "Approve everything shown" — offered only once nothing on the statement
 * still needs the user's decision (refused with a clear reason otherwise, so
 * a low-confidence line can never be approved unseen). Reuses FDH-7's
 * `approveStatement` cascade unchanged.
 */
export async function approveAllOnStatement(userId: string, statementId: string): Promise<ApproveAllResult> {
  const review = await getStatementCategoryReview(userId, statementId);
  if (review.counts.needs_decision > 0) {
    const n = review.counts.needs_decision;
    throw new CategoryReviewError(
      'invalid_state',
      `${n} transaction${n === 1 ? ' still needs' : 's still need'} your decision. Choose a category for ${n === 1 ? 'it' : 'them'} first.`,
    );
  }
  const waiting = review.counts.waiting_for_approval;
  if (waiting === 0 && review.statement.statement_approved) return { outcome: 'already_approved', approved: 0 };
  try {
    await approveStatement(userId, statementId);
  } catch (e) {
    if (e instanceof ApprovalError) {
      throw new CategoryReviewError(e.code === 'not_found' ? 'not_found' : 'invalid_state', 'Some transactions could not be approved yet. Refresh the page to see which ones need a decision.', e.details);
    }
    throw e;
  }
  return { outcome: waiting === 0 ? 'already_approved' : 'approved', approved: waiting };
}

export interface SetCategoryResult {
  transaction_id: string;
  category_id: string;
  economic_transaction_type: FdhEconomicTransactionType;
  classification_method: 'user_manual';
  links_settled: number;
  payee_remembered: boolean;
  payee_key: string | null;
}

async function rememberPayee(
  userId: string,
  payeeKey: string,
  categoryId: string,
  economicType: FdhEconomicTransactionType,
): Promise<boolean> {
  const { data: rules } = await userClassificationRulesRepository.listForUserAll(userId);
  const sameNeedle = (rules ?? []).filter((r) => {
    const m = r.match_definition as FdhRuleMatchDefinition;
    return r.active && m.match_kind === 'description_contains' && m.needle_normalised.toUpperCase() === payeeKey;
  });
  const alreadyRemembered = sameNeedle.some((r) => {
    const a = r.action_definition as FdhRuleActionDefinition;
    return a.action_kind === 'classify' && a.category_id === categoryId;
  });
  if (alreadyRemembered) return true;
  // A different remembered choice for the same payee would tie at the same
  // priority and the engine would (correctly) refuse both as a conflict; the
  // user's newest decision replaces the old one instead.
  for (const r of sameNeedle) {
    const { error } = await userClassificationRulesRepository.update(userId, r.id, { active: false } as never);
    if (error) throw new CategoryReviewError('invalid_state', 'We could not update your saved payee choice.');
  }
  await createPersonalClassificationRule(userId, {
    rule_type: 'description_contains',
    match_definition: { match_kind: 'description_contains', needle_normalised: payeeKey },
    action_definition: { action_kind: 'classify', category_id: categoryId, economic_transaction_type: economicType },
  });
  return true;
}

/**
 * The user picks a category for ONE of their own transactions. Sets the
 * economic type that category implies (the fix for production bug 1: the
 * category used to change while the type stayed 'unknown', so the line could
 * never be approved), records the method as the user's own, settles any
 * pending "is this a transfer?" match the choice answers, and — only if the
 * user asked — remembers the payee for next time.
 */
export async function setTransactionCategory(
  userId: string,
  transactionId: string,
  input: { category_id: string; remember_payee?: boolean },
): Promise<SetCategoryResult> {
  const { data: txn } = await transactionsRepository.getForUser(userId, transactionId);
  if (!txn) throw new CategoryReviewError('not_found', 'This transaction was not found.');
  if ((txn as { approval_status?: string }).approval_status === 'approved') {
    throw new CategoryReviewError('invalid_state', 'This transaction is already approved. Reopen its statement to change it.');
  }

  const { data: category } = await categoriesRepository.getById(input.category_id);
  if (!category || !category.active || category.economic_type === 'unknown') {
    throw new CategoryReviewError('invalid_input', 'Choose a category from the list.');
  }
  const newType = category.economic_type;
  const reason = 'Chosen by you in the statement review.';

  if (txn.economic_transaction_type !== newType) {
    await correctTransaction(userId, transactionId, { field_name: 'economic_transaction_type', corrected_value: newType, reason });
  }
  // Always recorded, even when the category is unchanged: confirming the
  // engine's suggestion is itself the user's decision, and this is the
  // correction evidence the review-status transition requires.
  await correctTransaction(userId, transactionId, { field_name: 'category_id', corrected_value: category.id, reason });

  let clearSubcategory = false;
  if (txn.subcategory_id) {
    const { data: sub } = await subcategoriesRepository.getById(txn.subcategory_id);
    clearSubcategory = !sub || sub.category_id !== category.id;
  }
  await recordUserClassificationDecision(userId, {
    transactionId,
    previousEconomicType: txn.economic_transaction_type,
    newEconomicType: newType,
    previousCategoryId: txn.category_id,
    newCategoryId: category.id,
    previousSubcategoryId: txn.subcategory_id,
    clearSubcategory,
  });

  // Settle any still-pending transfer-type match this answer decides.
  const supabase = await createClient();
  const { data: links } = await supabase
    .from('fdh_transaction_links')
    .select('id, link_type')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .or(`transaction_id_from.eq.${transactionId},transaction_id_to.eq.${transactionId}`);
  let linksSettled = 0;
  for (const link of (links ?? []) as Array<{ id: string; link_type: string }>) {
    const decision = linkDecisionForChosenType(link.link_type, newType);
    if (!decision) continue;
    await reviewTransactionLink(userId, link.id, { decision });
    linksSettled += 1;
  }

  const payeeKey = derivePayeeKey(txn.description_clean ?? txn.merchant_raw);
  let payeeRemembered = false;
  if (input.remember_payee && payeeKey) {
    payeeRemembered = await rememberPayee(userId, payeeKey, category.id, newType);
    // The same payee elsewhere on this (or any not-yet-decided) statement is
    // classified straight away by R8's own engine, which never touches a
    // line a person already decided (user_override rows are skipped).
    try {
      await classifyUserTransactions(userId);
    } catch {
      // Best-effort: the rule is saved and applies on the next import.
    }
  }

  return {
    transaction_id: transactionId,
    category_id: category.id,
    economic_transaction_type: newType,
    classification_method: 'user_manual',
    links_settled: linksSettled,
    payee_remembered: payeeRemembered,
    payee_key: payeeKey,
  };
}
