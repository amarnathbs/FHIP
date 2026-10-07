-- ---------------------------------------------------------------------------
-- PART B starts here: append-only monitoring events and the override record
-- ---------------------------------------------------------------------------

create or replace function public.promo_hardening_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'this table is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;

-- Generic alert and monitoring rows. No address, no code and no secret is ever written here.
-- The event type is shape checked rather than listed, so a later feature adds a type without any
-- constraint change.
create table if not exists public.admin_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (event_type ~ '^[a-z][a-z_]{2,59}$'),
  severity text not null default 'info' check (severity in ('info', 'warning', 'high')),
  actor_user_id uuid,
  details jsonb not null default '{}'::jsonb,
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200)
);
create unique index if not exists uq_admin_monitoring_dedupe on public.admin_monitoring_events (dedupe_key) where dedupe_key is not null;
create index if not exists idx_admin_monitoring_type_time on public.admin_monitoring_events (event_type, created_at desc);
comment on table public.admin_monitoring_events is
  'Hardening 0264: append-only alert and monitoring rows (promo e-mail volume, circuit breaker, limit overrides, retention runs). Carries counts, ids and flags only. Never an address, a code or a secret.';

drop trigger if exists trg_admin_monitoring_no_change on public.admin_monitoring_events;
create trigger trg_admin_monitoring_no_change before update or delete on public.admin_monitoring_events
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_admin_monitoring_no_truncate on public.admin_monitoring_events;
create trigger trg_admin_monitoring_no_truncate before truncate on public.admin_monitoring_events
  for each statement execute function public.promo_hardening_append_only();
alter table public.admin_monitoring_events enable row level security;
revoke all on public.admin_monitoring_events from anon, authenticated;

-- Every override of the per grant cap or the lifetime ceiling leaves one row here.
create table if not exists public.premium_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid not null,
  target_user_id uuid not null,
  action text not null check (action in ('grant', 'extend')),
  limit_hit text not null check (limit_hit in ('lifetime_ceiling', 'extension_cap', 'both')),
  reason text not null check (char_length(btrim(reason)) >= 20 and char_length(reason) <= 1000),
  units_before int not null,
  units_after int not null,
  extension_count_before int not null,
  requested_ends_on date not null
);
create index if not exists idx_premium_overrides_target on public.premium_entitlement_overrides (target_user_id, created_at desc);
comment on table public.premium_entitlement_overrides is
  'Hardening 0264 item 3: append-only record of every grant or extension that went past the per grant cap or the lifetime ceiling. Written only inside admin_manage_premium_entitlement with the override flag.';
drop trigger if exists trg_premium_overrides_no_change on public.premium_entitlement_overrides;
create trigger trg_premium_overrides_no_change before update or delete on public.premium_entitlement_overrides
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_premium_overrides_no_truncate on public.premium_entitlement_overrides;
create trigger trg_premium_overrides_no_truncate before truncate on public.premium_entitlement_overrides
  for each statement execute function public.promo_hardening_append_only();
alter table public.premium_entitlement_overrides enable row level security;
drop policy if exists entitlement_admin_reads_overrides on public.premium_entitlement_overrides;
create policy entitlement_admin_reads_overrides on public.premium_entitlement_overrides
  for select using (public.is_premium_entitlement_admin());
revoke all on public.premium_entitlement_overrides from anon, authenticated;
grant select on public.premium_entitlement_overrides to authenticated;

-- Read the latest alerts. Either capability may look. Nobody can write through the API.
create or replace function public.admin_list_monitoring_events(p_limit int default 100)
returns table (id uuid, created_at timestamptz, event_type text, severity text, actor_user_id uuid, details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not (public.is_promo_code_admin() or public.is_premium_entitlement_admin()) then
    raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select e.id, e.created_at, e.event_type, e.severity, e.actor_user_id, e.details
      from public.admin_monitoring_events e
     order by e.created_at desc, e.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$fn$;
revoke all on function public.admin_list_monitoring_events(int) from public, anon;
grant execute on function public.admin_list_monitoring_events(int) to authenticated;
