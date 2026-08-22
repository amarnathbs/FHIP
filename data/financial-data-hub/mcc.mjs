// FDH-2 — MCC (Merchant Category Code, ISO 18245) master. Codes and standard
// descriptions are drawn from publicly documented payment-network MCC
// reference lists (source_key: iso18245_mcc_public_reference — see
// FDH2_RESEARCH_EVIDENCE.md). `normalized_description` and `broad_group` are
// FHIP's own concise/grouped restatement, not a verbatim copy.
//
// An MCC is an INPUT SIGNAL, never an absolute classification — see
// mccCategoryMap.mjs for how (and how NOT) each code maps to a category.
const S = 'iso18245_mcc_public_reference';
const BOTH = ['AU', 'IN'];

function mcc(code, official, normalized, broad_group, notes = null) {
  return {
    mcc: code,
    official_or_public_description: official,
    normalized_description: normalized,
    broad_group,
    active: true,
    source_key: S,
    source_version: '2026-08-public-reference',
    country_relevance: BOTH,
    notes,
  };
}

export const mccList = [
  // Grocery / supermarket
  mcc('5411', 'Grocery Stores, Supermarkets', 'Supermarket / grocery store', 'grocery_supermarket'),
  mcc('5422', 'Freezer and Locker Meat Provisioners', 'Butcher / meat provisioner', 'grocery_supermarket'),
  mcc('5441', 'Candy, Nut, and Confectionery Stores', 'Confectionery store', 'grocery_supermarket'),
  mcc('5451', 'Dairy Products Stores', 'Dairy products store', 'grocery_supermarket'),
  mcc('5462', 'Bakeries', 'Bakery', 'food_beverage'),
  mcc('5499', 'Miscellaneous Food Stores', 'Convenience / specialty food store', 'grocery_supermarket'),

  // Food & beverage
  mcc('5812', 'Eating Places, Restaurants', 'Restaurant', 'food_beverage'),
  mcc('5813', 'Drinking Places (Bars, Taverns, Nightclubs)', 'Bar / pub / nightclub', 'food_beverage'),
  mcc('5814', 'Fast Food Restaurants', 'Fast food / takeaway', 'food_beverage'),
  mcc('5921', 'Package Stores, Beer, Wine, Liquor', 'Liquor store', 'food_beverage'),

  // Fuel / automotive
  mcc('5541', 'Service Stations', 'Petrol / fuel station (with service)', 'fuel_automotive'),
  mcc('5542', 'Automated Fuel Dispensers', 'Petrol / fuel station (self-serve pump)', 'fuel_automotive'),
  mcc('5511', 'Car and Truck Dealers (New and Used)', 'Vehicle dealer', 'fuel_automotive'),
  mcc('5531', 'Auto and Home Supply Stores', 'Auto parts / accessories store', 'fuel_automotive'),
  mcc('7538', 'Automotive Service Shops', 'Vehicle repair / service shop', 'fuel_automotive'),
  mcc('7523', 'Parking Lots and Garages', 'Parking', 'transport_travel'),

  // Utilities / telecom
  mcc('4900', 'Utilities — Electric, Gas, Water, Sanitary', 'Electricity / gas / water / waste utility', 'utilities_telecom', 'Genuinely ambiguous across utility TYPE — the mapping deliberately leaves subcategory unresolved (see mccCategoryMap.mjs).'),
  mcc('4814', 'Telecommunication Services', 'Telecom / mobile / phone service', 'utilities_telecom'),
  mcc('4816', 'Computer Network / Information Services', 'Internet service provider', 'utilities_telecom'),
  mcc('4899', 'Cable, Satellite, and Other Pay TV/Radio Services', 'Pay TV / cable / satellite / streaming-subscription service', 'utilities_telecom', 'Some processors also report digital streaming subscriptions under this code rather than a dedicated one; merchant-level mapping (not MCC alone) distinguishes a utility pay-TV bundle from a discretionary streaming subscription.'),

  // Transport / travel
  mcc('4111', 'Local/Suburban Commuter Transport', 'Public transport (train/tram/bus)', 'transport_travel'),
  mcc('4121', 'Taxicabs and Limousines', 'Taxi / rideshare', 'transport_travel'),
  mcc('4131', 'Bus Lines', 'Bus travel', 'transport_travel'),
  mcc('4784', 'Tolls and Bridge Fees', 'Road toll', 'transport_travel'),
  mcc('4511', 'Airlines, Air Carriers', 'Airline', 'transport_travel'),
  mcc('4722', 'Travel Agencies and Tour Operators', 'Travel agency / tour operator', 'transport_travel'),
  mcc('7011', 'Hotels, Motels, Resorts', 'Hotel / accommodation', 'transport_travel'),
  mcc('7512', 'Car Rental Agencies', 'Car rental', 'transport_travel'),

  // Health / medical
  mcc('5912', 'Drug Stores and Pharmacies', 'Pharmacy', 'health_medical'),
  mcc('8011', 'Doctors, Physicians', 'Doctor / GP / specialist', 'health_medical'),
  mcc('8021', 'Dentists, Orthodontists', 'Dentist', 'health_medical'),
  mcc('8031', 'Osteopaths', 'Osteopath', 'health_medical'),
  mcc('8041', 'Chiropractors', 'Chiropractor', 'health_medical'),
  mcc('8042', 'Optometrists, Ophthalmologists', 'Optometrist / eye care', 'health_medical'),
  mcc('8043', 'Opticians, Optical Goods and Eyeglasses', 'Optical goods', 'health_medical'),
  mcc('8049', 'Podiatrists and Chiropodists', 'Podiatrist', 'health_medical'),
  mcc('8050', 'Nursing and Personal Care Facilities', 'Nursing / aged-care facility', 'health_medical'),
  mcc('8062', 'Hospitals', 'Hospital', 'health_medical'),
  mcc('8099', 'Medical Services, Health Practitioners (Not Elsewhere Classified)', 'Allied health practitioner', 'health_medical'),

  // Education
  mcc('8211', 'Elementary and Secondary Schools', 'School (primary/secondary)', 'education'),
  mcc('8220', 'Colleges, Universities, Professional Schools', 'University / college', 'education'),
  mcc('8241', 'Correspondence Schools', 'Correspondence / distance education', 'education'),
  mcc('8244', 'Business/Secretarial Schools', 'Business / vocational school', 'education'),
  mcc('8299', 'Schools and Educational Services (Not Elsewhere Classified)', 'Tutoring / other education service', 'education'),
  mcc('8351', 'Child Care Services', 'Childcare / daycare', 'education'),

  // Financial services
  mcc('6011', 'Automated Cash Disbursements (ATM)', 'ATM cash withdrawal', 'financial_services'),
  mcc('6010', 'Manual Cash Disbursements', 'Branch cash withdrawal', 'financial_services'),
  mcc('6012', 'Financial Institutions — Merchandise and Services', 'Bank / financial-institution service', 'financial_services'),
  mcc('6051', 'Quasi Cash — Non-Financial Institutions', 'Quasi-cash / money order / stored value', 'financial_services'),
  mcc('6211', 'Securities Brokers and Dealers', 'Broker / investment platform', 'financial_services'),
  mcc('6300', 'Insurance Sales, Underwriting, Premiums', 'Insurance premium', 'insurance', 'Genuinely ambiguous across insurance TYPE — left unresolved at subcategory (see mccCategoryMap.mjs).'),
  mcc('6540', 'POS Funding — Non-Financial Institutions', 'Prepaid / POS funding transaction', 'financial_services'),

  // Government services
  mcc('9311', 'Tax Payments', 'Government tax payment', 'government_services'),
  mcc('9399', 'Government Services (Not Elsewhere Classified)', 'Government service payment', 'government_services'),
  mcc('9222', 'Fines', 'Government fine / penalty', 'government_services'),
  mcc('9402', 'Postal Services — Government Only', 'Postal service', 'government_services'),

  // Retail / merchandise
  mcc('5300', 'Wholesale Clubs', 'Wholesale / membership club', 'retail_merchandise'),
  mcc('5311', 'Department Stores', 'Department store', 'retail_merchandise'),
  mcc('5310', 'Discount Stores', 'Discount store', 'retail_merchandise'),
  mcc('5399', 'Miscellaneous General Merchandise', 'General merchandise store / online marketplace (general)', 'retail_merchandise'),
  mcc('5651', 'Family Clothing Stores', 'Clothing store', 'retail_merchandise'),
  mcc('5621', "Women's Ready-to-Wear Stores", "Women's clothing store", 'retail_merchandise'),
  mcc('5611', "Men's and Boy's Clothing Stores", "Men's clothing store", 'retail_merchandise'),
  mcc('5661', 'Shoe Stores', 'Footwear store', 'retail_merchandise'),
  mcc('5732', 'Electronics Stores', 'Electronics store', 'retail_merchandise'),
  mcc('5722', 'Household Appliance Stores', 'Appliance store', 'retail_merchandise'),
  mcc('5712', 'Furniture, Home Furnishings Stores', 'Furniture / homeware store', 'retail_merchandise'),
  mcc('5211', 'Lumber, Building Materials Stores', 'Home improvement / hardware store', 'retail_merchandise'),
  mcc('5945', 'Hobby, Toy, and Game Shops', 'Hobby / toy store', 'retail_merchandise'),
  mcc('5942', 'Book Stores', 'Book store', 'retail_merchandise'),
  mcc('5943', 'Stationery, Office and School Supply Stores', 'Stationery / office supply store', 'retail_merchandise'),
  mcc('5964', 'Direct Marketing — Catalog Merchants', 'Catalog / online retailer', 'retail_merchandise', 'General online-retail bucket; many marketplaces self-report a more specific MCC instead.'),
  mcc('5992', 'Florists', 'Florist', 'retail_merchandise'),
  mcc('5977', 'Cosmetic Stores', 'Cosmetics / personal care store', 'retail_merchandise'),

  // Entertainment / recreation
  mcc('7832', 'Motion Picture Theaters', 'Cinema', 'entertainment_recreation'),
  mcc('7996', 'Amusement Parks, Carnivals', 'Amusement park', 'entertainment_recreation'),
  mcc('7997', 'Membership Clubs (Sports, Recreation, Athletic)', 'Gym / fitness / recreation club', 'entertainment_recreation'),
  mcc('7998', 'Aquariums', 'Aquarium / zoo', 'entertainment_recreation'),
  mcc('5735', 'Record Stores / Digital Media', 'Music / digital media store', 'entertainment_recreation'),

  // Professional / business services
  mcc('8931', 'Accounting, Auditing, Bookkeeping Services', 'Accounting / bookkeeping service', 'professional_services'),
  mcc('8111', 'Legal Services, Attorneys', 'Legal service', 'professional_services'),
  mcc('7372', 'Computer Programming, Data Processing, Software', 'Software / SaaS service', 'professional_services'),
  mcc('8398', 'Charitable and Social Service Organizations', 'Charity / not-for-profit', 'professional_services'),
  mcc('8641', 'Civic, Social, Fraternal Associations', 'Membership / community association', 'professional_services'),
  mcc('7299', 'Miscellaneous Personal Services', 'Personal service (not elsewhere classified)', 'professional_services'),

  // Wholesale / business
  mcc('5199', 'Nondurable Goods (Not Elsewhere Classified)', 'Wholesale nondurable goods', 'wholesale_business'),
  mcc('5085', 'Industrial Supplies (Not Elsewhere Classified)', 'Industrial / trade supplies', 'wholesale_business'),
];
