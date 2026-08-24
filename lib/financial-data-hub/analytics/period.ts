/**
 * Financial Data Hub — FDH-8: time period resolution.
 *
 * PURE FUNCTIONS, NO DATABASE ACCESS, NO `Date.now()` DEFAULT BAKED IN. Every
 * function here takes "today" as an explicit parameter (ISO date string) so
 * tests are deterministic and no timezone/DST edge case can silently depend
 * on the machine running the code (spec section 94 — "late-night UTC must
 * not shift an AU transaction's financial date"). Callers at the API/page
 * boundary pass `new Date().toISOString().slice(0, 10)` (UTC calendar date)
 * — FDH-8 does not introduce a second timezone convention; it uses the same
 * canonical `transaction_date` (a DATE column, already timezone-free) that
 * every other FDH phase uses (spec 24).
 */

export type IsoDate = string; // 'YYYY-MM-DD'

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

export const PERIOD_PRESETS = [
  'this_month',
  'last_month',
  '3_months',
  '6_months',
  '12_months',
  'year_to_date',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIso(year: number, month1to12: number, day: number): IsoDate {
  return `${year}-${pad2(month1to12)}-${pad2(day)}`;
}

/** Last calendar day of a given year/month (1-12), leap-year correct because
 * it relies on `Date.UTC` day-0 rollover rather than a hand-rolled table. */
function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function parseIso(date: IsoDate): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Subtract N whole calendar months from an ISO date, clamping the day to
 * the target month's length (e.g. Mar 31 - 1 month = Feb 28/29, never Mar 3). */
function subtractMonths(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseIso(date);
  const totalMonths = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const clampedDay = Math.min(day, lastDayOfMonth(targetYear, targetMonth));
  return toIso(targetYear, targetMonth, clampedDay);
}

/** Resolves a preset (or explicit custom range) to a concrete [from, to]
 * inclusive `transaction_date` range, given an explicit "today". */
export function resolvePeriod(
  preset: PeriodPreset,
  today: IsoDate,
  custom?: DateRange,
): DateRange {
  const { year, month } = parseIso(today);
  switch (preset) {
    case 'this_month':
      return { from: toIso(year, month, 1), to: toIso(year, month, lastDayOfMonth(year, month)) };
    case 'last_month': {
      const totalMonths = year * 12 + (month - 1) - 1;
      const ly = Math.floor(totalMonths / 12);
      const lm = (totalMonths % 12) + 1;
      return { from: toIso(ly, lm, 1), to: toIso(ly, lm, lastDayOfMonth(ly, lm)) };
    }
    case '3_months':
      return { from: subtractMonths(today, 3), to: today };
    case '6_months':
      return { from: subtractMonths(today, 6), to: today };
    case '12_months':
      return { from: subtractMonths(today, 12), to: today };
    case 'year_to_date':
      return { from: toIso(year, 1, 1), to: today };
    case 'custom':
      if (!custom) throw new RangeError('resolvePeriod: preset "custom" requires an explicit range');
      if (custom.from > custom.to) {
        throw new RangeError(`resolvePeriod: custom range "from" (${custom.from}) is after "to" (${custom.to})`);
      }
      return custom;
    default: {
      const exhaustive: never = preset;
      throw new RangeError(`resolvePeriod: unknown preset ${String(exhaustive)}`);
    }
  }
}

export type PartialPeriodMode = 'equivalent_elapsed' | 'full_previous_period';

export interface PreviousPeriodResult {
  range: DateRange;
  /** true when the current period is not yet finished (its `to` is in the
   * future relative to "today") — callers must disclose this rather than
   * silently comparing a partial month to a full one (spec 56). */
  currentPeriodIsPartial: boolean;
  mode: PartialPeriodMode;
}

/**
 * The immediately-preceding period of equal calendar length, for
 * period-over-period comparison. When `mode: 'equivalent_elapsed'` (the
 * default) and the current period is still in progress (its `to` is after
 * `today`), the previous period is truncated to the SAME number of elapsed
 * days so "this month so far" is compared to "last month, same number of
 * days" rather than a full month — an apples-to-apples comparison, per spec
 * 56 ("partial period comparisons must be either equivalent-elapsed-period
 * or explicitly disclosed as different"). `currentPeriodIsPartial` tells the
 * caller to render the disclosure even when using `equivalent_elapsed`.
 */
export function resolvePreviousPeriod(
  current: DateRange,
  today: IsoDate,
  mode: PartialPeriodMode = 'equivalent_elapsed',
): PreviousPeriodResult {
  const msPerDay = 86_400_000;
  const fromMs = Date.parse(`${current.from}T00:00:00Z`);
  const toMs = Date.parse(`${current.to}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const currentPeriodIsPartial = toMs > todayMs;

  const lengthDays = Math.round((toMs - fromMs) / msPerDay) + 1;
  const effectiveToMs = currentPeriodIsPartial ? todayMs : toMs;
  const elapsedDays = Math.round((effectiveToMs - fromMs) / msPerDay) + 1;

  const spanDays = mode === 'equivalent_elapsed' && currentPeriodIsPartial ? elapsedDays : lengthDays;

  const prevToMs = fromMs - msPerDay;
  const prevFromMs = prevToMs - (spanDays - 1) * msPerDay;
  const isoFromMs = (ms: number): IsoDate => new Date(ms).toISOString().slice(0, 10);

  return {
    range: { from: isoFromMs(prevFromMs), to: isoFromMs(prevToMs) },
    currentPeriodIsPartial,
    mode,
  };
}

/** Formats a `Record<'YYYY-MM', ...>` bucket key from an ISO date — the
 * single canonical month-grouping key used by trend/comparison logic. */
export function monthBucketKey(isoDate: IsoDate): string {
  return isoDate.slice(0, 7); // 'YYYY-MM'
}
