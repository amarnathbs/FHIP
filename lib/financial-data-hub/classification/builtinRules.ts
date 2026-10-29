/**
 * Built-in deterministic categorisation rules (28-10-2026 coverage work).
 *
 * WHY THIS EXISTS. Production evidence (29-10-2026): after a real bank import the review said "271 of 341 need you to choose a category".
 * The governed reference data (60 global narrative rules, ~140 merchants) recognised only the large brands and the few fee/interest
 * wordings; ordinary Australian statement shapes such as "Osko Payment To <you>", "Transfer to SAV <digits>", "BPAY to <card issuer>",
 * "Direct Debit <card issuer>", a utility biller, a school fee or a bakery were all "We could not tell what this is".
 *
 * WHAT IT IS. A small, reviewable, code-level rule table plus a few structural rules (own-account transfers). No AI, no database, no
 * network, no regular expression compiled from data. It sits at the "narrative pattern" tier of the existing precedence order
 * (classificationPrecedence.ts): a user's own rule, a verified merchant and an approved global rule all outrank it. Every match scores
 * MEDIUM, so a line classified here is a PROPOSAL the person approves by category total ("proposed, check the lines"); nothing is
 * approved or counted by this file.
 *
 * WHY IT IS NOT A MIGRATION. FHIP's rule table is data, applied by migration, and the Product Owner asked for no migration unless
 * unavoidable. A rule added here ships with the code, is covered by unit tests with look-alikes that must NOT match, and can later be
 * promoted into the governed table without changing behaviour.
 *
 * HOW CONSERVATIVE. A wrong automatic category is worse than a question, so:
 *  - phrases match on WORD boundaries (`containsPhrase`): "BP" is a fuel brand, "BPAY" is not;
 *  - spending rules apply to money OUT only; a credit with the same words stays a question (it may be a refund);
 *  - a person-to-person Osko / PayID line is never decided by a merchant word in the payer's typed reference;
 *  - when two rules of the same priority disagree the engine proposes nothing (it asks) rather than picking one;
 *  - a payment to another person is NEVER given a spending category here: FHIP's category list has no "payment to a person" category,
 *    so those lines stay a question (and are grouped by payee so one answer covers them all).
 */

import type { FdhEconomicTransactionType } from '../constants/enums';
import type { FdhCategory, FdhSubcategory } from '../domain/types';
import { isCardPurchaseShape, isPersonToPersonRail } from './paymentShape';
import { mentionsOwnAccount, matchOwnPerson, onlyOwnNameWords, ownMaskedAccountKind, type OwnIdentity } from './ownIdentity';
import { containsPhrase } from './textMatch';

export interface BuiltinRuleDef {
  key: string;
  /** Which statement currency family the rule is written for. */
  region: 'AU' | 'IN';
  direction?: 'debit' | 'credit';
  /** Any one of these phrases (word-boundary match). */
  anyOf: readonly string[];
  /** A second group: when present, one of these must ALSO be present. */
  andAnyOf?: readonly string[];
  /** None of these may be present. */
  noneOf?: readonly string[];
  category: string;
  subcategory?: string;
  /** True only for rules whose wording is MEANT to be typed by a person on an Osko / PayID line (the rent reference). */
  allowOnPersonToPerson?: boolean;
  /** True when the phrase is MORE specific than a merchant alias that would otherwise decide ("COSTCO GAS" vs "COSTCO"). */
  outranksMerchant?: boolean;
  /** Lower number wins. Specific brand/phrase rules 300; generic words 350. */
  priority: number;
  /** Plain-words reason shown to the person. */
  why: string;
}

const REFUND_WORDS = ['REFUND', 'REVERSAL', 'REVERSED', 'CHARGEBACK', 'CANCELLED', 'WAIVED'] as const;

