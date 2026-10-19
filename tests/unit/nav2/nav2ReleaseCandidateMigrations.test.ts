// NAV2 release candidate, phase C: the migrations that changed or were added after the Stage 3 pack, replayed in an in-process Postgres (PGlite).
// Evidence level: PGLITE-VERIFIED (not DEV, not production).
//
//   0261  the PRECONDITION GUARD: the retention function pc6_nav_row_is_candidate() is replaced only if the live text is the 0219 text or the 0261 text
//         (compared on a NORMALIZED checksum, so a re-formatted copy passes and a changed one stops); a stop changes NOTHING; behaviour of the
//         function for held, held-by-hold, report-pinned, after-changeover, gap-protected and null input; owner, arguments, return type, grants.
//   0281  the idempotency key columns, the shape constraint and the unique index; an issued report is still immutable.
//   0282  the ambiguity summary: authorisation inside, suppression below 5, only the cases this release opens, 90 day window.
//
// NAMED NEGATIVE CONTROLS
//   NC-G1  an unexpected live function body STOPS 0261 (P0001) and leaves the live function, and every table 0261 would create, exactly as they were;
//   NC-G2  the guard is NOT formatting sensitive: the 0219 text with different white space, case and comments is accepted although its raw md5 differs;
//   NC-G3  CONTROL: with the guard removed from a copy of 0261, the unexpected body IS overwritten (so the stop above is the guard's doing);
//   NC-G4  the function after 0261 protects everything the 0219 function protected, plus a pinned report range, and a NULL input is never a candidate;
//   NC-I1  0281: a key without a fingerprint, a short key and a key with a space are refused; the same key twice for one person is refused (23505 on the
//          named index); two people may share a key; many rows without a key are fine; an update of an issued report is still refused;
//   NC-A1  0282: an anonymous or non-admin caller gets 42501, never an empty result; fewer than 5 cases is "suppressed", never 0.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIG_DIR = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations');
const MIG = (name: string) => readFileSync(path.join(MIG_DIR, name), 'utf8');
const M0219 = '0219_nav1_merger_lineage_and_coverage_gaps.sql';
const M0261 = '0261_nav2_fund_analytics_reports_cache_and_pinning.sql';
const M0281 = '0281_nav2_report_idempotency_key.sql';
const M0282 = '0282_nav2_ambiguity_case_summary.sql';

