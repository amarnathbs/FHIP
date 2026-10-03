// Holdings-only positions and the investment date (Document2 defect D-3,
// PO decision 2026-10-03).
//
// A statement can give us a HOLDING (units and a value on a date) with no
// purchase / transaction date at all -- a "holdings-only" position. Before this
// module existed such a position was shown as "holding only; no transactions
// uploaded" and silently fell out of every return calculation.
//
// PO decision: do not silently use a statement value and do not silently
// exclude it. ASK the user for the investment date, validate it, then treat it
// exactly as if the purchase date had been captured from the statement: pull
// the NAV on that date and let the existing pipeline compute from there. Until
// the user answers, the position is "needs investment date" with a call to
// action, and nothing else is blocked.
//
// EVERYTHING HERE IS PURE (no I/O) so the rules are unit-testable. The I/O
// lives in lib/services/investment-intelligence/investmentDateService.ts.

import { formatDateInput, parseDateInput } from '@/lib/engines/dateInput';

/** Provenance recorded for a date the user typed (stored on ii_investment_date_inputs.provenance). */
export const USER_INVESTMENT_DATE_PROVENANCE = 'user_supplied' as const;

/**
 * `source_reference` marker on the one derived ii_transactions row. It is how
 * every consumer can tell, from the row alone, that the date came from the
 * user and the amount from the NAV on that date (never from a statement line).
 */
export const USER_INVESTMENT_DATE_REFERENCE_PREFIX = 'USER_INVESTMENT_DATE:';

export function userInvestmentDateReference(inputId: string): string {
  return `${USER_INVESTMENT_DATE_REFERENCE_PREFIX}${inputId}`;
}

export function isUserSuppliedInvestmentDateReference(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(USER_INVESTMENT_DATE_REFERENCE_PREFIX);
}

/** A weekend / market holiday has no NAV: the latest NAV within this many days before the date is used. */
export const NAV_MAX_STALE_DAYS = 7;

/** Units below this are rounding noise on a statement (same value the India MF report uses). */
const UNIT_EPSILON = 0.001;

/** The transaction types that put units into a position (the report's own "acquiring" set). */
export const ACQUIRING_TRANSACTION_TYPES: ReadonlySet<string> = new Set(['purchase', 'sip', 'switch_in', 'stp_in', 'reinvestment', 'bonus', 'transfer_in']);

// ---------------------------------------------------------------------------
// Validation of the typed date
// ---------------------------------------------------------------------------
export type InvestmentDateErrorCode = 'required' | 'not_a_date' | 'in_future' | 'before_inception' | 'after_statement';

export type InvestmentDateValidation =
  | { ok: true; iso: string }
  | { ok: false; code: InvestmentDateErrorCode; message: string };

export interface ValidateInvestmentDateArgs {
  /** What the user typed (day first). */
  text: string | null | undefined;
  /** Today, ISO yyyy-mm-dd. Injected, never read from the clock here. */
  todayIso: string;
  /** The earliest date the fund has a NAV, when known (ii_nav_history_floors). Null = unknown, not checked. */
  inceptionIso?: string | null;
  /** The as-of date of the statement holding. A purchase after it cannot be part of those units. */
  statementAsOfIso?: string | null;
}

/**
 * Day-first, real calendar date, not in the future, not before the fund's
 * inception (when known), and not after the statement date the units were
 * counted on. Messages show dates day-first (dd-mm-yyyy), never ISO.
 */
export function validateInvestmentDate(args: ValidateInvestmentDateArgs): InvestmentDateValidation {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return { ok: false, code: 'required', message: 'Enter the date you invested, like 01-10-2026.' };
  const iso = parseDateInput(text);
  if (!iso) return { ok: false, code: 'not_a_date', message: 'That is not a real date. Type it as day-month-year, like 01-10-2026.' };
  if (iso > args.todayIso) return { ok: false, code: 'in_future', message: 'The investment date cannot be in the future.' };
  if (args.inceptionIso && iso < args.inceptionIso) {
    return { ok: false, code: 'before_inception', message: `This fund has no price history before ${formatDateInput(args.inceptionIso)}, so it cannot have been bought on ${formatDateInput(iso)}.` };
  }
  if (args.statementAsOfIso && iso > args.statementAsOfIso) {
    return { ok: false, code: 'after_statement', message: `Your statement already shows these units on ${formatDateInput(args.statementAsOfIso)}, so they were bought on or before that date.` };
  }
  return { ok: true, iso };
}

