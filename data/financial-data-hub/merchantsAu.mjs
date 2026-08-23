// FDH-2 — Australian merchant master. Quantity is NOT the goal (specification
// section 29-37): every row here is a real, publicly identifiable brand, not
// a guess inflated to raise the count. `canonical_name` is the merchant's
// STABLE MACHINE KEY (FDH-1's own documented convention — see
// 0045_fdh_reference_foundation.sql's column comment) — never rename it to
// "fix" a display label; change `display_name` instead.
//
// mcc/mcc_confidence are populated ONLY where the mapping is genuinely
// verifiable; otherwise both are left null rather than guessed
// (specification section 9-11).
const S = 'au_public_merchant_information';

function m(canonical_name, display_name, opts) {
  return {
    canonical_name,
    display_name,
    country_code: 'AU',
    merchant_type: opts.merchant_type,
    category_key: opts.category_key ?? null,
    subcategory_key: opts.subcategory_key ?? null,
    mcc: opts.mcc ?? null,
    mcc_confidence: opts.mcc ? (opts.mcc_confidence ?? 'medium') : null,
    essential_discretionary: opts.essential_discretionary ?? null,
    subscription_possible: opts.subscription_possible ?? false,
    recurring_possible: opts.recurring_possible ?? opts.subscription_possible ?? false,
    typical_frequency: opts.typical_frequency ?? null,
    fixed_amount_expected: opts.fixed_amount_expected ?? false,
    variable_amount_possible: opts.variable_amount_possible ?? true,
    recurring_type: opts.recurring_type ?? null,
    is_payment_processor: opts.is_payment_processor ?? false,
    website_domain: opts.website_domain ?? null,
    parent_company_name: opts.parent_company_name ?? null,
    active: opts.active ?? true,
    source_key: opts.source_key ?? S,
    source_checked_at: opts.source_checked_at ?? '2026-08-21',
    aliases: opts.aliases ?? [],
    notes: opts.notes ?? null,
  };
}

