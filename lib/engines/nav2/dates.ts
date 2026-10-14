// NAV2 -- small, pure, UTC-only ISO-date helpers (yyyy-mm-dd strings are data;
// they are never shown raw: user-visible text goes through showDate() in
// types.ts, which uses lib/engines/date.ts formatDateShort). Whole-day
// differences reuse the R5 date-alignment module's daysBetween so there is one
// day-count implementation.

import { __dateAlignmentInternals } from '@/lib/engines/investment-intelligence/sip/dateAlignment';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written yyyy-mm-dd (rejects 2026-02-30, 2026-13-01, "2026-1-1"). */
export function isValidIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** Whole calendar days from a to b (b - a). Negative when b is earlier. */
export function daysBetweenIso(a: string, b: string): number {
  return __dateAlignmentInternals.daysBetween(a, b);
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * `n` calendar months before `iso`, same day of month, clamped to the last day of the target month
 * (31 March minus 1 month is 28/29 February). This is the "t - horizon" of a rolling window (spec 8.5).
 */
export function subtractMonthsIso(iso: string, n: number): string {
  // remembered (a rolling window asks for the same date and horizon once per fund): same answer, bounded memory (see toUtc in the R5 date module)
  const key = `${iso}|${n}`;
  const hit = SUBTRACT_CACHE.get(key);
  if (hit !== undefined) return hit;
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12; // 0-based month
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(ty, tm, Math.min(d, lastDay))).toISOString().slice(0, 10);
  if (SUBTRACT_CACHE.size >= 100_000) SUBTRACT_CACHE.clear();
  SUBTRACT_CACHE.set(key, out);
  return out;
}
const SUBTRACT_CACHE = new Map<string, string>();

/** Monday to Friday days in [from, to], inclusive. A coverage yardstick only (it knows no market holidays). */
export function weekdayCount(from: string, to: string): number {
  if (to < from) return 0;
  const total = daysBetweenIso(from, to) + 1;
  const fullWeeks = Math.floor(total / 7);
  let count = fullWeeks * 5;
  const startDow = new Date(`${from}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  for (let i = 0; i < total % 7; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/** ISO 8601 week key (e.g. 2026-W40) used to resample to weekly observations. */
export function isoWeekKey(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // the Thursday of this week decides the year
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
