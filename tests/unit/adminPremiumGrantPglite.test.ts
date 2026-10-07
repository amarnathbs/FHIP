// Admin Premium grant (migration 0231) — real-Postgres (PGlite) proof of the
// DATABASE half: the capability, the 365-day cap, the mandatory reason, paid-
// entitlement protection, the atomic audit trail, the Stripe/webhook merge, the
// window-driven return to Free in the AI entitlement path, RLS and
// cross-user isolation.
//
// The whole migration ledger (0001..latest, including 0231) is replayed into an
// ISOLATED in-memory Postgres, then every rule is exercised through the real
// SECURITY DEFINER functions as the real database roles (authenticated /
// service_role / anon) with auth.uid() driven by request.jwt.claims — nothing
// is reimplemented in the test.
//
// NEGATIVE CONTROLS. A green test proves nothing if it cannot go red. For each
// rule the suite runs the SAME assertion twice: once against the real function
// (must pass), and once against a copy of the function with exactly that rule
// surgically removed (the assertion MUST throw). The mutation is verified to
// have actually changed the SQL, and the real function is restored afterwards.
// The assertion that goes red is named in each control's title.
//
// EVIDENCE LABEL: this suite is "code-complete, verified on an isolated PGlite
// replay". It is NOT DEV-verified or production-verified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { latestFunctionSql } from './support/promoTestHelpers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
// The CURRENT definitions of the manage and webhook functions live in the promo/extension-cap migration
// (it replaces them in place), so the negative controls mutate and then restore THAT text; restoring the
// 0231 text would silently downgrade the function under test.
const LATEST_NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_admin_promo_codes_extension_cap_expiry_summary.sql'));
if (!LATEST_NAME) throw new Error('promo / extension-cap migration not found');
const MIGRATION_LATEST = fs.readFileSync(path.join(MIG_DIR, LATEST_NAME), 'utf8');
const MIGRATION_0115 = fs.readFileSync(path.join(MIG_DIR, '0115_module11_1_ai_entitlements_quotas_cost_controls.sql'), 'utf8');

const ADMIN = 'aaaaaaaa-0000-0000-0000-00000000a001'; // holds can_manage_premium_entitlements
const ADMIN_NOCAP = 'aaaaaaaa-0000-0000-0000-00000000a002'; // in admin_users, capability false
const PLAIN = 'aaaaaaaa-0000-0000-0000-00000000a003'; // ordinary user

let db: PGlite;
let counter = 0;

type Json = Record<string, unknown>;

