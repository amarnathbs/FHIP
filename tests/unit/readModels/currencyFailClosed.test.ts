/**
 * One FX lookup; unsupported currency fails closed (DC-12 / DC-13).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FX_RATE_AUD_INR, fxContext, loadFxContext, toReporting } from '@/lib/read-models/core/currency';
import { makeFakeSupabase } from './helpers/fakeSupabase';
import { profile, USER } from './helpers/fixtures';

describe('toReporting', () => {
  const aud = fxContext('AUD', 56);
  const inr = fxContext('INR', 56);

  it('same currency is unchanged; AUD <-> INR at the single rate', () => {
    expect(toReporting(100, 'AUD', aud)).toBe(100);
    expect(toReporting(5600, 'INR', aud)).toBe(100);
    expect(toReporting(100, 'AUD', inr)).toBe(5600);
  });

  it('USD, an unknown code, or a missing code -> null (never treated as the reporting currency)', () => {
    for (const c of ['USD', 'GBP', 'XYZ', null, undefined, '']) expect(toReporting(100, c as string, aud)).toBeNull();
  });

  it('an unsupported reporting preference falls back to AUD; a bad rate falls back to the documented default', () => {
    expect(fxContext('USD', 56).reportingCurrency).toBe('AUD');
    expect(fxContext('AUD', 0)).toMatchObject({ fxRateAudInr: DEFAULT_FX_RATE_AUD_INR, rateSource: 'default' });
    expect(fxContext('AUD', Number.NaN).rateSource).toBe('default');
  });
});

describe('loadFxContext', () => {
  it('reads preferred currency, country and the live rate', async () => {
    const { client } = makeFakeSupabase(profile('INR', 'IN', 60));
    expect(await loadFxContext(USER, client)).toEqual({ reportingCurrency: 'INR', fxRateAudInr: 60, rateSource: 'forecast_global_assumptions', countryCode: 'IN' });
  });

  it('a missing rate row uses the Dashboard default (56), labelled as such', async () => {
    const { client } = makeFakeSupabase(profile('AUD', 'AU', null));
    expect(await loadFxContext(USER, client)).toMatchObject({ fxRateAudInr: 56, rateSource: 'default' });
  });

  it('a failed rate query is an error (fail closed), not a silent default', async () => {
    const { client } = makeFakeSupabase(profile(), { failOn: new Set(['forecast_global_assumptions']) });
    await expect(loadFxContext(USER, client)).rejects.toMatchObject({ name: 'ReadModelUnavailableError', reason: 'query_failed' });
  });
});
