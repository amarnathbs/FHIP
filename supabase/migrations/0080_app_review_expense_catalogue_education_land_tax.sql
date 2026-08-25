-- App Review spec §8 (Expense Catalogue): Education and Land Tax were
-- reported missing from the Expenses catalogue. Confirmed by reading
-- supabase/seed_master_items.sql's full 'expense' category list (68 items,
-- lines 35-102) — school_fees/childcare/books/uniforms/tutoring exist
-- (school-age education costs) but there is no broader "Education" item for
-- adult/tertiary education (TAFE, university, professional courses), and
-- "Land Tax" does not exist at all (council_rates and water_rates do, but
-- land tax is a distinct state-government charge on investment/second
-- properties, not covered by either).
--
-- Additive only — no existing item_key is renamed, removed, or renumbered
-- (spec §1/§8: "retain all current valid items", "never delete a category
-- referenced by existing production rows"). `on conflict do nothing` makes
-- this safely re-runnable and a no-op if these keys somehow already exist.
--
-- sort_order placement: 'land_tax' at 45, between council_rates (40) and
-- water_rates (50) — same government-charge bracket. 'education' at 265,
-- between tutoring (260) and health_insurance (270) — broader catch-all
-- alongside the other education-adjacent items, not reordering any of them.
insert into master_financial_items (category, item_key, item_label, sort_order)
values
  ('expense', 'land_tax', 'Land Tax', 45),
  ('expense', 'education', 'Education (Tertiary / Professional / Courses)', 265)
on conflict (category, item_key) do nothing;
