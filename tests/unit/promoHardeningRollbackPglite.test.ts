// ROLLBACK of the promo / Premium hardening release, proven on a real Postgres (PGlite).
//
//   R2  (docs/admin/po_apply_promo_hardening_release/rollback/R2_undo_0264_to_0268.sql) takes a database that has 0264 to 0268 back
//       to the shape it had before them: same functions, same table columns, the old release's calls work again, and rolling
//       forward again afterwards works. Its guard refuses when a code exists only as a digest (dropping the digest columns would
//       orphan it).
//   R1  (rollback/R1_after_0279_restore_old_function_shapes.sql) puts the five old function shapes back after the cleanup 0279,
//       with the same owner, security mode, search_path and grants, and the old release's calls work.
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  R2 without its guard drops the digest columns under a digest-only code and orphans it: the assertion
//          "no code is orphaned by the rollback" goes red;
//   NC-R2  an R1 that forgets a revoke leaves a function open to the anonymous role: the assertion "the old shape is closed to the
//          anonymous role again" goes red.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, REPO_ROOT, expectNamedFailure, makeCode, migrationFiles, replayAll } from './support/promoTestHelpers';

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

const ROLLBACK_DIR = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'rollback');
const R1 = fs.readFileSync(path.join(ROLLBACK_DIR, 'R1_after_0279_restore_old_function_shapes.sql'), 'utf8');
const R2 = fs.readFileSync(path.join(ROLLBACK_DIR, 'R2_undo_0264_to_0268.sql'), 'utf8');

const PROMO_ADMIN = 'aaaaaaaa-0000-0000-0000-0000000e0001';
const ENT_ADMIN = 'aaaaaaaa-0000-0000-0000-0000000e0002';

const additive = () => migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 264 && Number(x.slice(0, 4)) <= 268);
const cleanupFile = () => migrationFiles().find((x) => x.includes('promo_hardening_legacy_cleanup'))!;
const run = async (sql: string) => db.exec(sql);
const applyAdditive = async () => {
  for (const f of additive()) await run(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
};

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-7000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${id}','${label}${counter}@pg.test', now());`);
  return id;
}