function extractFn(sql: string, name: string): string {
  const re = new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`);
  const m = sql.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
// The hardening migration (0265) replaces admin_manage_premium_entitlement(), so the negative controls mutate and restore the NEWEST definition.
const MANAGE_FN = latestFunctionSql('admin_manage_premium_entitlement');
const WEBHOOK_FN = extractFn(MIGRATION_LATEST, 'apply_subscription_entitlement_event');
const AI_STATE_FN = extractFn(MIGRATION_0115, 'ai_entitlement_state');

async function newUser(label = 'u'): Promise<string> {
  counter += 1;
  const id = `bbbbbbbb-0000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email) values ('${id}','${label}${counter}@pg.test');`); // signup trigger creates the free entitlement row
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

const asAdmin = <T>(fn: () => Promise<T>) => as(ADMIN, 'authenticated', fn);

async function manage(actor: string, action: string, target: string, endsOn: string | null, reason = 'Pilot customer, invoice pending'): Promise<Json> {
  return as(actor, 'authenticated', async () => {
    const { rows } = await db.query(`select public.admin_manage_premium_entitlement($1,$2,$3,$4,false) v`, [action, target, endsOn, reason]);
    return (rows[0] as { v: Json }).v;
  });
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

const today = async () => ((await db.query(`select current_date::text d`)).rows[0] as { d: string }).d;
const addDays = async (n: number) => ((await db.query(`select (current_date + $1::int)::text d`, [n])).rows[0] as { d: string }).d;
// PGlite returns date/timestamptz columns as JS Dates; normalise to strings so assertions compare like with like.
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
const eventCount = async (target?: string) =>
  ((await db.query(target ? `select count(*)::int c from admin_entitlement_events where target_user_id=$1` : `select count(*)::int c from admin_entitlement_events`, target ? [target] : [])).rows[0] as { c: number }).c;

async function aiStateV(uid: string): Promise<Json> {
  return ((await db.query(`select ai_entitlement_state($1) v`, [uid])).rows[0] as { v: Json }).v;
}
async function aiAdmit(uid: string, hh: string): Promise<Json> {
  const { rows } = await db.query(
    `select ai_admit_request($1,$2,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false,null,null,null,1000,200,500) v`,
    [uid, hh]
  );
  const v = (rows[0] as { v: Json & { allowed?: boolean; execution_state?: string; admission_id?: string } }).v;
  if (v.allowed && v.execution_state === 'reserved' && v.admission_id) await db.query(`select ai_finalise_admission($1)`, [v.admission_id]);
  return v;
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

// A negative control passes only when the NAMED assertion goes red against the broken rule. A failure
// for any other reason (a SQL error in the mutated function, a harness fault) does not count.
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

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  expect(files).toContain('0231_admin_premium_entitlement_grants.sql');
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await db.exec(`insert into auth.users(id,email) values ('${ADMIN}','admin@pg.test'),('${ADMIN_NOCAP}','admin-nocap@pg.test'),('${PLAIN}','plain@pg.test');`);
  await db.exec(`insert into admin_users(user_id) values ('${ADMIN}'),('${ADMIN_NOCAP}');`);
  await db.exec(`update admin_users set can_manage_premium_entitlements = true where user_id='${ADMIN}';`);
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 0231 — shape', () => {
  it('adds the source columns with safe defaults and the capability column defaulting to false', async () => {
    const free = await ent(PLAIN);
    expect(free.entitlement_source).toBe('payment');
    expect(free.admin_grant_ends_on).toBeNull();
    const cap = (await db.query(`select can_manage_premium_entitlements c from admin_users where user_id=$1`, [ADMIN_NOCAP])).rows[0] as { c: boolean };
    expect(cap.c).toBe(false);
  });

  it('the audit table has RLS enabled, and anon/authenticated hold no write privilege on it or on user_entitlements via RLS', async () => {
    const rls = (await db.query(`select relrowsecurity r from pg_class where oid='public.admin_entitlement_events'::regclass`)).rows[0] as { r: boolean };
    expect(rls.r).toBe(true);
    const grants = (await db.query(
      `select privilege_type p from information_schema.role_table_grants where table_name='admin_entitlement_events' and grantee in ('anon','authenticated') order by 1`
    )).rows.map((r) => (r as { p: string }).p);
    expect(grants).toEqual(['SELECT']);
  });
});

describe('authorisation (Standard §2/§4) — capability enforced in the DATABASE', () => {
  it('an ordinary user, an admin WITHOUT the capability, anon and service_role (no auth.uid) all cannot grant', async () => {
    const t = await newUser();
    const before = await eventCount();
    const end = await addDays(30);
    await expectCode(manage(PLAIN, 'grant', t, end), 'ENTITLEMENT_ADMIN_REQUIRED');
    await expectCode(manage(ADMIN_NOCAP, 'grant', t, end), 'ENTITLEMENT_ADMIN_REQUIRED');
    // anon has no EXECUTE at all (permission denied).
    await expect(as(null, 'anon', () => db.query(`select public.admin_manage_premium_entitlement('grant',$1,$2,'some valid reason',false)`, [t, end]))).rejects.toThrow(/permission denied/i);
    // service_role may hold EXECUTE through platform default privileges, but auth.uid() is null for it, so the function itself refuses.
    await expect(as(null, 'service_role', () => db.query(`select public.admin_manage_premium_entitlement('grant',$1,$2,'some valid reason',false)`, [t, end]))).rejects.toThrow(/permission denied|ENTITLEMENT_UNAUTHENTICATED/i);
    expect((await ent(t)).plan_tier).toBe('free');
    expect(await eventCount()).toBe(before);
  });

  it('the capability holder succeeds (positive control)', async () => {
    const t = await newUser();
    const v = await manage(ADMIN, 'grant', t, await addDays(30));
    expect(v.plan_tier).toBe('premium');
  });

  it('NEGATIVE CONTROL — with the capability check removed, an ordinary user CAN grant (assertion "non-admin refused" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/if not public\.is_premium_entitlement_admin\(\) then\s+raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';\s+end if;/, ''),
      async () => {
        await expectAssertionFails(async () => {
          const t = await newUser();
          await expectCode(manage(PLAIN, 'grant', t, await addDays(30)), 'ENTITLEMENT_ADMIN_REQUIRED');
        }, 'expected rejection with ENTITLEMENT_ADMIN_REQUIRED');
      }
    );
  });

  it('read RPCs refuse a capability-less caller (search / list / history)', async () => {
    for (const who of [PLAIN, ADMIN_NOCAP]) {
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_search_premium_entitlement_users('anything')`)), 'ENTITLEMENT_ADMIN_REQUIRED');
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_list_premium_grants('expiring',30)`)), 'ENTITLEMENT_ADMIN_REQUIRED');
      await expectCode(as(who, 'authenticated', () => db.query(`select * from public.admin_premium_entitlement_history($1,10)`, [PLAIN])), 'ENTITLEMENT_ADMIN_REQUIRED');
    }
  });

  it('the audit table is readable only by the capability holder (RLS), and not writable by anyone via the API roles', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(10));
    const adminRows = await asAdmin(async () => (await db.query(`select id from admin_entitlement_events where target_user_id=$1`, [t])).rows.length);
    expect(adminRows).toBe(1);
    const plainRows = await as(PLAIN, 'authenticated', async () => (await db.query(`select id from admin_entitlement_events`)).rows.length);
    expect(plainRows).toBe(0);
    const noCapRows = await as(ADMIN_NOCAP, 'authenticated', async () => (await db.query(`select id from admin_entitlement_events`)).rows.length);
    expect(noCapRows).toBe(0);
    await expect(
      asAdmin(() =>
        db.query(
          `insert into admin_entitlement_events(action,actor_user_id,target_user_id,reason,after_plan_tier,after_entitlement_source) values ('grant',$1,$2,'forged audit row here','premium','admin_grant')`,
          [ADMIN, t]
        )
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it('users cannot write user_entitlements or admin_users themselves (the existing boundary is intact)', async () => {
    const u = await newUser();
    const upd = await as(u, 'authenticated', () => db.query(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', admin_grant_ends_on=current_date+5 where user_id=$1`, [u]));
    expect(upd.affectedRows ?? 0).toBe(0);
    expect((await ent(u)).plan_tier).toBe('free');
    const esc = await as(PLAIN, 'authenticated', () => db.query(`update admin_users set can_manage_premium_entitlements=true where user_id=$1`, [PLAIN]));
    expect(esc.affectedRows ?? 0).toBe(0);
    await expectCode(manage(u, 'grant', u, await addDays(10)), 'ENTITLEMENT_ADMIN_REQUIRED'); // a user cannot call it for themselves
  });
});

