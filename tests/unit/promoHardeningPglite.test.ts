// Promo and Premium hardening (migrations 0264 to 0268) — real-Postgres (PGlite) proof of the DATABASE half.
//
// The whole migration ledger is replayed into an isolated in-memory Postgres and every rule is exercised through the real
// SECURITY DEFINER functions as the real roles (authenticated / service_role / anon), with auth.uid() driven by
// request.jwt.claims. Nothing is reimplemented here.
//
// NEGATIVE CONTROLS (named): each is run against a copy of the LIVE function with exactly one rule removed. The named
// assertion must go red as a real AssertionError (a database error does not count), and the live function is restored.
//
// WHAT PGLITE CANNOT PROVE (listed in docs/admin/ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md section 14 and in the DEV proof
// script scripts/promo_hardening_dev_proof.mjs): true concurrency (PGlite is one connection, so the advisory lock around
// admin_promo_email_begin and the row lock of the redeem function cannot be raced here), the real pg_cron / pg_net / Vault
// extensions (stubbed below), and the real Supabase role grants of a hosted project.
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. Not DEV- or production-verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, TEST_ENV, digestsFor, expectNamedFailure, latestFunctionSql, makeCode, replayAll, testKeys, REPO_ROOT } from './support/promoTestHelpers';
import { PREMIUM_GRANT_LIFETIME_CEILING, MAX_EXTENSIONS_PER_GRANT } from '@/lib/services/premiumGrantAdmin';
import { PROMO_EMAIL_LIMITS } from '@/lib/services/promoEmailAbuse';
import { computePromoDigest } from '@/lib/services/promoCodeDigest';
import { accessEndDate } from '@/lib/services/entitlementWindow';
import { keyedAddressHash } from '@/lib/services/promoCodeEmail';

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

const PROMO_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000e001';
const ENT_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000e002';
const OVERRIDE_ADMIN = 'aaaaaaaa-0000-0000-0000-00000000e003'; // premium entitlement + override
const OVERRIDE_ONLY = 'aaaaaaaa-0000-0000-0000-00000000e004'; // override alone
const PROMO_AND_ENT = 'aaaaaaaa-0000-0000-0000-00000000e005'; // both ordinary capabilities, no override
const PROMO_ADMIN_2 = 'aaaaaaaa-0000-0000-0000-00000000e006';

async function newUser(label = 'u', confirmed = true): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-5000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${id}','${label}${counter}@pg.test', ${confirmed ? 'now()' : 'null'});`);
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
const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

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

// -- thin wrappers over the real functions -----------------------------------

