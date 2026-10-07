-- 0266 promo e-mail abuse controls and reconcilable dispatch (part A of D)
-- =============================================================================
-- NEW migration on top of 0265 (apply 0264 and 0265 first). 0242 is NOT edited. The functions it created
-- are dropped and recreated here with the same security mode, the same empty search_path and the same
-- grants (authenticated for the admin functions).
--
-- WHAT THIS ADDS (items 8 and 9 of the hardening mission)
--   * a purpose, a kind (create or replace) and the replaced code on every dispatch request, so each
--     request records who started it, why, and for how many recipients (never an address, never a code),
--   * named limits in one function: recipients per admin per rolling 24 hours, recipients across all
--     admins per rolling 24 hours, replacements per code per 24 hours, and the circuit breaker settings,
--   * an advisory lock around the begin step so two simultaneous requests cannot both slip under a limit,
--   * monitoring rows (admin_monitoring_events) when volume gets unusual or a request is refused,
--   * a circuit breaker for the mail provider (service role only) and a status function that lets the
--     admin who started a request see the state of every recipient WITHOUT any plain address or code.
--
-- NOTHING IS SWITCHED ON: sending is still governed by PREMIUM_PROMO_EMAIL_ENABLED (default off).
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to D in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0266: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

alter table public.promo_email_requests add column if not exists purpose text;
alter table public.promo_email_requests add column if not exists kind text not null default 'create';
alter table public.promo_email_requests add column if not exists replaces_promo_code_id uuid;

