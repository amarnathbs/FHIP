// Staff admin Premium (migration 0283) -- real-Postgres (PGlite) proof of the DATABASE half.
//
// PO decision 16-10-2026: FHIP staff accounts hold a REAL Premium entitlement row. This suite replays the whole migration ledger
// (0001..0283) into an isolated in-memory Postgres and exercises every rule through the real functions and triggers, as the
// real roles (authenticated / service_role / anon) with auth.uid() driven by request.jwt.claims. Nothing is reimplemented here.
//
// NEGATIVE CONTROLS (named). Each rule is also run against a copy of the live function with exactly that rule removed. The named
// assertion must go red as a real AssertionError (a SQL error does not count) and the live definition is restored afterwards.
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. NOT DEV-verified, NOT production-verified.
// What PGlite cannot prove: true concurrency, and the real Supabase role grants of a hosted project (the DEV proof does that).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, expectNamedFailure, latestFunctionSql, replayAll } from './support/promoTestHelpers';
import { STAFF_PREMIUM_RESOURCE_ROLES } from '@/lib/services/staffPremium';

// Real-Postgres replay tests: give each test room when the machine is busy with a full parallel run (the 5 s default is too short).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

const CAP_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000f001'; // Super Admin holding can_manage_premium_entitlements
const NOCAP_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000f002'; // Super Admin without the capability
const PLAIN = 'aaaaaaaa-0000-0000-0000-00000000f003'; // an ordinary customer

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-6000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email) values ('${id}','${label}${counter}@pg.test');`); // signup trigger creates the free row
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

async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection with ${code}`).toContain(code);
}

function norm(row: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      const iso = v.toISOString();
      out[k] = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
    } else out[k] = v;
  }
  return out;
}
const ent = async (uid: string) => norm((await db.query(`select * from user_entitlements where user_id=$1`, [uid])).rows[0] as Json);
const entCount = async (uid: string) => ((await db.query(`select count(*)::int c from user_entitlements where user_id=$1`, [uid])).rows[0] as { c: number }).c;
const events = async (uid: string) =>
  (await db.query(`select action, origin, replaced_source from staff_premium_events where target_user_id=$1 order by created_at, id`, [uid])).rows as { action: string; origin: string; replaced_source: string | null }[];
const eventTotal = async () => ((await db.query(`select count(*)::int c from staff_premium_events`)).rows[0] as { c: number }).c;
const today = async () => ((await db.query(`select current_date::text d`)).rows[0] as { d: string }).d;
const addDays = async (n: number) => ((await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0] as { d: string }).d;
const tableSnapshot = async () => JSON.stringify((await db.query(`select * from user_entitlements order by user_id`)).rows);

async function makeAdmin(uid: string) {
  await db.exec(`insert into admin_users(user_id) values ('${uid}');`);
}
async function giveRole(uid: string, role: string, active = true) {
  await db.exec(`insert into resource_user_roles(user_id, role, is_active) values ('${uid}','${role}',${active});`);
}
async function reconcile(dry: boolean): Promise<{ user_id: string; planned: string; result: string; masked_email: string; qualifies_via: string; current_source: string }[]> {
  return (await db.query(`select * from public.staff_premium_reconcile(${dry})`)).rows as never;
}
async function sync(uid: string): Promise<string> {
  return ((await db.query(`select public.staff_premium_sync_user($1,'backfill') v`, [uid])).rows[0] as { v: string }).v;
}
async function manage(actor: string, action: string, target: string, endsOn: string | null, reason = 'Pilot customer, invoice pending'): Promise<Json> {
  return as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_manage_premium_entitlement($1,$2,$3,$4,false) v`, [action, target, endsOn, reason]);
    return (rows[0] as { v: Json }).v;
  });
}
async function webhook(uid: string, confers: boolean, status: string) {
  await db.query(`select public.apply_subscription_entitlement_event($1,'stripe','cus_x','sub_x',$2,$3,'price_x',null,false)`, [uid, confers, status]);
}

function extractFn(sql: string, name: string): string {
  const m = sql.match(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, '0283_staff_admin_premium.sql'), 'utf8');
const GUARD_FN = extractFn(MIGRATION, 'staff_premium_guard');
const SYNC_FN = extractFn(MIGRATION, 'staff_premium_sync_user');
const QUAL_FN = extractFn(MIGRATION, 'is_staff_premium_account');
const RECONCILE_FN = extractFn(MIGRATION, 'staff_premium_reconcile');

async function withMutation<T>(originalSql: string, mutate: (sql: string) => string, fn: () => Promise<T>): Promise<T> {
  const mutated = mutate(originalSql);
  expect(mutated, 'the negative-control mutation must actually change the SQL').not.toBe(originalSql);
  await db.exec(mutated);
  try {
    return await fn();
  } finally {
    await db.exec(originalSql);
  }
}
async function expectAssertionFails(assertion: () => Promise<void>, namedAssertion: string) {
  await expectNamedFailure(assertion, namedAssertion);
}

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db);
  await db.exec(`insert into auth.users(id,email) values ('${CAP_ADMIN}','cap@pg.test'),('${NOCAP_ADMIN}','nocap@pg.test'),('${PLAIN}','plain@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${CAP_ADMIN}'),('${NOCAP_ADMIN}');`);
  await db.exec(`update admin_users set can_manage_premium_entitlements = true where user_id='${CAP_ADMIN}';`);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 0283 -- shape', () => {
  it('the source constraint accepts staff_admin and still accepts every earlier value, and rejects anything else', async () => {
    const def = ((await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='user_entitlements_entitlement_source_check'`)).rows[0] as { d: string }).d;
    for (const v of ['payment', 'admin_grant', 'promo_code', 'staff_admin']) expect(def, `value ${v}`).toContain(`'${v}'`);
    const u = await newUser();
    await expect(db.exec(`update user_entitlements set entitlement_source='bogus' where user_id='${u}'`)).rejects.toThrow(/user_entitlements_entitlement_source_check/);
  });

  it('a staff row must be Premium and open ended (the shape rule)', async () => {
    const def = ((await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='user_entitlements_staff_source_shape_check'`)).rows[0] as { d: string }).d;
    expect(def).toContain('staff_admin');
    expect(def).toContain('effective_to IS NULL');
  });

  it('the earlier rule for admin grants and promo codes is intact (a non-payment row without an end date is still refused)', async () => {
    const u = await newUser();
    await expect(db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant' where user_id='${u}'`)).rejects.toThrow(/managed_source_shape_check/);
  });

  it('the audit table is append-only, has RLS, and API roles can only read it', async () => {
    const rls = (await db.query(`select relrowsecurity r from pg_class where oid='public.staff_premium_events'::regclass`)).rows[0] as { r: boolean };
    expect(rls.r).toBe(true);
    const grants = (await db.query(`select privilege_type p from information_schema.role_table_grants where table_name='staff_premium_events' and grantee in ('anon','authenticated') order by 1`)).rows.map((r) => (r as { p: string }).p);
    expect(grants).toEqual(['SELECT']);
    const u = await newUser();
    await makeAdmin(u);
    await expect(db.exec(`update staff_premium_events set action='end' where target_user_id='${u}'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`delete from staff_premium_events where target_user_id='${u}'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`truncate staff_premium_events`)).rejects.toThrow(/append-only/);
    // clean up so the later total-count assertions are not disturbed
    await db.exec(`alter table staff_premium_events disable trigger trg_staff_premium_events_no_change`);
    await db.exec(`alter table staff_premium_events disable trigger trg_staff_premium_events_no_truncate`);
    await db.exec(`delete from admin_users where user_id='${u}'`);
    await db.exec(`alter table staff_premium_events enable trigger trg_staff_premium_events_no_change`);
    await db.exec(`alter table staff_premium_events enable trigger trg_staff_premium_events_no_truncate`);
  });
});

