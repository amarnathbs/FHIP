/**
 * AIE per-user DAILY spend cap (Product Owner decision 16-10-2026) -- migration 0284, against a REAL Postgres
 * engine (PGlite) seeded from this repository's own full migration chain.
 *
 * EVIDENCE LABEL: PGLITE-VERIFIED. PGlite is a single in-process session, so the "concurrent" cases below
 * interleave statements one after another; they prove the arithmetic and that nothing is decided from a stale
 * read, NOT that two real connections block each other on the ledger row lock. That lock (the same one the
 * global allowance has always relied on) is exercised by scripts/aie_user_cap_live_dev_check.ts against DEV once
 * the DEV pack is applied. Nothing here is DEV-verified or production-verified.
 *
 * Every scenario is a function of the Postgres function NAME so the same assertions can be pointed at a MUTANT
 * built by deleting one clause of the real function. A negative control that never fails proves nothing, so each
 * mutant test asserts that the scenario DOES fail against the broken function.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIE_USER_DAILY_CAP_USD_DEFAULT } from '@/lib/aie/config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');
const MIGRATION_FILE = '0284_aie_per_user_daily_cost_cap.sql';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const REAL = 'aie_reserve_ai_cost_v2';

let db: PGlite;
let migrationSql = '';
let counter = 0;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  migrationSql = fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE), 'utf8');
  await db.exec(`insert into auth.users(id,email) values ('${USER_A}','cap-a@pg.test'),('${USER_B}','cap-b@pg.test') on conflict do nothing;`);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from aie_ai_cost_attempt;
    update aie_ai_cost_ledger set reserved_usd = 0, settled_usd = 0, total_attempts = 0, total_input_tokens = 0, total_output_tokens = 0, allowance_usd = 10, user_daily_cap_usd = 1 where id = 'global';`);
});

interface V2Row {
  reserved: boolean;
  remaining_usd: string | number;
  refusal_reason: string | null;
  user_remaining_usd: string | number;
}

function nextKey(prefix = 'k'): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

async function reserve(
  user: string,
  amount: number,
  opts: { fn?: string; key?: string; allowance?: number; cap?: number | null } = {},
): Promise<V2Row> {
  const res = await db.query<V2Row>(`select * from ${opts.fn ?? REAL}($1, $2::numeric, $3::numeric, $4, $5::uuid, $6::numeric)`, [
    'global',
    amount,
    opts.allowance ?? 10,
    opts.key ?? nextKey(),
    user,
    opts.cap === undefined ? null : opts.cap,
  ]);
  expect(res.rows).toHaveLength(1);
  return res.rows[0];
}

async function settle(key: string, actual: number): Promise<{ settled: boolean; already_settled: boolean }> {
  const res = await db.query<{ settled: boolean; already_settled: boolean }>(
    `select * from aie_settle_ai_cost_v2('global', $1, $2::numeric, 10, 5, 'gpt-4o-mini', array[]::text[], 'success', false)`,
    [key, actual],
  );
  return res.rows[0];
}

async function ledger(): Promise<{ reserved: number; settled: number; attempts: number }> {
  const r = await db.query<{ reserved_usd: string; settled_usd: string; total_attempts: string }>(
    `select reserved_usd, settled_usd, total_attempts from aie_ai_cost_ledger where id = 'global'`,
  );
  return { reserved: Number(r.rows[0].reserved_usd), settled: Number(r.rows[0].settled_usd), attempts: Number(r.rows[0].total_attempts) };
}

async function attemptRow(key: string): Promise<{ admission_outcome: string; reserved_usd: string; settled_usd: string | null; user_id: string | null }> {
  const r = await db.query<{ admission_outcome: string; reserved_usd: string; settled_usd: string | null; user_id: string | null }>(
    `select admission_outcome, reserved_usd, settled_usd, user_id from aie_ai_cost_attempt where idempotency_key = $1`,
    [key],
  );
  return r.rows[0];
}

/** Builds a copy of the real function under another name with one clause altered. The replacement MUST change the text. */
async function installMutant(name: string, from: RegExp, to: string): Promise<void> {
  const start = migrationSql.indexOf('create or replace function aie_reserve_ai_cost_v2(');
  // the function ends at its closing "end;" followed by the dollar-quote terminator
  const bodyEnd = migrationSql.indexOf('end;\n$fn$;', start) + 'end;\n$fn$;'.length;
  expect(start).toBeGreaterThan(-1);
  expect(bodyEnd).toBeGreaterThan(start);
  const original = migrationSql.slice(start, bodyEnd);
  const renamed = original.replace('function aie_reserve_ai_cost_v2(', `function ${name}(`);
  const mutated = renamed.replace(from, to);
  expect(mutated, `mutant ${name} did not change the function text`).not.toBe(renamed);
  await db.exec(mutated);
}

