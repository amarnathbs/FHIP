/**
 * The read-model time window (DC-01 / EXP-G3 / PO D-02).
 *
 * THE RULE. Actual (imported) activity is averaged over the trailing THREE
 * COMPLETE calendar months before "today" in the household's own timezone --
 * never the current, still-open month alone (the old Dashboard rule, which
 * made a statement for last month count $0 the day it was approved). Within
 * that window, only months that an approved statement fully covers are
 * averaged (see coverage.ts); partial months are shown, not averaged.
 *
 * "Today" is taken in the user's timezone, derived from their country of
 * residence (AU -> Australia/Sydney, IN -> Asia/Kolkata). user_profiles has no
 * timezone column; a transaction date is a plain DATE, so only the choice of
 * "which month is the current one" depends on it (e.g. 1 Sep 08:00 in Sydney
 * is still 31 Aug in UTC).
 */

export type MonthKey = string; // 'YYYY-MM'
export type IsoDate = string; // 'YYYY-MM-DD'

export interface ReadWindow {
  kind: 'trailing_complete_months' | 'explicit';
  /** Inclusive first day. */
  from: IsoDate;
  /** Inclusive last day. */
  to: IsoDate;
  /** The complete calendar months inside [from, to], oldest first. */
  months: MonthKey[];
  /** The local date the window was computed from. */
  asOf: IsoDate;
  timeZone: string;
}

export const DEFAULT_TRAILING_MONTHS = 3;

const COUNTRY_TIMEZONES: Record<string, string> = {
  AU: 'Australia/Sydney',
  IN: 'Asia/Kolkata',
};

export function timeZoneForCountry(countryCode: string | null | undefined): string {
  return (countryCode && COUNTRY_TIMEZONES[countryCode.toUpperCase()]) || 'Australia/Sydney';
}

/** The calendar date of `now` in `timeZone`, as YYYY-MM-DD. */
export function localDateInZone(now: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(month: MonthKey): IsoDate {
  return `${month}-01`;
}

export function monthEnd(month: MonthKey): IsoDate {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The `n` complete calendar months before the month containing `asOf`. */
export function trailingCompleteMonthsWindow(asOf: IsoDate, n = DEFAULT_TRAILING_MONTHS, timeZone = 'Australia/Sydney'): ReadWindow {
  const current = monthOf(asOf);
  const months: MonthKey[] = [];
  for (let i = n; i >= 1; i -= 1) months.push(addMonths(current, -i));
  return { kind: 'trailing_complete_months', from: monthStart(months[0]), to: monthEnd(months[months.length - 1]), months, asOf, timeZone };
}

/** An explicit [from, to] window; `months` lists only the complete months inside it. */
export function explicitWindow(from: IsoDate, to: IsoDate, asOf: IsoDate = to, timeZone = 'Australia/Sydney'): ReadWindow {
  if (from > to) throw new Error(`window from ${from} is after to ${to}`);
  const months: MonthKey[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) {
    if (monthStart(m) >= from && monthEnd(m) <= to) months.push(m);
  }
  return { kind: 'explicit', from, to, months, asOf, timeZone };
}

/** The default window for a household, from the current instant. */
export function defaultWindowFor(countryCode: string | null | undefined, now: Date = new Date()): ReadWindow {
  const tz = timeZoneForCountry(countryCode);
  return trailingCompleteMonthsWindow(localDateInZone(now, tz), DEFAULT_TRAILING_MONTHS, tz);
}

export function isDateInWindow(date: IsoDate, window: ReadWindow): boolean {
  return date >= window.from && date <= window.to;
}