describe('the 1-year (365 days counting the first day) cap — enforced by the database, not the UI', () => {
  async function assertCap(): Promise<void> {
    const t = await newUser();
    await expectCode(manage(ADMIN, 'grant', t, await addDays(365)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    expect((await ent(t)).plan_tier, 'a rejected 366-day grant (end date today plus 365) must not change the row').toBe('free');
    const ok = await manage(ADMIN, 'grant', t, await addDays(364));
    expect(ok.effective_to).toBe(await addDays(364));
  }

  it('a 366 day grant (end today plus 365) is rejected, a 365 day grant (end today plus 364) is accepted', async () => {
    await assertCap();
  });

  it('past dates, missing dates are rejected', async () => {
    const t = await newUser();
    await expectCode(manage(ADMIN, 'grant', t, await addDays(-1)), 'ENTITLEMENT_END_DATE_IN_PAST');
    await expectCode(manage(ADMIN, 'grant', t, null), 'ENTITLEMENT_END_DATE_REQUIRED');
    expect((await ent(t)).plan_tier).toBe('free');
  });

  it('NEGATIVE CONTROL — with the cap removed a 400-day grant succeeds (assertion "366 days rejected" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/if p_ends_on > v_max_end then/, 'if false then'),
      async () => {
        await expectAssertionFails(assertCap, 'expected rejection with ENTITLEMENT_END_DATE_EXCEEDS_MAX');
      }
    );
  });

  it('an extension is capped at 365 days from the DATE OF THE EXTENSION (not from the original allocation)', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(300));
    // Backdate the allocation by 200 days (grant started 200 days ago, ends in 300): an extension is
    // measured from today, so today+364 is allowed even though it is 564 days after the allocation.
    await db.exec(`update user_entitlements set effective_from = current_date - 200 where user_id='${t}'`);
    const v = await manage(ADMIN, 'extend', t, await addDays(364));
    expect(v.effective_to).toBe(await addDays(364));
    await expectCode(manage(ADMIN, 'extend', t, await addDays(365)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
    expect((await ent(t)).effective_to).toBe(await addDays(364)); // unchanged by the rejected extension
  });

  it('NEGATIVE CONTROL — with the cap removed an over-long EXTENSION succeeds (assertion "extension 366 rejected" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/if p_ends_on > v_max_end then/, 'if false then'),
      async () => {
        await expectAssertionFails(async () => {
          const t = await newUser();
          await manage(ADMIN, 'grant', t, await addDays(30));
          await expectCode(manage(ADMIN, 'extend', t, await addDays(365)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX');
        }, 'expected rejection with ENTITLEMENT_END_DATE_EXCEEDS_MAX');
      }
    );
  });
});