// ---------------------------------------------------------------------------
// NAV on the investment date and the derived purchase
// ---------------------------------------------------------------------------
export interface NavPoint {
  date: string; // ISO
  price: number;
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The NAV that stands for the investment date: the latest one ON or BEFORE
 * that date, no older than `maxStaleDays`. Null when there is none -- the
 * caller then keeps the date and waits for NAV history, it never invents a NAV.
 */
export function pickNavForInvestmentDate(navs: readonly NavPoint[], dateIso: string, maxStaleDays: number = NAV_MAX_STALE_DAYS): NavPoint | null {
  let best: NavPoint | null = null;
  for (const n of navs) {
    if (!Number.isFinite(n.price) || n.price <= 0) continue;
    if (n.date > dateIso) continue;
    if (best === null || n.date > best.date) best = n;
  }
  if (best === null) return null;
  return daysBetweenIso(best.date, dateIso) <= maxStaleDays ? best : null;
}

export interface DerivedPurchase {
  units: number;
  pricePerUnit: number;
  /** units x NAV, rounded to 2 places (the ii_transactions.gross_amount scale). */
  grossAmount: number;
}

/** The purchase the statement would have shown: all the held units, bought on the date, at that day's NAV. */
export function deriveInvestmentDatePurchase(args: { units: number; navPrice: number }): DerivedPurchase | null {
  if (!Number.isFinite(args.units) || args.units <= UNIT_EPSILON) return null;
  if (!Number.isFinite(args.navPrice) || args.navPrice <= 0) return null;
  return { units: args.units, pricePerUnit: args.navPrice, grossAmount: Math.round(args.units * args.navPrice * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Which positions need a date
// ---------------------------------------------------------------------------
export interface PositionForDateCheck {
  snapshotUnits: number;
  transactions: ReadonlyArray<{ type: string; status: string; sourceReference: string | null }>;
  /** Is there already an active (awaiting or applied) user-supplied date for this position? */
  hasActiveInput: boolean;
}

/** The same exclusion every analytics reader applies to a transaction. */
export function isUsableTransactionStatus(status: string): boolean {
  return status !== 'reversed' && status !== 'review_required';
}

/**
 * Holdings-only = a certified-or-not holding with units, and NO usable
 * transaction of any kind (the India MF report's own `noTransactions`). A
 * position that already has a user-supplied date is not asked again.
 */
export function needsInvestmentDate(p: PositionForDateCheck): boolean {
  if (p.hasActiveInput) return false;
  if (!(p.snapshotUnits > UNIT_EPSILON)) return false;
  return !p.transactions.some((t) => isUsableTransactionStatus(t.status));
}

export type InvestmentDateItemState = 'needs_date' | 'awaiting_nav' | 'applied';

export const INVESTMENT_DATE_STATE_LABEL: Record<InvestmentDateItemState, string> = {
  needs_date: 'Needs investment date',
  awaiting_nav: 'Date saved, waiting for price history',
  applied: 'Investment date added by you',
};

/** One short sentence per state; what is true, what happens next. */
export const INVESTMENT_DATE_STATE_HELP: Record<InvestmentDateItemState, string> = {
  needs_date: 'Your statement shows what you hold but not when you bought it. Add the date and we will work out your return from then. Everything else keeps working meanwhile.',
  awaiting_nav: 'We have your date. We are still loading this fund’s price history for it, and your return appears once that is in.',
  applied: 'The cost is the fund’s price on the date you gave, not a figure from your statement. You can change the date at any time.',
};
