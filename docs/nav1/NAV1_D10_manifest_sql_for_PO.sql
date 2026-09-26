-- =============================================================================
-- NAV 1 completion (2026-09-25) -- SQL for the PO to run in the Supabase SQL
-- editor. The agent had PostgREST GET access only, so these could not be run
-- from the session. Every query below is READ-ONLY except Q7, which is a
-- single transaction that ends in ROLLBACK and leaves nothing behind.
--
-- Before each block: check the project ref in the SQL editor's URL.
--   production = twwpnltizhtjxhamyoxt      DEV = vqycarelcoijzwlpkpcz
-- Paste each block's output back into the session (counts and hashes only;
-- none of these queries return personal data).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Q1 (PRODUCTION and DEV) -- environment identity. Run first, in each project.
-- -----------------------------------------------------------------------------
select current_database() as db,
       (select string_agg(environment || ':' || policy_version || ':' || changeover_date, ', ')
          from ii_nav_retention_policy) as retention_policy,
       now() as at;


-- -----------------------------------------------------------------------------
-- Q2 (DEV) -- 0194 proof: no DEV cron job calls production.
-- Expected: zero rows with targets_production = true; no pc6-reference-ingest
-- or pc6-scheme-master-weekly row at all.
-- -----------------------------------------------------------------------------
select jobid, jobname, schedule, active,
       command ilike '%app.financialhealthplatform.com%' as targets_production
from cron.job
order by jobname;

-- Q2b (PRODUCTION) -- each NAV job registered exactly once, active.
-- Expected: 3 rows, n = 1 each, active = true, schedules
--   pc6-reference-ingest '30 3 * * 2-6', pc6-scheme-master-weekly '0 3 * * 2',
--   pc6-selective-hydration '*/30 * * * *'.
select jobname, schedule, active, count(*) over (partition by jobname) as n
from cron.job
where jobname in ('pc6-reference-ingest', 'pc6-scheme-master-weekly', 'pc6-selective-hydration')
order by jobname;

-- Q2c (PRODUCTION) -- the first scheduled daily tick (25 Sep 03:30 UTC) at the
-- pg_cron and pg_net layers. The batch row is the authoritative record; this
-- shows the HTTP status the route actually returned.
select d.jobid, j.jobname, d.status, d.start_time, d.end_time, left(d.return_message, 200) as msg
from cron.job_run_details d join cron.job j using (jobid)
where j.jobname in ('pc6-reference-ingest', 'pc6-selective-hydration')
  and d.start_time > now() - interval '12 hours'
order by d.start_time desc
limit 30;
select id, status_code, timed_out, created, left(error_msg, 200) as err
from net._http_response
where created > now() - interval '12 hours'
order by created desc
limit 30;


-- -----------------------------------------------------------------------------
-- Q3 (PRODUCTION) -- reproduce the manifest's per-instrument candidate counts
-- independently. Compare `per_instrument_md5` and `candidate_rows` with
-- manifest.json checksums.per_instrument_counts_md5 and counts.candidate_rows.
-- The protected set here is written from the tables, NOT from the candidate
-- function, exactly as the manifest generator does.
-- -----------------------------------------------------------------------------
with protected as (
  select instrument_id from ii_transactions
  union select instrument_id from ii_holding_snapshots
  union select instrument_id from ii_portfolio_truth_status
  union select instrument_id from ii_tax_lots
  union select instrument_id from ii_sip_series
  union select instrument_id from ii_capital_gains_computations
  union select instrument_id from ii_fhip_publications where instrument_id is not null
  union select instrument_id from ii_instrument_benchmarks
  union select instrument_id from ii_report_nav_dependencies
  union select instrument_id from ii_nav_retention_holds
  union select ii_canonical_instrument_id from investments where ii_canonical_instrument_id is not null
  union select merged_into_instrument_id from ii_instruments where merged_into_instrument_id is not null
  union select id from ii_instruments where merged_into_instrument_id is not null
),
per as (
  select p.instrument_id, count(*) as n
  from ii_prices_nav p
  where p.price_date < date '2026-09-21'
    and not exists (select 1 from protected x where x.instrument_id = p.instrument_id)
  group by p.instrument_id
)
select count(*) as candidate_instruments,
       sum(n) as candidate_rows,
       md5(string_agg(instrument_id::text || ':' || n, E'\n' order by instrument_id)) as per_instrument_md5
from per;


-- -----------------------------------------------------------------------------
-- Q4 (PRODUCTION) -- the full primary-key checksum the agent could not compute
-- over PostgREST (~22M ids). Chunked by instrument so no single string grows
-- past memory limits: md5 per instrument, then md5 over the per-instrument
-- lines. Deterministic: re-running on unchanged data gives the same value.
-- Expect a few minutes. If the editor times out, run it once per leading hex
-- digit of instrument_id (add: and p.instrument_id::text like '0%' ... 'f%')
-- and send all 16 results.
-- -----------------------------------------------------------------------------
with protected as (
  select instrument_id from ii_transactions
  union select instrument_id from ii_holding_snapshots
  union select instrument_id from ii_portfolio_truth_status
  union select instrument_id from ii_tax_lots
  union select instrument_id from ii_sip_series
  union select instrument_id from ii_capital_gains_computations
  union select instrument_id from ii_fhip_publications where instrument_id is not null
  union select instrument_id from ii_instrument_benchmarks
  union select instrument_id from ii_report_nav_dependencies
  union select instrument_id from ii_nav_retention_holds
  union select ii_canonical_instrument_id from investments where ii_canonical_instrument_id is not null
  union select merged_into_instrument_id from ii_instruments where merged_into_instrument_id is not null
  union select id from ii_instruments where merged_into_instrument_id is not null
),
per as (
  select p.instrument_id, count(*) as n, md5(string_agg(p.id::text, E'\n' order by p.id)) as h
  from ii_prices_nav p
  where p.price_date < date '2026-09-21'
    and not exists (select 1 from protected x where x.instrument_id = p.instrument_id)
  group by p.instrument_id
)
select count(*) as candidate_instruments, sum(n) as candidate_rows,
       md5(string_agg(instrument_id::text || ':' || n || ':' || h, E'\n' order by instrument_id)) as candidate_pk_checksum
