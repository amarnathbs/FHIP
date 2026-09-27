/**
 * The ONE definition of what an approved imported line means economically
 * (EXP-G2 / DC-03). Pure; no data access.
 *
 * Before this module there were three divergent "actual spending" definitions
 * (the Dashboard's current-month query, FDH-7's approved summary, and the
 * category review), and the Dashboard ignored duplicates, splits and refund
 * links. Every read model -- and, from WP-08, FDH Activity and Category
 * review -- imports these rules instead of restating them.
 *
 * RULES (each one is an oracle-tested claim, see tests/unit/readModels/):
 *  1. Only approval_status = 'approved' rows count. Before Apply: effect 0.
 *  2. dedup_status 'duplicate_confirmed' / 'user_confirmed_duplicate' rows
 *     never count (the certified FDH-7 exclusion; a removed_b side).
 *  3. A split transaction counts ONLY through its allocations, which must
 *     reconcile to the parent to the 4th decimal; an unreconciled split is
 *     refused, never summed. An 'unknown' allocation is never counted.
 *  4. Every FDH economic_transaction_type maps to exactly one bucket
 *     (ECONOMIC_TYPE_BUCKET, compile-time exhaustive).
 *  5. On a card/loan FACILITY account, debt_interest and fee are "cost of
 *     debt": counted once through liability debt service (PO D-09), never also
 *     as spending. On an ordinary bank account they stay spending.
 *  6. A bank leg settling a facility (confirmed credit_card_settlement /
 *     loan_payment link to a facility-account line) or an own-account
 *     transfer (confirmed internal_transfer) is a transfer, whatever it was
 *     typed: card purchases $200 + $20 and a $220 repayment are spending $220.
 *  7. A bank leg that approved broker evidence corroborates is re-bucketed:
 *     BUY funding -> investment (spending 0), SELL proceeds -> asset_sale
 *     (income 0), a broker-cash deposit -> investment, a broker-cash
 *     withdrawal -> transfer (WP-12). A dividend credit stays income: it is
 *     the single leg.
 *  8. Refunds net against spending ONLY with a CONFIRMED refund_original /
 *     reversal_original link to a counted spending line (PO D-01, the
 *     certified FDH-7 rule). Any other refund is shown as unlinked, never
 *     netted and never counted as income.
 *  9. A row the user settled (user_override) is never re-bucketed by
 *     corroboration (7). A CONFIRMED link (6) is itself a settled match and
 *     applies whatever the row was typed, by the user or by the classifier.
 *     Residual (security review, R9 -- decided by the LEDGER, not here):
 *     card/loan/broker evidence APPROVED AFTER the user's last own decision
 *     on the line clears user_override before this function sees it, so that
 *     later explicit approval re-buckets the line through rule 7.
 * 10. Money in never adds to spending: on an ORDINARY account a CREDIT line
 *     of a spending type is a refund (bucket 'refund'), so rule 8 decides
 *     whether it nets. Not on a facility, where a credit is a repayment and
 *     its interest/fee allocations are cost of debt. See directionalBucket().
 *     Rule 10 shapes the BASE bucket, so it holds under user_override too.
 *
 * PRECEDENCE of effectiveBucket (combined certification, 2026-09-27; see
 * tests/unit/readModels/effectiveBucketPrecedence.test.ts):
 *   base = rule 4/5 bucket, then rule 10 on an ordinary-account credit;
 *   split or facility line -> base;
 *   confirmed settlement / internal-transfer / investment-funding link (6)
 *     -> wins over user_override (D1);
 *   user_override still in force (not cleared by R9) -> base;
 *   approved corroboration (7) -> re-bucket.
 */
import { FDH_ECONOMIC_TRANSACTION_TYPES, type FdhEconomicTransactionType } from '@/lib/financial-data-hub/constants/enums';

export type EconomicTransactionType = FdhEconomicTransactionType;
export const ECONOMIC_TRANSACTION_TYPES: readonly EconomicTransactionType[] = FDH_ECONOMIC_TRANSACTION_TYPES;

