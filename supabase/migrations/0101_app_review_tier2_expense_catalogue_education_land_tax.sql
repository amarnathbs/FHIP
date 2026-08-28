-- App Review tier-2 fix pass (2026-08-28 branch reconciliation), Fix 3 —
-- Expense catalogue: Education + Land Tax. Confirmed genuinely absent from
-- main's seed data (supabase/seed_master_items.sql has no land_tax and no
-- general/tertiary education item — only school-age items exist:
-- school_fees/childcare/books/uniforms/tutoring).
--
-- Ported from supabase/migrations/0080_app_review_expense_catalogue_
-- education_land_tax.sql on feature/app-review-remainder-input-ux-
-- currency-onboarding, re-emitted here under a fresh, collision-checked
-- number. That migration already used only master_financial_items' base
-- 4-column insert convention (category, item_key, item_label, sort_order —
-- same as every other row in supabase/seed_master_items.sql), which is
-- unchanged on current main, so no schema adaptation was needed beyond the
-- migration number.
--
-- Additive only — no existing item_key is renamed, removed, or renumbered.
-- `on conflict do nothing` makes this safely re-runnable and a no-op if
-- these keys somehow already exist.
--
-- sort_order placement: 'land_tax' at 45, between council_rates (40) and
-- water_rates (50) — same government-charge bracket. 'education' at 265,
-- between tutoring (260) and health_insurance (270) — broader catch-all
-- alongside the other education-adjacent items, not reordering any of them.
-- Both slots verified free against current main's full expense sort_order
-- list (10-680 in steps of 10).
insert into master_financial_items (category, item_key, item_label, sort_order)
values
  ('expense', 'land_tax', 'Land Tax', 45),
  ('expense', 'education', 'Education (Tertiary / Professional / Courses)', 265)
on conflict (category, item_key) do nothing;
