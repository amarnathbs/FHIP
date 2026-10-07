// E-mailing a promo code (migration "promo_code_email_send") — real-Postgres (PGlite) proof of the
// DATABASE half: address binding (keyed hash only), the bound code's generic refusal for every other
// account, the idempotent dispatch request + per-admin rate limit, the send ledger (keyed hashes,
// no address/body/code), capability enforcement, and the old call shapes still working.
//
// NEGATIVE CONTROLS: each rule's assertion runs against the real function (must pass) and against a copy
// with exactly that rule removed (the NAMED assertion must go red; any other failure does not count). The
// mutation is verified to change the SQL and the real function is restored afterwards.
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. Not DEV- or production-verified.
// No e-mail is sent anywhere in this file (the database never sees an address at all).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { digestsFor, latestFunctionSql, makeCode, replayAll } from './support/promoTestHelpers';

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

// The hardening migrations (0265, 0266) replace redeem and begin, so the negative controls mutate and restore the NEWEST definitions.
const REDEEM_FN = latestFunctionSql('redeem_promo_code_for_user');
const BEGIN_FN = latestFunctionSql('admin_promo_email_begin');
const RECORD_FN = latestFunctionSql('admin_promo_email_record');

const PROMO_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000d001';
const PROMO_ADMIN_2 = 'aaaaaaaa-0000-0000-0000-00000000d002';
const ENT_ONLY_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000d003';
const PLAIN = 'aaaaaaaa-0000-0000-0000-00000000d004';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const UNUSABLE = { ok: false, code: 'PROMO_CODE_UNUSABLE' };

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-3000-0000-0000-${String(counter).padStart(12, '0')}`;
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

async function expectCode(p: Promise<unknown>, code: string) {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, `expected rejection with ${code}`).toContain(code);
}

const addDays = async (n: number) => ((await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0] as { d: string }).d;

async function createPromo(actor: string, o: { max?: number | null; unlimited?: boolean; hash?: string | null; recipients?: number } = {}): Promise<Json> {
  const exp = await addDays(60);
  const made = makeCode();
  const v = await as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_create_promo_code($1,$2,$3,30,$4,$5,$6,false,null,$7,$8) v`, [
      made.digest,
      made.hint,
      made.version,
      o.unlimited ? null : o.max === undefined ? 5 : o.max,
      o.unlimited ?? false,
      exp,
      o.hash ?? null,
      o.recipients ?? 0,
    ]);
    return (rows[0] as { v: Json }).v;
  });
  return { ...v, code: made.plain };
}

async function redeem(user: string, code: string, emailHash: string | null = null): Promise<Json> {
  return as(null, 'service_role', async () => {
    const q = await db.query(`select public.redeem_promo_code_for_user($1,$2::text[],null,$3) v`, [user, digestsFor(code), emailHash]);
    return (q.rows[0] as { v: Json }).v;
  });
}

const begin = (actor: string, key: string, count = 1, bound = false) =>
  as(actor, 'authenticated', async () => ((await db.query(`select public.admin_promo_email_begin($1,$2,$3,'create','Pilot cohort welcome codes',null) v`, [key, count, bound])).rows[0] as { v: Json }).v);
const record = (actor: string, key: string, codeId: unknown, hash: string, status: string, attempts = 1, msg: string | null = null, err: string | null = null) =>
  as(actor, 'authenticated', async () => ((await db.query(`select public.admin_promo_email_record($1,$2,$3,$4,$5,$6,$7) r`, [key, codeId, hash, status, attempts, msg, err])).rows[0] as { r: boolean }).r);

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