describe('mandatory reason', () => {
  async function assertReason(): Promise<void> {
    const t = await newUser();
    for (const bad of ['', '   ', 'too short', '         x  ']) {
      await expectCode(manage(ADMIN, 'grant', t, await addDays(10), bad), 'ENTITLEMENT_REASON_REQUIRED');
    }
    expect((await ent(t)).plan_tier).toBe('free');
    await expectCode(manage(ADMIN, 'grant', t, await addDays(10), 'x'.repeat(1001)), 'ENTITLEMENT_REASON_TOO_LONG');
    const ok = await manage(ADMIN, 'grant', t, await addDays(10), 'Exactly ten');
    expect(ok.plan_tier).toBe('premium');
  }
  it('empty / whitespace-only / <10 chars rejected for grant; revoke needs one too', async () => {
    await assertReason();
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(10));
    await expectCode(manage(ADMIN, 'revoke', t, null, 'short'), 'ENTITLEMENT_REASON_REQUIRED');
    await expectCode(manage(ADMIN, 'extend', t, await addDays(20), ''), 'ENTITLEMENT_REASON_REQUIRED');
  });
  it('NEGATIVE CONTROL — with the reason check removed a blank-reason grant is accepted (assertion "reason required" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/if char_length\(v_reason\) < 10 then/, 'if false then'),
      async () => {
        await expectAssertionFails(assertReason, 'expected rejection with ENTITLEMENT_REASON_REQUIRED');
      }
    );
  });
});

describe('audit trail — one row per successful action, none for a rejected one, append-only', () => {
  async function assertAudit(): Promise<void> {
    const t = await newUser();
    const b0 = await eventCount(t);
    await manage(ADMIN, 'grant', t, await addDays(60), 'Audit probe grant');
    expect(await eventCount(t), 'grant writes exactly one audit row').toBe(b0 + 1);
    await expectCode(manage(ADMIN, 'grant', t, await addDays(60)), 'ENTITLEMENT_GRANT_ALREADY_ACTIVE'); // rejected
    await expectCode(manage(ADMIN, 'extend', t, await addDays(999)), 'ENTITLEMENT_END_DATE_EXCEEDS_MAX'); // rejected
    expect(await eventCount(t), 'rejected requests write NO audit row').toBe(b0 + 1);
    await manage(ADMIN, 'extend', t, await addDays(90), 'Audit probe extend');
    await manage(ADMIN, 'revoke', t, null, 'Audit probe revoke');
    expect(await eventCount(t)).toBe(b0 + 3);
  }

  it('records actor, target, reason and before/after tier + dates', async () => {
    const t = await newUser();
    const end = await addDays(45);
    await manage(ADMIN, 'grant', t, end, 'Cheque payment pending clearance');
    const e = norm((await db.query(`select * from admin_entitlement_events where target_user_id=$1 order by created_at desc limit 1`, [t])).rows[0] as Json);
    expect(e.action).toBe('grant');
    expect(e.actor_user_id).toBe(ADMIN);
    expect(e.target_user_id).toBe(t);
    expect(e.reason).toBe('Cheque payment pending clearance');
    expect(e.before_plan_tier).toBe('free');
    expect(e.after_plan_tier).toBe('premium');
    expect(e.after_entitlement_source).toBe('admin_grant');
    expect(String(e.after_effective_to).slice(0, 10)).toBe(end);
    expect(String(e.after_effective_from).slice(0, 10)).toBe(await today());
    expect(String(e.requested_ends_on).slice(0, 10)).toBe(end);
  });

  it('exactly one row per success and zero per rejection', async () => {
    await assertAudit();
  });

  it('NEGATIVE CONTROL — with the audit insert removed no row is written (assertion "grant writes exactly one audit row" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/insert into public\.admin_entitlement_events \([\s\S]*?returning id into v_event_id;/, 'v_event_id := gen_random_uuid();'),
      async () => {
        await expectAssertionFails(assertAudit, 'grant writes exactly one audit row');
      }
    );
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused even for the table owner', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(20));
    await expect(db.query(`update admin_entitlement_events set reason='edited reason text' where target_user_id=$1`, [t])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from admin_entitlement_events where target_user_id=$1`, [t])).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate admin_entitlement_events`)).rejects.toThrow(/append-only/);
    expect(await eventCount(t)).toBe(1);
  });

  it('history RPC returns the trail newest-first for the capability holder only', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(20), 'History probe grant');
    await manage(ADMIN, 'extend', t, await addDays(40), 'History probe extend');
    const rows = await asAdmin(async () => (await db.query(`select action, actor_email, reason from public.admin_premium_entitlement_history($1,50)`, [t])).rows as { action: string; actor_email: string; reason: string }[]);
    expect(rows.map((r) => r.action)).toEqual(['extend', 'grant']);
    expect(rows[0].actor_email).toBe('admin@pg.test');
  });
});