export type ReadModelBucket =
  | 'income'
  | 'spending'
  | 'refund'
  | 'transfer'
  | 'cash_withdrawal'
  | 'investment'
  | 'asset_purchase'
  | 'asset_sale'
  | 'debt_principal'
  | 'cost_of_debt'
  | 'unknown';

/** Rule 4. The bucket of each type on an ORDINARY (non-facility) account. */
export const ECONOMIC_TYPE_BUCKET: Record<EconomicTransactionType, ReadModelBucket> = {
  income: 'income',
  expense: 'spending',
  fee: 'spending',
  tax: 'spending',
  debt_interest: 'spending',
  transfer: 'transfer',
  refund: 'refund',
  investment: 'investment',
  asset_purchase: 'asset_purchase',
  asset_sale: 'asset_sale',
  debt_principal: 'debt_principal',
  cash_withdrawal: 'cash_withdrawal',
  unknown: 'unknown',
};

/** Rule 5. Types re-bucketed to cost_of_debt on a facility account. */
export const FACILITY_COST_OF_DEBT_TYPES: ReadonlySet<EconomicTransactionType> = new Set(['debt_interest', 'fee']);

/** fdh_financial_accounts.account_type values that are a card/loan facility
 * (0046 + the 0096 FDH-10 widening). */
export const FACILITY_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'credit_card', 'home_loan', 'personal_loan', 'vehicle_loan',
  'investment_property_loan', 'other_term_loan', 'line_of_credit', 'overdraft',
]);
export const REVOLVING_FACILITY_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['credit_card', 'line_of_credit', 'overdraft']);

export function isFacilityAccount(account: { account_type: string; liability_id?: string | null } | null | undefined): boolean {
  if (!account) return false;
  return FACILITY_ACCOUNT_TYPES.has(account.account_type) || Boolean(account.liability_id);
}

/** Rule 2. */
export const DUPLICATE_EXCLUDED_DEDUP_STATUSES: ReadonlySet<string> = new Set(['duplicate_confirmed', 'user_confirmed_duplicate']);
export function isDuplicateExcluded(dedupStatus: string | null | undefined): boolean {
  return DUPLICATE_EXCLUDED_DEDUP_STATUSES.has(dedupStatus ?? '');
}

/** Rule 8. */
export type RefundRule = 'confirmed_link_only';
export const DEFAULT_REFUND_RULE: RefundRule = 'confirmed_link_only';
export const REFUND_LIKE_LINK_TYPES: ReadonlySet<string> = new Set(['refund_original', 'reversal_original']);

/** Rule 6. Link types whose non-facility leg is a transfer when confirmed. */
export const SETTLEMENT_LINK_TYPES: ReadonlySet<string> = new Set(['credit_card_settlement', 'loan_payment']);

/** Rule 4 + 5 (+ rule 10 when the line's direction is given). */
export function bucketForType(type: EconomicTransactionType, onFacility: boolean, creditDebit?: 'credit' | 'debit' | null): ReadModelBucket {
  const base: ReadModelBucket = onFacility && FACILITY_COST_OF_DEBT_TYPES.has(type) ? 'cost_of_debt' : ECONOMIC_TYPE_BUCKET[type] ?? 'unknown';
  // Rule 10 applies to ORDINARY accounts only. On a card/loan facility a CREDIT is a repayment, and the
  // FDH-10 ledger decomposes it into principal / interest / fee allocations (D-09): its interest and fee
  // parts are cost of debt, never a refund.
  return onFacility ? base : directionalBucket(base, creditDebit);
}

/**
 * Rule 10 (canonical-cert scale/UI, 2026-09-27). MONEY IN never adds to
 * spending. A CREDIT line whose type is a spending type (expense / fee / tax /
 * debt_interest, or cost of debt on a facility) -- e.g. "REFUND WOOLWORTHS"
 * classified Food & Dining by the merchant master, or a payee the user
 * remembered as Food & Dining whose statement also has credits -- is
 * economically a refund / reversal of spending. It is bucketed 'refund', so
 * rule 8 (PO D-01) applies unchanged: it nets only with a CONFIRMED
 * refund_original / reversal_original link, otherwise it is shown as an
 * unlinked refund and never counted. Before this rule the amount (stored
 * unsigned) was ADDED to spending: a $20 refund raised spending by $20.
 */