describe('who counts as staff (decision D1)', () => {
  it('the SQL role list and the TypeScript role list agree (single source of truth, mirrored)', () => {
    const m = QUAL_FN.match(/r\.role in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const sqlRoles = m![1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
    expect(sqlRoles).toEqual([...STAFF_PREMIUM_RESOURCE_ROLES].sort());
  });

  it('a Super Admin row makes the account staff, and the entitlement row is Staff Premium straight away', async () => {
    const e = await ent(CAP_ADMIN);
    expect(e.plan_tier).toBe('premium');
    expect(e.entitlement_source).toBe('staff_admin');
    expect(e.effective_to).toBeNull();
    expect(e.admin_grant_ends_on).toBeNull();
    expect(e.reserve_source).toBeNull();
    expect(e.effective_from).toBe(await today());
  });

  for (const role of ['resource_admin', 'editor']) {
    it(`an ACTIVE ${role} role makes the account staff`, async () => {
      const u = await newUser(role);
      expect((await ent(u)).plan_tier).toBe('free');
      await giveRole(u, role);
      const e = await ent(u);
      expect(e.plan_tier).toBe('premium');
      expect(e.entitlement_source).toBe('staff_admin');
    });
  }

  // PO decision D1 (16-10-2026): these four open the Admin area but get no Staff Premium.
  for (const role of ['author', 'compliance_reviewer', 'publisher', 'analyst']) {
    it(`an ACTIVE ${role} role does NOT make the account staff (excluded by the PO decision)`, async () => {
      const u = await newUser(role);
      await giveRole(u, role);
      const e = await ent(u);
      expect(e.plan_tier).toBe('free');
      expect(e.entitlement_source).toBe('payment');
      expect(await events(u)).toEqual([]);
      expect((await reconcile(true)).some((r) => r.user_id === u), 'the preview never lists an excluded role').toBe(false);
    });
  }

  it('NEGATIVE CONTROL -- with the role list widened to every Resources role an Author would qualify (assertion "author is not staff" goes red)', async () => {
    await withMutation(QUAL_FN, (s) => s.replace("r.role in ('resource_admin', 'editor')", "r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst')"), async () => {
      await expectAssertionFails(async () => {
        const u = await newUser();
        await giveRole(u, 'author');
        expect((await ent(u)).entitlement_source, 'author is not staff').toBe('payment');
      }, 'author is not staff');
    });
  });

  it('LATER CHANGE: narrowing the rule again, the preview lists exactly who would END (and the run returns them to Free)', async () => {
    const ed = await newUser('narrow-ed');
    const ra = await newUser('narrow-ra');
    await giveRole(ed, 'editor');
    await giveRole(ra, 'resource_admin');
    await withMutation(QUAL_FN, (s) => s.replace("r.role in ('resource_admin', 'editor')", "r.role in ('resource_admin')"), async () => {
      const preview = await reconcile(true);
      expect(preview.find((r) => r.user_id === ed)?.planned, 'the editor would end').toBe('end');
      expect(preview.find((r) => r.user_id === ra)?.planned, 'the resource admin stays').toBe('keep_staff');
      expect((await ent(ed)).entitlement_source, 'the preview changed nothing').toBe('staff_admin');
      await reconcile(false);
      expect((await ent(ed)).plan_tier).toBe('free');
      expect((await ent(ra)).entitlement_source).toBe('staff_admin');
    });
    // widening again brings the editor back
    await reconcile(false);
    expect((await ent(ed)).entitlement_source).toBe('staff_admin');
  });

  it('an INACTIVE role does not, and an ordinary customer never gets a staff row', async () => {
    const u = await newUser();
    await giveRole(u, 'editor', false);
    expect((await ent(u)).entitlement_source).toBe('payment');
    expect((await ent(u)).plan_tier).toBe('free');
    expect((await ent(PLAIN)).entitlement_source).toBe('payment');
    expect((await ent(PLAIN)).plan_tier).toBe('free');
    expect(await events(PLAIN)).toEqual([]);
  });

  it('NEGATIVE CONTROL -- with the is_active test removed an inactive role would qualify (assertion "inactive role is not staff" goes red)', async () => {
    await withMutation(QUAL_FN, (s) => s.replace('where r.user_id = p_user_id and r.is_active', 'where r.user_id = p_user_id'), async () => {
      await expectAssertionFails(async () => {
        const u = await newUser();
        await giveRole(u, 'editor', false);
        expect((await ent(u)).entitlement_source, 'inactive role is not staff').toBe('payment');
      }, 'inactive role is not staff');
    });
  });
});

describe('automatic path -- assignment creates it, removal of the LAST staff role ends it', () => {
  it('assigning a role through the service role creates the entitlement and an audit event with its origin', async () => {
    const u = await newUser();
    await as(null, 'service_role', () => db.query(`insert into resource_user_roles(user_id, role, is_active) values ($1,'editor',true)`, [u]));
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    expect(await events(u)).toEqual([{ action: 'start', origin: 'resource_user_roles', replaced_source: null }]);
  });

  it('removing one of two roles keeps it, removing the last ends it (Free, source payment, no leftovers), reassigning restores it', async () => {
    const u = await newUser();
    await giveRole(u, 'resource_admin');
    await giveRole(u, 'editor');
    await db.exec(`update resource_user_roles set is_active=false where user_id='${u}' and role='resource_admin'`);
    expect((await ent(u)).entitlement_source, 'still staff via the editor role').toBe('staff_admin');
    await db.exec(`update resource_user_roles set is_active=false where user_id='${u}' and role='editor'`);
    const e = await ent(u);
    expect(e.plan_tier, 'removal of all staff roles ends it').toBe('free');
    expect(e.entitlement_source).toBe('payment');
    expect(e.effective_to).toBeNull();
    await db.exec(`update resource_user_roles set is_active=true where user_id='${u}' and role='resource_admin'`);
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    expect((await events(u)).map((x) => x.action)).toEqual(['start', 'end', 'start']);
  });

  it('a Super Admin who also holds a role stays staff when the admin row is deleted, and ends when the role goes too', async () => {
    const u = await newUser();
    await makeAdmin(u);
    await giveRole(u, 'resource_admin');
    await db.exec(`delete from admin_users where user_id='${u}'`);
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    await db.exec(`delete from resource_user_roles where user_id='${u}'`);
    expect((await ent(u)).plan_tier).toBe('free');
    const evs = await events(u);
    expect(evs[evs.length - 1]).toMatchObject({ action: 'end', origin: 'resource_user_roles' });
  });

  it('a statement typed in the SQL editor takes the same path (nothing to bypass)', async () => {
    const u = await newUser();
    await db.exec(`insert into admin_users(user_id) values ('${u}')`);
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    await db.exec(`delete from admin_users where user_id='${u}'`);
    expect((await ent(u)).plan_tier).toBe('free');
  });

  it('NEGATIVE CONTROL -- with the trigger on admin_users dropped a new admin gets nothing (assertion "new admin gets Staff Premium" goes red)', async () => {
    await db.exec(`drop trigger trg_staff_premium_admin_users on public.admin_users`);
    try {
      await expectAssertionFails(async () => {
        const u = await newUser();
        await makeAdmin(u);
        expect((await ent(u)).entitlement_source, 'new admin gets Staff Premium').toBe('staff_admin');
      }, 'new admin gets Staff Premium');
    } finally {
      await db.exec(`create trigger trg_staff_premium_admin_users after insert or delete on public.admin_users for each row execute function public.staff_premium_after_admin_users()`);
    }
  });

  it('NEGATIVE CONTROL -- with the ending branch removed the entitlement outlives the role (assertion "removal ends it" goes red)', async () => {
    await withMutation(SYNC_FN, (s) => s.replace("if found and v_row.entitlement_source = 'staff_admin' then", "if false then"), async () => {
      await expectAssertionFails(async () => {
        const u = await newUser();
        await giveRole(u, 'editor');
        await db.exec(`update resource_user_roles set is_active=false where user_id='${u}'`);
        expect((await ent(u)).plan_tier, 'removal ends it').toBe('free');
      }, 'removal ends it');
    });
  });

  it('deleting an account (the role rows go with it) neither errors nor leaves an entitlement row behind', async () => {
    const u = await newUser();
    await makeAdmin(u);
    await giveRole(u, 'editor');
    await db.exec(`delete from auth.users where id='${u}'`);
    expect(await entCount(u)).toBe(0);
  });
});

describe('preview and backfill (the PO runs these)', () => {
  async function seedLegacyStaff() {
    // Staff accounts as they exist BEFORE the migration: roles with no entitlement change. Triggers are switched off to build that state.
    await db.exec(`alter table admin_users disable trigger trg_staff_premium_admin_users`);
    await db.exec(`alter table resource_user_roles disable trigger trg_staff_premium_resource_roles`);
    await db.exec(`alter table user_entitlements disable trigger trg_staff_premium_guard`);
    const ids = { free: await newUser('legacyfree'), grant: await newUser('legacygrant'), promo: await newUser('legacypromo'), paid: await newUser('legacypaid'), lapsed: await newUser('legacylapsed'), role: await newUser('legacyrole') };
    for (const k of ['free', 'grant', 'promo', 'paid', 'lapsed']) await makeAdmin(ids[k as keyof typeof ids]);
    await giveRole(ids.role, 'resource_admin');
    const end = await addDays(40);
    const past = await addDays(-5);
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-3, effective_to='${end}', admin_grant_ends_on='${end}', reserve_source='admin_grant', admin_lifetime_grant_units=3, admin_grant_extension_count=2 where user_id='${ids.grant}'`);
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='promo_code', effective_from=current_date-3, effective_to='${end}', admin_grant_ends_on='${end}', reserve_source='promo_code' where user_id='${ids.promo}'`);
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='payment', provider='stripe', subscription_status='active' where user_id='${ids.paid}'`);
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-60, effective_to='${past}', admin_grant_ends_on='${past}', reserve_source='admin_grant' where user_id='${ids.lapsed}'`);
    await db.exec(`alter table admin_users enable trigger trg_staff_premium_admin_users`);
    await db.exec(`alter table resource_user_roles enable trigger trg_staff_premium_resource_roles`);
    await db.exec(`alter table user_entitlements enable trigger trg_staff_premium_guard`);
    return ids;
  }

  it('the PREVIEW (dry run, the default) lists exactly who would be affected and WRITES NOTHING', async () => {
    const ids = await seedLegacyStaff();
    const before = await tableSnapshot();
    const eventsBefore = await eventTotal();
    const rows = (await db.query(`select * from public.staff_premium_reconcile()`)).rows as { user_id: string; planned: string; result: string; masked_email: string }[];
    const by = (id: string) => rows.find((r) => r.user_id === id)!;
    expect(by(ids.free).planned).toBe('start');
    expect(by(ids.grant).planned).toBe('start_replacing_admin_grant');
    expect(by(ids.promo).planned).toBe('start_replacing_promo_code');
    expect(by(ids.paid).planned).toBe('keep_paid');
    expect(by(ids.lapsed).planned).toBe('start');
    expect(by(ids.role).planned).toBe('start');
    expect(rows.every((r) => r.result === 'dry_run')).toBe(true);
    expect(rows.some((r) => r.user_id === PLAIN), 'an ordinary customer is never listed').toBe(false);
    expect(await tableSnapshot(), 'the preview writes nothing').toBe(before);
    expect(await eventTotal()).toBe(eventsBefore);
    // masked e-mail: two characters and the domain only
    for (const r of rows) {
      expect(r.masked_email).toMatch(/^.{0,2}\*\*\*@pg\.test$/);
    }
  });

  it('NEGATIVE CONTROL -- a preview that writes would change the table (assertion "the preview writes nothing" goes red)', async () => {
    const u = await newUser();
    await db.exec(`alter table admin_users disable trigger trg_staff_premium_admin_users`);
    await makeAdmin(u);
    await db.exec(`alter table admin_users enable trigger trg_staff_premium_admin_users`);
    await withMutation(RECONCILE_FN, (s) => s.replace('    if p_dry_run then', '    if false then'), async () => {
      await expectAssertionFails(async () => {
        const before = await tableSnapshot();
        await db.query(`select * from public.staff_premium_reconcile(true)`);
        expect(await tableSnapshot(), 'the preview writes nothing').toBe(before);
      }, 'the preview writes nothing');
    });
    await sync(u);
  });

  it('the BACKFILL gives every current staff account Staff Premium, leaves paid Premium alone, and a second run changes nothing', async () => {
    const rows1 = await reconcile(false);
    const results = Object.fromEntries(rows1.map((r) => [r.user_id, r.result]));
    expect(Object.values(results).every((v) => ['started', 'kept', 'kept_paid'].includes(v))).toBe(true);
    const snap = await tableSnapshot();
    const evs = await eventTotal();
    const rows2 = await reconcile(false);
    expect(rows2.every((r) => ['kept', 'kept_paid'].includes(r.result)), 'second run: nothing started').toBe(true);
    expect(await tableSnapshot(), 'idempotent: the table is byte-identical after a second run').toBe(snap);
    expect(await eventTotal(), 'idempotent: no new audit events').toBe(evs);
    const drift = (await db.query(`select count(*)::int c from public.staff_premium_reconcile(true) where planned not in ('keep_staff','keep_paid')`)).rows[0] as { c: number };
    expect(drift.c).toBe(0);
  });

  it('an active admin grant or promo is REPLACED by Staff Premium and the audit event names what was replaced; paid stays paid', async () => {
    const grantUser = ((await db.query(`select e.user_id from user_entitlements e join staff_premium_events v on v.target_user_id = e.user_id where v.replaced_source='admin_grant' limit 1`)).rows[0] as { user_id: string } | undefined)?.user_id;
    expect(grantUser, 'a user whose admin grant was replaced exists').toBeTruthy();
    const e = await ent(grantUser!);
    expect(e.entitlement_source).toBe('staff_admin');
    expect(e.admin_grant_ends_on).toBeNull();
    expect(e.effective_to).toBeNull();
    const promoReplaced = (await db.query(`select count(*)::int c from staff_premium_events where replaced_source='promo_code' and origin='backfill'`)).rows[0] as { c: number };
    expect(promoReplaced.c).toBe(1);
    const paid = (await db.query(`select entitlement_source s, plan_tier t, provider p from user_entitlements where subscription_status='active' and provider='stripe' and user_id in (select user_id from admin_users) order by user_id limit 1`)).rows[0] as { s: string; t: string; p: string };
    expect(paid).toEqual({ s: 'payment', t: 'premium', p: 'stripe' });
    const o = (await db.query(`select count(*)::int c from staff_premium_events where origin='backfill'`)).rows[0] as { c: number };
    expect(o.c).toBeGreaterThanOrEqual(5);
  });
});