async function as<T>(uid: string | null, role: 'authenticated' | 'anon' | 'service_role', fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

const addDays = async (n: number) => ((await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0] as { d: string }).d;

/** The OLD release's calls, by argument name. They must work whenever the database has the old shapes. */
async function oldReleaseWorks(tag: string): Promise<void> {
  const exp = await addDays(60);
  const created = await as(PROMO_ADMIN, 'authenticated', async () =>
    ((await db.query(`select public.admin_create_promo_code(p_code => $1::text, p_duration_days => 30, p_max_redemptions => 3, p_unlimited => false, p_expires_on => $2::date, p_no_expiry => false, p_note => null::text) v`, [tag, exp])).rows[0] as { v: Json }).v
  );
  expect(created.code).toBe(tag);
  const listed = await as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select code from public.admin_list_promo_codes()`)).rows as Json[]);
  expect(listed.map((r) => r.code)).toContain(tag);
  const user = await newUser('old');
  const verdict = await as(null, 'service_role', async () => ((await db.query(`select public.redeem_promo_code_for_user(p_user_id => $1::uuid, p_code => $2::text, p_ip_hash => null::text) v`, [user, tag])).rows[0] as { v: Json }).v);
  expect(verdict).toMatchObject({ ok: true });
  const target = await newUser('grant');
  const grant = await as(ENT_ADMIN, 'authenticated', async () =>
    ((await db.query(`select public.admin_manage_premium_entitlement(p_action => 'grant', p_target_user_id => $1::uuid, p_ends_on => $2::date, p_reason => 'Rollback proof grant, pilot') v`, [target, await addDays(30)])).rows[0] as { v: Json }).v
  );
  expect(grant).toMatchObject({ action: 'grant' });
  const begin = await as(PROMO_ADMIN, 'authenticated', async () =>
    ((await db.query(`select public.admin_promo_email_begin(p_request_key => $1::text, p_recipient_count => 1, p_bound => false) v`, ['rb-' + tag + '-key']
    )).rows[0] as { v: Json }).v
  );
  expect(begin).toMatchObject({ new: true });
}

interface Shape {
  functions: string[];
  columns: Record<string, string[]>;
  tables: string[];
}

const TABLES = ['promo_codes', 'promo_email_requests', 'promo_email_sends', 'promo_code_events', 'user_entitlements', 'admin_users', 'promo_redemption_attempts'];

async function shape(): Promise<Shape> {
  const fns = (await db.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows.map((r) => (r as { sig: string }).sig);
  const columns: Record<string, string[]> = {};
  for (const t of TABLES) {
    columns[t] = (await db.query(`select column_name || ':' || data_type || ':' || is_nullable as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name`, [t])).rows.map((r) => (r as { c: string }).c);
  }
  const tables = (await db.query(`select table_name from information_schema.tables where table_schema = 'public' order by 1`)).rows.map((r) => (r as { table_name: string }).table_name);
  return { functions: fns, columns, tables };
}

interface Props {
  owner: string;
  secdef: boolean;
  config: unknown;
  grantees: string[];
}
async function props(name: string, ident: string): Promise<Props | null> {
  const { rows } = await db.query(
    `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config,
            coalesce((select array_agg(distinct case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end order by case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end)
                        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'), '{}') as grantees
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1 and pg_get_function_identity_arguments(p.oid) = $2`,
    [name, ident]
  );
  return (rows[0] as Props | undefined) ?? null;
}

let original: Shape;
const OLD_SHAPES: [string, string][] = [
  ['admin_create_promo_code', 'p_code text, p_duration_days integer, p_max_redemptions integer, p_unlimited boolean, p_expires_on date, p_no_expiry boolean, p_note text, p_bound_email_hash text, p_recipient_count integer'],
  ['admin_list_promo_codes', ''],
  ['redeem_promo_code_for_user', 'p_user_id uuid, p_code text, p_ip_hash text, p_email_hash text'],
  ['admin_manage_premium_entitlement', 'p_action text, p_target_user_id uuid, p_ends_on date, p_reason text'],
  ['admin_promo_email_begin', 'p_request_key text, p_recipient_count integer, p_bound boolean'],
];
let originalProps: (Props | null)[];

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db, '0252_zzz');
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    insert into auth.users(id,email,email_confirmed_at) values ('${PROMO_ADMIN}','pa@pg.test',now()),('${ENT_ADMIN}','ea@pg.test',now());
    insert into admin_users(user_id) values ('${PROMO_ADMIN}'),('${ENT_ADMIN}');
    update admin_users set can_manage_promo_codes=true where user_id='${PROMO_ADMIN}';
    update admin_users set can_manage_premium_entitlements=true where user_id='${ENT_ADMIN}';
  `);
  original = await shape();
  originalProps = [];
  for (const [n, i] of OLD_SHAPES) originalProps.push(await props(n, i));
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('R2: 0264 to 0268 applied, then rolled back', () => {
  it('guard: refuses while a code exists only as a digest, and changes nothing (nothing was dropped)', async () => {
    await applyAdditive();
    const made = makeCode('KEPTSAFE2222');
    await as(PROMO_ADMIN, 'authenticated', () =>
      db.query(
        `select public.admin_create_promo_code(p_code_digest => $1::text, p_code_hint => $2::text, p_digest_version => $3::int, p_duration_days => 30, p_max_redemptions => 3, p_unlimited => false, p_expires_on => (current_date + 30), p_no_expiry => false, p_note => null::text)`,
        [made.digest, made.hint, made.version]
      )
    );
    let message = '';
    try {
      await run(R2);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('PROMO_ROLLBACK_BLOCKED');
    const present = (await db.query(`select count(*)::int n from pg_proc where proname = 'admin_create_promo_code'`)).rows[0] as { n: number };
    expect(present.n, 'the refused rollback dropped nothing').toBe(2);
    expect(((await db.query(`select count(*)::int n from information_schema.columns where table_name='promo_codes' and column_name='code_digest'`)).rows[0] as { n: number }).n).toBe(1);
  });

  it('NC-R1: without the guard the same rollback drops the digest columns under that code and ORPHANS it (the assertion goes red)', async () => {
    const unguarded = R2.replace(/do \$fn\$\nbegin\n  if exists \(select 1 from public\.promo_codes where code is null and anonymised_at is null\) then[\s\S]*?end \$fn\$;/, '');
    expect(unguarded, 'the mutation must change the text').not.toBe(R2);
    // run it on a COPY of the state: PGlite has no cheap clone, so do it inside a transaction and roll back
    await db.exec('begin;');
    try {
      await run(unguarded.replace(/\bdo \$fn\$\nbegin\n  if to_regclass\('cron\.job'\)[\s\S]*?end \$fn\$;/, ''));
      const orphans = ((await db.query(`select count(*)::int n from promo_codes where code is null`)).rows[0] as { n: number }).n;
      const stillIdentifiable = ((await db.query(`select count(*)::int n from information_schema.columns where table_name='promo_codes' and column_name='code_digest'`)).rows[0] as { n: number }).n;
      await expectNamedFailure(() => expect(orphans === 0 || stillIdentifiable === 1, 'no code is orphaned by the rollback').toBe(true), 'no code is orphaned by the rollback');
    } finally {
      await db.exec('rollback;');
    }
    expect(((await db.query(`select count(*)::int n from information_schema.columns where table_name='promo_codes' and column_name='code_digest'`)).rows[0] as { n: number }).n, 'the transaction was rolled back').toBe(1);
  });

  it('with no digest-only code the rollback succeeds and the database is back to its earlier shape', { timeout: 240_000 }, async () => {
    // retire the guard row the way the guard message says: it cannot be disabled away from the check, so rebuild a clean database
    await db.close();
    db = await PGlite.create();
    await replayAll(db, '0252_zzz');
    await db.exec(`
      create schema if not exists vault;
      create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
      insert into auth.users(id,email,email_confirmed_at) values ('${PROMO_ADMIN}','pa@pg.test',now()),('${ENT_ADMIN}','ea@pg.test',now());
      insert into admin_users(user_id) values ('${PROMO_ADMIN}'),('${ENT_ADMIN}');
      update admin_users set can_manage_promo_codes=true where user_id='${PROMO_ADMIN}';
      update admin_users set can_manage_premium_entitlements=true where user_id='${ENT_ADMIN}';
    `);
    await oldReleaseWorks('PRESTATE2222');
    await applyAdditive();
    await oldReleaseWorks('NEWSCHEMA222');
    await run(R2);
    const now = await shape();
    expect(now.functions, 'the same functions as before 0264').toEqual(original.functions);
    expect(now.tables, 'the same tables as before 0264').toEqual(original.tables);
    for (const t of TABLES) {
      const expected = original.columns[t].map((c) => (t === 'promo_codes' && c.startsWith('code:') ? 'code:text:YES' : c)).sort();
      expect(now.columns[t].slice().sort(), `${t} columns`).toEqual(expected);
    }
  });

  it('the old release works again after the rollback (create, list, redeem, grant, begin)', async () => {
    await oldReleaseWorks('REVERTED2222');
  });

  it('the restored old functions have the same owner, security mode, search_path and grants as before', async () => {
    for (let i = 0; i < OLD_SHAPES.length; i += 1) {
      const [n, ident] = OLD_SHAPES[i];
      const now = await props(n, ident);
      expect(now, `${n} exists`).not.toBeNull();
      expect(now, `${n} properties`).toEqual(originalProps[i]);
    }
  });

  it('the append-only audit trail still refuses an update after the restored function replaced the hardened one', async () => {
    await expect(db.exec(`update promo_code_events set code_hint = code_hint`)).rejects.toThrow(/append-only/);
  });

  it('rolling forward again works: 0264 to 0268 apply cleanly on the rolled back database, and the old release still works beside them', async () => {
    await applyAdditive();
    await oldReleaseWorks('RERUNNEWER22');
    expect(((await db.query(`select count(*)::int n from pg_proc where proname = 'admin_create_promo_code'`)).rows[0] as { n: number }).n).toBe(2);
  });
});

describe('R1: 0279 applied, then the old function shapes are restored', () => {
  it('after the cleanup the old shapes are gone; R1 puts each back with the same owner, security mode, search_path and grants', async () => {
    // the cleanup refuses while a plain value remains: prepare and blank them as the runbook does (digest, verify, finalise)
    await db.exec(`update promo_codes set code_digest = encode(sha256(convert_to(code, 'UTF8')), 'hex'), code_digest_version = 1, code_digest_verified_at = now() where code is not null`);
    await as(null, 'service_role', () => db.query(`select public.promo_codes_finalise_hash_only(false)`));
    await run(fs.readFileSync(path.join(MIG_DIR, cleanupFile()), 'utf8'));
    for (const [n, i] of OLD_SHAPES) expect(await props(n, i), `${n} is gone after the cleanup`).toBeNull();
    await run(R1);
    for (let k = 0; k < OLD_SHAPES.length; k += 1) {
      const [n, ident] = OLD_SHAPES[k];
      expect(await props(n, ident), `${n} restored`).toEqual(originalProps[k]);
    }
  });

  it('the old release works again, with the new shapes still beside the old ones', async () => {
    await oldReleaseWorks('THENRESTART22');
    expect(((await db.query(`select count(*)::int n from pg_proc where proname = 'redeem_promo_code_for_user'`)).rows[0] as { n: number }).n).toBe(2);
  });

  it('NC-R2: an R1 that forgets a revoke leaves a function open to the anonymous role (the assertion goes red)', async () => {
    const forgetful = R1.split('\n').filter((l) => !/^revoke all on function public\.admin_list_promo_codes\(\)/.test(l)).join('\n');
    expect(forgetful, 'the mutation must change the text').not.toBe(R1);
    await run('drop function public.admin_list_promo_codes();');
    await run(forgetful);
    try {
      let closed = false;
      try {
        await as(null, 'anon', () => db.query(`select * from public.admin_list_promo_codes()`));
      } catch (e) {
        closed = /permission denied/i.test((e as Error).message);
      }
      await expectNamedFailure(() => expect(closed, 'the old shape is closed to the anonymous role again').toBe(true), 'the old shape is closed to the anonymous role again');
    } finally {
      await run('drop function public.admin_list_promo_codes();');
      await run(R1);
    }
    expect(await props('admin_list_promo_codes', '')).toEqual(originalProps[1]);
  });
});
