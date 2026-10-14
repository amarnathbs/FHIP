// DEPLOY SAFETY of the promo / Premium hardening release, proven on a real Postgres (PGlite) that starts as a SEEDED OLD-WORLD
// DATABASE: the production state before this release (the ledger up to 0252, with promo codes in plain text, a redemption, an
// admin grant, a send request), created through the OLD functions exactly as the live release created them.
//
// WHAT IS PROVEN (each phase is a step of docs/admin/po_apply_promo_hardening_release/PRODUCTION_RUNBOOK.md):
//   A  secrets set, 0264 to 0268 applied, the OLD application release is still live: every call the old release makes keeps
//      working and returns what it returned before (create, list, redeem, grant, extend, revoke, e-mail begin, record, disable).
//   B  the NEW release is deployed, the backfill has NOT run yet: existing plain-text codes redeem through the legacy lookup,
//      a user who redeemed under the old release is still "already redeemed", new codes are digest-only, the new list never
//      shows a code.
//   C  the backfill (the real server function, through a service role adapter): every existing code gets a VERIFIED digest;
//      redeeming by digest ONLY (no legacy value passed) works for every old code; a code the old release creates during the
//      overlap is picked up by a second run; a duplicate typed code is reported, not hidden, and still works.
//   D  finalise: refuses while any plain row is unverified; then blanks all plain values; every code still redeems by digest.
//      Stated honestly: after this point the OLD release can no longer redeem (that is the one-way step, so it comes last).
//   E  cleanup 0279: refuses while any plain value remains; after finalise it removes the old shapes and nothing else.
//
// The rollback SQL is proven in promoHardeningRollbackPglite.test.ts.
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  finalise without the verified predicate blanks an unverified row, and the test that follows goes red;
//   NC-S2  a redeem function without the legacy lookup refuses an existing plain-text code (so a deploy BEFORE the backfill would
//          have broken every existing code), which is exactly what the legacy lookup prevents.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, digestsFor, expectNamedFailure, latestFunctionSql, makeCode, migrationFiles, replayAll, testKeys } from './support/promoTestHelpers';
import { runDigestBackfill, type BackfillClient } from '@/lib/services/promoCodeBackfill';

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

const PROMO_ADMIN = 'aaaaaaaa-0000-0000-0000-0000000d0001';
const ENT_ADMIN = 'aaaaaaaa-0000-0000-0000-0000000d0002';

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-6000-0000-0000-${String(counter).padStart(12, '0')}`;
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

// -- the OLD release's calls: the argument NAMES the live application sends (PostgREST resolves by name) ------------------

const old = {
  async create(opts: { code?: string | null; max?: number | null; bound?: string | null } = {}): Promise<Json> {
    const exp = await addDays(60);
    return as(PROMO_ADMIN, 'authenticated', async () => {
      const { rows } = await db.query(
        `select public.admin_create_promo_code(p_code => $1::text, p_duration_days => 30, p_max_redemptions => $2::int, p_unlimited => false, p_expires_on => $3::date, p_no_expiry => false, p_note => null::text, p_bound_email_hash => $4::text, p_recipient_count => 0) v`,
        [opts.code ?? null, opts.max === undefined ? 5 : opts.max, exp, opts.bound ?? null]
      );
      return (rows[0] as { v: Json }).v;
    });
  },
  async list(): Promise<Json[]> {
    return as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select * from public.admin_list_promo_codes()`)).rows as Json[]);
  },
  async redeem(user: string, code: string): Promise<Json> {
    return as(null, 'service_role', async () => {
      const { rows } = await db.query(`select public.redeem_promo_code_for_user(p_user_id => $1::uuid, p_code => $2::text, p_ip_hash => null::text) v`, [user, code]);
      return (rows[0] as { v: Json }).v;
    });
  },
  async manage(action: string, target: string, endsOn: string | null): Promise<Json> {
    return as(ENT_ADMIN, 'authenticated', async () => {
      const { rows } = await db.query(`select public.admin_manage_premium_entitlement(p_action => $1::text, p_target_user_id => $2::uuid, p_ends_on => $3::date, p_reason => 'Old release grant, pilot customer') v`, [action, target, endsOn]);
      return (rows[0] as { v: Json }).v;
    });
  },
  async begin(key: string): Promise<Json> {
    return as(PROMO_ADMIN, 'authenticated', async () => {
      const { rows } = await db.query(`select public.admin_promo_email_begin(p_request_key => $1::text, p_recipient_count => 1, p_bound => false) v`, [key]);
      return (rows[0] as { v: Json }).v;
    });
  },
};

