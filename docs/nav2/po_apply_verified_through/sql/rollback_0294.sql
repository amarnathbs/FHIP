-- ROLLBACK of 0294. Run ONLY the steps in the README section 6, in that order. This file is step 2 of 2.
-- Step 1 (README): run docs/nav2/po_apply_production/sql/parts/0260d.sql again, it puts commit_risk_free_upload back exactly as it was before 0294.
-- Step 2 (this file): remove the two new functions. No table, row or column is touched. A state log row written by a confirmation stays, it is permanent by design.
drop function if exists public.confirm_risk_free_verified_through(text, date, text);
drop function if exists public.risk_free_today();
