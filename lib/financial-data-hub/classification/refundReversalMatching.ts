/**
 * R8 — refund/reversal linkage (spec section 36).
 *
 * Classification of "this transaction IS a refund" already comes from
 * FDH-2's seeded narrative_pattern rules (refund/reversal/chargeback
 * patterns → `economic_transaction_type = 'refund'`, evaluated by
 * `economicTypeEngine.ts`). This module's ONLY job is the separate task of
 * LINKING a refund/reversal back to the original transaction it undoes —
 * `fdh_transaction_links.link_type IN ('refund_original', 'reversal_original')`
 * — never deleting or mutating the original (spec section 36/38).
 *
 * Evidence: same account (a refund is issued back to the same account the
 * original charge came from), opposite direction, same or smaller amount
 * (a partial refund is smaller; a refund can never legitimately exceed the
 * original), the refund dated AFTER the original, within a bounded lookback
 * window. Like transfer matching, never matches on amount alone.
 */

export interface RefundCandidateTxn {
  id: string;
  financialAccountId: string;
  transactionDate: string; // ISO date
  amountOriginal: number;
  currencyOriginal: string;
  creditDebit: 'credit' | 'debit';
  /** true when the economic-type engine classified this row 'refund' via a
   * narrative-pattern rule — only these are candidates FOR linking; every
   * other transaction is a possible ORIGINAL, never a refund itself. */
  isRefundClassified: boolean;
}

export interface ProposedRefundLink {
  refundTransactionId: string;
  originalTransactionId: string;
  linkType: 'refund_original' | 'reversal_original';
  confidence: number;
  evidence: Record<string, unknown>;
}

const DEFAULT_LOOKBACK_DAYS = 90;

function dayDiff(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * For each refund-classified transaction, finds the best original within
 * the SAME account: opposite direction, same currency, amount ≤ the
 * original, dated on or before the refund, within the lookback window.
 * Closest-in-time, closest-in-amount original wins. A refund with no
 * plausible original in range is left unlinked (never fabricated) —
 * exactly the "persistent missing counterpart" pattern
 * `fdh_transaction_links` already supports.
 */
export function matchRefundsToOriginals(
  candidates: RefundCandidateTxn[],
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): ProposedRefundLink[] {
  const results: ProposedRefundLink[] = [];
  const claimedOriginals = new Set<string>();

  const refunds = candidates.filter((t) => t.isRefundClassified);
  const byAccount = new Map<string, RefundCandidateTxn[]>();
  for (const t of candidates) {
    const list = byAccount.get(t.financialAccountId);
    if (list) list.push(t);
    else byAccount.set(t.financialAccountId, [t]);
  }

  for (const refund of refunds) {
    const sameAccount = byAccount.get(refund.financialAccountId) ?? [];
    let best: { txn: RefundCandidateTxn; days: number; amountDelta: number } | null = null;
    for (const candidate of sameAccount) {
      if (candidate.id === refund.id) continue;
      if (claimedOriginals.has(candidate.id)) continue;
      if (candidate.creditDebit === refund.creditDebit) continue; // must be opposite direction
      if (candidate.currencyOriginal !== refund.currencyOriginal) continue;
      if (candidate.amountOriginal < refund.amountOriginal) continue; // refund can't exceed original
      const days = dayDiff(refund.transactionDate, candidate.transactionDate);
      if (days < 0 || days > lookbackDays) continue; // original must precede (or equal) the refund
      const amountDelta = candidate.amountOriginal - refund.amountOriginal;
      if (!best || days < best.days || (days === best.days && amountDelta < best.amountDelta)) {
        best = { txn: candidate, days, amountDelta };
      }
    }
    if (!best) continue;
    claimedOriginals.add(best.txn.id);
    results.push({
      refundTransactionId: refund.id,
      originalTransactionId: best.txn.id,
      linkType: best.amountDelta === 0 ? 'refund_original' : 'reversal_original',
      confidence: best.amountDelta === 0 && best.days <= 7 ? 1 : 0.6,
      evidence: {
        rule: 'refund_classified_opposite_direction_amount_le_original_same_account',
        date_delta_days: best.days,
        amount_delta: best.amountDelta,
        partial: best.amountDelta > 0,
      },
    });
  }

  return results;
}
