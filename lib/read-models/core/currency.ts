/**
 * One FX lookup for every read model (DC-12 / DC-13).
 *
 * The app supports two reporting currencies, AUD and INR, converted with the
 * single live `fx_rate_aud_inr` row (the same row and the same fallback the
 * Dashboard already uses -- see lib/services/dashboardData.ts getFxRateAudInr).
 * It is looked up ONCE per request and passed to every selector, so two
 * figures on one screen can never be converted at different rates.
 *
 * FAIL CLOSED on an unsupported currency: a USD (or any other) amount is
 * never treated as if it were already in the reporting currency. It gets
 * `amountReporting = null`, is left out of every total, and is surfaced in
 * the selector's `unconverted` tally.
 */
import { fetchOne, type ReadModelClient } from './paginate';
import { roundMoney } from './types';

export const SUPPORTED_REPORTING_CURRENCIES = ['AUD', 'INR'] as const;
export type ReportingCurrency = (typeof SUPPORTED_REPORTING_CURRENCIES)[number];

/** Same fallback as dashboard.ts DEFAULT_FX_RATE_AUD_INR / getFxRateAudInr. */
export const DEFAULT_FX_RATE_AUD_INR = 56;

export interface FxContext {
  reportingCurrency: ReportingCurrency;
  /** INR per 1 AUD. */
  fxRateAudInr: number;
  rateSource: 'forecast_global_assumptions' | 'default';
  /** The user's country of residence (drives the local-date timezone). */
  countryCode: string | null;
}

export function isSupportedCurrency(code: string | null | undefined): code is ReportingCurrency {
  return code === 'AUD' || code === 'INR';
}

/** Converts once. Returns null for an unsupported / missing currency. */
export function toReporting(amount: number, currency: string | null | undefined, fx: FxContext): number | null {
  if (!isSupportedCurrency(currency)) return null;
  if (currency === fx.reportingCurrency) return roundMoney(amount);
  return roundMoney(currency === 'INR' ? amount / fx.fxRateAudInr : amount * fx.fxRateAudInr);
}

export function fxContext(reportingCurrency: string | null | undefined, fxRateAudInr: number | null | undefined, countryCode: string | null = null): FxContext {
  const rate = typeof fxRateAudInr === 'number' && Number.isFinite(fxRateAudInr) && fxRateAudInr > 0 ? fxRateAudInr : null;
  return {
    reportingCurrency: isSupportedCurrency(reportingCurrency) ? reportingCurrency : 'AUD',
    fxRateAudInr: rate ?? DEFAULT_FX_RATE_AUD_INR,
    rateSource: rate ? 'forecast_global_assumptions' : 'default',
    countryCode,
  };
}

/**
 * Loads the household's reporting currency (user_profiles.preferred_currency,
 * AUD when unset -- the Dashboard's rule) and the live AUD/INR rate. A failed
 * query is 'unavailable', never a silent default; a MISSING rate row falls
 * back to the documented default exactly as the Dashboard does today.
 */
export async function loadFxContext(userId: string, client: ReadModelClient): Promise<FxContext> {
  const profile = await fetchOne<{ preferred_currency: string | null; country_of_residence: string | null }>('user_profiles', () =>
    client.from('user_profiles').select('preferred_currency, country_of_residence').eq('user_id', userId).maybeSingle(),
  );
  const rateRow = await fetchOne<{ assumption_value: number | null }>('forecast_global_assumptions', () =>
    client
      .from('forecast_global_assumptions')
      .select('assumption_value')
      .eq('assumption_key', 'fx_rate_aud_inr')
      .eq('is_active', true)
      .is('country_code', null)
      .maybeSingle(),
  );
  return fxContext(profile?.preferred_currency ?? null, rateRow?.assumption_value == null ? null : Number(rateRow.assumption_value), profile?.country_of_residence ?? null);
}
