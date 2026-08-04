-- The Forecasting 50-case test package's cross-border scenario (TC081) holds
-- a genuine USD-denominated investment and an overseas-education goal, but
-- `currencies` (0001_foundation.sql) only ever seeded AUD/INR — the two
-- countries this platform operates in. Any row referencing currency_code
-- 'USD' (investments.currency_code, user_goals.currency_code, etc.) fails
-- their FK constraint, which blocked seeding TC081 entirely. USD holdings
-- are tracked at face value (no FX conversion) since the cross-border
-- forecast engine's FX assumptions only cover the AUD<->INR pair — this is
-- the same "simplification, not a defect" scope already established for
-- this engine, not a new feature.
insert into currencies (currency_code, currency_name, currency_symbol, country_code) values
  ('USD', 'US Dollar', '$', null)
on conflict do nothing;