describe('grant / extend / revoke state machine', () => {
  it('grant sets Premium/admin_grant from today; a second grant on an active grant is refused (use extend)', async () => {
    const t = await newUser();
    const end = await addDays(100);
    const v = await manage(ADMIN, 'grant', t, end);
    expect(v).toMatchObject({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_to: end, admin_grant_ends_on: end });
    expect(v.effective_from).toBe(await today());
    await expectCode(manage(ADMIN, 'grant', t, end), 'ENTITLEMENT_GRANT_ALREADY_ACTIVE');
  });

  it('extend must be strictly later than the current end while the grant is active; shortening is not an extension', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(100));
    await expectCode(manage(ADMIN, 'extend', t, await addDays(100)), 'ENTITLEMENT_EXTENSION_NOT_LATER');
    await expectCode(manage(ADMIN, 'extend', t, await addDays(50)), 'ENTITLEMENT_EXTENSION_NOT_LATER');
    const v = await manage(ADMIN, 'extend', t, await addDays(200));
    expect(v.effective_to).toBe(await addDays(200));
    expect(v.effective_from).toBe(await today()); // an ACTIVE grant keeps its start
  });

  it('extending an EXPIRED grant re-activates it from today', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(10));
    await db.exec(`update user_entitlements set effective_from=current_date-40, effective_to=current_date-5, admin_grant_ends_on=current_date-5 where user_id='${t}'`);
    const v = await manage(ADMIN, 'extend', t, await addDays(30), 'Re-activating after lapse');
    expect(v).toMatchObject({ plan_tier: 'premium', entitlement_source: 'admin_grant' });
    expect(v.effective_from).toBe(await today());
    expect(v.effective_to).toBe(await addDays(30));
  });

  it('revoke returns the user to free and clears the grant markers; revoking again is refused', async () => {
    const t = await newUser();
    await manage(ADMIN, 'grant', t, await addDays(100));
    const v = await manage(ADMIN, 'revoke', t, null, 'Granted in error, reversing');
    expect(v).toMatchObject({ plan_tier: 'free', entitlement_source: 'payment', effective_to: null, admin_grant_ends_on: null });
    await expectCode(manage(ADMIN, 'revoke', t, null, 'Granted in error, reversing'), 'ENTITLEMENT_NO_ADMIN_GRANT');
    await expectCode(manage(ADMIN, 'extend', t, await addDays(10)), 'ENTITLEMENT_NO_ADMIN_GRANT');
  });

  it('an admin cannot target their own account; unknown users are not found', async () => {
    await expectCode(manage(ADMIN, 'grant', ADMIN, await addDays(10)), 'ENTITLEMENT_SELF_TARGET');
    await expectCode(manage(ADMIN, 'grant', 'cccccccc-0000-0000-0000-000000000000', await addDays(10)), 'ENTITLEMENT_USER_NOT_FOUND');
  });
});