export const BUILTIN_RULES: readonly BuiltinRuleDef[] = [
  // ---- Credit-card, store-card and buy-now-pay-later repayments (a transfer to a liability, never an expense) --------------------------
  {
    key: 'au_card_repayment_bpay_issuer', region: 'AU', anyOf: ['BPAY', 'BPAY TO', 'INTERNET BPAY', 'DIRECT DEBIT', 'DIRECT CREDIT', 'AUTO PAYMENT', 'AUTOPAY'],
    andAnyOf: ['CREDIT CARD', 'CREDIT CARDS', 'CREDITCARD', 'CREDITCARDS', 'MYCARD', 'READYCREDIT', 'READY CREDIT', 'GEM VISA', 'GEM MASTERCARD', 'HUMM', 'AMERICAN EXPRESS', 'AMEX', 'CITIBANK', 'DINERS CLUB', 'LATITUDE FINANCE', 'GE SALES FINANCE', 'CARD SERVICES', 'CARDS SERVICES'],
    noneOf: ['REFUND', 'FEE'],
    category: 'credit_card_payment', subcategory: 'credit_card_bill_payment', priority: 300,
    why: 'a payment to a credit-card or store-card provider',
  },
  {
    key: 'au_card_repayment_words', region: 'AU', anyOf: ['CREDIT CARD PAYMENT', 'CREDIT CARD REPAYMENT', 'CARD REPAYMENT', 'PAYMENT THANK YOU', 'CC PAYMENT'],
    noneOf: ['REFUND', 'FEE'], category: 'credit_card_payment', subcategory: 'credit_card_bill_payment', priority: 300,
    why: 'wording that names a credit-card repayment',
  },
  {
    key: 'au_card_provider_statement_line', region: 'AU', anyOf: ['GE SALES FINANCE', 'GE MONEY', 'LATITUDE FINANCIAL', 'HUMM CARDS', 'HUMM'],
    noneOf: ['REFUND', 'FEE'], category: 'credit_card_payment', subcategory: 'credit_card_bill_payment', priority: 310,
    why: 'a payment to a credit or store-card provider',
  },

  // ---- Loans (principal and interest together; the split is not on a bank line) ----------------------------------------------------------
  {
    key: 'au_loan_repayment', region: 'AU', direction: 'debit', anyOf: ['LOAN REPAYMENT', 'HOME LOAN', 'MORTGAGE', 'MORTGAGE REPAYMENT', 'LOAN PAYMENT'],
    noneOf: ['INTEREST', 'FEE', 'REFUND', 'INSURANCE'], category: 'loan_principal', subcategory: 'other_loan_principal', priority: 320,
    why: 'wording that names a loan or mortgage repayment',
  },

  {
    key: 'au_loan_repayment_on_transfer_line', region: 'AU', direction: 'debit', anyOf: ['REPAYMENT', 'REPAYMENTS'], andAnyOf: ['HL', 'LOAN', 'MORTGAGE', 'HOME LOAN'],
    noneOf: ['INTEREST', 'FEE', 'REFUND', 'INSURANCE'], category: 'loan_principal', subcategory: 'other_loan_principal', priority: 320, allowOnPersonToPerson: true,
    why: 'a loan repayment named in the reference',
  },

  // ---- Retirement ----------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_super_contribution', region: 'AU', direction: 'debit',
    anyOf: ['SUPER', 'SUPERANNUATION', 'AUSTRALIANSUPER', 'AUSTRALIAN SUPER', 'HOSTPLUS', 'CBUS', 'UNISUPER', 'HESTA', 'REST SUPER', 'AWARE SUPER', 'SUNSUPER', 'MLC SUPER', 'NORTH SUPER', 'ART SUPER', 'AMP SUPER'],
    andAnyOf: ['BPAY', 'BILLER CODE', 'CONTRIBUTION', 'SUPER FUND', 'SUPERANNUATION', 'AUSTRALIANSUPER', 'HOSTPLUS', 'CBUS', 'UNISUPER', 'HESTA', 'AWARE SUPER', 'SUNSUPER', 'MLC SUPER', 'NORTH SUPER', 'ART SUPER', 'AMP SUPER', 'REST SUPER'],
    noneOf: ['SUPERMARKET', 'SUPER RETAIL', 'SUPER CHEAP', 'SUPERCHEAP', 'SUPER AMART', 'SUPERIOR', 'REFUND'],
    category: 'retirement_contribution', subcategory: 'superannuation_contribution', priority: 300,
    why: 'a payment to a superannuation fund',
  },

  // ---- Brokers and investment platforms (funding the account is a purchase of investments, never household spending) -------------------------
  {
    key: 'au_broker_funding', region: 'AU', direction: 'debit',
    anyOf: ['SUPERHERO', 'COMMSEC', 'COMMONWEALTH SECURITIES', 'SELFWEALTH', 'CMC MARKETS', 'NABTRADE', 'INTERACTIVE BROKERS', 'RAIZ', 'SPACESHIP', 'BETASHARES', 'VANGUARD', 'COINSPOT', 'SWYFTX', 'INDEPENDENT RESERVE', 'BINANCE', 'ETORO', 'COINJAR', 'COINBASE', 'KRAKEN', 'BTC MARKETS'],
    noneOf: ['REFUND'], category: 'investment_purchase', subcategory: 'other_investment_purchase', priority: 300, allowOnPersonToPerson: true,
    why: 'a payment to an investment platform or broker',
  },
  {
    key: 'au_broker_withdrawal', region: 'AU', direction: 'credit',
    anyOf: ['SUPERHERO', 'COMMSEC', 'COMMONWEALTH SECURITIES', 'SELFWEALTH', 'CMC MARKETS', 'NABTRADE', 'INTERACTIVE BROKERS', 'RAIZ', 'SPACESHIP', 'BETASHARES', 'VANGUARD', 'COINSPOT', 'SWYFTX', 'INDEPENDENT RESERVE', 'BINANCE', 'ETORO', 'COINJAR', 'COINBASE', 'KRAKEN', 'BTC MARKETS'],
    noneOf: ['REFUND', 'DIVIDEND', 'DISTRIBUTION'], category: 'investment_sale', subcategory: 'other_investment_sale', priority: 300, allowOnPersonToPerson: true,
    why: 'money returned from an investment platform or broker',
  },

  // ---- Government and tax ---------------------------------------------------------------------------------------------------------------
  {
    key: 'au_tax_refund_credit', region: 'AU', direction: 'credit', anyOf: ['ATO', 'AUSTRALIAN TAXATION OFFICE', 'TAX OFFICE'], andAnyOf: ['REFUND', 'TAX REFUND'],
    category: 'refund_reversal', subcategory: 'tax_refund', priority: 290, why: 'a tax refund from the tax office',
  },
  {
    key: 'au_tax_payment', region: 'AU', direction: 'debit', anyOf: ['ATO', 'AUSTRALIAN TAXATION OFFICE', 'TAXATION OFFICE', 'ATO PAYMENT'],
    noneOf: [...REFUND_WORDS, 'ATO CHEMIST'], category: 'government_tax', subcategory: 'income_tax_payment', priority: 300,
    why: 'a payment to the tax office',
  },
  {
    key: 'au_government_benefit', region: 'AU', direction: 'credit', anyOf: ['CENTRELINK', 'SERVICES AUSTRALIA', 'FAMILY TAX BENEFIT', 'JOBSEEKER', 'AGE PENSION', 'DSP PAYMENT', 'PARENTING PAYMENT', 'CHILD CARE SUBSIDY'],
    noneOf: ['REPAYMENT', 'DEBT RECOVERY'], category: 'income', subcategory: 'government_benefit', priority: 300,
    why: 'a payment from a government benefit agency',
  },
  {
    key: 'au_fines', region: 'AU', direction: 'debit', anyOf: ['INFRINGEMENT', 'PENALTY NOTICE', 'FINES VICTORIA', 'REVENUE NSW', 'PARKING FINE', 'TRAFFIC FINE'],
    noneOf: ['REFUND'], category: 'government_tax', subcategory: 'fines_penalties', priority: 300, why: 'wording that names a fine or penalty notice',
  },

  // ---- Bank fees ------------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_bank_fees', region: 'AU', direction: 'debit',
    anyOf: ['INT TRAN FEE', 'INTL TRAN FEE', 'INTERNATIONAL TRANSACTION FEE', 'OVERSEAS TRANSACTION FEE', 'MONTHLY ACCOUNT FEE', 'ACCOUNT KEEPING FEE', 'ACCOUNT SERVICE FEE', 'CASH ADVANCE FEE', 'MONTHLY FEE', 'PACKAGE FEE'],
    noneOf: [...REFUND_WORDS], category: 'financial_fees', subcategory: 'other_fee', priority: 300, why: 'wording that names a bank or card fee',
  },

  // ---- Cash ----------------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_cash_out', region: 'AU', direction: 'debit', anyOf: ['ATM', 'NABATM', 'ATM CSH', 'CASH OUT', 'CASHOUT'],
    noneOf: ['FEE', 'SURCHARGE', 'DEPOSIT', 'REFUND', 'BPAY', 'STATION', 'MATMAN'], category: 'cash_withdrawal', subcategory: 'atm_cash_withdrawal', priority: 340,
    why: 'a cash withdrawal',
  },

  // ---- Utilities and phone/internet billers (BPAY or direct debit or card) ---------------------------------------------------------------
  {
    key: 'au_electricity_gas_retailers', region: 'AU', direction: 'debit',
    anyOf: ['ALINTA ENERGY', 'RED ENERGY', 'SIMPLY ENERGY', 'POWERSHOP', 'LUMO ENERGY', 'MOMENTUM ENERGY', '1ST ENERGY', 'GLOBIRD', 'DODO ENERGY', 'PEOPLE ENERGY', 'ELECTRICITY', 'ORIGIN ENERGY', 'AGL ENERGY'],
    noneOf: [...REFUND_WORDS], category: 'utilities', subcategory: 'electricity', priority: 300, why: 'an electricity or gas retailer',
  },
  {
    key: 'au_water_authorities', region: 'AU', direction: 'debit',
    anyOf: ['YARRA VALLEY WATER', 'CITY WEST WATER', 'SOUTH EAST WATER', 'SYDNEY WATER', 'HUNTER WATER', 'WATER CORPORATION', 'SA WATER', 'ICON WATER', 'TASWATER', 'UNITYWATER', 'URBAN UTILITIES', 'BARWON WATER', 'WESTERN WATER', 'GOULBURN VALLEY WATER'],
    noneOf: [...REFUND_WORDS], category: 'utilities', subcategory: 'water', priority: 300, why: 'a water authority',
  },
  {
    key: 'au_telco_billers', region: 'AU', direction: 'debit',
    anyOf: ['LYCAMOBILE', 'AMAYSIM', 'BOOST MOBILE', 'AUSSIE BROADBAND', 'BELONG', 'IINET', 'EXETEL', 'LEBARA', 'VIRGIN MOBILE', 'SUPERLOOP', 'OPTUS', 'TELSTRA', 'VODAFONE', 'TPG', 'DODO', 'MATE COMMUNICATIONS', 'ISEEK', 'SPINTEL', 'KOGAN MOBILE', 'FELIX MOBILE', 'ALDI MOBILE', 'MOOSE MOBILE'],
    noneOf: [...REFUND_WORDS], category: 'utilities', subcategory: 'mobile_phone', priority: 305, why: 'a phone or internet provider',
  },
  {
    key: 'au_council_rates', region: 'AU', direction: 'debit', anyOf: ['COUNCIL RATES', 'RATES NOTICE', 'COUNCIL RATE', 'LAND RATES', 'WATER RATES', 'CITY COUNCIL', 'SHIRE COUNCIL', 'COUNCIL'],
    andAnyOf: ['COUNCIL', 'COUNCIL RATES', 'RATES NOTICE', 'COUNCIL RATE', 'LAND RATES', 'WATER RATES'],
    noneOf: [...REFUND_WORDS, 'PARKING', 'FINE', 'INFRINGEMENT'], category: 'housing', subcategory: 'council_rates_property_tax', priority: 335, why: 'a local council (rates and charges)',
  },
  {
    key: 'au_strata', region: 'AU', direction: 'debit', anyOf: ['STRATA', 'BODY CORPORATE', 'OWNERS CORPORATION', 'OWNERS CORP'],
    noneOf: [...REFUND_WORDS], category: 'housing', subcategory: 'body_corporate_strata_maintenance', priority: 300, why: 'strata or body-corporate levies',
  },
  {
    key: 'au_rent_reference', region: 'AU', direction: 'debit', anyOf: ['RENT', 'RENT PAYMENT', 'RENTAL PAYMENT', 'RENTAL'],
    noneOf: ['CAR RENT', 'CAR HIRE', 'RENTAL CAR', 'CAR RENTAL', 'VEHICLE', 'EQUIPMENT', 'TRUCK', 'BIKE', 'TOOL', 'HIRE', 'RENT A', 'RENTAL INCOME', 'REFUND', 'BOND'], category: 'housing', subcategory: 'rent', priority: 345, allowOnPersonToPerson: true,
    why: 'wording that names rent',
  },
  {
    key: 'au_hardware', region: 'AU', direction: 'debit', anyOf: ['HARDWARE', 'BUNNINGS', 'MITRE 10', 'MITRE10', 'TOTAL TOOLS', 'HOME TIMBER'],
    noneOf: [...REFUND_WORDS], category: 'housing', subcategory: 'home_maintenance_repairs', priority: 330, why: 'a hardware store',
  },

  // ---- Insurance -----------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_insurance', region: 'AU', direction: 'debit',
    anyOf: ['INSURANCE', 'ASSURANCE', 'HCF', 'HBF', 'YOUI', 'GIO', 'RACV', 'NRMA', 'AAMI', 'SUNCORP', 'ALLIANZ', 'BUPA', 'MEDIBANK', 'NIB', 'TAL LIFE', 'AIA AUSTRALIA', 'AUSTRALIAN UNITY'],
    noneOf: [...REFUND_WORDS, 'INSURANCE BROKER'], category: 'insurance', subcategory: 'other_insurance', priority: 335, why: 'an insurer or an insurance premium',
  },

  // ---- Transport -----------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_fuel_brands', region: 'AU', direction: 'debit', anyOf: ['BP', 'SHELL', 'OTR'],
    noneOf: [...REFUND_WORDS, 'BPAY', 'SHELL COMPANY', 'SHELL COVE'], category: 'transport', subcategory: 'fuel', priority: 300, why: 'a fuel retailer',
  },
  {
    key: 'au_fuel_words', region: 'AU', direction: 'debit', anyOf: ['PETROL', 'FUEL', 'SERVICE STATION', 'AMPOL', 'CALTEX', 'UNITED PETROLEUM', 'LIBERTY OIL', 'METRO PETROLEUM', 'PUMA ENERGY'],
    noneOf: [...REFUND_WORDS, 'BPAY'], category: 'transport', subcategory: 'fuel', priority: 300, why: 'a fuel retailer',
  },
  {
    key: 'au_fuel_at_a_supermarket_brand', region: 'AU', direction: 'debit', anyOf: ['COSTCO GAS', 'COSTCO FUEL', 'COSTCO PETROL'],
    noneOf: [...REFUND_WORDS], category: 'transport', subcategory: 'fuel', priority: 290, outranksMerchant: true, why: 'a fuel purchase at a wholesale club',
  },
  {
    key: 'au_public_transport_tolls', region: 'AU', direction: 'debit',
    anyOf: ['MYKI', 'OPAL', 'GO CARD', 'TRANSLINK', 'TRANSPORT NSW', 'METRO TRAINS', 'PUBLIC TRANSPORT VICTORIA', 'PTV', 'TRANSPORT FOR NSW', 'TRANSPERTH', 'LINKT', 'E-TOLL', 'ETOLL', 'CITYLINK', 'EASTLINK', 'TRANSURBAN'],
    noneOf: [...REFUND_WORDS], category: 'transport', subcategory: 'public_transport', priority: 300, why: 'public transport or toll road charges',
  },
  {
    key: 'au_parking', region: 'AU', direction: 'debit', anyOf: ['PARKING', 'CAR PARK', 'CARPARK', 'WILSON PARKING', 'SECURE PARKING'],
    noneOf: [...REFUND_WORDS, 'FINE', 'INFRINGEMENT'], category: 'transport', subcategory: 'parking_tolls', priority: 330, why: 'parking',
  },
  {
    key: 'au_vehicle_registration', region: 'AU', direction: 'debit', anyOf: ['VICROADS', 'SERVICE VICTORIA', 'REGISTRATION RENEWAL', 'VEHICLE REGISTRATION'],
    noneOf: [...REFUND_WORDS], category: 'transport', subcategory: 'vehicle_maintenance_registration', priority: 330, why: 'vehicle registration',
  },

  // ---- Health --------------------------------------------------------------------------------------------------------------------------
  {
    key: 'au_health', region: 'AU', direction: 'debit',
    anyOf: ['PHARMACY', 'CHEMIST', 'TERRY WHITE', 'AMCAL', 'DENTAL', 'DENTIST', 'MEDICAL CENTRE', 'MEDICAL CENTER', 'PATHOLOGY', 'RADIOLOGY', 'PHYSIO', 'PHYSIOTHERAPY', 'OPTOMETRIST', 'SPECSAVERS', 'OPSM', 'HEALTHSCOPE', 'SONIC HEALTHCARE'],
    noneOf: [...REFUND_WORDS], category: 'health', subcategory: 'pharmacy', priority: 335, why: 'a pharmacy or health provider',
  },

  // ---- Education and childcare ---------------------------------------------------------------------------------------------------------
  {
    key: 'au_education', region: 'AU', direction: 'debit',
    anyOf: ['SCHOOL FEES', 'SCHOOL FEE', 'TUITION', 'CHILDCARE', 'CHILD CARE', 'DAYCARE', 'OSHC', 'KINDERGARTEN', 'TAFE', 'HECS', 'KUMON', 'TUTORING'],
    noneOf: [...REFUND_WORDS], category: 'education', subcategory: 'school_fees', priority: 330, why: 'school, tuition or childcare fees',
  },

  // ---- Food and groceries --------------------------------------------------------------------------------------------------------------
  {
    key: 'au_groceries_words', region: 'AU', direction: 'debit', anyOf: ['SUPERMARKET', 'SUPERMARKETS', 'SUPER MARKET', 'GROCER', 'GREENGROCER', 'FRUIT AND VEG', 'FRUIT & VEG', 'FOODWORKS', 'HARRIS FARM', 'FRESH MARKET', 'FRUIT MARKET', 'BUTCHER', 'FOODLAND', 'FRESH FOOD', 'SEAFOOD', 'SEAFOODS', 'FISH MARKET', 'MEATS', 'POULTRY', 'PRODUCE', 'VEGIES', 'VEGGIES', 'VEGETABLES', 'GROWERS', 'HALAL'],
    noneOf: [...REFUND_WORDS], category: 'food', subcategory: 'groceries', priority: 335, why: 'a grocer or supermarket',
  },
  {
    key: 'au_eating_out_words', region: 'AU', direction: 'debit',
    anyOf: ['CAFE', 'RESTAURANT', 'TAKEAWAY', 'BAKERY', 'PIZZA', 'SUSHI', 'NOODLE', 'NOODLES', 'RAMEN', 'DUMPLING', 'BURGER', 'KEBAB', 'BIRYANI', 'BHAVAN', 'CURRY', 'DOSA', 'SPICES', 'BISTRO', 'EATERY', 'DINER', 'COFFEE', 'DONUT', 'BAR AND GRILL', 'CHICKEN', 'SWEETS', 'SPICE', 'OPORTO', 'RED ROOSTER', 'NANDOS', 'THAI', 'CHINESE', 'INDIAN', 'VIETNAMESE', 'KOREAN', 'JAPANESE', 'MEXICAN', 'ITALIAN', 'TURKISH', 'LEBANESE', 'SANDWICH', 'JUICE'],
    noneOf: [...REFUND_WORDS, 'CAFE SUPPLIES'], category: 'food', subcategory: 'restaurants', priority: 345, why: 'a cafe, restaurant or takeaway',
  },

  // ---- Shopping, lifestyle, charity, travel ----------------------------------------------------------------------------------------------
  {
    key: 'au_retail_brands', region: 'AU', direction: 'debit',
    anyOf: ['JB HI-FI', 'JB HIFI', 'HARVEY NORMAN', 'THE GOOD GUYS', 'BING LEE', 'IKEA', 'SPOTLIGHT', 'REBEL SPORT', 'KOGAN', 'ALIEXPRESS', 'TEMU', 'SHEIN', 'UNIQLO', 'COTTON ON', 'ANACONDA', 'DECATHLON'],
    noneOf: [...REFUND_WORDS], category: 'shopping', subcategory: 'other_shopping', priority: 335, why: 'a retail store',
  },
  {
    key: 'au_streaming_and_apps', region: 'AU', direction: 'debit',
    anyOf: ['FOXTEL', 'BINGE', 'PARAMOUNT', 'YOUTUBE', 'APPLE.COM/BILL', 'ICLOUD', 'AUDIBLE', 'NETFLIX', 'SPOTIFY', 'DISNEY PLUS', 'DISNEY+', 'KAYO'],
    noneOf: [...REFUND_WORDS], category: 'lifestyle', subcategory: 'entertainment_streaming_subscriptions', priority: 320, why: 'a streaming or app subscription',
  },
  {
    key: 'au_personal_care', region: 'AU', direction: 'debit', anyOf: ['HAIR SALON', 'HAIRDRESSER', 'BARBER', 'SALON', 'NAILS'],
    noneOf: [...REFUND_WORDS], category: 'lifestyle', subcategory: 'personal_care', priority: 335, why: 'a hairdresser or beauty salon',
  },
  {
    key: 'au_cinema_events', region: 'AU', direction: 'debit', anyOf: ['CINEMA', 'CINEMAS', 'HOYTS', 'EVENT CINEMAS', 'TICKETEK', 'TICKETMASTER'],
    noneOf: [...REFUND_WORDS], category: 'lifestyle', subcategory: 'hobbies_recreation', priority: 335, why: 'cinema or event tickets',
  },
  {
    key: 'au_gym', region: 'AU', direction: 'debit', anyOf: ['ANYTIME FITNESS', 'FITNESS', 'GYM', 'F45', 'PLUS FITNESS', 'GOODLIFE', 'SNAP FITNESS', 'CROSSFIT', 'YOGA', 'PILATES'],
    noneOf: [...REFUND_WORDS], category: 'lifestyle', subcategory: 'gym_fitness', priority: 335, why: 'a gym or fitness provider',
  },
  {
    key: 'au_charity', region: 'AU', direction: 'debit', anyOf: ['DONATION', 'RED CROSS', 'SALVATION ARMY', 'UNICEF', 'OXFAM', 'WORLD VISION', 'GIVIT', 'CANCER COUNCIL', 'SAVE THE CHILDREN', 'GREENPEACE', 'LIFELINE', 'BEYOND BLUE'],
    noneOf: [...REFUND_WORDS], category: 'charity', subcategory: 'charitable_donation', priority: 320, why: 'a charity or donation',
  },
  {
    key: 'au_travel', region: 'AU', direction: 'debit', anyOf: ['EXPEDIA', 'AGODA', 'TRIVAGO', 'HOSTEL', 'MOTEL', 'RESORT', 'EMIRATES', 'SINGAPORE AIRLINES', 'AIR INDIA', 'CATHAY PACIFIC', 'AIR NEW ZEALAND'],
    noneOf: [...REFUND_WORDS], category: 'travel', subcategory: 'other_travel', priority: 335, why: 'travel or accommodation',
  },

  // ---- India (shared engine; narrative keywords only, nothing that needs a bank-specific format) --------------------------------------------
  {
    key: 'in_electricity', region: 'IN', direction: 'debit', anyOf: ['ELECTRICITY BILL', 'BESCOM', 'MSEDCL', 'TATA POWER', 'ADANI ELECTRICITY', 'BSES', 'TNEB'],
    noneOf: [...REFUND_WORDS], category: 'utilities', subcategory: 'electricity', priority: 300, why: 'an electricity bill',
  },
  {
    key: 'in_mobile_internet', region: 'IN', direction: 'debit', anyOf: ['JIO', 'AIRTEL', 'BSNL', 'VODAFONE IDEA', 'RECHARGE', 'ACT FIBERNET'],
    noneOf: [...REFUND_WORDS], category: 'utilities', subcategory: 'mobile_phone', priority: 320, why: 'a phone or internet recharge',
  },
  {
    key: 'in_fuel', region: 'IN', direction: 'debit', anyOf: ['HPCL', 'BPCL', 'IOCL', 'INDIAN OIL', 'PETROL PUMP', 'HP PETROL', 'BHARAT PETROLEUM'],
    noneOf: [...REFUND_WORDS], category: 'transport', subcategory: 'fuel', priority: 300, why: 'a fuel retailer',
  },
  {
    key: 'in_life_insurance', region: 'IN', direction: 'debit', anyOf: ['LIC PREMIUM', 'LIC OF INDIA', 'HDFC LIFE', 'ICICI PRUDENTIAL LIFE', 'SBI LIFE', 'MAX LIFE'],
    noneOf: [...REFUND_WORDS], category: 'insurance', subcategory: 'life_insurance_premium', priority: 300, why: 'a life-insurance premium',
  },
];