describe('migration 0284 -- shape', () => {
  it('the ledger column default equals the documented TypeScript default', async () => {
    const r = await db.query<{ column_default: string }>(
      `select column_default from information_schema.columns where table_name = 'aie_ai_cost_ledger' and column_name = 'user_daily_cap_usd'`,
    );
    expect(Number(r.rows[0].column_default.replace(/[^0-9.]/g, ''))).toBe(AIE_USER_DAILY_CAP_USD_DEFAULT);
  });

  it('is additive: the 0195 functions still exist unchanged and the old reserve function ignores users', async () => {
    const fns = await db.query<{ proname: string }>(
      `select proname from pg_proc where proname in ('aie_reserve_ai_cost','aie_reserve_ai_cost_v2','aie_settle_ai_cost_v2','aie_release_stale_ai_cost_reservations') order by proname`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual(['aie_release_stale_ai_cost_reservations', 'aie_reserve_ai_cost', 'aie_reserve_ai_cost_v2', 'aie_settle_ai_cost_v2']);
    const legacy = await db.query<{ reserved: boolean }>(`select * from aie_reserve_ai_cost('global', 0.5, 10, $1)`, [nextKey('legacy')]);
    expect(legacy.rows[0].reserved).toBe(true);
    // legacy attempt has no user and counts for nobody
    const a = await reserve(USER_A, 1.0);
    expect(a.reserved).toBe(true);
  });

  it('LOCK ORDER (found on DEV 16-10-2026): the ledger row is locked FOR UPDATE BEFORE the claim row is inserted', () => {
    // The claim insert references the ledger row by foreign key, which takes a shared KEY SHARE lock on it. If a transaction
    // holds that shared lock and THEN asks for FOR UPDATE, any two concurrent callers wait on each other (deadlock, resolved
    // only by aborting one after the deadlock timeout). On DEV, 22 simultaneous requests for different keys admitted 2 and
    // timed out 20 at the statement timeout. PGlite is one session so it cannot show the deadlock; this pins the ordering
    // that prevents it, and scripts/aie_user_cap_live_dev_check.ts P1 is the real proof.
    const body = migrationSql.slice(migrationSql.indexOf('as $fn$'));
    const lockAt = body.indexOf('from aie_ai_cost_ledger where id = p_ledger_id for update');
    const claimAt = body.indexOf('insert into aie_ai_cost_attempt');
    expect(lockAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(lockAt, 'ledger lock must come before the claim insert').toBeLessThan(claimAt);
    expect(body.match(/for update/g)).toHaveLength(1);
  });

  it('only the service role may execute the v2 function (anon and authenticated may not)', async () => {
    const r = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `select has_function_privilege('anon', 'aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute') as anon,
              has_function_privilege('authenticated', 'aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute') as authenticated,
              has_function_privilege('service_role', 'aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute') as service`,
    );
    expect(r.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });

  it('rejects a missing user, a non-positive amount and an empty key (raises, never admits)', async () => {
    await expect(db.query(`select * from ${REAL}('global', 0.1, 10, $1, null::uuid, null::numeric)`, [nextKey()])).rejects.toThrow(/user id is required/);
    await expect(reserve(USER_A, 0)).rejects.toThrow(/must be positive/);
    await expect(db.query(`select * from ${REAL}('global', 0.1, 10, '', $1::uuid, null::numeric)`, [USER_A])).rejects.toThrow(/idempotency key is required/);
  });
});

describe('per-user cap arithmetic', () => {
  it('BELOW the cap: admitted, and the user remainder shrinks', async () => {
    const r = await reserve(USER_A, 0.4);
    expect(r.reserved).toBe(true);
    expect(r.refusal_reason).toBeNull();
    expect(Number(r.user_remaining_usd)).toBeCloseTo(0.6, 6);
  });

  it('EXACTLY AT the cap is admitted (the cap is inclusive); the very next unit is refused', async () => {
    expect((await reserve(USER_A, 0.4)).reserved).toBe(true);
    expect((await reserve(USER_A, 0.4)).reserved).toBe(true);
    const exact = await reserve(USER_A, 0.2);
    expect(exact.reserved).toBe(true);
    expect(Number(exact.user_remaining_usd)).toBe(0);
    const over = await reserve(USER_A, 0.000001);
    expect(over.reserved).toBe(false);
    expect(over.refusal_reason).toBe('user_daily_cap');
  });

  it('ABOVE the cap: a single request larger than the cap, and a request that would cross it, are refused with the typed reason', async () => {
    const big = await reserve(USER_A, 1.01);
    expect(big).toMatchObject({ reserved: false, refusal_reason: 'user_daily_cap' });
    expect((await reserve(USER_A, 0.9)).reserved).toBe(true);
    const cross = await reserve(USER_A, 0.11);
    expect(cross).toMatchObject({ reserved: false, refusal_reason: 'user_daily_cap' });
  });

  it('a refusal changes nothing in the global ledger and is recorded as user_daily_cap_reached with zero reserved', async () => {
    await reserve(USER_A, 0.95);
    const before = await ledger();
    const key = nextKey('refused');
    const r = await reserve(USER_A, 0.2, { key });
    expect(r.reserved).toBe(false);
    expect(await ledger()).toEqual(before);
    expect(await attemptRow(key)).toMatchObject({ admission_outcome: 'user_daily_cap_reached', reserved_usd: '0.000000', user_id: USER_A });
  });

  it('two users are independent: one at the cap does not stop the other', async () => {
    expect((await reserve(USER_A, 1.0)).reserved).toBe(true);
    expect((await reserve(USER_A, 0.01)).reserved).toBe(false);
    const b = await reserve(USER_B, 1.0);
    expect(b.reserved).toBe(true);
    expect((await reserve(USER_B, 0.01)).reserved).toBe(false);
    expect(await ledger()).toMatchObject({ reserved: 2.0, attempts: 2 });
  });

  it('the stored column is the authority: the caller may only LOWER the cap, never raise it', async () => {
    expect((await reserve(USER_A, 0.4, { cap: 0.3 })).refusal_reason).toBe('user_daily_cap'); // lowered
    expect((await reserve(USER_A, 1.2, { cap: 5 })).refusal_reason).toBe('user_daily_cap'); // cannot raise above the column
    await db.exec(`update aie_ai_cost_ledger set user_daily_cap_usd = 2 where id = 'global'`);
    expect((await reserve(USER_A, 1.2)).reserved).toBe(true); // raising the column is the one place to change it
    await db.exec(`update aie_ai_cost_ledger set user_daily_cap_usd = 0 where id = 'global'`);
    expect((await reserve(USER_B, 0.000001)).refusal_reason).toBe('user_daily_cap'); // zero switches the capped path off for everyone
  });
});

describe('day boundary (UTC) and rollover', () => {
  it('spend from a previous UTC day does not count; spend since 00:00:00 UTC does', async () => {
    const k1 = nextKey('yesterday');
    expect((await reserve(USER_A, 1.0, { key: k1 })).reserved).toBe(true);
    expect((await reserve(USER_A, 0.01)).reserved).toBe(false);
    // last microsecond of the previous UTC day -> rolled over
    await db.exec(`update aie_ai_cost_attempt set created_at = (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 microsecond'`);
    expect((await reserve(USER_A, 1.0)).reserved).toBe(true);
  });

  it('exactly 00:00:00 UTC belongs to the NEW day', async () => {
    const k = nextKey('midnight');
    expect((await reserve(USER_A, 1.0, { key: k })).reserved).toBe(true);
    await db.exec(`update aie_ai_cost_attempt set created_at = date_trunc('day', now() at time zone 'utc') at time zone 'utc'`);
    expect((await reserve(USER_A, 0.01)).refusal_reason).toBe('user_daily_cap');
  });

  it('an attempt belongs to the day it was made even if it is settled after midnight', async () => {
    const k = nextKey('late-settle');
    await reserve(USER_A, 0.9, { key: k });
    await db.exec(`update aie_ai_cost_attempt set created_at = created_at - interval '1 day'`);
    expect((await settle(k, 0.9)).settled).toBe(true);
    expect((await reserve(USER_A, 1.0)).reserved).toBe(true); // yesterday's 0.9 is not today's
  });
});

describe('concurrency (interleaved statements on one session -- see the evidence note at the top)', () => {
  it('20 simultaneous requests of 0.1 for one user: exactly 10 admitted, the ledger holds exactly 1.0, nothing overshoots', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(USER_A, 0.1)));
    expect(results.filter((r) => r.reserved)).toHaveLength(10);
    expect(results.filter((r) => !r.reserved).every((r) => r.refusal_reason === 'user_daily_cap')).toBe(true);
    expect(await ledger()).toMatchObject({ reserved: 1.0, attempts: 10 });
  });

  it('two users racing: each gets exactly their own share', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => reserve(i % 2 === 0 ? USER_A : USER_B, 0.1).then((r) => ({ user: i % 2 === 0 ? 'a' : 'b', ...r }))),
    );
    expect(results.filter((r) => r.user === 'a' && r.reserved)).toHaveLength(10);
    expect(results.filter((r) => r.user === 'b' && r.reserved)).toHaveLength(10);
    expect(await ledger()).toMatchObject({ reserved: 2.0 });
  });

  it('the same key sent many times at once reserves once (replay is never admitted, never charged)', async () => {
    const key = nextKey('same');
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(USER_A, 0.3, { key })));
    expect(results.filter((r) => r.reserved)).toHaveLength(1);
    expect(results.filter((r) => r.refusal_reason === 'replay')).toHaveLength(7);
    expect(await ledger()).toMatchObject({ reserved: 0.3, attempts: 1 });
  });
});