describe('a genuine paid entitlement is never clobbered through the grant UI', () => {
  async function paidUser(): Promise<string> {
    const t = await newUser('paid');
    await as(null, 'service_role', () =>
      db.query(`select public.apply_subscription_entitlement_event($1,'stripe','cus_x','sub_x',true,'active','premium_monthly_au',now()+interval '30 days',false)`, [t])
    );
    return t;
  }

  async function assertPaidProtected(): Promise<void> {
    const t = await paidUser();
    const before = await ent(t);
    const ev = await eventCount(t);
    await expectCode(manage(ADMIN, 'grant', t, await addDays(30)), 'ENTITLEMENT_PAID_ACTIVE');
    await expectCode(manage(ADMIN, 'extend', t, await addDays(30)), 'ENTITLEMENT_PAID_ACTIVE');
    await expectCode(manage(ADMIN, 'revoke', t, null, 'Trying to revoke a paid plan'), 'ENTITLEMENT_PAID_ACTIVE');
    const after = await ent(t);
    for (const k of ['plan_tier', 'entitlement_source', 'effective_from', 'effective_to', 'admin_grant_ends_on', 'subscription_status', 'provider_subscription_id']) {
      expect(after[k], `paid row column ${k} must be untouched`).toEqual(before[k]);
    }
    expect(await eventCount(t), 'refused attempts leave no audit row').toBe(ev);
  }

  it('grant / extend / revoke are all REFUSED on an active paid entitlement and change nothing', async () => {
    await assertPaidProtected();
  });

  it('NEGATIVE CONTROL — with the paid-protection removed a grant overwrites a paying customer (assertion "paid row untouched / grant refused" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;\s+if v_managed_active then raise exception 'ENTITLEMENT_GRANT_ALREADY_ACTIVE'/, "if v_managed_active then raise exception 'ENTITLEMENT_GRANT_ALREADY_ACTIVE'"),
      async () => {
        await expectAssertionFails(assertPaidProtected, 'expected rejection with ENTITLEMENT_PAID_ACTIVE');
      }
    );
  });

  it('a manually-set Premium (no provider, set by SQL before 0231) is protected the same way', async () => {
    const t = await newUser('manual');
    await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${t}'`);
    await expectCode(manage(ADMIN, 'grant', t, await addDays(30)), 'ENTITLEMENT_PAID_ACTIVE');
  });

  it('a LAPSED paid/other Premium (window ended) is not active, so an admin may grant', async () => {
    const t = await newUser('lapsedpaid');
    await db.exec(`update user_entitlements set plan_tier='premium', effective_to=current_date-3 where user_id='${t}'`);
    const v = await manage(ADMIN, 'grant', t, await addDays(30));
    expect(v.entitlement_source).toBe('admin_grant');
  });
});

