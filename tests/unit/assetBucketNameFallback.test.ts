import { describe, expect, it } from 'vitest';
import { bucketAssetClass, computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';

/**
 * PO production report (16-10-2026): an asset named 'House ' (trailing space) with a null master item key
 * was grouped as 'other' instead of property. The grid never collects asset_class, so a custom row keeps
 * the default 'other' and the name is the only signal. The fallback is deliberately narrow: whole-name
 * match after trimming/normalising, property words only, and it never overrides a real master item key or
 * an explicit asset_class.
 */
describe('bucketAssetClass: custom-named property rows', () => {
  it("'House ' with a trailing space and no master key is property", () => {
    expect(bucketAssetClass('other', null, 'House ')).toBe('property');
  });
  it.each(['house', ' HOUSE', 'My House', 'Family  Home', 'principal residence', 'Apartment', 'Unit', 'vacant land', 'Investment Property'])(
    '%j is property',
    (name) => {
      expect(bucketAssetClass('other', null, name)).toBe('property');
    },
  );
  it('does not guess from a name that merely contains a property word', () => {
    expect(bucketAssetClass('other', null, 'House insurance refund')).toBe('other');
    expect(bucketAssetClass('other', null, 'Housing deposit')).toBe('other');
    expect(bucketAssetClass('other', null, '')).toBe('other');
    expect(bucketAssetClass('other', null, null)).toBe('other');
  });
  it('a real master item key or an explicit asset_class wins over the name', () => {
    expect(bucketAssetClass('other', 'savings_account', 'House')).toBe('cash');
    expect(bucketAssetClass('cash', null, 'House')).toBe('cash');
    expect(bucketAssetClass('property', null, 'Whatever')).toBe('property');
  });
  it('a master item key with stray whitespace or capitals still resolves', () => {
    expect(bucketAssetClass('other', 'Principal_Residence ', null)).toBe('property');
  });
  it('callers that do not pass a name behave exactly as before', () => {
    expect(bucketAssetClass('other', null)).toBe('other');
    expect(bucketAssetClass('property', null)).toBe('property');
  });
});

describe('computeDashboard: the House row is grouped as property in the allocation', () => {
  it('moves the 1,000,000 from other to property and leaves every total unchanged', () => {
    const base: DashboardInput = {
      income: [], expenses: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [],
      assets: [{ current_value: 1_000_000, asset_class: 'other', master_item_key: null, asset_name: 'House ', currency_code: 'AUD' }],
    };
    const s = computeDashboard(base, 'AUD');
    expect(s.netWorthAllocation).toEqual([{ bucket: 'property', value: 1_000_000 }]);
    expect(s.netWorth).toBe(1_000_000);
    expect(s.totalAssets).toBe(1_000_000);
  });
});
