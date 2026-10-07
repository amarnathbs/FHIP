-- 0263 -- Fund analytics: one row per LIVE weekly RBI refresh attempt, and an aggregate-only summary for the monitoring page.
--
-- Forward-only, additive, idempotent. HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply AFTER 0260, 0261 and 0262 (a single paste).
--
-- WHY. The RBI address for robots.txt answers with an HTML Unauthorised Access page (the firewall), not a robots file. The PO decided
-- (RFC 9309: an unavailable robots file means no rules are published) that the weekly refresh continues and RECORDS that robots
-- was unavailable, and that a refusal of a CONTENT page (403, 429, a verification page or an Unauthorised Access page) stops the whole
-- run loudly as blocked_by_source. Both need a durable count, so each live run leaves one row here. A dry run writes nothing.
--
-- The summary function is authorised INSIDE by the same capability as the existing monitoring snapshot (is_pc6_reference_data_admin),
-- returns counts and dates only (no page text, no address), and is read by the Fund analytics health page.

create table if not exists ii_risk_free_refresh_attempts (
  id bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  job_version text,
  robots_outcome text not null check (robots_outcome in ('not_read', 'robots_ok', 'robots_unavailable_continued', 'robots_unreachable')),
  source_status text not null check (source_status in ('ok', 'blocked_by_source', 'fetch_problem')),
  fetch_problem_code text,
  tbill_outcome text,
  repo_outcome text,
  pages_requested integer not null default 0 check (pages_requested >= 0),
  robots_requests integer not null default 0 check (robots_requests >= 0)
);
create index if not exists idx_ii_risk_free_refresh_attempts_at on ii_risk_free_refresh_attempts (attempted_at desc);
alter table ii_risk_free_refresh_attempts enable row level security;
revoke all on ii_risk_free_refresh_attempts from anon, authenticated;

create or replace function nav2_refresh_attempt_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_last record;
  v_runs bigint;
  v_robots bigint;
  v_blocked bigint;
  v_last_blocked timestamptz;
begin
  if auth.uid() is null or not public.is_pc6_reference_data_admin() then
    raise exception 'nav2 refresh attempts: not authorised' using errcode = '42501';
  end if;
  select a.attempted_at, a.robots_outcome, a.source_status
    into v_last
    from public.ii_risk_free_refresh_attempts a
   order by a.attempted_at desc
   limit 1;
  select count(*),
         count(*) filter (where x.robots_outcome = 'robots_unavailable_continued'),
         count(*) filter (where x.source_status = 'blocked_by_source'),
         max(x.attempted_at) filter (where x.source_status = 'blocked_by_source')
    into v_runs, v_robots, v_blocked, v_last_blocked
    from public.ii_risk_free_refresh_attempts x
   where x.attempted_at > now() - interval '90 days';
  return jsonb_build_object(
    'runs_last_90_days', v_runs,
    'robots_unavailable_continued_last_90_days', v_robots,
    'blocked_by_source_last_90_days', v_blocked,
    'last_blocked_at', v_last_blocked,
    'last_attempt_at', v_last.attempted_at,
    'last_robots_outcome', v_last.robots_outcome,
    'last_source_status', v_last.source_status
  );
end $fn$;
revoke all on function nav2_refresh_attempt_summary() from public, anon;
grant execute on function nav2_refresh_attempt_summary() to authenticated, service_role;

-- ROLLBACK: drop the function nav2_refresh_attempt_summary and then the table ii_risk_free_refresh_attempts.
