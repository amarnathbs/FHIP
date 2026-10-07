// Migration 0271 (the second step after 0270), replayed in an in-process Postgres (PGlite) with the few things they depend on stubbed. NOT DEV evidence: the
// timing of the monitoring function and the effect of the policy can only be shown on DEV once the SQL is applied (hand-over).
//
//   NC-M1  0270: the new monitoring function returns exactly the same figures as the 0262 function on a data set with held and non-held
//          instruments on both sides of the changeover, and it scans the price table table-wide at most twice (0262 did three times).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIG = (name: string) => readFileSync(path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations', name), 'utf8');
const U = { premium: '00000000-0000-0000-0000-000000000001', free: '00000000-0000-0000-0000-000000000002', lapsed: '00000000-0000-0000-0000-000000000003', future: '00000000-0000-0000-0000-000000000004', openEnded: '00000000-0000-0000-0000-000000000005', endsToday: '00000000-0000-0000-0000-000000000006' };
const ROLES = `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;`;

describe('0271: the monitoring snapshot stops counting the whole price table exactly (NC-M2, Stage 3 second finding)', () => {
  let db: PGlite;
  const stripTime = (j: Record<string, unknown>) => ({ ...j, generated_at: null });
  const unboundedTotalCount = (sql: string) => (sql.slice(sql.indexOf('create or replace function nav2_monitoring_snapshot()')).match(/count\(\*\) into v_nav_rows from public\.ii_prices_nav;/g) ?? []).length;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(ROLES);
    await db.exec(`
      create function public.is_pc6_reference_data_admin() returns boolean language sql stable as $f$ select true $f$;
      create table ii_prices_nav (id serial primary key, instrument_id uuid not null, price_date date not null, price numeric not null default 1, unique (instrument_id, price_date));
      create table held_ids (instrument_id uuid primary key);
      create function public.pc6_user_held_instrument_ids() returns table (instrument_id uuid) language sql stable as $f$ select h.instrument_id from held_ids h $f$;
      create table ii_nav_hydration_attempts (instrument_id uuid primary key, last_attempted_at timestamptz not null default now(), last_outcome text not null default 'hydrated', consecutive_failures int not null default 0);
      create table nav2_result_cache (cache_key text primary key, invalidated_at timestamptz);
      create table nav2_fund_analytics_reports (id serial primary key, created_at timestamptz not null default now(), state_counts jsonb not null default '{}');
      create table ii_risk_free_series (series_id text primary key, enabled boolean not null default true, terms_review_status text, cadence text not null default 'weekly_auction', max_staleness_days int not null default 21, verified_through_date date);
      create table ii_risk_free_observations (id serial primary key, series_id text not null, observation_date date not null, kind text not null default 'value');
      create table ii_benchmarks (id uuid primary key default gen_random_uuid());
      create table ii_benchmark_series (id serial primary key, benchmark_id uuid not null, series_date date);
      create table ii_reference_corrections (id uuid primary key default gen_random_uuid(), target_table text, target_row_id uuid);
      create table ii_risk_free_corrections (id uuid primary key default gen_random_uuid(), series_id text, observation_date date);
      grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    `);
    await db.exec(MIG('0262_nav2_correction_events_and_monitoring.sql'));
    // 8 instruments: 6 held (the figure is withheld below 5), 2 not held; rows before and after the changeover (2026-09-21)
    await db.exec(`
      insert into held_ids select ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid from generate_series(1, 6) g;
      insert into ii_prices_nav (instrument_id, price_date)
        select ('00000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, d::date
          from generate_series(1, 8) i, generate_series(date '2026-08-20', date '2026-10-04', interval '1 day') d
         where (i * 7 + extract(day from d)::int) % 3 <> 0;
      insert into nav2_fund_analytics_reports default values;
    `);
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  const snapshot = async () => {
    await db.exec(`select set_config('test.uid', '${U.premium}', false);`);
    return (await db.query<{ s: Record<string, unknown> }>('select nav2_monitoring_snapshot() as s')).rows[0].s;
  };

  it('0270 still counts the whole table exactly (the cause on DEV); 0271 does not. After an ANALYZE the figures equal 0270, the estimated ones are labelled approximate, and a never-analysed table shows them as unavailable, never a number', async () => {
    await db.exec(MIG('0270_nav2_monitoring_snapshot_bounded_cost.sql'));
    const exact = await snapshot();
    expect(unboundedTotalCount(MIG('0270_nav2_monitoring_snapshot_bounded_cost.sql'))).toBe(1);
    const fixed = MIG('0271_nav2_monitoring_snapshot_row_estimate.sql');
    expect(unboundedTotalCount(fixed)).toBe(0);
    await db.exec(fixed);
    await db.exec(fixed); // idempotent
    await db.exec('analyze ii_prices_nav');
    const est = await snapshot();
    const s0 = exact.storage as Record<string, Record<string, unknown>>;
    const s1 = est.storage as Record<string, Record<string, unknown>>;
    expect(s1.nav_rows_total.value).toBe(s0.nav_rows_total.value);
    expect(s1.nav_rows_non_held_before_policy_changeover.value).toBe(s0.nav_rows_non_held_before_policy_changeover.value);
    expect(s1.nav_rows_of_held_instruments).toEqual(s0.nav_rows_of_held_instruments); // exact, unlabelled
    expect(s1.nav_rows_total.approximate).toBe(true);
    expect(s1.nav_rows_non_held_before_policy_changeover.approximate).toBe(true);
    expect(s0.nav_rows_total.approximate).toBeUndefined();
    expect({ ...est, storage: null, generated_at: null }).toEqual({ ...exact, storage: null, generated_at: null }); // everything else identical
    // never analysed: reltuples is -1, so the two estimated cells are unavailable
    await db.exec(`update pg_class set reltuples = -1 where oid = 'public.ii_prices_nav'::regclass`);
    const never = (await snapshot()).storage as Record<string, Record<string, unknown>>;
    expect(never.nav_rows_total.state).toBe('unavailable');
    expect(never.nav_rows_total.value).toBeNull();
    expect(never.nav_rows_non_held_before_policy_changeover.state).toBe('unavailable');
    expect(never.nav_rows_of_held_instruments.state).toBe('ok');
    void stripTime;
  });
});
