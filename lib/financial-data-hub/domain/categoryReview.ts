/**
 * Financial Data Hub — category-totals review of one imported statement
 * (PO scope 2026-09-26: "after a bank statement import the user must NOT
 * review every transaction line").
 *
 * PURE, NO DATABASE ACCESS. `services/categoryReviewService.ts` loads the
 * rows and passes them in; the unit tests call this same function with
 * hand-built fixtures.
 *
 * ONE DEFINITION FOR EVERY SURFACE. The review page's tiles, its per-line
 * list and its category groups previously each used their own rule for
 * "uncategorised" and "low confidence" (production, 2026-09-26: tiles said 3
 * uncategorised / 4 low confidence while the list said "Nothing to review").
 * `isUncategorised` / `isLowConfidence` / `isUserDecided` below are the only
 * definitions; the review-queue route and this module both import them.
 *
 *  - UNCATEGORISED: `economic_transaction_type = 'unknown'`. That is the
 *    column the FDH-7 approval gate (migration 0076/0085
 *    `fdh7_transaction_has_blocking_issue`) refuses to approve, and the one
 *    Monthly Surplus reads, so it is the only honest meaning. A row whose
 *    `category_id` was set but whose economic type is still unknown (exactly
 *    the production rows) IS uncategorised: it cannot be approved and counts
 *    nowhere.
 *  - LOW CONFIDENCE: FDH-6's own definition (`classification/reviewReasons.ts`
 *    LOW_CLASSIFICATION_CONFIDENCE): a classification was reached, but its
 *    score is at or below the LOW bucket (0.3). The review-queue tile used
 *    `<= 0.6`, which swept in EVERY approved-global-rule match (the engine
 *    scores all of those MEDIUM = 0.6), contradicting its own documentation
 *    (FDH7_TRANSACTION_REVIEW.md: "consistent with ... LOW boundary"). A
 *    user's own decision is never low confidence.
 *
 * WHAT A GROUP IS. Every not-yet-decided-needing transaction on the
 * statement lands in exactly one group, keyed by category (or economic type
 * when no category is set), direction (money in / money out) and currency.
 * A transaction that needs the user's decision is listed individually
 * instead and is in NO group — so approving a group can never approve a line
 * the user has not had a chance to categorise.
 *
 * WHAT COUNTS (WP-08, Approved Upload -> Canonical programme). This module
 * no longer keeps its own copy of "what is spending". Every rule comes from
 * the ONE canonical definition the read models use,
 * `lib/read-models/core/spendingRules.ts`: the type -> bucket map, the
 * duplicate exclusion, and the refund rule (PO D-01 -- a refund reduces
 * spending ONLY with a CONFIRMED refund_original / reversal_original link;
 * any other refund is shown, never netted). Before, this file mirrored the
 * Dashboard's current-month constants and netted every refund, so the review
 * and Activity could show different spending for the same approved lines.
 */

import type { FdhEconomicTransactionType } from '../constants/enums';
import {
  bucketForType,
  isDuplicateExcluded,
  NON_SPENDING_LABELS,
  REFUND_LIKE_LINK_TYPES,
  type NonSpendingBucket,
} from '@/lib/read-models/core/spendingRules';
import { CLASSIFICATION_CONFIDENCE_SCORE } from '../classification/thresholds';
import { fromMinorUnits, toMinorUnits } from './money';

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------

/** At or below this score an automatic classification is "low confidence"
 * (FDH-6's own boundary — see header). */
export const LOW_CONFIDENCE_CEILING = CLASSIFICATION_CONFIDENCE_SCORE.LOW;

/** Classification methods that record a person's own decision. */
export const USER_DECIDED_METHODS: readonly string[] = ['user_manual', 'user_rule'];

/**
 * What an approved line of this type does to the household's figures, from
 * the canonical bucket map (an ordinary bank account -- card and loan
 * facilities are reviewed on their own statements). `refund_unlinked` is a
 * refund with no confirmed link to the purchase it refunds: shown, never
 * netted, never income (D-01).
 */
export type SurplusEffect = 'income' | 'spending' | 'reduces_spending' | 'refund_unlinked' | 'not_counted' | 'split';

