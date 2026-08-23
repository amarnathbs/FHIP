// FDH-2 — subcategory master, one array per parent category_key. A null
// `essential_discretionary` or `fixed_variable` means "inherit the parent
// category's value" — only genuinely different subcategories carry an
// explicit override (e.g. food.groceries=essential vs food.restaurants=
// discretionary, both under a `mixed` parent).
const D = 'fhip_taxonomy_design';
const BOTH = ['AU', 'IN'];
const AU = ['AU'];
const IN = ['IN'];

function sub(category_key, subcategory_key, display_name, opts = {}) {
  return {
    category_key,
    subcategory_key,
    display_name,
    description: opts.description ?? null,
    country_applicability: opts.country_applicability ?? BOTH,
    essential_discretionary: opts.essential_discretionary ?? null,
    fixed_variable: opts.fixed_variable ?? null,
    fhip_mapping_key: opts.fhip_mapping_key ?? `${category_key}.${subcategory_key}`,
    display_order: opts.display_order ?? 0,
    source_key: D,
  };
}

export const subcategories = [
  // --- income (9) ---
  sub('income', 'salary_wages', 'Salary & Wages', { display_order: 10 }),
  sub('income', 'bonus_commission', 'Bonus & Commission', { display_order: 20 }),
  sub('income', 'self_employment_income', 'Self-Employment / Business Income', { display_order: 30 }),
  sub('income', 'rental_income', 'Rental Income', { display_order: 40 }),
  sub('income', 'interest_income', 'Interest Income', { display_order: 50 }),
  sub('income', 'dividend_income', 'Dividend Income', { display_order: 60 }),
  sub('income', 'government_benefit', 'Government Benefit', { display_order: 70 }),
  sub('income', 'pension_income', 'Pension Income', { display_order: 80 }),
  sub('income', 'other_income', 'Other Income', { display_order: 90 }),

  // --- housing (5) ---
  sub('housing', 'rent', 'Rent', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 10 }),
  sub('housing', 'council_rates_property_tax', 'Council Rates / Property Tax', { essential_discretionary: 'essential', fixed_variable: 'fixed', description: 'AU council rates; India municipal property tax.', display_order: 20 }),
  sub('housing', 'body_corporate_strata_maintenance', 'Body Corporate / Strata / Society Maintenance', { essential_discretionary: 'essential', fixed_variable: 'fixed', description: 'AU body corporate/strata fees; India housing-society maintenance charges.', display_order: 30 }),
  sub('housing', 'home_maintenance_repairs', 'Home Maintenance & Repairs', { essential_discretionary: 'mixed', fixed_variable: 'variable', display_order: 40 }),
  sub('housing', 'other_housing', 'Other Housing', { display_order: 50 }),

  // --- utilities (8) ---
  sub('utilities', 'electricity', 'Electricity', { essential_discretionary: 'essential', display_order: 10 }),
  sub('utilities', 'gas', 'Gas', { essential_discretionary: 'essential', display_order: 20 }),
  sub('utilities', 'water', 'Water', { essential_discretionary: 'essential', display_order: 30 }),
  sub('utilities', 'internet_broadband', 'Internet / Broadband', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 40 }),
  sub('utilities', 'mobile_phone', 'Mobile Phone', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 50 }),
  sub('utilities', 'home_phone_landline', 'Home Phone / Landline', { essential_discretionary: 'discretionary', fixed_variable: 'fixed', display_order: 60 }),
  sub('utilities', 'waste_council_services', 'Waste & Council Services', { essential_discretionary: 'essential', display_order: 70 }),
  sub('utilities', 'other_utilities', 'Other Utilities', { display_order: 80 }),

  // --- food (6) ---
  sub('food', 'groceries', 'Groceries', { essential_discretionary: 'essential', display_order: 10 }),
  sub('food', 'restaurants', 'Restaurants', { essential_discretionary: 'discretionary', display_order: 20 }),
  sub('food', 'cafes_coffee', 'Cafes & Coffee', { essential_discretionary: 'discretionary', display_order: 30 }),
  sub('food', 'takeaway_food_delivery', 'Takeaway & Food Delivery', { essential_discretionary: 'discretionary', display_order: 40 }),
  sub('food', 'alcohol_liquor', 'Alcohol / Liquor', { essential_discretionary: 'discretionary', display_order: 50 }),
  sub('food', 'other_food', 'Other Food & Dining', { display_order: 60 }),

  // --- transport (7) ---
  sub('transport', 'fuel', 'Fuel', { essential_discretionary: 'essential', display_order: 10 }),
  sub('transport', 'public_transport', 'Public Transport', { essential_discretionary: 'essential', display_order: 20 }),
  sub('transport', 'rideshare_taxi', 'Rideshare & Taxi', { essential_discretionary: 'discretionary', display_order: 30 }),
  sub('transport', 'parking_tolls', 'Parking & Tolls', { essential_discretionary: 'mixed', display_order: 40 }),
  sub('transport', 'vehicle_maintenance_registration', 'Vehicle Maintenance & Registration', { essential_discretionary: 'essential', fixed_variable: 'variable', display_order: 50 }),
  sub('transport', 'vehicle_purchase_lease', 'Vehicle Purchase / Lease Payment', { essential_discretionary: 'mixed', fixed_variable: 'fixed', display_order: 60 }),
  sub('transport', 'other_transport', 'Other Transport', { display_order: 70 }),

  // --- health (6) ---
  sub('health', 'pharmacy', 'Pharmacy', { essential_discretionary: 'essential', display_order: 10 }),
  sub('health', 'doctor_specialist', 'Doctor / Specialist', { essential_discretionary: 'essential', display_order: 20 }),
  sub('health', 'dental', 'Dental', { essential_discretionary: 'essential', display_order: 30 }),
  sub('health', 'health_insurance_gap_excess', 'Health Insurance Gap / Excess Payment', { essential_discretionary: 'essential', description: 'Out-of-pocket gap/excess paid at point of care. The insurance PREMIUM itself is under Insurance > Health Insurance Premium.', display_order: 40 }),
  sub('health', 'allied_health', 'Allied Health', { essential_discretionary: 'mixed', description: 'Physiotherapy, psychology, optometry and similar.', display_order: 50 }),
  sub('health', 'other_health', 'Other Health', { display_order: 60 }),

  // --- education (6) ---
  sub('education', 'school_fees', 'School Fees', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 10 }),
  sub('education', 'tuition_university', 'Tuition / University', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 20 }),
  sub('education', 'childcare_daycare', 'Childcare / Daycare', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 30 }),
  sub('education', 'textbooks_supplies', 'Textbooks & Supplies', { essential_discretionary: 'essential', fixed_variable: 'variable', display_order: 40 }),
  sub('education', 'tutoring', 'Tutoring', { essential_discretionary: 'discretionary', fixed_variable: 'variable', display_order: 50 }),
  sub('education', 'other_education', 'Other Education', { display_order: 60 }),

  // --- lifestyle (6) ---
  sub('lifestyle', 'entertainment_streaming_subscriptions', 'Entertainment & Streaming Subscriptions', { essential_discretionary: 'discretionary', fixed_variable: 'fixed', display_order: 10 }),
  sub('lifestyle', 'gym_fitness', 'Gym & Fitness', { essential_discretionary: 'discretionary', fixed_variable: 'fixed', display_order: 20 }),
  sub('lifestyle', 'hobbies_recreation', 'Hobbies & Recreation', { display_order: 30 }),
  sub('lifestyle', 'personal_care', 'Personal Care', { display_order: 40 }),
  sub('lifestyle', 'gifts_general', 'Gifts (General)', { display_order: 50 }),
  sub('lifestyle', 'other_lifestyle', 'Other Lifestyle', { display_order: 60 }),

  // --- shopping (6) ---
  sub('shopping', 'clothing_footwear', 'Clothing & Footwear', { display_order: 10 }),
  sub('shopping', 'electronics_appliances', 'Electronics & Appliances', { display_order: 20 }),
  sub('shopping', 'home_furniture_homeware', 'Home, Furniture & Homeware', { display_order: 30 }),
  sub('shopping', 'online_marketplace_general', 'Online Marketplace (General)', { display_order: 40 }),
  sub('shopping', 'department_discount_retail', 'Department & Discount Retail', { display_order: 50 }),
  sub('shopping', 'other_shopping', 'Other Shopping', { display_order: 60 }),

  // --- travel (5) ---
  sub('travel', 'flights', 'Flights', { display_order: 10 }),
  sub('travel', 'accommodation', 'Accommodation', { display_order: 20 }),
  sub('travel', 'travel_packages_tours', 'Travel Packages & Tours', { display_order: 30 }),
  sub('travel', 'travel_insurance', 'Travel Insurance', { fixed_variable: 'fixed', display_order: 40 }),
  sub('travel', 'other_travel', 'Other Travel', { display_order: 50 }),

  // --- financial_fees (7) ---
  sub('financial_fees', 'bank_account_fee', 'Bank Account Fee', { display_order: 10 }),
  sub('financial_fees', 'card_annual_fee', 'Card Annual Fee', { fixed_variable: 'fixed', display_order: 20 }),
  sub('financial_fees', 'foreign_transaction_fee', 'Foreign Transaction Fee', { display_order: 30 }),
  sub('financial_fees', 'late_payment_fee', 'Late Payment Fee', { display_order: 40 }),
  sub('financial_fees', 'overdraft_fee', 'Overdraft Fee', { display_order: 50 }),
  sub('financial_fees', 'atm_fee', 'ATM Fee', { display_order: 60 }),
  sub('financial_fees', 'other_fee', 'Other Fee', { display_order: 70 }),

  // --- insurance (6) ---
  sub('insurance', 'health_insurance_premium', 'Health Insurance Premium', { fixed_variable: 'fixed', display_order: 10 }),
  sub('insurance', 'life_insurance_premium', 'Life Insurance Premium', { fixed_variable: 'fixed', display_order: 20 }),
  sub('insurance', 'home_contents_insurance_premium', 'Home & Contents Insurance Premium', { fixed_variable: 'fixed', display_order: 30 }),
  sub('insurance', 'vehicle_insurance_premium', 'Vehicle Insurance Premium', { fixed_variable: 'fixed', display_order: 40 }),
  sub('insurance', 'income_protection_insurance_premium', 'Income Protection Insurance Premium', { fixed_variable: 'fixed', display_order: 50 }),
  sub('insurance', 'other_insurance', 'Other Insurance', { display_order: 60 }),

  // --- government_tax (4) ---
  sub('government_tax', 'income_tax_payment', 'Income Tax Payment', { display_order: 10 }),
  sub('government_tax', 'gst_bas_payment', 'GST / BAS Payment', { description: 'AU: Business Activity Statement / GST remittance. India: GST payment.', display_order: 20 }),
  sub('government_tax', 'fines_penalties', 'Fines & Penalties', { display_order: 30 }),
  sub('government_tax', 'other_government_tax', 'Other Government / Tax', { display_order: 40 }),

  // --- family (4) ---
  sub('family', 'child_support', 'Child Support', { essential_discretionary: 'essential', fixed_variable: 'fixed', display_order: 10 }),
  sub('family', 'family_allowance_pocket_money', 'Family Allowance / Pocket Money', { essential_discretionary: 'discretionary', display_order: 20 }),
  sub('family', 'dependant_care', 'Dependant Care', { essential_discretionary: 'essential', display_order: 30 }),
  sub('family', 'other_family', 'Other Family', { display_order: 40 }),

  // --- charity (3) ---
  sub('charity', 'charitable_donation', 'Charitable Donation', { display_order: 10 }),
  sub('charity', 'religious_giving', 'Religious / Community Giving', { display_order: 20 }),
  sub('charity', 'other_charity', 'Other Charity', { display_order: 30 }),

  // --- transfer_own_account (3) ---
  sub('transfer_own_account', 'internal_transfer', 'Internal Transfer', { display_order: 10 }),
  sub('transfer_own_account', 'savings_transfer', 'Savings Transfer', { display_order: 20 }),
  sub('transfer_own_account', 'joint_account_transfer', 'Joint Account Transfer', { display_order: 30 }),

  // --- credit_card_payment (1) ---
  sub('credit_card_payment', 'credit_card_bill_payment', 'Credit Card Bill Payment', { display_order: 10 }),

  // --- loan_principal (4) ---
  sub('loan_principal', 'home_loan_principal', 'Home Loan Principal', { display_order: 10 }),
  sub('loan_principal', 'personal_loan_principal', 'Personal Loan Principal', { display_order: 20 }),
  sub('loan_principal', 'vehicle_loan_principal', 'Vehicle Loan Principal', { display_order: 30 }),
  sub('loan_principal', 'other_loan_principal', 'Other Loan Principal', { display_order: 40 }),

  // --- loan_interest (5) ---
  sub('loan_interest', 'home_loan_interest', 'Home Loan Interest', { display_order: 10 }),
  sub('loan_interest', 'personal_loan_interest', 'Personal Loan Interest', { display_order: 20 }),
  sub('loan_interest', 'vehicle_loan_interest', 'Vehicle Loan Interest', { display_order: 30 }),
  sub('loan_interest', 'credit_card_interest', 'Credit Card Interest', { display_order: 40 }),
  sub('loan_interest', 'other_loan_interest', 'Other Loan Interest', { display_order: 50 }),

  // --- investment_purchase (4) ---
  sub('investment_purchase', 'managed_fund_mutual_fund_purchase', 'Managed Fund / Mutual Fund Purchase', { display_order: 10 }),
  sub('investment_purchase', 'shares_equity_purchase', 'Shares / Equity Purchase', { display_order: 20 }),
  sub('investment_purchase', 'bond_fixed_income_purchase', 'Bond / Fixed Income Purchase', { display_order: 30 }),
  sub('investment_purchase', 'other_investment_purchase', 'Other Investment Purchase', { display_order: 40 }),

  // --- investment_sale (4) ---
  sub('investment_sale', 'managed_fund_mutual_fund_sale', 'Managed Fund / Mutual Fund Sale', { display_order: 10 }),
  sub('investment_sale', 'shares_equity_sale', 'Shares / Equity Sale', { display_order: 20 }),
  sub('investment_sale', 'bond_fixed_income_sale', 'Bond / Fixed Income Sale', { display_order: 30 }),
  sub('investment_sale', 'other_investment_sale', 'Other Investment Sale', { display_order: 40 }),

  // --- retirement_contribution (4) ---
  sub('retirement_contribution', 'superannuation_contribution', 'Superannuation Contribution', { country_applicability: AU, display_order: 10 }),
  sub('retirement_contribution', 'epf_contribution', 'EPF Contribution', { country_applicability: IN, display_order: 20 }),
  sub('retirement_contribution', 'nps_contribution', 'NPS Contribution', { country_applicability: IN, display_order: 30 }),
  sub('retirement_contribution', 'other_retirement_contribution', 'Other Retirement Contribution', { display_order: 40 }),

  // --- cash_withdrawal (3) ---
  sub('cash_withdrawal', 'atm_cash_withdrawal', 'ATM Cash Withdrawal', { display_order: 10 }),
  sub('cash_withdrawal', 'branch_cash_withdrawal', 'Branch Cash Withdrawal', { display_order: 20 }),
  sub('cash_withdrawal', 'other_cash_withdrawal', 'Other Cash Withdrawal', { display_order: 30 }),

  // --- refund_reversal (4) ---
  sub('refund_reversal', 'purchase_refund', 'Purchase Refund', { display_order: 10 }),
  sub('refund_reversal', 'transaction_reversal_chargeback', 'Transaction Reversal / Chargeback', { display_order: 20 }),
  sub('refund_reversal', 'tax_refund', 'Tax Refund', { display_order: 30 }),
  sub('refund_reversal', 'other_refund', 'Other Refund', { display_order: 40 }),

  // --- unknown (1) ---
  sub('unknown', 'unresolved', 'Unresolved', { display_order: 10 }),
];