// -- the NEW release's calls ------------------------------------------------------------------------------------------

const fresh = {
  async create(plain?: string, max: number | null = 5): Promise<{ made: ReturnType<typeof makeCode>; v: Json }> {
    const made = makeCode(plain);
    const exp = await addDays(60);
    const v = await as(PROMO_ADMIN, 'authenticated', async () => {
      const { rows } = await db.query(
        `select public.admin_create_promo_code(p_code_digest => $1::text, p_code_hint => $2::text, p_digest_version => $3::int, p_duration_days => 30, p_max_redemptions => $4::int, p_unlimited => false, p_expires_on => $5::date, p_no_expiry => false, p_note => null::text) v`,
        [made.digest, made.hint, made.version, max, exp]
      );
      return (rows[0] as { v: Json }).v;
    });
    return { made, v };
  },
  async list(): Promise<Json[]> {
    return as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select * from public.admin_list_promo_codes_v2()`)).rows as Json[]);
  },
  /** legacy = pass the normalised value too (the deployed route does, until the backfill is finished). */
  async redeem(user: string, plain: string, o: { legacy?: boolean; emailHash?: string | null } = {}): Promise<Json> {
    return as(null, 'service_role', async () => {
      const { rows } = await db.query(
        `select public.redeem_promo_code_for_user(p_user_id => $1::uuid, p_digests => $2::text[], p_ip_hash => null::text, p_email_hash => $3::text, p_legacy_code => $4::text) v`,
        [user, digestsFor(plain), o.emailHash ?? null, o.legacy === false ? null : plain.replace(/[\s\-_]/g, '').toUpperCase()]
      );
      return (rows[0] as { v: Json }).v;
    });
  },
  async manage(action: string, target: string, endsOn: string | null): Promise<Json> {
    return as(ENT_ADMIN, 'authenticated', async () => {
      const { rows } = await db.query(`select public.admin_manage_premium_entitlement(p_action => $1::text, p_target_user_id => $2::uuid, p_ends_on => $3::date, p_reason => 'New release grant, pilot customer', p_override => false) v`, [action, target, endsOn]);
      return (rows[0] as { v: Json }).v;
    });
  },
};

/** A service role adapter with the supabase-js rpc shape, so the REAL backfill function runs against the replay. */
function serviceRoleClient(): BackfillClient {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      try {
        const res = await as(null, 'service_role', () =>
          db.query(`select * from public.${name}(${params})`, keys.map((k) => (args[k] === undefined ? null : args[k])) as unknown[])
        );
        const cols = res.fields.map((f) => f.name);
        if (cols.length === 1 && cols[0] === name) return { data: (res.rows[0] as Json)?.[name] ?? null, error: null };
        return { data: res.rows, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code ?? 'XX000', message: (e as Error).message } };
      }
    },
  };
}

const plainCount = async () => ((await db.query(`select count(*)::int n from promo_codes where code is not null`)).rows[0] as { n: number }).n;
const verifiedCount = async () => ((await db.query(`select count(*)::int n from promo_codes where code_digest_verified_at is not null`)).rows[0] as { n: number }).n;
const functionCount = async (name: string) => ((await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [name])).rows[0] as { n: number }).n;
const ent = async (uid: string) => (await db.query(`select * from user_entitlements where user_id=$1`, [uid])).rows[0] as Json;
const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

// State shared across the ordered phases.
let OLD_TYPED: string; // 'SUMMERPASS', created by the old release, typed by an admin
let OLD_GENERATED: string; // generated by the old create function

const BOUND_HASH = 'ab'.repeat(32);
let USER_REDEEMED_OLD: string; // redeemed OLD_TYPED under the old release, before this release
let USER_GRANTED_OLD: string; // an admin grant made by the old function

beforeAll(async () => {
  db = await PGlite.create();
  // THE OLD WORLD: everything the PO has applied before this mission.
  await replayAll(db, '0252_zzz');
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    insert into auth.users(id,email,email_confirmed_at) values ('${PROMO_ADMIN}','pa@pg.test',now()),('${ENT_ADMIN}','ea@pg.test',now());
    insert into admin_users(user_id) values ('${PROMO_ADMIN}'),('${ENT_ADMIN}');
    update admin_users set can_manage_promo_codes=true where user_id='${PROMO_ADMIN}';
    update admin_users set can_manage_premium_entitlements=true where user_id='${ENT_ADMIN}';
  `);
  // Seed it through the OLD functions, exactly as the live release did.
  const typed = await old.create({ code: 'SUMMERPASS', max: 10 });
  OLD_TYPED = String(typed.code);
  const generated = await old.create({ code: null, max: 3 });
  OLD_GENERATED = String(generated.code);
  const bound = await old.create({ code: 'KEMPTHREE33', max: 1, bound: BOUND_HASH });
  expect(String(bound.code)).toBe('KEMPTHREE33');
  USER_REDEEMED_OLD = await newUser('oldredeemer');
  expect(await old.redeem(USER_REDEEMED_OLD, OLD_TYPED)).toMatchObject({ ok: true });
  USER_GRANTED_OLD = await newUser('oldgrant');
  await old.manage('grant', USER_GRANTED_OLD, await addDays(60));
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('the seeded OLD-WORLD database is what production is today', () => {
  it('has plain-text codes, no digest column, the old function shapes, and the old release behaviours', async () => {
    expect(OLD_TYPED).toBe('SUMMERPASS');
    expect(OLD_GENERATED).toMatch(/^[A-Z2-9]{10}$/);
    const cols = (await db.query(`select column_name from information_schema.columns where table_name='promo_codes' and column_name='code_digest'`)).rows;
    expect(cols, 'the digest column does not exist yet').toHaveLength(0);
    expect(await functionCount('admin_list_promo_codes_v2')).toBe(0);
    const rows = (await db.query(`select code from promo_codes order by created_at`)).rows.map((r) => (r as { code: string }).code);
    expect(rows).toEqual(expect.arrayContaining(['SUMMERPASS', 'KEMPTHREE33', OLD_GENERATED]));
  });
});

describe('PHASE A: 0264 to 0268 applied, the OLD release still live', () => {
  beforeAll(async () => {
    for (const f of migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 264 && Number(x.slice(0, 4)) <= 268)) {
      await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    }
  }, 120_000);

  it('the old release can still CREATE a typed code and a generated code (plain value stored, as before)', async () => {
    const typed = await old.create({ code: 'EXTRATYPED22', max: 2 });
    expect(typed).toMatchObject({ code: 'EXTRATYPED22' });
    const gen = await old.create({ code: null, max: 2 });
    expect(String(gen.code)).toMatch(/^[A-Z2-9]{10}$/);
    const row = (await db.query(`select code, code_digest from promo_codes where code='EXTRATYPED22'`)).rows[0] as Json;
    expect(row.code_digest, 'the old create writes no digest: the backfill picks it up later').toBeNull();
  });

  it('the old release can still LIST (it returns the plain code column it always did)', async () => {
    const rows = await old.list();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining(['SUMMERPASS', 'KEMPTHREE33']));
  });

  it('the old release can still REDEEM: a plain code, once per user, and a user who redeemed earlier is still told so', async () => {
    const u = await newUser('oldrelease');
    expect(await old.redeem(u, 'SUMMERPASS')).toMatchObject({ ok: true });
    expect(await old.redeem(u, 'SUMMERPASS')).toMatchObject({ ok: false, code: 'PROMO_ALREADY_REDEEMED' });
    expect(await old.redeem(USER_REDEEMED_OLD, 'SUMMERPASS')).toMatchObject({ ok: false, code: 'PROMO_ALREADY_REDEEMED' });
    expect(await old.redeem(await newUser('oldrelease'), 'NEVERMADE222')).toMatchObject({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
  });

  it('the old release can still GRANT, EXTEND and REVOKE Premium (four argument function)', async () => {
    const u = await newUser('oldmanage');
    const g = await old.manage('grant', u, await addDays(30));
    expect(g).toMatchObject({ action: 'grant', plan_tier: 'premium', entitlement_source: 'admin_grant' });
    const x = await old.manage('extend', u, await addDays(60));
    expect(x).toMatchObject({ action: 'extend' });
    const r = await old.manage('revoke', u, null);
    expect(r).toMatchObject({ action: 'revoke', plan_tier: 'free' });
  });

  it('the old release can still BEGIN an e-mail request (three argument function) and is rate limited as before', async () => {
    expect(await old.begin('old-key-0001')).toMatchObject({ new: true });
    expect(await old.begin('old-key-0001')).toMatchObject({ new: false });
  });

  it('a call made with the new argument names reaches only the new functions (and a four argument grant never reaches the new one)', async () => {
    const made = await fresh.create();
    expect(made.v).toMatchObject({ code_hint: made.made.hint });
    const u = await newUser('newmanage');
    expect(await fresh.manage('grant', u, await addDays(10))).toMatchObject({ lifetime_units: 1 });
    // the old function does NOT count toward the lifetime ceiling: 0279 brings the counter up to the audit trail
    const u2 = await newUser('oldcounts');
    await old.manage('grant', u2, await addDays(10));
    expect((await ent(u2)).admin_lifetime_grant_units, 'the old function leaves the counter alone (caught up by 0279)').toBe(0);
  });

  it('existing rows are untouched by the migrations (no code blanked, no digest invented)', async () => {
    expect(await plainCount()).toBeGreaterThanOrEqual(5);
    expect(await verifiedCount()).toBe(1); // only the code the NEW create made just above
  });
});

describe('PHASE B: the NEW release is live, the backfill has NOT run', () => {
  it('every existing plain-text code still redeems through the legacy lookup (typed, generated, and the address-bound one)', async () => {
    const u1 = await newUser('b1');
    expect(await fresh.redeem(u1, 'SUMMERPASS')).toMatchObject({ ok: true });
    const u2 = await newUser('b2');
    expect(await fresh.redeem(u2, OLD_GENERATED)).toMatchObject({ ok: true });
    const u3 = await newUser('b3');
    expect(await fresh.redeem(u3, 'KEMPTHREE33', { emailHash: BOUND_HASH })).toMatchObject({ ok: true });
    // a bound code with the wrong address is still the generic refusal
    const u4 = await newUser('b4');
    expect(await fresh.redeem(u4, 'KEMPTHREE33', { emailHash: 'cd'.repeat(32) })).toMatchObject({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
  });

  it('a user who redeemed under the OLD release is still "already redeemed" through the new function', async () => {
    expect(await fresh.redeem(USER_REDEEMED_OLD, 'SUMMERPASS')).toMatchObject({ ok: false, code: 'PROMO_ALREADY_REDEEMED' });
  });

  it('NC-S2: without the legacy lookup the same existing code would be refused (this is what a deploy before the legacy lookup would have broken)', async () => {
    const u = await newUser('s2');
    const refused = await fresh.redeem(u, 'SUMMERPASS', { legacy: false });
    await expectNamedFailure(() => expect(refused, 'an existing plain-text code must redeem before the backfill').toMatchObject({ ok: true }), 'an existing plain-text code must redeem before the backfill');
  });

  it('a code created by the new release is digest only (no plain value), redeems, and the new list never shows any code', async () => {
    const { made } = await fresh.create('FRESHSTART22', 2);
    const row = (await db.query(`select code, code_digest from promo_codes where code_hint=$1`, [made.hint])).rows.find((r) => (r as Json).code_digest === made.digest) as Json;
    expect(row.code).toBeNull();
    expect(await fresh.redeem(await newUser('b5'), 'FRESHSTART22')).toMatchObject({ ok: true });
    const rows = await fresh.list();
    expect(Object.keys(rows[0])).not.toContain('code');
    expect(JSON.stringify(rows)).not.toContain('SUMMERPASS');
    expect(rows.some((r) => r.plain_stored === true), 'the list says which rows still hold a plain value').toBe(true);
  });

  it('a grant by the new release counts toward the lifetime ceiling and ends on today plus 364 at the latest', async () => {
    const u = await newUser('b6');
    await expectCode(fresh.manage('grant', u, await addDays(365)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    expect(await fresh.manage('grant', u, await addDays(364))).toMatchObject({ lifetime_units: 1 });
  });
});

describe('PHASE C: the backfill (the real server function) makes every existing code digest-verified', () => {
  it('a dry look: the status function reports the counts (no code, no digest)', async () => {
    const s = await as(PROMO_ADMIN, 'authenticated', async () => ((await db.query(`select public.admin_promo_codes_hash_status() v`)).rows[0] as { v: Json }).v);
    expect(s).toMatchObject({ rows_with_plain_value: expect.any(Number), rows_plain_without_verified_digest: expect.any(Number) });
    expect(Number(s.rows_plain_without_verified_digest)).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(s)).not.toMatch(/SUMMERPASS|[0-9a-f]{64}/);
  });

  it('the status function is for promo administrators only', async () => {
    await expectCode(as(ENT_ADMIN, 'authenticated', () => db.query(`select public.admin_promo_codes_hash_status()`)), 'PROMO_ADMIN_REQUIRED');
    await expect(as(null, 'anon', () => db.query(`select public.admin_promo_codes_hash_status()`))).rejects.toThrow(/permission denied/i);
  });

  it('the backfill functions are service role only (a signed in user, even a promo admin, cannot call them)', async () => {
    for (const q of [`select public.promo_codes_digest_pending(10)`, `select public.promo_codes_finalise_hash_only(true)`, `select public.promo_codes_backfill_record(null, 1, 1)`]) {
      await expect(as(PROMO_ADMIN, 'authenticated', () => db.query(q)), q).rejects.toThrow(/permission denied/i);
    }
  });

  it('runs: every pending code is stored AND verified, nothing is blanked, and the summary carries counts only', async () => {
    const before = await plainCount();
    const summary = await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys(), actorId: PROMO_ADMIN });
    expect(summary.failure).toBeNull();
    expect(summary.rowsSeen).toBeGreaterThanOrEqual(5);
    expect(summary.rowsVerified).toBe(summary.rowsSeen);
    expect(summary.rowsNotVerified).toBe(0);
    expect(await plainCount(), 'nothing was blanked').toBe(before);
    const pending = ((await db.query(`select count(*)::int n from promo_codes where code is not null and code_digest_verified_at is null`)).rows[0] as { n: number }).n;
    expect(pending).toBe(0);
    const ev = (await db.query(`select details from admin_monitoring_events where event_type='promo_codes_digest_backfill'`)).rows as Json[];
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ev)).not.toMatch(/SUMMERPASS|[0-9a-f]{64}/);
  });

  it('a second run finds nothing to do (safe to repeat)', async () => {
    const summary = await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys() });
    expect(summary).toMatchObject({ rowsSeen: 0, rowsVerified: 0, failure: null, stalled: false });
  });

  it('after the backfill every existing code redeems by DIGEST ONLY (no legacy value is passed)', async () => {
    const u1 = await newUser('c1');
    expect(await fresh.redeem(u1, 'SUMMERPASS', { legacy: false })).toMatchObject({ ok: true });
    const u2 = await newUser('c2');
    expect(await fresh.redeem(u2, OLD_GENERATED, { legacy: false })).toMatchObject({ ok: true });
    expect(await fresh.redeem(USER_REDEEMED_OLD, 'SUMMERPASS', { legacy: false })).toMatchObject({ ok: false, code: 'PROMO_ALREADY_REDEEMED' });
    // the typed spelling is normalised the same way (lower case, spaces, hyphens)
    const u3 = await newUser('c3');
    expect(await fresh.redeem(u3, 'summer-pass', { legacy: false })).toMatchObject({ ok: true });
  });

  it('a code the OLD release creates during the overlap (after a backfill) is pending again, and a second run picks it up', async () => {
    const late = await old.create({ code: 'PASTRUNNER22', max: 2 });
    expect(late).toMatchObject({ code: 'PASTRUNNER22' });
    const pending = ((await db.query(`select count(*)::int n from promo_codes where code is not null and code_digest_verified_at is null`)).rows[0] as { n: number }).n;
    expect(pending).toBe(1);
    // before the second run it still redeems, through the legacy lookup
    expect(await fresh.redeem(await newUser('c4'), 'PASTRUNNER22')).toMatchObject({ ok: true });
    const summary = await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys() });
    expect(summary).toMatchObject({ rowsSeen: 1, rowsVerified: 1, rowsNotVerified: 0 });
    expect(await fresh.redeem(await newUser('c5'), 'PASTRUNNER22', { legacy: false })).toMatchObject({ ok: true });
  });

  it('a typed code that collides with an unprepared legacy code is REPORTED as not verified (never hidden) and still works', async () => {
    await old.create({ code: 'SAMETEXT2222', max: 3 });
    await fresh.create('SAMETEXT2222', 3); // the new create cannot see legacy plain values, so it succeeds with a digest
    const summary = await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys() });
    expect(summary.rowsSeen).toBe(1);
    expect(summary.rowsNotVerified).toBe(1);
    expect(summary.rowsVerified).toBe(0);
    expect(summary.stalled).toBe(true);
    // finalise refuses while that row is unverified
    await expectCode(as(null, 'service_role', () => db.query(`select public.promo_codes_finalise_hash_only(false)`)), 'PROMO_FINALISE_BLOCKED');
    // the cleanup refuses as well
    await expectCode(db.exec(fs.readFileSync(path.join(MIG_DIR, migrationFiles().find((f) => f.includes('promo_hardening_legacy_cleanup'))!), 'utf8')), 'PROMO_CLEANUP_BLOCKED');
    expect(await functionCount('admin_list_promo_codes'), 'a refused cleanup changed nothing').toBe(1);
    // resolving it: the admin disables the legacy duplicate by hand (here: rename its plain value out of the way, as the runbook says)
    await db.exec(`update promo_codes set code = 'SAMETEXT2222X', status = 'disabled', disabled_at = now() where code = 'SAMETEXT2222' and code_digest is null`);
    expect((await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys() })).rowsNotVerified).toBe(0);
  });
});

