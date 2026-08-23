-- Chunk 3a item 6 (discovery §3.6 confirmed catalogue gap, Spec 2 §32):
-- India retirement account types. The entire Retirement catalogue today is
-- AU-centric (industry_super/retail_super/SMSF); an India-resident user has
-- nothing but overseas_pension/other_retirement_assets/a custom row to
-- represent an EPF, PPF, or NPS account. Pure addition — no existing
-- retirement catalogue row is touched, following seed_master_items.sql's
-- own "only add/deprecate, never rename" discipline (same pattern as
-- migration 0066's collectibles addition, migration 0011's twin-benchmark
-- inserts).
--
-- Structural classification (enough to not misclassify, per the task
-- brief — not a deep tax/regulatory research pass):
--  - EPF (Employees' Provident Fund): a balance-style mandatory retirement
--    account, employer+employee contributions accrue into one account
--    balance. current_value_source = 'balance', no purchase concept.
--  - PPF (Public Provident Fund): a balance-style voluntary long-term
--    savings account (15-year lock-in). Same profile as EPF for this
--    catalogue's purposes.
--  - NPS (National Pension System): has both an account balance AND a
--    contribution-tier structure (Tier I/II, employer/employee/voluntary
--    splits) — richer than EPF/PPF. This migration models it at the same
--    balance-style level as EPF/PPF for current_value_source (the account
--    balance is what matters for net worth), and does NOT attempt to model
--    NPS's tier/contribution-type structure — flagged in
--    docs/app-review-2026-08/CHUNK3A_CANONICAL_SCHEMA.md as a known gap for
--    a future phase, not silently glossed over.
--
-- sort_order continues after the existing retirement category's highest
-- value (170) rather than being interleaved, so existing sort order for
-- every other retirement item is completely undisturbed.

insert into master_financial_items (
  category, item_key, item_label, sort_order, is_active,
  current_value_source, supports_purchase_date, supports_purchase_price,
  requires_purchase_date, requires_purchase_price,
  requires_country, requires_currency, purpose_dimension, future_flow_source
) values
  ('retirement', 'epf', 'EPF (Employees'' Provident Fund)', 180, true,
   'balance', false, false, false, false, true, true, null, false),
  ('retirement', 'ppf', 'PPF (Public Provident Fund)', 190, true,
   'balance', false, false, false, false, true, true, null, false),
  ('retirement', 'nps', 'NPS (National Pension System)', 200, true,
   'balance', false, false, false, false, true, true, null, false)
on conflict (category, item_key) do nothing;
