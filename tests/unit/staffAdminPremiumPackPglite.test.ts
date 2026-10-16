// Staff admin Premium -- the PO hand-over pack, run exactly as the PO will run it, on a copy of the database as it is BEFORE 0283.
//
//   D1 preview (before the migration) -> parts 0283a, 0283b, 0283c one at a time -> V0283 -> B2 preview -> B1 backup -> B3 backfill
//   -> V_after_backfill -> V_compare_with_backup, and every part and the backfill run a SECOND time (nothing may change).
//
// Also proves: every read only file really writes nothing, no file shows a full e-mail address, the migration is the byte-for-byte
// concatenation of its parts, every file passes the SQL editor lint, and the numbering is clean.
//
// EVIDENCE LABEL: PGlite replay. Not DEV-verified, not production-verified.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../../scripts/migration_editor_safety_lint.mjs';
import { MIGRATION } from '../../scripts/staff_premium_build_migration.mjs';
import { MIG_DIR, REPO_ROOT, expectNamedFailure, replayAll } from './support/promoTestHelpers';

// Real-Postgres replay tests: give each test room when the machine is busy with a full parallel run (the 5 s default is too short).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

const PACK = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_staff_premium');
const file = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const part = (n: string) => file(`parts/${n}.sql`);

let db: PGlite;
type Row = Record<string, unknown>;
// A file may hold several statements (B1 does): run them all and return the rows of the LAST one, which is what the SQL editor shows.
const run = async (sql: string): Promise<Row[]> => {
  const res = await db.exec(sql);
  return (res[res.length - 1]?.rows ?? []) as Row[];
};
const snapshot = async () => JSON.stringify([(await run('select * from user_entitlements order by user_id')), (await run('select * from admin_users order by user_id')), (await run('select * from resource_user_roles order by id'))]);

const U = (n: number) => `cccccccc-7000-0000-0000-${String(n).padStart(12, '0')}`;
const ids = { free: U(1), grant: U(2), promo: U(3), paid: U(4), role: U(5), customer: U(6), inactive: U(7), lapsed: U(8) };

