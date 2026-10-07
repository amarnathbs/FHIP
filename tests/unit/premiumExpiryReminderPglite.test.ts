// Premium expiry e-mail reminders (migration 0238) — real-Postgres (PGlite) proof
// of the DATABASE half: who is due, the send-once ledger, retries without
// duplication, the kill-switch default, the production-only schedule guard and the
// service-role-only boundary. No mail is sent anywhere in this suite: the mailer
// is exercised separately with an injected fake (premiumExpiryReminderRunner.test.ts).
//
// NEGATIVE CONTROLS: each rule's assertion runs against the real function (must
// pass) and against a copy with exactly that rule removed (the NAMED assertion
// must go red; any other failure does not count). The mutation is verified to
// change the SQL and the real function is restored afterwards.
//
// CONCURRENCY — HONEST LIMIT: PGlite is a single connection, so two simultaneous
// cron runs cannot be raced here. "Overlapping runs" is proven by (a) claim being
// idempotent across back-to-back runs (the second returns nothing) and (b) the
// UNIQUE key, which the database enforces for truly concurrent inserts; the
// key's firing is exercised by removing the claim's own duplicate checks.
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. Not DEV-
// or production-verified.

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
const NAME = fs.readdirSync(MIG_DIR).find((f) => f.endsWith('_premium_expiry_email_reminders.sql'));
if (!NAME) throw new Error('premium expiry reminders migration not found');
const MIGRATION = fs.readFileSync(path.join(MIG_DIR, NAME), 'utf8');

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

function extractFn(name: string): string {
  const m = MIGRATION.match(new RegExp(`create or replace function (?:public\\.)?${name}\\([\\s\\S]*?\\n\\$fn\\$;`));
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}
// The hardening migration (0265) replaces the claim, so the negative controls mutate and restore the NEWEST definition.
const CLAIM_FN = latestFunctionSql('premium_reminder_claim');
const RECORD_FN = extractFn('premium_reminder_record');
const SCHEDULE_BLOCK = (() => {
  const i = MIGRATION.lastIndexOf('do $$');
  const j = MIGRATION.indexOf('end $$;', i);
  return MIGRATION.slice(i, j + 'end $$;'.length);
})();

async function newUser(label: string): Promise<string> {
  counter += 1;
  const id = `cccccccc-2000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email) values ('${id}','${label}${counter}@pg.test');`);
  return id;
}

/** Make `uid` hold a managed (or paid) entitlement that ends `endsIn` days from today and started `startedAgo` days ago. */
async function seed(uid: string, source: 'admin_grant' | 'promo_code' | 'payment', endsIn: number, startedAgo = 400): Promise<void> {
  if (source === 'payment') {
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='payment', effective_from=current_date-${startedAgo}, effective_to=current_date+${endsIn}, admin_grant_ends_on=current_date+${endsIn}, reserve_source='admin_grant' where user_id='${uid}'`);
    return;
  }
  await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='${source}', effective_from=current_date-${startedAgo}, effective_to=current_date+${endsIn}, admin_grant_ends_on=current_date+${endsIn}, reserve_source='${source}' where user_id='${uid}'`);
}

async function as<T>(role: 'authenticated' | 'anon' | 'service_role', uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

interface Claimed {
  ledger_id: string;
  user_id: string;
  email: string;
  country: string | null;
  entitlement_source: string;
  ends_on: Date | string;
  threshold_days: number;
  attempt: number;
}
async function claim(opts: { thresholds?: number[]; only?: string | null; batch?: number; maxAttempts?: number } = {}): Promise<Claimed[]> {
  return as('service_role', null, async () => {
    const { rows } = await db.query(`select * from public.premium_reminder_claim(current_date, $1::int[], $2, $3, 60, $4)`, [
      opts.thresholds ?? [30],
      opts.batch ?? 50,
      opts.maxAttempts ?? 3,
      opts.only ?? null,
    ]);
    return rows as unknown as Claimed[];
  });
}
const record = (id: string, ok: boolean, msg: string | null = null, err: string | null = null, maxAttempts = 3) =>
  as('service_role', null, async () => ((await db.query(`select public.premium_reminder_record($1,$2,$3,$4,60,$5) r`, [id, ok, msg, err, maxAttempts])).rows[0] as { r: boolean }).r);
const ledger = async (uid: string) => (await db.query(`select * from premium_expiry_email_ledger where user_id=$1 order by created_at, id`, [uid])).rows as Json[];

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
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seedSql = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  for (const f of fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seedSql);
  }
}, 240_000);