from per;


-- -----------------------------------------------------------------------------
-- Q5 (PRODUCTION) -- the proposed canary, reproduced from the database.
-- Replace the list with manifest.json canary.instruments[*].instrument_id.
-- Expected: rows = canary.rows and pk_md5 = canary.primary_key_md5.
-- -----------------------------------------------------------------------------
-- select count(*) as rows, md5(string_agg(id::text, E'\n' order by id)) as pk_md5
-- from ii_prices_nav
-- where instrument_id in ('<id-1>', '<id-2>', '...') and price_date < date '2026-09-21';


-- -----------------------------------------------------------------------------
-- Q6 (PRODUCTION) -- logical/physical size baseline (P9 item 10). Read-only.
-- -----------------------------------------------------------------------------
select pg_size_pretty(pg_database_size(current_database())) as database_size,
       pg_size_pretty(pg_total_relation_size('ii_prices_nav')) as nav_total,
       pg_size_pretty(pg_relation_size('ii_prices_nav')) as nav_heap,
       pg_size_pretty(pg_indexes_size('ii_prices_nav')) as nav_indexes,
       pg_total_relation_size('ii_prices_nav') as nav_total_bytes;
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables where relname = 'ii_prices_nav';
select indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes where relname = 'ii_prices_nav' order by pg_relation_size(indexrelid) desc;


-- -----------------------------------------------------------------------------
-- Q7 (PRODUCTION) -- 0168 certification-hold proof in a ROLLED-BACK transaction.
-- Creates a synthetic user/account/instrument INSIDE the transaction, moves a
-- truth-status row through non-certifying -> certifying -> unchanged, reads the
-- hold count after each step, then ROLLS BACK. Nothing persists.
-- Run the whole block at once. Expected output rows:
--   trigger_present = 1, holds_after_noncertifying = 0, holds_after_certify = 1,
--   hold_reason = statement_reconciliation_in_progress, hold_days ~ 30,
--   holds_after_unchanged_update = 1, residue_after_rollback = 0 (last query).
-- -----------------------------------------------------------------------------
begin;
select count(*) as trigger_present
from pg_trigger where tgname = 'trg_pc6_hold_on_statement_acceptance' and not tgisinternal;
insert into auth.users (id, email, aud, role)
  values ('0168d000-0000-4000-8000-000000000168', 'nav1-0168-rollback@fhip-synthetic.test', 'authenticated', 'authenticated');
insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status)
  values ('0168d000-0000-4000-8000-00000000a168', 'NAV1 0168 rollback probe', 'mutual_fund', 'IN', 'INR', 'provisional');
insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name)
  values ('0168d000-0000-4000-8000-00000000b168', '0168d000-0000-4000-8000-000000000168', 'IN', 'INR', 'demat', 'NAV1 0168 rollback probe');
insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status)
  values ('0168d000-0000-4000-8000-000000000168', '0168d000-0000-4000-8000-00000000b168', '0168d000-0000-4000-8000-00000000a168', 'reconciliation_required');
select count(*) as holds_after_noncertifying from ii_nav_retention_holds where instrument_id = '0168d000-0000-4000-8000-00000000a168';
update ii_portfolio_truth_status set status = 'certified' where instrument_id = '0168d000-0000-4000-8000-00000000a168';
select count(*) as holds_after_certify, max(reason) as hold_reason,
       round(extract(epoch from max(expires_at) - now()) / 86400) as hold_days
from ii_nav_retention_holds where instrument_id = '0168d000-0000-4000-8000-00000000a168' and released_at is null;
update ii_portfolio_truth_status set status = 'certified' where instrument_id = '0168d000-0000-4000-8000-00000000a168';
select count(*) as holds_after_unchanged_update from ii_nav_retention_holds where instrument_id = '0168d000-0000-4000-8000-00000000a168';
rollback;
select (select count(*) from auth.users where id = '0168d000-0000-4000-8000-000000000168')
     + (select count(*) from ii_instruments where id = '0168d000-0000-4000-8000-00000000a168')
     + (select count(*) from ii_nav_retention_holds where instrument_id = '0168d000-0000-4000-8000-00000000a168') as residue_after_rollback;


-- -----------------------------------------------------------------------------
-- Q8 (PRODUCTION, after 0200 is applied) -- the grant fix is live.
-- Expected: service_role only (plus the owner), no anon/authenticated/PUBLIC.
-- -----------------------------------------------------------------------------
select p.proname, r.rolname
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
join pg_roles r on r.oid = a.grantee
where p.proname in ('pc6_nav_row_is_candidate', 'pc6_instrument_is_user_held', 'pc6_user_held_instrument_ids')
  and a.privilege_type = 'EXECUTE'
order by 1, 2;
-- (a grantee of 0 = PUBLIC does not join pg_roles; check it separately:)
select p.proname, bool_or(a.grantee = 0) as public_can_execute
from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where p.proname in ('pc6_nav_row_is_candidate', 'pc6_instrument_is_user_held', 'pc6_user_held_instrument_ids')
group by 1;
