/**
 * Day-first date display for the bank-statement screens (2026-10-29).
 *
 * A person never reads a year-first (yyyy-mm-dd) or month-first date (PO standing rule): Australian accounts show
 * dd/mm/yyyy, Indian accounts dd-mm-yyyy. The one canonical formatter is `formatDateShort` (lib/engines/date.ts); this is
 * only the null-safe adapter the statement screens need, because every date there arrives from the API as a raw ISO `date`
 * string (or null) and the account's currency decides the style. Lives beside the formatter because the data hub's own library folder
 * must import no calculation engine (tests/unit/fdh1Isolation.test.ts).
 */

import { formatDateShort } from './date';

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

/** The date style for an account currency: INR is dd-mm-yyyy, everything else dd/mm/yyyy. */
export function dateStyleForCurrency(currency: string | null | undefined): 'AUD' | 'INR' {
  return currency === 'INR' ? 'INR' : 'AUD';
}

/** An API date (yyyy-mm-dd or a timestamp) as the user's day-first text; `fallback` when there is none. */
export function displayDate(value: string | null | undefined, currency: string | null | undefined, fallback = ''): string {
  if (!value) return fallback;
  const m = ISO_DATE_PREFIX.exec(value);
  return m ? formatDateShort(m[1], dateStyleForCurrency(currency)) : value;
}

/** "01/08/2026 to 31/08/2026", or null when the statement prints no period at all. */
export function displayPeriod(start: string | null | undefined, end: string | null | undefined, currency: string | null | undefined): string | null {
  if (!start && !end) return null;
  if (start && end) return `${displayDate(start, currency)} to ${displayDate(end, currency)}`;
  return displayDate(start ?? end, currency);
}
