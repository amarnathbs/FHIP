-- 0314 -- Loan Given category. Paste this WHOLE file into a new empty SQL tab and run it once. DEV first, then production.
-- Safe to run twice: it adds one row and skips it if it already exists. It changes nothing else.

insert into fdh_categories (category_key, display_name, description, economic_type, country_applicability, essential_discretionary, fixed_variable, tax_reporting_flag, retirement_relevance, investment_relevance, debt_relevance, fhip_mapping_key, display_order, icon_key, source_key) values
  ($lit$loan_given$lit$, $lit$Loan Given (money lent to someone)$lit$, $lit$Money you lent to a person or business and expect to get back. It leaves your account but is not spending, so it never counts as an expense or as income; the repayment you later receive is the other side of it.$lit$, $lit$transfer$lit$, array['AU','IN']::char(2)[], $lit$not_applicable$lit$, $lit$not_applicable$lit$, false, false, false, false, $lit$transfer.loan_given$lit$, 225, $lit$hand-coins$lit$, $lit$fhip_taxonomy_design$lit$)
on conflict (category_key) do nothing;
