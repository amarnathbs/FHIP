/**
 * Financial Data Hub — FDH-7: centralised review priority and blocking-issue
 * policy (spec sections 21, 53-54, 96).
 *
 * SINGLE SOURCE OF TRUTH, TWO LAYERS, ONE POLICY. The actual, un-bypassable
 * enforcement of "what blocks an approval" lives in Postgres —
 * `fdh7_transaction_has_blocking_issue()` / `fdh7_statement_has_blocking_issue()`
 * (migration 0076) — because spec sections 109-110/123 require a forged
 * direct API request to be rejected by the SERVER, not merely hidden by a
 * disabled button. This module is the friendly, UI-facing mirror of that
 * same policy: it never disagrees with the database (both are derived from
 * the identical reasoning, documented once here and once in the migration's
 * comments), and it adds the presentational concern the database correctly
 * has no opinion on — REVIEW PRIORITY ORDERING (spec 21) — in exactly one
 * place, so no component reimplements its own ordering.
 */

import type { FdhReviewReasonCode } from '../classification/reviewReasons';
import type { FdhReviewType } from '../constants/enums';

/**
 * Review-queue priority (spec 21), lower number = more urgent = shown first.
 * `RECONCILIATION_VARIANCE` sits outside `FdhReviewReasonCode` because it is
 * a STATEMENT-level fact, not a per-transaction reason — callers pass
 * `hasReconciliationVariance` separately (see `reviewPriorityRank` below).
 */
export const FDH7_REVIEW_PRIORITY_ORDER: readonly (FdhReviewReasonCode | 'RECONCILIATION_VARIANCE')[] = [
  'RECONCILIATION_VARIANCE',
  'POSSIBLE_DUPLICATE',
  'POSSIBLE_TRANSFER',
  'MISSING_COUNTERPART_ACCOUNT',
  'UNKNOWN_CLASSIFICATION',
  'RULE_CONFLICT',
  'LOW_CLASSIFICATION_CONFIDENCE',
  'POSSIBLE_REFUND',
] as const;

/**
 * The lowest (= most urgent) rank among a transaction's reasons, or
 * `Number.POSITIVE_INFINITY` for an item with no reasons at all (sorts last
 * — "ready to approve" items belong at the bottom of the queue, never mixed
 * randomly among items that actually need attention).
 */
export function reviewPriorityRank(
  reasons: readonly FdhReviewReasonCode[],
  hasReconciliationVariance = false,
): number {
  if (hasReconciliationVariance) return FDH7_REVIEW_PRIORITY_ORDER.indexOf('RECONCILIATION_VARIANCE');
  if (reasons.length === 0) return Number.POSITIVE_INFINITY;
  const ranks = reasons.map((r) => {
    const idx = FDH7_REVIEW_PRIORITY_ORDER.indexOf(r);
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  });
  return Math.min(...ranks);
}

/** Deterministic comparator for a review-queue list — ties break on a stable
 * secondary key the caller supplies (e.g. transaction id), never on
 * insertion order, so pagination stays deterministic (spec 70). */
export function compareReviewPriority(
  a: { reasons: readonly FdhReviewReasonCode[]; hasReconciliationVariance?: boolean; tieBreakKey: string },
  b: { reasons: readonly FdhReviewReasonCode[]; hasReconciliationVariance?: boolean; tieBreakKey: string },
): number {
  const rankA = reviewPriorityRank(a.reasons, a.hasReconciliationVariance);
  const rankB = reviewPriorityRank(b.reasons, b.hasReconciliationVariance);
  if (rankA !== rankB) return rankA - rankB;
  return a.tieBreakKey < b.tieBreakKey ? -1 : a.tieBreakKey > b.tieBreakKey ? 1 : 0;
}

/**
 * Blocking vs non-blocking review-item classification (spec 53). This is a
 * DISPLAY/UX mirror only — the actual gate is `fdh_review_items.severity`
 * (already 'blocking'/'warning'/'info', set by the producing engine at
 * write time, per FDH-1's own migration 0048) plus the DB functions above.
 * This map exists so a caller building a NEW review item (or explaining an
 * existing one) has one place to look up the conventional severity for a
 * review type, rather than guessing per call site.
 */
export const FDH7_REVIEW_TYPE_DEFAULT_SEVERITY: Record<FdhReviewType, 'info' | 'warning' | 'blocking'> = {
  reconciliation_failure: 'blocking',
  possible_duplicate: 'warning',
  possible_transfer: 'warning',
  missing_counterpart_account: 'info',
  low_classification_confidence: 'info',
  low_extraction_confidence: 'warning',
  unknown_merchant: 'info',
  transaction_split: 'info',
  income_evidence: 'info',
  other: 'info',
};

/**
 * Bulk-action partial-failure contract (spec 96 — "define explicit
 * behaviour... do not silently skip"). FDH-7's chosen contract:
 * PER-ITEM, EXPLICIT: every id in a bulk request is validated
 * INDEPENDENTLY; valid ones succeed, invalid ones fail with a per-item
 * reason, and the response never claims a blocked item succeeded (spec 50).
 * This is deliberately NOT all-or-nothing — spec 49's own example ("approve
 * 25 high-confidence grocery transactions") would otherwise let one
 * unrelated blocked transaction silently veto 24 legitimate approvals.
 */
export const FDH7_BULK_ACTION_CONTRACT = 'PER_ITEM_EXPLICIT_PARTIAL_SUCCESS' as const;

export interface BulkActionItemResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BulkActionResult {
  contract: typeof FDH7_BULK_ACTION_CONTRACT;
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkActionItemResult[];
}

/** Runs `action` over every id independently, catching per-item failure so
 * one blocked item never aborts the batch or silently vanishes from the
 * response (spec 50, 96). */
export async function runBulkAction(
  ids: readonly string[],
  action: (id: string) => Promise<void>,
): Promise<BulkActionResult> {
  const results: BulkActionItemResult[] = [];
  for (const id of ids) {
    try {
      await action(id);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return {
    contract: FDH7_BULK_ACTION_CONTRACT,
    requested: ids.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
