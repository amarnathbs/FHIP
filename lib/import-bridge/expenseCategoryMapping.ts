/**
 * WP-15 -- the missing input mapping: FDH-2 taxonomy `fhip_mapping_key`
 * (seeded by migration 0053, e.g. 'food.groceries') -> the Expenses register's
 * `expense_items.master_item_key` (supabase/seed_master_items.sql, e.g.
 * 'groceries').
 *
 * FDH2_CATEGORY_TAXONOMY.md said "wiring into expense_items is FDH-15's job";
 * it was never built (R8_ASSUMPTION_RECONCILIATION.md: the two vocabularies
 * share no key format). This table is that wiring, and it is used for ONE
 * thing only: the "Update your planned expenses from your actual spending"
 * proposal. Nothing is ever copied transaction-by-transaction; a proposal
 * carries one monthly average per planned item, and the user applies it.
 *
 * THE INVARIANT THAT PREVENTS A DOUBLE COUNT. The canonical Expense read model
 * (lib/read-models/expenses.ts) compares planned and actual per canonical
 * GROUP and never adds them (PO D-02). If 'Other Housing' spending (group
 * housing) were proposed into a planned item of group 'other', the combined
 * basis would count it twice: once as housing actual, once as 'other'
 * planned. So every entry below maps to a master key in the SAME canonical
 * group as its taxonomy key -- the unit test checks this for every row.
 *
 * A taxonomy key with no same-group planned item, or with more than one
 * plausible item (e.g. 'Parking & Tolls' covers two planned items), maps to
 * null. Its average is still shown to the user, under "Not matched to a
 * planned item", never silently dropped and never guessed.
 *
 * Client-safe: pure data, no imports beyond the (client-safe) group table.
 */
import { groupForExpenseItem, groupForFdhCategory, type CanonicalExpenseGroup } from '@/lib/read-models/core/categoryGroups';

/** Subcategory mapping key -> expense_items.master_item_key (or null = not matched, shown). */
export const FDH_MAPPING_KEY_TO_EXPENSE_ITEM: Readonly<Record<string, string | null>> = {
  // housing
  'housing.rent': 'rent',
  'housing.council_rates_property_tax': 'council_rates',
  'housing.body_corporate_strata_maintenance': 'body_corporate',
  'housing.home_maintenance_repairs': 'property_maintenance',
  'housing.other_housing': null,
  // utilities
  'utilities.electricity': 'electricity',
  'utilities.gas': 'gas',
  'utilities.water': 'water',
  'utilities.internet_broadband': 'internet',
  'utilities.mobile_phone': 'mobile_phone',
  'utilities.home_phone_landline': 'home_phone',
  // Council rates is a HOUSING planned item; waste services are utilities.
  'utilities.waste_council_services': null,
  'utilities.other_utilities': null,
  // food
  'food.groceries': 'groceries',
  'food.restaurants': 'restaurants',
  'food.cafes_coffee': 'coffee',
  'food.takeaway_food_delivery': 'takeaway_food',
  'food.alcohol_liquor': null,
  'food.other_food': null,
  // transport
  'transport.fuel': 'fuel',
  'transport.public_transport': 'public_transport',
  'transport.rideshare_taxi': null,
  // Two planned items (parking, tolls): never guess the split.
  'transport.parking_tolls': null,
  // Two planned items (vehicle_maintenance, vehicle_registration).
  'transport.vehicle_maintenance_registration': null,
  // A lease/finance payment is debt service, not a planned living cost.
  'transport.vehicle_purchase_lease': null,
  'transport.other_transport': null,
  // health
  'health.pharmacy': 'pharmacy',
  'health.doctor_specialist': 'medical',
  'health.dental': 'dental',
  'health.health_insurance_gap_excess': 'medical',
  'health.allied_health': 'medical',
  'health.other_health': null,
  // education
  'education.school_fees': 'school_fees',
  'education.tuition_university': 'education',
  'education.childcare_daycare': 'childcare',
  'education.textbooks_supplies': 'books',
  'education.tutoring': 'tutoring',
  'education.other_education': null,
  // lifestyle
  // Spans three planned items (entertainment, streaming_services, subscriptions).
  'lifestyle.entertainment_streaming_subscriptions': null,
  'lifestyle.gym_fitness': 'gym',
  'lifestyle.hobbies_recreation': null,
  // Spans hairdresser + beauty.
  'lifestyle.personal_care': null,
  'lifestyle.gifts_general': 'gifts',
  'lifestyle.other_lifestyle': null,
  // shopping
  'shopping.clothing_footwear': 'clothing',
  'shopping.electronics_appliances': null,
  'shopping.home_furniture_homeware': null,
  'shopping.online_marketplace_general': null,
  'shopping.department_discount_retail': null,
  'shopping.other_shopping': null,
  // travel
  'travel.flights': 'travel',
  'travel.accommodation': 'travel',
  'travel.travel_packages_tours': 'travel',
  'travel.travel_insurance': 'travel',
  'travel.other_travel': 'travel',
  // bank & financial fees (fees on a card/loan facility are cost of debt and
  // never reach spending lines at all -- see core/spendingRules)
  'financial_fees.bank_account_fee': 'bank_fees',
  'financial_fees.card_annual_fee': 'credit_card_fees',
  'financial_fees.foreign_transaction_fee': 'bank_fees',
  'financial_fees.late_payment_fee': 'bank_fees',
  'financial_fees.overdraft_fee': 'bank_fees',
  'financial_fees.atm_fee': 'bank_fees',
  'financial_fees.other_fee': null,
  // insurance
  'insurance.health_insurance_premium': 'health_insurance',
  'insurance.life_insurance_premium': 'life_insurance',
  // Spans home_insurance + contents_insurance.
  'insurance.home_contents_insurance_premium': null,
  'insurance.vehicle_insurance_premium': 'vehicle_insurance',
  'insurance.income_protection_insurance_premium': 'income_protection',
  'insurance.other_insurance': null,
  // government & tax
  'government_tax.income_tax_payment': 'tax_payments',
  'government_tax.gst_bas_payment': 'tax_payments',
  'government_tax.fines_penalties': null,
  'government_tax.other_government_tax': null,
  // family
  'family.child_support': null,
  'family.family_allowance_pocket_money': null,
  'family.dependant_care': null,
  'family.other_family': null,
  // charity
  'charity.charitable_donation': 'donations',
  'charity.religious_giving': 'donations',
  'charity.other_charity': 'donations',
};

