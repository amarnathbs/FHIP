-- Forecasting Engine P1 fix FHIP-FC-RET-001 — retirement timing hierarchy.
-- Today the retirement forecast has exactly one path (DOB + retirement_age);
-- if date_of_birth isn't on file it gives up entirely. These two nullable
-- columns add the remaining tiers: retirement_date (an explicit target date,
-- when known — takes priority over the age-based calculation) and
-- retirement_timing_override_months (a manual "months until retirement"
-- fallback, usable when no DOB is on file at all — collapses what the
-- source review called two separate tiers, "current age + retirement age
-- for migrated records" and "user-entered years remaining", into one stored
-- value, since both are just different ways of arriving at the same
-- months-until-retirement number and this app has no legacy-migration
-- concept to distinguish them).
alter table forecast_profiles
  add column retirement_date date,
  add column retirement_timing_override_months int check (retirement_timing_override_months >= 0);
