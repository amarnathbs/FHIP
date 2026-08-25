/**
 * Financial Data Hub — FDH-8: Approved Financial Activity analytics layer.
 *
 * THE SINGLE SOURCE OF CANONICAL SEMANTICS FOR FDH-8. Every FDH-8 page/API
 * route calls INTO this file rather than recomputing totals itself (spec
 * section 82 — "do not recalculate totals independently inside every page").
 *
 * *** THE CRITICAL INVARIANT (Product Owner emphasis, spec 12/88) ***
 * `approval_status = 'approved'` and `approval_status = 'pending'` rows are
 * fetched into TWO SEPARATE LISTS (`fetchScopedTransactions` is always
 * called once per status) and are NEVER concatenated, unioned or passed to
 * the same aggregation call together, anywhere in this file. `getOverview`
 * is the one place both exist side by side, and even there they produce two
 * distinct result objects (`approved` / `pending`) — nothing sums them into
 * one number. `tests/unit/fdh8PendingExclusion.test.ts` proves this with a
 * real negative control (see that file for the failing-oracle demonstration
 * this invariant is checked against).
 *
 * REUSE, NOT A COMPETING ENGINE (spec 5, 82). Headline income/expense/net
 * totals are produced by calling FDH-7's own certified, independently
 * oracle-tested `computeApprovedFinancialSummary` — the exact function
 * `approvalService.ts` uses to persist `fdh_approved_financial_summaries`.
 * This file adds NO second definition of "what counts as income" or "what a
 * transfer excludes" — it only adds grouping (by month / merchant / account)
 * and read-only queries around that one certified function. Duplicate
 * exclusion, split-allocation handling and refund netting are therefore
 * identical to FDH-7's own approved-summary treatment by construction (spec
 * 17-19), not by a parallel reimplementation that could drift.
 *
 * EXACT MONEY (spec 82). All arithmetic in this file goes through
 * `lib/financial-data-hub/domain/money.ts` (`toMinorUnits`/`fromMinorUnits`/
 * `sumMoney`) or through `computeApprovedFinancialSummary` itself — there is
 * no `reduce((x, t) => x + Number(t.amount), 0)` anywhere below.
 *
 * MULTI-CURRENCY (spec 64-69). Every aggregate is grouped BY CURRENCY first;
 * nothing here ever adds an AUD amount to an INR amount. A household with
 * accounts in two currencies gets two sets of totals, never one blended sum.
 */

import { createClient } from '@/lib/supabase/server';

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;
import {
  computeApprovedFinancialSummary,
  type ApprovedFinancialSummaryTotals,
  type ApprovedSummaryAllocation,
  type ApprovedSummaryRefundLink,
  type ApprovedSummaryTransaction,
} from '../domain/approvedSummary';
import { fromMinorUnits, sumMoney, toMinorUnits } from '../domain/money';
import type { FdhCategory, FdhMerchant } from '../domain/types';
import type { FdhEconomicTransactionType, FdhTransactionApprovalStatus } from '../constants/enums';
import { categoriesRepository, merchantsRepository } from '../repositories/index';
import { fetchAllRows } from '../bank-csv/pagination';
import type { DateRange } from './period';

// ---------------------------------------------------------------------------
// Shared scope / filter types
// ---------------------------------------------------------------------------

export interface ActivityFilters {
  period: DateRange;
  /** Restrict to one `fdh_financial_accounts.id`. Omitted = every account
   * the user owns (household aggregate — spec 41-43). */
  accountId?: string | null;
}

const DUPLICATE_EXCLUDED_DEDUP_STATUSES = ['duplicate_confirmed', 'user_confirmed_duplicate'] as const;

interface RawTxnRow {
  id: string;
  financial_account_id: string;
  transaction_date: string;
  description_clean: string | null;
  merchant_id: string | null;
  amount_original: number;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;
  dedup_status: ApprovedSummaryTransaction['dedup_status'];
  review_status: string;
  approval_status: FdhTransactionApprovalStatus;
  recurring_transaction_id: string | null;
  created_at: string;
}

interface RawAllocationRow {
  transaction_id: string;
  economic_transaction_type: FdhEconomicTransactionType;
  category_id: string | null;
  amount: number;
  currency_code: string;
}

export interface ScopedTransaction extends RawTxnRow {
  allocations: RawAllocationRow[];
}

