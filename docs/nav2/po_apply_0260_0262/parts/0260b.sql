-- ---------------------------------------------------------------------------
-- PART B starts here: the append-only function and the batch triggers
-- ---------------------------------------------------------------------------
create or replace function ii_risk_free_append_only() returns trigger
language plpgsql as $fn$
begin
  raise exception using message = tg_table_name || ' is append-only (' || tg_op || ' blocked)', errcode = '42501';
end $fn$;
drop trigger if exists trg_ii_risk_free_batches_no_change on ii_risk_free_batches;
create trigger trg_ii_risk_free_batches_no_change before update or delete on ii_risk_free_batches
  for each row execute function ii_risk_free_append_only();
drop trigger if exists trg_ii_risk_free_batches_no_truncate on ii_risk_free_batches;
create trigger trg_ii_risk_free_batches_no_truncate before truncate on ii_risk_free_batches
  for each statement execute function ii_risk_free_append_only();

-- ---------------------------------------------------------------------------
-- 4. Observations (one value or gap per series and date, changed only through the correction RPC)
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_observations (
  id uuid primary key default gen_random_uuid(),
  series_id text not null references ii_risk_free_series(series_id),
  observation_date date not null,
  kind text not null default 'value' check (kind in ('value', 'gap')),
  value_percent numeric(9, 4),
  gap_reason text check (gap_reason is null or gap_reason in ('no_accepted_bids', 'no_auction_held', 'no_row_in_source')),
  source_document text not null check (length(trim(source_document)) > 0),
  source_url text,
  retrieved_on date not null,
  notes text,
  entry_kind text not null check (entry_kind in ('first_load_csv', 'admin_upload', 'weekly_refresh_job')),
  extraction jsonb,
  batch_id uuid references ii_risk_free_batches(id),
  created_at timestamptz not null default now(),
  constraint ii_risk_free_obs_unique unique (series_id, observation_date),
  constraint ii_risk_free_obs_value_range check (value_percent is null or (value_percent >= 0 and value_percent <= 100)),
  -- A gap row never carries a value, a value row always does.
  constraint ii_risk_free_obs_kind_consistent check (
    (kind = 'value' and value_percent is not null and gap_reason is null)
    or (kind = 'gap' and value_percent is null and gap_reason is not null)
  ),
  -- An observation cannot be dated after the day it was retrieved (a future-dated rate).
  constraint ii_risk_free_obs_not_future check (observation_date <= retrieved_on)
);
create index if not exists idx_ii_risk_free_obs_series_date on ii_risk_free_observations (series_id, observation_date desc);
alter table ii_risk_free_observations enable row level security;
drop policy if exists read_ii_risk_free_observations on ii_risk_free_observations;
create policy read_ii_risk_free_observations on ii_risk_free_observations for select using (true);
revoke insert, update, delete, truncate on ii_risk_free_observations from anon, authenticated;

-- Updates are allowed ONLY inside correct_risk_free_observation(), which sets this transaction-local flag,
-- deletes and truncates are never allowed.
create or replace function ii_risk_free_obs_guard() returns trigger
language plpgsql as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'ii_risk_free_observations rows are never deleted' using errcode = '42501';
  end if;
  if coalesce(current_setting('fhip.risk_free_correction', true), '') <> 'on' then
    raise exception 'ii_risk_free_observations is append-only: use correct_risk_free_observation()' using errcode = '42501';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_ii_risk_free_obs_guard on ii_risk_free_observations;
create trigger trg_ii_risk_free_obs_guard before update or delete on ii_risk_free_observations
  for each row execute function ii_risk_free_obs_guard();
drop trigger if exists trg_ii_risk_free_obs_no_truncate on ii_risk_free_observations;
create trigger trg_ii_risk_free_obs_no_truncate before truncate on ii_risk_free_observations
  for each statement execute function ii_risk_free_append_only();

