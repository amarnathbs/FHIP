// Promo codes, per-grant extension cap and the expiry summary (promo migration)
// — real-Postgres (PGlite) proof of the DATABASE half.
//
// The whole migration ledger is replayed into an isolated in-memory Postgres and
// every rule is exercised through the real SECURITY DEFINER functions as the real
// roles (authenticated / service_role / anon), with auth.uid() driven by
// request.jwt.claims. Nothing is reimplemented in the test.
//
// NEGATIVE CONTROLS: each rule's assertion is run twice — against the real
// function (must pass) and against a copy with exactly that rule removed (the
// NAMED assertion must go red; a failure for any other reason does not count).
// The mutation is verified to change the SQL and the real function is restored.
//
// CONCURRENCY — HONEST LIMIT. PGlite is a single connection, so two simultaneous
// redemptions cannot be raced here. The guarantee that max_redemptions can never
// be exceeded rests on (1) FOR UPDATE on the promo row (serialises redeemers) and
// (2) an independent CHECK (redemption_count <= max_redemptions) which this suite
// DOES exercise: with the function's own exhaustion check removed, the database
// still refuses the over-redemption. A parallel-redemption probe is included in
// scripts/admin_premium_grant_dev_proof.mjs for DEV.
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. Not DEV-
// or production-verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_EXTENSIONS_PER_GRANT } from '@/lib/services/premiumGrantAdmin';
import { normalisePromoCode, PROMO_ALPHABET } from '@/lib/services/promoCodes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const LATEST_NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_admin_promo_codes_extension_cap_expiry_summary.sql'));
if (!LATEST_NAME) throw new Error('promo / extension-cap migration not found');
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, LATEST_NAME), 'utf8');
// The e-mail-a-code migration replaces admin_create_promo_code() and redeem_promo_code_for_user() in place (address
// binding), so their negative controls mutate and restore THAT (newest) text.
const EMAIL_SEND_NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_promo_code_email_send.sql'));
if (!EMAIL_SEND_NAME) throw new Error('promo code e-mail migration not found');
const MIGRATION_EMAIL_SEND = fs.readFileSync(path.join(MIG_DIR, EMAIL_SEND_NAME), 'utf8');

const ENT_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000b001'; // can_manage_premium_entitlements only
const PROMO_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000b002'; // can_manage_promo_codes only
const NO_CAP_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000b003'; // in admin_users, no capability
const PLAIN = 'aaaaaaaa-0000-0000-0000-00000000b004';

let db: PGlite;
let counter = 0;
type Json = Record<string, unknown>;

function extractFn(name: string, source: string = MIGRATION): string {
  const m = source.match(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
const MANAGE_FN = extractFn('admin_manage_premium_entitlement');
const REDEEM_FN = extractFn('redeem_promo_code_for_user', MIGRATION_EMAIL_SEND);
const CREATE_FN = extractFn('admin_create_promo_code', MIGRATION_EMAIL_SEND);
const WEBHOOK_FN = extractFn('apply_subscription_entitlement_event');
const SUMMARY_FN = extractFn('admin_entitlement_expiry_summary');

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

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-1000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email) values ('${id}','${label}${counter}@pg.test');`);
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

const today = async () => ((await db.query(`select current_date::text d`)).rows[0] as { d: string }).d;
const addDays = async (n: number) => ((await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0] as { d: string }).d;
const ent = async (uid: string) => norm((await db.query(`select * from user_entitlements where user_id=$1`, [uid])).rows[0] as Json);

async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection with ${code}`).toContain(code);
}

async function manage(actor: string, action: string, target: string, endsOn: string | null, reason = 'Pilot customer, invoice pending'): Promise<Json> {
  return as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_manage_premium_entitlement($1,$2,$3,$4) v`, [action, target, endsOn, reason]);
    return (rows[0] as { v: Json }).v;
  });
}

interface CreateOpts {
  code?: string | null;
  duration?: number | null;
  max?: number | null;
  unlimited?: boolean;
  expires?: string | null;
  noExpiry?: boolean;
  note?: string | null;
}
async function createPromo(actor: string, o: CreateOpts = {}): Promise<Json> {
  const exp = o.expires === undefined && !o.noExpiry ? await addDays(60) : (o.expires ?? null);
  return as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_create_promo_code($1,$2,$3,$4,$5,$6,$7) v`, [
      o.code ?? null,
      o.duration === undefined ? null : o.duration,
      o.unlimited ? null : o.max === undefined ? 100 : o.max,
      o.unlimited ?? false,
      exp,
      o.noExpiry ?? false,
      o.note ?? null,
    ]);
    return (rows[0] as { v: Json }).v;
  });
}

async function redeem(user: string, code: string, ip: string | null = null): Promise<Json> {
  return as(null, 'service_role', async () => {
    const { rows } = await db.query(`select public.redeem_promo_code_for_user($1,$2,$3) v`, [user, code, ip]);
    return (rows[0] as { v: Json }).v;
  });
}

const webhook = (uid: string, confers: boolean, status: string) =>
  as(null, 'service_role', () =>
    db.query(`select public.apply_subscription_entitlement_event($1,'stripe','cus_p','sub_p',$2,$3,'premium_monthly_au',now()+interval '30 days',false) v`, [uid, confers, status])
  );

async function aiStateV(uid: string): Promise<Json> {
  return ((await db.query(`select ai_entitlement_state($1) v`, [uid])).rows[0] as { v: Json }).v;
}

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
  let failure: Error | null = null;
  try {
    await assertion();
  } catch (e) {
    failure = e as Error;
  }
  expect(failure, 'the assertion did NOT fail against the deliberately broken rule — the test cannot detect this regression').not.toBeNull();
  expect(failure!.name, `the control failed for the wrong reason: ${failure!.message}`).toBe('AssertionError');
  expect(failure!.message, 'the control went red on a different assertion than the one it is named after').toContain(namedAssertion);
}

