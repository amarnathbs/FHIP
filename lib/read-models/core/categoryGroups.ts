/**
 * Canonical expense groups: the ONE vocabulary both sides of the Expense
 * model are compared in (DC-11 / EXP-G6).
 *
 * The planned side (expense_items, keyed by master_item_key from
 * supabase/seed_master_items.sql + later catalogue migrations) and the actual
 * side (approved fdh_transactions, categorised by the FDH-2 taxonomy seeded in
 * 0053 -- fdh_categories/fdh_subcategories and their fhip_mapping_key) never
 * shared a key format (R8_ASSUMPTION_RECONCILIATION.md:68). Both are mapped
 * here to the same coarse group so "planned Groceries $800" and "imported
 * Woolworths $200 (food.groceries)" land in the same row and are compared --
 * never added -- per PO D-02.
 *
 * Unmapped keys go to 'other' and are listed by the selector, never dropped.
 */

export const CANONICAL_EXPENSE_GROUPS = [
  'housing',
  'utilities',
  'food',
  'transport',
  'health',
  'education',
  'lifestyle',
  'shopping',
  'travel',
  'fees',
  'insurance',
  'tax',
  'family',
  'charity',
  'other',
] as const;
export type CanonicalExpenseGroup = (typeof CANONICAL_EXPENSE_GROUPS)[number];

export const EXPENSE_GROUP_LABELS: Record<CanonicalExpenseGroup, string> = {
  housing: 'Housing',
  utilities: 'Utilities',
  food: 'Food & dining',
  transport: 'Transport',
  health: 'Health',
  education: 'Education & childcare',
  lifestyle: 'Lifestyle & entertainment',
  shopping: 'Shopping',
  travel: 'Travel',
  fees: 'Bank fees & interest',
  insurance: 'Insurance',
  tax: 'Government & tax',
  family: 'Family & dependants',
  charity: 'Charity & giving',
  other: 'Other',
};

/** fdh_categories.category_key (0053) -> group. Non-spending categories
 * (income, transfers, loan principal, investments, cash, refunds, unknown) map
 * to 'other': they never reach spending through the bucket rules, and a
 * refund takes its ORIGINAL purchase's group. */
const FDH_CATEGORY_KEY_TO_GROUP: Record<string, CanonicalExpenseGroup> = {
  housing: 'housing',
  utilities: 'utilities',
  food: 'food',
  transport: 'transport',
  health: 'health',
  education: 'education',
  lifestyle: 'lifestyle',
  shopping: 'shopping',
  travel: 'travel',
  financial_fees: 'fees',
  loan_interest: 'fees',
  insurance: 'insurance',
  government_tax: 'tax',
  family: 'family',
  charity: 'charity',
};

/** expense_items.master_item_key -> group (every 'expense' catalogue key). */
const MASTER_ITEM_KEY_TO_GROUP: Record<string, CanonicalExpenseGroup> = {
  mortgage: 'housing',
  rent: 'housing',
  body_corporate: 'housing',
  council_rates: 'housing',
  water_rates: 'housing',
  property_maintenance: 'housing',
  land_tax: 'housing',
  home_insurance: 'insurance',
  contents_insurance: 'insurance',
  health_insurance: 'insurance',
  vehicle_insurance: 'insurance',
  life_insurance: 'insurance',
  income_protection: 'insurance',
  tpd_insurance: 'insurance',
  pet_insurance: 'insurance',
  electricity: 'utilities',
  gas: 'utilities',
  water: 'utilities',
  internet: 'utilities',
  mobile_phone: 'utilities',
  home_phone: 'utilities',
  security_monitoring: 'utilities',
  streaming_services: 'lifestyle',
  cloud_storage: 'lifestyle',
  subscriptions: 'lifestyle',
  gym: 'lifestyle',
  personal_trainer: 'lifestyle',
  sports: 'lifestyle',
  entertainment: 'lifestyle',
  hairdresser: 'lifestyle',
  beauty: 'lifestyle',
  laundry: 'lifestyle',
  pet_expenses: 'lifestyle',
  gifts: 'lifestyle',
  groceries: 'food',
  takeaway_food: 'food',
  restaurants: 'food',
  coffee: 'food',
  school_fees: 'education',
  childcare: 'education',
  books: 'education',
  uniforms: 'education',
  tutoring: 'education',
  education: 'education',
  medical: 'health',
  dental: 'health',
  optical: 'health',
  pharmacy: 'health',
  travel: 'travel',
  holiday_savings: 'travel',
  fuel: 'transport',
  public_transport: 'transport',
  parking: 'transport',
  tolls: 'transport',
  vehicle_registration: 'transport',
  vehicle_maintenance: 'transport',
  car_loan_repayments: 'transport',
  clothing: 'shopping',
  donations: 'charity',
  family_support_remittance: 'family',
  professional_membership: 'fees',
  accounting_fees: 'fees',
  legal_fees: 'fees',
  bank_fees: 'fees',
  credit_card_fees: 'fees',
  loan_interest: 'fees',
  tax_payments: 'tax',
  business_expenses: 'other',
  other_household_expenses: 'other',
  emergency_fund_saving: 'other',
  miscellaneous: 'other',
};