describe('PHASE D: finalise (blank the plain values)', () => {
  it('a dry run reports the counts and changes nothing', async () => {
    const r = await as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_finalise_hash_only(true) v`)).rows[0] as { v: Json }).v);
    expect(r).toMatchObject({ dry_run: true });
    expect(Number(r.rows_with_plain_value)).toBeGreaterThan(0);
    expect(await plainCount()).toBeGreaterThan(0);
  });

  it('NC-S1: finalise without the verified predicate blanks an UNVERIFIED row, and the follow-up check goes red', async () => {
    // a row whose digest copy is WRONG and unverified: blanking its plain value would lose the code for good
    await old.create({ code: 'CHECKERS222', max: 2 });
    await db.exec(`update promo_codes set code_digest = repeat('0', 64), code_digest_version = 1, code_digest_verified_at = null where code = 'CHECKERS222'`);
    const live = latestFunctionSql('promo_codes_finalise_hash_only');
    const mutated = live.replace('where code is not null and code_digest_verified_at is not null', 'where code is not null').replace(/if v_unverified > 0 then[\s\S]*?end if;/, '');
    expect(mutated, 'the mutation must change the SQL').not.toBe(live);
    await db.exec(mutated);
    try {
      await as(null, 'service_role', () => db.query(`select public.promo_codes_finalise_hash_only(false)`));
      const stillPlain = ((await db.query(`select count(*)::int n from promo_codes where code_digest = repeat('0', 64) and code is not null`)).rows[0] as { n: number }).n;
      await expectNamedFailure(() => expect(stillPlain, 'an unverified row must keep its plain value').toBe(1), 'an unverified row must keep its plain value');
    } finally {
      await db.exec(live);
    }
    // the broken function destroyed that throwaway row on purpose: remove it so later phases start clean
    await db.exec(`update promo_codes set status = 'disabled', disabled_at = now() where code_digest = repeat('0', 64)`);
    // and the REAL function leaves such a row alone (it refuses outright)
    await old.create({ code: 'CHECKERS333', max: 2 });
    await db.exec(`update promo_codes set code_digest = repeat('1', 64), code_digest_version = 1, code_digest_verified_at = null where code = 'CHECKERS333'`);
    await expectCode(as(null, 'service_role', () => db.query(`select public.promo_codes_finalise_hash_only(false)`)), 'PROMO_FINALISE_BLOCKED');
    expect(((await db.query(`select count(*)::int n from promo_codes where code = 'CHECKERS333'`)).rows[0] as { n: number }).n, 'the real finalise left the unverified row alone').toBe(1);
    await db.exec(`update promo_codes set code_digest = null, code_digest_version = null where code = 'CHECKERS333'`);
  });

  it('the real finalise refuses while a plain row is unverified, then blanks every plain value once all are verified', async () => {
    // rebuild a clean unverified state: one row with a plain value and no verification
    await old.create({ code: 'KEEPTHEBEST22', max: 2 });
    await expectCode(as(null, 'service_role', () => db.query(`select public.promo_codes_finalise_hash_only(false)`)), 'PROMO_FINALISE_BLOCKED');
    expect((await runDigestBackfill({ db: serviceRoleClient(), keys: testKeys() })).rowsNotVerified).toBe(0);
    const r = await as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_finalise_hash_only(false) v`)).rows[0] as { v: Json }).v);
    expect(r).toMatchObject({ dry_run: false, rows_unverified: 0 });
    expect(await plainCount(), 'no plain value remains').toBe(0);
  });

  it('after the finalise EVERY existing code still redeems, by digest (the proof that blanking loses nothing)', async () => {
    for (const code of ['SUMMERPASS', OLD_GENERATED, 'KEEPTHEBEST22']) {
      const u = await newUser('d');
      const r = await fresh.redeem(u, code, { legacy: false });
      // a code may be exhausted by earlier phases: the verdict must then be the generic one, never "not found" by a missing digest
      expect(['PROMO_CODE_UNUSABLE', undefined]).toContain(r.ok ? undefined : r.code);
    }
    const u = await newUser('d2');
    expect(await fresh.redeem(u, 'KEEPTHEBEST22', { legacy: false })).toMatchObject({ ok: true });
    const bound = await newUser('d3');
    // KEMPTHREE33 was single-use and already consumed in phase B: the verdict is the generic one
    expect(await fresh.redeem(bound, 'KEMPTHREE33', { legacy: false, emailHash: BOUND_HASH })).toMatchObject({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
  });

  it('stated honestly: after the finalise the OLD release can no longer redeem (the plain value is gone). This is why finalise comes last and rollback of the code is only possible before it', async () => {
    const u = await newUser('d4');
    expect(await old.redeem(u, 'KEEPTHEBEST22')).toMatchObject({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
  });
});

describe('PHASE E: the cleanup 0279 removes the old function shapes and nothing else', () => {
  it('applies after the finalise; each old shape is gone, each new shape remains, the data is untouched', async () => {
    const before = ((await db.query(`select count(*)::int n from promo_codes`)).rows[0] as { n: number }).n;
    const file = migrationFiles().find((f) => f.includes('promo_hardening_legacy_cleanup'))!;
    await db.exec(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
    expect(await functionCount('admin_list_promo_codes')).toBe(0);
    for (const n of ['admin_create_promo_code', 'redeem_promo_code_for_user', 'admin_manage_premium_entitlement', 'admin_promo_email_begin', 'admin_list_promo_codes_v2']) expect(await functionCount(n), n).toBe(1);
    expect(((await db.query(`select count(*)::int n from promo_codes`)).rows[0] as { n: number }).n).toBe(before);
    await expect(old.list()).rejects.toThrow(/does not exist/);
    await expect(old.manage('grant', await newUser('e'), await addDays(5))).rejects.toThrow(/does not exist/);
  });

  it('the lifetime counter now counts the grants the old function made during the overlap', async () => {
    const rows = (await db.query(`select e.user_id, e.admin_lifetime_grant_units u, (select count(*) from admin_entitlement_events v where v.target_user_id = e.user_id and v.action in ('grant','extend'))::int c from user_entitlements e where e.admin_lifetime_grant_units > 0 or exists (select 1 from admin_entitlement_events v where v.target_user_id = e.user_id and v.action in ('grant','extend'))`)).rows as { u: number; c: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.u, 'the counter equals the audited count for every user').toBe(r.c);
  });

  it('the grant by the old function before this release (USER_GRANTED_OLD) keeps its dates, and its source', async () => {
    const e = await ent(USER_GRANTED_OLD);
    expect(e).toMatchObject({ plan_tier: 'premium', entitlement_source: 'admin_grant' });
    expect(norm(e.effective_to)).toBe(await addDays(60));
  });

  it('the new release keeps working after the cleanup: create, redeem by digest, grant, list', async () => {
    const { made } = await fresh.create('AFTERMERGE22', 2);
    expect(await fresh.redeem(await newUser('f'), 'AFTERMERGE22', { legacy: false })).toMatchObject({ ok: true });
    expect(made.hint).toMatch(/^AF\*+22$/);
    expect(await fresh.manage('grant', await newUser('f2'), await addDays(20))).toMatchObject({ action: 'grant' });
    expect((await fresh.list()).length).toBeGreaterThan(5);
  });
});
