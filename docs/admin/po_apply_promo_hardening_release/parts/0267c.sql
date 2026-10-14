-- ---------------------------------------------------------------------------
-- PART C starts here: the cleanup function (service role only)
-- ---------------------------------------------------------------------------
-- promo_retention_run(true) is a dry run and works while the job control row is disabled: it only counts.
-- promo_retention_run(false) changes data and refuses while the job control row is not enabled. Both leave
-- one evidence row per data set in promo_retention_runs.

create or replace function public.promo_retention_user_held(p_user_id uuid, p_data_set text)
returns boolean
language sql stable security definer set search_path = '' as $fn$
  select p_user_id is not null and exists (
    select 1 from public.promo_retention_holds h
     where h.released_at is null and h.user_id = p_user_id and h.data_set in ('all', p_data_set));
$fn$;
revoke all on function public.promo_retention_user_held(uuid, text) from public, anon, authenticated;
grant execute on function public.promo_retention_user_held(uuid, text) to service_role;

create or replace function public.promo_retention_run(p_dry_run boolean default true, p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_run uuid := gen_random_uuid();
  v_dry boolean := coalesce(p_dry_run, true);
  v_enabled boolean;
  v_pol record;
  v_cutoff timestamptz;
  v_n int;
  v_n2 int;
  v_n3 int;
  v_total int := 0;
  v_results jsonb := '[]'::jsonb;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  select c.enabled into v_enabled from public.premium_reminder_job_control c where c.job_key = 'promo_retention';
  v_enabled := coalesce(v_enabled, false);

  if not v_dry and not v_enabled then
    insert into public.promo_retention_runs (run_id, dry_run, data_set, outcome, details)
    values (v_run, false, 'all', 'skipped_disabled', jsonb_build_object('reason', 'job control row is not enabled'));
    return jsonb_build_object('run_id', v_run, 'dry_run', false, 'outcome', 'skipped_disabled', 'rows_total', 0, 'results', '[]'::jsonb);
  end if;

  perform set_config('app.promo_retention_anonymise', case when v_dry then 'off' else 'on' end, true);

  for v_pol in select * from public.promo_retention_policy order by data_set loop
    v_cutoff := p_now - make_interval(days => v_pol.retention_days);
    if exists (select 1 from public.promo_retention_holds h where h.released_at is null and h.user_id is null and h.data_set in ('all', v_pol.data_set)) then
      insert into public.promo_retention_runs (run_id, dry_run, data_set, outcome, details)
      values (v_run, v_dry, v_pol.data_set, 'skipped_hold', jsonb_build_object('cutoff', v_cutoff));
      v_results := v_results || jsonb_build_array(jsonb_build_object('data_set', v_pol.data_set, 'outcome', 'skipped_hold', 'rows', 0));
      continue;
    end if;
    v_n := 0;

    if v_pol.data_set = 'promo_redemption_attempts' then
      if v_dry then
        select count(*) into v_n from public.promo_redemption_attempts a
         where a.attempted_at < v_cutoff and not public.promo_retention_user_held(a.user_id, v_pol.data_set);
      else
        with d as (delete from public.promo_redemption_attempts a
                    where a.attempted_at < v_cutoff and not public.promo_retention_user_held(a.user_id, v_pol.data_set) returning 1)
        select count(*) into v_n from d;
      end if;

    elsif v_pol.data_set = 'promo_email_requests' then
      if v_dry then
        select count(*) into v_n from public.promo_email_requests r
         where r.created_at < v_cutoff and not public.promo_retention_user_held(r.admin_user_id, v_pol.data_set);
      else
        with d as (delete from public.promo_email_requests r
                    where r.created_at < v_cutoff and not public.promo_retention_user_held(r.admin_user_id, v_pol.data_set) returning 1)
        select count(*) into v_n from d;
      end if;

    elsif v_pol.data_set = 'promo_email_sends' then
      if v_dry then
        select count(*) into v_n from public.promo_email_sends s
         where s.anonymised_at is null and s.created_at < v_cutoff and not public.promo_retention_user_held(s.admin_user_id, v_pol.data_set);
      else
        with u as (update public.promo_email_sends s
                      set recipient_hash = encode(sha256(convert_to(s.id::text, 'UTF8')), 'hex'),
                          provider_message_id = null, last_error = null, anonymised_at = p_now
                    where s.anonymised_at is null and s.created_at < v_cutoff
                      and not public.promo_retention_user_held(s.admin_user_id, v_pol.data_set) returning 1)
        select count(*) into v_n from u;
      end if;

    elsif v_pol.data_set = 'premium_expiry_email_ledger' then
      if v_dry then
        select count(*) into v_n from public.premium_expiry_email_ledger l
         where l.created_at < v_cutoff and l.status in ('sent', 'abandoned', 'unknown', 'void')
           and not public.promo_retention_user_held(l.user_id, v_pol.data_set);
      else
        with d as (delete from public.premium_expiry_email_ledger l
                    where l.created_at < v_cutoff and l.status in ('sent', 'abandoned', 'unknown', 'void')
                      and not public.promo_retention_user_held(l.user_id, v_pol.data_set) returning 1)
        select count(*) into v_n from d;
      end if;

    elsif v_pol.data_set = 'promo_codes' then
      if v_dry then
        select count(*) into v_n from public.promo_codes c
         where c.anonymised_at is null
           and ((c.status = 'disabled' and c.disabled_at < v_cutoff) or (c.expires_on is not null and c.expires_on < v_cutoff::date));
      else
        with u as (update public.promo_codes c
                      set note = null, code = null, code_digest = null, code_digest_verified_at = null,
                          bound_email_hash = null, anonymised_at = p_now
                    where c.anonymised_at is null
                      and ((c.status = 'disabled' and c.disabled_at < v_cutoff) or (c.expires_on is not null and c.expires_on < v_cutoff::date))
                    returning 1)
        select count(*) into v_n from u;
      end if;

    elsif v_pol.data_set = 'promo_code_events' then
      if v_dry then
        select count(*) into v_n from public.promo_code_events e
         where e.anonymised_at is null and e.created_at < v_cutoff and not public.promo_retention_user_held(e.actor_user_id, v_pol.data_set);
      else
        with u as (update public.promo_code_events e
                      set actor_user_id = v_zero, anonymised_at = p_now
                    where e.anonymised_at is null and e.created_at < v_cutoff
                      and not public.promo_retention_user_held(e.actor_user_id, v_pol.data_set) returning 1)
        select count(*) into v_n from u;
      end if;
    end if;

    insert into public.promo_retention_runs (run_id, dry_run, data_set, outcome, rows_affected, details)
    values (v_run, v_dry, v_pol.data_set, 'ok', v_n, jsonb_build_object('cutoff', v_cutoff, 'action', v_pol.action));
    v_results := v_results || jsonb_build_array(jsonb_build_object('data_set', v_pol.data_set, 'outcome', 'ok', 'rows', v_n));
    v_total := v_total + v_n;
  end loop;

  -- Rows that belong to deleted accounts: no age limit applies, and only an open hold on everything pauses it.
  if not exists (select 1 from public.promo_retention_holds h where h.released_at is null and h.user_id is null and h.data_set = 'all') then
    if v_dry then
      select count(*) into v_n from public.promo_redemption_attempts a
       where not exists (select 1 from auth.users u where u.id = a.user_id) and not public.promo_retention_user_held(a.user_id, 'promo_redemption_attempts');
      select count(*) into v_n2 from public.promo_code_events e
       where e.actor_user_id <> v_zero and e.anonymised_at is null and not exists (select 1 from auth.users u where u.id = e.actor_user_id);
      select count(*) into v_n3 from public.promo_email_requests r
       where not exists (select 1 from auth.users u where u.id = r.admin_user_id);
    else
      with d as (delete from public.promo_redemption_attempts a
                  where not exists (select 1 from auth.users u where u.id = a.user_id)
                    and not public.promo_retention_user_held(a.user_id, 'promo_redemption_attempts') returning 1)
      select count(*) into v_n from d;
      with u2 as (update public.promo_code_events e set actor_user_id = v_zero, anonymised_at = p_now
                   where e.actor_user_id <> v_zero and e.anonymised_at is null
                     and not exists (select 1 from auth.users u where u.id = e.actor_user_id)
                     and not public.promo_retention_user_held(e.actor_user_id, 'promo_code_events') returning 1)
      select count(*) into v_n2 from u2;
      with d3 as (delete from public.promo_email_requests r
                   where not exists (select 1 from auth.users u where u.id = r.admin_user_id)
                     and not public.promo_retention_user_held(r.admin_user_id, 'promo_email_requests') returning 1)
      select count(*) into v_n3 from d3;
    end if;
    insert into public.promo_retention_runs (run_id, dry_run, data_set, outcome, rows_affected, details)
    values (v_run, v_dry, 'account_deletion_orphans', 'ok', v_n + v_n2 + v_n3,
            jsonb_build_object('attempts', v_n, 'event_actors', v_n2, 'email_requests', v_n3));
    v_results := v_results || jsonb_build_array(jsonb_build_object('data_set', 'account_deletion_orphans', 'outcome', 'ok', 'rows', v_n + v_n2 + v_n3));
    v_total := v_total + v_n + v_n2 + v_n3;
  end if;

  perform set_config('app.promo_retention_anonymise', 'off', true);
  if not v_dry then
    insert into public.admin_monitoring_events (event_type, severity, details)
    values ('promo_retention_run', 'info', jsonb_build_object('run_id', v_run, 'rows_total', v_total));
  end if;
  return jsonb_build_object('run_id', v_run, 'dry_run', v_dry, 'outcome', 'ok', 'rows_total', v_total, 'results', v_results);
end;
$fn$;
revoke all on function public.promo_retention_run(boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.promo_retention_run(boolean, timestamptz) to service_role;