describe('Stripe/Razorpay webhook merge — payment never shortens or silently downgrades an admin grant', () => {
  const webhook = (uid: string, confers: boolean, status: string) =>
    as(null, 'service_role', () =>
      db.query(`select public.apply_subscription_entitlement_event($1,'stripe','cus_1','sub_1',$2,$3,'premium_monthly_au',now()+interval '30 days',false) v`, [uid, confers, status])
    );

  async function assertPaymentMerge(): Promise<void> {
    const t = await newUser('merge');
    const grantEnd = await addDays(200);
    await manage(ADMIN, 'grant', t, grantEnd);

    // (a) an abandoned checkout ('incomplete') must NOT take away the grant.
    await webhook(t, false, 'incomplete');
    let r = await ent(t);
    expect(r.plan_tier, 'incomplete checkout must not downgrade an admin grant').toBe('premium');
    expect(r.entitlement_source).toBe('admin_grant');
    expect(String(r.effective_to).slice(0, 10)).toBe(grantEnd);

    // (b) a successful payment WINS and must not leave the grant's end date acting on a paying customer.
    await webhook(t, true, 'active');
    r = await ent(t);
    expect(r.plan_tier).toBe('premium');
    expect(r.entitlement_source).toBe('payment');
    expect(r.effective_to, 'a paying customer must not be cut off at the admin grant expiry').toBeNull();
    expect(String(r.admin_grant_ends_on).slice(0, 10), 'the grant is kept in reserve').toBe(grantEnd);

    // (c) cancellation falls back to the unexpired grant instead of dropping to free.
    await webhook(t, false, 'canceled');
    r = await ent(t);
    expect(r.plan_tier, 'cancellation must restore the unexpired grant, not silently downgrade').toBe('premium');
    expect(r.entitlement_source).toBe('admin_grant');
    expect(String(r.effective_to).slice(0, 10)).toBe(grantEnd);

    // (d) once the grant has itself lapsed, cancellation correctly lands on free.
    await webhook(t, true, 'active');
    await db.exec(`update user_entitlements set admin_grant_ends_on = current_date - 2 where user_id='${t}'`);
    await webhook(t, false, 'canceled');
    r = await ent(t);
    expect(r.plan_tier).toBe('free');
  }

  it('abandoned checkout keeps the grant; payment wins and clears the live end date; cancel restores the grant; a lapsed grant ends at free', async () => {
    await assertPaymentMerge();
  });

  it('NEGATIVE CONTROL — a naive webhook (plain plan_tier overwrite, no merge) fails the same assertions (assertion "incomplete checkout must not downgrade an admin grant" goes red)', async () => {
    const naive = WEBHOOK_FN.replace(/elsif v_row\.admin_grant_ends_on is not null and v_row\.admin_grant_ends_on >= v_today then[\s\S]*?v_restored := true;/, 'elsif false then null;');
    await withMutation(WEBHOOK_FN, () => naive, async () => {
      await expectAssertionFails(assertPaymentMerge, 'incomplete checkout must not downgrade an admin grant');
    });
  });

  it('NEGATIVE CONTROL — a webhook that leaves the grant end date on a paying customer fails (assertion "paying customer must not be cut off at the admin grant expiry" goes red)', async () => {
    await withMutation(WEBHOOK_FN, (s) => s.replace("v_tier := 'premium'; v_src := 'payment'; v_to := null;", "v_tier := 'premium'; v_src := 'payment';"), async () => {
      await expectAssertionFails(assertPaymentMerge, 'a paying customer must not be cut off at the admin grant expiry');
    });
  });

  it('an unknown user is a no-op (never an insert from webhook data); legacy free users behave as before', async () => {
    const r = await webhook('cccccccc-0000-0000-0000-000000000009', true, 'active');
    expect((r.rows[0] as { v: Json }).v.applied).toBe(false);
    const t = await newUser('legacy');
    await webhook(t, true, 'active');
    expect((await ent(t)).plan_tier).toBe('premium');
    await webhook(t, false, 'canceled');
    expect((await ent(t)).plan_tier).toBe('free');
  });

  it('the webhook function is service_role only (authenticated/anon cannot call it)', async () => {
    const t = await newUser('whperm');
    for (const role of ['authenticated', 'anon'] as const) {
      await expect(
        as(role === 'authenticated' ? t : null, role, () => db.query(`select public.apply_subscription_entitlement_event($1,'stripe','c','s',true,'active',null,null,false)`, [t]))
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('expiry returns the user to Free in the AI entitlement path (ai_entitlement_state + ai_admit_request)', () => {
  async function lifecycle(): Promise<void> {
    const t = await newUser('ai');
    const hh = `dddddddd-0000-0000-0000-${String(counter).padStart(12, '0')}`;
    await db.exec(`insert into households (id, user_id) values ('${hh}','${t}')`);

    expect((await aiStateV(t)).reason, 'before any grant the user is Free').toBe('premium_required');

    await manage(ADMIN, 'grant', t, await addDays(30));
    let s = await aiStateV(t);
    expect(s.eligible, 'grant -> eligible').toBe(true);
    expect((await aiAdmit(t, hh)).allowed, 'grant -> admitted').toBe(true);

    await db.exec(`update user_entitlements set effective_to = current_date - 1 where user_id='${t}'`); // the grant lapses
    s = await aiStateV(t);
    expect(s.eligible, 'expired -> not eligible').toBe(false);
    expect(s.reason, 'expired -> premium_required').toBe('premium_required');
    const denied = await aiAdmit(t, hh);
    expect(denied.allowed, 'expired -> admission refused').toBe(false);
    expect(denied.deny_reason).toBe('entitlement_expired');

    await manage(ADMIN, 'extend', t, await addDays(60), 'Extending after lapse');
    expect((await aiStateV(t)).eligible, 'extend -> eligible again').toBe(true);

    await manage(ADMIN, 'revoke', t, null, 'Revoking for the lifecycle test');
    s = await aiStateV(t);
    expect(s.eligible, 'revoke -> not eligible').toBe(false);
    expect(s.reason).toBe('premium_required');
  }

  it('grant -> eligible; backdate effective_to -> premium_required / entitlement_expired; extend -> eligible; revoke -> premium_required', async () => {
    await lifecycle();
  });

  it('NEGATIVE CONTROL — if the AI function ignored effective_to, an expired grant would still be eligible (assertion "expired -> not eligible" goes red)', async () => {
    await withMutation(
      AI_STATE_FN,
      (s) => s.replace('and (effective_to is null or effective_to >= current_date);', ';'),
      async () => {
        await expectAssertionFails(lifecycle, 'expired -> not eligible');
      }
    );
  });
});

describe('cross-user isolation — granting A never changes B', () => {
  async function assertIsolation(): Promise<void> {
    const a = await newUser('iso-a');
    const b = await newUser('iso-b');
    const bBefore = await ent(b);
    const bEvents = await eventCount(b);
    await manage(ADMIN, 'grant', a, await addDays(30));
    await manage(ADMIN, 'extend', a, await addDays(60));
    await manage(ADMIN, 'revoke', a, null, 'Isolation probe revoke');
    expect(await ent(b), 'B row must be byte-identical').toEqual(bBefore);
    expect(await eventCount(b)).toBe(bEvents);
    await manage(ADMIN, 'grant', a, await addDays(30));
    expect((await ent(b)).plan_tier).toBe('free');
  }
  it('A\'s grant/extend/revoke leave B\'s entitlement row and audit history untouched', async () => {
    await assertIsolation();
  });
  it('NEGATIVE CONTROL — if the grant UPDATE lost its WHERE user_id clause B would be upgraded (assertion "B row must be byte-identical" goes red)', async () => {
    await withMutation(
      MANAGE_FN,
      (s) => s.replace(/updated_at = now\(\)\n     where user_id = p_target_user_id;\n\n  elsif p_action = 'extend'/, "updated_at = now()\n     where true;\n\n  elsif p_action = 'extend'"),
      async () => {
        await expectAssertionFails(assertIsolation, 'B row must be byte-identical');
      }
    );
  });
});

describe('admin read RPCs — search, expiring list', () => {
  it('search needs >= 3 chars, matches email fragments and exact user ids, returns <= 20 rows', async () => {
    const t = await newUser('zzsearch');
    await expectCode(asAdmin(() => db.query(`select * from public.admin_search_premium_entitlement_users('ab')`)), 'ENTITLEMENT_QUERY_TOO_SHORT');
    const byEmail = await asAdmin(async () => (await db.query(`select user_id, entitlement_active from public.admin_search_premium_entitlement_users('zzsearch')`)).rows as { user_id: string }[]);
    expect(byEmail.map((r) => r.user_id)).toContain(t);
    const byId = await asAdmin(async () => (await db.query(`select user_id from public.admin_search_premium_entitlement_users($1)`, [t])).rows as { user_id: string }[]);
    expect(byId.map((r) => r.user_id)).toEqual([t]);
    for (let i = 0; i < 25; i += 1) await newUser('zzbulk');
    const bulk = await asAdmin(async () => (await db.query(`select 1 from public.admin_search_premium_entitlement_users('zzbulk')`)).rows.length);
    expect(bulk).toBe(20);
  });

  it('expiring list shows grants ending within 30 days, not later ones; lapsed list shows lapsed ones', async () => {
    const soon = await newUser('soon');
    const later = await newUser('later');
    const lapsed = await newUser('lapsed');
    await manage(ADMIN, 'grant', soon, await addDays(10));
    await manage(ADMIN, 'grant', later, await addDays(90));
    await manage(ADMIN, 'grant', lapsed, await addDays(5));
    await db.exec(`update user_entitlements set effective_from=current_date-20, effective_to=current_date-2, admin_grant_ends_on=current_date-2 where user_id='${lapsed}'`);
    const expiring = await asAdmin(async () => (await db.query(`select user_id, days_remaining from public.admin_list_premium_grants('expiring',30)`)).rows as { user_id: string; days_remaining: number }[]);
    const ids = expiring.map((r) => r.user_id);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(later);
    expect(ids).not.toContain(lapsed);
    expect(expiring.find((r) => r.user_id === soon)?.days_remaining).toBe(10);
    const lapsedList = await asAdmin(async () => (await db.query(`select user_id from public.admin_list_premium_grants('lapsed',30)`)).rows as { user_id: string }[]);
    expect(lapsedList.map((r) => r.user_id)).toContain(lapsed);
    await expectCode(asAdmin(() => db.query(`select * from public.admin_list_premium_grants('bogus',30)`)), 'ENTITLEMENT_FILTER_INVALID');
  });
});
