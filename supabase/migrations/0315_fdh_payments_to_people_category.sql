-- 0315 -- A "Payments to People" category, so a payment to a person (not a shop) can be filed without guessing a purpose (PO request, 02-11-2026).
--
-- Person-to-person payments such as an Osko payment to a named individual had no category that fits: they stayed "needs your choice" line by
-- line. This is a SPENDING category (economic type 'expense', "mixed" essential/discretionary) because the reason is usually unknown and money
-- paid to someone else is not a move between your own accounts. Money you lent and expect back is "Loan Given" (0314), a transfer.
--
-- ADDITIVE AND SAFE TO REPEAT. One INSERT ... ON CONFLICT DO NOTHING, the same idiom and the same columns as the 0053 and 0314 seeds. No existing
-- row is changed or deleted, and no existing transaction is touched: a line only moves to this category when you choose it.
-- Mirrors data/financial-data-hub/categories.mjs (category_key 'payments_to_people'); a unit test keeps the two in step.

insert into fdh_categories (category_key, display_name, description, economic_type, country_applicability, essential_discretionary, fixed_variable, tax_reporting_flag, retirement_relevance, investment_relevance, debt_relevance, fhip_mapping_key, display_order, icon_key, source_key) values
  ($lit$payments_to_people$lit$, $lit$Payments to People (family, friends, others)$lit$, $lit$Money you paid to a person (not a shop or a business) where the reason is not one of the other categories: help for family or friends, shared costs, personal payments. It counts as spending. Money you lent and expect back belongs under Loan Given, and moves between your own accounts belong under Own-Account Transfer.$lit$, $lit$expense$lit$, array['AU','IN']::char(2)[], $lit$mixed$lit$, $lit$variable$lit$, false, false, false, false, $lit$expense.payments_to_people$lit$, 155, $lit$send$lit$, $lit$fhip_taxonomy_design$lit$)
on conflict (category_key) do nothing;
