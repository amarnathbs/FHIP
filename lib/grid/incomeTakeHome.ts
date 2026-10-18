/**
 * Take-home pay of one Income grid row (PO request 17-10-2026: "add a Take-home column so the user can see the net next to the gross").
 *
 * ONE SOURCE OF TRUTH. The figure is `resolveNetBasis` from lib/engines/incomeNetBasis.ts - the SAME function the Dashboard
 * (lib/engines/dashboard.ts), the Income read model (lib/read-models/income.ts) and the Monthly Report use - applied to the row's own
 * gross, take-home and tax, all on the row's OWN pay period (frequency). Nothing here recomputes the rule:
 *   entered take-home -> else gross minus entered tax -> else the gross is ASSUMED to be take-home (PO decision 16-10-2026).
 * The plausibility hint is `assessNetToGross` from lib/engines/incomePlausibility.ts, tested on wage-like rows only, exactly as the
 * Dashboard does. The annual equivalent uses the same `toMonthly(...) * 12` the grid's "Total annual value" footer uses.
 *
 * Pure and client-safe (no server-only import), so the grid cell, the form's live line, the footer and the tests share it.
 */
import { resolveNetBasis, type NetBasis } from '@/lib/engines/incomeNetBasis';
import { assessNetToGross, isWageLikeIncome, type NetToGrossAssessment } from '@/lib/engines/incomePlausibility';
import { toMonthly, type Frequency } from '@/lib/engines/money';

/** The row fields the take-home needs. Values may be numbers, numeric strings, '' (blank form box) or null. */
export interface IncomeTakeHomeRow {
  amount?: unknown;
  net_amount?: unknown;
  tax_amount?: unknown;
  frequency?: unknown;
  master_item_key?: string | null;
  source_type?: unknown;
}

export interface IncomeTakeHome {
  /** Gross per the row's own frequency. */
  gross: number;
  /** Take-home per the row's own frequency (the figure the column shows). */
  net: number;
  basis: NetBasis;
  frequency: Frequency | null;
  /** Gross / take-home as a full year (`toMonthly(x) * 12`, the footer's rule); 0 for a one-off, which has no yearly rate. */
  annualGross: number;
  annualNet: number;
  /** False for a one-off or a row with no frequency: there is no yearly equivalent to state. */
  hasAnnualEquivalent: boolean;
  plausibility: NetToGrossAssessment;
  /** take-home / gross as a whole percent, or null when the gross is not above zero. */
  netPercentOfGross: number | null;
}

const FREQUENCIES: readonly string[] = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'];

/** A blank box, null or text that is not a number is "not entered" (null); anything numeric is passed on for the rule to judge. */
function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** null when there is no usable gross yet (a blank form), so nothing is shown rather than a made-up figure. */
export function incomeTakeHome(row: IncomeTakeHomeRow): IncomeTakeHome | null {
  const gross = numberOrNull(row.amount);
  if (gross === null || gross < 0) return null;
  const { net, basis } = resolveNetBasis(gross, numberOrNull(row.net_amount), numberOrNull(row.tax_amount));
  const frequency = typeof row.frequency === 'string' && FREQUENCIES.includes(row.frequency) ? (row.frequency as Frequency) : null;
  const annualGross = frequency ? cents(toMonthly(gross, frequency) * 12) : 0;
  const annualNet = frequency ? cents(toMonthly(net, frequency) * 12) : 0;
  const wage = isWageLikeIncome(row.master_item_key ?? null, typeof row.source_type === 'string' ? row.source_type : null);
  return {
    gross,
    net,
    basis,
    frequency,
    annualGross,
    annualNet,
    hasAnnualEquivalent: frequency !== null && frequency !== 'one_off',
    plausibility: wage ? assessNetToGross(gross, net) : 'ok',
    netPercentOfGross: gross > 0 ? Math.round((net / gross) * 100) : null,
  };
}

/** The short label under the figure. The assumed wording is the PO's own (decision 16-10-2026). */
export const TAKE_HOME_BASIS_SHORT: Record<NetBasis, string> = {
  entered: 'entered',
  derived_from_tax: 'from tax',
  assumed_gross: 'assumed = gross (no tax deducted)',
};

/** How the form's live line names the basis. */
export const TAKE_HOME_BASIS_LIVE: Record<NetBasis, string> = {
  entered: 'entered',
  derived_from_tax: 'from tax',
  assumed_gross: 'assumed gross: no tax deducted',
};

/** "a fortnight", "a year": the period a per-frequency figure is for. */
export const TAKE_HOME_PERIOD_WORDS: Record<Frequency, string> = {
  weekly: 'a week',
  fortnightly: 'a fortnight',
  monthly: 'a month',
  quarterly: 'a quarter',
  annually: 'a year',
  one_off: 'one-off',
};

/** A short, non-alarming hint for a row whose take-home looks off, or null when it looks fine. */
export function takeHomeHint(t: IncomeTakeHome): { short: string; long: string } | null {
  if (t.plausibility === 'net_far_below_gross') {
    return {
      short: `Check take-home: only ${t.netPercentOfGross ?? 0}% of gross`,
      long: `Take-home is only ${t.netPercentOfGross ?? 0}% of the gross, which tax alone rarely explains. Check that both amounts are for the same pay period.`,
    };
  }
  if (t.plausibility === 'net_above_gross') {
    return {
      short: 'Check take-home: more than gross',
      long: 'Take-home is more than the gross, which is not possible for a wage. Check both amounts.',
    };
  }
  return null;
}

/** The form field after which the live line is shown. */
export const TAKE_HOME_LIVE_AFTER_FIELD = 'tax_amount';
