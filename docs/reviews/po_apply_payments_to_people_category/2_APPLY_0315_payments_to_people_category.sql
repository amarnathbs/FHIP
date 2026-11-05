-- 0315 -- Payments to People category. Paste this WHOLE file into a new empty SQL tab and run it once. DEV first, then production.
-- Safe to run twice: it adds one row and skips it if it already exists. It changes nothing else.

insert into fdh_categories (category_key, display_name, description, economic_type, country_applicability, essential_discretionary, fixed_variable, tax_reporting_flag, retirement_relevance, investment_relevance, debt_relevance, fhip_mapping_key, display_order, icon_key, source_key) values
  ($lit$payments_to_people$lit$, $lit$Payments to People (family, friends, others)$lit$, $lit$Money you paid to a person (not a shop or a business) where the reason is not one of the other categories: help for family or friends, shared costs, personal payments. It counts as spending. Money you lent and expect back belongs under Loan Given, and moves between your own accounts belong under Own-Account Transfer.$lit$, $lit$expense$lit$, array['AU','IN']::char(2)[], $lit$mixed$lit$, $lit$variable$lit$, false, false, false, false, $lit$expense.payments_to_people$lit$, 155, $lit$send$lit$, $lit$fhip_taxonomy_design$lit$)
on conflict (category_key) do nothing;