beforeAll(async () => {
  db = await PGlite.create();
  // the database as it is today: every migration up to and including 0280, no 0283
  await replayAll(db, '0280_bench1_entitlement_edit_revision.sql');
  for (const [k, id] of Object.entries(ids)) await db.exec(`insert into auth.users(id,email) values ('${id}','${k}person@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${ids.free}'),('${ids.grant}'),('${ids.promo}'),('${ids.paid}'),('${ids.lapsed}');`);
  await db.exec(`insert into resource_user_roles(user_id, role, is_active) values ('${ids.role}','editor',true),('${ids.inactive}','author',false);`);
  await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-3, effective_to=current_date+40, admin_grant_ends_on=current_date+40, reserve_source='admin_grant', admin_lifetime_grant_units=4 where user_id='${ids.grant}'`);
  await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='promo_code', effective_from=current_date-3, effective_to=current_date+40, admin_grant_ends_on=current_date+40, reserve_source='promo_code' where user_id='${ids.promo}'`);
  await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='payment', provider='stripe', provider_customer_id='cus_1', provider_subscription_id='sub_1', subscription_status='active' where user_id='${ids.paid}'`);
  await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-60, effective_to=current_date-5, admin_grant_ends_on=current_date-5, reserve_source='admin_grant' where user_id='${ids.lapsed}'`);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('the files', () => {
  it('the migration is the byte-for-byte concatenation of its three parts (and the build script agrees)', () => {
    const joined = Buffer.concat(MIGRATION.parts.map((p: string) => fs.readFileSync(path.join(PACK, 'parts', `${p}.sql`))));
    expect(joined.equals(fs.readFileSync(path.join(MIG_DIR, MIGRATION.file)))).toBe(true);
  });

  it('NEGATIVE CONTROL -- one changed byte in a part breaks the equality (assertion "parts equal the migration" goes red)', async () => {
    const bad = Buffer.from(part('0283b'));
    bad[bad.length - 5] = bad[bad.length - 5] === 0x20 ? 0x21 : 0x20;
    const parts = [Buffer.from(part('0283a')), bad, Buffer.from(part('0283c'))];
    const whole = fs.readFileSync(path.join(MIG_DIR, MIGRATION.file));
    await expectNamedFailure(() => expect(Buffer.concat(parts).equals(whole), 'parts equal the migration').toBe(true), 'parts equal the migration');
  });

  it('each part starts on its banner and ends on a completed statement, so each can be pasted alone', () => {
    ['0283a', '0283b', '0283c'].forEach((p, i) => {
      const sql = part(p);
      if (i === 0) expect(sql.startsWith('-- 0283 ')).toBe(true);
      else expect(sql).toMatch(new RegExp(`^-- -{20,}\\n-- PART ${String.fromCharCode(65 + i)} starts here`));
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      expect(code.endsWith(';'), `${p} ends on a completed statement`).toBe(true);
      expect((code.match(/\$fn\$/g) ?? []).length % 2, `${p}: balanced dollar quotes`).toBe(0);
    });
  });

  it('every SQL file of the pack, and the migration, passes the SQL editor lint (the DEV editor mis-parses the statement words in comments and strings)', () => {
    const files: string[] = [path.join(MIG_DIR, MIGRATION.file)];
    for (const dir of ['parts', 'checks', 'backfill', 'rollback']) for (const f of fs.readdirSync(path.join(PACK, dir))) if (f.endsWith('.sql')) files.push(path.join(PACK, dir, f));
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const f of files) expect(hazards(fs.readFileSync(f, 'utf8')), path.relative(REPO_ROOT, f)).toEqual([]);
  });

  it('the read only files contain no statement that can write', () => {
    for (const f of ['checks/D1_preview_before_migration_READONLY.sql', 'checks/V0283_after_migration.sql', 'checks/V_after_backfill.sql', 'checks/V_compare_with_backup.sql', 'checks/V_compare_list_changed_ids.sql', 'backfill/B2_preview_READONLY.sql']) {
      // comments and text in quotes are not statements (the files say things like "admin grant")
      const code = file(f)
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .replace(/'(?:[^']|'')*'/g, "''");
      expect(code, f).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i);
    }
  });

  it('numbering: 0283 is unique, above everything on main (0280), and clear of NAV2 (0281, 0282) and of every other file in the repository', () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_/.test(f));
    expect(files.filter((f) => f.startsWith('0283_'))).toEqual([MIGRATION.file]);
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(283);
    expect(files.some((f) => f.startsWith('0281_') || f.startsWith('0282_'))).toBe(false);
  });

  it('the earlier source rule is only WIDENED: every value the predecessor (0237) allowed is still in the new rule', () => {
    const pred = fs.readFileSync(path.join(MIG_DIR, '0237_admin_promo_codes_extension_cap_expiry_summary.sql'), 'utf8').match(/entitlement_source in \(([^)]*)\)\)/)![1];
    const next = part('0283a').match(/check \(entitlement_source in \(([^)]*)\)\)/)![1];
    const set = (s: string) => s.split(',').map((x) => x.trim().replace(/'/g, ''));
    for (const v of set(pred)) expect(set(next)).toContain(v);
    expect(set(next)).toContain('staff_admin');
  });

  it('NEGATIVE CONTROL -- a widening that dropped promo_code (the sibling-branch trap) is caught (assertion "no earlier value is lost" goes red)', async () => {
    const pred = ['payment', 'admin_grant', 'promo_code'];
    const broken = "check (entitlement_source in ('payment', 'admin_grant', 'staff_admin'))".match(/in \(([^)]*)\)/)![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    await expectNamedFailure(() => {
      for (const v of pred) expect(broken, 'no earlier value is lost').toContain(v);
    }, 'no earlier value is lost');
  });
});

describe('the written hand-over', () => {
  const docs = ['README.md', 'PRODUCTION_RUNBOOK.md'];

  it('every file the README and the runbook name exists in the pack or the repository', () => {
    for (const d of docs) {
      const text = file(d);
      const named = [...text.matchAll(/`((?:parts|checks|backfill|rollback|supabase\/migrations)\/[A-Za-z0-9_./-]+\.sql)`/g)].map((m) => m[1]);
      expect(named.length, `${d} names files`).toBeGreaterThan(3);
      for (const n of named) {
        const full = n.startsWith('supabase/') ? path.join(REPO_ROOT, n) : path.join(PACK, n);
        expect(fs.existsSync(full), `${d} names ${n}`).toBe(true);
      }
    }
  });

  it('dates are day first (no ISO or US order), both projects are named, and production is separated from DEV', () => {
    for (const d of docs) expect(file(d), d).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    const readme = file('README.md');
    expect(readme).toContain('vqycarelcoijzwlpkpcz');
    expect(readme).toContain('twwpnltizhtjxhamyoxt');
    expect(readme).toContain('PRODUCTION_RUNBOOK.md');
    expect(file('PRODUCTION_RUNBOOK.md')).toMatch(/no managed backups/i);
    expect(file('PRODUCTION_RUNBOOK.md').indexOf('B1_backup')).toBeLessThan(file('PRODUCTION_RUNBOOK.md').indexOf('B3_run_backfill'));
  });

  it('the backup step comes before the backfill in the README order too', () => {
    const r = file('README.md');
    expect(r.indexOf('B1_backup_user_entitlements.sql')).toBeLessThan(r.indexOf('B3_run_backfill.sql'));
    expect(r.indexOf('B2_preview_READONLY.sql')).toBeLessThan(r.indexOf('B3_run_backfill.sql'));
  });
});

