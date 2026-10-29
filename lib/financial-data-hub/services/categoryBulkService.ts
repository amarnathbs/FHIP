/**
 * Financial Data Hub — BULK category assignment on one imported statement's
 * review (PO request 2026-10-29: "no multiple select and save all at once").
 *
 * WHAT IT IS. The single-line "Save category" (`setTransactionCategory`) applied
 * to many lines in ONE request, with the SAME rules and the SAME evidence per
 * line: the user's category must be an active, non-'unknown' category; the
 * economic type is derived on the server from it; a correction row (previous and
 * new value) is written for the type (when it changes) and the category; the line
 * is stamped `user_manual` with full confidence and the transfer flag its type
 * implies; a subcategory that no longer fits is cleared; a pending "is this a
 * transfer?" match the choice answers is settled; one `transaction_corrected`
 * audit event per changed field; and, only if the user ticked it, the payee is
 * remembered through R8's `rememberPayee` (once per payee, not once per line).
 *
 * WHAT IT NEVER DOES. It never approves anything. Approval (a category group, or
 * everything) stays the separate explicit step in `categoryReviewService`.
 *
 * SCOPE. The statement must be the caller's own (404 otherwise) and each id must
 * be a line of THAT statement owned by the caller; every query carries the
 * RLS-scoped session client AND an explicit `.eq('user_id', userId)`. An id that
 * is someone else's, another statement's, or invented is reported as "not found"
 * in the result and touches nothing; it reveals nothing about the row.
 *
 * ATOMICITY. Supabase offers no multi-statement transaction from application
 * code and this feature adds no migration, so the batch is NOT all-or-nothing.
 * The alternative the request allows is implemented instead: every requested id
 * appears in the result exactly once, as applied, unchanged (already had exactly
 * this choice: re-running the same request is a no-op with no second correction
 * or audit row) or failed with a plain-words reason. Nothing is skipped
 * silently, and a failure of one line never undoes or blocks the others.
 *
 * SPEED. The per-line save costs ~8 requests; 271 lines would be ~2,000
 * sequential requests (the 28 s production limit was already hit that way, see
 * tests/unit/fdhClassificationBatchedWrites.test.ts). Lines receiving the same
 * category are written together (`.in('id', <=100 ids)`); corrections, history
 * and audit rows are inserted in chunks.
 */

import { createClient } from '@/lib/supabase/server';
import { derivePayeeKey, linkDecisionForChosenType } from '../domain/categoryReview';
import { categoriesRepository, subcategoriesRepository } from '../repositories';
import { recordDocumentAuditEvents } from './auditLog';
import { reviewTransactionLink } from './classificationReviewService';
import { CategoryReviewError, getStatementCategoryReview, rememberPayee } from './categoryReviewService';
import { classifyUserTransactions, recordUserClassificationDecisionsBatch } from './transactionClassificationService';
import type { FdhBulkSetCategoryInput } from '../validation/transactions';
import type { FdhEconomicTransactionType } from '../constants/enums';

export type BulkCategoryFailureCode =
  | 'not_found'
  | 'already_approved'
  | 'cannot_choose_here'
  | 'no_suggestion'
  | 'invalid_category'
  | 'write_failed';

export interface BulkCategoryFailure {
  transaction_id: string;
  description: string | null;
  code: BulkCategoryFailureCode;
  message: string;
}

export interface BulkSetCategoryResult {
  statement_id: string;
  mode: 'category' | 'suggested';
  requested: number;
  /** Lines whose category was set by this request. */
  applied: number;
  /** Lines that already had exactly this choice (no second correction or audit row was written). */
  unchanged: number;
  /** Every line that could not be set, each with its reason. applied + unchanged + failed.length === requested. */
  failed: BulkCategoryFailure[];
  applied_ids: string[];
  unchanged_ids: string[];
  /** Applied and unchanged lines per category, for the confirmation message. */
  by_category: Array<{ category_id: string; label: string; count: number }>;
  links_settled: number;
  payees_remembered: number;
  payees_not_remembered: Array<{ payee_key: string; message: string }>;
  /** Always 0: assigning a category never approves a line. */
  approved: 0;
  outcome: 'applied' | 'partly_applied' | 'already_set' | 'nothing_applied';
}

const REASON = 'Chosen by you in the statement review.';
const IN_CHUNK = 100;
const INSERT_CHUNK = 200;
const CONCURRENCY = 5;

