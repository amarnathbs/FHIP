-- Supabase platform shim for PGlite clean-rebuild replay.
-- Emulates ONLY the managed-platform surface that Supabase provides before any
-- project migration runs. No project schema is defined here.

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create schema if not exists graphql_public;
create schema if not exists cron;
create schema if not exists net;

-- Platform roles
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login password 'x'; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants API roles usage on auth/storage and table privileges in
-- public by default (via ALTER DEFAULT PRIVILEGES on the owning role), so
-- RLS — not the grant layer — is what actually confines a tenant.
grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- auth.users (GoTrue-managed)
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Request-context accessors. Supabase reads the JWT from the request GUC.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(auth.jwt()->>'sub', current_setting('request.jwt.claim.sub', true)), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt()->>'role', current_setting('request.jwt.claim.role', true));
$$;
create or replace function auth.email() returns text language sql stable as $$
  select auth.jwt()->>'email';
$$;
grant select on auth.users to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt(), auth.role(), auth.email() to anon, authenticated, service_role;

-- storage
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/');
$$;
create or replace function storage.filename(name text) returns text language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name,'/'),1)];
$$;
grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated, service_role;
grant execute on function storage.foldername(text), storage.filename(text) to anon, authenticated, service_role;

-- pg_cron / pg_net stubs. PGlite cannot load these C extensions; the project's
-- only use is one scheduled HTTP POST (migration 0010), which has no schema
-- effect. Stubbing keeps replay faithful for every DDL statement around it.
create table if not exists cron.job (
  jobid bigserial primary key, schedule text, command text, jobname text
);
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$
  insert into cron.job(schedule, command, jobname) values (schedule, command, job_name) returning jobid;
$$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  delete from cron.job where jobname = job_name; select true;
$$;
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language sql as $$ select 1::bigint; $$;