/** The text of pc6_nav_row_is_candidate() as migration 0219 defines it (the production predecessor), ready to execute. */
function functionSql(file: string): string {
  const t = MIG(file);
  const start = t.search(/create or replace function pc6_nav_row_is_candidate\(/i);
  const m = /as\s+(\$[a-z]*\$)/i.exec(t.slice(start))!;
  const open = start + m.index + m[0].length - m[1].length;
  const close = t.indexOf(m[1], open + m[1].length);
  return t.slice(start, close + m[1].length) + ';';
}
const NORM = `md5(lower(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')))`;
const ROLES = `create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
  grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`;
/** Just enough of the older schema for the 0219 / 0261 functions to be created and run. */
const OLDER = `
  create table ii_instruments (id uuid primary key, merged_into_instrument_id uuid);
  create table ii_scheme_master (instrument_id uuid, merged_into_instrument_id uuid);
  create table ii_instrument_benchmarks (instrument_id uuid);
  create table ii_report_nav_dependencies (instrument_id uuid, nav_date_from date, nav_date_to date);
  create table ii_nav_retention_holds (instrument_id uuid, released_at timestamptz, expires_at timestamptz);
  create table ii_nav_source_coverage_gaps (instrument_id uuid, gap_from date, gap_to date, resolved_at timestamptz);
  create table held (instrument_id uuid primary key);
  create function pc6_instrument_is_user_held(p uuid) returns boolean language sql stable as $f$ select exists (select 1 from held h where h.instrument_id = p) $f$;
  create function is_pc6_reference_data_admin() returns boolean language sql stable as $f$ select coalesce(current_setting('test.admin', true), '') = 'yes' $f$;
`;
const I = { plain: '00000000-0000-4000-8000-000000000001', held: '00000000-0000-4000-8000-000000000002', hold: '00000000-0000-4000-8000-000000000003', pinned: '00000000-0000-4000-8000-000000000004', gap: '00000000-0000-4000-8000-000000000005' };

describe('0261: the retention function guard', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(ROLES);
    await db.exec(OLDER);
    await db.exec(`set check_function_bodies = off; ${functionSql(M0219)}`); // the production predecessor
    await db.exec(`insert into ii_instruments (id) values ('${I.plain}'), ('${I.held}'), ('${I.hold}'), ('${I.pinned}'), ('${I.gap}');
      insert into held values ('${I.held}');
      insert into ii_nav_retention_holds values ('${I.hold}', null, null);
      insert into ii_nav_source_coverage_gaps values ('${I.gap}', '2020-01-01', '2020-12-31', null);`);
  }, 120_000);
  afterEach(async () => {
    await db.close();
  });
  const live = async () => (await db.query<{ raw: string; norm: string; src: string }>(`select md5(p.prosrc) as raw, ${NORM} as norm, p.prosrc as src from pg_proc p where p.oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure`)).rows[0];
  const tablesExist = async () => (await db.query<{ n: number }>(`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'nav2%'`)).rows[0].n;
  const cand = async (id: string | null, date: string | null, change: string | null) => (await db.query<{ v: boolean }>(`select pc6_nav_row_is_candidate(${id ? `'${id}'` : 'null'}, ${date ? `'${date}'::date` : 'null'}, ${change ? `'${change}'::date` : 'null'}) as v`)).rows[0].v;

  it('the 0219 text is accepted (and so is a second run of 0261: the guard accepts its own text), every time, with the same shape', async () => {
    const before = await live();
    expect(before.raw).toBe('7806e43771e30a14ee55aac7d478c8fd'); // the raw md5 the Stage 3 pre-check P3 compares with
    await db.exec(MIG(M0261));
    const after1 = await live();
    expect(after1.norm).not.toBe(before.norm); // it really replaced it
    await db.exec(MIG(M0261));
    const after2 = await live();
    expect(after2).toEqual(after1);
    expect(await tablesExist()).toBeGreaterThanOrEqual(4);
  });

  it('NC-G1: an unexpected live body STOPS the file with P0001 and changes nothing: not the function, not any table', async () => {
    await db.exec(`create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date) returns boolean language sql stable as $f$ select true $f$;`);
    const before = await live();
    const tablesBefore = await tablesExist();
    await expect(db.exec(MIG(M0261))).rejects.toMatchObject({ code: 'P0001', message: expect.stringMatching(/0261 stopped/) });
    expect(await live()).toEqual(before);
    expect(await tablesExist()).toBe(tablesBefore);
    expect((await db.query(`select to_regclass('public.nav2_fund_analytics_reports') as t`)).rows[0]).toEqual({ t: null });
  });

  it('NC-G1b: a one-branch change to the 0219 text (an extra "or true") is also stopped', async () => {
    const tampered = functionSql(M0219).replace(/select coalesce\(not \(/i, 'select coalesce(not (true and (').replace(/, false\);/, '), false);');
    expect(tampered).not.toBe(functionSql(M0219));
    await db.exec(`set check_function_bodies = off; ${tampered}`);
    await expect(db.exec(MIG(M0261))).rejects.toMatchObject({ code: 'P0001' });
    expect(await tablesExist()).toBe(0);
  });

  it('NC-G2: the guard is not formatting sensitive: the 0219 text re-formatted (white space, case, comments) is accepted although its raw md5 differs', async () => {
    const reformatted = functionSql(M0219).replace(/\n\s+/g, '\n\n      ').replace(/select/g, 'SELECT').replace('with recursive', '-- an added comment\nwith recursive');
    await db.exec(`set check_function_bodies = off; ${reformatted}`);
    const l = await live();
    expect(l.raw).not.toBe('7806e43771e30a14ee55aac7d478c8fd');
    await db.exec(MIG(M0261)); // accepted
    expect(await tablesExist()).toBeGreaterThanOrEqual(4);
  });

  it('NC-G3 (control): with the guard cut out of a copy of 0261, the unexpected body IS overwritten, so the stop in NC-G1 is the guard\'s doing', async () => {
    await db.exec(`create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date) returns boolean language sql stable as $f$ select true $f$;`);
    const sql = MIG(M0261);
    const noGuard = sql.slice(0, sql.indexOf('do $guard$')) + sql.slice(sql.indexOf('end $guard$;') + 'end $guard$;'.length);
    expect(noGuard).not.toContain('do $guard$');
    await db.exec(noGuard);
    const l = await live();
    expect(l.src).toContain('merge_family'); // the 0261 text replaced the unexpected one
  });

  it('a database without the function at all (a fresh one) is accepted', async () => {
    await db.exec('drop function pc6_nav_row_is_candidate(uuid, date, date)');
    await db.exec(MIG(M0261));
    expect((await live()).norm).toBeTruthy();
  });

  it('NC-G4: after 0261 the function protects every case the 0219 function did, plus a pinned report range, and NULL is never a candidate', async () => {
    const old = {
      plain: await cand(I.plain, '2020-06-15', '2026-09-21'),
      held: await cand(I.held, '2020-06-15', '2026-09-21'),
      hold: await cand(I.hold, '2020-06-15', '2026-09-21'),
      after: await cand(I.plain, '2026-10-01', '2026-09-21'),
      gapIn: await cand(I.gap, '2020-06-15', '2026-09-21'),
      nul: await cand(null, null, null),
    };
    expect(old).toEqual({ plain: true, held: false, hold: false, after: false, gapIn: false, nul: false });
    await db.exec(MIG(M0261));
    const now = {
      plain: await cand(I.plain, '2020-06-15', '2026-09-21'),
      held: await cand(I.held, '2020-06-15', '2026-09-21'),
      hold: await cand(I.hold, '2020-06-15', '2026-09-21'),
      after: await cand(I.plain, '2026-10-01', '2026-09-21'),
      gapIn: await cand(I.gap, '2020-06-15', '2026-09-21'),
      gapOut: await cand(I.gap, '2021-06-15', '2026-09-21'),
      nul: await cand(null, null, null),
      nullPartial: await cand(I.plain, null, '2026-09-21'),
    };
    expect(now).toEqual({ plain: true, held: false, hold: false, after: false, gapIn: false, gapOut: true, nul: false, nullPartial: false });
    // the new protection: a finalised report pins a range of this instrument
    await db.exec(`insert into auth.users (id) values ('00000000-0000-4000-9000-0000000000aa');
      insert into nav2_fund_analytics_reports (user_id, version_number, as_of_date, reporting_currency, scheme_count, policy_version, engine_version, report_json, manifest_json, manifest_checksum)
      values ('00000000-0000-4000-9000-0000000000aa', 1, '2026-10-01', 'INR', 1, 'p', 'e', '{}', '{}', repeat('a', 64))`);
    const rid = (await db.query<{ id: string }>('select id from nav2_fund_analytics_reports limit 1')).rows[0].id;
    expect(await cand(I.pinned, '2021-03-10', '2026-09-21')).toBe(true);
    await db.exec(`insert into nav2_report_nav_dependencies (report_id, instrument_id, nav_date_from, nav_date_to) values ('${rid}', '${I.pinned}', '2021-01-01', '2021-12-31')`);
    expect(await cand(I.pinned, '2021-03-10', '2026-09-21')).toBe(false); // inside the pinned range: kept
    expect(await cand(I.pinned, '2022-03-10', '2026-09-21')).toBe(true); // outside: still a candidate
  });

  it('identity: arguments, return type, volatility, and who may call it (service role only)', async () => {
    await db.exec(MIG(M0261));
    const r = (await db.query<{ args: string; ret: string; vol: string; anon: boolean; auth: boolean; svc: boolean; owner: string }>(`
      select pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret, p.provolatile::text as vol,
             has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('service_role', p.oid, 'execute') as svc, pg_get_userbyid(p.proowner) as owner
        from pg_proc p where p.oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure`)).rows[0];
    expect(r).toMatchObject({ args: 'p_instrument_id uuid, p_price_date date, p_changeover_date date', ret: 'boolean', vol: 's', anon: false, auth: false, svc: true });
    expect(r.owner).toBeTruthy();
  });
});