const UNUSABLE = { ok: false, code: 'PROMO_CODE_UNUSABLE' };

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(
    `insert into auth.users(id,email) values ('${ENT_ADMIN}','ent-admin@pg.test'),('${PROMO_ADMIN}','promo-admin@pg.test'),('${NO_CAP_ADMIN}','nocap@pg.test'),('${PLAIN}','plain@pg.test');`
  );
  await db.exec(`insert into admin_users(user_id) values ('${ENT_ADMIN}'),('${PROMO_ADMIN}'),('${NO_CAP_ADMIN}');`);
  await db.exec(`update admin_users set can_manage_premium_entitlements=true where user_id='${ENT_ADMIN}';`);
  await db.exec(`update admin_users set can_manage_promo_codes=true where user_id='${PROMO_ADMIN}';`);
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('migration shape', () => {
  it('capabilities default to false and are SEPARATE columns; promo tables have RLS; users hold no write privilege', async () => {
    const cols = (await db.query(`select can_manage_premium_entitlements p, can_manage_promo_codes c from admin_users where user_id=$1`, [NO_CAP_ADMIN])).rows[0] as { p: boolean; c: boolean };
    expect(cols).toEqual({ p: false, c: false });
    for (const t of ['promo_codes', 'promo_code_redemptions', 'promo_code_events', 'promo_redemption_attempts']) {
      const rls = (await db.query(`select relrowsecurity r from pg_class where oid=$1::regclass`, [`public.${t}`])).rows[0] as { r: boolean };
      expect(rls.r, `${t} must have RLS`).toBe(true);
      const w = (await db.query(
        `select privilege_type p from information_schema.role_table_grants where table_name=$1 and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'`, [t]
      )).rows;
      expect(w, `${t}: no write privilege for API roles`).toEqual([]);
    }
  });

  it('the SQL extension limit equals the TypeScript constant (single named constant on each side, kept in step)', async () => {
    const v = (await db.query(`select public.premium_grant_max_extensions() n`)).rows[0] as { n: number };
    expect(v.n).toBe(MAX_EXTENSIONS_PER_GRANT);
    expect(MAX_EXTENSIONS_PER_GRANT).toBe(5);
  });

  it('TypeScript and SQL normalise codes identically (case, whitespace, hyphen, underscore)', async () => {
    for (const sample of ['abc-def 234', '  Ab_C dEf\t2 3 4 ', 'ABCDEF', 'a-b-c', '']) {
      const sql = ((await db.query(`select public.promo_normalise_code($1) n`, [sample])).rows[0] as { n: string }).n;
      expect(sql, JSON.stringify(sample)).toBe(normalisePromoCode(sample));
    }
  });
});

describe('extension cap — at most 5 admin extensions per grant', () => {
  async function assertCap(): Promise<void> {
    const t = await newUser('cap');
    await manage(ENT_ADMIN, 'grant', t, await addDays(10));
    for (let i = 1; i <= MAX_EXTENSIONS_PER_GRANT; i += 1) {
      const v = await manage(ENT_ADMIN, 'extend', t, await addDays(10 + i * 10), `Extension number ${i} approved`);
      expect(v.extension_count, `extension ${i} is counted`).toBe(i);
      expect(v.extensions_remaining).toBe(MAX_EXTENSIONS_PER_GRANT - i);
    }
    const before = await ent(t);
    await expectCode(manage(ENT_ADMIN, 'extend', t, await addDays(200), 'Sixth extension attempt'), 'ENTITLEMENT_EXTENSION_LIMIT_REACHED');
    expect(await ent(t), 'a refused extension must not change the row').toEqual(before);
    expect(before.admin_grant_extension_count).toBe(MAX_EXTENSIONS_PER_GRANT);
  }

  it('extensions 1-5 succeed and are counted; the 6th is refused and changes nothing', async () => {
    await assertCap();
  });

  it('NEGATIVE CONTROL — with the cap removed a 6th extension succeeds (assertion "expected rejection with ENTITLEMENT_EXTENSION_LIMIT_REACHED" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace("if v_row.admin_grant_extension_count >= v_max_ext then raise exception 'ENTITLEMENT_EXTENSION_LIMIT_REACHED' using errcode = 'P0001'; end if;", ''),
      async () => {
        await expectAssertionFails(assertCap, 'expected rejection with ENTITLEMENT_EXTENSION_LIMIT_REACHED');
      }
    );
  });

  it('only SUCCESSFUL extensions count: a refused extension (not later / over 365 / missing reason) does not consume one', async () => {
    const t = await newUser('capnc');
    await manage(ENT_ADMIN, 'grant', t, await addDays(100));
    await expectCode(manage(ENT_ADMIN, 'extend', t, await addDays(100)), 'ENTITLEMENT_EXTENSION_NOT_LATER');
    await expectCode(manage(ENT_ADMIN, 'extend', t, await addDays(366)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    await expectCode(manage(ENT_ADMIN, 'extend', t, await addDays(200), 'short'), 'ENTITLEMENT_REASON_REQUIRED');
    expect((await ent(t)).admin_grant_extension_count).toBe(0);
    const v = await manage(ENT_ADMIN, 'extend', t, await addDays(200));
    expect(v.extension_count).toBe(1);
  });

  it('re-activating a LAPSED grant by extension counts as an extension', async () => {
    const t = await newUser('caplapsed');
    await manage(ENT_ADMIN, 'grant', t, await addDays(10));
    await db.exec(`update user_entitlements set effective_from=current_date-30, effective_to=current_date-2, admin_grant_ends_on=current_date-2 where user_id='${t}'`);
    const v = await manage(ENT_ADMIN, 'extend', t, await addDays(30));
    expect(v.extension_count).toBe(1);
    expect(v.effective_from).toBe(await today());
  });

  it('the counter RESETS on a new grant: Revoke then Grant gives a fresh allowance, and both actions are audited', async () => {
    const t = await newUser('capreset');
    await manage(ENT_ADMIN, 'grant', t, await addDays(10));
    for (let i = 1; i <= MAX_EXTENSIONS_PER_GRANT; i += 1) await manage(ENT_ADMIN, 'extend', t, await addDays(10 + i * 10));
    await expectCode(manage(ENT_ADMIN, 'extend', t, await addDays(300)), 'ENTITLEMENT_EXTENSION_LIMIT_REACHED');
    const revoked = await manage(ENT_ADMIN, 'revoke', t, null, 'Revoking to restart the grant');
    expect(revoked.extension_count).toBe(0);
    const regrant = await manage(ENT_ADMIN, 'grant', t, await addDays(30), 'Re-granting after revoke');
    expect(regrant).toMatchObject({ extension_count: 0, extensions_remaining: MAX_EXTENSIONS_PER_GRANT });
    expect((await manage(ENT_ADMIN, 'extend', t, await addDays(60))).extension_count).toBe(1);
    const actions = (await db.query(`select action, extension_count_after from admin_entitlement_events where target_user_id=$1 order by created_at, id`, [t])).rows as { action: string; extension_count_after: number }[];
    expect(actions.map((a) => a.action)).toEqual(['grant', 'extend', 'extend', 'extend', 'extend', 'extend', 'revoke', 'grant', 'extend']);
    expect(actions.map((a) => a.extension_count_after)).toEqual([0, 1, 2, 3, 4, 5, 0, 0, 1]);
  });

  it('a paying subscription keeps the counter in reserve and restores the grant with it', async () => {
    const t = await newUser('capreserve');
    await manage(ENT_ADMIN, 'grant', t, await addDays(100));
    await manage(ENT_ADMIN, 'extend', t, await addDays(150));
    await manage(ENT_ADMIN, 'extend', t, await addDays(200));
    await webhook(t, true, 'active');
    expect((await ent(t)).admin_grant_extension_count).toBe(2);
    await webhook(t, false, 'canceled');
    const r = await ent(t);
    expect(r).toMatchObject({ entitlement_source: 'admin_grant', admin_grant_extension_count: 2 });
  });

  it('an admin extending a PROMO entitlement converts it to an admin grant and counts as extension 1', async () => {
    const t = await newUser('capromo');
    const p = await createPromo(PROMO_ADMIN, { duration: 30 });
    expect((await redeem(t, p.code as string)).ok).toBe(true);
    expect((await ent(t)).entitlement_source).toBe('promo_code');
    const v = await manage(ENT_ADMIN, 'extend', t, await addDays(90));
    expect(v).toMatchObject({ entitlement_source: 'admin_grant', extension_count: 1 });
  });
});