// ---------------------------------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface BuiltinRuleInput {
  /** Upper-cased, whitespace-collapsed narrative (see `toMatchText`). */
  haystackUpper: string;
  creditDebit: 'credit' | 'debit';
  currency: string;
}

export interface BuiltinMatch {
  ruleKey: string;
  categoryId: string;
  subcategoryId: string | null;
  economicType: FdhEconomicTransactionType;
  priority: number;
  why: string;
  matchedPhrase: string;
  /** True for rules that are about the payer's own accounts; the engine adds no pending transfer link for these (see engine header). */
  isOwnTransfer: boolean;
  isCardRepayment: boolean;
  outranksMerchant: boolean;
}

function firstPhrase(hay: string, phrases: readonly string[] | undefined): string | null {
  if (!phrases) return null;
  for (const p of phrases) if (containsPhrase(hay, p)) return p;
  return null;
}

/** Structural own-account transfer evidence: returns the plain-words reason, or null. */
export function ownTransferEvidence(hay: string, identity: OwnIdentity): { why: string; phrase: string; kind?: 'transfer' | 'loan' } | null {
  const rail = ['OSKO', 'PAYID', 'TRANSFER', 'TFR', 'TRF', 'FAST PAYMENT', 'PAY ANYONE', 'RECEIVED FROM', 'LINKED ACC', 'LINKED ACCOUNT'].find((p) => containsPhrase(hay, p));
  if (!rail) return null;
  const masked = ownMaskedAccountKind(hay, identity);
  if (masked === 'loan') return { why: 'a payment into one of your own loan accounts', phrase: 'your loan account', kind: 'loan' };
  if (masked === 'share') return { why: 'a transfer between your own accounts', phrase: 'your account', kind: 'transfer' };
  if (hay.includes('LINKED ACC')) return { why: 'a transfer between linked accounts', phrase: 'LINKED ACC' };
  // "Transfer to SAV 12345678 ...", "Received from SAV 12345678 Transfer from ..." -- the bank's own savings sub-account, with a title that is
  // only the household's own names or initials. A title naming anyone else is left as a question.
  const sav = /\bSAV(?:INGS)? (\d{4,})\b(.*)$/.exec(hay);
  if (sav && /\b(TRANSFER|TFR|TRF|RECEIVED FROM)\b/.test(hay)) {
    const title = sav[2].replace(/\b(TO|FROM|TRANSFER|TFR|TRF|RECEIVED|SAV|SAVINGS)\b/g, ' ');
    if (onlyOwnNameWords(title, identity)) return { why: 'a transfer to or from a savings account in your own name', phrase: 'SAV <account>' };
    return null;
  }
  const person = matchOwnPerson(hay, identity);
  if (person === 'self') return { why: 'a payment that names you, so it looks like a move between your own accounts', phrase: 'your name' };
  if (person === 'household') return { why: 'a payment that names a member of your household', phrase: 'household member' };
  if (mentionsOwnAccount(hay, identity)) return { why: 'a transfer that names one of your own accounts', phrase: 'your account number' };
  return null;
}