export function directionalBucket(bucket: ReadModelBucket, creditDebit?: 'credit' | 'debit' | null): ReadModelBucket {
  if (creditDebit === 'credit' && (bucket === 'spending' || bucket === 'cost_of_debt')) return 'refund';
  return bucket;
}

// ---------------------------------------------------------------------------
// Rule 3: allocation-aware expansion
// ---------------------------------------------------------------------------

export interface RuleTransaction {
  id: string;
  amount_original: number;
  currency_original: string;
  economic_transaction_type: EconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;
  dedup_status: string;
  approval_status: string;
}

export interface RuleAllocation {
  transaction_id: string;
  allocation_sequence: number;
  economic_transaction_type: EconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;
  amount: number;
  currency_code: string;
}

export interface ExpandedPart {
  allocationSequence: number | null;
  type: EconomicTransactionType;
  categoryId: string | null;
  subcategoryId: string | null;
  amount: number;
  currency: string;
}

export type ExpandResult =
  | { kind: 'parts'; parts: ExpandedPart[] }
  | { kind: 'not_approved' }
  | { kind: 'duplicate' }
  | { kind: 'invalid_split'; allocatedMinor: number; parentMinor: number };

/** Exact 4-dp minor units (the storage precision of numeric(20,4)). */
export const toMinor = (n: number): number => Math.round(Number(n) * 10000);

export function expandTransaction(txn: RuleTransaction, allocations: readonly RuleAllocation[]): ExpandResult {
  if (txn.approval_status !== 'approved') return { kind: 'not_approved' };
  if (isDuplicateExcluded(txn.dedup_status)) return { kind: 'duplicate' };
  const own = allocations.filter((a) => a.transaction_id === txn.id).sort((a, b) => a.allocation_sequence - b.allocation_sequence);
  if (own.length === 0) {
    return {
      kind: 'parts',
      parts: [{ allocationSequence: null, type: txn.economic_transaction_type, categoryId: txn.category_id, subcategoryId: txn.subcategory_id, amount: Number(txn.amount_original), currency: txn.currency_original }],
    };
  }
  const allocatedMinor = own.reduce((s, a) => s + toMinor(a.amount), 0);
  const parentMinor = toMinor(txn.amount_original);
  if (allocatedMinor !== parentMinor) return { kind: 'invalid_split', allocatedMinor, parentMinor };
  return {
    kind: 'parts',
    parts: own.map((a) => ({ allocationSequence: a.allocation_sequence, type: a.economic_transaction_type, categoryId: a.category_id, subcategoryId: a.subcategory_id, amount: Number(a.amount), currency: a.currency_code })),
  };
}

// ---------------------------------------------------------------------------
// Rules 6, 7, 9: re-bucketing a whole (unsplit) bank leg
// ---------------------------------------------------------------------------

export interface LinkEvidence {
  linkType: string;
  status: string;
  /** Is the OTHER leg of the link on a facility account? */
  counterpartOnFacility: boolean;
}

export type CorroborationKind = 'payroll_event' | 'liability_activity' | 'investment_activity' | 'retirement_activity';

export interface CorroborationEvidence {
  kind: CorroborationKind;
  sourceId: string;
  /** The evidence row's own type, e.g. 'BUY', 'PAYMENT', 'PERSONAL_CONTRIBUTION'. */
  activityType: string | null;
}

export interface ReBucketResult {
  bucket: ReadModelBucket;
  /** Why the bucket differs from the row's own type, if it does. */
  reason: string | null;
}

/**
 * The effective bucket of an UNSPLIT line after link / corroboration evidence.
 * Split lines keep their allocation types (the user decided them).
 */
