-- 0316 -- Reimbursement and Pets types. Paste this WHOLE file into a new empty SQL tab and run it once. DEV first, then production.
-- Safe to run twice: it adds two rows and skips any that already exist. It changes nothing else.

insert into fdh_subcategories (category_id, subcategory_key, display_name, description, country_applicability, essential_discretionary, fixed_variable, fhip_mapping_key, display_order, source_key) values
  ((select id from fdh_categories where category_key = 'refund_reversal'), $lit$reimbursement$lit$, $lit$Reimbursement (expenses paid back to you)$lit$, $lit$Money paid back to you for something you paid for, such as a work expense or a shared cost. It is not income.$lit$, array['AU','IN']::char(2)[], null, null, $lit$refund_reversal.reimbursement$lit$, 35, $lit$fhip_taxonomy_design$lit$),
  ((select id from fdh_categories where category_key = 'lifestyle'), $lit$pets$lit$, $lit$Pets$lit$, null, array['AU','IN']::char(2)[], null, null, $lit$lifestyle.pets$lit$, 55, $lit$fhip_taxonomy_design$lit$)
on conflict (category_id, subcategory_key) do nothing;
