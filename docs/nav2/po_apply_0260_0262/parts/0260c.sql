-- ---------------------------------------------------------------------------
-- PART C starts here: the review queue, correction ledger and state log tables
-- ---------------------------------------------------------------------------
-- 5. Review queue, correction ledger, state log
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_review_items (
  id uuid primary key default gen_random_uuid(),
  series_id text not null references ii_risk_free_series(series_id),
  observation_date date,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  reasons text[] not null default '{}',
  candidate jsonb,
  evidence jsonb,
  batch_id uuid references ii_risk_free_batches(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  constraint ii_risk_free_review_resolved_has_actor check (status = 'open' or (resolved_at is not null and resolved_by is not null))
);
-- The same unresolved case is queued once (idempotent weekly runs).
create unique index if not exists uidx_ii_risk_free_review_open
  on ii_risk_free_review_items (series_id, coalesce(observation_date, date '0001-01-01')) where status = 'open';
alter table ii_risk_free_review_items enable row level security;
drop policy if exists capability_read_ii_risk_free_review_items on ii_risk_free_review_items;
create policy capability_read_ii_risk_free_review_items on ii_risk_free_review_items for select using (is_risk_free_data_admin());
revoke insert, update, delete, truncate on ii_risk_free_review_items from anon, authenticated;

create table if not exists ii_risk_free_corrections (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references ii_risk_free_observations(id),
  series_id text not null,
  observation_date date not null,
  previous_value_percent numeric(9, 4),
  new_value_percent numeric(9, 4) not null,
  reason text not null check (length(trim(reason)) >= 20),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table ii_risk_free_corrections enable row level security;
drop policy if exists capability_read_ii_risk_free_corrections on ii_risk_free_corrections;
create policy capability_read_ii_risk_free_corrections on ii_risk_free_corrections for select using (is_risk_free_data_admin());
revoke insert, update, delete, truncate on ii_risk_free_corrections from anon, authenticated;
drop trigger if exists trg_ii_risk_free_corrections_no_change on ii_risk_free_corrections;
create trigger trg_ii_risk_free_corrections_no_change before update or delete on ii_risk_free_corrections
  for each row execute function ii_risk_free_append_only();

create table if not exists ii_risk_free_series_state_log (
  id uuid primary key default gen_random_uuid(),
  series_id text not null,
  previous_enabled boolean not null,
  new_enabled boolean not null,
  previous_terms_status text not null,
  new_terms_status text not null,
  reason text not null check (length(trim(reason)) >= 20),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table ii_risk_free_series_state_log enable row level security;
drop policy if exists capability_read_ii_risk_free_series_state_log on ii_risk_free_series_state_log;
create policy capability_read_ii_risk_free_series_state_log on ii_risk_free_series_state_log
  for select using (is_risk_free_data_admin() or is_risk_free_series_switch_admin());
revoke insert, update, delete, truncate on ii_risk_free_series_state_log from anon, authenticated;
drop trigger if exists trg_ii_risk_free_state_log_no_change on ii_risk_free_series_state_log;
create trigger trg_ii_risk_free_state_log_no_change before update or delete on ii_risk_free_series_state_log
  for each row execute function ii_risk_free_append_only();