describe('settlement and stale recovery are per-user-correct', () => {
  it('settling at a LOWER actual cost gives the headroom back to that user only', async () => {
    const k = nextKey('lower');
    await reserve(USER_A, 0.9, { key: k });
    expect((await reserve(USER_A, 0.2)).reserved).toBe(false);
    await settle(k, 0.1);
    const again = await reserve(USER_A, 0.85);
    expect(again.reserved).toBe(true);
    expect(await ledger()).toMatchObject({ settled: 0.1, reserved: 0.85 });
  });

  it('settling at a HIGHER actual cost than reserved is counted in full', async () => {
    const k = nextKey('higher');
    await reserve(USER_A, 0.5, { key: k });
    await settle(k, 0.95);
    expect((await reserve(USER_A, 0.1)).refusal_reason).toBe('user_daily_cap');
    expect((await reserve(USER_A, 0.05)).reserved).toBe(true);
  });

  it('settling twice charges once (the settle function is a no-op on replay) and does not move the user total', async () => {
    const k = nextKey('twice');
    await reserve(USER_A, 0.5, { key: k });
    expect(await settle(k, 0.2)).toEqual({ settled: true, already_settled: false });
    expect(await settle(k, 0.2)).toEqual({ settled: false, already_settled: true });
    expect((await reserve(USER_A, 0.8)).reserved).toBe(true);
    expect((await reserve(USER_A, 0.01)).reserved).toBe(false);
  });

  it('a stale unsettled reservation is released conservatively at the FULL reserved amount and still counts for its own user only', async () => {
    const k = nextKey('stale');
    await reserve(USER_A, 0.6, { key: k });
    // Placed at 00:00:00 UTC today: the oldest moment that still counts for TODAY (a fixed "3 hours ago" would
    // fall on the previous UTC day for the first three hours of every UTC day and make this test flaky).
    await db.exec(`update aie_ai_cost_attempt set created_at = date_trunc('day', now() at time zone 'utc') at time zone 'utc' where idempotency_key = '${k}'`);
    const released = await db.query<{ n: number }>(`select aie_release_stale_ai_cost_reservations(5) as n`);
    expect(Number(released.rows[0].n)).toBe(1);
    expect(await attemptRow(k)).toMatchObject({ settled_usd: '0.600000' });
    expect((await reserve(USER_A, 0.5)).refusal_reason).toBe('user_daily_cap'); // 0.6 + 0.5 > 1
    expect((await reserve(USER_A, 0.4)).reserved).toBe(true); // 0.6 + 0.4 = 1
    expect((await reserve(USER_B, 1.0)).reserved).toBe(true); // the other user is untouched
  });

  it('a reservation still in flight counts at its reserved amount, so a burst cannot all be admitted before anything settles', async () => {
    await reserve(USER_A, 0.6);
    expect((await reserve(USER_A, 0.6)).reserved).toBe(false);
  });
});

