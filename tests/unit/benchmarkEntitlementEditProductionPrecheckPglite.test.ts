// Production precheck and manual backup for migration 0280 - proved on a replica of the state production is in BEFORE 0280:
// the whole ledger EXCEPT 0280, two approved entitlement records. The precheck must pass there, must fail loudly once 0280 is applied
// (negative control), and the backup query must return exactly the records. Evidence label: PGlite-verified, not run on production.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const PACK = path.join(ROOT, 'docs', 'benchmark-data', 'po_apply_entitlement_edit');
const MIG_NAME = '0280_bench1_entitlement_edit_revision.sql';
const strip = (sql: string) => sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const read = (f: string) => fs.readFileSync(path.join(PACK, f), 'utf8');
const trimSemi = (s: string) => s.replace(/;\s*$/, '');

const CAT = 'eeeeeeee-0000-0000-0000-00000000d001';
const APP = 'eeeeeeee-0000-0000-0000-00000000d002';
let db: PGlite;

async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const entry = (key: string) => ({ benchmark_key: key, official_name: `Precheck ${key}`, owner_name: 'Owner Ltd', official_identifier: key, asset_class: 'equity', country_code: 'IN', currency_code: 'INR', return_type: 'TRI', return_variant: 'total_return', frequency: 'business_daily', base_date: '1995-11-03', base_value: 1000, launch_date: '1996-04-22', history_start_date: '1996-04-22', history_class: 'live', calendar_code: 'IN_NSE', methodology_url: 'https://example.test/m', source_url: 'https://example.test/s', evidence_ref: 'fixture', evidence_retrieved_at: '2026-10-01' });

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f !== MIG_NAME).sort();
  for (const f of files) {
    await db.exec(strip(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  for (const u of [CAT, APP]) await db.exec(`insert into auth.users (id, email) values ('${u}', '${u.slice(-4)}@pre.test'); insert into admin_users (user_id) values ('${u}');`);
  await db.exec(`update admin_users set can_manage_benchmark_catalogue = true where user_id = '${CAT}'; update admin_users set can_approve_benchmark_entitlements = true where user_id = '${APP}';`);
  for (const key of ['PRE_ONE_TRI', 'PRE_TWO_TRI']) {
    const id = (await as(CAT, async () => (await db.query(`select upsert_benchmark_catalogue_entry($1::jsonb) as id`, [JSON.stringify(entry(key))])).rows[0])) as { id: string };
    const p = { benchmark_id: id.id, entitlement_kind: 'commercial_licence', return_variant: 'total_return', currency_code: 'INR', allow_manual_ingest: true, allow_storage: true, allow_calculation: true, valid_from: '2026-01-01', evidence_reference: 'Licence fixture' };
    const eid = (await as(CAT, async () => (await db.query(`select propose_benchmark_entitlement($1::jsonb) as id`, [JSON.stringify(p)])).rows[0])) as { id: string };
    await as(APP, () => db.query(`select approve_benchmark_entitlement($1::uuid, 'approved in the fixture', false)`, [eid.id]));
  }
}, 900_000);

afterAll(async () => {
  await db?.close();
});

const run = async () => (await db.query(trimSemi(read('production_precheck.sql')))).rows as Array<{ n: number; check_name: string; expected: string; actual: string; result: string }>;

describe('production precheck (read-only) on a replica of production before 0280', () => {
  it('passes every one of its 10 checks, including the two approved records', async () => {
    const rows = await run();
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(r.result, `${r.n} ${r.check_name}: expected ${r.expected}, actual ${r.actual}`).toBe('PASS');
  });

  it('changes nothing', async () => {
    const before = (await db.query(`select (select count(*) from ii_benchmark_entitlements) a, (select count(*) from ii_benchmark_governance_events) b, (select count(*) from pg_proc) c`)).rows[0];
    await run();
    expect((await db.query(`select (select count(*) from ii_benchmark_entitlements) a, (select count(*) from ii_benchmark_governance_events) b, (select count(*) from pg_proc) c`)).rows[0]).toEqual(before);
  });

  it('the backup query returns every record with every column', async () => {
    const res = await db.query(trimSemi(read('production_backup.sql')));
    expect(res.rows).toHaveLength(2);
    const cols = (await db.query(`select count(*)::int n from information_schema.columns where table_name = 'ii_benchmark_entitlements'`)).rows[0] as { n: number };
    expect(res.fields.length).toBe(cols.n);
  });

  it('both files pass the editor-safety lint', () => {
    expect(hazards(read('production_precheck.sql'))).toEqual([]);
    expect(hazards(read('production_backup.sql'))).toEqual([]);
  });

  it('NEGATIVE CONTROL: other states of production make named rows FAIL (a wrong record count, a leftover 0280 object, an extra approve function)', async () => {
    await db.exec(`update ii_benchmark_entitlements set status = 'revoked', revoked_by = created_by, revoked_at = now(), revoked_reason = 'temporary change for the control' where id = (select id from ii_benchmark_entitlements order by id limit 1)`);
    expect((await run()).filter((r) => r.result === 'FAIL').map((r) => r.n)).toEqual([8]);
    await db.exec(`update ii_benchmark_entitlements set status = 'approved' where status = 'revoked'`);
    await db.exec(`alter table ii_benchmark_entitlements add column edit_count integer`);
    expect((await run()).filter((r) => r.result === 'FAIL').map((r) => r.n)).toEqual([2, 3]);
    await db.exec('alter table ii_benchmark_entitlements drop column edit_count');
    await db.exec(`create function public.approve_benchmark_entitlement(a uuid, b text, c boolean, d integer) returns void language sql as 'select 1'`);
    expect((await run()).filter((r) => r.result === 'FAIL').map((r) => r.n)).toEqual([6]);
    await db.exec('drop function public.approve_benchmark_entitlement(uuid, text, boolean, integer)');
    expect((await run()).every((r) => r.result === 'PASS')).toBe(true);
  });

  it('once 0280 is applied the precheck refuses (so it cannot be mistaken for a post-check) and verify.sql passes', async () => {
    await db.exec(strip(fs.readFileSync(path.join(MIG_DIR, MIG_NAME), 'utf8')));
    const failed = (await run()).filter((r) => r.result === 'FAIL').map((r) => r.n);
    expect(failed).toEqual([2, 3, 4, 5, 6]);
    const verify = (await db.query(trimSemi(read('verify.sql')))).rows as Array<{ result: string }>;
    expect(verify).toHaveLength(12);
    expect(verify.every((r) => r.result === 'PASS')).toBe(true);
    // the two existing approved records are untouched by 0280
    expect(((await db.query(`select count(*)::int n from ii_benchmark_entitlements where status = 'approved'`)).rows[0] as { n: number }).n).toBe(2);
  });
});