interface TxnRow {
  id: string;
  statement_upload_id: string | null;
  description_clean: string | null;
  merchant_raw: string | null;
  economic_transaction_type: string;
  category_id: string | null;
  subcategory_id: string | null;
  classification_method: string | null;
  user_override: boolean | null;
  approval_status: string;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadStatementRows(userId: string, statementId: string, ids: readonly string[]): Promise<Map<string, TxnRow>> {
  const supabase = await createClient();
  const found = new Map<string, TxnRow>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('fdh_transactions')
      .select('id, statement_upload_id, description_clean, merchant_raw, economic_transaction_type, category_id, subcategory_id, classification_method, user_override, approval_status')
      .in('id', part)
      .eq('user_id', userId)
      .eq('statement_upload_id', statementId);
    if (error) throw new CategoryReviewError('invalid_state', 'We could not load these transactions.');
    for (const r of (data ?? []) as TxnRow[]) found.set(r.id, r);
  }
  return found;
}

interface GroupOutcome {
  appliedRows: TxnRow[];
  unchangedRows: TxnRow[];
  failed: BulkCategoryFailure[];
  linksSettled: number;
}

/** Applies ONE category to many rows (all already checked: owned, on this statement, not approved). */
async function applyCategoryToRows(
  userId: string,
  statementId: string,
  category: { id: string; economic_type: FdhEconomicTransactionType },
  rows: readonly TxnRow[],
  settledLinkIds: Set<string>,
): Promise<GroupOutcome> {
  const newType = category.economic_type;
  const failed: BulkCategoryFailure[] = [];
  const fail = (r: TxnRow, message: string) => failed.push({ transaction_id: r.id, description: r.description_clean, code: 'write_failed', message });

  const unchangedRows = rows.filter(
    (r) => r.category_id === category.id && r.economic_transaction_type === newType && r.classification_method === 'user_manual' && r.user_override === true,
  );
  const unchangedIds = new Set(unchangedRows.map((r) => r.id));
  let todo = rows.filter((r) => !unchangedIds.has(r.id));
  if (todo.length === 0) return { appliedRows: [], unchangedRows: [...unchangedRows], failed, linksSettled: 0 };

  const supabase = await createClient();

  // 1. Correction evidence (the trigger on fdh_transactions requires it): the same rows correctTransaction writes.
  const corrections: Array<Record<string, unknown>> = [];
  const correctedAt = new Date().toISOString();
  for (const r of todo) {
    if (r.economic_transaction_type !== newType) {
      corrections.push({ user_id: userId, transaction_id: r.id, field_name: 'economic_transaction_type', previous_value: r.economic_transaction_type ?? null, corrected_value: newType, reason: REASON, corrected_at: correctedAt });
    }
    corrections.push({ user_id: userId, transaction_id: r.id, field_name: 'category_id', previous_value: r.category_id ?? null, corrected_value: category.id, reason: REASON, corrected_at: correctedAt });
  }
  const evidenceFailed = new Set<string>();
  for (const part of chunk(corrections, INSERT_CHUNK)) {
    const { error } = await supabase.from('fdh_transaction_corrections').insert(part);
    if (error) for (const c of part) evidenceFailed.add(String(c.transaction_id));
  }
  for (const r of todo) if (evidenceFailed.has(r.id)) fail(r, 'We could not record your choice on this transaction.');
  todo = todo.filter((r) => !evidenceFailed.has(r.id));

  // 2. The user's own (RLS-scoped) update: type, category, override flag, review resolved.
  const updatedIds = new Set<string>();
  for (const part of chunk(todo, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('fdh_transactions')
      .update({ economic_transaction_type: newType, category_id: category.id, user_override: true, review_status: 'resolved', updated_at: new Date().toISOString() })
      .in('id', part.map((r) => r.id))
      .eq('user_id', userId)
      .neq('approval_status', 'approved')
      .select('id');
    if (!error) for (const row of (data ?? []) as Array<{ id: string }>) updatedIds.add(row.id);
  }
  for (const r of todo) if (!updatedIds.has(r.id)) fail(r, 'We could not save this category. The transaction may have been approved or changed meanwhile.');
  todo = todo.filter((r) => updatedIds.has(r.id));
  if (todo.length === 0) return { appliedRows: [], unchangedRows: [...unchangedRows], failed, linksSettled: 0 };

  // 3. The sanctioned service-role stamp + history (method user_manual, confidence, transfer flag, stale subcategory cleared).
  const subIds = [...new Set(todo.map((r) => r.subcategory_id).filter((x): x is string => Boolean(x)))];
  const subBelongs = new Map<string, boolean>();
  for (const sid of subIds) {
    const { data: sub } = await subcategoriesRepository.getById(sid);
    subBelongs.set(sid, Boolean(sub && sub.category_id === category.id));
  }
  const stamp = await recordUserClassificationDecisionsBatch(
    userId,
    { newEconomicType: newType, newCategoryId: category.id },
    todo.map((r) => ({
      transactionId: r.id,
      previousEconomicType: r.economic_transaction_type,
      previousCategoryId: r.category_id,
      previousSubcategoryId: r.subcategory_id,
      clearSubcategory: r.subcategory_id ? !subBelongs.get(r.subcategory_id) : false,
    })),
  );
  const stamped = new Set(stamp.stampedIds);
  for (const f of stamp.failed) {
    const r = todo.find((x) => x.id === f.transactionId);
    if (r) fail(r, f.message);
  }
  const appliedRows = todo.filter((r) => stamped.has(r.id));

  // 4. One `transaction_corrected` audit event per changed field, in batches.
  await recordDocumentAuditEvents(
    appliedRows.flatMap((r) => {
      const fields = r.economic_transaction_type !== newType ? ['economic_transaction_type', 'category_id'] : ['category_id'];
      return fields.map((field_name) => ({
        userId,
        documentId: r.statement_upload_id ?? statementId,
        eventType: 'transaction_corrected' as const,
        actorType: 'user' as const,
        actorId: userId,
        metadata: { field_name },
      }));
    }),
  );

  // 5. Settle any still-pending transfer-type match the choice answers.
  let linksSettled = 0;
  const links = new Map<string, string>();
  for (const part of chunk(appliedRows.map((r) => r.id), IN_CHUNK)) {
    for (const col of ['transaction_id_from', 'transaction_id_to'] as const) {
      const { data } = await supabase
        .from('fdh_transaction_links')
        .select('id, link_type')
        .eq('user_id', userId)
        .eq('status', 'pending')
        .in(col, part);
      for (const l of (data ?? []) as Array<{ id: string; link_type: string }>) links.set(l.id, l.link_type);
    }
  }
  for (const [linkId, linkType] of links) {
    if (settledLinkIds.has(linkId)) continue;
    const decision = linkDecisionForChosenType(linkType, newType);
    if (!decision) continue;
    settledLinkIds.add(linkId);
    await reviewTransactionLink(userId, linkId, { decision });
    linksSettled += 1;
  }

  return { appliedRows, unchangedRows: [...unchangedRows], failed, linksSettled };
}

/**
 * Assigns categories to many of one statement's lines in a single request. See
 * the file header for the rules, the scope and why the batch is not all-or-nothing.
 */
export async function setCategoriesBulk(userId: string, statementId: string, input: FdhBulkSetCategoryInput): Promise<BulkSetCategoryResult> {
  const review = await getStatementCategoryReview(userId, statementId); // 404 for a statement that is not the caller's
  if (input.mode === 'category') {
    // Same rule and message as the single save, checked BEFORE any line is touched.
    const { data: chosen } = await categoriesRepository.getById(input.category_id as string);
    if (!chosen || !chosen.active || chosen.economic_type === 'unknown') {
      throw new CategoryReviewError('invalid_input', 'Choose a category from the list.');
    }
  }
  const needsById = new Map(review.needs_decision.map((i) => [i.id, i] as const));
  const rowsById = await loadStatementRows(userId, statementId, input.transaction_ids);

  const failed: BulkCategoryFailure[] = [];
  const failRow = (id: string, row: TxnRow | undefined, code: BulkCategoryFailureCode, message: string) =>
    failed.push({ transaction_id: id, description: row?.description_clean ?? null, code, message });

  // Which category each eligible line gets.
  const byCategory = new Map<string, TxnRow[]>();
  for (const id of input.transaction_ids) {
    const row = rowsById.get(id);
    if (!row) {
      failRow(id, undefined, 'not_found', 'This transaction was not found on this statement.');
      continue;
    }
    if (row.approval_status === 'approved') {
      failRow(id, row, 'already_approved', 'Already approved. Reopen the statement to change it.');
      continue;
    }
    const need = needsById.get(id);
    if (need && !need.can_choose_category) {
      failRow(id, row, 'cannot_choose_here', 'This one has to be decided on its own page. Use "Open to decide".');
      continue;
    }
    const categoryId = input.mode === 'category' ? input.category_id ?? null : need?.suggested_category_id ?? null;
    if (!categoryId) {
      failRow(id, row, 'no_suggestion', 'There is no suggested category for this transaction. Choose one.');
      continue;
    }
    byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), row]);
  }

  const appliedRows: Array<{ row: TxnRow; categoryId: string; type: FdhEconomicTransactionType }> = [];
  const unchangedRows: Array<{ row: TxnRow; categoryId: string; type: FdhEconomicTransactionType }> = [];
  const counts = new Map<string, { label: string; count: number }>();
  const settledLinkIds = new Set<string>();
  let linksSettled = 0;

  for (const [categoryId, rows] of byCategory) {
    const { data: category } = await categoriesRepository.getById(categoryId);
    if (!category || !category.active || category.economic_type === 'unknown') {
      for (const r of rows) failRow(r.id, r, 'invalid_category', 'Choose a category from the list.');
      continue;
    }
    const outcome = await applyCategoryToRows(userId, statementId, category, rows, settledLinkIds);
    failed.push(...outcome.failed);
    linksSettled += outcome.linksSettled;
    for (const row of outcome.appliedRows) appliedRows.push({ row, categoryId, type: category.economic_type });
    for (const row of outcome.unchangedRows) unchangedRows.push({ row, categoryId, type: category.economic_type });
    const done = outcome.appliedRows.length + outcome.unchangedRows.length;
    if (done > 0) counts.set(categoryId, { label: category.display_name, count: done });
  }

  // Remember each payee ONCE (the line's own words), only for lines the user's choice now stands on.
  let payeesRemembered = 0;
  const payeesNotRemembered: Array<{ payee_key: string; message: string }> = [];
  if (input.remember_payee) {
    const perPayee = new Map<string, Map<string, FdhEconomicTransactionType>>();
    for (const { row, categoryId, type } of [...appliedRows, ...unchangedRows]) {
      const key = derivePayeeKey(row.description_clean ?? row.merchant_raw);
      if (!key) continue;
      perPayee.set(key, (perPayee.get(key) ?? new Map()).set(categoryId, type));
    }
    const work: Array<{ key: string; categoryId: string; type: FdhEconomicTransactionType }> = [];
    for (const [key, cats] of perPayee) {
      if (cats.size > 1) {
        payeesNotRemembered.push({ payee_key: key, message: 'This payee was given different categories in this batch, so it was not remembered.' });
        continue;
      }
      const [categoryId, type] = [...cats.entries()][0];
      work.push({ key, categoryId, type });
    }
    const results = await mapConcurrent(work, CONCURRENCY, async (w) => {
      try {
        return { w, ok: await rememberPayee(userId, w.key, w.categoryId, w.type) };
      } catch {
        return { w, ok: false };
      }
    });
    for (const r of results) {
      if (r.ok) payeesRemembered += 1;
      else payeesNotRemembered.push({ payee_key: r.w.key, message: 'We could not save this payee for next time.' });
    }
    if (payeesRemembered > 0) {
      try {
        await classifyUserTransactions(userId); // same best-effort follow-up as the single save
      } catch {
        // The rules are saved and apply on the next import.
      }
    }
  }

  const applied = appliedRows.length;
  const unchanged = unchangedRows.length;
  return {
    statement_id: statementId,
    mode: input.mode,
    requested: input.transaction_ids.length,
    applied,
    unchanged,
    failed,
    applied_ids: appliedRows.map((a) => a.row.id),
    unchanged_ids: unchangedRows.map((a) => a.row.id),
    by_category: [...counts.entries()].map(([category_id, v]) => ({ category_id, label: v.label, count: v.count })),
    links_settled: linksSettled,
    payees_remembered: payeesRemembered,
    payees_not_remembered: payeesNotRemembered,
    approved: 0,
    outcome:
      applied === 0 && unchanged === 0
        ? 'nothing_applied'
        : failed.length > 0
          ? 'partly_applied'
          : applied === 0
            ? 'already_set'
            : 'applied',
  };
}