describe('replay and idempotency do not double charge', () => {
  it('a replayed ADMITTED key is refused with reason replay and changes neither the ledger nor the user total', async () => {
    const k = nextKey('replay');
    await reserve(USER_A, 0.4, { key: k });
    const before = await ledger();
    const again = await reserve(USER_A, 0.4, { key: k });
    expect(again).toMatchObject({ reserved: false, refusal_reason: 'replay' });
    expect(Number(again.user_remaining_usd)).toBeCloseTo(0.6, 6);
    expect(await ledger()).toEqual(before);
  });

  it('a replayed REFUSED key stays refused, and a settled key cannot buy another call', async () => {
    const refused = nextKey('refused-replay');
    await reserve(USER_A, 1.0);
    expect((await reserve(USER_A, 0.1, { key: refused })).refusal_reason).toBe('user_daily_cap');
    expect((await reserve(USER_A, 0.1, { key: refused })).refusal_reason).toBe('replay');
    const settledKey = nextKey('settled-replay');
    await reserve(USER_B, 0.2, { key: settledKey });
    await settle(settledKey, 0.1);
    expect((await reserve(USER_B, 0.2, { key: settledKey })).refusal_reason).toBe('replay');
  });
});

describe('composition with the global allowance', () => {
  it('a user under their cap is still refused when the GLOBAL allowance is gone, with the global reason', async () => {
    const r = await reserve(USER_A, 0.6, { allowance: 0.5 });
    expect(r).toMatchObject({ reserved: false, refusal_reason: 'budget_exhausted' });
  });

  it('when both would refuse, the per-user reason wins (it is the one the person can act on)', async () => {
    await reserve(USER_A, 0.9);
    const r = await reserve(USER_A, 0.5, { allowance: 1.0 });
    expect(r.refusal_reason).toBe('user_daily_cap');
  });

  it('the global total across users still holds: many users each under their cap cannot exceed the global allowance', async () => {
    await db.exec(`update aie_ai_cost_ledger set allowance_usd = 1.5 where id = 'global'`);
    expect((await reserve(USER_A, 1.0)).reserved).toBe(true);
    const b = await reserve(USER_B, 0.9);
    expect(b).toMatchObject({ reserved: false, refusal_reason: 'budget_exhausted' });
  });
});

