-- 0267 promo and premium data retention and scheduled cleanup (part A of D)
-- =============================================================================
-- NEW migration on top of 0266. Nothing applied is edited. Item 7 of the hardening mission.
--
-- WHAT THIS ADDS
--   * a policy table with one named retention period per data set (the periods are PROPOSALS for PO approval,
--     each is one row that can be changed without a migration),
--   * legal hold rows that pause cleanup for a data set or for one user,
--   * an append-only run record, so every cleanup run leaves evidence (dry runs too),
--   * promo_retention_run(): the cleanup, service role only, anonymising instead of deleting where the audit
--     trail needs the row, and handling rows that belong to deleted accounts,
--   * a job control row promo_retention that SHIPS DISABLED, and a pg_cron job registered ONLY on a database
--     that carries the production marker row (it does nothing while the switch is off).
--
-- PROPOSED PERIODS (all disabled until the PO approves and enables the job)
--   promo_redemption_attempts   30 days   delete
--   promo_email_requests        180 days  delete
--   promo_email_sends           180 days  anonymise (the keyed recipient hash is replaced, status kept)
--   premium_expiry_email_ledger 400 days  delete settled rows
--   promo_codes                 365 days  anonymise (after disable or after the redeem by date)
--   promo_code_events           2555 days anonymise (7 years, the actor is replaced, the event stays)
--
-- ACCOUNT DELETION. Redemption rows and reminder ledger rows follow the user by foreign key cascade. Rows
-- with no foreign key (attempts, event actors, e-mail request admins) are cleaned by the orphan step of
-- promo_retention_run, which runs on every pass and does not wait for the age limit.
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed
-- by a name. Hand-run parts A to D in order. Their concatenation is byte-equal to this file.
--
-- MIGRATION NUMBER 0267: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

alter table public.promo_email_sends add column if not exists anonymised_at timestamptz;
alter table public.promo_code_events add column if not exists anonymised_at timestamptz;

create table if not exists public.promo_retention_policy (
  data_set text primary key,
  retention_days int not null check (retention_days between 1 and 3650),
  action text not null check (action in ('delete', 'anonymise')),
  note text,
  updated_at timestamptz not null default now()
);
comment on table public.promo_retention_policy is
  'Hardening 0267 item 7: one named retention period per promo and premium data set. Proposals pending PO approval. Changing a period is a row update, not a migration.';

insert into public.promo_retention_policy (data_set, retention_days, action, note)
select v.data_set, v.retention_days, v.action, v.note
  from (values
    ('promo_redemption_attempts', public.promo_attempts_retention_days(), 'delete', 'Rate limit ledger. The redeem function also prunes with the same value.'),
    ('promo_email_requests', 180, 'delete', 'Dispatch requests: admin, purpose and counts only.'),
    ('promo_email_sends', 180, 'anonymise', 'Keyed recipient hash replaced, provider id and error cleared, status kept.'),
    ('premium_expiry_email_ledger', 400, 'delete', 'Settled rows only (sent, abandoned, unknown, void).'),
    ('promo_codes', 365, 'anonymise', 'Disabled or past the redeem by date for this long: note and digest cleared, row kept.'),
    ('promo_code_events', 2555, 'anonymise', 'Seven years, then the actor is replaced and the event stays.')
  ) as v(data_set, retention_days, action, note)
 where not exists (select 1 from public.promo_retention_policy p where p.data_set = v.data_set);

create table if not exists public.promo_retention_holds (
  id uuid primary key default gen_random_uuid(),
  data_set text not null check (data_set in ('all', 'promo_redemption_attempts', 'promo_email_requests', 'promo_email_sends',
                                              'premium_expiry_email_ledger', 'promo_codes', 'promo_code_events')),
  user_id uuid,
  reason text not null check (char_length(btrim(reason)) >= 10 and char_length(reason) <= 500),
  created_by text not null default current_user,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by text
);
comment on table public.promo_retention_holds is
  'Hardening 0267 item 7: a legal hold. An open row (released_at is null) with user_id null pauses cleanup of that data set (or all). With a user_id it protects that user rows only.';