afterAll(async () => {
  await db?.close();
});

describe('shape and defaults', () => {
  it('the job ships DISABLED (kill switch row present and false); the ledger has no address/body/code columns', async () => {
    const row = (await db.query(`select enabled from premium_reminder_job_control where job_key='expiry_email'`)).rows[0] as { enabled: boolean };
    expect(row.enabled).toBe(false);
    const cols = (await db.query(`select column_name from information_schema.columns where table_name='premium_expiry_email_ledger'`)).rows.map((r) => (r as { column_name: string }).column_name);
    for (const forbidden of ['email', 'body', 'subject', 'text', 'code', 'promo_code_id']) expect(cols, forbidden).not.toContain(forbidden);
  });

  it('the ledger and kill-switch tables are unreadable/unwritable for users (RLS, no policy, no grant); claim/record are service_role only', async () => {
    const u = await newUser('perm');
    for (const t of ['premium_expiry_email_ledger', 'premium_reminder_job_control']) {
      await expect(as('authenticated', u, () => db.query(`select 1 from ${t}`))).rejects.toThrow(/permission denied/i);
      await expect(as('anon', null, () => db.query(`select 1 from ${t}`))).rejects.toThrow(/permission denied/i);
    }
    await expect(as('authenticated', u, () => db.query(`update premium_reminder_job_control set enabled=true`))).rejects.toThrow(/permission denied/i);
    for (const role of ['authenticated', 'anon'] as const) {
      await expect(as(role, u, () => db.query(`select * from public.premium_reminder_claim(current_date, '{30}', 5, 3, 60, null)`))).rejects.toThrow(/permission denied/i);
      await expect(as(role, u, () => db.query(`select public.premium_reminder_record($1,true,null,null,60,3)`, [u]))).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('who is due — thresholds, source, ownership', () => {
  async function assertBoundaries(): Promise<void> {
    const cases: [number, boolean][] = [[31, false], [30, true], [15, true], [1, true], [0, true]];
    for (const [daysLeft, due] of cases) {
      const u = await newUser('bd');
      await seed(u, 'admin_grant', daysLeft);
      const got = await claim({ only: u });
      expect(got.length > 0, `${daysLeft} days left: due=${due} (exactly 30 days left must be claimed)`).toBe(due);
    }
    const gone = await newUser('bd');
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-60, effective_to=current_date-1, admin_grant_ends_on=current_date-1, reserve_source='admin_grant' where user_id='${gone}'`);
    expect((await claim({ only: gone })).length, 'an already-ended window is never e-mailed').toBe(0);
  }
  it('threshold boundaries: 31 days left no; 30, 15, 1 and 0 (last day) yes; ended yesterday no', async () => {
    await assertBoundaries();
  });
  it('NEGATIVE CONTROL — with the boundary made strict (< instead of <=) the 30-day mark is missed (assertion "exactly 30 days left must be claimed" goes red)', async () => {
    await withMutation(CLAIM_FN, (s) => s.replace('(e.effective_to - p_today) <= x', '(e.effective_to - p_today) < x'), async () => {
      await expectAssertionFails(assertBoundaries, 'exactly 30 days left must be claimed');
    });
  });

  async function assertNeverPaid(): Promise<void> {
    const paid = await newUser('paid');
    await seed(paid, 'payment', 10); // paying customer, with an admin grant held in reserve
    // (a database error here is the ledger's own CHECK on the source firing; it is reported as a failed assertion)
    const got = await claim({ only: paid }).catch((e: Error) => [{ thrown: e.message }]);
    expect(got.length, 'paid Premium is never claimed').toBe(0);
    const grant = await newUser('grant');
    await seed(grant, 'admin_grant', 10);
    expect((await claim({ only: grant })).length).toBe(1);
  }
  it('admin-granted and promo Premium are due; PAID Premium is never due (even with a grant in reserve)', async () => {
    await assertNeverPaid();
    const promo = await newUser('promo');
    await seed(promo, 'promo_code', 10);
    expect((await claim({ only: promo }))[0].entitlement_source).toBe('promo_code');
  });
  it('NEGATIVE CONTROL — with the source filter removed a paying customer would be e-mailed; the ledger CHECK on the source is the independent backstop that refuses the row (assertion "paid Premium is never claimed" goes red)', async () => {
    await withMutation(CLAIM_FN, (s) => s.replace("and e.entitlement_source in ('admin_grant', 'promo_code')\n       and e.effective_to is not null and e.effective_to >= p_today", 'and e.effective_to is not null and e.effective_to >= p_today'), async () => {
      await expectAssertionFails(assertNeverPaid, 'paid Premium is never claimed');
    });
  });

  it('free users and entitlements with no end date are never due', async () => {
    const free = await newUser('free');
    const open = await newUser('open');
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='admin_grant', effective_from=current_date-5, effective_to=null, admin_grant_ends_on=current_date+5, reserve_source='admin_grant' where user_id='${open}'`);
    expect((await claim({ only: free })).length).toBe(0);
    expect((await claim({ only: open })).length).toBe(0);
  });

  it('a short window is not told "30 days left": a 30-day promo redeemed today is not due at the 30-day mark', async () => {
    const u = await newUser('short');
    await seed(u, 'promo_code', 29, 0); // started today and ends on today plus 29: a 30 day window, both ends inclusive
    expect((await claim({ only: u })).length).toBe(0);
    const u2 = await newUser('short');
    await seed(u2, 'promo_code', 6, 24);
    expect((await claim({ only: u2, thresholds: [30, 7] })).map((c) => c.threshold_days)).toEqual([7]);
  });

  it('with thresholds [30, 7] only the MOST URGENT applicable one is sent; later, the second is sent separately', async () => {
    const early = await newUser('two');
    await seed(early, 'admin_grant', 20);
    expect((await claim({ only: early, thresholds: [30, 7] })).map((c) => c.threshold_days)).toEqual([30]);
    await db.exec(`update premium_expiry_email_ledger set status='sent', sent_at=now() where user_id='${early}'`);
    await seed(early, 'admin_grant', 5);
    // the end date moved, so this is a NEW window: the 7-day reminder (most urgent) is due once
    expect((await claim({ only: early, thresholds: [30, 7] })).map((c) => c.threshold_days)).toEqual([7]);
    const late = await newUser('two');
    await seed(late, 'admin_grant', 3);
    expect((await claim({ only: late, thresholds: [30, 7] })).map((c) => c.threshold_days)).toEqual([7]); // late enable: one e-mail, not two
  });

  async function assertOwnRecipient(): Promise<void> {
    const a = await newUser('own');
    const b = await newUser('own');
    const c = await newUser('own');
    await seed(a, 'admin_grant', 10);
    await seed(b, 'promo_code', 12);
    // c is free
    const got = await claim({ batch: 500 });
    const mine = got.filter((g) => [a, b, c].includes(g.user_id));
    expect(mine.map((g) => g.user_id).sort(), "another user's entitlement must not be claimed").toEqual([a, b].sort());
    for (const g of got) {
      const owner = (await db.query(`select email from auth.users where id=$1`, [g.user_id])).rows[0] as { email: string };
      expect(g.email, 'the address must belong to the entitlement\'s own user').toBe(owner.email);
    }
  }
  it('each claim carries the address of the entitlement\'s OWN user; a free user is not included', async () => {
    await assertOwnRecipient();
  });
  it('NEGATIVE CONTROL — a claim that joined the address through the wrong key would mail the wrong person (assertion "the address must belong to the entitlement\'s own user" goes red)', async () => {
    await withMutation(
      CLAIM_FN,
      (s) => s.replace("select l.id, l.user_id, u.email::text, p.country_of_residence::text,", "select l.id, l.user_id, (select u2.email::text from auth.users u2 order by u2.email limit 1), p.country_of_residence::text,"),
      async () => {
        await expectAssertionFails(assertOwnRecipient, "the address must belong to the entitlement's own user");
      }
    );
  });
});

describe('send-once ledger', () => {
  async function assertOnce(): Promise<void> {
    const u = await newUser('once');
    await seed(u, 'admin_grant', 10);
    const first = await claim({ only: u });
    expect(first, 'first run claims the reminder').toHaveLength(1);
    const second = await claim({ only: u }).catch((e: Error) => [{ thrown: e.message }]);
    expect(second, 'an immediate rerun / overlapping run must claim nothing').toEqual([]);
    expect(await record(first[0].ledger_id, true, 'msg_1')).toBe(true);
    expect(await claim({ only: u }), 'after it was sent nothing is claimed again').toEqual([]);
    expect(await ledger(u), 'exactly one ledger row').toHaveLength(1);
  }
  it('a rerun or overlapping run never claims the same reminder twice, before or after it is sent', async () => {
    await assertOnce();
  });
  it('NEGATIVE CONTROL — without the duplicate checks only the UNIQUE key stands between a rerun and a second e-mail (assertion "an immediate rerun / overlapping run must claim nothing" goes red; the key fires by name)', async () => {
    await withMutation(
      CLAIM_FN,
      (s) =>
        s
          .replace(/\n       and not exists \(select 1 from public\.premium_expiry_email_ledger x[\s\S]*?x\.threshold_days = d\.threshold\)/, '')
          .replace('on conflict on constraint uq_premium_expiry_email_window do nothing', ''),
      async () => {
        await expectAssertionFails(assertOnce, 'an immediate rerun / overlapping run must claim nothing');
        const u = await newUser('once2');
        await seed(u, 'admin_grant', 10);
        await claim({ only: u });
        await expect(claim({ only: u })).rejects.toThrow(/uq_premium_expiry_email_window/);
      }
    );
  });

  it('an extension (new end date) opens a NEW window and may be reminded; the same window never is', async () => {
    const u = await newUser('window');
    await seed(u, 'admin_grant', 10);
    const a = await claim({ only: u });
    await record(a[0].ledger_id, true, 'm1');
    await seed(u, 'admin_grant', 25); // extended
    const b = await claim({ only: u });
    expect(b).toHaveLength(1);
    expect(b[0].ledger_id).not.toBe(a[0].ledger_id);
    expect(await ledger(u)).toHaveLength(2);
  });

  it('stuck "pending" (worker died, outcome unknown) becomes "unknown" after 30 minutes and is NEVER re-sent', async () => {
    const u = await newUser('stuck');
    await seed(u, 'admin_grant', 10);
    const a = await claim({ only: u });
    await db.exec(`update premium_expiry_email_ledger set last_attempt_at = now() - interval '45 minutes' where id='${a[0].ledger_id}'`);
    expect(await claim({ only: u })).toEqual([]);
    expect((await ledger(u))[0].status).toBe('unknown');
    expect(await claim({ only: u })).toEqual([]);
  });

  it('claim carries the user\'s country for date formatting and nothing else personal beyond the address', async () => {
    const u = await newUser('ctry');
    await db.exec(`update user_profiles set country_of_residence='IN' where user_id='${u}'`);
    await seed(u, 'promo_code', 9);
    const got = await claim({ only: u });
    expect(got[0]).toMatchObject({ country: 'IN', entitlement_source: 'promo_code', threshold_days: 30, attempt: 1 });
    expect(Object.keys(got[0]).sort()).toEqual(['attempt', 'country', 'email', 'ends_on', 'entitlement_source', 'ledger_id', 'threshold_days', 'user_id']);
  });
});

describe('failures are recorded and retried within a bounded budget without double-sending', () => {
  async function assertRetryNoDup(): Promise<void> {
    const u = await newUser('retry');
    await seed(u, 'admin_grant', 10);
    const first = await claim({ only: u });
    expect(await record(first[0].ledger_id, false, null, 'resend_http_500')).toBe(true);
    let rows = await ledger(u);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'resend_http_500' });
    expect(await claim({ only: u }), 'a failed send is not retried before its delay').toEqual([]);
    await db.exec(`update premium_expiry_email_ledger set next_attempt_at = now() - interval '1 minute' where user_id='${u}'`);
    const retry = await claim({ only: u });
    expect(retry, 'retried once the delay has passed').toHaveLength(1);
    expect(retry[0].ledger_id, 'the SAME ledger row is retried, not a new one').toBe(first[0].ledger_id);
    expect(retry[0].attempt).toBe(2);
    expect(await record(retry[0].ledger_id, true, 'msg_ok')).toBe(true);
    rows = await ledger(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', provider_message_id: 'msg_ok' });
    expect(await claim({ only: u }), 'nothing more after success').toEqual([]);
    // a late or duplicate record call can never flip a sent row
    expect(await record(first[0].ledger_id, false, null, 'late failure'), 'a settled row cannot be settled again').toBe(false);
    expect((await ledger(u))[0].status, 'a sent row stays sent').toBe('sent');
  }
  it('failed -> delayed retry (same row, attempt 2) -> sent; one row; a late failure cannot flip a sent row', async () => {
    await assertRetryNoDup();
  });
  it('NEGATIVE CONTROL — if record() could settle any row a late failure would un-send a sent reminder (assertion "a settled row cannot be settled again" goes red)', async () => {
    await withMutation(RECORD_FN, (s) => s.replace("if not found or v_row.status <> 'pending' then return false; end if;", 'if not found then return false; end if;'), async () => {
      await expectAssertionFails(assertRetryNoDup, 'a settled row cannot be settled again');
    });
  });

  it('the retry budget is bounded: after 3 failed attempts the row is "abandoned" and never claimed again', async () => {
    const u = await newUser('budget');
    await seed(u, 'admin_grant', 10);
    for (let i = 1; i <= 3; i += 1) {
      await db.exec(`update premium_expiry_email_ledger set next_attempt_at = now() - interval '1 minute' where user_id='${u}'`);
      const got = await claim({ only: u });
      expect(got, `attempt ${i}`).toHaveLength(1);
      expect(got[0].attempt).toBe(i);
      await record(got[0].ledger_id, false, null, 'resend_http_503');
    }
    expect((await ledger(u))[0]).toMatchObject({ status: 'abandoned', attempts: 3 });
    await db.exec(`update premium_expiry_email_ledger set next_attempt_at = now() - interval '1 day' where user_id='${u}'`);
    expect(await claim({ only: u })).toEqual([]);
  });

  it('a failed reminder is VOIDED, not retried, if the user has meanwhile started paying or the end date changed', async () => {
    const paid = await newUser('void');
    await seed(paid, 'admin_grant', 10);
    const a = await claim({ only: paid });
    await record(a[0].ledger_id, false, null, 'resend_http_500');
    await db.exec(`update user_entitlements set entitlement_source='payment', effective_to=null where user_id='${paid}'`); // payment took over
    await db.exec(`update premium_expiry_email_ledger set next_attempt_at = now() - interval '1 minute' where user_id='${paid}'`);
    expect(await claim({ only: paid })).toEqual([]);
    expect((await ledger(paid))[0].status).toBe('void');
  });

  it('errors are stored short and without any address or body (<= 200 chars)', async () => {
    const u = await newUser('err');
    await seed(u, 'admin_grant', 10);
    const a = await claim({ only: u });
    await record(a[0].ledger_id, false, null, 'x'.repeat(500));
    expect(String((await ledger(u))[0].last_error)).toHaveLength(200);
  });
});

describe('scheduling guard — a DEV database never schedules a call to the production origin', () => {
  async function jobs(): Promise<{ jobname: string; schedule: string; command: string }[]> {
    return (await db.query(`select jobname, schedule, command from cron.job where jobname='premium-expiry-email-reminders'`)).rows as { jobname: string; schedule: string; command: string }[];
  }

  async function assertDevSchedulesNothing(block: string): Promise<void> {
    await db.exec(`delete from cron.job where jobname='premium-expiry-email-reminders'; delete from platform_deployment_environment;`);
    await db.exec(block);
    expect(await jobs(), 'DEV (no production marker row) must register no cron job').toEqual([]);
  }

  it('without the production marker row the migration registers NOTHING (DEV, fresh environment)', async () => {
    await assertDevSchedulesNothing(SCHEDULE_BLOCK);
  });

  it('with the production marker row it registers exactly one hourly job at the production URL, authenticated by the vault secret; re-running is idempotent', async () => {
    await db.exec(`delete from cron.job where jobname='premium-expiry-email-reminders'; insert into platform_deployment_environment(environment) values ('production') on conflict do nothing;`);
    await db.exec(SCHEDULE_BLOCK);
    await db.exec(SCHEDULE_BLOCK);
    const j = await jobs();
    expect(j).toHaveLength(1);
    expect(j[0].schedule).toBe('17 * * * *');
    expect(j[0].command).toContain('https://app.financialhealthplatform.com/api/premium/cron/expiry-reminders');
    expect(j[0].command).toContain("name = 'premium_reminder_cron_secret'");
    expect(j[0].command).toContain('x-cron-secret');
    await db.exec(`delete from platform_deployment_environment; delete from cron.job where jobname='premium-expiry-email-reminders'`);
  });

  it('NEGATIVE CONTROL — a schedule block without the marker check would register the production URL on DEV (assertion "DEV (no production marker row) must register no cron job" goes red)', async () => {
    const unguarded = SCHEDULE_BLOCK.replace(/if not exists \(select 1 from public\.platform_deployment_environment[\s\S]*?end if;/, '');
    expect(unguarded).not.toBe(SCHEDULE_BLOCK);
    await expectAssertionFails(() => assertDevSchedulesNothing(unguarded), 'DEV (no production marker row) must register no cron job');
    await db.exec(`delete from cron.job where jobname='premium-expiry-email-reminders'`);
  });
});
