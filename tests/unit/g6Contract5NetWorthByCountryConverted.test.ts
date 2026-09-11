// G6 Contract 5 (docs/country-programme/g6-data-contracts.md) —
// DashboardSummary.netWorthByCountryConverted: a converted, currency-aware
// per-country net-worth view, additive alongside the existing (unconverted)
// assetsByCountry/liabilitiesByCountry/retirementByCountry.
import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';

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

function byCountry(rows: { countryCode: string; value: number }[], code: string): number | undefined {
  return rows.find((r) => r.countryCode === code)?.value;
}

describe('computeDashboard — netWorthByCountryConverted (G6 Contract 5)', () => {
  it('single-country, single-currency household: converted value equals the raw (unconverted) value — no double-counting or scaling drift', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [{ current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' }],
        liabilities: [{ balance: 20000, interest_rate: 5, monthly_repayment: 500, debt_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD' }],
      },
      'AUD'
    );
    expect(byCountry(d.assetsByCountry, 'AU')).toBe(100000);
    expect(byCountry(d.netWorthByCountryConverted, 'AU')).toBe(80000);
  });

  it('cross-border: each country bucket is converted through the SAME fx rate/function used for the blended netWorth total, not a new one', () => {
    const fxRateAudInr = 55;
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [
          { current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' },
          { current_value: 5500000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR' },
        ],
        liabilities: [{ balance: 20000, interest_rate: 5, monthly_repayment: 500, debt_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD' }],
      },
      'AUD',
      fxRateAudInr
    );
    // IN bucket: 5,500,000 INR / 55 = 100,000 AUD converted.
    expect(byCountry(d.netWorthByCountryConverted, 'IN')).toBe(100000);
    // AU bucket: 100,000 - 20,000 = 80,000 AUD, unaffected by the IN rate.
    expect(byCountry(d.netWorthByCountryConverted, 'AU')).toBe(80000);
    // The blended total reconciles with the sum of the per-country converted
    // buckets (both assets are wholly captured — no double count, no drop).
    const sumOfBuckets = d.netWorthByCountryConverted.reduce((s, r) => s + r.value, 0);
    expect(sumOfBuckets).toBe(d.netWorth);
  });

  it('additive-only contract: the existing unconverted assetsByCountry/liabilitiesByCountry stay in native currency, byte-for-byte, unaffected by this new field', () => {
    const d = computeDashboard(
      {
        ...EMPTY,
        assets: [{ current_value: 5500000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR' }],
      },
      'AUD',
      55
    );
    // The legacy unconverted rollup still shows the raw INR figure...
    expect(byCountry(d.assetsByCountry, 'IN')).toBe(5500000);
    // ...while the new converted rollup shows the AUD-equivalent.
    expect(byCountry(d.netWorthByCountryConverted, 'IN')).toBe(100000);
  });

  it('a country with only a liability (no assets/retirement) still appears, with a negative net-worth-by-country value', () => {
    const d = computeDashboard(
      { ...EMPTY, liabilities: [{ balance: 30000, interest_rate: 5, monthly_repayment: 500, debt_type: 'personal_loan', country_code: 'AU', currency_code: 'AUD' }] },
      'AUD'
    );
    expect(byCountry(d.netWorthByCountryConverted, 'AU')).toBe(-30000);
  });

  it('empty household: netWorthByCountryConverted is an empty array, never a fabricated zero-value row', () => {
    const d = computeDashboard(EMPTY, 'AUD');
    expect(d.netWorthByCountryConverted).toEqual([]);
  });

  it('rows with no country_code are excluded, matching the existing byCountry() rollups\' own convention', () => {
    const d = computeDashboard({ ...EMPTY, assets: [{ current_value: 500, asset_class: 'cash' }] }, 'AUD');
    expect(d.netWorthByCountryConverted).toEqual([]);
  });
});