async function createPromo(actor: string, o: { duration?: number; max?: number | null; unlimited?: boolean; bound?: string | null; plain?: string; recipients?: number } = {}): Promise<{ made: ReturnType<typeof makeCode>; v: Json }> {
  const made = makeCode(o.plain);
  const exp = await addDays(60);
  const v = await as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_create_promo_code($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v`, [
      made.digest, made.hint, made.version, o.duration ?? 30, o.unlimited ? null : o.max === undefined ? 100 : o.max, o.unlimited ?? false, exp, false, null, o.bound ?? null, o.recipients ?? 0,
    ]);
    return (rows[0] as { v: Json }).v;
  });
  return { made, v };
}

async function redeem(user: string, plain: string, o: { ip?: string | null; emailHash?: string | null; digests?: string[]; legacy?: string | null } = {}): Promise<Json> {
  return as(null, 'service_role', async () => {
    const { rows } = await db.query(`select public.redeem_promo_code_for_user($1,$2::text[],$3,$4,$5) v`, [
      user, o.digests ?? digestsFor(plain), o.ip ?? null, o.emailHash ?? null, o.legacy === undefined ? null : o.legacy,
    ]);
    return (rows[0] as { v: Json }).v;
  });
}

async function manage(actor: string, action: string, target: string, endsOn: string | null, reason = 'Pilot customer, invoice pending', override?: boolean): Promise<Json> {
  return as(actor, 'authenticated', async () => {
    // Always the five argument form: a four argument call would reach the OLD function (kept until 0279) and skip the new rules.
    const { rows } = await db.query(`select public.admin_manage_premium_entitlement($1,$2,$3,$4,$5) v`, [action, target, endsOn, reason, override ?? false]);
    return (rows[0] as { v: Json }).v;
  });
}

const ent = async (uid: string) => (await db.query(`select * from user_entitlements where user_id=$1`, [uid])).rows[0] as Json;

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db);
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
  `);
  await db.exec(
    `insert into auth.users(id,email,email_confirmed_at) values
      ('${PROMO_ADMIN}','pa@pg.test',now()),('${ENT_ADMIN}','ea@pg.test',now()),('${OVERRIDE_ADMIN}','oa@pg.test',now()),
      ('${OVERRIDE_ONLY}','oo@pg.test',now()),('${PROMO_AND_ENT}','pe@pg.test',now()),('${PROMO_ADMIN_2}','pa2@pg.test',now());`
  );
  await db.exec(`insert into admin_users(user_id) values ('${PROMO_ADMIN}'),('${ENT_ADMIN}'),('${OVERRIDE_ADMIN}'),('${OVERRIDE_ONLY}'),('${PROMO_AND_ENT}'),('${PROMO_ADMIN_2}');`);
  await db.exec(`update admin_users set can_manage_promo_codes=true where user_id in ('${PROMO_ADMIN}','${PROMO_AND_ENT}','${PROMO_ADMIN_2}');`);
  await db.exec(`update admin_users set can_manage_premium_entitlements=true where user_id in ('${ENT_ADMIN}','${OVERRIDE_ADMIN}','${PROMO_AND_ENT}');`);
  await db.exec(`update admin_users set can_override_entitlement_limits=true where user_id in ('${OVERRIDE_ADMIN}','${OVERRIDE_ONLY}');`);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

// =============================================================================
describe('item 2 — one inclusive window definition in SQL', () => {
  it('access_end_date and access_window_days agree with the TypeScript definition (1, 30, 365 days, leap year)', async () => {
    for (const [start, days] of [['2026-10-05', 1], ['2026-10-05', 30], ['2026-10-05', 365], ['2024-02-28', 30], ['2024-02-28', 365], ['2024-02-29', 30]] as const) {
      const { rows } = await db.query(`select public.access_end_date($1::date,$2::int)::text e, public.access_window_days($1::date, public.access_end_date($1::date,$2::int)) w`, [start, days]);
      expect((rows[0] as Json).e, `${start} + ${days}`).toBe(accessEndDate(start, days));
      expect((rows[0] as Json).w).toBe(days);
    }
    expect(((await db.query(`select public.access_end_date(null,30) v, public.access_end_date('2026-01-01',0) w`)).rows[0] as Json)).toEqual({ v: null, w: null });
  });

  it('a 30 day promo redeemed today ends on today plus 29 (and the create response says the same)', async () => {
    const { made, v } = await createPromo(PROMO_ADMIN, { duration: 30 });
    expect(norm(v.ends_if_redeemed_today)).toBe(await addDays(29));
    const user = await newUser();
    const r = await redeem(user, made.plain);
    expect(r.ok).toBe(true);
    expect(r.ends_on, 'a 30 day promo ends on redemption day plus 29').toBe(await addDays(29));
    expect(norm((await ent(user)).effective_to)).toBe(await addDays(29));
  });

  it('NC-D2: the OLD redeem rule (today plus duration) is caught by the same assertion', async () => {
    const live = latestFunctionSql('redeem_promo_code_for_user');
    await withMutation(live, (s) => s.replace('public.access_end_date(v_today, v_promo.duration_days)', 'v_today + v_promo.duration_days'), async () => {
      const { made } = await createPromo(PROMO_ADMIN, { duration: 30 });
      const user = await newUser();
      const r = await redeem(user, made.plain);
      await expectNamedFailure(() => expect(r.ends_on, 'a 30 day promo ends on redemption day plus 29').toBe(accessEndDate(String(norm((r as Json).started_on)), 30)), 'a 30 day promo ends on redemption day plus 29');
    });
  });

  it('admin grants: today plus 364 is the latest end date, today plus 365 is refused', async () => {
    const target = await newUser();
    await expectCode(manage(ENT_ADMIN, 'grant', target, await addDays(365)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    const ok = await manage(ENT_ADMIN, 'grant', target, await addDays(364));
    expect(norm(ok.effective_to)).toBe(await addDays(364));
  });

  it('NC-D3: the OLD ceiling (today plus 365) would accept a 366 day grant', async () => {
    const live = latestFunctionSql('admin_manage_premium_entitlement');
    await withMutation(live, (s) => s.replace('v_max_end        date := public.access_end_date(current_date, 365);', 'v_max_end        date := current_date + 365;'), async () => {
      const target = await newUser();
      let refused = false;
      try {
        await manage(ENT_ADMIN, 'grant', target, await addDays(365));
      } catch {
        refused = true;
      }
      await expectNamedFailure(() => expect(refused, 'a 366 day grant is refused').toBe(true), 'a 366 day grant is refused');
    });
  });

  it('reminders measure a window with the shared definition: a 30 day window is not told it has 30 days left, a 31 day window is', async () => {
    const claim = async (user: string) =>
      as(null, 'service_role', async () => (await db.query(`select * from public.premium_reminder_claim(current_date, '{30}'::int[], 50, 3, 60, $1::uuid)`, [user])).rows as Json[]);
    const seed = async (user: string, windowDays: number, endsIn: number) => {
      await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='promo_code', effective_from=current_date+${endsIn}-${windowDays - 1}, effective_to=current_date+${endsIn}, admin_grant_ends_on=current_date+${endsIn}, reserve_source='promo_code' where user_id='${user}'`);
    };
    const u30 = await newUser();
    const u31 = await newUser();
    for (const u of [u30, u31]) await db.exec(`insert into user_entitlements(user_id) values ('${u}') on conflict do nothing`);
    await seed(u30, 30, 10);
    await seed(u31, 31, 10);
    expect(await claim(u30), 'a 30 day window gets no 30 day reminder').toHaveLength(0);
    expect((await claim(u31)).length, 'a 31 day window gets the 30 day reminder').toBe(1);
    // negative control: the OLD measure (end minus start, without the inclusive day) treats the 31 day window as 30 days long
    const live = latestFunctionSql('premium_reminder_claim');
    await db.exec(`delete from premium_expiry_email_ledger where user_id='${u31}'`);
    await withMutation(live, (s) => s.replace('public.access_window_days(coalesce(e.effective_from, p_today), e.effective_to) > x', '(e.effective_to - coalesce(e.effective_from, p_today)) > x'), async () => {
      const rows = await claim(u31);
      await expectNamedFailure(() => expect(rows.length, 'a 31 day window gets the 30 day reminder').toBe(1), 'a 31 day window gets the 30 day reminder');
    });
  });
});

// =============================================================================
describe('item 1 — hash only promo codes', () => {
  it('a created code stores NO plain value, only the digest, the version and the masked hint', async () => {
    const { made, v } = await createPromo(PROMO_ADMIN);
    const row = (await db.query(`select code, code_digest, code_digest_version, code_hint from promo_codes where id=$1`, [v.id])).rows[0] as Json;
    expect(row.code).toBeNull();
    expect(row.code_digest).toBe(made.digest);
    expect(row.code_digest_version).toBe(1);
    expect(row.code_hint).toBe(made.hint);
    expect(JSON.stringify(v), 'the create function result carries no code').not.toContain(made.plain);
    const events = await db.query(`select details::text d, code_hint from promo_code_events where promo_code_id=$1`, [v.id]);
    expect(JSON.stringify(events.rows)).not.toContain(made.plain);
  });

  it('API roles cannot read the plain code, the digest or the bound hash from the table; the safe columns stay readable', async () => {
    await createPromo(PROMO_ADMIN);
    for (const col of ['code', 'code_digest', 'bound_email_hash', 'code_digest_version']) {
      await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select ${col} from promo_codes limit 1`)), 'permission denied');
    }
    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select * from promo_codes limit 1`)), 'permission denied');
    const ok = await as(PROMO_ADMIN, 'authenticated', () => db.query(`select id, code_hint, status from promo_codes limit 1`));
    expect(ok.rows.length).toBeGreaterThan(0);
    await expectCode(as(null, 'anon', () => db.query(`select code_hint from promo_codes limit 1`)), 'permission denied');
  });

  it('the admin list returns no code column and no digest (only the masked hint)', async () => {
    const { made } = await createPromo(PROMO_ADMIN);
    const rows = await as(PROMO_ADMIN, 'authenticated', async () => (await db.query(`select * from public.admin_list_promo_codes_v2()`)).rows as Json[]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain('code');
      expect(Object.keys(r)).not.toContain('code_digest');
      expect(JSON.stringify(r)).not.toContain(made.plain);
    }
    expect(rows.some((r) => r.code_hint === made.hint)).toBe(true);
  });

  it('redemption by digest: right code works, normalisation (case, hyphens, spaces) applies, a wrong code is the generic refusal', async () => {
    const { made } = await createPromo(PROMO_ADMIN);
    const u1 = await newUser();
    const spaced = `${made.plain.slice(0, 5)}-${made.plain.slice(5).toLowerCase()}`;
    expect((await redeem(u1, spaced)).ok).toBe(true);
    const u2 = await newUser();
    expect(await redeem(u2, 'ZZZZZZZZZZ')).toEqual({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
    expect(await redeem(u2, made.plain, { digests: [] }), 'no digests at all').toEqual({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
    expect(await redeem(u2, made.plain, { digests: ['a', 'b', 'c', 'd'] }), 'more than three digests is refused').toEqual({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
  });

  it('a duplicate digest is refused and a malformed digest or hint is refused', async () => {
    const { made } = await createPromo(PROMO_ADMIN);
    const exp = await addDays(10);
    const call = (digest: string, hint: string) =>
      as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_create_promo_code($1,$2,1,30,5,false,$3,false,null) v`, [digest, hint, exp]));
    await expectCode(call(made.digest, made.hint), 'PROMO_CODE_EXISTS');
    await expectCode(call('nothex', made.hint), 'PROMO_CODE_INVALID');
    await expectCode(call('a'.repeat(64), 'plain-looking-hint'), 'PROMO_CODE_INVALID');
    await expectCode(call('b'.repeat(64), 'AB*CD'), 'PROMO_CODE_INVALID');
  });

  it('key rotation: a code stored under key version 1 is found by the previous-key candidate, and NOT without it', async () => {
    const prevSecret = 'previous-key-eeeeeeeeeeeeeeeeeeeeeeeeeeeee-0005';
    const plain = makeCode().plain;
    const oldDigest = computePromoDigest(plain, { version: 1, secret: prevSecret });
    const newDigest = computePromoDigest(plain, { version: 2, secret: TEST_ENV.PROMO_CODE_DIGEST_SECRET });
    const exp = await addDays(30);
    await as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_create_promo_code($1,$2,1,30,5,false,$3,false,null) v`, [oldDigest, `${plain.slice(0, 2)}******${plain.slice(-2)}`, exp]));
    const u1 = await newUser();
    expect(await redeem(u1, plain, { digests: [newDigest] }), 'after rotation without the previous key the old code is unusable').toEqual({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
    expect((await redeem(u1, plain, { digests: [newDigest, oldDigest] })).ok, 'dual verify window').toBe(true);
  });

  describe('migration of existing plain codes (backfill, verify, finalise)', () => {
    const legacy = async (plain: string) => {
      const id = ((await db.query(`insert into promo_codes(code, code_hint, duration_days, max_redemptions, created_by) values ($1,$2,30,5,$3) returning id`, [plain, `${plain.slice(0, 2)}******${plain.slice(-2)}`, PROMO_ADMIN])).rows[0] as { id: string }).id;
      return id;
    };
    const pending = () => as(null, 'service_role', async () => (await db.query(`select * from public.promo_codes_digest_pending(100)`)).rows as Json[]);
    const finalise = (dry: boolean) => as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_finalise_hash_only($1) v`, [dry])).rows[0] as { v: Json }).v);

    it('a legacy row without a digest is still redeemable through the legacy lookup, so existing codes keep working during the migration', async () => {
      const plain = 'ABCDEFGHJK';
      await legacy(plain);
      const u = await newUser();
      expect((await redeem(u, plain, { legacy: plain })).ok).toBe(true);
      expect(await redeem(await newUser(), plain, { legacy: null }), 'without the legacy parameter a digestless row is not found').toEqual({ ok: false, code: 'PROMO_CODE_UNUSABLE' });
    });

    it('the backfill functions are service role only', async () => {
      await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select * from public.promo_codes_digest_pending(10)`)), 'permission denied');
      await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.promo_codes_finalise_hash_only(true)`)), 'permission denied');
      await expectCode(as(null, 'anon', () => db.query(`select public.promo_codes_digest_apply(gen_random_uuid(), $1, 1)`, ['a'.repeat(64)])), 'permission denied');
    });

    it('apply, verify and finalise: nothing is blanked before every digest is verified, then the plain value goes and the code still works', async () => {
      const plainA = 'BCDEFGHJKM';
      const plainB = 'CDEFGHJKMN';
      const idA = await legacy(plainA);
      const idB = await legacy(plainB);
      const rows = await pending();
      expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining([plainA, plainB]));

      const keys = testKeys();
      const dA = computePromoDigest(plainA, keys.current);
      const dB = computePromoDigest(plainB, keys.current);
      const apply = (id: string, d: string) => as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_digest_apply($1,$2,1) v`, [id, d])).rows[0] as { v: boolean }).v);
      const verify = (id: string, d: string) => as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_digest_mark_verified($1,$2) v`, [id, d])).rows[0] as { v: boolean }).v);

      expect(await apply(idA, dA)).toBe(true);
      expect(await apply(idB, dB)).toBe(true);
      // a recomputed digest that does not match the stored one does not verify
      expect(await verify(idB, 'f'.repeat(64)), 'a wrong digest is not marked verified').toBe(false);
      expect(await verify(idA, dA)).toBe(true);

      const dry = await finalise(true);
      expect(dry.dry_run).toBe(true);
      expect(Number(dry.rows_unverified)).toBeGreaterThanOrEqual(1);
      // the real finalise refuses while one plain row is unverified (all or nothing)
      await expectCode(finalise(false), 'PROMO_FINALISE_BLOCKED');
      expect(((await db.query(`select code from promo_codes where id=$1`, [idA])).rows[0] as Json).code, 'nothing was blanked by the refused finalise').toBe(plainA);

      // verify every remaining pending row, then finalise
      expect(await verify(idB, dB)).toBe(true);
      for (const r of await pending()) {
        const d = computePromoDigest(String(r.code), keys.current);
        await apply(String(r.id), d);
        await verify(String(r.id), d);
      }
      const done = await finalise(false);
      expect(done.dry_run).toBe(false);
      expect(Number(done.rows_blanked)).toBeGreaterThanOrEqual(2);
      expect(((await db.query(`select count(*)::int n from promo_codes where code is not null`)).rows[0] as Json).n).toBe(0);
      const ev = await db.query(`select details from admin_monitoring_events where event_type='promo_codes_hash_only_finalised'`);
      expect(ev.rows.length).toBe(1);
      expect(JSON.stringify(ev.rows)).not.toContain(plainA);

      // the existing codes keep working by digest, with no legacy parameter
      expect((await redeem(await newUser(), plainA)).ok).toBe(true);
      expect((await redeem(await newUser(), plainB)).ok).toBe(true);
    });

    it('NC-H1: a finalise that blanks rows without checking the digest was verified destroys the only copy of an unverified code', async () => {
      const live = latestFunctionSql('promo_codes_finalise_hash_only');
      const id = await legacy('DEFGHJKMNP');
      // a digest is stored but NOT verified (a plain only row can never be blanked at all: the table check promo_codes_has_identity refuses it)
      await as(null, 'service_role', () => db.query(`select public.promo_codes_digest_apply($1,$2,1)`, [id, 'e'.repeat(64)]));
      const outcome = async () => {
        try {
          await finalise(false);
        } catch {
          /* the real function refuses while a plain row is unverified */
        }
        const row = (await db.query(`select code from promo_codes where id=$1`, [id])).rows[0] as Json;
        expect(row.code, 'an unverified plain value is never blanked').not.toBeNull();
      };
      await outcome(); // the live function passes
      await withMutation(
        live,
        (s) => s.replace('if v_unverified > 0 then', 'if false then').replace('where code is not null and code_digest_verified_at is not null;', 'where code is not null;'),
        async () => {
          await expectNamedFailure(outcome, 'an unverified plain value is never blanked');
        }
      );
    });

    it('NC-H2: a verify function that does not compare the digest marks any digest as verified', async () => {
      const live = latestFunctionSql('promo_codes_digest_mark_verified');
      const id = await legacy('EFGHJKMNPQ');
      await as(null, 'service_role', () => db.query(`select public.promo_codes_digest_apply($1,$2,1)`, [id, 'c'.repeat(64)]));
      await withMutation(live, (s) => s.replace('and code_digest = p_recomputed_digest', ''), async () => {
        const r = await as(null, 'service_role', async () => ((await db.query(`select public.promo_codes_digest_mark_verified($1,$2) v`, [id, 'd'.repeat(64)])).rows[0] as { v: boolean }).v);
        await expectNamedFailure(() => expect(r, 'a wrong digest is not marked verified').toBe(false), 'a wrong digest is not marked verified');
      });
    });
  });
});

