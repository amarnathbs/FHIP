-- Reference data ---------------------------------------------------------
create table countries (
  country_code char(2) primary key,
  country_name text not null,
  default_currency_code char(3) not null,
  is_supported boolean default true
);

create table currencies (
  currency_code char(3) primary key,
  currency_name text not null,
  currency_symbol text not null,
  country_code char(2)
);

-- Profile (1:1 with auth.users) ------------------------------------------
create table user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  date_of_birth date,
  country_of_residence char(2) references countries(country_code),
  secondary_country char(2),
  preferred_currency char(3) references currencies(currency_code),
  employment_status text,
  onboarding_completed boolean default false,
  profile_completion_percentage int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table households (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_name text,
  household_type text,
  marital_status text,
  dependants_count int default 0 check (dependants_count >= 0),
  annual_household_income_range text,
  primary_country char(2),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table user_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_name text not null,
  goal_type text not null,
  target_amount numeric(18,2) not null check (target_amount >= 0),
  current_amount numeric(18,2) default 0 check (current_amount >= 0),
  currency_code char(3) not null references currencies(currency_code),
  target_date date,
  priority text default 'medium',
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Consent + audit primitives (scaffolded early for compliance) ------------
create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_type text not null,
  consent_version text not null,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,          -- login, update, delete, export, calc_run
  entity text,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_households_user on households(user_id);
create index idx_user_goals_user on user_goals(user_id);
create index idx_consents_user on consents(user_id);
create index idx_audit_user on audit_events(user_id);

-- Row Level Security: the reusable pattern for EVERY user-owned table -----
alter table user_profiles enable row level security;
alter table households    enable row level security;
alter table user_goals    enable row level security;
alter table consents      enable row level security;
alter table audit_events  enable row level security;

-- Owner-only policy, applied identically to each table
create policy "own rows - profiles" on user_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - households" on households
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - goals" on user_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - consents" on consents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows - audit" on audit_events
  for select using (auth.uid() = user_id);

-- Reference tables are world-readable, admin-writable (see Module 12)
alter table countries enable row level security;
alter table currencies enable row level security;
create policy "read countries" on countries for select using (true);
create policy "read currencies" on currencies for select using (true);
