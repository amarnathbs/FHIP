-- App Review tier-2 fix pass (2026-08-28 branch reconciliation), Fix 2 —
-- India retirement catalogue (EPF/PPF/NPS). Confirmed genuinely absent from
-- main (`git grep -il "'epf'|'ppf'|'nps'"` returns nothing). The entire
-- Retirement catalogue today is AU-centric (industry_super/retail_super/
-- SMSF/defined_benefit/...); an India-resident user has nothing but
-- overseas_pension/other_retirement_assets/a custom row to represent an
-- EPF, PPF, or NPS account.
--
-- Ported from supabase/migrations/0072_india_retirement_catalogue.sql on
-- feature/app-review-input-integrity-production, re-emitted here under a
-- fresh, collision-checked number (that branch's own 0072 collides with
-- canonical main's real 0072_air_consolidation_schema_foundation.sql — a
-- completely different migration). The source migration also targeted a
-- since-superseded draft schema (columns like current_value_source,
-- requires_country, purpose_dimension, future_flow_source that never
-- actually landed on master_financial_items) — this version is rewritten
-- against master_financial_items' ACTUAL current schema: the base 4-column
-- insert convention used throughout supabase/seed_master_items.sql, plus
-- the real is_retirement_specific flag added by migration 0072
-- (air_consolidation_schema_foundation) and set for every other
-- superannuation/pension-type retirement item by migration 0074.
--
-- Pure addition — no existing retirement catalogue row is touched,
-- following seed_master_items.sql's own "only add/deprecate, never rename"
-- discipline. Reuses the existing retirement_accounts domain: EPF/PPF/NPS
-- are all balance-style accounts (current_value_source semantics — no
-- purchase-price/date concept, same as industry_super/retail_super), so
-- no product-specific tax/forecasting logic is introduced here, and none
-- of these three is force-fitted into the generic "Retirement Savings"
-- catch-all item, per this task's own explicit instruction.
--
-- NPS specifically has both an account balance and a contribution-tier
-- structure (Tier I/II, employer/employee/voluntary splits) richer than
-- EPF/PPF; this migration deliberately only adds the account-balance-level
-- catalogue entry (the account balance is what matters for Net Worth) and
-- does NOT attempt to model NPS's tier/contribution-type structure — a
-- disclosed gap for a future phase, not silently glossed over.
--
-- Country availability: left unrestricted (country_applicability NULL),
-- matching migration 0084's own deliberate precedent of leaving every
-- AU-flavoured retirement item unrestricted except SMSF (the one item with
-- concrete spec-mandated evidence of being jurisdiction-gated) "pending an
-- explicit product decision" rather than "claiming regulatory
-- classification where the catalogue doesn't provide enough evidence."
-- Country/currency selection for a saved row still goes through this
-- grid's normal country_code/currency_code fields, unaffected by this.
--
-- sort_order continues after the existing retirement category's highest
-- value (170) rather than being interleaved, so existing sort order for
-- every other retirement item is completely undisturbed.

insert into master_financial_items (category, item_key, item_label, sort_order)
values
  ('retirement', 'epf', 'EPF (Employees'' Provident Fund)', 180),
  ('retirement', 'ppf', 'PPF (Public Provident Fund)', 190),
  ('retirement', 'nps', 'NPS (National Pension System)', 200)
on conflict (category, item_key) do nothing;

update master_financial_items set is_retirement_specific = true
  where category = 'retirement' and item_key in ('epf', 'ppf', 'nps');