describe('promo capability separation (Standard §3) and database-layer authorisation', () => {
  it('each capability opens ONLY its own functions: entitlement-admin cannot manage promos, promo-admin cannot manage entitlements', async () => {
    const t = await newUser('sep');
    await expectCode(createPromo(ENT_ADMIN, {}), 'PROMO_ADMIN_REQUIRED');
    await expectCode(manage(PROMO_ADMIN, 'grant', t, await addDays(10)), 'ENTITLEMENT_ADMIN_REQUIRED');
    for (const who of [PLAIN, NO_CAP_ADMIN]) await expectCode(createPromo(who, {}), 'PROMO_ADMIN_REQUIRED');
    await expect(as(null, 'anon', () => db.query(`select public.admin_list_promo_codes()`))).rejects.toThrow(/permission denied/i);
    expect((await createPromo(PROMO_ADMIN, {})).id).toBeTruthy();
  });

  it('NEGATIVE CONTROL — with the capability check removed an ordinary user can create a code (assertion "expected rejection with PROMO_ADMIN_REQUIRED" goes red)', async () => {
    await withMutation(
      CREATE_FN,
      (s) => s.replace("if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;", ''),
      async () => {
        await expectAssertionFails(async () => {
          await expectCode(createPromo(PLAIN, {}), 'PROMO_ADMIN_REQUIRED');
        }, 'expected rejection with PROMO_ADMIN_REQUIRED');
      }
    );
  });

  it('promo tables are invisible to ordinary users and to entitlement-only admins (no code enumeration via the API)', async () => {
    await createPromo(PROMO_ADMIN, {});
    for (const who of [PLAIN, ENT_ADMIN, NO_CAP_ADMIN]) {
      for (const t of ['promo_codes', 'promo_code_events', 'promo_code_redemptions']) {
        const n = await as(who, 'authenticated', async () => (await db.query(`select 1 from ${t}`)).rows.length);
        expect(n, `${t} must read as 0 rows for ${who}`).toBe(0);
      }
    }
    const adminSees = await as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select 1 from promo_codes`)).rows.length);
    expect(adminSees).toBeGreaterThan(0);
  });
});

describe('creating codes', () => {
  async function assertDuration(): Promise<void> {
    await expectCode(createPromo(PROMO_ADMIN, { duration: 366 }), 'PROMO_DURATION_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { duration: 0 }), 'PROMO_DURATION_INVALID');
    expect((await createPromo(PROMO_ADMIN, { duration: 365 })).duration_days).toBe(365);
  }
  it('duration must be 1..365 (365 accepted, 366 refused) and defaults to 30 (one month)', async () => {
    await assertDuration();
    const dflt = await createPromo(PROMO_ADMIN, { duration: null });
    expect(dflt.duration_days, 'access length defaults to one month').toBe(30);
    expect(dflt.ends_if_redeemed_today).toBe(await addDays(30));
  });
  it('NEGATIVE CONTROL — with the duration check removed the function no longer reports it (assertion "expected rejection with PROMO_DURATION_INVALID" goes red; the table CHECK is the only backstop)', async () => {
    await withMutation(
      CREATE_FN,
      (s) => s.replace("if v_duration < 1 or v_duration > 365 then raise exception 'PROMO_DURATION_INVALID' using errcode = '22023'; end if;", ''),
      async () => {
        await expectAssertionFails(assertDuration, 'expected rejection with PROMO_DURATION_INVALID');
      }
    );
  });

  it('unlimited redemptions and no-expiry must be EXPLICIT choices; finite values are bounded', async () => {
    await expectCode(createPromo(PROMO_ADMIN, { max: null, unlimited: false }), 'PROMO_MAX_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { max: 0 }), 'PROMO_MAX_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { expires: null, noExpiry: false }), 'PROMO_EXPIRY_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { expires: await addDays(-1) }), 'PROMO_EXPIRY_INVALID');
    const u = await createPromo(PROMO_ADMIN, { unlimited: true, noExpiry: true });
    expect(u).toMatchObject({ max_redemptions: null, expires_on: null });
  });

  it('codes use the unambiguous alphabet; admin-chosen codes are normalised case-insensitively; duplicates (any case/spacing) are refused', async () => {
    for (const bad of ['ABC0EF', 'ABCOEF', 'ABC1EF', 'ABCIEF', 'ABCLEF', 'SHORT', 'abc!def']) {
      await expectCode(createPromo(PROMO_ADMIN, { code: bad }), 'PROMO_CODE_INVALID');
    }
    const a = await createPromo(PROMO_ADMIN, { code: ' summer-2k26 pass ' });
    expect(a.code).toBe('SUMMER2K26PASS');
    await expectCode(createPromo(PROMO_ADMIN, { code: 'SUMMER-2K26-PASS' }), 'PROMO_CODE_EXISTS');
    await expectCode(createPromo(PROMO_ADMIN, { code: 'summer2k26pass' }), 'PROMO_CODE_EXISTS');
  });

  it('generated codes: 10 characters, only the unambiguous alphabet, unique', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const c = (await createPromo(PROMO_ADMIN, {})).code as string;
      expect(c).toHaveLength(10);
      for (const ch of c) expect(PROMO_ALPHABET.includes(ch), `char ${ch}`).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBe(40);
  });

  it('the audit trail records create with id + masked hint and NEVER the code value', async () => {
    const c = await createPromo(PROMO_ADMIN, { code: 'ADPRBXYZ77', note: 'internal note text' });
    const e = (await db.query(`select * from promo_code_events where promo_code_id=$1`, [c.id])).rows[0] as Json;
    expect(e.event_type).toBe('create');
    expect(e.actor_user_id).toBe(PROMO_ADMIN);
    const blob = JSON.stringify(e).toUpperCase();
    expect(blob.includes('ADPRBXYZ77'), 'the code value must not appear anywhere in the audit row').toBe(false);
    expect(blob.includes('INTERNAL NOTE TEXT'), 'the free-text note is not copied into the audit row either').toBe(false);
    expect(String(e.code_hint)).toMatch(/^AD\*+77$/);
  });

  it('disable needs a reason, is audited, cannot be repeated, and stops FUTURE redemptions only', async () => {
    const c = await createPromo(PROMO_ADMIN, { code: 'DSBKEMEX77' });
    const u1 = await newUser('dis');
    expect((await redeem(u1, 'DSBKEMEX77')).ok).toBe(true);
    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_disable_promo_code($1,'short')`, [c.id])), 'PROMO_REASON_REQUIRED');
    await as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_disable_promo_code($1,'Campaign finished, closing it')`, [c.id]));
    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_disable_promo_code($1,'Trying to disable twice')`, [c.id])), 'PROMO_CODE_ALREADY_DISABLED');
    const u2 = await newUser('dis2');
    expect(await redeem(u2, 'DSBKEMEX77')).toEqual(UNUSABLE);
    expect((await ent(u1)).plan_tier, 'Premium already granted is NOT revoked by disabling the code').toBe('premium');
    const ev = (await db.query(`select event_type, reason from promo_code_events where promo_code_id=$1 order by created_at, id`, [c.id])).rows as { event_type: string; reason: string | null }[];
    expect(ev.map((e) => e.event_type)).toEqual(['create', 'redeem', 'disable']);
    expect(ev[2].reason).toBe('Campaign finished, closing it');
  });

  it('promo_codes rows can never be deleted; the audit table is append-only', async () => {
    const c = await createPromo(PROMO_ADMIN, {});
    await expect(db.query(`delete from promo_codes where id=$1`, [c.id])).rejects.toThrow(/never deleted/);
    await expect(db.query(`update promo_code_events set reason='x' where promo_code_id=$1`, [c.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from promo_code_events where promo_code_id=$1`, [c.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate promo_code_events`)).rejects.toThrow(/append-only/);
  });
});

