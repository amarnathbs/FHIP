-- App Review tier-2 fix pass (2026-08-28 branch reconciliation), Fix 1 —
-- Profile Page. Adds the one column user_profiles was genuinely missing for
-- the new Profile page's "Contact number" field. Name/DOB/country/currency/
-- employment_status all already exist (0001_foundation.sql); Email is
-- intentionally NOT duplicated here — it lives solely in auth.users and is
-- displayed/changed via Supabase Auth's own updateUser({ email }) flow,
-- never mirrored into this table, to avoid a second, driftable copy of a
-- security-sensitive field.
--
-- Ported from supabase/migrations/0079_app_review_profile_phone.sql on
-- feature/app-review-remainder-input-ux-currency-onboarding (unmerged
-- sibling branch) — re-emitted here under a fresh, collision-checked
-- number (0079-0081 are already claimed elsewhere in that branch's own
-- lineage and are not free on canonical main; verified via
-- scripts/check-migration-versions.mjs and
-- scripts/check-migration-versions-against-branch.mjs against a freshly
-- fetched origin/main before allocating 0099).
alter table user_profiles
  add column if not exists phone text;