do $fn$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_email_requests_kind_check' and conrelid = 'public.promo_email_requests'::regclass) then
    alter table public.promo_email_requests add constraint promo_email_requests_kind_check check (kind in ('create', 'replace'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promo_email_requests_purpose_check' and conrelid = 'public.promo_email_requests'::regclass) then
    alter table public.promo_email_requests add constraint promo_email_requests_purpose_check
      check (purpose is null or (char_length(btrim(purpose)) between 10 and 200));
  end if;
end $fn$;
create index if not exists idx_promo_email_requests_time on public.promo_email_requests (created_at desc);
create index if not exists idx_promo_email_requests_replaces on public.promo_email_requests (replaces_promo_code_id, created_at desc) where replaces_promo_code_id is not null;

comment on column public.promo_email_requests.purpose is
  'Hardening 0266 item 9: why the admin sent this (10 to 200 characters). Null only on rows written before 0266.';
comment on column public.promo_email_requests.kind is
  'Hardening 0266 item 9: create (a new code created and sent) or replace (a replacement for an existing code).';
comment on column public.promo_email_requests.replaces_promo_code_id is
  'Hardening 0266 item 9: the code that a replacement stands in for. Used to limit repeated replacement generation.';

-- All the limits in one place. Mirrored by PROMO_EMAIL_LIMITS in lib/services/promoEmailAbuse.ts (a test asserts they agree).
create or replace function public.promo_email_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'admin_recipients_per_day', 100,
    'global_recipients_per_day', 300,
    'replacements_per_code_per_day', 3,
    'volume_alert_percent', 80,
    'circuit_failure_threshold', 5,
    'circuit_open_minutes', 15
  );
$fn$;
comment on function public.promo_email_limits() is
  'Hardening 0266 items 8 and 9: the named limits of the promo e-mail path. One source in SQL, mirrored in TypeScript, asserted equal by a test.';
revoke all on function public.promo_email_limits() from public, anon;
grant execute on function public.promo_email_limits() to authenticated, service_role;

-- The mail provider circuit breaker (one row). Service role only: written by the server after a send.
create table if not exists public.promo_email_circuit (
  id boolean primary key default true check (id),
  consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  open_until timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.promo_email_circuit enable row level security;
revoke all on public.promo_email_circuit from anon, authenticated;
comment on table public.promo_email_circuit is
  'Hardening 0266 item 9: circuit breaker state for the mail provider. After the configured number of consecutive provider failures sending pauses for the configured minutes and codes are shown once to the admin instead.';
-- ---------------------------------------------------------------------------
-- PART B starts here: begin a dispatch request (purpose, daily limits, replacement limit, alerts)
-- ---------------------------------------------------------------------------

drop function if exists public.admin_promo_email_begin(text, int, boolean);

create or replace function public.admin_promo_email_begin(
  p_request_key text, p_recipient_count int, p_bound boolean,
  p_kind text default 'create', p_purpose text default null, p_replaces uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_limits jsonb := public.promo_email_limits();
  v_purpose text := btrim(coalesce(p_purpose, ''));
  v_kind text := coalesce(p_kind, 'create');
  v_id uuid;
  v_recent_requests int;
  v_recent_recipients int;
  v_admin_day int;
  v_global_day int;
  v_replacements int;
  v_admin_limit int := (v_limits ->> 'admin_recipients_per_day')::int;
  v_global_limit int := (v_limits ->> 'global_recipients_per_day')::int;
  v_alert_pct int := (v_limits ->> 'volume_alert_percent')::int;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_request_key is null or char_length(p_request_key) < 8 or char_length(p_request_key) > 100 then
    raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023';
  end if;
  if p_recipient_count is null or p_recipient_count < 1 or p_recipient_count > 20 then
    raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023';
  end if;
  if v_kind not in ('create', 'replace') then raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023'; end if;
  if char_length(v_purpose) < 10 or char_length(v_purpose) > 200 or v_purpose ~ '[[:cntrl:]]' then
    raise exception 'PROMO_EMAIL_PURPOSE_REQUIRED' using errcode = '22023';
  end if;
  if v_kind = 'replace' and p_replaces is null then raise exception 'PROMO_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_kind = 'create' and p_replaces is not null then raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023'; end if;

  -- A refusal RETURNS a result (it does not raise) so that its alert row is committed with the call.
  -- One begin at a time: the limits below are counted, then a row is added. Without this lock two
  -- simultaneous requests could both pass the count.
  perform pg_advisory_xact_lock(hashtext('promo_email_begin'));

  if exists (select 1 from public.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key) then
    return jsonb_build_object('new', false);
  end if;

  if p_replaces is not null then
    if not exists (select 1 from public.promo_codes where id = p_replaces) then raise exception 'PROMO_NOT_FOUND' using errcode = 'P0002'; end if;
    select count(*) into v_replacements from public.promo_email_requests
     where replaces_promo_code_id = p_replaces and created_at > now() - interval '24 hours';
    if v_replacements >= (v_limits ->> 'replacements_per_code_per_day')::int then
      insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details, dedupe_key)
      values ('promo_email_refused', 'warning', v_actor, jsonb_build_object('reason', 'replacement_limit', 'promo_code_id', p_replaces),
              'replacement:' || p_replaces::text || ':' || current_date::text)
      on conflict (dedupe_key) where dedupe_key is not null do nothing;
      return jsonb_build_object('new', false, 'refused', 'PROMO_EMAIL_REPLACEMENT_LIMIT');
    end if;
  end if;

  select count(*), coalesce(sum(recipient_count), 0) into v_recent_requests, v_recent_recipients
    from public.promo_email_requests
   where admin_user_id = v_actor and created_at > now() - interval '1 hour';
  if v_recent_requests >= 10 or v_recent_recipients + p_recipient_count > 100 then
    raise exception 'PROMO_EMAIL_RATE_LIMITED' using errcode = 'P0001';
  end if;

  select coalesce(sum(recipient_count), 0) into v_admin_day from public.promo_email_requests
   where admin_user_id = v_actor and created_at > now() - interval '24 hours';
  select coalesce(sum(recipient_count), 0) into v_global_day from public.promo_email_requests
   where created_at > now() - interval '24 hours';
  if v_admin_day + p_recipient_count > v_admin_limit then
    insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details, dedupe_key)
    values ('promo_email_refused', 'warning', v_actor, jsonb_build_object('reason', 'admin_daily_limit', 'recipients_24h', v_admin_day),
            'admin-day:' || v_actor::text || ':' || current_date::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
    return jsonb_build_object('new', false, 'refused', 'PROMO_EMAIL_DAILY_LIMIT');
  end if;
  if v_global_day + p_recipient_count > v_global_limit then
    insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details, dedupe_key)
    values ('promo_email_refused', 'high', v_actor, jsonb_build_object('reason', 'global_daily_limit', 'recipients_24h', v_global_day),
            'global-day:' || current_date::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
    return jsonb_build_object('new', false, 'refused', 'PROMO_EMAIL_GLOBAL_LIMIT');
  end if;

  insert into public.promo_email_requests (admin_user_id, request_key, recipient_count, bound, purpose, kind, replaces_promo_code_id)
  values (v_actor, p_request_key, p_recipient_count, coalesce(p_bound, false), v_purpose, v_kind, p_replaces)
  on conflict on constraint uq_promo_email_request do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('new', false); end if;

  -- Unusual volume: an alert row (counts only) once an admin or the whole platform crosses the alert share
  -- of its daily limit. One row per admin per day and one per day for the platform.
  if (v_admin_day + p_recipient_count) * 100 >= v_admin_limit * v_alert_pct then
    insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details, dedupe_key)
    values ('promo_email_volume', 'warning', v_actor,
            jsonb_build_object('scope', 'admin', 'recipients_24h', v_admin_day + p_recipient_count, 'limit', v_admin_limit),
            'volume-admin:' || v_actor::text || ':' || current_date::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;
  if (v_global_day + p_recipient_count) * 100 >= v_global_limit * v_alert_pct then
    insert into public.admin_monitoring_events (event_type, severity, actor_user_id, details, dedupe_key)
    values ('promo_email_volume', 'high', v_actor,
            jsonb_build_object('scope', 'platform', 'recipients_24h', v_global_day + p_recipient_count, 'limit', v_global_limit),
            'volume-platform:' || current_date::text)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  return jsonb_build_object('new', true, 'admin_recipients_24h', v_admin_day + p_recipient_count,
                            'platform_recipients_24h', v_global_day + p_recipient_count);
end;
$fn$;
revoke all on function public.admin_promo_email_begin(text, int, boolean, text, text, uuid) from public, anon;
grant execute on function public.admin_promo_email_begin(text, int, boolean, text, text, uuid) to authenticated;
-- ---------------------------------------------------------------------------
-- PART C starts here: per recipient status for a request, without any plain address or code
-- ---------------------------------------------------------------------------
-- The caller passes the keyed hashes it recomputes out of the addresses the admin typed. Only the admin who
-- started the request can read it. A recipient with no ledger row is reported as unknown (the response may
-- have been lost before the outcome was recorded) and is never assumed to have received anything.

create or replace function public.admin_promo_email_request_status(p_request_key text, p_recipient_hashes text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_req record;
  v_sends jsonb;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_request_key is null or char_length(p_request_key) < 8 or char_length(p_request_key) > 100 then
    raise exception 'PROMO_EMAIL_KEY_INVALID' using errcode = '22023';
  end if;
  if p_recipient_hashes is null or cardinality(p_recipient_hashes) > 20 then
    raise exception 'PROMO_RECIPIENTS_INVALID' using errcode = '22023';
  end if;

  select * into v_req from public.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key;
  if not found then return jsonb_build_object('request_exists', false, 'recipients', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'recipient_hash', h.hash,
           'status', coalesce(s.status, 'unknown'),
           'attempts', coalesce(s.attempts, 0),
           'promo_code_id', s.promo_code_id,
           'updated_at', s.updated_at) order by h.ord), '[]'::jsonb)
    into v_sends
    from unnest(p_recipient_hashes) with ordinality as h(hash, ord)
    left join public.promo_email_sends s
      on s.admin_user_id = v_actor and s.request_key = p_request_key and s.recipient_hash = h.hash;

  return jsonb_build_object('request_exists', true, 'kind', v_req.kind, 'purpose', v_req.purpose,
                            'recipient_count', v_req.recipient_count, 'bound', v_req.bound,
                            'created_at', v_req.created_at, 'recipients', v_sends);
end;
$fn$;
revoke all on function public.admin_promo_email_request_status(text, text[]) from public, anon;
grant execute on function public.admin_promo_email_request_status(text, text[]) to authenticated;
-- ---------------------------------------------------------------------------
-- PART D starts here: provider circuit breaker (service role only)
-- ---------------------------------------------------------------------------
-- The server reports the outcome of each provider call. The breaker counts only provider level failures
-- (network errors, server errors, rate limiting, rejected credentials), never a refusal of one address.
-- After the configured number of consecutive failures it opens for the configured minutes. While it is open
-- the application sends nothing and shows each new code once to the admin instead. After the pause the next
-- send is allowed through and its outcome closes or reopens the breaker.

create or replace function public.promo_email_circuit_status()
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare v_row record;
begin
  select * into v_row from public.promo_email_circuit where id;
  if not found then return jsonb_build_object('open', false, 'consecutive_failures', 0, 'open_until', null); end if;
  return jsonb_build_object('open', v_row.open_until is not null and v_row.open_until > now(),
                            'consecutive_failures', v_row.consecutive_failures, 'open_until', v_row.open_until);
end;
$fn$;
revoke all on function public.promo_email_circuit_status() from public, anon, authenticated;
grant execute on function public.promo_email_circuit_status() to service_role;

create or replace function public.promo_email_circuit_report(p_ok boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_limits jsonb := public.promo_email_limits();
  v_threshold int := (v_limits ->> 'circuit_failure_threshold')::int;
  v_minutes int := (v_limits ->> 'circuit_open_minutes')::int;
  v_row record;
  v_failures int;
  v_open_until timestamptz;
  v_opened boolean := false;
begin
  insert into public.promo_email_circuit (id) values (true) on conflict (id) do nothing;
  select * into v_row from public.promo_email_circuit where id for update;
  if coalesce(p_ok, false) then
    update public.promo_email_circuit
       set consecutive_failures = 0, open_until = null, last_success_at = now(), updated_at = now()
     where id;
    return jsonb_build_object('open', false, 'consecutive_failures', 0, 'open_until', null);
  end if;

  v_failures := v_row.consecutive_failures + 1;
  v_open_until := v_row.open_until;
  if v_failures >= v_threshold and (v_open_until is null or v_open_until <= now()) then
    v_open_until := now() + make_interval(mins => v_minutes);
    v_opened := true;
  end if;
  update public.promo_email_circuit
     set consecutive_failures = v_failures, open_until = v_open_until, last_failure_at = now(), updated_at = now()
   where id;
  if v_opened then
    insert into public.admin_monitoring_events (event_type, severity, details)
    values ('promo_email_circuit_opened', 'high', jsonb_build_object('consecutive_failures', v_failures, 'open_until', v_open_until));
  end if;
  return jsonb_build_object('open', v_open_until is not null and v_open_until > now(),
                            'consecutive_failures', v_failures, 'open_until', v_open_until);
end;
$fn$;
revoke all on function public.promo_email_circuit_report(boolean) from public, anon, authenticated;
grant execute on function public.promo_email_circuit_report(boolean) to service_role;