describe('edge cases of the sync', () => {
  it('a staff account with NO entitlement row at all gets one (and it is Staff Premium)', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    await db.exec(`delete from user_entitlements where user_id='${u}'`);
    expect(await entCount(u)).toBe(0);
    expect(await sync(u)).toBe('started');
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    expect(await sync(u)).toBe('kept');
  });

  it('a staff row that is not yet in force (start date in the future) is corrected, and the preview says start, not keep', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    await db.exec('alter table user_entitlements disable trigger trg_staff_premium_guard');
    await db.exec(`update user_entitlements set effective_from = current_date + 20 where user_id='${u}'`);
    await db.exec('alter table user_entitlements enable trigger trg_staff_premium_guard');
    expect((await reconcile(true)).find((r) => r.user_id === u)?.planned).toBe('start');
    expect(await sync(u)).toBe('started');
    expect((await ent(u)).effective_from).toBe(await today());
  });

  it('a stray session setting for the audit origin can never block a legitimate write (unknown values are recorded as a direct write)', async () => {
    const u = await newUser();
    await db.query(`select set_config('fhip.staff_premium_origin','not-a-real-origin',false)`);
    try {
      await db.exec(`insert into resource_user_roles(user_id, role, is_active) values ('${u}','editor',true)`);
    } finally {
      await db.query(`select set_config('fhip.staff_premium_origin','',false)`);
    }
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    expect((await events(u))[0].origin).toBe('resource_user_roles'); // the role trigger sets its own origin for the sync it runs
    await db.query(`select set_config('fhip.staff_premium_origin','not-a-real-origin',false)`);
    try {
      const v = await newUser();
      await db.exec(`insert into admin_users(user_id) values ('${v}')`); // trigger path again, still fine
      await db.exec('alter table user_entitlements disable trigger trg_staff_premium_guard');
      await db.exec(`update user_entitlements set plan_tier='free', entitlement_source='payment' where user_id='${u}'`);
      await db.exec('alter table user_entitlements enable trigger trg_staff_premium_guard');
      // a plain write by an operator carries no origin of its own: the garbage value is normalised
      await db.exec(`update user_entitlements set updated_at = now() where user_id='${u}'`);
      const evs = await events(u);
      expect(evs[evs.length - 1]).toMatchObject({ action: 'start', origin: 'direct_write' });
    } finally {
      await db.query(`select set_config('fhip.staff_premium_origin','',false)`);
    }
  });
});

