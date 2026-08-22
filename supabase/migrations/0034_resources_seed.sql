-- =============================================================================
-- Resources — R1.1 minimal seed data
-- =============================================================================
-- Per spec §65: only foundation data required for safe development/testing.
-- Explicitly NOT the 218-record R0-A import (that is R1.7).

insert into resource_settings (key, value, description) values
  ('youtube_channel_handle', '"@GKTC"'::jsonb, 'Default @GKTC YouTube channel handle for Resource Videos'),
  ('youtube_channel_url', '"https://www.youtube.com/@GKTC"'::jsonb, 'Default @GKTC YouTube channel URL'),
  ('default_review_cycle_days', '365'::jsonb, 'Default number of days before a published post''s next_review_at falls due'),
  ('default_disclaimer', '"This content is general financial education, not personal financial advice. It does not take into account your individual objectives, financial situation or needs."'::jsonb, 'Default disclaimer text for GREEN/AMBER content')
on conflict (key) do nothing;

-- Initial foundational taxonomy seed (reconciled during the R1.1 closure
-- pass: these are genuine top-level categories drawn directly from spec
-- §24's own eventual-taxonomy list, not throwaway test fixtures — they are
-- real, intended top-level Resources categories, just a small foundational
-- subset rather than the full ~14-category set. R1.7's full R0-A import
-- will add the remaining categories and the 218 content records; it is not
-- expected to need to remove or rename any of the five seeded here.
insert into resource_categories (name, slug, description, sort_order) values
  ('Financial Health', 'financial-health', 'Understanding and improving your overall financial health', 1),
  ('Managing Money', 'managing-money', 'Budgeting, cash flow, and day-to-day money management', 2),
  ('Emergency & Resilience', 'emergency-resilience', 'Building a safety net and preparing for shocks', 3),
  ('Investing', 'investing', 'Growing wealth through investment', 4),
  ('FHIP Explained', 'fhip-explained', 'How FHIP''s scores, forecasts, and features work', 5)
on conflict (slug) do nothing;