// =============================================================================
describe('item 5 — bound redemption needs the verified address', () => {
  const UNUSABLE = { ok: false, code: 'PROMO_CODE_UNUSABLE' };
  const hashOf = (address: string) => keyedAddressHash('bind', address, TEST_ENV)!;

  it('the SQL normalisation contract agrees with the shared vector file', async () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'email-normalisation-vectors.json'), 'utf8')) as { vectors: { input: string; normalised: string }[] };
    for (const v of vectors.vectors) {
      const { rows } = await db.query(`select public.promo_normalise_email($1) n`, [v.input]);
      expect((rows[0] as Json).n, JSON.stringify(v.input)).toBe(v.normalised);
    }
  });

  it('matching verified address redeems; unverified address, other address, no hash and a changed address all get the SAME generic refusal', async () => {
    const addr = 'recipient@mail-example.com';
    const { made } = await createPromo(PROMO_ADMIN, { max: 1, bound: hashOf(addr) });
    const unverified = await newUser('unv', false);
    expect(await redeem(unverified, made.plain, { emailHash: hashOf(addr) }), 'an unverified address cannot redeem a bound code').toEqual(UNUSABLE);
    const other = await newUser();
    expect(await redeem(other, made.plain, { emailHash: hashOf('someone.else@mail-example.com') })).toEqual(UNUSABLE);
    expect(await redeem(other, made.plain, { emailHash: null }), 'no address hash').toEqual(UNUSABLE);
    // the address changed after the code was issued: the new address hashes differently, the code stays unusable (no silent rebind)
    const changed = await newUser();
    expect(await redeem(changed, made.plain, { emailHash: hashOf('recipient.new@mail-example.com') })).toEqual(UNUSABLE);
    // Gmail style variants are NOT the same address (no rewriting)
    expect(await redeem(changed, made.plain, { emailHash: hashOf('Recipient@Mail-Example.com ') }), 'case and surrounding space ARE normalised: this is the same address').toMatchObject({ ok: true });
  });

  it('NC-B1: a redeem function that ignores the verified flag lets an unverified account use a bound code', async () => {
    const live = latestFunctionSql('redeem_promo_code_for_user');
    await withMutation(live, (s) => s.replace('or coalesce(v_verified, false) = false', ''), async () => {
      const addr = 'nc-b1@mail-example.com';
      const { made } = await createPromo(PROMO_ADMIN, { max: 1, bound: hashOf(addr) });
      const unverified = await newUser('unv', false);
      const r = await redeem(unverified, made.plain, { emailHash: hashOf(addr) });
      await expectNamedFailure(() => expect(r, 'an unverified address cannot redeem a bound code').toEqual(UNUSABLE), 'an unverified address cannot redeem a bound code');
    });
  });
});

