import { convertToReportingCurrency, type SupportedCurrency } from './fx';

// LR-11 (Company / Family Trust Entity Architecture) — WP-05's consolidation
// rule as a pure, isolated function. This is the ONLY code path by which a
// business entity's value ever reaches personal household Net Worth
// (lib/engines/dashboard.ts imports and calls this, never re-derives the
// arithmetic itself) — keeping the entity-specific computation isolated
// here, with a single already-netted number crossing into dashboard.ts,
// is what makes AC-09's "one expression never mixes incompatible entity
// populations" a structural property rather than a convention.

export interface BusinessEntityRow {
  id: string;
  ownership_percentage: number;
  valuation_mode: 'summary' | 'detailed';
  summary_net_asset_value: number | null;
  currency_code: string;
  is_active: boolean;
}

export interface BusinessEntityLineItemRow {
  value: number;
  currency_code: string;
}

export interface BusinessEntityWithLineItems {
  entity: BusinessEntityRow;
  assets: BusinessEntityLineItemRow[];
  liabilities: BusinessEntityLineItemRow[];
}

function toSupportedCurrency(code: string | null | undefined): SupportedCurrency | null {
  return code === 'AUD' || code === 'INR' ? code : null;
}

function convert(amount: number, currencyCode: string | null | undefined, reportingCurrency: SupportedCurrency, fxRateAudInr: number): number {
  const currency = toSupportedCurrency(currencyCode);
  if (!currency) return amount;
  return convertToReportingCurrency(amount, currency, reportingCurrency, fxRateAudInr);
}

/**
 * Net entity value (assets minus liabilities) in the household's reporting
 * currency. Summary mode returns the entity's own directly-entered net
 * figure (migration 0134: summary_net_asset_value is already net, matching
 * smsf_funds.summary_balance's semantics); Detailed mode nets the entity's
 * own line items. Never both — valuation_mode is exclusive, mirroring SMSF's
 * summary-XOR-detailed discipline (migration 0084) without needing that
 * migration's $0-variance mode-switch gate (this entity has no other writer
 * to race against — see migration 0134's own header).
 */
export function computeBusinessEntityNetAssetValue(
  row: BusinessEntityWithLineItems,
  reportingCurrency: SupportedCurrency,
  fxRateAudInr: number
): number {
  if (row.entity.valuation_mode === 'summary') {
    return convert(row.entity.summary_net_asset_value ?? 0, row.entity.currency_code, reportingCurrency, fxRateAudInr);
  }
  const totalAssets = row.assets.reduce((sum, a) => sum + convert(a.value, a.currency_code, reportingCurrency, fxRateAudInr), 0);
  const totalLiabilities = row.liabilities.reduce((sum, l) => sum + convert(l.value, l.currency_code, reportingCurrency, fxRateAudInr), 0);
  return totalAssets - totalLiabilities;
}

/**
 * WP-05's consolidation rule (Product Owner decision, LR-11): the ONLY
 * figure that ever reaches personal household Net Worth for a business
 * entity is (ownership_percentage / 100) * that entity's own net asset
 * value — never the entity's gross assets, and never the full net value
 * regardless of actual ownership share. Summing this across entities (rather
 * than summing NAVs first and applying one blended percentage) is
 * deliberate: each entity keeps its own percentage, so a household with a
 * 100%-owned company and a 20%-owned company never has one entity's
 * ownership share silently applied to the other's value.
 */
export function computeBusinessEntityOwnershipValue(
  rows: BusinessEntityWithLineItems[],
  reportingCurrency: SupportedCurrency,
  fxRateAudInr: number
): number {
  return rows
    .filter((r) => r.entity.is_active)
    .reduce((sum, r) => sum + (r.entity.ownership_percentage / 100) * computeBusinessEntityNetAssetValue(r, reportingCurrency, fxRateAudInr), 0);
}
