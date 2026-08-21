import { describe, it, expect } from 'vitest';
import { assetSchema } from '@/lib/validation/asset';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import {
  currencyMismatch,
  currencyMismatchBlocked,
  currencyMatchesCountry,
} from '@/lib/validation/currencyCountry';
import { expectedCurrencyForCountry, COUNTRY_TO_CURRENCY } from '@/lib/constants';

// AR-0 §3.2 / Chunk 2 item 1: country/currency hard block, exercised against
// Spec 1's exact Case A-D scenarios.

function baseAsset(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    asset_name: 'Test asset',
    current_value: 100000,
    owner: 'self' as const,
    ...overrides,
  };
}

describe('COUNTRY_TO_CURRENCY / expectedCurrencyForCountry', () => {
  it('maps AU -> AUD and IN -> INR', () => {
    expect(COUNTRY_TO_CURRENCY.AU).toBe('AUD');
    expect(COUNTRY_TO_CURRENCY.IN).toBe('INR');
    expect(expectedCurrencyForCountry('AU')).toBe('AUD');
    expect(expectedCurrencyForCountry('IN')).toBe('INR');
  });

  it('returns undefined for no/unsupported country', () => {
    expect(expectedCurrencyForCountry(undefined)).toBeUndefined();
    expect(expectedCurrencyForCountry(null)).toBeUndefined();
    expect(expectedCurrencyForCountry('US')).toBeUndefined();
  });
});

describe('Spec 1 Case A — AU/AUD/100,000 (matching pair)', () => {
  it('is not blocked and saves cleanly', () => {
    const row = { country_code: 'AU', currency_code: 'AUD' as const };
    expect(currencyMismatch(row)).toBe(false);
    expect(currencyMismatchBlocked(row)).toBe(false);

    const parsed = assetSchema.safeParse(baseAsset({ current_value: 100000, country_code: 'AU', currency_code: 'AUD' }));
    expect(parsed.success).toBe(true);
  });
});

describe('Spec 1 Case B — India/INR/10,000,000 (matching pair, must not become AUD)', () => {
  it('is not blocked and the stored currency stays INR, not silently AUD', () => {
    const row = { country_code: 'IN', currency_code: 'INR' as const };
    expect(currencyMismatch(row)).toBe(false);

    const parsed = assetSchema.safeParse(
      baseAsset({ current_value: 10000000, country_code: 'IN', currency_code: 'INR' })
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency_code).toBe('INR');
      expect(parsed.data.country_code).toBe('IN');
    }
  });

  it('a 10,000,000 INR asset must not be added to net worth as if it were 10,000,000 AUD', () => {
    const EMPTY: DashboardInput = {
      income: [],
      expenses: [],
      assets: [],
      liabilities: [],
      investments: [],
      retirement: [],
      insurance: [],
      goals: [],
      snapshots: [],
    };
    const fxRateAudInr = 56;
    const d = computeDashboard(
      { ...EMPTY, assets: [{ current_value: 10000000, asset_class: 'cash', currency_code: 'INR', country_code: 'IN' }] },
      'AUD',
      fxRateAudInr
    );
    expect(d.totalAssets).toBeCloseTo(10000000 / fxRateAudInr);
    expect(d.totalAssets).not.toBe(10000000);
  });
});

describe('Spec 1 Case C — India/AUD manually selected (mismatch)', () => {
  it('is blocked without the override flag', () => {
    const row = { country_code: 'IN', currency_code: 'AUD' as const };
    expect(currencyMismatch(row)).toBe(true);
    expect(currencyMismatchBlocked(row)).toBe(true);

    const parsed = assetSchema.safeParse(
      baseAsset({ current_value: 100000, country_code: 'IN', currency_code: 'AUD' })
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(['currency_code']);
    }
  });

  it('succeeds once the explicit override flag is set', () => {
    const row = { country_code: 'IN', currency_code: 'AUD' as const, currency_override: true };
    expect(currencyMismatch(row)).toBe(true); // still shown as a mismatch...
    expect(currencyMismatchBlocked(row)).toBe(false); // ...but no longer blocking

    const parsed = assetSchema.safeParse(
      baseAsset({ current_value: 100000, country_code: 'IN', currency_code: 'AUD', currency_override: true })
    );
    expect(parsed.success).toBe(true);
  });

  it('the override is never silently defaulted true for an ordinary row', () => {
    expect(currencyMatchesCountry({ country_code: 'IN', currency_code: 'AUD' })).toBe(false);
  });
});

describe('Spec 1 Case D — mixed AUD+INR household net worth', () => {
  it('preserves source values, converts totals correctly, and uses one consistent base currency', () => {
    const EMPTY: DashboardInput = {
      income: [],
      expenses: [],
      assets: [],
      liabilities: [],
      investments: [],
      retirement: [],
      insurance: [],
      goals: [],
      snapshots: [],
    };
    const fxRateAudInr = 56;
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [
          { current_value: 100000, asset_class: 'cash', currency_code: 'AUD', country_code: 'AU' },
          { current_value: 560000, asset_class: 'cash', currency_code: 'INR', country_code: 'IN' }, // = 10,000 AUD
        ],
      },
      'AUD',
      fxRateAudInr
    );
    // Matches lib/engines/fx.ts's convertToReportingCurrency() convention exactly.
    expect(d.totalAssets).toBe(100000 + 560000 / fxRateAudInr);
    expect(d.totalAssets).toBe(110000);
    expect(d.netWorth).toBe(110000);
  });
});

describe('no country selected — nothing to cross-check yet', () => {
  it('does not block a row before the user has picked a country', () => {
    const row = { currency_code: 'AUD' as const };
    expect(currencyMismatch(row)).toBe(false);
    expect(currencyMismatchBlocked(row)).toBe(false);
  });
});

describe('income/expense/insurance have no country_code field and are unaffected', () => {
  it('a currency/country cross-check is a no-op with no country_code present', () => {
    expect(currencyMatchesCountry({ currency_code: 'AUD' })).toBe(true);
    expect(currencyMatchesCountry({ currency_code: 'INR' })).toBe(true);
  });
});
