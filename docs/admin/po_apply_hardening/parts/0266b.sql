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
