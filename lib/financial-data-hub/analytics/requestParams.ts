/**
 * Financial Data Hub — FDH-8: shared request-parameter parsing for the
 * Financial Activity API routes. Kept in one place so every route resolves
 * `period=` the same way rather than each route re-implementing preset
 * parsing slightly differently.
 */

import { PERIOD_PRESETS, resolvePeriod, type DateRange, type PeriodPreset } from './period';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPreset(value: string | null): value is PeriodPreset {
  return !!value && (PERIOD_PRESETS as readonly string[]).includes(value);
}

/** Today's UTC calendar date — the one place FDH-8 reads the wall clock.
 * Everything downstream (period.ts) takes it as an explicit parameter. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ParsedActivityParams {
  period: DateRange;
  accountId: string | null;
  error: string | null;
}

/** Reads `period` (a preset, default `this_month`), `from`/`to` (required
 * together when `period=custom`) and `account_id` from a request URL. */
export function parseActivityParams(url: URL): ParsedActivityParams {
  const presetParam = url.searchParams.get('period');
  const preset: PeriodPreset = isPreset(presetParam) ? presetParam : 'this_month';
  const accountId = url.searchParams.get('account_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (preset === 'custom') {
    if (!from || !to || !ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      return { period: { from: todayIsoDate(), to: todayIsoDate() }, accountId, error: 'period=custom requires valid from= and to= (YYYY-MM-DD)' };
    }
    if (from > to) {
      return { period: { from, to }, accountId, error: '"from" must not be after "to"' };
    }
    return { period: { from, to }, accountId, error: null };
  }

  try {
    return { period: resolvePeriod(preset, todayIsoDate()), accountId, error: null };
  } catch (e) {
    return { period: { from: todayIsoDate(), to: todayIsoDate() }, accountId, error: e instanceof Error ? e.message : 'invalid period' };
  }
}
