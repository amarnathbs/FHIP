-- Phase 6 — Cross-Border Forecasting (spec section 12). Seeds the FX
-- assumptions the cross-border calculator needs. Convention (must match
-- lib/engines/forecast/crossBorderCalculator.ts and be displayed to the
-- user per spec 12.4's "the exact convention must be stored and displayed
-- to prevent calculation errors"):
--   fx_rate_aud_inr = number of INR per 1 AUD.
--   AUD value = INR value / fx_rate_aud_inr
--   INR value = AUD value * fx_rate_aud_inr
-- fx_drift_aud_inr is the assumed annual % change in that rate going
-- forward (positive = INR weakens further against AUD, i.e. more INR per
-- AUD over time). Default 0 = spec 12.6's "Constant exchange rate"
-- scenario; users can override it via the Assumptions page like any other
-- assumption to model appreciation/depreciation scenarios.
insert into forecast_global_assumptions (country_code, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference) values
  (null, 'fx', 'fx_rate_aud_inr', 56.0, 'ratio', 'INR_per_AUD', 'Indicative starting rate, editable — not a live market feed'),
  (null, 'fx', 'fx_drift_aud_inr', 0.0, 'percentage', 'per_annum', 'Constant-rate scenario by default (spec 12.6); user-adjustable for appreciation/depreciation scenarios')
on conflict (country_code, assumption_key) do nothing;