// =============================================================================
describe('item 3 — lifetime ceiling and the separate override capability', () => {
  it('constants agree between SQL and TypeScript', async () => {
    expect(((await db.query(`select public.premium_grant_lifetime_ceiling() c, public.premium_grant_max_extensions() m`)).rows[0] as Json)).toEqual({
      c: PREMIUM_GRANT_LIFETIME_CEILING,
      m: MAX_EXTENSIONS_PER_GRANT,
    });
  });

  it('the counter is backfilled out of the audit trail (grant and extend events per target), and a re-run never lowers it', async () => {
    const u = await newUser();
    await db.exec(`insert into user_entitlements(user_id) values ('${u}') on conflict do nothing`);
    for (const action of ['grant', 'extend', 'extend', 'revoke']) {
      await db.query(
        `insert into admin_entitlement_events(action, actor_user_id, target_user_id, reason, after_plan_tier, after_entitlement_source) values ($1,$2,$3,'a long enough reason','premium','admin_grant')`,
        [action, ENT_ADMIN, u]
      );
    }
    const sql = fs.readFileSync(path.join(MIG_DIR, fs.readdirSync(MIG_DIR).find((f) => f.startsWith('0264_'))!), 'utf8');
    const stmt = sql.slice(sql.indexOf('update public.user_entitlements e'), sql.indexOf('where e.user_id = c.user_id and e.admin_lifetime_grant_units < c.units;') + 'where e.user_id = c.user_id and e.admin_lifetime_grant_units < c.units;'.length);
    expect(stmt.length).toBeGreaterThan(50);
    await db.exec(stmt);
    expect(((await ent(u)).admin_lifetime_grant_units)).toBe(3);
    await db.exec(`update user_entitlements set admin_lifetime_grant_units = 7 where user_id='${u}'`);
    await db.exec(stmt);
    expect(((await ent(u)).admin_lifetime_grant_units), 'a re-run never lowers the counter').toBe(7);
  });

  async function exhaustByRegrant(target: string) {
    // grant, revoke, grant, revoke ... each grant adds one to the lifetime counter, a revoke never lowers it
    for (let i = 0; i < PREMIUM_GRANT_LIFETIME_CEILING; i += 1) {
      await manage(ENT_ADMIN, 'grant', target, await addDays(30));
      await manage(ENT_ADMIN, 'revoke', target, null);
    }
  }

  it('revoke and re-grant is counted: after the ceiling an ordinary grant is refused even though nothing is active', async () => {
    const target = await newUser();
    await exhaustByRegrant(target);
    expect((await ent(target)).admin_lifetime_grant_units).toBe(PREMIUM_GRANT_LIFETIME_CEILING);
    await expectCode(manage(ENT_ADMIN, 'grant', target, await addDays(30)), 'ENTITLEMENT_LIFETIME_LIMIT_REACHED');
    expect((await ent(target)).plan_tier, 'the refused grant changed nothing').toBe('free');
  });

  it('extensions count too: five extensions hit the per grant cap first, then re-grants hit the lifetime ceiling', async () => {
    const target = await newUser();
    await manage(ENT_ADMIN, 'grant', target, await addDays(10));
    for (let i = 1; i <= MAX_EXTENSIONS_PER_GRANT; i += 1) await manage(ENT_ADMIN, 'extend', target, await addDays(10 + i));
    await expectCode(manage(ENT_ADMIN, 'extend', target, await addDays(40)), 'ENTITLEMENT_EXTENSION_LIMIT_REACHED');
    expect((await ent(target)).admin_lifetime_grant_units).toBe(1 + MAX_EXTENSIONS_PER_GRANT);
  });

  it('NC-L1: without the lifetime check, revoke and re-grant after exhaustion is accepted', async () => {
    const live = latestFunctionSql('admin_manage_premium_entitlement');
    const target = await newUser();
    await exhaustByRegrant(target);
    await withMutation(live, (s) => s.replace('v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;\n  elsif', 'v_life_hit := false;\n  elsif').replace('    v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;\n  end if;', '    v_life_hit := false;\n  end if;'), async () => {
      let refused = false;
      try {
        await manage(ENT_ADMIN, 'grant', target, await addDays(30));
      } catch {
        refused = true;
      }
      await expectNamedFailure(() => expect(refused, 'revoke and re-grant after exhaustion is refused').toBe(true), 'revoke and re-grant after exhaustion is refused');
    });
  });

  it('override: needs its own capability, a reason of 20 or more characters, and a limit that was really reached', async () => {
    const target = await newUser();
    await exhaustByRegrant(target);
    const longReason = 'Founding customer, signed contract pending, approved by the PO';
    // an ordinary entitlement admin (and even one that also holds the promo capability) cannot override
    await expectCode(manage(ENT_ADMIN, 'grant', target, await addDays(30), longReason, true), 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED');
    await expectCode(manage(PROMO_AND_ENT, 'grant', target, await addDays(30), longReason, true), 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED');
    // the override capability alone does not allow managing entitlements at all
    await expectCode(manage(OVERRIDE_ONLY, 'grant', target, await addDays(30), longReason, true), 'ENTITLEMENT_ADMIN_REQUIRED');
    // a short reason
    await expectCode(manage(OVERRIDE_ADMIN, 'grant', target, await addDays(30), 'too short reason', true), 'ENTITLEMENT_OVERRIDE_REASON_REQUIRED');
    // an override on a revoke is not a thing
    await expectCode(manage(OVERRIDE_ADMIN, 'revoke', target, null, longReason, true), 'ENTITLEMENT_ACTION_INVALID');
    // not needed: a fresh user with no limit reached
    const fresh = await newUser();
    await expectCode(manage(OVERRIDE_ADMIN, 'grant', fresh, await addDays(30), longReason, true), 'ENTITLEMENT_OVERRIDE_NOT_NEEDED');
    // success
    const out = await manage(OVERRIDE_ADMIN, 'grant', target, await addDays(30), longReason, true);
    expect(out.override).toBe(true);
    expect(out.lifetime_units).toBe(PREMIUM_GRANT_LIFETIME_CEILING + 1);
    expect(out.plan_tier).toBe('premium');
  });

  it('an override leaves an audit event, an append-only override row and a high severity alert; none of them can be changed', async () => {
    const target = await newUser();
    await exhaustByRegrant(target);
    const reason = 'Second override case, reviewed by a second person on the team';
    const out = await manage(OVERRIDE_ADMIN, 'grant', target, await addDays(20), reason, true);
    const audit = (await db.query(`select action, reason from admin_entitlement_events where id=$1`, [out.audit_id])).rows[0] as Json;
    expect(audit.action).toBe('grant');
    expect(audit.reason).toBe(reason);
    const ov = (await db.query(`select * from premium_entitlement_overrides where target_user_id=$1`, [target])).rows as Json[];
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ actor_user_id: OVERRIDE_ADMIN, action: 'grant', limit_hit: 'lifetime_ceiling', units_before: PREMIUM_GRANT_LIFETIME_CEILING, units_after: PREMIUM_GRANT_LIFETIME_CEILING + 1 });
    const alert = (await db.query(`select severity, details from admin_monitoring_events where event_type='premium_limit_override' order by created_at desc limit 1`)).rows[0] as Json;
    expect(alert.severity).toBe('high');
    expect(JSON.stringify(alert.details)).not.toContain(reason);
    await expectCode(db.query(`update premium_entitlement_overrides set reason='x' where target_user_id=$1`, [target]), 'append-only');
    await expectCode(db.query(`delete from premium_entitlement_overrides where target_user_id=$1`, [target]), 'append-only');
    await expectCode(db.query(`update admin_monitoring_events set severity='info'`), 'append-only');
    await expectCode(db.query(`delete from admin_monitoring_events`), 'append-only');
    // the entitlement admin may READ the override record, a promo-only admin may not
    expect((await as(ENT_ADMIN, 'authenticated', () => db.query(`select 1 from premium_entitlement_overrides`))).rows.length).toBeGreaterThan(0);
    expect((await as(PROMO_ADMIN, 'authenticated', () => db.query(`select 1 from premium_entitlement_overrides`))).rows.length).toBe(0);
  });

  it('NC-L2: an override that skips the capability check lets an ordinary admin past the limit', async () => {
    const live = latestFunctionSql('admin_manage_premium_entitlement');
    const target = await newUser();
    await exhaustByRegrant(target);
    await withMutation(live, (s) => s.replace("if not public.is_entitlement_override_admin() then raise exception 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED' using errcode = '42501'; end if;", ''), async () => {
      let refused = false;
      try {
        await manage(ENT_ADMIN, 'grant', target, await addDays(30), 'A long enough override reason here', true);
      } catch {
        refused = true;
      }
      await expectNamedFailure(() => expect(refused, 'an override needs its own capability').toBe(true), 'an override needs its own capability');
    });
  });

  it('the override capability is a separate predicate: no other capability implies it, it implies no other', async () => {
    const pred = async (uid: string, fn: string) => as(uid, 'authenticated', async () => ((await db.query(`select public.${fn}() v`)).rows[0] as { v: boolean }).v);
    expect(await pred(PROMO_AND_ENT, 'is_entitlement_override_admin')).toBe(false);
    expect(await pred(ENT_ADMIN, 'is_entitlement_override_admin')).toBe(false);
    expect(await pred(PROMO_ADMIN, 'is_entitlement_override_admin')).toBe(false);
    expect(await pred(OVERRIDE_ADMIN, 'is_entitlement_override_admin')).toBe(true);
    expect(await pred(OVERRIDE_ONLY, 'is_premium_entitlement_admin')).toBe(false);
    expect(await pred(OVERRIDE_ONLY, 'is_promo_code_admin')).toBe(false);
    expect(await pred(PROMO_ADMIN, 'is_premium_entitlement_admin')).toBe(false);
    expect(await pred(ENT_ADMIN, 'is_promo_code_admin')).toBe(false);
  });
});

