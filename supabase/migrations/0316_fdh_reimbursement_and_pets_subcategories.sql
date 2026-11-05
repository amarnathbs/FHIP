-- 0316 -- Two missing subcategories: Reimbursement (under Refund / Reversal) and Pets (under Lifestyle). PO request, 05-11-2026.
--
-- The review screen now lets a person pick a type under the category, for example Income then Salary & Wages. Two types people look for were missing.
--   * Reimbursement: money paid back to you for something you paid for. Filed under Refund / Reversal, NOT under Income. It is not earnings,
--     and counting it as income would overstate income and savings.
--   * Pets: a lifestyle cost with no type of its own.
--
-- ADDITIVE AND SAFE TO REPEAT. One insert with on conflict do nothing, the same idiom and columns as the 0053 seed. No existing row is changed
-- or deleted, and no existing transaction is touched. Mirrors data/financial-data-hub/subcategories.mjs and a unit test keeps the two in step.

insert into fdh_subcategories (category_id, subcategory_key, display_name, description, country_applicability, essential_discretionary, fixed_variable, fhip_mapping_key, display_order, source_key) values
  ((select id from fdh_categories where category_key = 'refund_reversal'), $lit$reimbursement$lit$, $lit$Reimbursement (expenses paid back to you)$lit$, $lit$Money paid back to you for something you paid for, such as a work expense or a shared cost. It is not income.$lit$, array['AU','IN']::char(2)[], null, null, $lit$refund_reversal.reimbursement$lit$, 35, $lit$fhip_taxonomy_design$lit$),
  ((select id from fdh_categories where category_key = 'lifestyle'), $lit$pets$lit$, $lit$Pets$lit$, null, array['AU','IN']::char(2)[], null, null, $lit$lifestyle.pets$lit$, 55, $lit$fhip_taxonomy_design$lit$)
on conflict (category_id, subcategory_key) do nothing;
