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
 * WHAT COUNTS TOWARD MONTHLY SURPLUS. `SURPLUS_*` below mirror
 * `lib/services/dashboardData.ts`'s BANK_*_TRANSACTION_TYPES exactly (pinned
 * by `tests/unit/fdhCategoryReview.test.ts`), so the review never tells the
 * user a group "counts toward your spending" when the dashboard would ignore
 * it, or vice versa.
 */

import type { FdhEconomicTransactionType } from '../constants/enums';
import { CLASSIFICATION_CONFIDENCE_SCORE } from '../classification/thresholds';
import { fromMinorUnits, toMinorUnits } from './money';

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------

export const SURPLUS_INCOME_TYPES: readonly FdhEconomicTransactionType[] = ['income'];
export const SURPLUS_SPENDING_TYPES: readonly FdhEconomicTransactionType[] = ['expense', 'fee', 'debt_interest', 'tax'];
export const SURPLUS_REFUND_TYPE: FdhEconomicTransactionType = 'refund';

/** At or below this score an automatic classification is "low confidence"
 * (FDH-6's own boundary — see header). */
export const LOW_CONFIDENCE_CEILING = CLASSIFICATION_CONFIDENCE_SCORE.LOW;

/** Classification methods that record a person's own decision. */
export const USER_DECIDED_METHODS: readonly string[] = ['user_manual', 'user_rule'];

/** Rows R7/FDH-7 already treat as removed duplicates — never counted. */
export const DUPLICATE_EXCLUDED_DEDUP_STATUSES: readonly string[] = ['duplicate_confirmed', 'user_confirmed_duplicate'];

export type SurplusEffect = 'income' | 'spending' | 'reduces_spending' | 'not_counted';

export function surplusEffect(type: FdhEconomicTransactionType): SurplusEffect {
  if (SURPLUS_INCOME_TYPES.includes(type)) return 'income';
  if (SURPLUS_SPENDING_TYPES.includes(type)) return 'spending';
  if (type === SURPLUS_REFUND_TYPE) return 'reduces_spending';
  return 'not_counted';
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
}

export const TRANSFER_LIKE_LINK_TYPES: readonly string[] = ['internal_transfer', 'credit_card_settlement', 'investment_funding', 'loan_payment'];
export const REFUND_LIKE_LINK_TYPES: readonly string[] = ['refund_original', 'reversal_original'];

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

export function groupKeyFor(t: Pick<CategoryReviewTransaction, 'category_id' | 'economic_transaction_type' | 'credit_debit' | 'currency_original'>): string {
  const head = t.category_id ? `cat:${t.category_id}` : `type:${t.economic_transaction_type}`;
  return `${head}|${t.credit_debit === 'credit' ? 'in' : 'out'}|${t.currency_original}`;
}

function needsDecisionReason(t: CategoryReviewTransaction, b: CategoryReviewBlockers): NeedsDecisionReason | null {
  if (b.pendingDuplicateTxnIds.has(t.id)) return 'possible_duplicate';
  const linkTypes = b.pendingLinkTypesByTxn.get(t.id) ?? [];
  if (linkTypes.some((l) => TRANSFER_LIKE_LINK_TYPES.includes(l))) return 'transfer_check';
  if (linkTypes.some((l) => REFUND_LIKE_LINK_TYPES.includes(l))) return 'refund_check';
  if (isUncategorised(t)) return 'uncategorised';
  if (isLowConfidence(t)) return 'low_confidence';
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

  let approved = 0;
  let waiting = 0;
  let uncategorised = 0;
  let lowConfidence = 0;
  let duplicatesRemoved = 0;

  const sorted = [...transactions].sort((a, b) =>
    a.transaction_date < b.transaction_date ? -1 : a.transaction_date > b.transaction_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  for (const t of sorted) {
    if (DUPLICATE_EXCLUDED_DEDUP_STATUSES.includes(t.dedup_status)) {
      duplicatesRemoved += 1;
      continue;
    }
    const amount = Number(t.amount_original);
    const minor = toMinorUnits(amount, t.currency_original);
    const direction: 'in' | 'out' = t.credit_debit === 'credit' ? 'in' : 'out';
    const isApproved = t.approval_status === 'approved';
    if (isApproved) approved += 1;
    else waiting += 1;
    if (!isApproved && isUncategorised(t)) uncategorised += 1;
    if (!isApproved && isLowConfidence(t)) lowConfidence += 1;

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
    const key = groupKeyFor(t);
    let g = groups.get(key);
    if (!g) {
      const category = t.category_id ? categoryById.get(t.category_id) : undefined;
      g = {
        group_key: key,
        category_id: t.category_id,
        label: category?.display_name ?? TYPE_LABEL[type] ?? 'Other',
        economic_type: type,
        direction,
        currency: t.currency_original,
        counts_toward: surplusEffect(type),
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

    const effect = surplusEffect(type);
    const tm = totalsMinor.get(t.currency_original) ?? { wi: 0, ws: 0, ai: 0, as: 0 };
    const signed = effect === 'spending' ? minor : effect === 'reduces_spending' ? -minor : 0;
    if (effect === 'income') {
      if (isApproved) tm.ai += minor;
      else tm.wi += minor;
    } else if (signed !== 0) {
      if (isApproved) tm.as += signed;
      else tm.ws += signed;
    }
    totalsMinor.set(t.currency_original, tm);
  }

  const groupList = [...groups.values()].map((g) => {
    const gm = groupMinor.get(g.group_key)!;
    g.total = fromMinorUnits(gm.total, g.currency);
    g.pending_total = fromMinorUnits(gm.pending, g.currency);
    g.status = g.pending_count === 0 ? 'approved' : g.approved_count === 0 ? 'waiting' : 'partly_approved';
    return g;
  });

  const effectRank: Record<SurplusEffect, number> = { income: 0, spending: 1, reduces_spending: 2, not_counted: 3 };
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

  return {
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
