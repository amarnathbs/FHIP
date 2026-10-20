/**
 * AI spend controls as the production proof needs them understood (PGLITE-VERIFIED: a real Postgres engine seeded from this repository's
 * whole migration chain; single in-process session, so "simultaneous" cases are interleaved statements -- the true multi-connection race
 * was DEV-verified separately with scripts/aie_user_cap_live_dev_check.ts, 22 simultaneous requests admitted exactly 10).
 *
 * WHAT THIS ADDS to aieUserDailyCapPglite.test.ts (which proves the cap arithmetic mutant by mutant):
 *   1. THE RESET PERIOD OF THE GLOBAL ALLOWANCE IS "NEVER": it is a lifetime ledger. Spend dated 40 days ago still counts against it, while
 *      the per-user cap forgets yesterday. Nothing in the migrations or the application resets, deletes or truncates it.
 *   2. The effective global ceiling is the SMALLER of the environment value and the stored column: raising the environment variable
 *      cannot raise the ceiling; only an update of the stored column can.
 *   3. A realistic proof session (six document readings at their real reserve and settle sizes) leaves exactly the settled amounts in the
 *      ledger and in the user's daily total, nothing reserved, and replaying every key charges nothing.
 *   4. A bounded synthetic cap (US$0.01) shows the whole refuse / settle / re-admit cycle without spending a cent of provider money.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SUPABASE_ROOT = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const REAL = 'aie_reserve_ai_cost_v2';

let db: PGlite;
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
  await db.exec(`insert into auth.users(id,email) values ('${USER_A}','proof-a@pg.test'),('${USER_B}','proof-b@pg.test') on conflict do nothing;`);
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`delete from aie_ai_cost_attempt;
    update aie_ai_cost_ledger set reserved_usd = 0, settled_usd = 0, total_attempts = 0, total_input_tokens = 0, total_output_tokens = 0, allowance_usd = 10, user_daily_cap_usd = 1 where id = 'global';`);
});

const key = (p = 'k') => `${p}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
interface V2 { reserved: boolean; remaining_usd: string | number; refusal_reason: string | null; user_remaining_usd: string | number }
async function reserve(user: string, amount: number, o: { key?: string; allowance?: number } = {}): Promise<V2 & { k: string }> {
  const k = o.key ?? key();
  const r = await db.query<V2>(`select * from ${REAL}('global', $1::numeric, $2::numeric, $3, $4::uuid, null)`, [amount, o.allowance ?? 10, k, user]);
  return { ...r.rows[0], k };
}
async function settle(k: string, actual: number, inTok = 1377, outTok = 396) {
  await db.query(`select * from aie_settle_ai_cost_v2('global', $1, $2::numeric, $3, $4, 'gpt-4o-mini', array['req_proof']::text[], 'success', false)`, [k, actual, inTok, outTok]);
}
async function ledger() {
  const r = await db.query<{ reserved_usd: string; settled_usd: string; total_attempts: string }>(`select reserved_usd, settled_usd, total_attempts from aie_ai_cost_ledger where id = 'global'`);
  return { reserved: Number(r.rows[0].reserved_usd), settled: Number(r.rows[0].settled_usd), attempts: Number(r.rows[0].total_attempts) };
}
async function userToday(user: string): Promise<number> {
  const r = await db.query<{ s: string }>(`select coalesce(sum(coalesce(settled_usd, reserved_usd)), 0) as s from aie_ai_cost_attempt where user_id = $1 and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`, [user]);
  return Number(r.rows[0].s);
}
const near = (a: number, b: number, eps = 0.0000015) => Math.abs(a - b) < eps;

describe('1. the global allowance is a LIFETIME ledger (reset period: never); the per-user cap resets every UTC day', () => {
  it('spend dated 40 days ago still counts against the global allowance, while the same user has their whole daily cap back', async () => {
    await db.exec(`update aie_ai_cost_ledger set allowance_usd = 1.00 where id = 'global'`);
    const first = await reserve(USER_A, 0.9, { allowance: 1.0 });
    expect(first.reserved).toBe(true);
    await settle(first.k, 0.9);
    // age the attempt by 40 days (a rolled-over UTC day, many times over)
    await db.exec(`update aie_ai_cost_attempt set created_at = now() - interval '40 days' where idempotency_key = '${first.k}'`);
    expect(await userToday(USER_A)).toBe(0); // per-user: forgotten
    const next = await reserve(USER_A, 0.2, { allowance: 1.0 });
    expect(next.reserved).toBe(false);
    expect(next.refusal_reason).toBe('budget_exhausted'); // global: remembered, NOT user_daily_cap
    expect(Number(next.user_remaining_usd)).toBeGreaterThan(0.99); // the person has their daily cap back, the platform does not have the money
    const l = await ledger();
    expect(near(l.settled, 0.9)).toBe(true);
  });

  it('a second person is refused for the same reason: nobody can spend a ledger that has no lifetime headroom left', async () => {
    await db.exec(`update aie_ai_cost_ledger set allowance_usd = 0.5 where id = 'global'`);
    const a = await reserve(USER_A, 0.5, { allowance: 0.5 });
    await settle(a.k, 0.5);
    await db.exec(`update aie_ai_cost_attempt set created_at = now() - interval '400 days'`);
    const b = await reserve(USER_B, 0.01, { allowance: 0.5 });
    expect(b.reserved).toBe(false);
    expect(b.refusal_reason).toBe('budget_exhausted');
  });

  it('NEGATIVE CONTROL: a ledger whose settled total is cleared admits again, which proves the refusals above come from the lifetime total and nothing else', async () => {
    await db.exec(`update aie_ai_cost_ledger set allowance_usd = 0.5 where id = 'global'`);
    const a = await reserve(USER_A, 0.5, { allowance: 0.5 });
    await settle(a.k, 0.5);
    expect((await reserve(USER_B, 0.01, { allowance: 0.5 })).reserved).toBe(false);
    await db.exec(`update aie_ai_cost_ledger set settled_usd = 0 where id = 'global'`); // the reset nothing in the product does
    expect((await reserve(USER_B, 0.01, { allowance: 0.5 })).reserved).toBe(true);
  });

  it('nothing in the migrations or the application resets, deletes or truncates the ledger or its attempts', () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/--.*$/gm, '');
      if (/settled_usd\s*=\s*0\b/.test(sql) && /aie_ai_cost_ledger/.test(sql)) offenders.push(`${f}: settled_usd = 0`);
      if (/(delete\s+from|truncate(\s+table)?)\s+(public\.)?aie_ai_cost_(ledger|attempt)\b/i.test(sql)) offenders.push(`${f}: delete/truncate`);
      if (/cron\.schedule[\s\S]{0,400}aie_ai_cost/i.test(sql)) offenders.push(`${f}: scheduled job touching the ledger`);
    }
    expect(offenders).toEqual([]);
    const app = fs.readFileSync(path.join(ROOT, 'lib/aie/cost/costAdmission.ts'), 'utf8');
    expect(app).not.toMatch(/aie_ai_cost_ledger['"`]\)\s*\.(update|delete|upsert)/);
    // the only application reads of the ledger table are the status read in costAdmission.ts
    const touching: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && /from\(['"]aie_ai_cost_(ledger|attempt)['"]\)/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) touching.push(rel);
      }
    };
    walk('lib'); walk('app');
    expect(touching).toEqual(['lib/aie/cost/costAdmission.ts']);
  });
});

describe('2. the effective global ceiling is the SMALLER of the environment value and the stored column', () => {
  beforeEach(async () => { await db.exec(`update aie_ai_cost_ledger set user_daily_cap_usd = 100 where id = 'global'`); }); // keep the per-user cap out of the way
  it('an environment value far above the stored allowance cannot raise it', async () => {
    const r = await reserve(USER_A, 10.01, { allowance: 1000 });
    expect(r.reserved).toBe(false);
    expect(r.refusal_reason).toBe('budget_exhausted');
    expect((await reserve(USER_A, 9.99, { allowance: 1000 })).reserved).toBe(true);
  });
  it('an environment value below the stored allowance lowers it', async () => {
    const r = await reserve(USER_A, 0.6, { allowance: 0.5 });
    expect(r.reserved).toBe(false);
    expect(r.refusal_reason).toBe('budget_exhausted');
  });
  it('raising the ceiling needs the stored column updated: after that the same request is admitted', async () => {
    expect((await reserve(USER_A, 10.01, { allowance: 1000 })).reserved).toBe(false);
    await db.exec(`update aie_ai_cost_ledger set allowance_usd = 20 where id = 'global'`);
    expect((await reserve(USER_A, 10.01, { allowance: 1000 })).reserved).toBe(true);
    expect((await reserve(USER_B, 10.0, { allowance: 1000 })).reserved).toBe(false); // 10.01 + 10.00 > 20
  });
});

describe('3. a realistic proof session accounts exactly', () => {
  // [reserve, settle, input tokens, output tokens]: the real DEV bank reading reserved 0.009173 and settled 0.000444 (1,377 + 396 tokens)
  const SESSION: Array<[number, number, number, number]> = [
    [0.009173, 0.000444, 1377, 396], [0.009173, 0.000471, 1420, 402], [0.009173, 0.000402, 1301, 361],
    [0.00272, 0.000211, 905, 190], [0.009173, 0.000668, 2379, 518], [0.009173, 0.000328, 1321, 216],
  ];
  it('six readings: reservation released, settled total equals the sum of actuals, the user total equals the same, replays charge nothing', async () => {
    const keys: string[] = [];
    for (const [res] of SESSION) { const r = await reserve(USER_A, res); expect(r.reserved).toBe(true); keys.push(r.k); }
    expect(near((await ledger()).reserved, SESSION.reduce((s, x) => s + x[0], 0))).toBe(true);
    for (let i = 0; i < SESSION.length; i++) await settle(keys[i], SESSION[i][1], SESSION[i][2], SESSION[i][3]);
    const l = await ledger();
    const expectedSettled = SESSION.reduce((s, x) => s + x[1], 0);
    expect(l.reserved).toBe(0);
    expect(near(l.settled, expectedSettled)).toBe(true);
    expect(l.attempts).toBe(6);
    expect(near(await userToday(USER_A), expectedSettled)).toBe(true);
    // replay every key (a retry, a double click, a re-sent request): refused as replay, nothing changes
    for (const k of keys) {
      const again = await reserve(USER_A, 0.009173, { key: k });
      expect(again.reserved).toBe(false);
      expect(again.refusal_reason).toBe('replay');
    }
    const l2 = await ledger();
    expect(l2).toEqual(l);
    expect(near(await userToday(USER_A), expectedSettled)).toBe(true);
    // settling a second time charges once
    await settle(keys[0], 5);
    expect(near((await ledger()).settled, expectedSettled)).toBe(true);
    // the other person is untouched
    expect(await userToday(USER_B)).toBe(0);
  });
});

describe('4. a bounded synthetic cap (US$0.01) shows refuse, settle and re-admit with no provider money', () => {
  it('first reading reserved at 0.009173 is admitted, the second is refused for the person, settling at 0.000444 gives the headroom back', async () => {
    await db.exec(`update aie_ai_cost_ledger set user_daily_cap_usd = 0.01 where id = 'global'`);
    const first = await reserve(USER_A, 0.009173);
    expect(first.reserved).toBe(true);
    const second = await reserve(USER_A, 0.009173);
    expect(second.reserved).toBe(false);
    expect(second.refusal_reason).toBe('user_daily_cap');
    const before = await ledger();
    expect(before.reserved).toBeCloseTo(0.009173, 6); // the refusal reserved nothing
    await settle(first.k, 0.000444);
    const third = await reserve(USER_A, 0.009173);
    expect(third.reserved).toBe(true); // 0.000444 + 0.009173 <= 0.01
    const other = await reserve(USER_B, 0.009173);
    expect(other.reserved).toBe(true); // the other person has their own 0.01
    const refusedRow = await db.query<{ admission_outcome: string; reserved_usd: string }>(`select admission_outcome, reserved_usd from aie_ai_cost_attempt where idempotency_key = '${second.k}'`);
    expect(refusedRow.rows[0]).toEqual({ admission_outcome: 'user_daily_cap_reached', reserved_usd: '0.000000' });
  });
});