create table if not exists public.promo_retention_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  started_at timestamptz not null default now(),
  dry_run boolean not null,
  data_set text not null,
  outcome text not null check (outcome in ('ok', 'skipped_hold', 'skipped_disabled')),
  rows_affected int not null default 0,
  details jsonb not null default '{}'::jsonb
);
create index if not exists idx_promo_retention_runs_time on public.promo_retention_runs (started_at desc);
comment on table public.promo_retention_runs is
  'Hardening 0267 item 7: append-only evidence of every cleanup run, dry runs included. Counts only.';

drop trigger if exists trg_promo_retention_runs_no_change on public.promo_retention_runs;
create trigger trg_promo_retention_runs_no_change before update or delete on public.promo_retention_runs
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_promo_retention_runs_no_truncate on public.promo_retention_runs;
create trigger trg_promo_retention_runs_no_truncate before truncate on public.promo_retention_runs
  for each statement execute function public.promo_hardening_append_only();

alter table public.promo_retention_policy enable row level security;
alter table public.promo_retention_holds enable row level security;
alter table public.promo_retention_runs enable row level security;
revoke all on public.promo_retention_policy, public.promo_retention_holds, public.promo_retention_runs from anon, authenticated;

-- The kill switch row (same table and pattern as the expiry reminder job). Ships disabled.
insert into public.premium_reminder_job_control (job_key, enabled, disabled_reason)
select 'promo_retention', false, 'Shipped disabled. Enable only after the PO approves the retention periods in promo_retention_policy.'
 where not exists (select 1 from public.premium_reminder_job_control where job_key = 'promo_retention');
-- ---------------------------------------------------------------------------
-- PART B starts here: the promo audit trail stays append-only, with ONE narrow anonymising exception
-- ---------------------------------------------------------------------------
-- Same function name, same trigger wiring, same search_path as 0237. An UPDATE is allowed only inside the
-- retention function (it sets a transaction local switch first), only to mark the row anonymised, and only
-- while the identifying columns (id, time, type, code id, masked hint) stay exactly as they were. Delete and
-- truncate stay refused for everyone.

create or replace function public.promo_code_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.promo_retention_anonymise', true), '') = 'on'
     and new.id = old.id and new.created_at = old.created_at and new.event_type = old.event_type
     and new.promo_code_id = old.promo_code_id and new.code_hint = old.code_hint
     and old.anonymised_at is null and new.anonymised_at is not null then
    return new;
  end if;
  raise exception 'promo_code_events is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;
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
-- ---------------------------------------------------------------------------
-- PART D starts here: the scheduled job (production marker only, doing nothing while the switch is off)
-- ---------------------------------------------------------------------------
-- The job calls the SQL function directly (no web call, no secret). The function itself reads the job control
-- row, so a registered job with the row disabled is a cheap no-op that only records a skipped run. Absent
-- the pg_cron extension, or absent the production marker row (DEV, a fresh environment, PGlite), this
-- registers nothing.

do $fn$
begin
  if to_regclass('cron.job') is null then
    raise notice '0267: pg_cron is not installed here, the retention job is not registered.';
    return;
  end if;
  if not exists (select 1 from public.platform_deployment_environment where environment = 'production') then
    raise notice '0267: no production marker row here, the retention job is not registered.';
    return;
  end if;

  perform cron.unschedule('promo-retention-cleanup')
  where exists (select 1 from cron.job where jobname = 'promo-retention-cleanup');

  perform cron.schedule('promo-retention-cleanup', '43 3 * * *', $cron$ select public.promo_retention_run(false); $cron$);
  raise notice '0267: retention job registered (it does nothing until the promo_retention switch is enabled).';
end $fn$;
