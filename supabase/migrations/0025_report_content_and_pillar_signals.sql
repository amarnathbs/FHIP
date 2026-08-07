-- Free/Paid Report v3, Phase 3a — content-library foundation.
--
-- Part A: extend action_recommendation_master so the SAME library that
-- already drives the Forecasting Engine's recommendations (542 rows,
-- forecast-category/status triggered) can also be triggered by a Financial
-- Health Score pillar's band, for the Free/Paid report's action sections.
-- This is a deliberate extension of the existing table, not a second
-- parallel schema (per the user's confirmed shared-library decision) —
-- action_recommendation_conditions needs no change at all, since its
-- field_name column is already free-text (pillar_code/score_band are just
-- new condition field_name values an admin can use, exactly like
-- forecast_category/forecast_status are today).
alter table action_recommendation_master
  add column trigger_type text not null default 'forecast_variance'
    check (trigger_type in ('forecast_variance', 'score_pillar')),
  add column pillar_code text,
  add column score_band text;

-- forecast_category/forecast_status were NOT NULL because every existing
-- row is forecast-triggered — pillar-triggered rows have no natural
-- forecast_category, so both become nullable. All 542 existing rows are
-- unaffected (trigger_type defaults to 'forecast_variance' and both columns
-- stay populated for them).
alter table action_recommendation_master
  alter column forecast_category drop not null,
  alter column forecast_status drop not null;

alter table action_recommendation_master
  drop constraint if exists action_recommendation_master_forecast_category_check;
alter table action_recommendation_master
  add constraint action_recommendation_master_forecast_category_check
  check (forecast_category is null or forecast_category in (
    'net_worth', 'retirement', 'goal', 'debt', 'investment_growth', 'cross_border', 'resilience', 'data_quality'
  ));

alter table action_recommendation_master
  drop constraint if exists action_recommendation_master_forecast_status_check;
alter table action_recommendation_master
  add constraint action_recommendation_master_forecast_status_check
  check (forecast_status is null or forecast_status in (
    'ahead_of_plan', 'on_track', 'slightly_behind', 'at_risk', 'significantly_off_track', 'review_required'
  ));

-- Data-integrity guard: a row's required fields must match its trigger_type
-- — mirrors the existing not-null pattern rather than allowing a
-- half-configured row of either kind.
alter table action_recommendation_master
  add constraint action_recommendation_master_trigger_fields_check
  check (
    (trigger_type = 'forecast_variance' and forecast_category is not null and forecast_status is not null)
    or
    (trigger_type = 'score_pillar' and pillar_code is not null and score_band is not null)
  );

create index idx_action_recommendation_master_pillar on action_recommendation_master(trigger_type, pillar_code, score_band, is_active);

-- Part B: report_content_library — replaces lib/engines/reportCopy.ts's
-- hardcoded string constants with DB-editable rows. Seeded 1:1 with today's
-- exact wording in the next migration (0026) — this phase changes WHERE the
-- content lives, not what it says.
create table report_content_library (
  id uuid primary key default gen_random_uuid(),
  content_key text not null,
  locale text not null default 'en',
  -- 'fixed' = single unconditional string (e.g. REPORT_WHAT_IT_IS);
  -- 'banded' = one row per status_band under the same content_key (e.g.
  -- confidenceExplanation's high/medium/low); 'code_label' = one row per
  -- raw DB code under the same content_key (categoryLabel's ~20 mappings).
  content_type text not null check (content_type in ('fixed', 'banded', 'code_label')),
  status_band text,
  code_value text,
  title text,
  body_template text not null,
  is_active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (content_key, locale, status_band, code_value)
);
create index idx_report_content_library_lookup on report_content_library(content_key, locale, is_active);

alter table report_content_library enable row level security;
create policy "read report content library" on report_content_library for select using (true);
-- Writes go through the service-role admin client only (same pattern as
-- action_recommendation_master's admin routes) — no insert/update/delete
-- policy for authenticated/anon roles.
