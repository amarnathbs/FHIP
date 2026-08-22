// FDH-2 — Indian merchant master. Payment processors/gateways are included
// deliberately and explicitly (specification section 29-37: "narratives
// often show processor not end merchant") with `is_payment_processor: true`
// so a future engine knows to look for a downstream descriptor rather than
// classify the processor itself into one economic category.
const S = 'in_public_merchant_information';

function m(canonical_name, display_name, opts) {
  return {
    canonical_name,
    display_name,
    country_code: 'IN',
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

export const merchantsIn = [
  // --- Grocery / retail ---
  m('bigbasket', 'BigBasket', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'bigbasket.com', parent_company_name: 'Tata Digital', aliases: ['BIGBASKET', 'BIG BASKET'] }),
  m('dmart', 'DMart', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'dmart.in', parent_company_name: 'Avenue Supermarts Limited', aliases: ['DMART', 'D MART', 'AVENUE SUPERMARTS'] }),
  m('reliance_fresh', 'Reliance Fresh', { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'relianceretail.com', parent_company_name: 'Reliance Retail', aliases: ['RELIANCE FRESH', 'RELIANCE SMART'] }),
  m('spencers_retail', "Spencer's Retail", { merchant_type: 'grocery', category_key: 'food', subcategory_key: 'groceries', mcc: '5411', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'spencersretail.com', parent_company_name: 'RP-Sanjiv Goenka Group', aliases: ["SPENCER'S", 'SPENCERS RETAIL'] }),

  // --- E-commerce ---
  m('amazon_in', 'Amazon India', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', website_domain: 'amazon.in', parent_company_name: 'Amazon', aliases: ['AMAZON', 'AMAZON.IN', 'AMAZON INDIA'] }),
  m('flipkart', 'Flipkart', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', website_domain: 'flipkart.com', parent_company_name: 'Walmart', aliases: ['FLIPKART'] }),
  m('myntra', 'Myntra', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'clothing_footwear', mcc: '5651', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'myntra.com', parent_company_name: 'Flipkart / Walmart', aliases: ['MYNTRA'] }),
  m('meesho', 'Meesho', { merchant_type: 'retail', category_key: 'shopping', subcategory_key: 'online_marketplace_general', mcc: '5964', mcc_confidence: 'low', essential_discretionary: 'discretionary', website_domain: 'meesho.com', aliases: ['MEESHO'] }),
  m('nykaa', 'Nykaa', { merchant_type: 'retail', category_key: 'lifestyle', subcategory_key: 'personal_care', mcc: '5977', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'nykaa.com', parent_company_name: 'FSN E-Commerce Ventures', aliases: ['NYKAA'] }),

  // --- Food delivery ---
  m('swiggy', 'Swiggy', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'swiggy.com', aliases: ['SWIGGY'] }),
  m('zomato', 'Zomato', { merchant_type: 'other', category_key: 'food', subcategory_key: 'takeaway_food_delivery', mcc: '5814', mcc_confidence: 'medium', essential_discretionary: 'discretionary', source_checked_at: '2026-08-22', website_domain: 'zomato.com', parent_company_name: 'Eternal Limited', aliases: ['ZOMATO'], notes: 'CLOSURE-RESEARCH VERIFIED 2026-08-22 (live web search): Zomato\'s parent entity was renamed Eternal Limited (shareholders approved 6 Feb 2025, effective March 2025) — the year is corrected from the previously-stated "2024" to the confirmed 2025 timeline. The consumer-facing Zomato app/brand is unchanged.' }),

  // --- Rideshare / transport ---
  m('ola', 'Ola', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'rideshare_taxi', mcc: '4121', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'olacabs.com', parent_company_name: 'ANI Technologies', aliases: ['OLA', 'OLA CABS'] }),
  m('uber_in', 'Uber India', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'rideshare_taxi', mcc: '4121', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'uber.com', aliases: ['UBER'] }),
  m('rapido', 'Rapido', { merchant_type: 'transport', category_key: 'transport', subcategory_key: 'rideshare_taxi', mcc: '4121', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'rapido.bike', aliases: ['RAPIDO'] }),
  m('irctc', 'IRCTC', { merchant_type: 'transport', category_key: 'travel', subcategory_key: 'other_travel', mcc: '4111', mcc_confidence: 'medium', essential_discretionary: 'mixed', website_domain: 'irctc.co.in', parent_company_name: 'Indian Railways', aliases: ['IRCTC', 'INDIAN RAILWAY CATERING'] }),

  // --- Telecom / utilities ---
  m('reliance_jio', 'Reliance Jio', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'jio.com', parent_company_name: 'Reliance Industries', aliases: ['JIO', 'RELIANCE JIO'] }),
  m('bharti_airtel', 'Airtel', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'airtel.in', parent_company_name: 'Bharti Airtel Limited', aliases: ['AIRTEL', 'BHARTI AIRTEL'] }),
  m('vodafone_idea', 'Vi (Vodafone Idea)', { merchant_type: 'telecom', category_key: 'utilities', subcategory_key: 'mobile_phone', mcc: '4814', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'telecom', website_domain: 'myvi.in', aliases: ['VI', 'VODAFONE IDEA'] }),
  m('adani_electricity', 'Adani Electricity Mumbai', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'adanielectricity.com', aliases: ['ADANI ELECTRICITY'] }),
  m('tata_power', 'Tata Power', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'tatapower.com', aliases: ['TATA POWER'] }),
  m('indraprastha_gas', 'Indraprastha Gas Limited', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'iglonline.net', aliases: ['IGL', 'INDRAPRASTHA GAS'] }),
  m('mahanagar_gas', 'Mahanagar Gas Limited', { merchant_type: 'utility', category_key: 'utilities', mcc: '4900', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'monthly', recurring_type: 'utility', website_domain: 'mahanagargas.com', aliases: ['MGL', 'MAHANAGAR GAS'] }),

  // --- Digital subscriptions ---
  m('netflix_in', 'Netflix', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '4899', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'netflix.com', aliases: ['NETFLIX'] }),
  m('amazon_prime_in', 'Amazon Prime', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'amazon.in', parent_company_name: 'Amazon', aliases: ['AMAZON PRIME', 'PRIME VIDEO'] }),
  m('jiohotstar', 'JioHotstar', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '4899', mcc_confidence: 'low', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', source_checked_at: '2026-08-22', website_domain: 'jiohotstar.com', parent_company_name: 'Reliance / Disney joint venture', aliases: ['JIOHOTSTAR', 'DISNEY+ HOTSTAR', 'HOTSTAR'], notes: 'CLOSURE-RESEARCH VERIFIED 2026-08-22 (live web search, TechCrunch + multiple India trade press): the merger is confirmed complete — JioCinema and Disney+ Hotstar merged into JioHotstar on 14 February 2025 under JioStar, the Reliance Industries / Walt Disney joint venture. The seeded facts were accurate; the prior LOWER-CONFIDENCE flag is resolved and removed. Both legacy apps still exist during a transition period, with the Disney+ Hotstar app auto-updating to the new brand.' }),
  m('spotify_in', 'Spotify', { merchant_type: 'subscription', category_key: 'lifestyle', subcategory_key: 'entertainment_streaming_subscriptions', mcc: '5735', mcc_confidence: 'medium', essential_discretionary: 'discretionary', subscription_possible: true, recurring_possible: true, typical_frequency: 'monthly', fixed_amount_expected: true, recurring_type: 'subscription', website_domain: 'spotify.com', aliases: ['SPOTIFY'] }),

  // --- Payment processors / gateways (IMPORTANT — see module docstring) ---
  m('razorpay', 'Razorpay', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'razorpay.com', aliases: ['RAZORPAY'], notes: 'Payment gateway/processor — the narrative typically shows RAZORPAY plus a downstream merchant descriptor. Never classify a processor charge into one economic category by itself.' }),
  m('payu_india', 'PayU India', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'payu.in', aliases: ['PAYU'] }),
  m('ccavenue', 'CCAvenue', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'ccavenue.com', parent_company_name: 'Avenues (India) Pvt Ltd', aliases: ['CCAVENUE'] }),
  m('google_pay_in', 'Google Pay', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'pay.google.com', parent_company_name: 'Google', aliases: ['GOOGLE PAY', 'GPAY'] }),
  m('phonepe', 'PhonePe', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'phonepe.com', parent_company_name: 'Walmart', aliases: ['PHONEPE'] }),
  m('paytm', 'Paytm', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'paytm.com', parent_company_name: 'One97 Communications', aliases: ['PAYTM'] }),
  m('billdesk', 'BillDesk', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'billdesk.com', aliases: ['BILLDESK'] }),
  m('cashfree', 'Cashfree Payments', { merchant_type: 'financial_institution', is_payment_processor: true, essential_discretionary: 'not_applicable', website_domain: 'cashfree.com', aliases: ['CASHFREE'] }),

  // --- Fuel ---
  m('indian_oil', 'Indian Oil (IOCL)', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'iocl.com', aliases: ['IOCL', 'INDIAN OIL', 'INDANE'] }),
  m('bharat_petroleum', 'Bharat Petroleum (BPCL)', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'bharatpetroleum.in', aliases: ['BPCL', 'BHARAT PETROLEUM'] }),
  m('hindustan_petroleum', 'Hindustan Petroleum (HPCL)', { merchant_type: 'fuel', category_key: 'transport', subcategory_key: 'fuel', mcc: '5541', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'hindustanpetroleum.com', aliases: ['HPCL', 'HINDUSTAN PETROLEUM'] }),

  // --- Insurance ---
  m('lic', 'Life Insurance Corporation of India (LIC)', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'life_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'licindia.in', aliases: ['LIC', 'LIFE INSURANCE CORPORATION'] }),
  m('icici_lombard', 'ICICI Lombard', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'vehicle_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'icicilombard.com', aliases: ['ICICI LOMBARD'] }),
  m('hdfc_ergo', 'HDFC ERGO', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'other_insurance', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'hdfcergo.com', aliases: ['HDFC ERGO'] }),
  m('star_health_insurance', 'Star Health Insurance', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'health_insurance_premium', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'starhealth.in', aliases: ['STAR HEALTH', 'STAR HEALTH INSURANCE'] }),
  m('bajaj_allianz', 'Bajaj Allianz', { merchant_type: 'insurance', category_key: 'insurance', subcategory_key: 'other_insurance', mcc: '6300', mcc_confidence: 'medium', essential_discretionary: 'essential', recurring_possible: true, typical_frequency: 'annual', fixed_amount_expected: true, recurring_type: 'insurance', website_domain: 'bajajallianz.com', aliases: ['BAJAJ ALLIANZ'] }),

  // --- Healthcare / pharmacy ---
  m('apollo_pharmacy', 'Apollo Pharmacy', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'apollopharmacy.in', parent_company_name: 'Apollo Hospitals Enterprise', aliases: ['APOLLO PHARMACY'] }),
  m('tata_1mg', 'Tata 1mg', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: '1mg.com', parent_company_name: 'Tata Digital', aliases: ['1MG', 'TATA 1MG'] }),
  m('pharmeasy', 'PharmEasy', { merchant_type: 'health', category_key: 'health', subcategory_key: 'pharmacy', mcc: '5912', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'pharmeasy.in', aliases: ['PHARMEASY'] }),
  m('apollo_hospitals', 'Apollo Hospitals', { merchant_type: 'health', category_key: 'health', subcategory_key: 'doctor_specialist', mcc: '8062', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'apollohospitals.com', aliases: ['APOLLO HOSPITALS', 'APOLLO'] }),
  m('fortis_healthcare', 'Fortis Healthcare', { merchant_type: 'health', category_key: 'health', subcategory_key: 'doctor_specialist', mcc: '8062', mcc_confidence: 'high', essential_discretionary: 'essential', website_domain: 'fortishealthcare.com', aliases: ['FORTIS', 'FORTIS HEALTHCARE'] }),

  // --- Travel ---
  m('makemytrip', 'MakeMyTrip', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'travel_packages_tours', mcc: '4722', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'makemytrip.com', aliases: ['MAKEMYTRIP', 'MMT'] }),
  m('goibibo', 'Goibibo', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'travel_packages_tours', mcc: '4722', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'goibibo.com', parent_company_name: 'MakeMyTrip Group', aliases: ['GOIBIBO'] }),
  m('indigo_airlines', 'IndiGo', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'flights', mcc: '4511', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'goindigo.in', parent_company_name: 'InterGlobe Aviation', aliases: ['INDIGO'] }),
  m('air_india', 'Air India', { merchant_type: 'other', category_key: 'travel', subcategory_key: 'flights', mcc: '4511', mcc_confidence: 'high', essential_discretionary: 'discretionary', website_domain: 'airindia.com', parent_company_name: 'Tata Group', aliases: ['AIR INDIA'] }),

  // --- Education (high-confidence only) ---
  m('byjus', "BYJU'S", { merchant_type: 'education', category_key: 'education', subcategory_key: 'tutoring', mcc: '8299', mcc_confidence: 'medium', essential_discretionary: 'discretionary', source_checked_at: '2026-08-22', website_domain: 'byjus.com', parent_company_name: 'Think and Learn Pvt Ltd', aliases: ["BYJU'S", 'BYJUS'], notes: "CLOSURE-RESEARCH VERIFIED 2026-08-22 (live web search, incl. Wikipedia and Indian financial press): BYJU'S remains under active insolvency proceedings in India as of mid-2026 (Supreme Court reinstated proceedings Oct 2024 after a brief NCLAT closure), its Android app was delisted from the Play Store in May 2025 over unpaid hosting bills, and founder-estimated valuation has collapsed to near zero — but the company has not been liquidated/dissolved, so it is kept seeded and active for narrative-matching. The prior LOWER-CONFIDENCE flag is resolved: the uncertainty was real and remains real (ongoing proceedings), now backed by a dated live source rather than trained-knowledge recall." }),
  m('unacademy', 'Unacademy', { merchant_type: 'education', category_key: 'education', subcategory_key: 'tutoring', mcc: '8299', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'unacademy.com', aliases: ['UNACADEMY'] }),
  m('vedantu', 'Vedantu', { merchant_type: 'education', category_key: 'education', subcategory_key: 'tutoring', mcc: '8299', mcc_confidence: 'medium', essential_discretionary: 'discretionary', website_domain: 'vedantu.com', aliases: ['VEDANTU'] }),
];
