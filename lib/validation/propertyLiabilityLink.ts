import { z } from 'zod';

// Canonical stable link-type codes (spec s.7) -- never a display string.
export const LINK_TYPE_VALUES = [
  'owner_occupied_mortgage',
  'investment_property_loan',
  'commercial_property_loan',
  'smsf_property_loan',
  'property_secured_other',
  'cross_collateralised',
] as const;
export type LinkType = (typeof LINK_TYPE_VALUES)[number];

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  owner_occupied_mortgage: 'Owner-Occupied Mortgage',
  investment_property_loan: 'Investment Property Loan',
  commercial_property_loan: 'Commercial Property Loan',
  smsf_property_loan: 'SMSF Property Loan / LRBA',
  property_secured_other: 'Other Property-Secured Debt',
  cross_collateralised: 'Cross-Collateralised Loan',
};

// One property side per link, exactly one of the three ids set -- enforced
// again server-side (in addition to the DB CHECK constraint) so a bad
// request gets a clean 422 instead of a raw Postgres error.
export const propertyLiabilityLinkSchema = z
  .object({
    linked_asset_id: z.string().uuid().optional(),
    linked_investment_id: z.string().uuid().optional(),
    linked_retirement_id: z.string().uuid().optional(),
    liability_id: z.string().uuid(),
    link_type: z.enum(LINK_TYPE_VALUES),
    allocation_percent: z.number().gt(0).max(100).default(100),
    allocation_amount: z.number().min(0).optional(),
    is_primary: z.boolean().default(true),
    notes: z.string().optional(),
  })
  .refine(
    (v) =>
      [v.linked_asset_id, v.linked_investment_id, v.linked_retirement_id].filter((x) => x !== undefined).length === 1,
    { message: 'Exactly one of linked_asset_id, linked_investment_id, or linked_retirement_id must be set.' }
  );

export type PropertyLiabilityLinkInput = z.infer<typeof propertyLiabilityLinkSchema>;

// Catalogue master_item_keys that must NEVER be linked as property finance,
// no matter what link_type the client requests (spec s.27-31: "Consumer
// debt ... must never gain investment-debt treatment merely because a user
// accidentally links them"). Mirrors the DB trigger in migration 0078
// (pll_validate_liability_eligibility) as a fast-fail application-layer
// check -- the DB trigger remains the authoritative backstop.
export const CONSUMER_DEBT_MASTER_ITEMS = new Set([
  'credit_card',
  'store_card',
  'car_loan',
  'motorcycle_loan',
  'boat_loan',
  'education_loan',
  'hecs_help',
  'tax_debt',
  'ato_payment_plan',
  'family_loan',
  'private_loan',
  'buy_now_pay_later',
  'medical_loan',
  'guarantees',
  'margin_loan',
]);

// Property-plausible master_item_keys the linking UI offers by default (spec
// s.13-14). Custom rows (master_item_key null) are always eligible on both
// sides -- this allowlist only filters which *catalogue* rows are offered,
// it never hard-blocks a legitimate exception (spec s.14: "without hard-
// blocking legitimate exceptions").
export const PROPERTY_ASSET_MASTER_ITEMS = new Set([
  'principal_residence',
  'holiday_home',
  'vacant_land',
  'farm',
  'other_assets',
]);
export const PROPERTY_INVESTMENT_MASTER_ITEMS = new Set(['property', 'commercial_property', 'other_investments']);

// Suggested default link_type per property catalogue item -- the UI
// pre-selects this but the user may always override it to any valid code.
export const DEFAULT_LINK_TYPE_BY_PROPERTY_ITEM: Record<string, LinkType> = {
  principal_residence: 'owner_occupied_mortgage',
  holiday_home: 'property_secured_other',
  vacant_land: 'property_secured_other',
  farm: 'property_secured_other',
  property: 'investment_property_loan',
  commercial_property: 'commercial_property_loan',
};

// Whether the Property-side "Financing" control should be offered for this
// row at all (spec s.14: offered without hard-blocking legitimate
// exceptions -- custom rows are always eligible since that's the only way
// a non-catalogued property gets entered today).
export function isPropertyEligibleForLinking(kind: 'asset' | 'investment', masterItemKey: string | null): boolean {
  if (!masterItemKey) return true; // custom row
  return kind === 'asset' ? PROPERTY_ASSET_MASTER_ITEMS.has(masterItemKey) : PROPERTY_INVESTMENT_MASTER_ITEMS.has(masterItemKey);
}

// Whether the Liability-side "Related Property" control should be offered
// for this row (mirrors the consumer-debt denylist -- consumer debt is
// never offered a property-linking control at all, not just blocked
// server-side).
export function isLiabilityEligibleForLinking(masterItemKey: string | null): boolean {
  if (!masterItemKey) return true; // custom row
  return !CONSUMER_DEBT_MASTER_ITEMS.has(masterItemKey);
}