async function expectAssertionFails(assertion: () => Promise<void>, named: string) {
  let failure: Error | null = null;
  try {
    await assertion();
  } catch (e) {
    failure = e as Error;
  }
  expect(failure, 'the assertion did NOT fail against the deliberately broken rule — the test cannot detect this regression').not.toBeNull();
  expect(failure!.name, `the control failed for the wrong reason: ${failure!.message}`).toBe('AssertionError');
  expect(failure!.message, 'the control went red on a different assertion than the one it is named after').toContain(named);
}

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db);
  await db.exec(
    `insert into auth.users(id,email) values ('${PROMO_ADMIN}','pa1@pg.test'),('${PROMO_ADMIN_2}','pa2@pg.test'),('${ENT_ONLY_ADMIN}','ea@pg.test'),('${PLAIN}','plain@pg.test');
     insert into admin_users(user_id) values ('${PROMO_ADMIN}'),('${PROMO_ADMIN_2}'),('${ENT_ONLY_ADMIN}');
     update admin_users set can_manage_promo_codes=true where user_id in ('${PROMO_ADMIN}','${PROMO_ADMIN_2}');
     update admin_users set can_manage_premium_entitlements=true where user_id='${ENT_ONLY_ADMIN}';`
  );
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('the previous call shapes are GONE once the cleanup 0279 has run (hash only storage): no overload of the old signatures remains', () => {
  it('the old 9-argument create, the old 4-argument redeem and the old 3-argument begin no longer exist, and each function exists exactly once', async () => {
    for (const name of ['admin_create_promo_code', 'redeem_promo_code_for_user', 'admin_promo_email_begin', 'admin_list_promo_codes_v2']) {
      expect(((await db.query(`select count(*)::int n from pg_proc where proname=$1`, [name])).rows[0] as { n: number }).n, name).toBe(1);
    }
    expect(((await db.query(`select count(*)::int n from pg_proc where proname='admin_list_promo_codes'`)).rows[0] as { n: number }).n, 'the old list (it returned the plain code) is gone').toBe(0);
    await expect(db.query(`select public.admin_create_promo_code(null,30,5,false,null,false,null,null,0)`)).rejects.toThrow(/does not exist/);
    await expect(db.query(`select public.redeem_promo_code_for_user($1,'ABCDEFGHJK',null,null)`, [PLAIN]), 'the old plain code call can no longer be made').rejects.toThrow(/malformed array literal|does not exist/);
  });
});