describe('0281 and 0282', () => {
  let db: PGlite;
  const U1 = '00000000-0000-4000-9000-000000000001';
  const U2 = '00000000-0000-4000-9000-000000000002';
  const KEY1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const FP = 'a'.repeat(64);
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(ROLES);
    await db.exec(OLDER);
    await db.exec(`set check_function_bodies = off; ${functionSql(M0219)}`);
    await db.exec(MIG(M0261));
    await db.exec(`insert into auth.users (id) values ('${U1}'), ('${U2}');`);
  }, 120_000);
  afterEach(async () => {
    await db.close();
  });
  const insert = (user: string, version: number, key: string | null, fp: string | null) =>
    db.exec(`insert into nav2_fund_analytics_reports (user_id, version_number, as_of_date, reporting_currency, scheme_count, policy_version, engine_version, report_json, manifest_json, manifest_checksum, idempotency_key, request_fingerprint)
      values ('${user}', ${version}, '2026-10-01', 'INR', 1, 'p', 'e', '{}', '{}', repeat('b', 64), ${key ? `'${key}'` : 'null'}, ${fp ? `'${fp}'` : 'null'})`);

  it('NC-I1: 0281 is idempotent and keeps older rows untouched', async () => {
    // a report issued before 0281 has no key columns at all: the migration adds them to an existing row
    await db.exec(`insert into nav2_fund_analytics_reports (user_id, version_number, as_of_date, reporting_currency, scheme_count, policy_version, engine_version, report_json, manifest_json, manifest_checksum)
      values ('${U1}', 1, '2026-10-01', 'INR', 1, 'p', 'e', '{}', '{}', repeat('b', 64))`);
    await db.exec(MIG(M0281));
    await db.exec(MIG(M0281));
    const cols = (await db.query<{ column_name: string; is_nullable: string }>(`select column_name, is_nullable from information_schema.columns where table_name = 'nav2_fund_analytics_reports' and column_name in ('idempotency_key', 'request_fingerprint') order by 1`)).rows;
    expect(cols).toEqual([{ column_name: 'idempotency_key', is_nullable: 'YES' }, { column_name: 'request_fingerprint', is_nullable: 'YES' }]);
    expect((await db.query('select count(*)::int as n from nav2_fund_analytics_reports where idempotency_key is null')).rows[0]).toEqual({ n: 1 });
    expect((await db.query(`select count(*)::int as n from pg_indexes where indexname = 'uidx_nav2_reports_user_idempotency'`)).rows[0]).toEqual({ n: 1 });
    expect((await db.query(`select count(*)::int as n from pg_constraint where conname = 'nav2_reports_idempotency_shape'`)).rows[0]).toEqual({ n: 1 });
  });

  it('NC-I1: shape and uniqueness', async () => {
    await db.exec(MIG(M0281));
    await insert(U1, 1, KEY1, FP);
    await expect(insert(U1, 2, KEY1, FP)).rejects.toMatchObject({ code: '23505', message: expect.stringMatching(/uidx_nav2_reports_user_idempotency/) }); // same person, same key
    await insert(U2, 1, KEY1, FP); // another person may use the same key
    await insert(U1, 3, null, null); // many rows without a key
    await insert(U1, 4, null, null);
    await expect(insert(U1, 5, 'another-key-0000000000000000', null)).rejects.toMatchObject({ code: '23514' }); // key without fingerprint
    await expect(insert(U1, 5, null, FP)).rejects.toMatchObject({ code: '23514' }); // fingerprint without key
    await expect(insert(U1, 5, 'short', FP)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(U1, 5, 'has a space in it 0000000', FP)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(U1, 5, 'x'.repeat(65), FP)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(U1, 5, 'another-key-0000000000000000', 'not-hex')).rejects.toMatchObject({ code: '23514' });
  });

  it('an issued report is still immutable after 0281, including its key', async () => {
    await db.exec(MIG(M0281));
    await insert(U1, 1, KEY1, FP);
    await expect(db.exec(`update nav2_fund_analytics_reports set idempotency_key = null, request_fingerprint = null`)).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/immutable/) });
    await expect(db.exec(`update nav2_fund_analytics_reports set scheme_count = 9`)).rejects.toMatchObject({ code: '42501' });
  });

  describe('0282', () => {
    const reason = 'ISIN INF000000001 and AMFI scheme code 100001 point at different instruments; the match is refused until a reviewer decides.';
    beforeEach(async () => {
      await db.exec(`
        create table ii_reconciliation_cases (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null default 'open', discrepancy_type text not null, discrepancy_details jsonb, opened_at timestamptz not null default now());
        create function nav2_monitor_cell(p_value bigint, p_user_derived boolean) returns jsonb language sql immutable as $f$
          select case when p_value is null then jsonb_build_object('state', 'unavailable') when p_user_derived and p_value < 5 then jsonb_build_object('state', 'suppressed', 'value', null) else jsonb_build_object('state', 'ok', 'value', p_value) end $f$;
      `);
      await db.exec(MIG(M0282));
    });
    const summary = async (admin: boolean, uid: string | null = U1) => {
      await db.exec(`select set_config('test.uid', '${uid ?? ''}', false); select set_config('test.admin', '${admin ? 'yes' : 'no'}', false);`);
      return (await db.query<{ s: Record<string, { state: string; value: number | null }> }>('select nav2_ambiguity_case_summary() as s')).rows[0].s;
    };
    const cases = (n: number, o: { type?: string; reasonText?: string; ageDays?: number; status?: string; user?: string } = {}) =>
      db.exec(`insert into ii_reconciliation_cases (user_id, status, discrepancy_type, discrepancy_details, opened_at)
        select '${o.user ?? U1}', '${o.status ?? 'open'}', '${o.type ?? 'ambiguous_instrument'}', jsonb_build_object('reason', '${o.reasonText ?? reason}'), now() - interval '${o.ageDays ?? 1} days' from generate_series(1, ${n})`);

    it('NC-A1: a non-admin and an anonymous caller get 42501, never an empty result', async () => {
      await expect(summary(false)).rejects.toMatchObject({ code: '42501' });
      await expect(summary(true, null)).rejects.toMatchObject({ code: '42501' });
      expect((await db.query(`select has_function_privilege('anon', 'nav2_ambiguity_case_summary()', 'execute') as a, has_function_privilege('authenticated', 'nav2_ambiguity_case_summary()', 'execute') as b`)).rows[0]).toEqual({ a: false, b: true });
    });

    it('fewer than 5 is suppressed (not 0); 5 and more is shown; only this release\'s cases within 90 days are counted', async () => {
      const none = await summary(true);
      expect(none.opened_last_30_days).toMatchObject({ state: 'suppressed', value: null }); // zero cases is still "suppressed", never a bare 0
      await cases(4);
      expect((await summary(true)).opened_last_7_days.state).toBe('suppressed');
      await cases(1);
      const five = await summary(true);
      expect(five.opened_last_7_days).toMatchObject({ state: 'ok', value: 5 });
      expect(five.still_open).toMatchObject({ state: 'ok', value: 5 });
      // not counted: the AI path's ambiguity (different reason), another type, and older than 90 days
      await cases(9, { reasonText: 'Multiple instruments share ISIN INF000000002.' });
      await cases(9, { type: 'transaction_unclassified' });
      await cases(9, { ageDays: 120 });
      const after = await summary(true);
      expect(after.opened_last_90_days).toMatchObject({ state: 'ok', value: 5 });
      // windows: 7 / 30 / 90 days and still open
      await cases(5, { ageDays: 20, status: 'resolved' });
      await cases(5, { ageDays: 60, status: 'dismissed' });
      const w = await summary(true);
      expect([w.opened_last_7_days.value, w.opened_last_30_days.value, w.opened_last_90_days.value, w.still_open.value]).toEqual([5, 10, 15, 5]);
    });

    it('counts distinct people (suppressed below 5 people) and returns nothing identifying', async () => {
      await cases(6, { user: U1 });
      const s = await summary(true);
      expect(s.people_affected_last_90_days.state).toBe('suppressed'); // one person: not shown
      expect(JSON.stringify(s)).not.toContain(U1);
      expect(JSON.stringify(s)).not.toMatch(/INF0000|100001/);
    });
  });
});
