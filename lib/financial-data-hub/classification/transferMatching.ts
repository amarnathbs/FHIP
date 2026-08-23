/**
 * R8 — internal transfer / credit-card settlement / loan-payment / open
 * investment-funding candidate matching (spec sections 30-36).
 *
 * NEVER MATCHES ON AMOUNT ALONE (spec section 30). A pair requires ALL of:
 * different account, opposite direction, identical amount + currency, and a
 * date within a bounded window. Weak or ambiguous evidence never produces a
 * DB row with `status = 'confirmed'` — every proposed link this module
 * produces is written `status = 'pending'`; only a human (or, in a future
 * release, a much stronger evidence bar) may move it to `confirmed`. This is
 * a deliberate, conservative policy choice: it is always safer to ask a
 * household to confirm a transfer than to silently net two real cash-flow
 * events against each other.
 *
 * PURE FUNCTIONS ONLY — no DB access. The caller
 * (`transactionClassificationService.ts`) supplies the candidate set
 * (already scoped to one user, already excluding `user_override = true`
 * rows) and persists the result.
 */

import type { FdhAccountType, FdhCreditDebit, FdhTransactionLinkType } from '../constants/enums';

export interface TransferCandidateTxn {
  id: string;
  financialAccountId: string;
  transactionDate: string; // ISO date (YYYY-MM-DD)
  amountOriginal: number;
  currencyOriginal: string;
  creditDebit: FdhCreditDebit;
  descriptionClean: string | null;
  sourceReference: string | null;
}

export interface ProposedTransferLink {
  transactionIdFrom: string;
  transactionIdTo: string;
  linkType: FdhTransactionLinkType;
  confidence: number; // CONFIDENCE_SCORE bucket value
  confidenceState: 'HIGH' | 'MEDIUM';
  evidence: Record<string, unknown>;
}

const DEFAULT_DATE_WINDOW_DAYS = 3;

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function linkTypeFor(accountTypeA: FdhAccountType | null, accountTypeB: FdhAccountType | null): FdhTransactionLinkType {
  if (accountTypeA === 'credit_card' || accountTypeB === 'credit_card') return 'credit_card_settlement';
  const loanTypes: FdhAccountType[] = ['home_loan', 'personal_loan', 'vehicle_loan'];
  if ((accountTypeA && loanTypes.includes(accountTypeA)) || (accountTypeB && loanTypes.includes(accountTypeB))) {
    return 'loan_payment';
  }
  return 'internal_transfer';
}

/**
 * Pairs candidate transactions across a user's own accounts. Each
 * transaction is used in AT MOST one pair — a greedy assignment that always
 * prefers the closest date match first, so a transaction is never claimed
 * by a worse-evidence pair merely because it was iterated first.
 */
export function matchInternalTransfers(
  candidates: TransferCandidateTxn[],
  accountTypeById: Map<string, FdhAccountType>,
  dateWindowDays = DEFAULT_DATE_WINDOW_DAYS,
): ProposedTransferLink[] {
  // Bucket by (amount, currency) — never matches across different amounts.
  const buckets = new Map<string, TransferCandidateTxn[]>();
  for (const t of candidates) {
    const key = `${t.amountOriginal.toFixed(4)}|${t.currencyOriginal}`;
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }

  type PairScore = { a: TransferCandidateTxn; b: TransferCandidateTxn; days: number; sameReference: boolean };
  const results: ProposedTransferLink[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const pairs: PairScore[] = [];
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.financialAccountId === b.financialAccountId) continue; // must be different accounts
        if (a.creditDebit === b.creditDebit) continue; // must be opposite direction
        const days = dayDiff(a.transactionDate, b.transactionDate);
        if (days > dateWindowDays) continue;
        const sameReference = Boolean(
          a.sourceReference && b.sourceReference && a.sourceReference.trim() === b.sourceReference.trim(),
        );
        pairs.push({ a, b, days, sameReference });
      }
    }
    // Closest date (and same-reference evidence) first, so the best-evidence
    // pair claims its transactions before a weaker candidate pair can.
    pairs.sort((x, y) => (Number(y.sameReference) - Number(x.sameReference)) || x.days - y.days);

    const claimed = new Set<string>();
    for (const p of pairs) {
      if (claimed.has(p.a.id) || claimed.has(p.b.id)) continue;
      claimed.add(p.a.id);
      claimed.add(p.b.id);

      const typeA = accountTypeById.get(p.a.financialAccountId) ?? null;
      const typeB = accountTypeById.get(p.b.financialAccountId) ?? null;
      const linkType = linkTypeFor(typeA, typeB);
      const confidenceState: 'HIGH' | 'MEDIUM' = p.sameReference || p.days <= 1 ? 'HIGH' : 'MEDIUM';

      // From the debit side to the credit side, so the link direction
      // reads naturally ("money left A, arrived at B").
      const [fromTxn, toTxn] = p.a.creditDebit === 'debit' ? [p.a, p.b] : [p.b, p.a];

      results.push({
        transactionIdFrom: fromTxn.id,
        transactionIdTo: toTxn.id,
        linkType,
        confidence: confidenceState === 'HIGH' ? 1 : 0.6,
        confidenceState,
        evidence: {
          rule: 'exact_amount_opposite_direction_different_account',
          amount: p.a.amountOriginal,
          currency: p.a.currencyOriginal,
          date_delta_days: p.days,
          same_source_reference: p.sameReference,
          account_from: fromTxn.financialAccountId,
          account_to: toTxn.financialAccountId,
        },
      });
    }
  }

  return results;
}

/**
 * For a transaction a rule/hint flagged as a candidate (transfer, credit-card
 * settlement, or investment funding) that `matchInternalTransfers` did NOT
 * pair, records an OPEN link (`transaction_id_to = null`) — the schema's own
 * documented pattern for "the counterpart has not been imported yet" (spec
 * section 31). Never fabricates a counterpart; the review surface can
 * resolve it once the receiving account's statement exists. Investment
 * funding candidates deliberately never gain a real counterpart from this
 * module — the receiving side is Investment Intelligence's domain, which
 * FDH must never create a row in (spec section 18, 34).
 */
export function openCandidateLink(
  transactionId: string,
  candidateType: 'transfer_candidate' | 'liability_settlement_candidate' | 'investment_funding_candidate',
): { transactionId: string; linkType: FdhTransactionLinkType; confidence: number; evidence: Record<string, unknown> } {
  const linkType: FdhTransactionLinkType =
    candidateType === 'liability_settlement_candidate'
      ? 'credit_card_settlement'
      : candidateType === 'investment_funding_candidate'
        ? 'investment_funding'
        : 'internal_transfer';
  return {
    transactionId,
    linkType,
    confidence: 0.3,
    evidence: { rule: 'structural_candidate_no_counterpart_found', candidate_type: candidateType },
  };
}