describe('address binding (keyed hash only)', () => {
  it('a bound code is created single-use; unlimited / max != 1 / a malformed hash are refused by the database', async () => {
    const ok = await createPromo(PROMO_ADMIN, { max: 1, hash: HASH_A, recipients: 1 });
    expect(ok).toMatchObject({ bound: true, max_redemptions: 1 });
    await expectCode(createPromo(PROMO_ADMIN, { max: 2, hash: HASH_A, recipients: 1 }), 'PROMO_MAX_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { unlimited: true, hash: HASH_A, recipients: 1 }), 'PROMO_MAX_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { max: 1, hash: 'not-a-hash', recipients: 1 }), 'PROMO_BINDING_INVALID');
    await expectCode(createPromo(PROMO_ADMIN, { max: 1, hash: HASH_A, recipients: 21 }), 'PROMO_RECIPIENTS_INVALID');
  });

  it('the table CHECKs are an independent backstop (a bound code can never be multi-use or hold a malformed hash)', async () => {
    const c = await createPromo(PROMO_ADMIN, { max: 5 });
    await expect(db.query(`update promo_codes set bound_email_hash=$1 where id=$2`, [HASH_A, c.id])).rejects.toThrow(/promo_codes_bound_single_use/);
    await expect(db.query(`update promo_codes set max_redemptions=1, bound_email_hash='nope' where id=$1`, [c.id])).rejects.toThrow(/promo_codes_bound_hash_shape/);
  });

  async function assertBinding(): Promise<void> {
    const c = await createPromo(PROMO_ADMIN, { max: 1, hash: HASH_A, recipients: 1 });
    const code = c.code as string;
    const stranger = await newUser('stranger');
    const owner = await newUser('owner');
    const missing = await redeem(await newUser('m'), 'NOSUCHCODE22');
    for (const [label, v] of [
      ['a different hash', await redeem(stranger, code, HASH_B)],
      ['no hash', await redeem(stranger, code, null)],
    ] as const) {
      expect(v, `a bound code must not be redeemable by any other account (${label})`).toEqual(UNUSABLE);
      expect(v, 'and must read exactly like a code that does not exist').toEqual(missing);
    }
    const before = (await db.query(`select redemption_count c from promo_codes where id=$1`, [c.id])).rows[0] as { c: number };
    expect(before.c, 'a refused attempt consumes nothing').toBe(0);
    const entitlement = (await db.query(`select plan_tier from user_entitlements where user_id=$1`, [stranger])).rows[0] as { plan_tier: string };
    expect(entitlement.plan_tier).toBe('free');
    expect((await redeem(owner, code, HASH_A)).ok, 'the bound recipient can redeem').toBe(true);
  }
  it('only the account whose keyed e-mail hash matches can redeem; every other account gets the generic verdict identical to a missing code', async () => {
    await assertBinding();
  });
  it('NEGATIVE CONTROL — with the binding clause removed any account can redeem a bound code (assertion "a bound code must not be redeemable by any other account" goes red)', async () => {
    await withMutation(
      REDEEM_FN,
      (s) =>
        s.replace(
          /     or \(v_promo\.bound_email_hash is not null\n         and \(p_email_hash is null or coalesce\(v_verified, false\) = false or v_promo\.bound_email_hash is distinct from p_email_hash\)\)\n/,
          ''
        ),
      async () => {
        await expectAssertionFails(assertBinding, 'a bound code must not be redeemable by any other account');
      }
    );
  });

  it('the admin list shows THAT a code is bound but never exposes the hash', async () => {
    await createPromo(PROMO_ADMIN, { max: 1, hash: HASH_B, recipients: 1 });
    const rows = await as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select * from public.admin_list_promo_codes_v2()`)).rows as Json[]);
    expect(rows.some((r) => r.bound === true)).toBe(true);
    expect(rows.every((r) => !('bound_email_hash' in r))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(HASH_B);
  });

  it('the audit event records the recipient COUNT and a bound flag, never an address, a hash or the code', async () => {
    const c = await createPromo(PROMO_ADMIN, { max: 1, hash: HASH_A, recipients: 1 });
    const e = (await db.query(`select * from promo_code_events where promo_code_id=$1 and event_type='create'`, [c.id])).rows[0] as Json;
    expect(e.details).toMatchObject({ recipient_count: 1, bound: true });
    const blob = JSON.stringify(e).toUpperCase();
    expect(blob.includes(String(c.code)), 'the code value must not appear in the audit row').toBe(false);
    expect(blob.includes(HASH_A.toUpperCase()), 'the address hash must not appear in the audit row').toBe(false);
    expect(String(e.code_hint)).toMatch(/^[A-Z0-9]{2}\*+[A-Z0-9]{2}$/);
  });
});

describe('dispatch request: capability, idempotency key, per-admin rate limit', () => {
  it('only a promo-code admin may begin a request (plain user, entitlement-only admin, anon refused)', async () => {
    await expectCode(begin(PLAIN, 'key-plain-0001'), 'PROMO_ADMIN_REQUIRED');
    await expectCode(begin(ENT_ONLY_ADMIN, 'key-ent-0001'), 'PROMO_ADMIN_REQUIRED');
    await expect(as(null, 'anon', () => db.query(`select public.admin_promo_email_begin('key-anon-0001',1,false,'create','Pilot cohort welcome codes',null)`))).rejects.toThrow(/permission denied/i);
    await expect(as(null, 'service_role', () => db.query(`select public.admin_promo_email_begin('key-svc-00001',1,false,'create','Pilot cohort welcome codes',null)`))).rejects.toThrow(/PROMO_UNAUTHENTICATED/);
  });

  it('keys must be 8..100 characters and recipient counts 1..20', async () => {
    await expectCode(begin(PROMO_ADMIN, 'short'), 'PROMO_EMAIL_KEY_INVALID');
    await expectCode(begin(PROMO_ADMIN, 'k'.repeat(101)), 'PROMO_EMAIL_KEY_INVALID');
    await expectCode(begin(PROMO_ADMIN, 'key-count-0001', 0), 'PROMO_RECIPIENTS_INVALID');
    await expectCode(begin(PROMO_ADMIN, 'key-count-0002', 21), 'PROMO_RECIPIENTS_INVALID');
  });

  async function assertIdempotent(): Promise<void> {
    const key = `idem-${counter++}-${Math.random().toString(36).slice(2, 10)}`;
    const first = await begin(PROMO_ADMIN, key, 2, false);
    expect(first).toMatchObject({ new: true });
    const again = await begin(PROMO_ADMIN, key, 2, false).catch((e: Error) => ({ thrown: e.message }));
    expect(again, 'a repeated request key must be reported as NOT new').toEqual({ new: false });
    const n = (await db.query(`select count(*)::int c from promo_email_requests where request_key=$1`, [key])).rows[0] as { c: number };
    expect(n.c, 'exactly one request row per key').toBe(1);
  }
  it('the same (admin, key) is new once and a duplicate afterwards; another admin may reuse the same key text', async () => {
    await assertIdempotent();
    expect(await begin(PROMO_ADMIN_2, 'shared-key-0001')).toMatchObject({ new: true });
    expect(await begin(PROMO_ADMIN, 'shared-key-0001')).toMatchObject({ new: true });
  });
  it('NEGATIVE CONTROL — without the duplicate handling a repeated key is not reported as a duplicate (assertion "a repeated request key must be reported as NOT new" goes red; the UNIQUE key fires by name)', async () => {
    await withMutation(
      BEGIN_FN,
      (s) =>
        s
          .replace(/  if exists \(select 1 from public\.promo_email_requests where admin_user_id = v_actor and request_key = p_request_key\) then\n    return jsonb_build_object\('new', false\);\n  end if;\n/, '')
          .replace('  on conflict on constraint uq_promo_email_request do nothing\n', '\n'),
      async () => {
        await expectAssertionFails(assertIdempotent, 'a repeated request key must be reported as NOT new');
        await begin(PROMO_ADMIN, 'ctrl-unique-0001');
        await expect(begin(PROMO_ADMIN, 'ctrl-unique-0001')).rejects.toThrow(/uq_promo_email_request/);
      }
    );
  });

  async function assertRateLimit(): Promise<void> {
    const admin = PROMO_ADMIN_2;
    await db.exec(`delete from promo_email_requests where admin_user_id='${admin}'`);
    for (let i = 0; i < 10; i += 1) await begin(admin, `rl-${counter}-${i}-aaaa`);
    await expectCode(begin(admin, `rl-${counter}-11-aaaa`), 'PROMO_EMAIL_RATE_LIMITED');
    // per-admin: another admin is unaffected
    expect(await begin(PROMO_ADMIN, `rl-other-${counter}-aaaa`), 'another admin is not limited by this one').toMatchObject({ new: true });
  }
  it('10 requests per rolling hour per admin; the 11th is refused; another admin is unaffected', async () => {
    counter += 1;
    await assertRateLimit();
  });
  it('100 recipients per rolling hour per admin', async () => {
    await db.exec(`delete from promo_email_requests where admin_user_id='${PROMO_ADMIN_2}'`);
    for (let i = 0; i < 5; i += 1) await begin(PROMO_ADMIN_2, `rc-${counter}-${i}-bbbb`, 20);
    await expectCode(begin(PROMO_ADMIN_2, `rc-${counter}-6-bbbb`, 1), 'PROMO_EMAIL_RATE_LIMITED');
    await db.exec(`delete from promo_email_requests where admin_user_id='${PROMO_ADMIN_2}'`);
  });
  it('NEGATIVE CONTROL — with the rate limit removed the 11th request goes through (assertion "expected rejection with PROMO_EMAIL_RATE_LIMITED" goes red)', async () => {
    counter += 1;
    await withMutation(BEGIN_FN, (s) => s.replace('if v_recent_requests >= 10 or v_recent_recipients + p_recipient_count > 100 then', 'if false then'), async () => {
      await expectAssertionFails(assertRateLimit, 'expected rejection with PROMO_EMAIL_RATE_LIMITED');
    });
    await db.exec(`delete from promo_email_requests where admin_user_id='${PROMO_ADMIN_2}'`);
  });
});

describe('send ledger — keyed hashes only, a sent row is never downgraded', () => {
  it('records outcomes per recipient hash; unknown request -> false; bad status refused; capability enforced', async () => {
    const key = `ledger-${counter++}-xxxx`;
    const c = await createPromo(PROMO_ADMIN, { max: 5 });
    expect(await record(PROMO_ADMIN, key, c.id, HASH_A, 'sent'), 'a record for an unknown request is refused').toBe(false);
    await begin(PROMO_ADMIN, key, 2);
    expect(await record(PROMO_ADMIN, key, c.id, HASH_A, 'sent', 1, 'msg_1')).toBe(true);
    expect(await record(PROMO_ADMIN, key, c.id, HASH_B, 'abandoned', 3, null, 'resend_http_500')).toBe(true);
    const rows = (await db.query(`select recipient_hash, status, attempts, last_error, provider_message_id from promo_email_sends where request_key=$1 order by recipient_hash`, [key])).rows as Json[];
    expect(rows).toEqual([
      { recipient_hash: HASH_A, status: 'sent', attempts: 1, last_error: null, provider_message_id: 'msg_1' },
      { recipient_hash: HASH_B, status: 'abandoned', attempts: 3, last_error: 'resend_http_500', provider_message_id: null },
    ]);
    await expectCode(record(PROMO_ADMIN, key, c.id, HASH_A, 'bogus'), 'PROMO_EMAIL_KEY_INVALID');
    await expectCode(record(PLAIN, key, c.id, HASH_A, 'sent'), 'PROMO_ADMIN_REQUIRED');
    await expect(db.query(`insert into promo_email_sends(admin_user_id,request_key,promo_code_id,recipient_hash,status) values ($1,'k',$2,'zz','sent')`, [PROMO_ADMIN, c.id])).rejects.toThrow();
  });

  async function assertNoDowngrade(): Promise<void> {
    const key = `nodown-${counter++}-yyyy`;
    const c = await createPromo(PROMO_ADMIN, { max: 5 });
    await begin(PROMO_ADMIN, key, 1);
    await record(PROMO_ADMIN, key, c.id, HASH_A, 'sent', 1, 'm');
    await record(PROMO_ADMIN, key, c.id, HASH_A, 'abandoned', 3, null, 'late');
    const r = (await db.query(`select status from promo_email_sends where request_key=$1`, [key])).rows[0] as { status: string };
    expect(r.status, 'a sent row must never be downgraded').toBe('sent');
  }
  it('a late failure cannot downgrade a sent row', async () => {
    await assertNoDowngrade();
  });
  it('NEGATIVE CONTROL — without the guard a late failure overwrites a sent row (assertion "a sent row must never be downgraded" goes red)', async () => {
    await withMutation(RECORD_FN, (s) => s.replace("\n    -- a settled 'sent' row is never downgraded\n    where public.promo_email_sends.status <> 'sent';", ';'), async () => {
      await expectAssertionFails(assertNoDowngrade, 'a sent row must never be downgraded');
    });
  });

  it('the ledger and request tables hold no address, body or code value, and are readable only by promo admins', async () => {
    for (const t of ['promo_email_requests', 'promo_email_sends']) {
      const cols = (await db.query(`select column_name from information_schema.columns where table_name=$1`, [t])).rows.map((r) => (r as { column_name: string }).column_name);
      for (const forbidden of ['email', 'address', 'body', 'subject', 'text', 'code']) expect(cols, `${t}.${forbidden}`).not.toContain(forbidden);
      expect(await as(PLAIN, 'authenticated', async () => (await db.query(`select 1 from ${t}`)).rows.length)).toBe(0);
      expect(await as(ENT_ONLY_ADMIN, 'authenticated', async () => (await db.query(`select 1 from ${t}`)).rows.length)).toBe(0);
      await expect(as(PROMO_ADMIN, 'authenticated', () => db.query(`delete from ${t}`))).rejects.toThrow(/permission denied/i);
    }
    expect(await as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select 1 from promo_email_requests`)).rows.length)).toBeGreaterThan(0);
  });
});