export type UnmatchedReason = 'no_single_planned_item' | 'category_only' | 'unknown_key';

export type ExpenseItemMatch = { masterItemKey: string } | { masterItemKey: null; reason: UnmatchedReason };

/**
 * The planned item a spending line's taxonomy key feeds. A category-level key
 * ('expense.food', no subcategory) is too coarse to pick one planned item.
 * The line's canonical GROUP is not decided here: it is the read model's
 * (ActualLine.group), so both sides always agree.
 */
export function expenseItemForMappingKey(mappingKey: string | null | undefined): ExpenseItemMatch {
  if (!mappingKey) return { masterItemKey: null, reason: 'unknown_key' };
  const ns = mappingKey.split('.')[0];
  if (ns === 'expense' || ns === 'debt') return { masterItemKey: null, reason: 'category_only' };
  if (!Object.prototype.hasOwnProperty.call(FDH_MAPPING_KEY_TO_EXPENSE_ITEM, mappingKey)) return { masterItemKey: null, reason: 'unknown_key' };
  const masterItemKey = FDH_MAPPING_KEY_TO_EXPENSE_ITEM[mappingKey];
  return masterItemKey ? { masterItemKey } : { masterItemKey: null, reason: 'no_single_planned_item' };
}

export const UNMATCHED_REASON_LABELS: Record<UnmatchedReason, string> = {
  no_single_planned_item: 'No single planned item matches this category',
  category_only: 'Categorised only at the top level — pick a subcategory in review to match it',
  unknown_key: 'Category not recognised',
};

/** For tests: the group each side of every mapped row lands in. */
export function mappingGroupPairs(): { mappingKey: string; masterItemKey: string; fdhGroup: CanonicalExpenseGroup; plannedGroup: CanonicalExpenseGroup }[] {
  return Object.entries(FDH_MAPPING_KEY_TO_EXPENSE_ITEM)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([mappingKey, masterItemKey]) => ({
      mappingKey,
      masterItemKey,
      fdhGroup: groupForFdhCategory({ subcategoryMappingKey: mappingKey }).group,
      plannedGroup: groupForExpenseItem(masterItemKey).group,
    }));
}