export const merchantsAu = [
  // --- Groceries ---
  m('woolworths', 'Woolworths', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'woolworths.com.au', parent_company_name: 'Woolworths Group', aliases: ['WOOLWORTHS', 'WOOLWORTHS SUPERMARKET', 'WOOLWORTHS ONLINE', 'WOOLWORTHS METRO'] }),
  m('coles', 'Coles', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'coles.com.au', parent_company_name: 'Coles Group', aliases: ['COLES', 'COLES SUPERMARKET', 'COLES EXPRESS'] }),
  m('aldi_au', 'ALDI', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'aldi.com.au', aliases: ['ALDI', 'ALDI STORES'] }),
  m('iga', 'IGA', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'iga.com.au', parent_company_name: 'Metcash', aliases: ['IGA', 'INDEPENDENT GROCERS'] }),
  m('costco_au', 'Costco Wholesale Australia', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5300', mcc_confidence: 'medium', essential_discretionary: 'essential', website_domain: 'costco.com.au', aliases: ['COSTCO', 'COSTCO WHOLESALE'] }),

  // --- Fuel ---
  m('bp_au', 'BP', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'bp.com.au', aliases: ['BP', 'BP AUSTRALIA'] }),
  m('shell_au', 'Shell', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'shell.com.au', aliases: ['SHELL', 'SHELL COLES EXPRESS'] }),
  m('ampol', 'Ampol', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'ampol.com.au', aliases: ['AMPOL', 'CALTEX'], notes: 'Caltex Australia rebranded to Ampol in 2020.' }),
  m('seven_eleven_au', '7-Eleven', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'medium', essential_discretionary: 'mixed', website_domain: '7eleven.com.au', aliases: ['7-ELEVEN', '7 ELEVEN'], notes: 'Also sells convenience/food items; fuel is the default category, merchant identity alone cannot distinguish a convenience-only purchase.' }),
  m('united_petroleum', 'United Petroleum', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'unitedpetroleum.com.au', aliases: ['UNITED PETROLEUM', 'UNITED'] }),

  // --- Restaurants / takeaway / cafes (large chains only) ---
  m('mcdonalds_au', "McDonald's Australia", { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'mcdonalds.com.au', aliases: ["MCDONALD'S", 'MCDONALDS', 'MACCAS'] }),
  m('kfc_au', 'KFC Australia', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'kfc.com.au', parent_company_name: 'Collins Foods / Yum! Brands', aliases: ['KFC'] }),
  m('hungry_jacks', "Hungry Jack's", { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'hungryjacks.com.au', aliases: ["HUNGRY JACK'S", 'HUNGRY JACKS'] }),
  m('dominos_au', "Domino's Pizza Australia", { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'dominos.com.au', aliases: ["DOMINO'S", 'DOMINOS', "DOMINO'S PIZZA"] }),
  m('subway_au', 'Subway Australia', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'subway.com.au', aliases: ['SUBWAY'] }),
  m('guzman_y_gomez', 'Guzman y Gomez', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'guzmanygomez.com.au', aliases: ['GUZMAN Y GOMEZ', 'GYG'] }),
  m('starbucks_au', 'Starbucks Australia', { merchant_type: 'other', category_key: 'food', subcategory_key: 'cafes_coffee', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'starbucks.com.au', aliases: ['STARBUCKS'] }),
  m('the_coffee_club', 'The Coffee Club', { merchant_type: 'other', category_key: 'food', subcategory_key: 'cafes_coffee', mcc: '5812', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'thecoffeeclub.com.au', aliases: ['THE COFFEE CLUB', 'COFFEE CLUB'] }),

  // --- Utilities / telecom ---
  m('agl_energy', 'AGL Energy', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', fixed_amount_expected: false, recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'agl.com.au', aliases: ['AGL', 'AGL ENERGY'], notes: 'Electricity/gas retailer — merchant identity resolves the utility category, MCC 4900 alone is ambiguous.' }),
  m('origin_energy', 'Origin Energy', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'originenergy.com.au', aliases: ['ORIGIN', 'ORIGIN ENERGY'] }),
  m('energy_australia', 'EnergyAustralia', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'energyaustralia.com.au', aliases: ['ENERGYAUSTRALIA', 'ENERGY AUSTRALIA'] }),
  m('telstra', 'Telstra', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'telstra.com.au', aliases: ['TELSTRA'] }),
  m('optus', 'Optus', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'optus.com.au', parent_company_name: 'Singtel', aliases: ['OPTUS'] }),
  m('tpg_telecom', 'TPG Telecom', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'internet_broadband', mcc: '4816', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'tpg.com.au', aliases: ['TPG', 'TPG TELECOM'] }),
  m('vodafone_au', 'Vodafone Australia', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'vodafone.com.au', parent_company_name: 'TPG Telecom', aliases: ['VODAFONE'], notes: 'Vodafone Hutchison Australia merged with TPG Telecom in 2020; the Vodafone retail brand continues to trade separately within the merged group.' }),

  // --- Streaming / subscriptions ---
  m('netflix', 'Netflix', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '4899', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'netflix.com', aliases: ['NETFLIX', 'NETFLIX.COM'] }),
  m('spotify', 'Spotify', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '5735', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'spotify.com', aliases: ['SPOTIFY'] }),
  m('disney_plus', 'Disney+', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '4899', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'disneyplus.com', aliases: ['DISNEY+', 'DISNEY PLUS'] }),
  m('amazon_prime_au', 'Amazon Prime', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'amazon.com.au', parent_company_name: 'Amazon', aliases: ['AMAZON PRIME', 'PRIME'] }),
  m('stan', 'Stan', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '4899', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'stan.com.au', parent_company_name: 'Nine Entertainment', aliases: ['STAN'] }),
  m('kayo_sports', 'Kayo Sports', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'kayosports.com.au', parent_company_name: 'Foxtel Group', aliases: ['KAYO', 'KAYO SPORTS'] }),

  // --- Rideshare / delivery ---
  m('uber', 'Uber', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'rideshare_taxi', mcc: '4121', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'uber.com', aliases: ['UBER', 'UBER *TRIP', 'UBER TRIP'] }),
  m('uber_eats', 'Uber Eats', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'ubereats.com', parent_company_name: 'Uber', aliases: ['UBER EATS', 'UBER *EATS'] }),
  m('didi_au', 'DiDi', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'rideshare_taxi', mcc: '4121', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'didiglobal.com', aliases: ['DIDI'] }),
  m('menulog', 'Menulog', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', active: false, source_checked_at: '2026-08-22', website_domain: 'menulog.com.au', aliases: ['MENULOG'], notes: 'CLOSURE-RESEARCH CORRECTED 2026-08-22 (live web search): Menulog ceased Australian operations on 26 November 2025 after Just Eat Takeaway.com (its parent since 2020) was itself acquired by Prosus and exited the Australian market amid falling share and consecutive-year losses. Kept seeded for narrative-matching on older statements, marked active: false.' }),
  m('doordash_au', 'DoorDash', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'doordash.com', aliases: ['DOORDASH'] }),

  // --- Transport (tolls) ---
  m('linkt', 'Linkt', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'parking_tolls', mcc: '4784', mcc_confidence: 'high', essential_discretionary: 'mixed', recurring_possible: true, recurring_type: 'other_recurring', website_domain: 'linkt.com.au', parent_company_name: 'Transurban', aliases: ['LINKT'] }),

  // --- Home improvement ---
  m('bunnings', 'Bunnings Warehouse', { merchant_type: 'retail', category_key: 'housing', subcategory_key: 'home_maintenance_repairs', mcc: '5211', mcc_confidence: 'high', essential_discretionary: 'mixed', website_domain: 'bunnings.com.au', parent_company_name: 'Wesfarmers', aliases: ['BUNNINGS', 'BUNNINGS WAREHOUSE'] }),
  m('officeworks', 'Officeworks', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'other_shopping', mcc: '5943', mcc_confidence: 'medium', essential_discretionary: 'mixed', website_domain: 'officeworks.com.au', parent_company_name: 'Wesfarmers', aliases: ['OFFICEWORKS'] }),

  // --- Department / discount retail ---
  m('kmart_au', 'Kmart Australia', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5311', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'kmart.com.au', parent_company_name: 'Wesfarmers', aliases: ['KMART'] }),
  m('target_au', 'Target Australia', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5311', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'target.com.au', parent_company_name: 'Wesfarmers', aliases: ['TARGET'] }),
  m('big_w', 'Big W', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5311', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'bigw.com.au', parent_company_name: 'Woolworths Group', aliases: ['BIG W', 'BIGW'] }),
  m('myer', 'Myer', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5311', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'myer.com.au', aliases: ['MYER'] }),
  m('david_jones', 'David Jones', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5311', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'davidjones.com', aliases: ['DAVID JONES'] }),
  m('the_reject_shop', 'The Reject Shop', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'department_discount_retail', mcc: '5310', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'rejectshop.com.au', aliases: ['THE REJECT SHOP', 'REJECT SHOP'] }),

  // --- Online / e-commerce ---
  m('amazon_au', 'Amazon Australia', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', website_domain: 'amazon.com.au', aliases: ['AMAZON', 'AMAZON.COM.AU', 'AMAZON AU'], notes: 'General marketplace — actual purchase category varies by item; default category is broad-group only.' }),
  m('ebay_au', 'eBay Australia', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', website_domain: 'ebay.com.au', aliases: ['EBAY'] }),
  m('catch_au', 'Catch.com.au', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', active: false, source_checked_at: '2026-08-22', website_domain: 'catch.com.au', parent_company_name: 'Wesfarmers', aliases: ['CATCH', 'CATCH.COM.AU'], notes: 'CLOSURE-RESEARCH CORRECTED 2026-08-22 (live web search): Wesfarmers permanently closed Catch.com.au, with its last trading day 30 April 2025, after sustained losses ($96m in FY23/24). Kept seeded (real, historically significant merchant for narrative-matching on older statements) but marked active: false rather than left silently as an operating merchant.' }),
  m('temple_and_webster', 'Temple & Webster', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'home_furniture_homeware', mcc: '5712', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'templeandwebster.com.au', aliases: ['TEMPLE & WEBSTER', 'TEMPLE AND WEBSTER'] }),
  m('booktopia', 'Booktopia', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'other_shopping', mcc: '5942', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'booktopia.com.au', aliases: ['BOOKTOPIA'] }),

  // --- Insurance ---
  m('bupa_au', 'Bupa Australia', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'health_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'bupa.com.au', aliases: ['BUPA'] }),
  m('medibank', 'Medibank', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'health_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'medibank.com.au', aliases: ['MEDIBANK', 'MEDIBANK PRIVATE'] }),
  m('nib', 'nib', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'health_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'nib.com.au', aliases: ['NIB', 'NIB HEALTH FUNDS'] }),
  m('allianz_au', 'Allianz Australia', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'other_insurance', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'allianz.com.au', aliases: ['ALLIANZ'] }),
  m('aami', 'AAMI', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'vehicle_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'aami.com.au', parent_company_name: 'Suncorp Group', aliases: ['AAMI'] }),
  m('budget_direct', 'Budget Direct', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'vehicle_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'budgetdirect.com.au', parent_company_name: 'Auto & General', aliases: ['BUDGET DIRECT'] }),
  m('qbe_au', 'QBE Insurance', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'home_contents_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'qbe.com', aliases: ['QBE', 'QBE INSURANCE'] }),

  // --- Health / pharmacy ---
  m('chemist_warehouse', 'Chemist Warehouse', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'chemistwarehouse.com.au', aliases: ['CHEMIST WAREHOUSE'] }),
  m('priceline_pharmacy', 'Priceline Pharmacy', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'priceline.com.au', aliases: ['PRICELINE', 'PRICELINE PHARMACY'] }),
  m('terry_white_chemmart', 'Terry White Chemmart', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'terrywhitechemmart.com.au', aliases: ['TERRY WHITE CHEMMART', 'TERRYWHITE'] }),

  // --- Travel ---
  m('qantas', 'Qantas', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'flights', mcc: '4511', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'qantas.com', aliases: ['QANTAS', 'QANTAS AIRWAYS'] }),
  m('jetstar', 'Jetstar', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'flights', mcc: '4511', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'jetstar.com', parent_company_name: 'Qantas Group', aliases: ['JETSTAR'] }),
  m('virgin_australia', 'Virgin Australia', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'flights', mcc: '4511', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'virginaustralia.com', aliases: ['VIRGIN AUSTRALIA'] }),
  m('flight_centre', 'Flight Centre', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'travel_packages_tours', mcc: '4722', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'flightcentre.com.au', aliases: ['FLIGHT CENTRE'] }),
  m('webjet', 'Webjet', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'travel_packages_tours', mcc: '4722', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'webjet.com.au', aliases: ['WEBJET'] }),
  m('airbnb', 'Airbnb', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'accommodation', mcc: '7011', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'airbnb.com', aliases: ['AIRBNB'] }),
  m('booking_com', 'Booking.com', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'accommodation', mcc: '7011', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'booking.com', aliases: ['BOOKING.COM', 'BOOKING COM'] }),

  // --- Education / childcare ---
  m('goodstart_early_learning', 'Goodstart Early Learning', { merchant_type: 'education', category_key: 'education', subcategory_key: 'childcare_daycare', mcc: '8351', mcc_confidence: 'high', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'weekly', recurring_type: 'other_recurring', website_domain: 'goodstart.org.au', aliases: ['GOODSTART', 'GOODSTART EARLY LEARNING'] }),
  m('g8_education', 'G8 Education', { merchant_type: 'education', category_key: 'education', subcategory_key: 'childcare_daycare', mcc: '8351', mcc_confidence: 'high', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'weekly', recurring_type: 'other_recurring', website_domain: 'g8education.edu.au', aliases: ['G8 EDUCATION'] }),
];
