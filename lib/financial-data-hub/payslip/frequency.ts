/**
 * FDH-9 — pay-frequency inference (spec section 27).
 *
 * "Infer cautiously (weekly/fortnightly/semimonthly/monthly). One payslip may
 * not provide enough evidence unless explicitly stated. User must be able to
 * correct it."
 *
 * The order of preference is therefore:
 *
 *   1. STATED_ON_PAYSLIP     — the document literally says "Pay Frequency:
 *                              Fortnightly". Highest confidence.
 *   2. DERIVED_FROM_PERIOD   — the pay period start/end span a recognisable
 *                              length. Good, but a period is not a promise
 *                              about the next one.
 *   3. DERIVED_FROM_HISTORY  — the gap between this payment date and prior
 *                              payment dates for the same employer.
 *   4. UNKNOWN               — a correct, deliberate answer.
 *
 * `unknown` is never silently upgraded to `monthly`. Where frequency is only
 * DERIVED (2 or 3), the income proposal marks the frequency field
 * `requires_confirmation` so the user must positively accept it before it can
 * be applied — see `lib/import-bridge/adapters/incomeAdapter.ts`.
 */

import type { PayFrequency, PayFrequencySource } from './types';

export interface FrequencyInference {
  frequency: PayFrequency;
  source: PayFrequencySource;
  confidence: number;
}

/** Explicit statements found on payslips, most specific first. */
const STATED_PATTERNS: { pattern: RegExp; frequency: PayFrequency }[] = [
  { pattern: /\bsemi[\s-]?monthly\b|\btwice\s+monthly\b|\bbi[\s-]?monthly\b/i, frequency: 'semimonthly' },
  { pattern: /\bfort\s?nightly\b|\bbi[\s-]?weekly\b|\bevery\s+two\s+weeks\b|\b2\s?weekly\b/i, frequency: 'fortnightly' },
  { pattern: /\bweekly\b/i, frequency: 'weekly' },
  { pattern: /\bmonthly\b|\bper\s+month\b|\bp\.?m\.?\b/i, frequency: 'monthly' },
  { pattern: /\bquarterly\b/i, frequency: 'quarterly' },
  { pattern: /\bannual(?:ly)?\b|\byearly\b|\bper\s+annum\b|\bp\.?a\.?\b/i, frequency: 'annual' },
];

/**
 * Look for an explicit frequency statement, but only on a line that is
 * actually ABOUT frequency.
 *
 * This restriction matters. A payslip routinely prints "Annual Salary
 * $120,000" or "Monthly Rent Allowance"; matching `/monthly/` anywhere in the
 * document would confidently return the wrong frequency. Only lines carrying a
 * frequency-declaring key are considered.
 */
const FREQUENCY_KEY = /\b(?:pay\s*(?:frequency|period|cycle|run)|frequency|pay\s*basis|payment\s*frequency|paid)\b/i;

export function inferStatedFrequency(lines: readonly string[]): FrequencyInference | null {
  for (const line of lines) {
    if (!FREQUENCY_KEY.test(line)) continue;
    for (const { pattern, frequency } of STATED_PATTERNS) {
      if (pattern.test(line)) {
        return { frequency, source: 'stated_on_payslip', confidence: 0.95 };
      }
    }
  }
  return null;
}

/**
 * Infer from the pay period's length.
 *
 * Day-count bands are deliberately narrow, and anything outside them returns
 * `unknown` rather than snapping to the nearest option. Note the inclusive
 * end-date convention: a fortnight printed as 01-Aug → 14-Aug spans 14 days,
 * so the span is (end - start + 1).
 */