// =============================================================================
describe('item 9 and 8 — e-mail abuse controls and per recipient status', () => {
  const limits = PROMO_EMAIL_LIMITS;
  const begin = (actor: string, key: string, count = 1, o: { kind?: string; purpose?: string | null; replaces?: string | null; bound?: boolean } = {}) =>
    as(actor, 'authenticated', async () => ((await db.query(`select public.admin_promo_email_begin($1,$2,$3,$4,$5,$6) v`, [key, count, o.bound ?? false, o.kind ?? 'create', o.purpose === undefined ? 'Pilot cohort welcome codes' : o.purpose, o.replaces ?? null])).rows[0] as { v: Json }).v);
  const key = () => `k-${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`;
  const backdate = async (admin: string, recipients: number, hoursAgo = 2) => {
    let left = recipients;
    while (left > 0) {
      const n = Math.min(20, left);
      await db.query(`insert into promo_email_requests(admin_user_id, request_key, recipient_count, created_at, kind) values ($1,$2,$3, now() - make_interval(hours => $4), 'create')`, [admin, key(), n, hoursAgo]);
      left -= n;
    }
  };
  const anyAdmin = async () => ((await db.query(`select gen_random_uuid()::text id`)).rows[0] as { id: string }).id;
  const clear = async () => {
    await db.exec(`delete from promo_email_sends; delete from promo_email_requests;`);
  };

  it('the limits agree between SQL and TypeScript', async () => {
    expect(((await db.query(`select public.promo_email_limits() v`)).rows[0] as { v: Json }).v).toEqual(limits);
  });

  it('a purpose of 10 to 200 characters without control characters is mandatory, and the request records admin, purpose, kind and count', async () => {
    await clear();
    for (const p of [null, '', 'short', 'x'.repeat(201), `line one\nline two here`]) await expectCode(begin(PROMO_ADMIN, key(), 1, { purpose: p }), 'PROMO_EMAIL_PURPOSE_REQUIRED');
    const k = key();
    expect((await begin(PROMO_ADMIN, k, 3, { purpose: 'Welcome codes for the pilot' })).new).toBe(true);
    const row = (await db.query(`select admin_user_id, purpose, kind, recipient_count from promo_email_requests where request_key=$1`, [k])).rows[0] as Json;
    expect(row).toEqual({ admin_user_id: PROMO_ADMIN, purpose: 'Welcome codes for the pilot', kind: 'create', recipient_count: 3 });
    // a repeated key is a duplicate and counts nothing again
    expect((await begin(PROMO_ADMIN, k, 3)).new).toBe(false);
    expect(((await db.query(`select count(*)::int n from promo_email_requests where request_key=$1`, [k])).rows[0] as Json).n).toBe(1);
  });

  it('the old three argument call shape is gone (no overload remains) and a non-promo admin is refused', async () => {
    expect(((await db.query(`select count(*)::int n from pg_proc where proname='admin_promo_email_begin'`)).rows[0] as Json).n).toBe(1);
    await expectCode(begin(ENT_ADMIN, key()), 'PROMO_ADMIN_REQUIRED');
  });

  it('the daily limit per admin is a RETURNED refusal, so its alert row is committed with it; a second admin is unaffected', async () => {
    await clear();
    await backdate(PROMO_ADMIN, limits.admin_recipients_per_day - 5);
    const refused = await begin(PROMO_ADMIN, key(), 10);
    expect(refused).toEqual({ new: false, refused: 'PROMO_EMAIL_DAILY_LIMIT' });
    const alerts = (await db.query(`select severity, details from admin_monitoring_events where event_type='promo_email_refused' and details->>'reason'='admin_daily_limit'`)).rows as Json[];
    expect(alerts.length, 'the alert row survived because the refusal returned instead of raising').toBeGreaterThanOrEqual(1);
    expect((await begin(PROMO_ADMIN_2, key(), 10)).new).toBe(true);
  });

  it('the platform wide daily limit refuses everyone and raises a high severity alert', async () => {
    await clear();
    for (let i = 0; i < 4; i += 1) await backdate(await anyAdmin(), 75);
    const refused = await begin(PROMO_AND_ENT, key(), 1);
    expect(refused.refused).toBe('PROMO_EMAIL_GLOBAL_LIMIT');
    const alert = (await db.query(`select severity from admin_monitoring_events where event_type='promo_email_refused' and details->>'reason'='global_daily_limit' limit 1`)).rows[0] as Json;
    expect(alert.severity).toBe('high');
  });

  it('unusual volume raises one alert per admin per day (counts only, no address, no code)', async () => {
    await clear();
    await backdate(PROMO_ADMIN_2, Math.ceil((limits.admin_recipients_per_day * limits.volume_alert_percent) / 100) - 5);
    await begin(PROMO_ADMIN_2, key(), 10);
    await begin(PROMO_ADMIN_2, key(), 1);
    const alerts = (await db.query(`select details::text d from admin_monitoring_events where event_type='promo_email_volume' and actor_user_id=$1`, [PROMO_ADMIN_2])).rows as Json[];
    expect(alerts, 'one alert per admin per day, not one per request').toHaveLength(1);
    expect(String(alerts[0].d)).not.toMatch(/@/);
  });

  it('repeated replacement of the same code is limited per day', async () => {
    await clear();
    const { v } = await createPromo(PROMO_ADMIN);
    for (let i = 0; i < limits.replacements_per_code_per_day; i += 1) {
      expect((await begin(PROMO_ADMIN, key(), 1, { kind: 'replace', replaces: String(v.id) })).new).toBe(true);
    }
    expect((await begin(PROMO_ADMIN, key(), 1, { kind: 'replace', replaces: String(v.id) })).refused).toBe('PROMO_EMAIL_REPLACEMENT_LIMIT');
    await expectCode(begin(PROMO_ADMIN, key(), 1, { kind: 'replace', replaces: null }), 'PROMO_NOT_FOUND');
    await expectCode(begin(PROMO_ADMIN, key(), 1, { kind: 'create', replaces: String(v.id) }), 'PROMO_EMAIL_KEY_INVALID');
  });

  it('NC-A1: without the daily limit check an admin can exceed the daily recipient limit', async () => {
    await clear();
    await backdate(PROMO_ADMIN, limits.admin_recipients_per_day - 5);
    const live = latestFunctionSql('admin_promo_email_begin');
    await withMutation(live, (s) => s.replace('if v_admin_day + p_recipient_count > v_admin_limit then', 'if false then'), async () => {
      const r = await begin(PROMO_ADMIN, key(), 10);
      await expectNamedFailure(() => expect(r.refused, 'the daily recipient limit is enforced').toBe('PROMO_EMAIL_DAILY_LIMIT'), 'the daily recipient limit is enforced');
    });
  });

  it('per recipient status comes from the ledger: sent, failed, unknown (no row), only for the admin who started the request, and never a code or address', async () => {
    await clear();
    const k = key();
    await begin(PROMO_ADMIN, k, 3);
    const { v } = await createPromo(PROMO_ADMIN, { max: null, unlimited: true });
    const hSent = keyedAddressHash('send', 'sent@mail-example.com', TEST_ENV)!;
    const hFailed = keyedAddressHash('send', 'failed@mail-example.com', TEST_ENV)!;
    const hLost = keyedAddressHash('send', 'lost@mail-example.com', TEST_ENV)!;
    const rec = (hash: string, status: string) =>
      as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.admin_promo_email_record($1,$2,$3,$4,1,$5,$6)`, [k, v.id, hash, status, status === 'sent' ? 'msg-1' : null, status === 'sent' ? null : 'resend_http_503']));
    await rec(hSent, 'sent');
    await rec(hFailed, 'failed');
    const status = (actor: string, key2: string) =>
      as(actor, 'authenticated', async () => ((await db.query(`select public.admin_promo_email_request_status($1,$2::text[]) v`, [key2, [hSent, hFailed, hLost]])).rows[0] as { v: Json }).v);
    const mine = await status(PROMO_ADMIN, k);
    expect(mine.request_exists).toBe(true);
    expect((mine.recipients as Json[]).map((r) => r.status)).toEqual(['sent', 'failed', 'unknown']);
    expect(JSON.stringify(mine)).not.toMatch(/@/);
    // another promo admin cannot see this request
    expect((await status(PROMO_ADMIN_2, k)).request_exists).toBe(false);
    // a settled sent row is never downgraded by a late failed record
    await rec(hSent, 'failed');
    expect((((await status(PROMO_ADMIN, k)).recipients as Json[])[0]).status).toBe('sent');
    await expectCode(as(ENT_ADMIN, 'authenticated', () => db.query(`select public.admin_promo_email_request_status($1,$2::text[])`, [k, [hSent]])), 'PROMO_ADMIN_REQUIRED');
  });

  it('circuit breaker: opens after the configured consecutive provider failures, closes on success, service role only, alert on open', async () => {
    const report = (ok: boolean) => as(null, 'service_role', async () => ((await db.query(`select public.promo_email_circuit_report($1) v`, [ok])).rows[0] as { v: Json }).v);
    const status = () => as(null, 'service_role', async () => ((await db.query(`select public.promo_email_circuit_status() v`)).rows[0] as { v: Json }).v);
    await db.exec(`delete from promo_email_circuit`);
    expect((await status()).open).toBe(false);
    for (let i = 1; i < limits.circuit_failure_threshold; i += 1) expect((await report(false)).open, `failure ${i}`).toBe(false);
    expect((await report(false)).open, 'the threshold failure opens the breaker').toBe(true);
    expect((await status()).open).toBe(true);
    expect(((await db.query(`select count(*)::int n from admin_monitoring_events where event_type='promo_email_circuit_opened'`)).rows[0] as Json).n).toBeGreaterThanOrEqual(1);
    expect((await report(true)).open, 'a success closes it').toBe(false);
    expect((await status()).open).toBe(false);
    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.promo_email_circuit_report(false)`)), 'permission denied');
    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select public.promo_email_circuit_status()`)), 'permission denied');
    // the pause ends by itself
    for (let i = 0; i < limits.circuit_failure_threshold; i += 1) await report(false);
    await db.exec(`update promo_email_circuit set open_until = now() - interval '1 minute'`);
    expect((await status()).open, 'after the pause the next send is allowed through').toBe(false);
  });
});

// =============================================================================
describe('item 7 — retention and scheduled cleanup', () => {
  const run = (dry: boolean) => as(null, 'service_role', async () => ((await db.query(`select public.promo_retention_run($1) v`, [dry])).rows[0] as { v: Json }).v);
  const rows = (v: Json, set: string) => ((v.results as Json[]).find((r) => r.data_set === set) as Json | undefined)?.rows;
  const enable = (on: boolean) => db.exec(`update premium_reminder_job_control set enabled=${on} where job_key='promo_retention'`);

  it('ships disabled, the policy rows carry the proposed periods, and the job control row exists', async () => {
    const byName = (a: Json, b: Json) => (String(a.data_set) < String(b.data_set) ? -1 : 1);
    const pol = ((await db.query(`select data_set, retention_days, action from promo_retention_policy`)).rows as Json[]).sort(byName);
    expect(pol).toEqual([
      { data_set: 'premium_expiry_email_ledger', retention_days: 400, action: 'delete' },
      { data_set: 'promo_code_events', retention_days: 2555, action: 'anonymise' },
      { data_set: 'promo_codes', retention_days: 365, action: 'anonymise' },
      { data_set: 'promo_email_requests', retention_days: 180, action: 'delete' },
      { data_set: 'promo_email_sends', retention_days: 180, action: 'anonymise' },
      { data_set: 'promo_redemption_attempts', retention_days: 30, action: 'delete' },
    ].sort(byName));
    expect(((await db.query(`select enabled from premium_reminder_job_control where job_key='promo_retention'`)).rows[0] as Json).enabled).toBe(false);
    expect(((await db.query(`select public.promo_attempts_retention_days() d`)).rows[0] as Json).d).toBe(30);
  });

  it('a real run while the switch is off changes nothing and leaves a skipped evidence row; a dry run only counts', async () => {
    const u = await newUser();
    await db.query(`insert into promo_redemption_attempts(user_id, attempted_at) values ($1, now() - interval '31 days')`, [u]);
    const dry = await run(true);
    expect(dry.dry_run).toBe(true);
    expect(Number(rows(dry, 'promo_redemption_attempts'))).toBeGreaterThanOrEqual(1);
    const off = await run(false);
    expect(off.outcome).toBe('skipped_disabled');
    expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [u])).rows[0] as Json).n, 'nothing deleted while disabled').toBe(1);
    const ev = (await db.query(`select outcome, dry_run from promo_retention_runs where outcome='skipped_disabled'`)).rows;
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(((await db.query(`select count(*)::int n from promo_retention_runs where dry_run`)).rows[0] as Json).n, 'a dry run leaves evidence too').toBeGreaterThanOrEqual(1);
  });

  it('enabled: deletes and anonymises per the policy and leaves evidence per data set', async () => {
    const u = await newUser();
    await enable(true);
    try {
      await db.query(`insert into promo_redemption_attempts(user_id, attempted_at) values ($1, now() - interval '31 days'), ($1, now() - interval '1 day')`, [u]);
      // email requests and sends
      const oldKey = `old-request-${counter}`;
      await db.query(`insert into promo_email_requests(admin_user_id, request_key, recipient_count, created_at) values ($1,$2,1, now() - interval '181 days')`, [PROMO_ADMIN, oldKey]);
      const { v } = await createPromo(PROMO_ADMIN, { max: null, unlimited: true });
      const h = keyedAddressHash('send', 'old@mail-example.com', TEST_ENV)!;
      await db.query(`insert into promo_email_sends(admin_user_id, request_key, promo_code_id, recipient_hash, status, provider_message_id, last_error, created_at) values ($1,$2,$3,$4,'failed','msg-x','resend_http_503', now() - interval '181 days')`, [PROMO_ADMIN, oldKey, v.id, h]);
      // reminder ledger: one settled old row, one pending old row
      await db.exec(`insert into user_entitlements(user_id) values ('${u}') on conflict do nothing`);
      await db.query(`insert into premium_expiry_email_ledger(user_id, entitlement_source, ends_on, threshold_days, status, created_at) values ($1,'admin_grant', current_date - 500, 30, 'sent', now() - interval '401 days'), ($1,'admin_grant', current_date - 499, 30, 'pending', now() - interval '401 days')`, [u]);
      // an old disabled code and an old expired code, an active code that must not be touched
      const idDisabled = ((await db.query(`insert into promo_codes(code_digest, code_digest_version, code_hint, duration_days, max_redemptions, created_by, status, disabled_at, disabled_by, disable_reason, note) values ($1,1,'AB******CD',30,5,$2,'disabled', now() - interval '366 days', $2, 'old campaign ended', 'secret note') returning id`, ['1'.repeat(64), PROMO_ADMIN])).rows[0] as { id: string }).id;
      const idExpired = ((await db.query(`insert into promo_codes(code_digest, code_digest_version, code_hint, duration_days, max_redemptions, created_by, expires_on, note) values ($1,1,'AB******CD',30,5,$2, current_date - 366, 'another note') returning id`, ['2'.repeat(64), PROMO_ADMIN])).rows[0] as { id: string }).id;
      const live = await createPromo(PROMO_ADMIN);
      // an old event
      await db.query(`insert into promo_code_events(created_at, event_type, actor_user_id, promo_code_id, code_hint) values (now() - interval '2600 days','create',$1,$2,'AB******CD')`, [PROMO_ADMIN, v.id]);

      const out = await run(false);
      expect(out.outcome).toBe('ok');
      expect(Number(rows(out, 'promo_redemption_attempts'))).toBeGreaterThanOrEqual(1);
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [u])).rows[0] as Json).n, 'the one day old row stays').toBe(1);
      expect(((await db.query(`select count(*)::int n from promo_email_requests where request_key=$1`, [oldKey])).rows[0] as Json).n).toBe(0);
      const send = (await db.query(`select recipient_hash, provider_message_id, last_error, anonymised_at, status from promo_email_sends where request_key=$1`, [oldKey])).rows[0] as Json;
      expect(send.recipient_hash, 'the keyed recipient hash was replaced').not.toBe(h);
      expect(send).toMatchObject({ provider_message_id: null, last_error: null, status: 'failed' });
      expect(send.anonymised_at).not.toBeNull();
      expect(((await db.query(`select status from premium_expiry_email_ledger where user_id=$1`, [u])).rows as Json[]).map((r) => r.status), 'only the settled row went, the pending row stays').toEqual(['pending']);
      for (const id of [idDisabled, idExpired]) {
        const c = (await db.query(`select note, code, code_digest, anonymised_at, status from promo_codes where id=$1`, [id])).rows[0] as Json;
        expect(c).toMatchObject({ note: null, code: null, code_digest: null });
        expect(c.anonymised_at).not.toBeNull();
      }
      const keep = (await db.query(`select code_digest, anonymised_at from promo_codes where id=$1`, [live.v.id])).rows[0] as Json;
      expect(keep.code_digest, 'an active code is never touched').toBe(live.made.digest);
      expect(keep.anonymised_at).toBeNull();
      const ev = (await db.query(`select actor_user_id, anonymised_at from promo_code_events where created_at < now() - interval '2000 days'`)).rows[0] as Json;
      expect(ev.actor_user_id, 'the actor of an old audit event was replaced').toBe('00000000-0000-0000-0000-000000000000');
      expect(ev.anonymised_at).not.toBeNull();
      expect(((await db.query(`select count(*)::int n from promo_retention_runs where run_id=$1`, [out.run_id])).rows[0] as Json).n, 'evidence per data set').toBeGreaterThanOrEqual(6);
      // a second run finds nothing more to do
      const again = await run(false);
      expect(rows(again, 'promo_email_sends')).toBe(0);
    } finally {
      await enable(false);
    }
  });

  it('the audit trail stays append-only for everyone else: no update, no delete, no truncate, even for the service role', async () => {
    const { v } = await createPromo(PROMO_ADMIN);
    await expectCode(as(null, 'service_role', () => db.query(`update promo_code_events set actor_user_id = '00000000-0000-0000-0000-000000000000' where promo_code_id=$1`, [v.id])), 'append-only');
    await expectCode(as(null, 'service_role', () => db.query(`delete from promo_code_events where promo_code_id=$1`, [v.id])), 'append-only');
    await expectCode(db.query(`truncate promo_code_events`), 'append-only');
    // the transaction local switch alone is not enough: the row must also be marked anonymised and keep its identity columns
    await db.exec(`select set_config('app.promo_retention_anonymise','on',false)`);
    await expectCode(db.query(`update promo_code_events set code_hint='XX******XX', anonymised_at=now() where promo_code_id='${v.id}'`), 'append-only');
    await expectCode(db.query(`update promo_code_events set actor_user_id=gen_random_uuid() where promo_code_id='${v.id}'`), 'append-only');
    await db.exec(`select set_config('app.promo_retention_anonymise','off',false)`);
  });

  it('a legal hold pauses a data set or one user; releasing it lets the run continue; holds need a reason', async () => {
    const u = await newUser();
    const held = await newUser();
    await enable(true);
    try {
      await db.query(`insert into promo_redemption_attempts(user_id, attempted_at) values ($1, now() - interval '40 days'), ($2, now() - interval '40 days')`, [u, held]);
      await expectCode(db.query(`insert into promo_retention_holds(data_set, reason) values ('all','short')`), 'violates check constraint');
      await db.query(`insert into promo_retention_holds(data_set, user_id, reason) values ('promo_redemption_attempts', $1, 'Dispute under review, keep this user rows')`, [held]);
      await run(false);
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [u])).rows[0] as Json).n, 'unheld user cleaned').toBe(0);
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [held])).rows[0] as Json).n, 'held user kept').toBe(1);
      // a global hold on the data set
      const u2 = await newUser();
      await db.query(`insert into promo_redemption_attempts(user_id, attempted_at) values ($1, now() - interval '40 days')`, [u2]);
      await db.query(`insert into promo_retention_holds(data_set, reason) values ('promo_redemption_attempts', 'Regulator request, hold the whole data set')`);
      const out = await run(false);
      expect(((out.results as Json[]).find((r) => r.data_set === 'promo_redemption_attempts') as Json).outcome).toBe('skipped_hold');
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [u2])).rows[0] as Json).n).toBe(1);
      await db.exec(`update promo_retention_holds set released_at = now(), released_by = 'test'`);
      await run(false);
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [u2])).rows[0] as Json).n, 'released hold: cleaned').toBe(0);
    } finally {
      await enable(false);
      await db.exec(`delete from promo_retention_holds`);
    }
  });

  it('account deletion: rows without a foreign key that belong to a deleted account are cleaned on the next run, no age limit', async () => {
    const gone = await newUser();
    await enable(true);
    try {
      const { v } = await createPromo(PROMO_ADMIN);
      await db.query(`insert into promo_redemption_attempts(user_id) values ($1)`, [gone]);
      await db.query(`insert into promo_code_events(event_type, actor_user_id, promo_code_id, code_hint) values ('redeem',$1,$2,'AB******CD')`, [gone, v.id]);
      await db.query(`insert into promo_email_requests(admin_user_id, request_key, recipient_count) values ($1,$2,1)`, [gone, `gone-${counter}-aaaaaaaa`]);
      await db.exec(`delete from auth.users where id='${gone}'`);
      const out = await run(false);
      expect(rows(out, 'account_deletion_orphans')).toBeGreaterThanOrEqual(3);
      expect(((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [gone])).rows[0] as Json).n).toBe(0);
      expect(((await db.query(`select actor_user_id from promo_code_events where code_hint='AB******CD' and promo_code_id=$1 and event_type='redeem'`, [v.id])).rows[0] as Json).actor_user_id).toBe('00000000-0000-0000-0000-000000000000');
      expect(((await db.query(`select count(*)::int n from promo_email_requests where admin_user_id=$1`, [gone])).rows[0] as Json).n).toBe(0);
    } finally {
      await enable(false);
    }
  });

  it('NC-R1: a cleanup that ignores holds deletes a held user rows', async () => {
    const held = await newUser();
    await enable(true);
    const live = latestFunctionSql('promo_retention_user_held');
    try {
      await db.query(`insert into promo_redemption_attempts(user_id, attempted_at) values ($1, now() - interval '40 days')`, [held]);
      await db.query(`insert into promo_retention_holds(data_set, user_id, reason) values ('all', $1, 'Dispute under review, keep this user rows')`, [held]);
      await withMutation(live, (s) => s.replace('select p_user_id is not null and exists (', 'select false and exists ('), async () => {
        await run(false);
        const n = ((await db.query(`select count(*)::int n from promo_redemption_attempts where user_id=$1`, [held])).rows[0] as Json).n;
        await expectNamedFailure(() => expect(n, 'a held user rows are kept').toBe(1), 'a held user rows are kept');
      });
    } finally {
      await enable(false);
      await db.exec(`delete from promo_retention_holds`);
    }
  });

  it('the scheduled job is registered ONLY with the production marker, and does not exist in a database without pg_cron', async () => {
    const partD = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'parts', '0267d.sql'), 'utf8');
    await db.exec(`delete from cron.job; delete from platform_deployment_environment;`);
    await db.exec(partD);
    expect(((await db.query(`select count(*)::int n from cron.job`)).rows[0] as Json).n, 'no marker: nothing registered').toBe(0);
    await db.exec(`insert into platform_deployment_environment(environment) values ('production')`);
    await db.exec(partD);
    await db.exec(partD); // idempotent: running it again leaves exactly one job
    const jobs = (await db.query(`select jobname, schedule, command from cron.job`)).rows as Json[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobname).toBe('promo-retention-cleanup');
    expect(String(jobs[0].command)).toContain('promo_retention_run(false)');
    expect(String(jobs[0].command), 'the job carries no secret and no URL').not.toMatch(/http|secret/i);
    await db.exec(`delete from cron.job; delete from platform_deployment_environment;`);
  });
});

// =============================================================================
describe('item 10 — production marker and scheduled job verification', () => {
  it('the marker table is not readable or writable by API roles, takes one row, and only allowed values', async () => {
    await db.exec(`delete from platform_deployment_environment`);
    for (const role of ['anon', 'authenticated'] as const) {
      await expectCode(as(role === 'anon' ? null : PROMO_ADMIN, role, () => db.query(`select * from platform_deployment_environment`)), 'permission denied');
      await expectCode(as(role === 'anon' ? null : PROMO_ADMIN, role, () => db.query(`insert into platform_deployment_environment(environment) values ('production')`)), 'permission denied');
    }
    await expectCode(db.query(`insert into platform_deployment_environment(environment) values ('prod')`), 'platform_deployment_environment_value_check');
    await db.exec(`insert into platform_deployment_environment(environment) values ('production')`);
    await expectCode(db.query(`insert into platform_deployment_environment(environment) values ('development')`), 'uq_platform_deployment_environment_single');
    await db.exec(`delete from platform_deployment_environment`);
  });

  it('part A refuses to run over a table that already holds more than one row (the operator must decide which is true)', async () => {
    const partA = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'parts', '0268a.sql'), 'utf8');
    await db.exec(`drop index uq_platform_deployment_environment_single; alter table platform_deployment_environment drop constraint platform_deployment_environment_value_check;`);
    await db.exec(`insert into platform_deployment_environment(environment) values ('production'),('development')`);
    await expectCode(db.exec(partA), 'MARKER_MORE_THAN_ONE_ROW');
    await db.exec(`delete from platform_deployment_environment`);
    await db.exec(partA); // restores the index and the constraint
    expect(((await db.query(`select count(*)::int n from pg_indexes where indexname='uq_platform_deployment_environment_single'`)).rows[0] as Json).n).toBe(1);
  });

  it('premium_cron_verify reports the marker, the jobs, the Vault secret and the kill switches (and the cron secret match by digest only)', async () => {
    const verify = (digest: string | null = null) =>
      as(null, 'service_role', async () => (await db.query(`select * from public.premium_cron_verify($1::text)`, [digest])).rows as { check_name: string; ok: boolean; detail: string }[]);
    const get = (r: { check_name: string; ok: boolean }[], name: string) => r.find((x) => x.check_name === name);
    await db.exec(`delete from cron.job; delete from platform_deployment_environment; delete from vault.decrypted_secrets;`);

    // DEV shape: no marker, no job, no secret needed. A production URL job here is a failure.
    let r = await verify();
    expect(get(r, 'marker_single_row')?.ok).toBe(true);
    expect(get(r, 'reminder_job_registered_only_in_production')?.ok).toBe(true);
    expect(get(r, 'no_production_url_job_outside_production')?.ok).toBe(true);
    await db.exec(`insert into cron.job(jobname, schedule, command) values ('premium-expiry-email-reminders','17 * * * *','select net.http_post(url := ''https://app.financialhealthplatform.com/api/premium/cron/expiry-reminders'')')`);
    r = await verify();
    expect(get(r, 'reminder_job_registered_only_in_production')?.ok, 'a reminder job on a database without the production marker').toBe(false);
    expect(get(r, 'no_production_url_job_outside_production')?.ok, 'a production URL on a database without the production marker').toBe(false);

    // production shape
    await db.exec(`insert into platform_deployment_environment(environment) values ('production')`);
    await db.exec(`insert into vault.decrypted_secrets(name, decrypted_secret) values ('premium_reminder_cron_secret', '${TEST_ENV.CRON_SECRET}')`);
    r = await verify();
    expect(get(r, 'reminder_job_registered_only_in_production')?.ok).toBe(true);
    expect(get(r, 'reminder_job_url_is_the_production_route')?.ok).toBe(true);
    expect(get(r, 'vault_secret_present')?.ok).toBe(true);
    expect(get(r, 'all_kill_switches_off')?.ok, 'shipped state: every switch off').toBe(true);
    const { createHash } = await import('node:crypto');
    const good = createHash('sha256').update(TEST_ENV.CRON_SECRET).digest('hex');
    expect(get(await verify(good), 'vault_secret_matches_application_cron_secret')?.ok).toBe(true);
    const mismatch = get(await verify(createHash('sha256').update('another').digest('hex')), 'vault_secret_matches_application_cron_secret');
    expect(mismatch?.ok).toBe(false);
    expect(JSON.stringify(await verify(good)), 'the report never carries the secret').not.toContain(TEST_ENV.CRON_SECRET);

    // a switch left on during deployment is flagged
    await db.exec(`update premium_reminder_job_control set enabled=true where job_key='expiry_email'`);
    expect(get(await verify(), 'all_kill_switches_off')?.ok, 'a kill switch left on').toBe(false);
    await db.exec(`update premium_reminder_job_control set enabled=false where job_key='expiry_email'`);

    await expectCode(as(PROMO_ADMIN, 'authenticated', () => db.query(`select * from public.premium_cron_verify(null)`)), 'permission denied');
    await expectCode(as(null, 'anon', () => db.query(`select public.platform_is_production()`)), 'permission denied');
    await db.exec(`delete from cron.job; delete from platform_deployment_environment; delete from vault.decrypted_secrets;`);
  });

  it('shipped state: every job control switch is off, including the expiry reminder e-mail and the retention job', async () => {
    const on = (await db.query(`select job_key from premium_reminder_job_control where enabled = true`)).rows;
    expect(on, 'no job control switch ships enabled').toEqual([]);
    const keys = ((await db.query(`select job_key from premium_reminder_job_control order by job_key`)).rows as { job_key: string }[]).map((r) => r.job_key);
    expect(keys).toEqual(expect.arrayContaining(['expiry_email', 'promo_retention']));
  });
});
