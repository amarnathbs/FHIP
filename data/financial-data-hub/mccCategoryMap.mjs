// FDH-2 — MCC to category/subcategory mapping. Deliberately NOT over-mapped:
// where one MCC commonly covers materially different household categories,
// `category_key`/`subcategory_key` are left null and `ambiguity_flag: true`
// (mapping_type: 'ambiguous_unmapped'), or mapped only to a broad top-level
// category (mapping_type: 'broad_group_only'). A future classification
// engine (FDH-6) combines MCC + merchant + description + user rules to
// resolve these — FDH-2 must never force a false precision.
//
// `country_code: null` means the mapping applies globally (AU and IN alike).
function map(mcc_code, opts) {
  return {
    mcc: mcc_code,
    country_code: opts.country_code ?? null,
    category_key: opts.category_key ?? null,
    subcategory_key: opts.subcategory_key ?? null,
    mapping_confidence: opts.mapping_confidence,
    mapping_type: opts.mapping_type,
    ambiguity_flag: opts.ambiguity_flag ?? false,
    requires_additional_context: opts.requires_additional_context ?? false,
    notes: opts.notes ?? null,
  };
}

export const mccCategoryMap = [
  // Grocery / supermarket — high confidence, direct
  map('5411', { category_key: 'food', subcategory_key: 'groceries', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5422', { category_key: 'food', subcategory_key: 'groceries', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5441', { category_key: 'food', subcategory_key: 'groceries', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5451', { category_key: 'food', subcategory_key: 'groceries', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5462', { category_key: 'food', subcategory_key: 'other_food', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5499', { category_key: 'food', subcategory_key: 'groceries', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Food & beverage
  map('5812', { category_key: 'food', subcategory_key: 'restaurants', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5813', { category_key: 'food', subcategory_key: 'alcohol_liquor', mapping_confidence: 'medium', mapping_type: 'direct', notes: 'A bar/tavern charge is usually alcohol/hospitality spend; could occasionally be entertainment. Kept as a direct-but-medium-confidence mapping.' }),
  map('5814', { category_key: 'food', subcategory_key: 'takeaway_food_delivery', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5921', { category_key: 'food', subcategory_key: 'alcohol_liquor', mapping_confidence: 'high', mapping_type: 'direct' }),

  // Fuel / automotive
  map('5541', { category_key: 'transport', subcategory_key: 'fuel', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5542', { category_key: 'transport', subcategory_key: 'fuel', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5511', { category_key: 'transport', subcategory_key: 'vehicle_purchase_lease', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5531', { category_key: 'transport', mapping_confidence: 'low', mapping_type: 'broad_group_only', ambiguity_flag: true, requires_additional_context: true, notes: 'CLOSURE-RESEARCH DOWNGRADED 2026-08-22 (live web search): the verified official description ("Auto and Home Supply Stores") and its standard trade classification explicitly note these establishments "frequently sell a substantial amount of home appliances, radios, and television sets" alongside automotive parts — a genuinely mixed-purpose store type, not a reliable direct signal for vehicle_maintenance_registration alone. Downgraded from direct/medium to broad_group_only/low with subcategory removed, per the "never force false precision" principle.' }),
  map('7538', { category_key: 'transport', subcategory_key: 'vehicle_maintenance_registration', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('7523', { category_key: 'transport', subcategory_key: 'parking_tolls', mapping_confidence: 'high', mapping_type: 'direct' }),

  // Utilities / telecom — 4900 deliberately AMBIGUOUS (electricity vs gas vs water)
  map('4900', { category_key: 'utilities', mapping_confidence: 'context_required', mapping_type: 'broad_group_only', ambiguity_flag: true, requires_additional_context: true, notes: 'Covers electricity, gas, water and sanitary services alike. Merchant identity (e.g. the specific retailer name) is required to resolve the subcategory — MCC alone cannot.' }),
  map('4814', { category_key: 'utilities', subcategory_key: 'mobile_phone', mapping_confidence: 'medium', mapping_type: 'direct', requires_additional_context: true, notes: 'Also covers landline/home-phone telecom; merchant identity refines which.' }),
  map('4816', { category_key: 'utilities', subcategory_key: 'internet_broadband', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4899', { category_key: 'utilities', mapping_confidence: 'context_required', mapping_type: 'broad_group_only', ambiguity_flag: true, requires_additional_context: true, notes: 'Pay-TV bundle (utility) vs. a discretionary streaming subscription cannot be told apart by MCC alone — merchant identity resolves this.' }),

  // Transport / travel
  map('4111', { category_key: 'transport', subcategory_key: 'public_transport', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4121', { category_key: 'transport', subcategory_key: 'rideshare_taxi', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4131', { category_key: 'transport', subcategory_key: 'public_transport', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4784', { category_key: 'transport', subcategory_key: 'parking_tolls', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4511', { category_key: 'travel', subcategory_key: 'flights', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('4722', { category_key: 'travel', subcategory_key: 'travel_packages_tours', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('7011', { category_key: 'travel', subcategory_key: 'accommodation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('7512', { category_key: 'travel', subcategory_key: 'other_travel', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Health / medical
  map('5912', { category_key: 'health', subcategory_key: 'pharmacy', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8011', { category_key: 'health', subcategory_key: 'doctor_specialist', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8021', { category_key: 'health', subcategory_key: 'dental', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8031', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8041', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8042', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8043', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8049', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8050', { category_key: 'health', mapping_confidence: 'low', mapping_type: 'broad_group_only', notes: 'Nursing/aged-care facility charges may be recurring accommodation-style costs rather than an ordinary out-of-pocket health cost.' }),
  map('8062', { category_key: 'health', subcategory_key: 'doctor_specialist', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8099', { category_key: 'health', subcategory_key: 'allied_health', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Education
  map('8211', { category_key: 'education', subcategory_key: 'school_fees', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8220', { category_key: 'education', subcategory_key: 'tuition_university', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8241', { category_key: 'education', subcategory_key: 'tuition_university', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8244', { category_key: 'education', subcategory_key: 'tuition_university', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('8299', { category_key: 'education', subcategory_key: 'tutoring', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true }),
  map('8351', { category_key: 'education', subcategory_key: 'childcare_daycare', mapping_confidence: 'high', mapping_type: 'direct' }),

  // Financial services — mostly rail/mechanism, not a category
  map('6011', { category_key: 'cash_withdrawal', subcategory_key: 'atm_cash_withdrawal', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('6010', { category_key: 'cash_withdrawal', subcategory_key: 'branch_cash_withdrawal', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('6012', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true, notes: 'A generic "financial institution service" MCC — could be a fee, an own-account transfer, a credit-card payment or an investment funding movement. MCC alone cannot resolve it.' }),
  map('6051', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true }),
  map('6211', { category_key: 'investment_purchase', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true, notes: 'A broker/securities-dealer charge is commonly an investment FUNDING candidate, but could also be a brokerage fee. Left at broad-group confidence.' }),
  map('6300', { category_key: 'insurance', mapping_confidence: 'context_required', mapping_type: 'broad_group_only', ambiguity_flag: true, requires_additional_context: true, notes: 'Covers health/life/home/vehicle insurance alike; merchant identity resolves the specific type.' }),
  map('6540', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true }),

  // Government services
  map('9311', { category_key: 'government_tax', subcategory_key: 'income_tax_payment', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('9399', { category_key: 'government_tax', subcategory_key: 'other_government_tax', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true }),
  map('9222', { category_key: 'government_tax', subcategory_key: 'fines_penalties', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('9402', { category_key: 'government_tax', subcategory_key: 'other_government_tax', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Retail / merchandise
  map('5300', { category_key: 'shopping', subcategory_key: 'department_discount_retail', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5311', { category_key: 'shopping', subcategory_key: 'department_discount_retail', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5310', { category_key: 'shopping', subcategory_key: 'department_discount_retail', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5399', { category_key: 'shopping', mapping_confidence: 'context_required', mapping_type: 'broad_group_only', ambiguity_flag: true, requires_additional_context: true, notes: 'General merchandise / marketplace covers essentially every shopping subcategory; MCC alone cannot resolve it.' }),
  map('5651', { category_key: 'shopping', subcategory_key: 'clothing_footwear', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5621', { category_key: 'shopping', subcategory_key: 'clothing_footwear', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5611', { category_key: 'shopping', subcategory_key: 'clothing_footwear', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5661', { category_key: 'shopping', subcategory_key: 'clothing_footwear', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5732', { category_key: 'shopping', subcategory_key: 'electronics_appliances', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5722', { category_key: 'shopping', subcategory_key: 'electronics_appliances', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5712', { category_key: 'shopping', subcategory_key: 'home_furniture_homeware', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5211', { category_key: 'housing', subcategory_key: 'home_maintenance_repairs', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5945', { category_key: 'lifestyle', subcategory_key: 'hobbies_recreation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5942', { category_key: 'shopping', subcategory_key: 'other_shopping', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5943', { category_key: 'shopping', subcategory_key: 'other_shopping', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5964', { category_key: 'shopping', subcategory_key: 'online_marketplace_general', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true }),
  map('5992', { category_key: 'lifestyle', subcategory_key: 'gifts_general', mapping_confidence: 'medium', mapping_type: 'direct' }),
  map('5977', { category_key: 'lifestyle', subcategory_key: 'personal_care', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Entertainment / recreation
  map('7832', { category_key: 'lifestyle', subcategory_key: 'hobbies_recreation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('7996', { category_key: 'lifestyle', subcategory_key: 'hobbies_recreation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('7997', { category_key: 'lifestyle', subcategory_key: 'gym_fitness', mapping_confidence: 'medium', mapping_type: 'direct', requires_additional_context: true, notes: 'Also covers non-fitness membership clubs.' }),
  map('7998', { category_key: 'lifestyle', subcategory_key: 'hobbies_recreation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('5735', { category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mapping_confidence: 'medium', mapping_type: 'direct' }),

  // Professional / business services
  map('8931', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true, notes: 'Personal vs. business accounting/bookkeeping cannot be told apart by MCC.' }),
  map('8111', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true }),
  map('7372', { category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true, notes: 'Software/SaaS spans personal subscriptions and business tools; broad-group only.' }),
  map('8398', { category_key: 'charity', subcategory_key: 'charitable_donation', mapping_confidence: 'high', mapping_type: 'direct' }),
  map('8641', { category_key: 'lifestyle', subcategory_key: 'other_lifestyle', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true }),
  map('7299', { category_key: 'lifestyle', subcategory_key: 'other_lifestyle', mapping_confidence: 'low', mapping_type: 'broad_group_only', requires_additional_context: true }),

  // Wholesale / business — deliberately unmapped (business-context dependent)
  map('5199', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true }),
  map('5085', { category_key: null, mapping_confidence: 'context_required', mapping_type: 'ambiguous_unmapped', ambiguity_flag: true, requires_additional_context: true }),
];