describe('redeeming a code (service_role only; identity from the authenticated route)', () => {
  it('a user cannot call the redeem function directly; only service_role can', async () => {
    const u = await newUser('direct');
    const p = await createPromo(PROMO_ADMIN, {});
    for (const [who, role] of [[u, 'authenticated'], [null, 'anon']] as const) {
      await expect(as(who, role, () => db.query(`select public.redeem_promo_code_for_user($1,$2,null)`, [u, p.code]))).rejects.toThrow(/permission denied/i);
    }
    expect((await redeem(u, p.code as string)).ok).toBe(true);
  });

  it('success: free Premium for duration_days from redemption, source promo_code + code id, same window rules, audited', async () => {
    const u = await newUser('ok');
    const p = await createPromo(PROMO_ADMIN, { duration: 365 });
    const v = await redeem(u, p.code as string);
    expect(v).toMatchObject({ ok: true, ends_on: await addDays(365), started_on: await today() });
    const r = await ent(u);
    expect(r).toMatchObject({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_to: await addDays(365), admin_grant_ends_on: await addDays(365), promo_code_id: p.id, admin_grant_extension_count: 0 });
    expect(r.effective_from).toBe(await today());
    expect((await db.query(`select redemption_count from promo_codes where id=$1`, [p.id])).rows[0]).toMatchObject({ redemption_count: 1 });
    const ev = (await db.query(`select event_type, actor_user_id, details from promo_code_events where promo_code_id=$1 and event_type='redeem'`, [p.id])).rows[0] as Json;
    expect(ev.actor_user_id).toBe(u);
  });

  it('a shorter code gives exactly its own duration (never more than 365)', async () => {
    const u = await newUser('short');
    const p = await createPromo(PROMO_ADMIN, { duration: 30 });
    expect((await redeem(u, p.code as string)).ends_on).toBe(await addDays(30));
  });

  it('is case-insensitive and ignores whitespace / hyphens / underscores', async () => {
    const p = await createPromo(PROMO_ADMIN, { code: 'CASEKXBEE99', max: 10 });
    const code = String(p.code);
    const variants = [code.toLowerCase(), `  ${code.slice(0, 5)}-${code.slice(5)} `, code.slice(0, 4) + ' ' + code.slice(4).toLowerCase(), code.split('').join('_')];
    for (const v of variants) {
      const u = await newUser('norm');
      expect((await redeem(u, v)).ok, JSON.stringify(v)).toBe(true);
    }
  });

  it('ONE redemption per user per code (the user is told so; no second grant, count unchanged)', async () => {
    async function assertOnce(): Promise<void> {
      const u = await newUser('once');
      const p = await createPromo(PROMO_ADMIN, { max: 5, duration: 30 });
      expect((await redeem(u, p.code as string)).ok).toBe(true);
      const again = await redeem(u, p.code as string);
      expect(again, 'second redemption by the same user must be refused').toEqual({ ok: false, code: 'PROMO_ALREADY_REDEEMED' });
      expect((await db.query(`select redemption_count c from promo_codes where id=$1`, [p.id])).rows[0]).toMatchObject({ c: 1 });
    }
    await assertOnce();
    await withMutation(
      REDEEM_FN,
      (s) => s.replace('if v_found and exists (select 1 from public.promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then', 'if false then'),
      async () => {
        await expectAssertionFails(assertOnce, 'second redemption by the same user must be refused');
      }
    );
  });

  it('max_redemptions can never be exceeded: the (max+1)th redeemer gets the generic verdict; the CHECK backstop holds even if the function check is removed', async () => {
    async function assertExhaustion(): Promise<void> {
      const p = await createPromo(PROMO_ADMIN, { max: 2, duration: 30 });
      const [a, b, c] = [await newUser('ex'), await newUser('ex'), await newUser('ex')];
      expect((await redeem(a, p.code as string)).ok).toBe(true);
      expect((await redeem(b, p.code as string)).ok).toBe(true);
      // A database error here (the CHECK backstop firing) is reported as a failed assertion, not swallowed.
      const third = await redeem(c, p.code as string).catch((e: Error) => ({ thrown: e.message }));
      expect(third, 'the third redemption of a max-2 code must be refused').toEqual(UNUSABLE);
      const n = (await db.query(`select redemption_count c, max_redemptions m from promo_codes where id=$1`, [p.id])).rows[0] as { c: number; m: number };
      expect(n.c).toBe(2);
      expect((await ent(c)).plan_tier).toBe('free');
    }
    await assertExhaustion();
    await withMutation(
      REDEEM_FN,
      (s) => s.replace('or (v_promo.max_redemptions is not null and v_promo.redemption_count >= v_promo.max_redemptions)', ''),
      async () => {
        await expectAssertionFails(assertExhaustion, 'the third redemption of a max-2 code must be refused');
        // ...and the independent CHECK still stopped the over-redemption (it fires, by name):
        const one = await createPromo(PROMO_ADMIN, { max: 1, duration: 30 });
        expect((await redeem(await newUser('bk'), one.code as string)).ok).toBe(true);
        await expectCode(redeem(await newUser('bk'), one.code as string), 'promo_codes_redemptions_within_max');
        const rows = (await db.query(`select 1 from promo_codes where max_redemptions is not null and redemption_count > max_redemptions`)).rows;
        expect(rows, 'redemption_count must never exceed max_redemptions, even with the function check removed').toHaveLength(0);
      }
    );
  });

  it('a code that does not exist, is disabled, is expired or is exhausted returns the IDENTICAL verdict (no oracle for which codes exist)', async () => {
    async function assertIdentical(): Promise<void> {
      const disabled = await createPromo(PROMO_ADMIN, { max: 5 });
      await as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_disable_promo_code($1,'Disabled for the oracle test')`, [disabled.id]));
      const expired = await createPromo(PROMO_ADMIN, { max: 5 });
      await db.exec(`update promo_codes set expires_on = current_date - 1 where id='${expired.id}'`);
      const exhausted = await createPromo(PROMO_ADMIN, { max: 1 });
      expect((await redeem(await newUser('o'), exhausted.code as string)).ok).toBe(true);
      const verdicts = [
        await redeem(await newUser('o'), 'NOSUCHCODE22'),
        await redeem(await newUser('o'), disabled.code as string),
        await redeem(await newUser('o'), expired.code as string),
        await redeem(await newUser('o'), exhausted.code as string),
      ];
      for (const v of verdicts) expect(v, 'all unusable verdicts must be identical').toEqual(UNUSABLE);
    }
    await assertIdentical();
    await withMutation(
      REDEEM_FN,
      (s) => s.replace('  if not v_found\n     or v_promo.status', "  if v_found and v_promo.expires_on is not null and v_promo.expires_on < v_today then return jsonb_build_object('ok', false, 'code', 'PROMO_CODE_EXPIRED'); end if;\n  if not v_found\n     or v_promo.status"),
      async () => {
        await expectAssertionFails(assertIdentical, 'all unusable verdicts must be identical');
      }
    );
  });

  it('PAID Premium is REFUSED (never clobbered or stacked), with a message that does not depend on the code', async () => {
    async function assertPaid(): Promise<void> {
      const u = await newUser('paid');
      await webhook(u, true, 'active');
      const before = await ent(u);
      const p = await createPromo(PROMO_ADMIN, { max: 5 });
      const events = (await db.query(`select count(*)::int c from promo_code_events where event_type='redeem'`)).rows[0] as { c: number };
      expect(await redeem(u, p.code as string), 'paid user must be refused').toEqual({ ok: false, code: 'PROMO_PAID_ACTIVE' });
      expect(await redeem(u, 'JUNKCODE223'), 'same verdict for a junk code (reveals nothing about codes)').toEqual({ ok: false, code: 'PROMO_PAID_ACTIVE' });
      expect(await ent(u), 'paid row untouched').toEqual(before);
      expect((await db.query(`select redemption_count c from promo_codes where id=$1`, [p.id])).rows[0]).toMatchObject({ c: 0 });
      expect(((await db.query(`select count(*)::int c from promo_code_events where event_type='redeem'`)).rows[0] as { c: number }).c).toBe(events.c);
    }
    await assertPaid();
    await withMutation(
      REDEEM_FN,
      (s) => s.replace("if v_paid_active then\n    return jsonb_build_object('ok', false, 'code', 'PROMO_PAID_ACTIVE');\n  end if;", ''),
      async () => {
        await expectAssertionFails(assertPaid, 'paid user must be refused');
      }
    );
  });

  it('an active admin grant is never shortened: a code that does not extend it is refused (generic, nothing consumed); a longer one extends it and keeps the start', async () => {
    const u = await newUser('grant');
    await manage(ENT_ADMIN, 'grant', u, await addDays(300));
    const before = await ent(u);
    const shortCode = await createPromo(PROMO_ADMIN, { duration: 90 });
    expect(await redeem(u, shortCode.code as string)).toEqual(UNUSABLE);
    expect(await ent(u), 'entitlement unchanged').toEqual(before);
    expect((await db.query(`select redemption_count c from promo_codes where id=$1`, [shortCode.id])).rows[0]).toMatchObject({ c: 0 });

    const u2 = await newUser('grant2');
    await manage(ENT_ADMIN, 'grant', u2, await addDays(100));
    const longCode = await createPromo(PROMO_ADMIN, { duration: 365 });
    const v = await redeem(u2, longCode.code as string);
    expect(v.ends_on).toBe(await addDays(365));
    const r = await ent(u2);
    expect(r).toMatchObject({ entitlement_source: 'promo_code', effective_to: await addDays(365), admin_grant_extension_count: 0 });
    expect(r.effective_from).toBe(await today());
  });

  it('a LAPSED admin grant does not block a redemption: it restarts from today', async () => {
    const u = await newUser('lapsedgrant');
    await manage(ENT_ADMIN, 'grant', u, await addDays(10));
    await db.exec(`update user_entitlements set effective_from=current_date-30, effective_to=current_date-2, admin_grant_ends_on=current_date-2 where user_id='${u}'`);
    const p = await createPromo(PROMO_ADMIN, { duration: 30 });
    const v = await redeem(u, p.code as string);
    expect(v).toMatchObject({ ok: true, started_on: await today(), ends_on: await addDays(30) });
  });

  it('abuse control: rate limit per user (10 attempts / 15 min) — attempts COMMIT even when they fail, so the 11th is refused even with a valid code', async () => {
    async function assertRateLimit(): Promise<void> {
      const u = await newUser('rl');
      const p = await createPromo(PROMO_ADMIN, { max: 5 });
      for (let i = 0; i < 10; i += 1) expect(await redeem(u, `WRONGCODE${i}2`)).toEqual(UNUSABLE);
      const persisted = (await db.query(`select count(*)::int c from promo_redemption_attempts where user_id=$1`, [u])).rows[0] as { c: number };
      expect(persisted.c, 'failed attempts must be recorded (not rolled back)').toBe(10);
      const v = await redeem(u, p.code as string);
      expect(v, 'the 11th attempt must be rate limited even with a valid code').toEqual({ ok: false, code: 'PROMO_RATE_LIMITED' });
      expect((await ent(u)).plan_tier).toBe('free');
    }
    await assertRateLimit();
    await withMutation(REDEEM_FN, (s) => s.replace('if v_user_attempts >= 10 or v_ip_attempts >= 30 then', 'if false then'), async () => {
      await expectAssertionFails(assertRateLimit, 'the 11th attempt must be rate limited even with a valid code');
    });
  });

  it('abuse control: rate limit per IP-equivalent (30 / 15 min) across different users', async () => {
    const ip = 'ip-hash-abuse-test';
    for (let i = 0; i < 30; i += 1) expect(await redeem(await newUser('ip'), 'NOSUCHCODE33', ip)).toEqual(UNUSABLE);
    const p = await createPromo(PROMO_ADMIN, { max: 5 });
    const fresh = await newUser('ip');
    expect(await redeem(fresh, p.code as string, ip), 'a different user on the same IP-equivalent is limited').toEqual({ ok: false, code: 'PROMO_RATE_LIMITED' });
    expect((await redeem(fresh, p.code as string, 'another-ip')).ok, 'a different IP-equivalent is unaffected').toBe(true);
  });

  it('no code value is stored in the attempts ledger, the audit events or the redemption rows', async () => {
    const p = await createPromo(PROMO_ADMIN, { code: 'KEAKCHECK88' });
    const u = await newUser('leak');
    await redeem(u, 'KEAKCHECK88');
    await redeem(await newUser('leak'), 'leak-check 88 typo');
    for (const t of ['promo_redemption_attempts', 'promo_code_events', 'promo_code_redemptions']) {
      const dump = ((await db.query(`select coalesce(string_agg(x::text, ' '), '') s from ${t} x`)).rows[0] as { s: string }).s.toUpperCase();
      expect(dump.includes('KEAKCHECK88'), `${t} must not contain the code`).toBe(false);
    }
    expect(p.id).toBeTruthy();
  });

  it('cross-user isolation: redeeming for A never changes B', async () => {
    const a = await newUser('iso');
    const b = await newUser('iso');
    const bBefore = await ent(b);
    const p = await createPromo(PROMO_ADMIN, { max: 5 });
    await redeem(a, p.code as string);
    expect(await ent(b)).toEqual(bBefore);
  });

  it('end-to-end with the AI path: redeem -> eligible; backdate -> premium_required; the user returns to Free like any grant', async () => {
    const u = await newUser('ai');
    const hh = `eeeeeeee-0000-0000-0000-${String(counter).padStart(12, '0')}`;
    await db.exec(`insert into households (id, user_id) values ('${hh}','${u}')`);
    const p = await createPromo(PROMO_ADMIN, { duration: 30 });
    expect((await aiStateV(u)).reason).toBe('premium_required');
    await redeem(u, p.code as string);
    expect((await aiStateV(u)).eligible).toBe(true);
    await db.exec(`update user_entitlements set effective_to = current_date - 1 where user_id='${u}'`);
    expect(await aiStateV(u)).toMatchObject({ eligible: false, reason: 'premium_required' });
  });
});

describe('Stripe/Razorpay interaction with a PROMO entitlement (same rules as an admin grant)', () => {
  async function assertPromoPaymentMerge(): Promise<void> {
    const u = await newUser('pm');
    const p = await createPromo(PROMO_ADMIN, { duration: 200 });
    await redeem(u, p.code as string);
    const end = await addDays(200);
    await webhook(u, false, 'incomplete');
    expect(await ent(u), 'abandoned checkout must not drop the promo').toMatchObject({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_to: end });
    await webhook(u, true, 'active');
    const paid = await ent(u);
    expect(paid, 'payment wins').toMatchObject({ plan_tier: 'premium', entitlement_source: 'payment', effective_to: null, admin_grant_ends_on: end, reserve_source: 'promo_code' });
    await webhook(u, false, 'canceled');
    expect(await ent(u), 'cancellation restores the promo with its ORIGINAL source').toMatchObject({ plan_tier: 'premium', entitlement_source: 'promo_code', effective_to: end });
    await webhook(u, true, 'active');
    await db.exec(`update user_entitlements set admin_grant_ends_on = current_date - 1 where user_id='${u}'`);
    await webhook(u, false, 'canceled');
    expect((await ent(u)).plan_tier).toBe('free');
  }
  it('payment wins, the promo is kept in reserve and restored with source promo_code; a lapsed reserve ends at free', async () => {
    await assertPromoPaymentMerge();
  });
  it('NEGATIVE CONTROL — a webhook that restores every reserve as admin_grant mislabels a promo (assertion "abandoned checkout must not drop the promo" goes red: it also checks the source stays promo_code)', async () => {
    await withMutation(WEBHOOK_FN, (s) => s.replace("coalesce(v_row.reserve_source, 'admin_grant')", "'admin_grant'"), async () => {
      await expectAssertionFails(assertPromoPaymentMerge, 'abandoned checkout must not drop the promo');
    });
  });
});

describe('current-month expiry summary', () => {
  it('lists admin/promo entitlements that expired this month and that expire in the rest of this month; filters by source; excludes revoked, paid and other months', async () => {
    const { ms, t, me } = (await db.query(`select (date_trunc('month', current_date))::date::text ms, current_date::text t, ((date_trunc('month', current_date) + interval '1 month - 1 day'))::date::text me`)).rows[0] as { ms: string; t: string; me: string };
    const mk = async (label: string, source: 'admin_grant' | 'promo_code', endExpr: string) => {
      const u = await newUser(label);
      await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='${source}', effective_from=current_date-400, effective_to=${endExpr}, admin_grant_ends_on=${endExpr}, reserve_source='${source}' where user_id='${u}'`);
      return u;
    };
    const expiringAdmin = await mk('sumA', 'admin_grant', `date '${me}'`);
    const expiringPromo = await mk('sumP', 'promo_code', `date '${t}'`);
    const lastMonth = await mk('sumL', 'admin_grant', `date '${ms}' - 1`);
    const nextMonth = await mk('sumN', 'admin_grant', `date '${me}' + 1`);
    const expiredThisMonth = t > ms ? await mk('sumE', 'promo_code', `date '${ms}'`) : null; // only when today is not the 1st
    const revoked = await mk('sumR', 'admin_grant', `date '${me}'`);
    await manage(ENT_ADMIN, 'revoke', revoked, null, 'Revoked before it expired');
    const paying = await newUser('sumPay');
    await webhook(paying, true, 'active');
    await db.exec(`update user_entitlements set admin_grant_ends_on=date '${me}', reserve_source='admin_grant' where user_id='${paying}'`);

    const all = await as(ENT_ADMIN, 'authenticated', async () => (await db.query(`select user_id, entitlement_source, bucket from public.admin_entitlement_expiry_summary(null)`)).rows as { user_id: string; entitlement_source: string; bucket: string }[]);
    const ids = all.map((r) => r.user_id);
    expect(ids).toContain(expiringAdmin);
    expect(ids).toContain(expiringPromo);
    if (expiredThisMonth) expect(all.find((r) => r.user_id === expiredThisMonth)?.bucket).toBe('expired_this_month');
    expect(all.find((r) => r.user_id === expiringAdmin)?.bucket).toBe('expiring_this_month');
    for (const excluded of [lastMonth, nextMonth, revoked, paying]) expect(ids).not.toContain(excluded);

    const promoOnly = await as(ENT_ADMIN, 'authenticated', async () => (await db.query(`select user_id from public.admin_entitlement_expiry_summary('promo_code')`)).rows as { user_id: string }[]);
    expect(promoOnly.map((r) => r.user_id)).toContain(expiringPromo);
    expect(promoOnly.map((r) => r.user_id)).not.toContain(expiringAdmin);
    await expectCode(as(ENT_ADMIN, 'authenticated', () => db.query(`select * from public.admin_entitlement_expiry_summary('payment')`)), 'ENTITLEMENT_FILTER_INVALID');
  });

  it('is capability-gated in the database (promo-admin without the entitlement capability, plain user, anon are refused)', async () => {
    for (const who of [PROMO_ADMIN, PLAIN, NO_CAP_ADMIN]) {
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_entitlement_expiry_summary(null)`)), 'ENTITLEMENT_ADMIN_REQUIRED');
    }
    await expect(as(null, 'anon', () => db.query(`select * from public.admin_entitlement_expiry_summary(null)`))).rejects.toThrow(/permission denied/i);
  });

  it('list and search expose source and remaining extensions for managed entitlements', async () => {
    const u = await newUser('listx');
    await manage(ENT_ADMIN, 'grant', u, await addDays(10));
    await manage(ENT_ADMIN, 'extend', u, await addDays(20));
    const row = await as(ENT_ADMIN, 'authenticated', async () => (await db.query(`select entitlement_source, extension_count, extensions_remaining from public.admin_search_premium_entitlement_users($1)`, [u])).rows[0]);
    expect(row).toEqual({ entitlement_source: 'admin_grant', extension_count: 1, extensions_remaining: MAX_EXTENSIONS_PER_GRANT - 1 });
  });
});

// ---------------------------------------------------------------------------
// Additional rules, each with its own negative control.
describe('never shortens an existing entitlement (promo)', () => {
  async function assertNeverShortens(): Promise<void> {
    const u = await newUser('never');
    await manage(ENT_ADMIN, 'grant', u, await addDays(300));
    const before = await ent(u);
    const p = await createPromo(PROMO_ADMIN, { duration: 90 });
    const verdict = await redeem(u, p.code as string);
    expect(verdict, 'a code must never shorten an existing entitlement').toEqual(UNUSABLE);
    expect(await ent(u), 'entitlement unchanged after a refused shorter code').toEqual(before);
  }
  it('a shorter code is refused with the generic verdict and the entitlement is byte-identical', async () => {
    await assertNeverShortens();
  });
  it('NEGATIVE CONTROL — with the no-benefit rule removed a 90-day code overwrites a 300-day grant (assertion "a code must never shorten an existing entitlement" goes red)', async () => {
    await withMutation(REDEEM_FN, (s) => s.replace('or (v_managed_active and v_row.effective_to >= v_end)', ''), async () => {
      await expectAssertionFails(assertNeverShortens, 'a code must never shorten an existing entitlement');
    });
  });
});

describe('the extension counter resets when a NEW grant starts after a lapse (no revoke)', () => {
  async function assertResetOnRegrant(): Promise<void> {
    const t = await newUser('lapsereset');
    await manage(ENT_ADMIN, 'grant', t, await addDays(10));
    for (let i = 1; i <= MAX_EXTENSIONS_PER_GRANT; i += 1) await manage(ENT_ADMIN, 'extend', t, await addDays(10 + i * 10));
    await db.exec(`update user_entitlements set effective_from=current_date-80, effective_to=current_date-3, admin_grant_ends_on=current_date-3 where user_id='${t}'`);
    const v = await manage(ENT_ADMIN, 'grant', t, await addDays(30), 'New grant after the previous one lapsed');
    expect(v.extension_count, 'a new grant starts with a fresh extension allowance').toBe(0);
  }
  it('Grant on a lapsed grant starts a new grant with a fresh allowance', async () => {
    await assertResetOnRegrant();
  });
  it('NEGATIVE CONTROL — if the grant did not reset the counter the old count would carry over (assertion "a new grant starts with a fresh extension allowance" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace("admin_grant_extension_count = 0, promo_code_id = null,\n           updated_at = now()\n     where user_id = p_target_user_id;\n\n  elsif p_action = 'extend'", "promo_code_id = null,\n           updated_at = now()\n     where user_id = p_target_user_id;\n\n  elsif p_action = 'extend'"),
      async () => {
        await expectAssertionFails(assertResetOnRegrant, 'a new grant starts with a fresh extension allowance');
      }
    );
  });
});

describe('no code value in the audit trail (control)', () => {
  async function assertNoCodeInAudit(): Promise<void> {
    const c = await createPromo(PROMO_ADMIN, {}); // generated, so every call has a fresh code
    const e = (await db.query(`select * from promo_code_events where promo_code_id=$1 and event_type='create'`, [c.id])).rows[0] as Json;
    expect(JSON.stringify(e).toUpperCase().includes(String(c.code)), 'the code value must not appear anywhere in the audit row').toBe(false);
  }
  it('create writes no code value to the audit row', async () => {
    await assertNoCodeInAudit();
  });
  it('NEGATIVE CONTROL — a create function that copied the code into the audit details would be caught (assertion "the code value must not appear anywhere in the audit row" goes red)', async () => {
    await withMutation(CREATE_FN, (s) => s.replace("    'bound', p_bound_email_hash is not null));", "    'bound', p_bound_email_hash is not null, 'code', v_code));"), async () => {
      await expectAssertionFails(assertNoCodeInAudit, 'the code value must not appear anywhere in the audit row');
    });
  });
});

describe('expiry summary — source filter (control)', () => {
  async function assertSourceFilter(): Promise<void> {
    const a = await newUser('sfa');
    const p = await newUser('sfp');
    const { me } = (await db.query(`select ((date_trunc('month', current_date) + interval '1 month - 1 day'))::date::text me`)).rows[0] as { me: string };
    for (const [u, src] of [[a, 'admin_grant'], [p, 'promo_code']] as const) {
      await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='${src}', effective_from=current_date-100, effective_to=date '${me}', admin_grant_ends_on=date '${me}', reserve_source='${src}' where user_id='${u}'`);
    }
    const promoOnly = await as(ENT_ADMIN, 'authenticated', async () => (await db.query(`select user_id from public.admin_entitlement_expiry_summary('promo_code')`)).rows as { user_id: string }[]);
    expect(promoOnly.map((r) => r.user_id), 'the promo-only list must not include admin grants').not.toContain(a);
    expect(promoOnly.map((r) => r.user_id)).toContain(p);
  }
  it('filtering by source returns only that source', async () => {
    await assertSourceFilter();
  });
  it('NEGATIVE CONTROL — without the source predicate the filter leaks the other source (assertion "the promo-only list must not include admin grants" goes red)', async () => {
    await withMutation(SUMMARY_FN, (s) => s.replace('and (p_source is null or e.entitlement_source = p_source)', ''), async () => {
      await expectAssertionFails(assertSourceFilter, 'the promo-only list must not include admin grants');
    });
  });
});
