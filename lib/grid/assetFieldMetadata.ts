// App Review spec §9 (Assets — Field Reassessment).
//
// Old calculation → defect → corrected rule → expected new result:
//   Old: assetGridConfig's fields list (purchase_price, purchase_date) was
//   static — the grid rendered the same input for every asset row
//   regardless of type, so a Savings Account, Cheque Account, Offset
//   Account or plain Wallet Cash row asked for a "Purchase Date", which is
//   meaningless for those account types (they don't have a single
//   acquisition date/price the way a property or vehicle does).
//   Defect: field requirements were attached to the grid config as a whole,
//   not to the asset TYPE, so there was no way to vary them per row.
//   Corrected rule: field metadata keyed by master_item_key (the field the
//   grid actually collects reliably — same reasoning as dashboard.ts's
//   MASTER_ASSET_ITEM_TO_BUCKET) drives per-row field visibility in
//   FinancialDataGrid via GridConfig.fieldVisibleForRow. Purchase
//   price/date are shown only for types where they're meaningful (real
//   estate, vehicles, collectibles/cost-basis items); cash-type accounts
//   never see them.
//   Backward compatible: hiding a field for a row never deletes or nulls
//   any value already saved on it (saveRow omits hidden fields from the
//   PATCH/POST body entirely, rather than sending null) — a historical
//   purchase_date on an old cash-type row, if one somehow exists, is left
//   untouched, just no longer re-collected going forward.
//
// Catalogue reference: supabase/seed_master_items.sql's 'asset' category,
// post A/I/R-consolidation (migrations 0072-0074) — investment-type
// holdings (shares, property funds, super, etc.) were already moved out of
// 'asset' entirely, so every remaining asset item_key is a genuine
// physical/cash asset type.
export interface AssetFieldMetadata {
  supportsPurchasePrice: boolean;
  requiresPurchasePrice: boolean;
  supportsPurchaseDate: boolean;
  requiresPurchaseDate: boolean;
  requiresCountry: boolean;
  requiresCurrency: boolean;
  supportsIncome: boolean; // this app's Assets register has no income field at all — reserved for a future field, always false today
  supportsLiabilityLink: boolean; // mortgage/loan-secured asset types (assets.linked_liability_id, migration 0072)
}

const CASH_TYPE: AssetFieldMetadata = {
  supportsPurchasePrice: false,
  requiresPurchasePrice: false,
  supportsPurchaseDate: false,
  requiresPurchaseDate: false,
  requiresCountry: true,
  requiresCurrency: true,
  supportsIncome: false,
  supportsLiabilityLink: false,
};

const REAL_ESTATE: AssetFieldMetadata = {
  supportsPurchasePrice: true,
  requiresPurchasePrice: false, // encouraged, not mandatory — a user may not remember/know the exact figure
  supportsPurchaseDate: true,
  requiresPurchaseDate: false,
  requiresCountry: true,
  requiresCurrency: true,
  supportsIncome: false,
  supportsLiabilityLink: true,
};

const VEHICLE_OR_COLLECTIBLE: AssetFieldMetadata = {
  supportsPurchasePrice: true,
  requiresPurchasePrice: false,
  supportsPurchaseDate: true,
  requiresPurchaseDate: false,
  requiresCountry: true,
  requiresCurrency: true,
  supportsIncome: false,
  supportsLiabilityLink: false,
};

// Ambiguous/misc types (loans_receivable, trust_assets, other_assets) — a
// "purchase" concept doesn't cleanly apply, but it's not clearly wrong
// either (e.g. a trust asset could have an origination date), so these stay
// supported-but-optional rather than hidden outright.
const MISC: AssetFieldMetadata = {
  supportsPurchasePrice: true,
  requiresPurchasePrice: false,
  supportsPurchaseDate: true,
  requiresPurchaseDate: false,
  requiresCountry: true,
  requiresCurrency: true,
  supportsIncome: false,
  supportsLiabilityLink: false,
};

export const ASSET_FIELD_METADATA: Record<string, AssetFieldMetadata> = {
  wallet_cash: CASH_TYPE,
  savings_account: CASH_TYPE,
  cheque_account: CASH_TYPE,
  offset_account: CASH_TYPE,
  foreign_currency: CASH_TYPE,
  principal_residence: REAL_ESTATE,
  holiday_home: REAL_ESTATE,
  vacant_land: REAL_ESTATE,
  farm: REAL_ESTATE,
  motor_vehicle: VEHICLE_OR_COLLECTIBLE,
  motorcycle: VEHICLE_OR_COLLECTIBLE,
  boat: VEHICLE_OR_COLLECTIBLE,
  caravan: VEHICLE_OR_COLLECTIBLE,
  collectables: VEHICLE_OR_COLLECTIBLE,
  jewellery: VEHICLE_OR_COLLECTIBLE,
  art: VEHICLE_OR_COLLECTIBLE,
  watches: VEHICLE_OR_COLLECTIBLE,
  wine_collection: VEHICLE_OR_COLLECTIBLE,
  intellectual_property: VEHICLE_OR_COLLECTIBLE,
  loans_receivable: MISC,
  trust_assets: MISC,
  other_assets: MISC,
};

// Custom rows (no master_item_key) and any future/unmapped catalogue item
// default to fully permissive — never hides a field the user hasn't been
// told is inapplicable, matching "maintain backward compatibility".
const DEFAULT_METADATA: AssetFieldMetadata = MISC;

export function getAssetFieldMetadata(masterItemKey: string | null | undefined): AssetFieldMetadata {
  if (!masterItemKey) return DEFAULT_METADATA;
  return ASSET_FIELD_METADATA[masterItemKey] ?? DEFAULT_METADATA;
}