export function surplusEffect(type: FdhEconomicTransactionType, opts: { refundLinked?: boolean } = {}): SurplusEffect {
  const bucket = bucketForType(type, false);
  if (bucket === 'income') return 'income';
  if (bucket === 'spending') return 'spending';
  if (bucket === 'refund') return opts.refundLinked ? 'reduces_spending' : 'refund_unlinked';
  return 'not_counted';
}

/** The visible reason a non-spending group is not counted (e.g. D-03 "Cash —
 * spending unknown"), from the canonical labels. Null for counted groups. */
export function notCountedReason(type: FdhEconomicTransactionType): string | null {
  const bucket = bucketForType(type, false);
  if (bucket === 'unknown') return 'Not counted until it has a category.';
  if (bucket in NON_SPENDING_LABELS) return NON_SPENDING_LABELS[bucket as NonSpendingBucket];
  return null;
}

export interface ClassificationFacts {
  economic_transaction_type: string;
  classification_method: string | null;
  classification_confidence: number | string | null;
  user_override: boolean;
}

export function isUncategorised(t: Pick<ClassificationFacts, 'economic_transaction_type'>): boolean {
  return t.economic_transaction_type === 'unknown';
}

export function isUserDecided(t: Pick<ClassificationFacts, 'classification_method' | 'user_override'>): boolean {
  return t.user_override === true || USER_DECIDED_METHODS.includes(t.classification_method ?? '');
}

function confidenceOf(t: Pick<ClassificationFacts, 'classification_confidence'>): number | null {
  if (t.classification_confidence === null || t.classification_confidence === undefined) return null;
  const n = Number(t.classification_confidence);
  return Number.isFinite(n) ? n : null;
}

export function isLowConfidence(t: ClassificationFacts): boolean {
  if (isUncategorised(t) || isUserDecided(t)) return false;
  const c = confidenceOf(t);
  return c !== null && c <= LOW_CONFIDENCE_CEILING;
}

/** Fully confident = a person decided it, or the engine scored it HIGH
 * (the user's own rule or a verified merchant). A MEDIUM score means "matched
 * an approved general rule on the description wording" — shown to the user as
 * a suggestion to glance at, never hidden. */
export function isFullyConfident(t: ClassificationFacts): boolean {
  if (isUncategorised(t)) return false;
  if (isUserDecided(t)) return true;
  const c = confidenceOf(t);
  return c !== null && c >= CLASSIFICATION_CONFIDENCE_SCORE.HIGH;
}

// ---------------------------------------------------------------------------
// Suggestions for a line the engine could not classify
// ---------------------------------------------------------------------------

/** Wording that, on a bank statement line, means money moved between the
 * account holder's own accounts. Deliberately narrow and literal (no regex
 * from data): a suggestion only pre-selects the dropdown, the user still
 * chooses. Covers the production example "Linked Acc Trns To Savings". */
const OWN_TRANSFER_TERMS = [
  'LINKED ACC', 'TO SAVINGS', 'FROM SAVINGS', 'TRANSFER TO', 'TRANSFER FROM', 'TRNS TO', 'TRNS FROM',
  'TRF TO', 'TRF FROM', 'TFR TO', 'TFR FROM', 'OWN ACCOUNT', 'INTERNAL TRANSFER', 'SELF TRANSFER',
];

export function looksLikeOwnAccountTransfer(description: string | null | undefined): boolean {
  const text = (description ?? '').toUpperCase().replace(/\s+/g, ' ');
  return OWN_TRANSFER_TERMS.some((term) => text.includes(term));
}

/** The literal payee text a remembered personal rule matches on next time.
 *
 * R8's `description_contains` is a LITERAL substring match against the
 * upper-cased, whitespace-collapsed description (`textMatch.toMatchText`), so
 * the key must be a contiguous piece of that text. It is the longest run of
 * consecutive plain words (letters only, 2+ characters) — a token carrying
 * digits or punctuation (a reference number, a date, "R4471", "Q...") ends a
 * run, because those change from one statement to the next — capped at four
 * words. "PAYROLL 5521 Quillfeather Studio Pty Ltd" -> "QUILLFEATHER STUDIO
 * PTY LTD"; "BPAY 889201 Origin Energy Holdings" -> "ORIGIN ENERGY HOLDINGS".
 * Returns null when nothing specific enough (4+ characters) is left. */