/**
 * Evaluates the built-in rules for one narrative. Returns the single best match, or null when nothing matched OR two rules of the same
 * priority disagree (conflict -> ask the person).
 */
export function matchBuiltinRule(
  input: BuiltinRuleInput,
  categories: readonly FdhCategory[],
  subcategories: readonly FdhSubcategory[],
  identity: OwnIdentity,
): BuiltinMatch | null {
  const hay = input.haystackUpper;
  if (hay.length === 0) return null;
  const catByKey = new Map(categories.filter((c) => c.active).map((c) => [c.category_key, c] as const));
  const subKey = (categoryId: string, key: string | undefined) => (key ? subcategories.find((s) => s.category_id === categoryId && s.subcategory_key === key && s.active)?.id ?? null : null);
  const region: 'AU' | 'IN' = input.currency === 'INR' ? 'IN' : 'AU';

  const matches: BuiltinMatch[] = [];

  // Structural: transfers between the person's own accounts.
  const own = ownTransferEvidence(hay, identity);
  const transferCat = catByKey.get(own?.kind === 'loan' ? 'loan_principal' : 'transfer_own_account');
  if (own && transferCat) {
    matches.push({
      ruleKey: 'own_account_transfer', categoryId: transferCat.id, subcategoryId: subKey(transferCat.id, own.kind === 'loan' ? 'other_loan_principal' : 'internal_transfer'), economicType: transferCat.economic_type,
      priority: 250, why: own.why, matchedPhrase: own.phrase, isOwnTransfer: own.kind !== 'loan', isCardRepayment: false, outranksMerchant: false,
    });
  }

  const purchase = isCardPurchaseShape(hay);
  const p2p = isPersonToPersonRail(hay);
  for (const rule of BUILTIN_RULES) {
    if (rule.region !== region) continue;
    if (rule.direction && rule.direction !== input.creditDebit) continue;
    // A payee name or a typed reference on a person-to-person line never decides a category (only the rent reference, which the payer types on
    // purpose, may).
    if (p2p && !rule.allowOnPersonToPerson) continue;
    const phrase = firstPhrase(hay, rule.anyOf);
    if (!phrase) continue;
    if (rule.andAnyOf && !firstPhrase(hay, rule.andAnyOf)) continue;
    if (firstPhrase(hay, rule.noneOf)) continue;
    // Fuel brand words are only a fuel purchase when the narrative is a card/EFTPOS purchase.
    if (rule.key === 'au_fuel_brands' && !purchase) continue;
    const cat = catByKey.get(rule.category);
    if (!cat) continue;
    matches.push({
      ruleKey: rule.key, categoryId: cat.id, subcategoryId: subKey(cat.id, rule.subcategory), economicType: cat.economic_type, priority: rule.priority,
      why: rule.why, matchedPhrase: phrase, isOwnTransfer: false, isCardRepayment: rule.category === 'credit_card_payment', outranksMerchant: rule.outranksMerchant === true,
    });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.priority - b.priority);
  const top = matches.filter((m) => m.priority === matches[0].priority);
  const distinct = new Set(top.map((m) => `${m.categoryId}|${m.subcategoryId ?? ''}`));
  if (distinct.size > 1) return null;
  return top[0];
}