/** Legacy expense_items.expense_category (0003) -> group, for custom rows. */
const EXPENSE_CATEGORY_TO_GROUP: Record<string, CanonicalExpenseGroup> = {
  housing: 'housing',
  transport: 'transport',
  food: 'food',
  utilities: 'utilities',
  insurance: 'insurance',
};

export interface GroupResolution {
  group: CanonicalExpenseGroup;
  /** True when no mapping matched and the value fell back to 'other'. */
  unmapped: boolean;
}

/**
 * The group of an FDH-categorised line. Prefers the subcategory's mapping key
 * ('food.groceries' -> food), then the category's ('expense.food' -> food),
 * then the category key itself.
 */
export function groupForFdhCategory(input: {
  categoryKey?: string | null;
  categoryMappingKey?: string | null;
  subcategoryMappingKey?: string | null;
}): GroupResolution {
  const candidates: string[] = [];
  if (input.subcategoryMappingKey) candidates.push(input.subcategoryMappingKey.split('.')[0]);
  if (input.categoryMappingKey) {
    const [ns, key] = input.categoryMappingKey.split('.');
    candidates.push(ns === 'expense' || ns === 'debt' ? (key === 'interest' ? 'loan_interest' : key) : ns);
  }
  if (input.categoryKey) candidates.push(input.categoryKey);
  for (const c of candidates) {
    const g = FDH_CATEGORY_KEY_TO_GROUP[c];
    if (g) return { group: g, unmapped: false };
  }
  return { group: 'other', unmapped: true };
}

export function groupForExpenseItem(masterItemKey: string | null | undefined, expenseCategory?: string | null): GroupResolution {
  if (masterItemKey && MASTER_ITEM_KEY_TO_GROUP[masterItemKey]) return { group: MASTER_ITEM_KEY_TO_GROUP[masterItemKey], unmapped: false };
  if (expenseCategory && EXPENSE_CATEGORY_TO_GROUP[expenseCategory]) return { group: EXPENSE_CATEGORY_TO_GROUP[expenseCategory], unmapped: false };
  return { group: 'other', unmapped: true };
}

/**
 * Essential vs lifestyle for an imported line, from the taxonomy's
 * essential_discretionary: the subcategory's value wins over the category's.
 * 'essential' -> essential; 'discretionary', 'mixed', 'user_dependent',
 * 'not_applicable' or unknown -> lifestyle (the conservative choice: an
 * over-stated essentials figure would flatter emergency-fund months).
 */
export function isEssentialFdh(categoryEssential: string | null | undefined, subcategoryEssential: string | null | undefined): boolean {
  const v = subcategoryEssential ?? categoryEssential ?? null;
  return v === 'essential';
}

/** For tests / the registry doc: every master key the map knows. */
export const KNOWN_EXPENSE_MASTER_ITEM_KEYS: readonly string[] = Object.keys(MASTER_ITEM_KEY_TO_GROUP);
export const KNOWN_FDH_SPENDING_CATEGORY_KEYS: readonly string[] = Object.keys(FDH_CATEGORY_KEY_TO_GROUP);