export function derivePayeeKey(description: string | null | undefined): string | null {
  const tokens = (description ?? '').toUpperCase().replace(/\s+/g, ' ').trim().split(' ');
  let best: string[] = [];
  let current: string[] = [];
  const consider = () => {
    const candidate = current.slice(0, 4);
    if (candidate.join(' ').length > best.join(' ').length) best = candidate;
    current = [];
  };
  for (const token of tokens) {
    if (/^[A-Z&'-]{2,}$/.test(token)) current.push(token);
    else consider();
  }
  consider();
  const key = best.join(' ');
  return key.length >= 4 ? key : null;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface CategoryReviewTransaction extends ClassificationFacts {
  id: string;
  transaction_date: string;
  description_clean: string | null;
  amount_original: number | string;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  category_id: string | null;
  review_status: string;
  approval_status: 'pending' | 'approved';
  dedup_status: string;
}

export interface CategoryReviewCategory {
  id: string;
  category_key: string;
  display_name: string;
  economic_type: string;
}

/** Everything else the FDH-7 approval gate checks, loaded in bulk by the
 * service. Mirrors `fdh7_transaction_has_blocking_issue` (0076/0085); the
 * database stays the real gate — approval goes through `approveTransaction`,
 * which calls that function and hits the trigger. */
export interface CategoryReviewBlockers {
  /** transaction id -> link types of every still-PENDING link it is a side of. */
  pendingLinkTypesByTxn: ReadonlyMap<string, readonly string[]>;
  pendingDuplicateTxnIds: ReadonlySet<string>;
  blockingReviewItemTxnIds: ReadonlySet<string>;
  invalidSplitTxnIds: ReadonlySet<string>;
  /** Refund lines with a CONFIRMED refund_original / reversal_original link
   * (D-01). Only these reduce spending. Absent = none. */
  confirmedRefundTxnIds?: ReadonlySet<string>;
  /** Lines split into allocations that add up to the line exactly (EXP-G5):
   * they count through their parts, never the parent's own type. */
  splitPartsByTxn?: ReadonlyMap<string, ReadonlyArray<{ economic_transaction_type: FdhEconomicTransactionType; amount: number | string }>>;
}

export const TRANSFER_LIKE_LINK_TYPES: readonly string[] = ['internal_transfer', 'credit_card_settlement', 'investment_funding', 'loan_payment'];

export type NeedsDecisionReason =
  | 'possible_duplicate'
  | 'transfer_check'
  | 'refund_check'
  | 'uncategorised'
  | 'low_confidence'
  | 'other_check';

export const NEEDS_DECISION_REASON_TEXT: Record<NeedsDecisionReason, string> = {
  possible_duplicate: 'This may be a copy of another transaction. Open it to decide.',
  transfer_check: 'This may be a transfer between your own accounts. Choose a category to confirm what it is.',
  refund_check: 'This may be a refund of an earlier purchase. Open it to decide.',
  uncategorised: 'We could not tell what this is. Choose a category.',
  low_confidence: 'We are not sure about this one. Check the category.',
  other_check: 'This needs a quick check before it can be approved. Open it to see why.',
};

/** Reasons the user can settle straight from the category dropdown. */
const CLASSIFIABLE_REASONS: readonly NeedsDecisionReason[] = ['transfer_check', 'uncategorised', 'low_confidence'];

export interface NeedsDecisionItem {
  id: string;
  transaction_date: string;
  description: string | null;
  amount: number;
  currency: string;
  direction: 'in' | 'out';
  reason: NeedsDecisionReason;
  reason_text: string;
  can_choose_category: boolean;
  current_category_id: string | null;
  suggested_category_id: string | null;
}

export interface CategoryGroupLine {
  id: string;
  transaction_date: string;
  description: string | null;
  amount: number;
  approval_status: 'pending' | 'approved';
  fully_confident: boolean;
}

export interface CategoryGroup {
  group_key: string;
  category_id: string | null;
  label: string;
  economic_type: FdhEconomicTransactionType;
  direction: 'in' | 'out';
  currency: string;
  counts_toward: SurplusEffect;
  /** Why a non-counted group is not counted, in words (null when counted). */
  not_counted_reason: string | null;
  count: number;
  total: number;
  pending_count: number;
  pending_total: number;
  approved_count: number;
  fully_confident: boolean;
  status: 'waiting' | 'partly_approved' | 'approved';
  lines: CategoryGroupLine[];
}

export interface CategoryReviewCurrencyTotals {
  currency: string;
  waiting_income: number;
  waiting_spending: number;
  approved_income: number;
  approved_spending: number;
}

/** Approved and waiting figures per calendar month of the transaction date
 * (EXP-G3 copy: the review says which month a figure lands in). */
export interface CategoryReviewMonthTotals {
  month: string;
  currency: string;
  waiting_income: number;
  waiting_spending: number;
  approved_income: number;
  approved_spending: number;
}

export interface CategoryReviewCounts {
  transactions: number;
  approved: number;
  waiting_for_approval: number;
  needs_decision: number;
  uncategorised: number;
  low_confidence: number;
  ready_to_approve: number;
  duplicates_removed: number;
}

export interface CategoryReview {
  counts: CategoryReviewCounts;
  totals: CategoryReviewCurrencyTotals[];
  months: CategoryReviewMonthTotals[];
  groups: CategoryGroup[];
  needs_decision: NeedsDecisionItem[];
}

const TYPE_LABEL: Record<string, string> = {
  income: 'Other income',
  expense: 'Other spending',
  transfer: 'Transfers between accounts',
  investment: 'Investments',
  debt_principal: 'Loan repayments',
  debt_interest: 'Interest charged',
  refund: 'Refunds',
  asset_purchase: 'Investment purchases',
  asset_sale: 'Investment sales',
  tax: 'Tax',
  fee: 'Fees',
  cash_withdrawal: 'Cash withdrawals',
};

export function groupKeyFor(
  t: Pick<CategoryReviewTransaction, 'category_id' | 'economic_transaction_type' | 'credit_debit' | 'currency_original'>,
  opts: { refundLinked?: boolean } = {},
): string {
  const head = t.category_id ? `cat:${t.category_id}` : `type:${t.economic_transaction_type}`;
  // D-01: linked and unlinked refunds count differently, so they are never
  // in the same group (a group has one "counts toward" answer).
  const refundTail = t.economic_transaction_type === 'refund' && opts.refundLinked ? '|refund-linked' : '';
  return `${head}|${t.credit_debit === 'credit' ? 'in' : 'out'}|${t.currency_original}${refundTail}`;
}

function needsDecisionReason(t: CategoryReviewTransaction, b: CategoryReviewBlockers): NeedsDecisionReason | null {
  if (b.pendingDuplicateTxnIds.has(t.id)) return 'possible_duplicate';
  const linkTypes = b.pendingLinkTypesByTxn.get(t.id) ?? [];
  if (linkTypes.some((l) => TRANSFER_LIKE_LINK_TYPES.includes(l))) return 'transfer_check';
  if (linkTypes.some((l) => REFUND_LIKE_LINK_TYPES.has(l))) return 'refund_check';
  const isSplit = b.splitPartsByTxn?.has(t.id) ?? false;
  if (!isSplit && isUncategorised(t)) return 'uncategorised';
  if (!isSplit && isLowConfidence(t)) return 'low_confidence';
  if (b.blockingReviewItemTxnIds.has(t.id) || b.invalidSplitTxnIds.has(t.id) || linkTypes.length > 0) return 'other_check';
  return null;
}

function suggestedCategoryId(
  t: CategoryReviewTransaction,
  linkTypes: readonly string[],
  categoryByKey: ReadonlyMap<string, CategoryReviewCategory>,
): string | null {
  // A still-pending match the engine proposed is the strongest hint...
  if (linkTypes.includes('credit_card_settlement')) return categoryByKey.get('credit_card_payment')?.id ?? t.category_id;
  if (linkTypes.includes('internal_transfer')) return categoryByKey.get('transfer_own_account')?.id ?? t.category_id;
  // ...then the category already on the line...
  if (!isUncategorised(t) && t.category_id) return t.category_id;
  // ...then own-account transfer wording on an unrecognised line.
  if (looksLikeOwnAccountTransfer(t.description_clean)) return categoryByKey.get('transfer_own_account')?.id ?? t.category_id;
  return t.category_id;
}

/** Builds the category-totals review for one statement's transactions. */
export function buildCategoryReview(
  transactions: readonly CategoryReviewTransaction[],
  categories: readonly CategoryReviewCategory[],
  blockers: CategoryReviewBlockers,
): CategoryReview {
  const categoryById = new Map(categories.map((c) => [c.id, c] as const));
  const categoryByKey = new Map(categories.map((c) => [c.category_key, c] as const));

  const groupMinor = new Map<string, { total: number; pending: number }>();
  const groups = new Map<string, CategoryGroup>();
  const needsDecision: NeedsDecisionItem[] = [];
  const totalsMinor = new Map<string, { wi: number; ws: number; ai: number; as: number }>();
  const monthsMinor = new Map<string, { month: string; currency: string; wi: number; ws: number; ai: number; as: number }>();
  const confirmedRefunds = blockers.confirmedRefundTxnIds ?? new Set<string>();

  let approved = 0;
  let waiting = 0;
  let uncategorised = 0;
  let lowConfidence = 0;
  let duplicatesRemoved = 0;

  const sorted = [...transactions].sort((a, b) =>
    a.transaction_date < b.transaction_date ? -1 : a.transaction_date > b.transaction_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  for (const t of sorted) {
    if (isDuplicateExcluded(t.dedup_status)) {
      duplicatesRemoved += 1;
      continue;
    }
    const amount = Number(t.amount_original);
    const minor = toMinorUnits(amount, t.currency_original);
    const direction: 'in' | 'out' = t.credit_debit === 'credit' ? 'in' : 'out';
    const isApproved = t.approval_status === 'approved';
    if (isApproved) approved += 1;
    else waiting += 1;
    const splitLine = blockers.splitPartsByTxn?.has(t.id) ?? false;
    if (!isApproved && !splitLine && isUncategorised(t)) uncategorised += 1;
    if (!isApproved && !splitLine && isLowConfidence(t)) lowConfidence += 1;

    const reason = isApproved ? null : needsDecisionReason(t, blockers);
    if (reason) {
      const linkTypes = blockers.pendingLinkTypesByTxn.get(t.id) ?? [];
      needsDecision.push({
        id: t.id,
        transaction_date: t.transaction_date,
        description: t.description_clean,
        amount,
        currency: t.currency_original,
        direction,
        reason,
        reason_text: NEEDS_DECISION_REASON_TEXT[reason],
        can_choose_category: CLASSIFIABLE_REASONS.includes(reason),
        current_category_id: t.category_id,
        suggested_category_id: suggestedCategoryId(t, linkTypes, categoryByKey),
      });
      continue;
    }

    const type = t.economic_transaction_type as FdhEconomicTransactionType;
    const refundLinked = confirmedRefunds.has(t.id);
    const splitParts = blockers.splitPartsByTxn?.get(t.id) ?? null;
    const key = splitParts ? `split|${direction}|${t.currency_original}` : groupKeyFor(t, { refundLinked: type === 'refund' && refundLinked });
    let g = groups.get(key);
    if (!g) {
      const category = t.category_id ? categoryById.get(t.category_id) : undefined;
      g = {
        group_key: key,
        category_id: t.category_id,
        label: splitParts ? 'Split transactions' : category?.display_name ?? TYPE_LABEL[type] ?? 'Other',
        economic_type: type,
        direction,
        currency: t.currency_original,
        counts_toward: splitParts ? 'split' : surplusEffect(type, { refundLinked }),
        not_counted_reason: splitParts
          ? null
          : surplusEffect(type, { refundLinked }) === 'refund_unlinked'
            ? 'A refund not yet linked to the purchase it refunds is shown here but not taken off your spending.'
            : notCountedReason(type),
        count: 0,
        total: 0,
        pending_count: 0,
        pending_total: 0,
        approved_count: 0,
        fully_confident: true,
        status: 'waiting',
        lines: [],
      };
      groups.set(key, g);
      groupMinor.set(key, { total: 0, pending: 0 });
    }
    const gm = groupMinor.get(key)!;
    g.count += 1;
    gm.total += minor;
    if (isApproved) g.approved_count += 1;
    else {
      g.pending_count += 1;
      gm.pending += minor;
    }
    const confident = isFullyConfident(t);
    if (!confident) g.fully_confident = false;
    g.lines.push({
      id: t.id,
      transaction_date: t.transaction_date,
      description: t.description_clean,
      amount,
      approval_status: t.approval_status,
      fully_confident: confident,
    });

    const tm = totalsMinor.get(t.currency_original) ?? { wi: 0, ws: 0, ai: 0, as: 0 };
    const monthKey = `${t.transaction_date.slice(0, 7)}|${t.currency_original}`;
    const mm = monthsMinor.get(monthKey) ?? { month: t.transaction_date.slice(0, 7), currency: t.currency_original, wi: 0, ws: 0, ai: 0, as: 0 };
    // A split line counts through its parts (the canonical rule), never its
    // own type; an unsplit line through its own type.
    const parts = splitParts
      ? splitParts.map((p) => ({ type: p.economic_transaction_type, minor: toMinorUnits(Number(p.amount), t.currency_original) }))
      : [{ type, minor }];
    for (const part of parts) {
      const effect = surplusEffect(part.type, { refundLinked });
      const signed = effect === 'spending' ? part.minor : effect === 'reduces_spending' ? -part.minor : 0;
      for (const bucket of [tm, mm]) {
        if (effect === 'income') {
          if (isApproved) bucket.ai += part.minor;
          else bucket.wi += part.minor;
        } else if (signed !== 0) {
          if (isApproved) bucket.as += signed;
          else bucket.ws += signed;
        }
      }
    }
    totalsMinor.set(t.currency_original, tm);
    monthsMinor.set(monthKey, mm);
  }

  const groupList = [...groups.values()].map((g) => {
    const gm = groupMinor.get(g.group_key)!;
    g.total = fromMinorUnits(gm.total, g.currency);
    g.pending_total = fromMinorUnits(gm.pending, g.currency);
    g.status = g.pending_count === 0 ? 'approved' : g.approved_count === 0 ? 'waiting' : 'partly_approved';
    return g;
  });

  const effectRank: Record<SurplusEffect, number> = { income: 0, spending: 1, split: 2, reduces_spending: 3, refund_unlinked: 4, not_counted: 5 };
  groupList.sort((a, b) =>
    effectRank[a.counts_toward] - effectRank[b.counts_toward]
    || b.total - a.total
    || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    || (a.group_key < b.group_key ? -1 : 1),
  );

  const totals: CategoryReviewCurrencyTotals[] = [...totalsMinor.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, m]) => ({
      currency,
      waiting_income: fromMinorUnits(m.wi, currency),
      waiting_spending: fromMinorUnits(m.ws, currency),
      approved_income: fromMinorUnits(m.ai, currency),
      approved_spending: fromMinorUnits(m.as, currency),
    }));

  const months: CategoryReviewMonthTotals[] = [...monthsMinor.values()]
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((m) => ({
      month: m.month,
      currency: m.currency,
      waiting_income: fromMinorUnits(m.wi, m.currency),
      waiting_spending: fromMinorUnits(m.ws, m.currency),
      approved_income: fromMinorUnits(m.ai, m.currency),
      approved_spending: fromMinorUnits(m.as, m.currency),
    }));

  return {
    months,
    counts: {
      transactions: transactions.length,
      approved,
      waiting_for_approval: waiting,
      needs_decision: needsDecision.length,
      uncategorised,
      low_confidence: lowConfidence,
      ready_to_approve: waiting - needsDecision.length,
      duplicates_removed: duplicatesRemoved,
    },
    totals,
    groups: groupList,
    needs_decision: needsDecision,
  };
}

/** The ids a group approval may approve: that group's still-pending lines,
 * nothing else. Returns null when the key names no current group. */
export function pendingIdsForGroup(review: CategoryReview, groupKey: string): string[] | null {
  const group = review.groups.find((g) => g.group_key === groupKey);
  if (!group) return null;
  return group.lines.filter((l) => l.approval_status === 'pending').map((l) => l.id);
}

/** Which way the user's category choice settles a still-pending link this
 * transaction is a side of. The user saying "this is an own-account transfer"
 * confirms a transfer match; saying "this is groceries" rejects it. Refund /
 * reversal links are never settled from the dropdown (they are listed with an
 * "open to decide" action instead). */
export function linkDecisionForChosenType(
  linkType: string,
  chosenType: FdhEconomicTransactionType,
): 'confirm' | 'reject' | null {
  if (!TRANSFER_LIKE_LINK_TYPES.includes(linkType)) return null;
  const compatible: Record<string, readonly FdhEconomicTransactionType[]> = {
    internal_transfer: ['transfer'],
    credit_card_settlement: ['transfer'],
    loan_payment: ['transfer', 'debt_principal', 'debt_interest'],
    investment_funding: ['transfer', 'investment', 'asset_purchase'],
  };
  return (compatible[linkType] ?? []).includes(chosenType) ? 'confirm' : 'reject';
}

// ---------------------------------------------------------------------------
// Statement-level notes (EXP-G15 / EXP-G17): open review items that are about
// the whole statement rather than one line, in words.
// ---------------------------------------------------------------------------

/** title_code of the blocking item a possibly-incomplete AI reading raises. */
export const AI_EXTRACTION_INCOMPLETE_TITLE_CODE = 'bank_statement.ai_extraction_incomplete';
/** title_code of the info note an overlapping statement raises. */
export const STATEMENT_OVERLAP_TITLE_CODE = 'bank_statement.overlaps_prior_statement';
/** Statement-level items the user may settle themselves (after checking the
 * statement). Nothing else can be acknowledged away. */
export const ACKNOWLEDGEABLE_STATEMENT_TITLE_CODES: readonly string[] = [AI_EXTRACTION_INCOMPLETE_TITLE_CODE];

export interface StatementReviewItemRow {
  id: string;
  severity: 'info' | 'warning' | 'blocking';
  title_code: string;
  context_json: Record<string, unknown> | null;
}

export interface StatementNote {
  id: string;
  severity: 'info' | 'warning' | 'blocking';
  title_code: string;
  text: string;
  can_acknowledge: boolean;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
}

export function statementNoteText(item: StatementReviewItemRow): string {
  const ctx = item.context_json ?? {};
  switch (item.title_code) {
    case AI_EXTRACTION_INCOMPLETE_TITLE_CODE: {
      const rows = num((ctx as { rows_read?: unknown }).rows_read);
      return `This statement was read by AI and may be missing transactions${rows !== null ? ` (${rows} read)` : ''}. `
        + 'Check it against your statement. Add any missing transactions by hand, then confirm that every transaction is listed. '
        + 'Until then this statement cannot be approved.';
    }
    case STATEMENT_OVERLAP_TITLE_CODE: {
      const from = (ctx as { overlap_from?: unknown }).overlap_from;
      const to = (ctx as { overlap_to?: unknown }).overlap_to;
      const range = typeof from === 'string' && typeof to === 'string' ? ` (${from} to ${to})` : '';
      return `This statement covers dates you have already imported for this account${range}. `
        + 'Lines that match an earlier import are removed as duplicates or listed above for you to check, so nothing is counted twice.';
    }
    case 'bank_pdf.reconciliation_failed':
    case 'bank_csv.reconciliation_failed':
      return 'The transactions read from this statement do not add up to its closing balance. Some lines may be missing or misread.';
    case 'bank_pdf.duplicate_candidates_pending_review':
    case 'bank_csv.duplicate_candidates_pending_review':
      return 'Some lines may be copies of transactions you imported before. They are listed above for you to decide.';
    case 'bank_csv.account_identity_ambiguous':
      return 'We could not tell which of your accounts this statement belongs to.';
    default:
      return item.severity === 'blocking'
        ? 'This statement has an open check that must be settled before it can be approved.'
        : 'This statement has a note for you to read.';
  }
}

export function buildStatementNotes(items: readonly StatementReviewItemRow[]): StatementNote[] {
  const rank = { blocking: 0, warning: 1, info: 2 } as const;
  return [...items]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.id < b.id ? -1 : 1))
    .map((item) => ({
      id: item.id,
      severity: item.severity,
      title_code: item.title_code,
      text: statementNoteText(item),
      can_acknowledge: ACKNOWLEDGEABLE_STATEMENT_TITLE_CODES.includes(item.title_code),
    }));
}
