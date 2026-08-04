-- Recommendations Engine schema v2 — supersedes the starter schema in
-- 0017/0018. The user supplied a complete, production-scale recommendation
-- library (542 master rows / 2143 conditions / 88 calculation methods / 120
-- template placeholders) with its own richer column set; this migration
-- adopts that schema directly rather than forcing their data into the
-- narrower starter shape.
--
-- Nothing user-facing depends on the 19 starter rows yet (the feature just
-- shipped), so action_recommendation_master/action_recommendation_conditions
-- are dropped and recreated rather than altered. user_recommendation_runs/
-- matches keep their shape but are truncated (their recommendation_id values
-- point at rows that no longer exist once master is recreated).

truncate table user_recommendation_matches, user_recommendation_runs;

drop table if exists action_recommendation_conditions cascade;
drop table if exists action_recommendation_master cascade;

create table action_recommendation_master (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null unique,
  forecast_category text not null check (forecast_category in (
    'net_worth', 'retirement', 'goal', 'debt', 'investment_growth', 'cross_border', 'resilience', 'data_quality'
  )),
  sub_category text not null,
  scenario_name text not null,
  scenario_description text,
  variance_result text check (variance_result in ('favourable', 'unfavourable', 'neutral')),
  forecast_status text not null check (forecast_status in (
    'ahead_of_plan', 'on_track', 'slightly_behind', 'at_risk', 'significantly_off_track', 'review_required'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  action_type text not null,
  action_title_template text not null,
  action_content_template text not null,
  financial_impact_template text,
  calculation_method_code text,
  required_input_fields text[] not null default '{}',
  supported_placeholders text[] not null default '{}',
  priority_score int not null default 0,
  country_code char(2) references countries(country_code),
  currency_code char(3) references currencies(currency_code),
  customer_segment text not null default 'base',
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  requires_ai boolean not null default false,
  -- Not part of the user-supplied library data (every imported row has
  -- requires_ai=false) — this is FHIP's own Free/Premium gating flag,
  -- defaulted false on import, settable per-row by an admin afterward.
  is_premium boolean not null default false,
  version_number int not null default 1,
  admin_notes text,
  -- Per user decision: forecasting-performance recommendations are shown in
  -- the Recommendations page; data_quality rows are reserved for the
  -- Monthly/Initial Report's data-quality section instead, not this engine's
  -- output — same master list, tagged for where each row is consumed.
  include_in_forecasting boolean not null default true,
  include_in_monthly_report boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_action_recommendation_master_lookup on action_recommendation_master(forecast_category, sub_category, forecast_status, is_active);
create index idx_action_recommendation_master_context on action_recommendation_master(include_in_forecasting, include_in_monthly_report);

create table action_recommendation_conditions (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null references action_recommendation_master(recommendation_code) on delete cascade,
  condition_group int not null default 1,
  field_name text not null,
  operator text not null default 'equals',
  comparison_value text,
  comparison_value_2 text,
  data_type text not null default 'text',
  logical_operator text not null default 'AND',
  evaluation_order int not null default 1,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create index idx_action_recommendation_conditions_code on action_recommendation_conditions(recommendation_code);

create table recommendation_calculation_methods (
  id uuid primary key default gen_random_uuid(),
  calculation_method_code text not null unique,
  method_name text not null,
  forecast_categories text[] not null default '{}',
  description text,
  calculation_service text,
  required_inputs text[] not null default '{}',
  outputs text[] not null default '{}',
  rounding_method text,
  supported_scenarios text[] not null default '{}',
  is_active boolean not null default true,
  version_number int not null default 1,
  admin_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table recommendation_template_placeholders (
  id uuid primary key default gen_random_uuid(),
  placeholder text not null unique,
  data_type text not null,
  description text,
  source text,
  availability text,
  display_format text,
  is_active boolean not null default true,
  validation_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table action_recommendation_master enable row level security;
alter table action_recommendation_conditions enable row level security;
alter table recommendation_calculation_methods enable row level security;
alter table recommendation_template_placeholders enable row level security;

create policy "read recommendation master" on action_recommendation_master for select using (true);
create policy "read recommendation conditions" on action_recommendation_conditions for select using (true);
create policy "read recommendation calculation methods" on recommendation_calculation_methods for select using (true);
create policy "read recommendation template placeholders" on recommendation_template_placeholders for select using (true);

-- Re-attach the FK from the (truncated, otherwise-unchanged) match table to
-- the recreated master table.
alter table user_recommendation_matches
  add constraint user_recommendation_matches_recommendation_id_fkey
  foreign key (recommendation_id) references action_recommendation_master(id) on delete cascade;