const TXN_COLUMNS =
  'id, financial_account_id, transaction_date, description_clean, merchant_id, amount_original, ' +
  'currency_original, credit_debit, economic_transaction_type, category_id, subcategory_id, dedup_status, ' +
  'review_status, approval_status, recurring_transaction_id, created_at';

/**
 * Fetches every transaction for `userId` in `filters.period`/`filters.accountId`
 * at EXACTLY one `approval_status` — the caller decides which, and never
 * mixes the two calls together (see file header). RLS (`auth.uid() =
 * user_id`) is the enforced boundary; the explicit `.eq('user_id', userId)`
 * below is defence in depth, matching every other FDH repository.
 */
async function fetchScopedTransactions(
  supabase: SupabaseClient,
  userId: string,
  approvalStatus: FdhTransactionApprovalStatus,
  filters: ActivityFilters,
): Promise<ScopedTransaction[]> {
  // PostgREST caps ANY unbounded select at this project's `db-max-rows`
  // (1,000 — see `bank-csv/pagination.ts`'s header) and reports truncation
  // only via a response header the Supabase JS client does not surface as
  // an error. A household with more than 1,000 approved/pending
  // transactions in the requested period would therefore have silently had
  // its headline totals computed over a truncated slice. `fetchAllRows()`
  // is the SAME established fix FDH-6 applied to this identical defect
  // class in its own repositories (`FDH6_SCALE_CERTIFICATION.md`) — paging
  // past the cap with deterministic, unique ordering rather than a second
  // pagination concept.
  const txns = await fetchAllRows<RawTxnRow>(() => {
    let query = supabase
      .from('fdh_transactions')
      .select(TXN_COLUMNS)
      .eq('user_id', userId)
      .eq('approval_status', approvalStatus)
      .gte('transaction_date', filters.period.from)
      .lte('transaction_date', filters.period.to);
    if (filters.accountId) query = query.eq('financial_account_id', filters.accountId);
    return query.order('transaction_date', { ascending: true }).order('id', { ascending: true }).returns<RawTxnRow[]>();
  });
  if (txns.length === 0) return [];

  const ids = txns.map((t) => t.id);
  // Allocations are fetched in bounded ID-batches (PostgREST's `.in()` list
  // itself has no practical size issue here, but the RESPONSE is subject to
  // the identical 1,000-row cap as above when a household has many split
  // allocations in scope) — same `fetchAllRows()` treatment.
  const CHUNK = 200; // ids per .in() batch — keeps URL/query size bounded
  const allocs: RawAllocationRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const idBatch = ids.slice(i, i + CHUNK);
    const batch = await fetchAllRows<RawAllocationRow>(() =>
      supabase
        .from('fdh_transaction_allocations')
        .select('transaction_id, economic_transaction_type, category_id, amount, currency_code')
        .eq('user_id', userId)
        .in('transaction_id', idBatch)
        .order('transaction_id', { ascending: true })
        .order('id', { ascending: true })
        .returns<RawAllocationRow[]>(),
    );
    allocs.push(...batch);
  }

  const byTxn = new Map<string, RawAllocationRow[]>();
  for (const a of allocs) byTxn.set(a.transaction_id, [...(byTxn.get(a.transaction_id) ?? []), a]);
  return txns.map((t) => ({ ...t, allocations: byTxn.get(t.id) ?? [] }));
}

/** Same query FDH-7's `approvalService.ts` uses to build refund-netting
 * input — replicated read-only here (not imported, since it is a private
 * helper of that module) rather than adding a cross-module dependency. */
async function fetchConfirmedRefundLinks(
  supabase: SupabaseClient,
  userId: string,
  transactionIds: readonly string[],
): Promise<ApprovedSummaryRefundLink[]> {
  if (transactionIds.length === 0) return [];
  // Same PostgREST `db-max-rows` truncation risk as `fetchScopedTransactions`
  // above — a household with more than 1,000 confirmed refund/reversal
  // links would otherwise silently miss refund netting past row 1,000.
  const data = await fetchAllRows<{ transaction_id_from: string; transaction_id_to: string | null }>(() =>
    supabase
      .from('fdh_transaction_links')
      .select('transaction_id_from, transaction_id_to, link_type, status')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .in('link_type', ['refund_original', 'reversal_original'])
      .order('id', { ascending: true })
      .returns<{ transaction_id_from: string; transaction_id_to: string | null }[]>(),
  );

  const idSet = new Set(transactionIds);
  return data
    .filter((l) => l.transaction_id_to && (idSet.has(l.transaction_id_from) || idSet.has(l.transaction_id_to)))
    .map((l) => ({ refundTransactionId: l.transaction_id_from, originalTransactionId: l.transaction_id_to as string }));
}