describe('the PO runs the pack (DEV and production use the same files)', () => {
  let d1Before = '';

  it('D1 (before the migration): every prerequisite is true, the staff list is right, e-mail is masked, and nothing is written', async () => {
    const before = await snapshot();
    const rows = await run(file('checks/D1_preview_before_migration_READONLY.sql'));
    expect(await snapshot(), 'D1 is read only').toBe(before);
    const a = rows.filter((r) => r.section === 'A prerequisites');
    expect(a.length).toBe(6);
    expect(a.every((r) => r.ok === true), JSON.stringify(a.filter((r) => r.ok !== true))).toBe(true);
    const b = rows.filter((r) => r.section === 'B staff accounts');
    expect(b.length, 'five Super Admins plus one editor').toBe(6);
    const by = (id: string) => String(b.find((r) => r.user_id === id)?.detail);
    expect(by(ids.free)).toContain('would: start Staff Premium');
    expect(by(ids.grant)).toContain('REPLACING an active admin grant');
    expect(by(ids.promo)).toContain('REPLACING an active promo');
    expect(by(ids.paid)).toContain('keep, a paid subscription');
    expect(by(ids.lapsed)).toContain('would: start Staff Premium');
    expect(by(ids.role)).toContain('resource role: editor');
    expect(b.some((r) => r.user_id === ids.customer || r.user_id === ids.inactive), 'a customer and an inactive role are never listed').toBe(false);
    for (const r of b) expect(String(r.masked_email)).toMatch(/^.{2}\*\*\*@pg\.test$/);
    expect(JSON.stringify(rows)).not.toContain('person@pg.test');
    d1Before = JSON.stringify(b.map((r) => [r.user_id, r.detail]));
  });

  it('parts A, B, C are applied one at a time, and every part can be applied a second time', async () => {
    for (const p of ['0283a', '0283b', '0283c']) {
      await db.exec(part(p));
      await db.exec(part(p)); // run again: must not fail and must not change anything of substance
    }
    expect(((await run(`select count(*)::int c from user_entitlements where entitlement_source='staff_admin'`))[0] as { c: number }).c, 'the migration alone backfills nothing').toBe(0);
    expect(((await run(`select count(*)::int c from staff_premium_events`))[0] as { c: number }).c).toBe(0);
  });

  it('V0283 after the migration: every check is true', async () => {
    const before = await snapshot();
    const rows = await run(file('checks/V0283_after_migration.sql'));
    expect(await snapshot()).toBe(before);
    expect(rows.length).toBe(15);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });

  it('B2 preview agrees with D1 and writes nothing', async () => {
    const before = await snapshot();
    const evBefore = ((await run(`select count(*)::int c from staff_premium_events`))[0] as { c: number }).c;
    const rows = await run(file('backfill/B2_preview_READONLY.sql'));
    expect(await snapshot()).toBe(before);
    expect(((await run(`select count(*)::int c from staff_premium_events`))[0] as { c: number }).c).toBe(evBefore);
    const planned = Object.fromEntries(rows.map((r) => [r.user_id as string, r.planned as string]));
    expect(planned[ids.free]).toBe('start');
    expect(planned[ids.grant]).toBe('start_replacing_admin_grant');
    expect(planned[ids.promo]).toBe('start_replacing_promo_code');
    expect(planned[ids.paid]).toBe('keep_paid');
    expect(planned[ids.lapsed]).toBe('start');
    expect(planned[ids.role]).toBe('start');
    expect(Object.keys(planned).sort()).toEqual([ids.free, ids.grant, ids.promo, ids.paid, ids.lapsed, ids.role].sort());
    expect(d1Before.length).toBeGreaterThan(10);
  });

  it('B1 backup: a private copy, equal row counts, no access for website roles, and it refuses to run twice', async () => {
    const rows = await run(file('backfill/B1_backup_user_entitlements.sql'));
    expect(rows[0]).toMatchObject({ ok: true });
    const acl = await run(`select has_table_privilege('authenticated','private.bk_user_entitlements_before_staff_premium','select') a, has_table_privilege('anon','private.bk_user_entitlements_before_staff_premium','select') b`);
    expect(acl[0]).toEqual({ a: false, b: false });
    await expect(db.exec(file('backfill/B1_backup_user_entitlements.sql'))).rejects.toThrow(/already exists/);
  });

  it('B3 backfill: starts exactly the accounts the preview named, leaves the paid one alone, and a second run changes nothing', async () => {
    const rows = await run(file('backfill/B3_run_backfill.sql'));
    const result = Object.fromEntries(rows.map((r) => [r.user_id as string, r.result as string]));
    expect(result[ids.free]).toBe('started');
    expect(result[ids.grant]).toBe('started');
    expect(result[ids.promo]).toBe('started');
    expect(result[ids.lapsed]).toBe('started');
    expect(result[ids.role]).toBe('started');
    expect(result[ids.paid]).toBe('kept_paid');
    const snap = await snapshot();
    const again = await run(file('backfill/B3_run_backfill.sql'));
    expect(again.every((r) => r.result === 'kept' || r.result === 'kept_paid')).toBe(true);
    expect(await snapshot(), 'the second run changes nothing').toBe(snap);
    // re-applying the parts afterwards does not disturb the data either
    for (const p of ['0283a', '0283b', '0283c']) await db.exec(part(p));
    expect(await snapshot()).toBe(snap);
  });

  it('V_after_backfill: every check is true', async () => {
    const rows = await run(file('checks/V_after_backfill.sql'));
    expect(rows.length).toBe(7);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    expect(rows[0].actual).toBe('6');
    expect(rows[1].actual).toBe('5');
  });

  it('V_compare_with_backup: no non-staff row changed, no consumer counter changed, the replaced grant is still counted', async () => {
    const rows = await run(file('checks/V_compare_with_backup.sql'));
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    expect(rows[1].actual, 'five accounts were turned into Staff Premium').toBe('5');
    expect(((await run(`select admin_lifetime_grant_units n from user_entitlements where user_id='${ids.grant}'`))[0] as { n: number }).n).toBe(4);
    expect(await run(file('checks/V_compare_list_changed_ids.sql'))).toEqual([]);
  });

  it('NEGATIVE CONTROL -- V_after_backfill goes red when a staff account is left without Premium (assertion "no staff account is missed" goes red)', async () => {
    await db.exec('alter table user_entitlements disable trigger trg_staff_premium_guard');
    await db.exec(`update user_entitlements set plan_tier='free', entitlement_source='payment' where user_id='${ids.role}'`);
    await db.exec('alter table user_entitlements enable trigger trg_staff_premium_guard');
    const rows = await run(file('checks/V_after_backfill.sql'));
    await expectNamedFailure(() => expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name), 'no staff account is missed').toEqual([]), 'no staff account is missed');
    await db.exec(`select * from public.staff_premium_reconcile(false)`);
    const fixed = await run(file('checks/V_after_backfill.sql'));
    expect(fixed.filter((r) => r.ok !== true)).toEqual([]);
  });

  it('NEGATIVE CONTROL -- V_after_backfill goes red when an ordinary customer holds a staff row (assertion "no customer holds a staff row" goes red)', async () => {
    await db.exec('alter table user_entitlements disable trigger trg_staff_premium_guard');
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='staff_admin' where user_id='${ids.customer}'`);
    await db.exec('alter table user_entitlements enable trigger trg_staff_premium_guard');
    const rows = await run(file('checks/V_after_backfill.sql'));
    await expectNamedFailure(() => expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name), 'no customer holds a staff row').toEqual([]), 'no customer holds a staff row');
    // the pack's own answer: the reconcile lists it for ending, the backfill returns it to Free
    expect((await run(`select planned from public.staff_premium_reconcile(true) where user_id='${ids.customer}'`))[0]).toEqual({ planned: 'end' });
    await db.exec(`select * from public.staff_premium_reconcile(false)`);
    expect((await run(`select plan_tier t from user_entitlements where user_id='${ids.customer}'`))[0]).toEqual({ t: 'free' });
  });
});