describe('no effect on the consumer grant and promo rules', () => {
  it('the lifetime counter is untouched by becoming staff, and still counts after the person leaves staff', async () => {
    const u = await newUser();
    const end = await addDays(30);
    await manage(CAP_ADMIN, 'grant', u, end);
    await manage(CAP_ADMIN, 'revoke', u, null);
    await manage(CAP_ADMIN, 'grant', u, end);
    const units = ((await db.query(`select admin_lifetime_grant_units n from user_entitlements where user_id=$1`, [u])).rows[0] as { n: number }).n;
    expect(units).toBe(2);
    await makeAdmin(u); // replaces the active grant
    expect(((await db.query(`select admin_lifetime_grant_units n from user_entitlements where user_id=$1`, [u])).rows[0] as { n: number }).n).toBe(2);
    await db.exec(`delete from admin_users where user_id='${u}'`);
    expect(((await db.query(`select admin_lifetime_grant_units n from user_entitlements where user_id=$1`, [u])).rows[0] as { n: number }).n).toBe(2);
    await manage(CAP_ADMIN, 'grant', u, end);
    expect(((await db.query(`select admin_lifetime_grant_units n from user_entitlements where user_id=$1`, [u])).rows[0] as { n: number }).n, 'the next grant counts as the third').toBe(3);
  });

  it('a staff account becoming staff never adds to any account lifetime counter', async () => {
    const r = (await db.query(`select coalesce(sum(admin_lifetime_grant_units),0)::int s from user_entitlements where entitlement_source='staff_admin' and user_id in (select user_id from admin_users where user_id in ('${CAP_ADMIN}','${NOCAP_ADMIN}'))`)).rows[0] as { s: number };
    expect(r.s).toBe(0);
  });

  it('the admin grant functions REFUSE to touch a staff row (grant, extend, revoke) and leave it unchanged', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    const before = await ent(u);
    for (const action of ['grant', 'extend', 'revoke']) {
      await expectCode(manage(CAP_ADMIN, action, u, action === 'revoke' ? null : await addDays(30)), 'ENTITLEMENT_PAID_ACTIVE');
    }
    expect(await ent(u)).toEqual(before);
  });

  it('staff rows are invisible to the grant list, the expiry summary and the reminder claim', async () => {
    const staffIds = ((await db.query(`select user_id from user_entitlements where entitlement_source='staff_admin'`)).rows as { user_id: string }[]).map((r) => r.user_id);
    expect(staffIds.length).toBeGreaterThan(3);
    for (const filter of ['expiring', 'active', 'lapsed']) {
      const list = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select user_id from public.admin_list_premium_grants($1, 365)`, [filter])).rows as { user_id: string }[]);
      expect(list.filter((r) => staffIds.includes(r.user_id)), `grant list ${filter}`).toEqual([]);
    }
    const summary = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select user_id from public.admin_entitlement_expiry_summary(null)`)).rows as { user_id: string }[]);
    expect(summary.filter((r) => staffIds.includes(r.user_id))).toEqual([]);
    const claimed = await as(null, 'service_role', async () => (await db.query(`select user_id from public.premium_reminder_claim(current_date, array[30,7], 500, 3, 60, null)`)).rows as { user_id: string }[]);
    expect(claimed.filter((r) => staffIds.includes(r.user_id))).toEqual([]);
  });

  it('a promo code or admin grant can never be written over a staff row (it would put an end date on it)', async () => {
    const u = await newUser();
    await giveRole(u, 'resource_admin');
    const end = await addDays(30);
    await expectCode(
      db.query(`update user_entitlements set plan_tier='premium', entitlement_source='promo_code', effective_to=$2, admin_grant_ends_on=$2, reserve_source='promo_code' where user_id=$1`, [u, end]),
      'STAFF_PREMIUM_PROTECTED'
    );
    await expectCode(
      db.query(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_to=$2, admin_grant_ends_on=$2, reserve_source='admin_grant' where user_id=$1`, [u, end]),
      'STAFF_PREMIUM_PROTECTED'
    );
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
  });
});

describe('payment webhook and other writers cannot take staff Premium away', () => {
  it('Premium event: payment wins (and is audited paid_over). Cancel: Staff Premium is back. Abandoned checkout: still Staff Premium', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    await webhook(u, true, 'active');
    let e = await ent(u);
    expect(e.entitlement_source, 'payment wins while the subscription is live').toBe('payment');
    expect(e.plan_tier).toBe('premium');
    expect(e.subscription_status).toBe('active');
    await webhook(u, false, 'canceled');
    e = await ent(u);
    expect(e.plan_tier, 'staff keeps Premium after the subscription ends').toBe('premium');
    expect(e.entitlement_source).toBe('staff_admin');
    expect(e.subscription_status, 'the provider status is recorded as the provider sent it').toBe('canceled');
    await webhook(u, false, 'incomplete');
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
    expect((await events(u)).map((x) => x.action)).toEqual(['start', 'paid_over', 'start']);
  });

  it('a NON-staff account behaves exactly as before: paid then cancelled is Free (regression)', async () => {
    const u = await newUser();
    await webhook(u, true, 'active');
    expect((await ent(u)).entitlement_source).toBe('payment');
    await webhook(u, false, 'canceled');
    const e = await ent(u);
    expect(e.plan_tier).toBe('free');
    expect(e.entitlement_source).toBe('payment');
    expect(await events(u)).toEqual([]);
  });

  it('an admin revoke (or any writer) that would leave a staff account Free is rewritten to Staff Premium', async () => {
    const u = await newUser();
    await giveRole(u, 'resource_admin');
    await db.exec(`update user_entitlements set plan_tier='free', entitlement_source='payment' where user_id='${u}'`);
    expect((await ent(u)).entitlement_source).toBe('staff_admin');
  });

  it('NEGATIVE CONTROL -- without the rewrite, a cancelled subscription drops staff to Free (assertion "staff keeps Premium after cancel" goes red)', async () => {
    await withMutation(GUARD_FN, (s) => s.replace("if new.entitlement_source <> 'staff_admin' and not (v_active and new.entitlement_source = 'payment') then", 'if false then'), async () => {
      await expectAssertionFails(async () => {
        const u = await newUser();
        await giveRole(u, 'editor');
        await webhook(u, true, 'active');
        await webhook(u, false, 'canceled');
        expect((await ent(u)).plan_tier, 'staff keeps Premium after cancel').toBe('premium');
      }, 'staff keeps Premium after cancel');
    });
  });
});

describe('a staff row can exist ONLY for a staff account (never created for non-admins)', () => {
  it('writing staff_admin for an ordinary customer is refused, whoever writes it', async () => {
    await expectCode(db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='staff_admin' where user_id='${PLAIN}'`), 'STAFF_PREMIUM_NOT_QUALIFIED');
    expect((await ent(PLAIN)).entitlement_source).toBe('payment');
    await expectCode(as(null, 'service_role', () => db.query(`update user_entitlements set plan_tier='premium', entitlement_source='staff_admin' where user_id=$1`, [PLAIN])), 'STAFF_PREMIUM_NOT_QUALIFIED');
  });

  it('NEGATIVE CONTROL -- without the qualification test an ordinary customer could be given a staff row (assertion "non-staff cannot hold a staff row" goes red)', async () => {
    await withMutation(GUARD_FN, (s) => s.replace("if new.entitlement_source = 'staff_admin' and not v_staff then", 'if false then'), async () => {
      await expectAssertionFails(async () => {
        const u = await newUser();
        // the guard would otherwise refuse this; with the rule removed the shape check is the only thing standing
        await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='staff_admin' where user_id='${u}'`);
        expect((await ent(u)).entitlement_source, 'non-staff cannot hold a staff row').not.toBe('staff_admin');
      }, 'non-staff cannot hold a staff row');
    });
  });

  it('a customer cannot reach any of it: no write to user_entitlements, admin_users or the role table, no execute on the sync functions', async () => {
    const u = await newUser();
    const upd = await as(u, 'authenticated', () => db.query(`update user_entitlements set plan_tier='premium', entitlement_source='staff_admin' where user_id=$1`, [u]));
    expect(upd.affectedRows ?? 0).toBe(0);
    await expect(as(u, 'authenticated', () => db.query(`insert into admin_users(user_id) values ($1)`, [u]))).rejects.toThrow(/permission denied|row-level security/i);
    await expect(as(u, 'authenticated', () => db.query(`insert into resource_user_roles(user_id, role) values ($1,'editor')`, [u]))).rejects.toThrow(/permission denied|row-level security/i);
    for (const role of ['authenticated', 'anon'] as const) {
      await expect(as(u, role, () => db.query(`select public.staff_premium_sync_user($1,'backfill')`, [u]))).rejects.toThrow(/permission denied/i);
      await expect(as(u, role, () => db.query(`select * from public.staff_premium_reconcile(true)`))).rejects.toThrow(/permission denied/i);
      await expect(as(u, role, () => db.query(`select public.is_staff_premium_account($1)`, [u]))).rejects.toThrow(/permission denied/i);
    }
    expect((await ent(u)).plan_tier).toBe('free');
  });
});

describe('what the Admin screen can read (Standard sections 2, 4 and 9)', () => {
  it('capability holder: the staff list shows state, roles and e-mail only; an admin without the capability, a customer and anon are refused', async () => {
    const rows = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select * from public.admin_list_staff_premium()`)).rows as Json[]);
    expect(rows.length).toBeGreaterThan(3);
    expect(Object.keys(rows[0]).sort()).toEqual(['effective_from', 'email', 'entitlement_active', 'entitlement_source', 'plan_tier', 'roles', 'state', 'user_id']);
    const me = rows.find((r) => r.user_id === CAP_ADMIN)!;
    expect(me.state).toBe('staff_premium');
    expect(me.roles).toBe('Super Admin');
    expect(rows.some((r) => r.user_id === PLAIN)).toBe(false);
    for (const who of [PLAIN, NOCAP_ADMIN]) {
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_list_staff_premium()`)), 'ENTITLEMENT_ADMIN_REQUIRED');
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_staff_premium_history($1,10)`, [CAP_ADMIN])), 'ENTITLEMENT_ADMIN_REQUIRED');
    }
    await expect(as(null, 'anon', () => db.query(`select * from public.admin_list_staff_premium()`))).rejects.toThrow(/permission denied/i);
  });

  it('the states: staff_premium, paid_subscription (payment wins), not_applied (backfill not run) and stray_staff_row', async () => {
    const paid = await newUser('p');
    await giveRole(paid, 'editor');
    await webhook(paid, true, 'active');
    const pending = await newUser('n');
    await db.exec(`alter table admin_users disable trigger trg_staff_premium_admin_users`);
    await makeAdmin(pending);
    await db.exec(`alter table admin_users enable trigger trg_staff_premium_admin_users`);
    const rows = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select user_id, state from public.admin_list_staff_premium()`)).rows as { user_id: string; state: string }[]);
    const st = (id: string) => rows.find((r) => r.user_id === id)?.state;
    expect(st(paid)).toBe('paid_subscription');
    expect(st(pending)).toBe('not_applied');
    await sync(pending);
    // a stray staff row: the triggers are off while the role disappears
    const stray = await newUser('s');
    await giveRole(stray, 'editor');
    await db.exec(`alter table resource_user_roles disable trigger trg_staff_premium_resource_roles`);
    await db.exec(`update resource_user_roles set is_active=false where user_id='${stray}'`);
    await db.exec(`alter table resource_user_roles enable trigger trg_staff_premium_resource_roles`);
    const rows2 = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select user_id, state from public.admin_list_staff_premium()`)).rows as { user_id: string; state: string }[]);
    expect(rows2.find((r) => r.user_id === stray)?.state).toBe('stray_staff_row');
    expect((await reconcile(true)).find((r) => r.user_id === stray)?.planned).toBe('end');
    await reconcile(false);
    expect((await ent(stray)).plan_tier).toBe('free');
  });

  it('the history of one account is readable by the capability holder (start, end) and by nobody else (RLS)', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    await db.exec(`update resource_user_roles set is_active=false where user_id='${u}'`);
    const h = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select action, origin from public.admin_staff_premium_history($1,10)`, [u])).rows as { action: string; origin: string }[]);
    expect(h.map((x) => x.action)).toEqual(['end', 'start']);
    const direct = await as(NOCAP_ADMIN, 'authenticated', async () => (await db.query(`select id from staff_premium_events`)).rows.length);
    expect(direct).toBe(0);
    const capDirect = await as(CAP_ADMIN, 'authenticated', async () => (await db.query(`select id from staff_premium_events where target_user_id=$1`, [u])).rows.length);
    expect(capDirect).toBe(2);
  });
});

describe('consumer guards read ONLY the row (the SQL AI functions work for staff with no admin lookup)', () => {
  it('ai_entitlement_state sees a staff account as Premium, and the function text mentions no role table', async () => {
    const u = await newUser();
    await giveRole(u, 'editor');
    const v = ((await db.query(`select ai_entitlement_state($1) v`, [u])).rows[0] as { v: Json }).v;
    expect(v.eligible, 'a staff account is eligible for the Premium AI feature').toBe(true);
    const free = ((await db.query(`select ai_entitlement_state($1) v`, [PLAIN])).rows[0] as { v: Json }).v;
    expect(free.eligible, 'positive control: an ordinary Free customer is not').toBe(false);
    const src = ((await db.query(`select pg_get_functiondef('ai_entitlement_state(uuid)'::regprocedure) d`)).rows[0] as { d: string }).d;
    expect(src).not.toMatch(/admin_users|resource_user_roles|is_staff_premium_account|staff_admin/);
    const src2 = ((await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p where p.proname='ai_admit_request' limit 1`)).rows[0] as { d: string }).d;
    expect(src2).not.toMatch(/admin_users|resource_user_roles|is_staff_premium_account|staff_admin/);
  });
});

