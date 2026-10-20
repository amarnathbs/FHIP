// Migration 0270, replayed in an in-process Postgres (PGlite) with the few things they depend on stubbed. NOT DEV evidence: the
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

describe('0270: the monitoring snapshot returns the same figures with bounded table scans (NC-M1)', () => {
  let db: PGlite;
  const stripTime = (j: Record<string, unknown>) => ({ ...j, generated_at: null });
  const wideScans = (sql: string) => {
    const body = sql.slice(sql.indexOf('create or replace function nav2_monitoring_snapshot()'));
    const parts = body.split('from public.ii_prices_nav').slice(1);
    return parts.filter((p) => !/^\s*p\s+where p\.instrument_id = h\.instrument_id/.test(p) && !/^\s*p where p\.instrument_id = h\.instrument_id/.test(p)).length;
  };

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

  it('0262 (before): three table-wide scans of the price table; 0270 (after): two; the figures are identical, and equal to an independent count', async () => {
    const before = await snapshot();
    const expectedTotal = Number((await db.query<{ n: number }>('select count(*)::int as n from ii_prices_nav')).rows[0].n);
    const expectedHeld = Number((await db.query<{ n: number }>('select count(*)::int as n from ii_prices_nav where instrument_id in (select instrument_id from held_ids)')).rows[0].n);
    const expectedNonHeldPre = Number((await db.query<{ n: number }>("select count(*)::int as n from ii_prices_nav where price_date < date '2026-09-21' and instrument_id not in (select instrument_id from held_ids)")).rows[0].n);
    const storageBefore = before.storage as Record<string, { value: number }>;
    expect(storageBefore.nav_rows_total.value).toBe(expectedTotal);
    expect(storageBefore.nav_rows_of_held_instruments.value).toBe(expectedHeld);
    expect(storageBefore.nav_rows_non_held_before_policy_changeover.value).toBe(expectedNonHeldPre);
    expect(expectedNonHeldPre).toBeGreaterThan(0);

    expect(wideScans(MIG('0262_nav2_correction_events_and_monitoring.sql'))).toBe(3);
    const fixed = MIG('0270_nav2_monitoring_snapshot_bounded_cost.sql');
    expect(wideScans(fixed)).toBe(2);
    await db.exec(fixed);
    await db.exec(fixed); // idempotent
    const after = await snapshot();
    expect(stripTime(after)).toEqual(stripTime(before));
  });

  it('the fixed function still refuses a caller without the capability and keeps its grants', async () => {
    await db.exec(`create or replace function public.is_pc6_reference_data_admin() returns boolean language sql stable as $f$ select false $f$;`);
    await expect(snapshot()).rejects.toMatchObject({ code: '42501' });
    await db.exec(`create or replace function public.is_pc6_reference_data_admin() returns boolean language sql stable as $f$ select true $f$;`);
    const q = async (sql: string) => (await db.query<{ v: boolean }>(sql)).rows[0].v;
    expect(await q(`select has_function_privilege('authenticated', 'nav2_monitoring_snapshot()', 'execute') as v`)).toBe(true);
    expect(await q(`select has_function_privilege('anon', 'nav2_monitoring_snapshot()', 'execute') as v`)).toBe(false);
  });
});
