/**
 * WP-08 (EXP-G14): "N lines could not be read" -- with the reasons, in words.
 *
 * Before, a CSV or PDF import reported only a bare `rejected_rows` count (and
 * the panel never showed even that): a line whose amount was blank, whose
 * date did not parse, or whose currency differed from the statement's simply
 * vanished. The reasons are now counted per statement, persisted in the
 * statement's `transaction_count_valid` data-quality row (so the statement
 * details drawer can show them later) and returned to the import panel.
 *
 * PURE: no I/O. The persisted form is a short machine string inside
 * `fdh_data_quality_results.details_sanitised` -- counts and reason codes
 * only, never any line content (that column's rule: no document text).
 */

export const UNREAD_REASON_TEXT: Record<string, string> = {
  column_not_found: 'a column the mapping names is missing on this line',
  missing_transaction_date: 'no date',
  invalid_transaction_date: 'a date we could not read',
  missing_amount: 'no amount',
  invalid_amount: 'an amount we could not read',
  zero_amount: 'an amount of zero',
  ambiguous_direction: 'we could not tell money in from money out',
  missing_balance: 'no running balance to confirm the amount',
  currency_mismatch: 'a different currency from the statement',
  unparseable_block: 'text we could not read as a transaction',
};

export interface UnreadReasonCount {
  reason: string;
  count: number;
  text: string;
}

export interface UnreadLinesSummary {
  count: number;
  reasons: UnreadReasonCount[];
}

export function summariseUnreadLines(rejected: ReadonlyArray<{ reason: string }>, unparseableBlocks = 0): UnreadLinesSummary {
  const counts = new Map<string, number>();
  for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  if (unparseableBlocks > 0) counts.set('unparseable_block', (counts.get('unparseable_block') ?? 0) + unparseableBlocks);
  const reasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([reason, count]) => ({ reason, count, text: UNREAD_REASON_TEXT[reason] ?? 'a line we could not read' }));
  return { count: rejected.length + unparseableBlocks, reasons };
}

/** `unread=3 invalid_amount=2 zero_amount=1`, appended to the existing
 * data-quality detail string. Reason codes are [a-z_] only. */
export function encodeUnreadLines(summary: UnreadLinesSummary): string {
  return [`unread=${summary.count}`, ...summary.reasons.map((r) => `${r.reason}=${r.count}`)].join(' ');
}

export function decodeUnreadLines(details: string | null | undefined): UnreadLinesSummary | null {
  if (!details) return null;
  const m = details.match(/unread=(\d+)((?:\s+[a-z_]+=\d+)*)/);
  if (!m) return null;
  const reasons = [...m[2].matchAll(/([a-z_]+)=(\d+)/g)].map(([, reason, n]) => ({
    reason,
    count: Number(n),
    text: UNREAD_REASON_TEXT[reason] ?? 'a line we could not read',
  }));
  return { count: Number(m[1]), reasons };
}

/** "2 lines could not be read: 1 had an amount we could not read, 1 had no date." */
export function describeUnreadLines(summary: UnreadLinesSummary): string | null {
  if (summary.count === 0) return null;
  const parts = summary.reasons.map((r) => `${r.count} had ${r.text}`);
  return `${summary.count} line${summary.count === 1 ? '' : 's'} could not be read${parts.length ? `: ${parts.join('; ')}` : ''}. `
    + 'They are not included. Add them by hand if they are real transactions.';
}