function toOracleInput(t: ScopedTransaction): ApprovedSummaryTransaction {
  return {
    id: t.id,
    amount_original: t.amount_original,
    currency_original: t.currency_original,
    economic_transaction_type: t.economic_transaction_type,
    category_id: t.category_id,
    dedup_status: t.dedup_status,
    allocations: t.allocations.map<ApprovedSummaryAllocation>((a) => ({
      economic_transaction_type: a.economic_transaction_type,
      category_id: a.category_id,
      amount: a.amount,
      currency_code: a.currency_code,
    })),
  };
}

function groupByCurrency(txns: ScopedTransaction[]): Map<string, ScopedTransaction[]> {
  const map = new Map<string, ScopedTransaction[]>();
  for (const t of txns) {
    const list = map.get(t.currency_original);
    if (list) list.push(t);
    else map.set(t.currency_original, [t]);
  }
  return map;
}

export interface CurrencyTotals extends ApprovedFinancialSummaryTotals {
  /** income_total - expense_total, exact, same currency (spec 15). */
  net_cash_flow: number;
}

/** Runs the FDH-7 oracle once per currency present in `txns`. This is the
 * ONLY function in FDH-8 that calls `computeApprovedFinancialSummary` — every
 * headline total (Overview, per-account, pending-disclosure) goes through it. */
async function computeTotalsByCurrency(
  supabase: SupabaseClient,
  userId: string,
  txns: ScopedTransaction[],
): Promise<CurrencyTotals[]> {
  const byCurrency = groupByCurrency(txns);
  const results: CurrencyTotals[] = [];
  for (const [currency, group] of byCurrency) {
    const refundLinks = await fetchConfirmedRefundLinks(supabase, userId, group.map((t) => t.id));
    const totals = computeApprovedFinancialSummary(currency, group.map(toOracleInput), refundLinks);
    results.push({ ...totals, net_cash_flow: sumMoney([totals.income_total, -totals.expense_total], currency) });
  }
  return results.sort((a, b) => a.currency_code.localeCompare(b.currency_code));
}

// ---------------------------------------------------------------------------
// Master-data lookup (categories/merchants) — cached per call, not global,
// so a stale process-lifetime cache can never serve one tenant's request
// with data fetched for another (there is none here, but the shape matters).
// ---------------------------------------------------------------------------

async function loadCategoryMap(): Promise<Map<string, FdhCategory>> {
  const { data, error } = await categoriesRepository.listActiveAll();
  if (error) throw new Error(`financialActivityAnalytics: could not list categories: ${error.message}`);
  return new Map((data ?? []).map((c) => [c.id, c]));
}

async function loadMerchantMap(): Promise<Map<string, FdhMerchant>> {
  const { data, error } = await merchantsRepository.listActiveAll();
  if (error) throw new Error(`financialActivityAnalytics: could not list merchants: ${error.message}`);
  return new Map((data ?? []).map((m) => [m.id, m]));
}

// ---------------------------------------------------------------------------
// getOverview
// ---------------------------------------------------------------------------

export interface PendingDisclosure {
  currency_code: string;
  /** Count of pending, non-confirmed-duplicate transactions in scope. */
  transaction_count: number;
  income_total: number;
  expense_total: number;
  net_amount: number;
}

export interface ReviewCounts {
  needs_attention: number;
  transfers: number;
  possible_duplicates: number;
  uncategorised: number;
  recurring_candidates: number;
}

export interface OverviewResult {
  period: DateRange;
  /** Approved-only headline totals (spec 11, 14, 15). NEVER includes any
   * pending transaction. This is the number rendered as "Income"/"Expenses"/
   * "Net Cash Flow" without qualification. */
  approved: CurrencyTotals[];
  /** A SEPARATE figure, always labelled, never merged into `approved` (spec
   * 12, 88). Empty array when there is no pending activity in scope. */
  pending: PendingDisclosure[];
  review: ReviewCounts;
  largestCategory: { categoryId: string; displayName: string; total: number; currencyCode: string } | null;
  recurringActiveCount: number;
  freshness: { latestTransactionDate: string | null; lastStatementProcessedAt: string | null };
}