describe('NEGATIVE CONTROLS -- each scenario must FAIL against a function with one clause removed', () => {
  async function overshootScenario(fn: string): Promise<number> {
    // returns how many 0.1 requests were admitted out of 15 for one user
    await db.exec(`delete from aie_ai_cost_attempt; update aie_ai_cost_ledger set reserved_usd = 0, settled_usd = 0, total_attempts = 0 where id = 'global'`);
    const results = await Promise.all(Array.from({ length: 15 }, () => reserve(USER_A, 0.1, { fn })));
    return results.filter((r) => r.reserved).length;
  }

  it('control: the real function admits 10 (the cap), the function WITHOUT the per-user check admits all 15', async () => {
    await installMutant('aie_reserve_ai_cost_v2_no_user_check', /if v_user_used \+ p_amount_usd > v_effective_user_cap then/, 'if false then');
    expect(await overshootScenario(REAL)).toBe(10);
    const mutantAdmitted = await overshootScenario('aie_reserve_ai_cost_v2_no_user_check');
    expect(mutantAdmitted).toBe(15);
    expect(mutantAdmitted).toBeGreaterThan(10); // the scenario above would FAIL against this mutant
  });

  it('control: without the day filter, a rolled-over day stays blocked (the rollover scenario fails)', async () => {
    await installMutant('aie_reserve_ai_cost_v2_no_day_filter', /and a\.created_at >= v_day_start;\n  v_user_remaining/, ';\n  v_user_remaining');
    await db.exec(`delete from aie_ai_cost_attempt`);
    await reserve(USER_A, 1.0);
    await db.exec(`update aie_ai_cost_attempt set created_at = created_at - interval '2 days'`);
    expect((await reserve(USER_A, 1.0, { fn: REAL })).reserved).toBe(true);
    await db.exec(`delete from aie_ai_cost_attempt`);
    await reserve(USER_A, 1.0);
    await db.exec(`update aie_ai_cost_attempt set created_at = created_at - interval '2 days'`);
    expect((await reserve(USER_A, 1.0, { fn: 'aie_reserve_ai_cost_v2_no_day_filter' })).reserved).toBe(false);
  });

  it('control: counting only the reserved amount (ignoring settlement) lets a higher-than-reserved settlement overshoot', async () => {
    await installMutant('aie_reserve_ai_cost_v2_reserved_only', /coalesce\(a\.settled_usd, a\.reserved_usd\)\), 0\) into v_user_used\n    from aie_ai_cost_attempt a\n   where a\.user_id = p_user_id and a\.created_at >= v_day_start;\n  v_user_remaining/, 'a.reserved_usd), 0) into v_user_used\n    from aie_ai_cost_attempt a\n   where a.user_id = p_user_id and a.created_at >= v_day_start;\n  v_user_remaining');
    for (const fn of [REAL, 'aie_reserve_ai_cost_v2_reserved_only']) {
      await db.exec(`delete from aie_ai_cost_attempt`);
      const k = nextKey('hi');
      await reserve(USER_A, 0.5, { key: k, fn });
      await settle(k, 0.95);
      const next = await reserve(USER_A, 0.4, { fn });
      expect(next.reserved, fn).toBe(fn === REAL ? false : true);
    }
  });

  it('control: a function that ignores the user (attributes everything to one bucket) lets two users interfere -- the independence scenario fails', async () => {
    await installMutant('aie_reserve_ai_cost_v2_shared_bucket', /where a\.user_id = p_user_id and a\.created_at >= v_day_start;\n  v_user_remaining/, 'where a.created_at >= v_day_start;\n  v_user_remaining');
    await db.exec(`delete from aie_ai_cost_attempt`);
    await reserve(USER_A, 1.0, { fn: 'aie_reserve_ai_cost_v2_shared_bucket' });
    const b = await reserve(USER_B, 0.5, { fn: 'aie_reserve_ai_cost_v2_shared_bucket' });
    expect(b.reserved).toBe(false); // wrongly blocked: independence is lost
    await db.exec(`delete from aie_ai_cost_attempt`);
    await reserve(USER_A, 1.0);
    expect((await reserve(USER_B, 0.5)).reserved).toBe(true); // the real function keeps them apart
  });
});
