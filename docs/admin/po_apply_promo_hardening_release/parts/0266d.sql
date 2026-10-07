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
