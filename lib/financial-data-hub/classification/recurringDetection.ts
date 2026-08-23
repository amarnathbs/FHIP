/**
 * R8 — recurring/subscription series detection (spec sections 49-53).
 *
 * FALSE-RECURRENCE PROTECTION (spec section 52). Grouping transactions by
 * merchant/description alone is not enough — five random supermarket trips
 * in a month are not a subscription. A series is only proposed when the
 * gaps between consecutive occurrences cluster consistently around ONE
 * canonical frequency bucket (within a bounded tolerance for realistic
 * weekend/month-boundary drift, spec section 50) — genuinely irregular
 * repeat spending never produces a series here, it is left alone.
 *
 * AMOUNT VARIATION (spec section 51). Both fixed and variable-amount
 * recurring series are supported — the series records the observed
 * amount range/tolerance rather than requiring exact equality.
 */

import type { FdhCreditDebit, FdhRecurringFrequency } from '../constants/enums';

export interface RecurringCandidateTxn {
  id: string;
  transactionDate: string; // ISO date
  amountOriginal: number;
  currencyOriginal: string;
  creditDebit: FdhCreditDebit;
  merchantId: string | null;
  descriptionClean: string | null;
  financialAccountId: string;
}

export interface DetectedSeries {
  groupKey: string;
  merchantId: string | null;
  financialAccountId: string;
  frequency: FdhRecurringFrequency;
  expectedAmount: number | null;
  amountTolerance: number | null;
  currencyCode: string;
  memberTransactionIds: string[];
  nextExpectedDate: string;
  confidence: 'HIGH' | 'MEDIUM';
  /** True history has fewer than 3 occurrences — still evidence, but not
   * yet enough to call the series ACTIVE (spec section 53's
   * INSUFFICIENT_HISTORY state). */
  insufficientHistory: boolean;
}

interface FrequencyBucket {
  frequency: FdhRecurringFrequency;
  nominalDays: number;
  toleranceDays: number;
}

// Ordered narrowest-first so a 7-day cadence is never mis-bucketed as
// "monthly" by a wider tolerance matching first.
const FREQUENCY_BUCKETS: FrequencyBucket[] = [
  { frequency: 'weekly', nominalDays: 7, toleranceDays: 2 },
  { frequency: 'fortnightly', nominalDays: 14, toleranceDays: 3 },
  { frequency: 'monthly', nominalDays: 30, toleranceDays: 5 },
  { frequency: 'quarterly', nominalDays: 91, toleranceDays: 10 },
  { frequency: 'annual', nominalDays: 365, toleranceDays: 15 },
];

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

function bucketForDelta(days: number): FrequencyBucket | null {
  return FREQUENCY_BUCKETS.find((b) => Math.abs(days - b.nominalDays) <= b.toleranceDays) ?? null;
}

function groupKeyFor(t: RecurringCandidateTxn): string {
  const identity = t.merchantId ?? (t.descriptionClean ?? '').toUpperCase().trim();
  return `${t.financialAccountId}|${identity}|${t.creditDebit}`;
}

/**
 * Detects candidate recurring series across a user's transaction history.
 * `minOccurrences` defaults to 2 (spec section 53's INSUFFICIENT_HISTORY is
 * itself a valid, disclosed detection outcome — not a reason to withhold a
 * series entirely) but a series only reaches non-insufficient status with
 * 3+ occurrences all matching the same frequency bucket.
 */
export function detectRecurringSeries(candidates: RecurringCandidateTxn[]): DetectedSeries[] {
  const groups = new Map<string, RecurringCandidateTxn[]>();
  for (const t of candidates) {
    if (!t.merchantId && !(t.descriptionClean && t.descriptionClean.trim().length >= 3)) continue;
    const key = groupKeyFor(t);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const results: DetectedSeries[] = [];

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.transactionDate) - Date.parse(b.transactionDate));
    // Currency must be uniform within a series — never mixes.
    const currencies = new Set(sorted.map((t) => t.currencyOriginal));
    if (currencies.size > 1) continue;

    const deltas: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      deltas.push(daysBetween(sorted[i - 1].transactionDate, sorted[i].transactionDate));
    }

    // Every consecutive gap must land in the SAME canonical bucket — this is
    // the false-recurrence guard. A single inconsistent gap disqualifies
    // the whole group rather than silently dropping the outlier.
    const firstBucket = bucketForDelta(deltas[0]);
    if (!firstBucket) continue;
    const consistent = deltas.every((d) => bucketForDelta(d)?.frequency === firstBucket.frequency);
    if (!consistent) continue;

    const amounts = sorted.map((t) => t.amountOriginal);
    const minAmount = Math.min(...amounts);
    const maxAmount = Math.max(...amounts);
    const meanAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const amountTolerance = Number((maxAmount - minAmount).toFixed(4));

    const lastDate = sorted[sorted.length - 1].transactionDate;
    const nextExpected = new Date(Date.parse(lastDate) + firstBucket.nominalDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const insufficientHistory = sorted.length < 3;
    // Tight amount clustering (<1% spread, or a single-cent rounding gap)
    // plus a tight date pattern earns HIGH; anything wider (but still
    // within the bucket's own tolerance) is MEDIUM.
    const tightAmounts = amountTolerance <= Math.max(0.01, meanAmount * 0.01);
    const confidence: 'HIGH' | 'MEDIUM' = !insufficientHistory && tightAmounts ? 'HIGH' : 'MEDIUM';

    results.push({
      groupKey: key,
      merchantId: sorted[0].merchantId,
      financialAccountId: sorted[0].financialAccountId,
      frequency: firstBucket.frequency,
      expectedAmount: Number(meanAmount.toFixed(4)),
      amountTolerance,
      currencyCode: sorted[0].currencyOriginal,
      memberTransactionIds: sorted.map((t) => t.id),
      nextExpectedDate: nextExpected,
      confidence,
      insufficientHistory,
    });
  }

  return results;
}

/** Spec section 53: refresh a previously ACTIVE series' status against
 * today's date, without ever declaring ENDED automatically (only a human
 * or a much longer, disclosed absence should do that — this function never
 * returns 'ended'). A series more than 1.5 cycles overdue is
 * POSSIBLY_PAUSED; anything within that window stays ACTIVE. */
export function refreshSeriesStatus(
  nextExpectedDate: string,
  frequencyNominalDays: number,
  today: string,
): 'active' | 'paused' {
  const overdueDays = daysBetween(nextExpectedDate, today);
  return overdueDays > frequencyNominalDays * 1.5 ? 'paused' : 'active';
}

export const FREQUENCY_NOMINAL_DAYS: Record<FdhRecurringFrequency, number> = Object.fromEntries(
  FREQUENCY_BUCKETS.map((b) => [b.frequency, b.nominalDays]),
) as Record<FdhRecurringFrequency, number>;
FREQUENCY_NOMINAL_DAYS.irregular = 30;