describe('rollback proof (R1 data, R2 schema)', () => {
  const ROLLBACK_DIR = path.join(path.resolve(MIG_DIR, '..', '..'), 'docs', 'admin', 'po_apply_staff_premium', 'rollback');

  it('R1 returns ONLY staff rows to their backed-up state, restores a replaced grant exactly, leaves every other row untouched', async () => {
    const r1 = fs.readFileSync(path.join(ROLLBACK_DIR, 'R1_restore_from_backup.sql'), 'utf8');
    const b1 = fs.readFileSync(path.join(path.resolve(MIG_DIR, '..', '..'), 'docs', 'admin', 'po_apply_staff_premium', 'backfill', 'B1_backup_user_entitlements.sql'), 'utf8');
    // a user holding an admin grant who then becomes staff through the backfill
    const g = await newUser('rbgrant');
    const end = await addDays(25);
    await manage(CAP_ADMIN, 'grant', g, end);
    await db.exec(`alter table admin_users disable trigger trg_staff_premium_admin_users`);
    await makeAdmin(g);
    await db.exec(`alter table admin_users enable trigger trg_staff_premium_admin_users`);
    const grantBefore = await ent(g);
    await db.exec(b1); // the backup the PO takes before the write
    await reconcile(false);
    expect((await ent(g)).entitlement_source).toBe('staff_admin');
    const bystander = await newUser('rbbystander');
    const bystanderBefore = await ent(bystander);
    await db.exec(r1);
    const restored = await ent(g);
    for (const k of ['plan_tier', 'entitlement_source', 'effective_from', 'effective_to', 'admin_grant_ends_on', 'reserve_source', 'admin_grant_extension_count']) {
      expect(restored[k], `column ${k} restored exactly`).toEqual(grantBefore[k]);
    }
    expect(await ent(bystander)).toEqual(bystanderBefore);
    const remaining = ((await db.query(`select count(*)::int c from user_entitlements where entitlement_source='staff_admin'`)).rows[0] as { c: number }).c;
    expect(remaining, 'no staff row is left after R1').toBe(0);
    // R1 leaves the triggers disabled on purpose; put them back for the rest of the suite
    await db.exec(`alter table user_entitlements enable trigger trg_staff_premium_guard`);
    await db.exec(`alter table admin_users enable trigger trg_staff_premium_admin_users`);
    await db.exec(`alter table resource_user_roles enable trigger trg_staff_premium_resource_roles`);
    await reconcile(false);
  });

  it('R2 removes every object the migration created, and the earlier source rules come back exactly', async () => {
    const r2 = fs.readFileSync(path.join(ROLLBACK_DIR, 'R2_undo_0283.sql'), 'utf8');
    const r1 = fs.readFileSync(path.join(ROLLBACK_DIR, 'R1_restore_from_backup.sql'), 'utf8');
    await db.exec(r1);
    await db.exec(r2);
    for (const fn of ['is_staff_premium_account(uuid)', 'staff_premium_guard()', 'staff_premium_sync_user(uuid,text)', 'staff_premium_reconcile(boolean)', 'admin_list_staff_premium()', 'admin_staff_premium_history(uuid,int)']) {
      expect(((await db.query(`select to_regprocedure('public.${fn}') is null as gone`)).rows[0] as { gone: boolean }).gone, fn).toBe(true);
    }
    expect(((await db.query(`select to_regclass('public.staff_premium_events') is null as gone`)).rows[0] as { gone: boolean }).gone).toBe(true);
    const def = ((await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='user_entitlements_entitlement_source_check'`)).rows[0] as { d: string }).d;
    expect(def).not.toContain('staff_admin');
    expect(def).toContain('promo_code');
    const shape = ((await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='user_entitlements_managed_source_shape_check'`)).rows[0] as { d: string }).d;
    expect(shape).not.toContain('staff_admin');
    // the consumer side still works after the undo: an admin can be added and nothing happens to the entitlement
    const u = await newUser('afterundo');
    await makeAdmin(u);
    expect((await ent(u)).entitlement_source).toBe('payment');
    // and the consumer functions are intact
    const t = await newUser('afterundo2');
    const v = await manage(CAP_ADMIN, 'grant', t, await addDays(10));
    expect(v.plan_tier).toBe('premium');
  });
});

describe('the live function definitions in the ledger are the ones under test', () => {
  it('latestFunctionSql finds the 0283 definitions (nothing newer replaces them)', () => {
    expect(latestFunctionSql('staff_premium_guard')).toBe(GUARD_FN);
    expect(latestFunctionSql('staff_premium_sync_user')).toBe(SYNC_FN);
  });
});
