import { describe, it, expect } from 'vitest';
import { getAssetFieldMetadata } from '@/lib/grid/assetFieldMetadata';
import { assetGridConfig } from '@/lib/grid/configs';

// App Review spec §9 (Assets — Field Reassessment): Purchase Date/Price
// requested even where meaningless for cash-type accounts.
describe('Asset field metadata (App Review spec §9)', () => {
  it('cash-type accounts (Wallet Cash, Savings, Cheque, Offset, Foreign Currency) never support Purchase Price/Date', () => {
    for (const key of ['wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'foreign_currency']) {
      const meta = getAssetFieldMetadata(key);
      expect(meta.supportsPurchasePrice).toBe(false);
      expect(meta.supportsPurchaseDate).toBe(false);
    }
  });

  it('real estate (Principal Residence, Holiday Home, Vacant Land, Farm) supports Purchase Price/Date and liability linking', () => {
    for (const key of ['principal_residence', 'holiday_home', 'vacant_land', 'farm']) {
      const meta = getAssetFieldMetadata(key);
      expect(meta.supportsPurchasePrice).toBe(true);
      expect(meta.supportsPurchaseDate).toBe(true);
      expect(meta.supportsLiabilityLink).toBe(true);
    }
  });

  it('vehicles and collectibles support Purchase Price/Date but not liability linking', () => {
    for (const key of ['motor_vehicle', 'motorcycle', 'boat', 'caravan', 'collectables', 'jewellery', 'art', 'watches', 'wine_collection']) {
      const meta = getAssetFieldMetadata(key);
      expect(meta.supportsPurchasePrice).toBe(true);
      expect(meta.supportsPurchaseDate).toBe(true);
      expect(meta.supportsLiabilityLink).toBe(false);
    }
  });

  it('an unmapped/custom item (no master_item_key) defaults to fully permissive, never silently hiding a field', () => {
    const meta = getAssetFieldMetadata(null);
    expect(meta.supportsPurchasePrice).toBe(true);
    expect(meta.supportsPurchaseDate).toBe(true);
  });

  it('no field is ever required (purchase price/date stay optional even where supported — a user may not know the exact figure)', () => {
    for (const key of Object.keys({ principal_residence: 0, motor_vehicle: 0 })) {
      const meta = getAssetFieldMetadata(key);
      expect(meta.requiresPurchasePrice).toBe(false);
      expect(meta.requiresPurchaseDate).toBe(false);
    }
  });

  it('assetGridConfig.fieldVisibleForRow hides purchase_price/purchase_date for a Savings Account but shows them for Principal Residence', () => {
    expect(assetGridConfig.fieldVisibleForRow).toBeDefined();
    const visible = assetGridConfig.fieldVisibleForRow!;
    expect(visible('purchase_price', 'savings_account')).toBe(false);
    expect(visible('purchase_date', 'savings_account')).toBe(false);
    expect(visible('purchase_price', 'principal_residence')).toBe(true);
    expect(visible('purchase_date', 'principal_residence')).toBe(true);
    // Unrelated fields (current_value, country_code, notes) are never hidden by this rule.
    expect(visible('current_value', 'savings_account')).toBe(true);
    expect(visible('country_code', 'savings_account')).toBe(true);
  });
});