export async function getOverview(userId: string, filters: ActivityFilters): Promise<OverviewResult> {
  const supabase = await createClient();

  const [approvedTxns, pendingTxns, categoryMap] = await Promise.all([
    fetchScopedTransactions(supabase, userId, 'approved', filters),
    fetchScopedTransactions(supabase, userId, 'pending', filters),
    loadCategoryMap(),
  ]);

  const approved = await computeTotalsByCurrency(supabase, userId, approvedTxns);
  // Pending activity uses the SAME oracle, called on a list that has NEVER
  // touched `approvedTxns` — see the file-header invariant.
  const pendingTotals = await computeTotalsByCurrency(supabase, userId, pendingTxns);
  const pending: PendingDisclosure[] = pendingTotals.map((t) => ({
    currency_code: t.currency_code,
    transaction_count: t.approved_transaction_count, // count within the pending-scoped list
    income_total: t.income_total,
    expense_total: t.expense_total,
    net_amount: t.net_cash_flow,
  }));

  let largestCategory: OverviewResult['largestCategory'] = null;
  for (const currencyTotals of approved) {
    for (const [categoryId, total] of Object.entries(currencyTotals.category_totals)) {
      if (categoryId === 'uncategorised') continue;
      const category = categoryMap.get(categoryId);
      if (!category || category.economic_type !== 'expense') continue;
      if (!largestCategory || total > largestCategory.total) {
        largestCategory = { categoryId, displayName: category.display_name, total, currencyCode: currencyTotals.currency_code };
      }
    }
  }

  const [needsAttention, transfers, duplicates, uncategorised, recurringCandidates, recurringActive, latestTxn, lastStatement] = await Promise.all([
    supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('review_status', ['pending', 'in_review']),
    supabase.from('fdh_transaction_links').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending').in('link_type', ['internal_transfer', 'credit_card_settlement']),
    supabase.from('fdh_duplicate_candidates').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending'),
    supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('economic_transaction_type', 'unknown'),
    supabase.from('fdh_recurring_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'candidate'),
    supabase.from('fdh_recurring_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
    supabase.from('fdh_transactions').select('transaction_date').eq('user_id', userId).order('transaction_date', { ascending: false }).limit(1).maybeSingle<{ transaction_date: string }>(),
    supabase.from('fdh_statement_uploads').select('updated_at').eq('user_id', userId).eq('processing_status', 'approved').order('updated_at', { ascending: false }).limit(1).maybeSingle<{ updated_at: string }>(),
  ]);

  return {
    period: filters.period,
    approved,
    pending,
    review: {
      needs_attention: needsAttention.count ?? 0,
      transfers: transfers.count ?? 0,
      possible_duplicates: duplicates.count ?? 0,
      uncategorised: uncategorised.count ?? 0,
      recurring_candidates: recurringCandidates.count ?? 0,
    },
    largestCategory,
    recurringActiveCount: recurringActive.count ?? 0,
    freshness: {
      // "Latest financial activity date" — the newest transaction date, NOT
      // an upload timestamp (spec 59: never represent upload date as
      // financial-activity date).
      latestTransactionDate: latestTxn.data?.transaction_date ?? null,
      lastStatementProcessedAt: lastStatement.data?.updated_at ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// getSpendingBreakdown / getIncomeBreakdown
//
// Both reuse `category_totals` from the SAME oracle call used by Overview —
// no second definition of "how much did this category cost". FDH categories
// are schema-typed to exactly one `economic_type` (migration 0045), so
// filtering the oracle's combined per-category bucket by the category
// master's `economic_type` correctly separates spending from income without
// re-deriving totals. This inherits one disclosed limitation directly from
// FDH-7's oracle: the 'uncategorised' bucket sums ALL non-transfer economic
// types together (the oracle keys solely by `category_id`, defaulting null
// to 'uncategorised', regardless of type) — so "Needs categorisation" can in
// principle mix an uncategorised expense and an uncategorised income. This
// is documented in FDH8_SPENDING_EXPERIENCE.md / FDH8_INCOME_EXPERIENCE.md
// rather than silently accepted.
// ---------------------------------------------------------------------------

export interface CategoryBreakdownRow {
  categoryId: string | 'uncategorised';
  displayName: string;
  essentialDiscretionary: string | null;
  total: number;
  percentage: number; // 0-100, of total categorised (excludes 'uncategorised') for this economic type
  transactionCount: number;
}

export interface CategoryBreakdownResult {
  period: DateRange;
  currencyCode: string;
  totalApproved: number;
  uncategorisedTotal: number;
  categories: CategoryBreakdownRow[];
}

async function computeCategoryBreakdown(
  userId: string,
  filters: ActivityFilters,
  economicType: 'expense' | 'income',
): Promise<CategoryBreakdownResult[]> {
  const supabase = await createClient();
  const [txns, categoryMap] = await Promise.all([
    fetchScopedTransactions(supabase, userId, 'approved', filters),
    loadCategoryMap(),
  ]);
  const totalsByCurrency = await computeTotalsByCurrency(supabase, userId, txns);

  // Per-category transaction counts (approved, non-duplicate, matching
  // economic type at the row/allocation level) — the oracle does not expose
  // counts per category, only per-currency, so this is computed alongside
  // it using the identical inclusion rules (duplicate exclusion,
  // allocation-vs-parent split handling).
  const countsByCurrency = new Map<string, Map<string, number>>();
  for (const t of txns) {
    if ((DUPLICATE_EXCLUDED_DEDUP_STATUSES as readonly string[]).includes(t.dedup_status)) continue;
    const bump = (currency: string, categoryId: string | null) => {
      const key = categoryId ?? 'uncategorised';
      const perCurrency = countsByCurrency.get(currency) ?? new Map<string, number>();
      perCurrency.set(key, (perCurrency.get(key) ?? 0) + 1);
      countsByCurrency.set(currency, perCurrency);
    };
    if (t.allocations.length > 0) {
      for (const a of t.allocations) {
        if (a.economic_transaction_type === economicType) bump(a.currency_code, a.category_id);
      }
    } else if (t.economic_transaction_type === economicType) {
      bump(t.currency_original, t.category_id);
    }
  }

  return totalsByCurrency.map((currencyTotals) => {
    const counts = countsByCurrency.get(currencyTotals.currency_code) ?? new Map();
    const rows: CategoryBreakdownRow[] = [];
    let categorisedTotalMinor = 0;
    let uncategorisedTotal = 0;

    for (const [categoryId, total] of Object.entries(currencyTotals.category_totals)) {
      if (categoryId === 'uncategorised') {
        uncategorisedTotal = total;
        continue;
      }
      const category = categoryMap.get(categoryId);
      if (!category || category.economic_type !== economicType) continue;
      categorisedTotalMinor += toMinorUnits(total, currencyTotals.currency_code);
      rows.push({
        categoryId,
        displayName: category.display_name,
        essentialDiscretionary: category.essential_discretionary,
        total,
        percentage: 0, // filled below once the categorised total is known
        transactionCount: counts.get(categoryId) ?? 0,
      });
    }
    const categorisedTotal = fromMinorUnits(categorisedTotalMinor, currencyTotals.currency_code);
    for (const row of rows) {
      row.percentage = categorisedTotal > 0 ? Math.round((row.total / categorisedTotal) * 1000) / 10 : 0;
    }
    rows.sort((a, b) => b.total - a.total);

    return {
      period: filters.period,
      currencyCode: currencyTotals.currency_code,
      totalApproved: categorisedTotal,
      uncategorisedTotal,
      categories: rows,
    };
  });
}

export const getSpendingBreakdown = (userId: string, filters: ActivityFilters) =>
  computeCategoryBreakdown(userId, filters, 'expense');

export const getIncomeBreakdown = (userId: string, filters: ActivityFilters) =>
  computeCategoryBreakdown(userId, filters, 'income');

// ---------------------------------------------------------------------------
// getMerchants (spec 29-31)
//
// NEW analytics (not reused from FDH-7, which has no merchant-ranking
// concept) but built on the SAME inclusion rules: approved only, duplicate
// rows excluded, allocation-aware, exact money. Own-account transfer
// counterparties, loan drawdowns, investment funding and ATM withdrawals are
// excluded from the default expense ranking (spec 31) by only counting
// `economic_transaction_type === 'expense'` rows/allocations — transfer,
// investment, debt_principal, cash_withdrawal etc. never reach this bucket
// because merchants only make sense as a concept for genuine expense
// transactions; a merchant total is a MAGNITUDE (spend at that merchant),
// never netted against unrelated refunds elsewhere.
// ---------------------------------------------------------------------------

export interface MerchantRow {
  merchantId: string;
  displayName: string;
  categoryId: string | null;
  essentialDiscretionary: string | null;
  totalSpent: number;
  transactionCount: number;
  averageTransaction: number;
  lastTransactionDate: string;
}

export interface MerchantsResult {
  period: DateRange;
  currencyCode: string;
  merchants: MerchantRow[];
}

export async function getMerchants(
  userId: string,
  filters: ActivityFilters,
  opts: { limit?: number } = {},
): Promise<MerchantsResult[]> {
  const supabase = await createClient();
  const [txns, merchantMap] = await Promise.all([
    fetchScopedTransactions(supabase, userId, 'approved', filters),
    loadMerchantMap(),
  ]);

  const byCurrency = groupByCurrency(txns);
  const results: MerchantsResult[] = [];

  for (const [currency, group] of byCurrency) {
    const perMerchantMinor = new Map<string, number>();
    const perMerchantCount = new Map<string, number>();
    const perMerchantLastDate = new Map<string, string>();

    for (const t of group) {
      if ((DUPLICATE_EXCLUDED_DEDUP_STATUSES as readonly string[]).includes(t.dedup_status)) continue;
      if (!t.merchant_id) continue; // spec 31 — no global merchant for personal transfer recipients (no merchant_id at all)
      const isExpense = t.allocations.length > 0
        ? t.allocations.some((a) => a.economic_transaction_type === 'expense')
        : t.economic_transaction_type === 'expense';
      if (!isExpense) continue;

      const magnitudeMinor = t.allocations.length > 0
        ? t.allocations.filter((a) => a.economic_transaction_type === 'expense').reduce((sum, a) => sum + toMinorUnits(a.amount, a.currency_code), 0)
        : toMinorUnits(t.amount_original, t.currency_original);

      perMerchantMinor.set(t.merchant_id, (perMerchantMinor.get(t.merchant_id) ?? 0) + magnitudeMinor);
      perMerchantCount.set(t.merchant_id, (perMerchantCount.get(t.merchant_id) ?? 0) + 1);
      const prevDate = perMerchantLastDate.get(t.merchant_id);
      if (!prevDate || t.transaction_date > prevDate) perMerchantLastDate.set(t.merchant_id, t.transaction_date);
    }

    const merchants: MerchantRow[] = [];
    for (const [merchantId, totalMinor] of perMerchantMinor) {
      const merchant = merchantMap.get(merchantId);
      const count = perMerchantCount.get(merchantId) ?? 0;
      const total = fromMinorUnits(totalMinor, currency);
      merchants.push({
        merchantId,
        displayName: merchant?.display_name ?? 'Unknown merchant',
        categoryId: merchant?.default_category_id ?? null,
        essentialDiscretionary: merchant?.essential_discretionary ?? null,
        totalSpent: total,
        transactionCount: count,
        averageTransaction: count > 0 ? fromMinorUnits(Math.round(totalMinor / count), currency) : 0,
        lastTransactionDate: perMerchantLastDate.get(merchantId) ?? filters.period.to,
      });
    }
    merchants.sort((a, b) => b.totalSpent - a.totalSpent);
    results.push({ period: filters.period, currencyCode: currency, merchants: opts.limit ? merchants.slice(0, opts.limit) : merchants });
  }
  return results.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

// ---------------------------------------------------------------------------
// getTrend (spec 50-53) — historical actuals only, no forecasting.
// ---------------------------------------------------------------------------

export interface TrendPoint {
  monthKey: string; // 'YYYY-MM'
  incomeTotal: number;
  expenseTotal: number;
  netCashFlow: number;
  transactionCount: number;
}

export interface TrendResult {
  currencyCode: string;
  points: TrendPoint[];
}

export async function getTrend(userId: string, filters: ActivityFilters): Promise<TrendResult[]> {
  const supabase = await createClient();
  const txns = await fetchScopedTransactions(supabase, userId, 'approved', filters);

  const byCurrency = groupByCurrency(txns);
  const results: TrendResult[] = [];
  for (const [currency, group] of byCurrency) {
    const byMonth = new Map<string, ScopedTransaction[]>();
    for (const t of group) {
      const key = t.transaction_date.slice(0, 7);
      const list = byMonth.get(key);
      if (list) list.push(t);
      else byMonth.set(key, [t]);
    }
    const points: TrendPoint[] = [];
    for (const [monthKey, monthTxns] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const refundLinks = await fetchConfirmedRefundLinks(supabase, userId, monthTxns.map((t) => t.id));
      const totals = computeApprovedFinancialSummary(currency, monthTxns.map(toOracleInput), refundLinks);
      points.push({
        monthKey,
        incomeTotal: totals.income_total,
        expenseTotal: totals.expense_total,
        netCashFlow: sumMoney([totals.income_total, -totals.expense_total], currency),
        transactionCount: totals.approved_transaction_count,
      });
    }
    results.push({ currencyCode: currency, points });
  }
  return results.sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

// ---------------------------------------------------------------------------
// getAccounts (spec 41-43) — household aggregate + per-account drilldown.
// Aggregating across accounts is transfer-safe FOR FREE: the oracle never
// routes `economic_transaction_type = 'transfer'` into income/expense
// regardless of how many accounts' transactions are pooled into one call,
// so a CBA -$1,000 / ANZ +$1,000 confirmed transfer pair (both classified
// 'transfer' by FDH-6) contributes $0 to the household's income_total and
// $0 to expense_total — never $1,000 + $1,000 (spec 43's worked example).
// ---------------------------------------------------------------------------

export interface AccountActivityRow {
  accountId: string;
  currencyCode: string;
  incomeTotal: number;
  expenseTotal: number;
  netCashFlow: number;
  transferTotal: number;
  transactionCount: number;
}

export interface AccountsResult {
  period: DateRange;
  household: CurrencyTotals[];
  perAccount: AccountActivityRow[];
}

export async function getAccounts(userId: string, filters: ActivityFilters): Promise<AccountsResult> {
  const supabase = await createClient();
  const txns = await fetchScopedTransactions(supabase, userId, 'approved', { period: filters.period }); // never account-scoped here — household means ALL accounts
  const household = await computeTotalsByCurrency(supabase, userId, txns);

  const byAccount = new Map<string, ScopedTransaction[]>();
  for (const t of txns) {
    const list = byAccount.get(t.financial_account_id);
    if (list) list.push(t);
    else byAccount.set(t.financial_account_id, [t]);
  }

  const perAccount: AccountActivityRow[] = [];
  for (const [accountId, accountTxns] of byAccount) {
    const totals = await computeTotalsByCurrency(supabase, userId, accountTxns);
    for (const t of totals) {
      perAccount.push({
        accountId,
        currencyCode: t.currency_code,
        incomeTotal: t.income_total,
        expenseTotal: t.expense_total,
        netCashFlow: t.net_cash_flow,
        transferTotal: t.transfer_total,
        transactionCount: t.approved_transaction_count,
      });
    }
  }

  return { period: filters.period, household, perAccount };
}

// ---------------------------------------------------------------------------
// getRecurring (spec 37-40) — display only. FDH-6/R8 determine recurrence;
// this reads `fdh_recurring_transactions` as-is. No detection logic here.
// ---------------------------------------------------------------------------

export interface RecurringRow {
  id: string;
  merchantId: string | null;
  merchantDisplayName: string | null;
  frequency: string;
  expectedAmount: number | null;
  currencyCode: string | null;
  status: string;
  /** Only populated when the certified engine itself set it — FDH-8 never
   * invents a future date (spec 40). */
  nextExpectedDate: string | null;
}

export async function getRecurring(userId: string): Promise<RecurringRow[]> {
  const supabase = await createClient();
  const [{ data, error }, merchantMap] = await Promise.all([
    supabase
      .from('fdh_recurring_transactions')
      .select('id, merchant_id, frequency, expected_amount, currency_code, status, next_expected_date')
      .eq('user_id', userId)
      .in('status', ['active', 'candidate', 'paused'])
      .order('status', { ascending: true })
      .returns<{ id: string; merchant_id: string | null; frequency: string; expected_amount: number | null; currency_code: string | null; status: string; next_expected_date: string | null }[]>(),
    loadMerchantMap(),
  ]);
  if (error) throw new Error(`financialActivityAnalytics: could not list recurring transactions: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id,
    merchantId: r.merchant_id,
    merchantDisplayName: r.merchant_id ? merchantMap.get(r.merchant_id)?.display_name ?? null : null,
    frequency: r.frequency,
    expectedAmount: r.expected_amount,
    currencyCode: r.currency_code,
    status: r.status,
    nextExpectedDate: r.next_expected_date,
  }));
}

// ---------------------------------------------------------------------------
// getTransactions (spec 44-49) — the Transaction Explorer. Deterministic
// keyset pagination (transaction_date desc, id desc — same convention as
// `bank-transactions/route.ts` and `review-queue/route.ts`), so requesting
// past 1,000 rows is a normal multi-page walk, never a truncation.
// ---------------------------------------------------------------------------

export type TransactionSort = 'newest' | 'oldest' | 'highest' | 'lowest' | 'merchant';

export interface TransactionExplorerFilters {
  accountId?: string | null;
  categoryId?: string | null;
  merchantId?: string | null;
  economicType?: FdhEconomicTransactionType | null;
  approvalStatus?: FdhTransactionApprovalStatus | null;
  reviewStatus?: string | null;
  isRecurring?: boolean | null;
  isTransfer?: boolean | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  search?: string | null; // description/merchant text match — never raw SQL
  period?: DateRange | null;
}

export interface TransactionExplorerPage {
  transactions: RawTxnRow[];
  pageSize: number;
  sort: TransactionSort;
}

const SORT_COLUMNS: Record<TransactionSort, { column: string; ascending: boolean }[]> = {
  newest: [{ column: 'transaction_date', ascending: false }, { column: 'id', ascending: false }],
  oldest: [{ column: 'transaction_date', ascending: true }, { column: 'id', ascending: true }],
  highest: [{ column: 'amount_original', ascending: false }, { column: 'id', ascending: false }],
  lowest: [{ column: 'amount_original', ascending: true }, { column: 'id', ascending: true }],
  merchant: [{ column: 'merchant_id', ascending: true }, { column: 'id', ascending: true }],
};

const EXPLORER_PAGE_SIZE_DEFAULT = 100;
const EXPLORER_PAGE_SIZE_MAX = 500;

export async function getTransactions(
  userId: string,
  filters: TransactionExplorerFilters,
  paging: { limit?: number; sort?: TransactionSort },
): Promise<TransactionExplorerPage> {
  const supabase = await createClient();
  const sort = paging.sort ?? 'newest';
  const limit = Math.min(Math.max(1, paging.limit ?? EXPLORER_PAGE_SIZE_DEFAULT), EXPLORER_PAGE_SIZE_MAX);

  let query = supabase.from('fdh_transactions').select(TXN_COLUMNS).eq('user_id', userId);
  if (filters.accountId) query = query.eq('financial_account_id', filters.accountId);
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.merchantId) query = query.eq('merchant_id', filters.merchantId);
  if (filters.economicType) query = query.eq('economic_transaction_type', filters.economicType);
  if (filters.approvalStatus) query = query.eq('approval_status', filters.approvalStatus);
  if (filters.reviewStatus) query = query.eq('review_status', filters.reviewStatus);
  if (filters.isTransfer === true) query = query.eq('economic_transaction_type', 'transfer');
  if (filters.isTransfer === false) query = query.neq('economic_transaction_type', 'transfer');
  if (filters.isRecurring === true) query = query.not('recurring_transaction_id', 'is', null);
  if (filters.isRecurring === false) query = query.is('recurring_transaction_id', null);
  if (filters.minAmount != null) query = query.gte('amount_original', filters.minAmount);
  if (filters.maxAmount != null) query = query.lte('amount_original', filters.maxAmount);
  if (filters.period) query = query.gte('transaction_date', filters.period.from).lte('transaction_date', filters.period.to);
  if (filters.search) {
    // description/merchant text only — parameterised via PostgREST `.or`,
    // never string-concatenated SQL (spec 45: "no SQL exposure").
    const needle = filters.search.replace(/[%,()]/g, ' ').trim();
    if (needle) query = query.ilike('description_clean', `%${needle}%`);
  }

  for (const { column, ascending } of SORT_COLUMNS[sort]) query = query.order(column, { ascending });
  query = query.limit(limit);

  const { data, error } = await query.returns<RawTxnRow[]>();
  if (error) throw new Error(`financialActivityAnalytics: could not list transactions: ${error.message}`);

  return { transactions: data ?? [], pageSize: limit, sort };
}