export function effectiveBucket(input: {
  type: EconomicTransactionType;
  onFacility: boolean;
  isSplit: boolean;
  userOverride: boolean;
  links: readonly LinkEvidence[];
  corroborations: readonly CorroborationEvidence[];
  /** The line's direction (rule 10). Omitted = legacy behaviour (no direction rule). */
  creditDebit?: 'credit' | 'debit' | null;
}): ReBucketResult {
  // Rule 10 is part of the base: an unlinked credit of a spending type on an
  // ordinary account is a refund whoever typed it (user or classifier).
  const base = bucketForType(input.type, input.onFacility, input.creditDebit);
  if (input.isSplit || input.onFacility) return { bucket: base, reason: null };
  // Rule 6 BEFORE rule 9 (certification fix, 2026-09-27): a CONFIRMED link is
  // itself a settled match -- the contract's "a transfer whatever it was
  // typed". Every bank line a person categorises carries user_override, so
  // gating links behind it made rule 6 dead for exactly the lines users touch:
  // a repayment filed as "Shopping" before the card statement was Applied (the
  // Apply then CONFIRMS the settlement link to that debit) counted $440, not
  // $220 -- reproduced live on DEV. Undoing the match is done by rejecting the
  // link, which removes it from `links` here.
  const confirmed = input.links.filter((l) => l.status === 'confirmed');
  if (confirmed.some((l) => SETTLEMENT_LINK_TYPES.has(l.linkType) && l.counterpartOnFacility)) {
    return { bucket: 'transfer', reason: base === 'transfer' ? null : 'facility_settlement_link' };
  }
  if (confirmed.some((l) => l.linkType === 'internal_transfer')) {
    return { bucket: 'transfer', reason: base === 'transfer' ? null : 'internal_transfer_link' };
  }
  if (confirmed.some((l) => l.linkType === 'investment_funding') && base === 'spending') {
    return { bucket: 'investment', reason: 'investment_funding_link' };
  }
  // Rule 9: corroboration (automatic, unconfirmed evidence) never overrides a
  // person's own decision.
  if (input.userOverride) return { bucket: base, reason: null };
  for (const c of input.corroborations) {
    if (c.kind === 'investment_activity') {
      if (c.activityType === 'BUY' && base !== 'investment') return { bucket: 'investment', reason: 'broker_buy_corroboration' };
      if (c.activityType === 'SELL' && base !== 'asset_sale') return { bucket: 'asset_sale', reason: 'broker_sell_corroboration' };
      // WP-12 (INV-G4): money moved INTO broker cash is invested (spending 0);
      // money taken OUT of broker cash is a transfer back (income 0).
      if (c.activityType === 'CASH_DEPOSIT' && base !== 'investment') return { bucket: 'investment', reason: 'broker_deposit_corroboration' };
      if (c.activityType === 'CASH_WITHDRAWAL' && base !== 'transfer') return { bucket: 'transfer', reason: 'broker_withdrawal_corroboration' };
    }
    if (c.kind === 'liability_activity' && c.activityType === 'PAYMENT' && base !== 'transfer') {
      return { bucket: 'transfer', reason: 'facility_payment_corroboration' };
    }
  }
  return { bucket: base, reason: null };
}

/** Buckets that are household consumption (the "spending" figure). */
export const SPENDING_BUCKETS: ReadonlySet<ReadModelBucket> = new Set(['spending']);
/** Buckets always reported, labelled, and never counted as spending. */
export const NON_SPENDING_BUCKETS = ['transfer', 'cash_withdrawal', 'investment', 'asset_purchase', 'asset_sale', 'debt_principal', 'cost_of_debt'] as const;
export type NonSpendingBucket = (typeof NON_SPENDING_BUCKETS)[number];

export const NON_SPENDING_LABELS: Record<NonSpendingBucket, string> = {
  transfer: 'Transfers between your accounts and card/loan repayments',
  cash_withdrawal: 'Cash — spending unknown',
  investment: 'Invested',
  asset_purchase: 'Asset purchases',
  asset_sale: 'Asset sales (not income)',
  debt_principal: 'Debt principal repaid',
  cost_of_debt: 'Cost of debt (interest and fees inside card/loan repayments)',
};
