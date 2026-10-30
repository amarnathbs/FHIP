-- 0314 -- A "Loan Given" category, so money lent to someone can be filed where it belongs (PO request, 2026-10-31).
--
-- Until now the category list had no place for money you lend: "Loan Principal Repayment" is for repaying a loan you owe, and
-- "Family & Dependants" is spending. A loan given leaves your account but is not spending, and it is not income when it comes back,
-- so it is an economic type 'transfer' (never counted as an expense or as income). Nothing else about the taxonomy changes.
--
-- ADDITIVE AND SAFE TO REPEAT. One INSERT ... ON CONFLICT DO NOTHING, the same idiom and the same columns as the 0053 seed. No existing
-- row is changed or deleted, and no existing transaction is touched: a line only moves to this category when you choose it.
-- Mirrors data/financial-data-hub/categories.mjs (category_key 'loan_given'); a unit test keeps the two in step.

insert into fdh_categories (category_key, display_name, description, economic_type, country_applicability, essential_discretionary, fixed_variable, tax_reporting_flag, retirement_relevance, investment_relevance, debt_relevance, fhip_mapping_key, display_order, icon_key, source_key) values
  ($lit$loan_given$lit$, $lit$Loan Given (money lent to someone)$lit$, $lit$Money you lent to a person or business and expect to get back. It leaves your account but is not spending, so it never counts as an expense or as income; the repayment you later receive is the other side of it.$lit$, $lit$transfer$lit$, array['AU','IN']::char(2)[], $lit$not_applicable$lit$, $lit$not_applicable$lit$, false, false, false, false, $lit$transfer.loan_given$lit$, 225, $lit$hand-coins$lit$, $lit$fhip_taxonomy_design$lit$)
on conflict (category_key) do nothing;