export function inferFrequencyFromPeriod(
  periodStart: string | undefined,
  periodEnd: string | undefined,
): FrequencyInference | null {
  if (!periodStart || !periodEnd) return null;
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const days = Math.round((end - start) / 86_400_000) + 1;

  if (days >= 6 && days <= 8) return { frequency: 'weekly', source: 'derived_from_period', confidence: 0.8 };
  if (days >= 13 && days <= 15) return { frequency: 'fortnightly', source: 'derived_from_period', confidence: 0.8 };
  // 15/16-day halves of a month are semimonthly, but they overlap the
  // fortnightly band, so only an unambiguous 16 is claimed here.
  if (days === 16) return { frequency: 'semimonthly', source: 'derived_from_period', confidence: 0.6 };
  if (days >= 28 && days <= 31) return { frequency: 'monthly', source: 'derived_from_period', confidence: 0.85 };
  if (days >= 89 && days <= 92) return { frequency: 'quarterly', source: 'derived_from_period', confidence: 0.8 };
  if (days >= 364 && days <= 366) return { frequency: 'annual', source: 'derived_from_period', confidence: 0.85 };

  return null;
}

/**
 * Infer from the gaps between successive payment dates for the same employer.
 *
 * Requires at least two PRIOR payment dates (i.e. three data points including
 * the current one) before it will claim anything — one gap could be a
 * coincidence or an off-cycle payment.
 */
export function inferFrequencyFromHistory(
  paymentDate: string | undefined,
  priorPaymentDates: readonly string[],
): FrequencyInference | null {
  if (!paymentDate || priorPaymentDates.length < 2) return null;

  const dates = [...priorPaymentDates, paymentDate]
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (dates.length < 3) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    gaps.push(Math.round((dates[i] - dates[i - 1]) / 86_400_000));
  }

  const classify = (gap: number): PayFrequency | null => {
    if (gap >= 6 && gap <= 8) return 'weekly';
    if (gap >= 13 && gap <= 15) return 'fortnightly';
    if (gap >= 28 && gap <= 31) return 'monthly';
    if (gap >= 89 && gap <= 92) return 'quarterly';
    return null;
  };

  const classified = gaps.map(classify);
  const first = classified[0];
  // Every gap must agree. An irregular series is `irregular`, not a guess.
  if (first === null || !classified.every((c) => c === first)) {
    return { frequency: 'irregular', source: 'derived_from_history', confidence: 0.5 };
  }
  return { frequency: first, source: 'derived_from_history', confidence: 0.85 };
}

/**
 * The single entry point. Applies the preference order and returns
 * `unknown` when nothing is good enough.
 */
export function inferPayFrequency(args: {
  lines: readonly string[];
  periodStart?: string;
  periodEnd?: string;
  paymentDate?: string;
  priorPaymentDates?: readonly string[];
}): FrequencyInference {
  return (
    inferStatedFrequency(args.lines)
    ?? inferFrequencyFromPeriod(args.periodStart, args.periodEnd)
    ?? inferFrequencyFromHistory(args.paymentDate, args.priorPaymentDates ?? [])
    ?? { frequency: 'unknown', source: 'unknown', confidence: 0 }
  );
}

/**
 * Map a payroll frequency onto the canonical `income_sources.frequency`
 * vocabulary (`weekly|fortnightly|monthly|quarterly|annually|one_off`).
 *
 * NOTE the deliberate gap: the canonical Income model has NO `semimonthly`
 * and NO `irregular` value. Rather than silently mapping semimonthly to
 * monthly — which would understate annual income by about 8% — this returns
 * null, and the income adapter simply does not propose a frequency change,
 * leaving the user's existing value alone and flagging it for confirmation.
 * Inventing a mapping the canonical model cannot express is precisely what
 * spec section 23 forbids.
 */
export function toCanonicalIncomeFrequency(frequency: PayFrequency): string | null {
  switch (frequency) {
    case 'weekly': return 'weekly';
    case 'fortnightly': return 'fortnightly';
    case 'monthly': return 'monthly';
    case 'quarterly': return 'quarterly';
    case 'annual': return 'annually';
    case 'semimonthly':
    case 'irregular':
    case 'unknown':
    default:
      return null;
  }
}
