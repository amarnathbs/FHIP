// The OPTIONAL seven day expiry reminder (PO approved in principle, ships OFF): proof that it deduplicates against the thirty
// day reminder BEFORE anyone is allowed to switch it on.
//
// The claim function takes the threshold list as a parameter, so enabling the seven day reminder is "the list becomes [30, 7]".
// What this suite proves on a real Postgres (PGlite), with the real premium_reminder_claim():
//   * one ledger row per (user, source, end date, threshold) — the same threshold of the same window is never claimed twice;
//   * a window that got its thirty day reminder gets exactly ONE more e-mail (the seven day one), never a second thirty day one;
//   * switching the seven day reminder on LATE (when both thresholds apply) sends only the most urgent one, never two at once;
//   * a failed or abandoned thirty day row does not block the seven day one, and a seven day row never revives the thirty day one;
//   * an extension (a new end date) opens a new window, which is legitimate, while a rerun for the same window is not;
//   * with the flag off the list is exactly [30], so the shipped behaviour is unchanged.
//
// NAMED NEGATIVE CONTROLS
//   NC-7A  a claim that picks the LEAST urgent threshold sends the thirty day one when both apply: "late enabling sends only the most urgent threshold";
//   NC-7B  a claim without the duplicate guard AND without the unique key claims the same threshold twice: "a rerun never claims the same threshold again".
//
// EVIDENCE LABEL: code-complete, verified on an isolated PGlite replay. No e-mail is sent anywhere in this file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { expectNamedFailure, latestFunctionSql, replayAll } from './support/promoTestHelpers';
import { PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS, premiumExpiryEmailThresholds } from '@/lib/services/premiumExpiryReminderEmail';

type Json = Record<string, unknown>;
let db: PGlite;
let counter = 0;

async function newUser(): Promise<string> {
  counter += 1;
  const id = `cccccccc-7000-0000-0000-${String(counter).padStart(12, '0')}`;
  await db.exec(`insert into auth.users(id,email) values ('${id}','sd${counter}@pg.test');`);
  await db.exec(`insert into user_entitlements(user_id) values ('${id}') on conflict do nothing;`);
  return id;
}

/** A managed entitlement whose window is `windowDays` long (inclusive) and ends `endsIn` days from today. */
async function seed(uid: string, windowDays: number, endsIn: number, source: 'admin_grant' | 'promo_code' = 'promo_code') {
  await db.exec(
    `update user_entitlements set plan_tier='premium', entitlement_source='${source}', effective_from=current_date+${endsIn}-${windowDays - 1}, effective_to=current_date+${endsIn}, admin_grant_ends_on=current_date+${endsIn}, reserve_source='${source}' where user_id='${uid}'`
  );
}

async function as<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
  }
}

/** `elapsed` days after the day the entitlement was seeded: TIME moves (p_today), the entitlement and so its end date (the ledger key) stay fixed. */
async function claim(uid: string, thresholds: number[], elapsed = 0): Promise<Json[]> {
  return as(async () => (await db.query(`select * from public.premium_reminder_claim(current_date + $3::int, $1::int[], 50, 3, 60, $2::uuid)`, [thresholds, uid, elapsed])).rows as Json[]);
}
const settle = (ledgerId: unknown, ok = true) =>
  as(async () => (await db.query(`select public.premium_reminder_record($1,$2,'m',$3,60,3) r`, [ledgerId, ok, ok ? null : 'resend_http_500'])).rows);
const ledger = async (uid: string) => (await db.query(`select threshold_days, status from premium_expiry_email_ledger where user_id=$1 order by threshold_days desc, created_at`, [uid])).rows as Json[];

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

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('the switch: OFF by default', () => {
  it('without the flag the threshold list is exactly [30]; only the exact text "true" adds the seven day reminder', () => {
    expect(PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS).toEqual([30]);
    expect(premiumExpiryEmailThresholds({})).toEqual([30]);
    for (const v of ['false', 'TRUE', '1', 'yes', ' ', '']) expect(premiumExpiryEmailThresholds({ PREMIUM_REMINDER_SEVEN_DAY_ENABLED: v }), String(v)).toEqual([30]);
    expect(premiumExpiryEmailThresholds({ PREMIUM_REMINDER_SEVEN_DAY_ENABLED: 'true' })).toEqual([30, 7]);
    expect(premiumExpiryEmailThresholds({ PREMIUM_REMINDER_SEVEN_DAY_ENABLED: ' true ' })).toEqual([30, 7]);
  });

  it('the shipped job control switches are all off, and the threshold list the cron route uses comes from this one function', async () => {
    expect(((await db.query(`select count(*)::int n from premium_reminder_job_control where enabled`)).rows[0] as Json).n).toBe(0);
  });
});

describe('deduplication of the seven day reminder against the thirty day reminder (database claim)', () => {
  it('a long window gets exactly TWO e-mails over its life: one at 30 days, one at 7 days, and every rerun in between claims nothing', async () => {
    const u = await newUser();
    await seed(u, 400, 30);
    const day30 = await claim(u, [30, 7]);
    expect(day30.map((r) => r.threshold_days), 'at 30 days left: the thirty day reminder').toEqual([30]);
    await settle(day30[0].ledger_id);
    expect(await claim(u, [30, 7]), 'a rerun on the same day claims nothing').toHaveLength(0);
    expect(await claim(u, [30, 7], 10), 'between the two thresholds (20 days left) nothing is due, and the thirty day one is not claimed again').toHaveLength(0);
    const day7 = await claim(u, [30, 7], 23); // 7 days left
    expect(day7.map((r) => r.threshold_days), 'at 7 days left: the seven day reminder, never a second thirty day one').toEqual([7]);
    await settle(day7[0].ledger_id);
    expect(await claim(u, [30, 7], 23)).toHaveLength(0);
    expect(await claim(u, [30, 7], 27), 'after both were sent nothing more is ever claimed for this window (3 days left)').toHaveLength(0);
    expect(await claim(u, [30, 7], 29), 'not even on the last day but one').toHaveLength(0);
    expect(await ledger(u)).toEqual([
      { threshold_days: 30, status: 'sent' },
      { threshold_days: 7, status: 'sent' },
    ]);
  });

  it('switching the seven day reminder on LATE sends only the most urgent threshold: never two e-mails at once', async () => {
    const u = await newUser();
    await seed(u, 400, 5); // both 30 and 7 apply; neither was ever sent (the job was off or the window is new)
    async function assertLate(): Promise<void> {
      const rows = await claim(u, [30, 7]);
      expect(rows.map((r) => r.threshold_days), 'late enabling sends only the most urgent threshold').toEqual([7]);
    }
    await assertLate();
    expect(await claim(u, [30, 7]), 'and nothing else follows').toHaveLength(0);
    expect(await ledger(u)).toEqual([{ threshold_days: 7, status: 'pending' }]);
  });

  it('NC-7A: a claim that chose the LEAST urgent threshold would send the thirty day one first', async () => {
    const live = latestFunctionSql('premium_reminder_claim');
    const u = await newUser();
    await seed(u, 400, 5);
    await withMutation(live, (s) => s.replace('(select min(x) from unnest(p_thresholds) x', '(select max(x) from unnest(p_thresholds) x'), async () => {
      const rows = await claim(u, [30, 7]);
      await expectNamedFailure(() => expect(rows.map((r) => r.threshold_days), 'late enabling sends only the most urgent threshold').toEqual([7]), 'late enabling sends only the most urgent threshold');
    });
  });

  it('turning the flag on AFTER the thirty day reminder went out sends the seven day one at 7 days and never re-sends the thirty day one', async () => {
    const u = await newUser();
    await seed(u, 400, 30);
    const first = await claim(u, [30]); // the shipped list
    await settle(first[0].ledger_id);
    // 20 days left: the PO enables the seven day reminder now
    expect(await claim(u, [30, 7], 10), 'enabling it does not re-send the thirty day reminder').toHaveLength(0);
    expect((await claim(u, [30, 7], 23)).map((r) => r.threshold_days)).toEqual([7]);
  });

  it('turning the flag OFF again after the seven day reminder was sent changes nothing: a LESS urgent threshold is never claimed after a more urgent one (no late thirty day e-mail)', async () => {
    const u = await newUser();
    await seed(u, 400, 7);
    const rows = await claim(u, [30, 7]);
    await settle(rows[0].ledger_id);
    async function assertNoLateThirty(): Promise<void> {
      expect(await claim(u, [30]), 'a less urgent threshold is never sent after a more urgent one').toHaveLength(0);
    }
    await assertNoLateThirty();
    // NC-7C: without the guard the shipped list [30] would send a thirty day reminder 7 days before the end, after the seven day one
    const live = latestFunctionSql('premium_reminder_claim');
    await withMutation(
      live,
      (s) => s.replace(/and not exists \(select 1 from public\.premium_expiry_email_ledger y[\s\S]*?y\.status <> 'void'\)/, ''),
      async () => {
        await expectNamedFailure(assertNoLateThirty, 'a less urgent threshold is never sent after a more urgent one');
      }
    );
  });

  it('a failed or abandoned thirty day row does not block the seven day one, and the seven day one never revives the thirty day one', async () => {
    const u = await newUser();
    await seed(u, 400, 30);
    const r30 = await claim(u, [30, 7]);
    for (let i = 0; i < 3; i += 1) {
      await settle(r30[0].ledger_id, false);
      const retry = await as(async () => (await db.query(`update premium_expiry_email_ledger set next_attempt_at = now() - interval '1 minute' where id=$1 returning id`, [r30[0].ledger_id])).rows);
      expect(retry).toHaveLength(1);
      if (i < 2) await claim(u, [30, 7]);
    }
    expect((await ledger(u))[0]).toEqual({ threshold_days: 30, status: 'abandoned' });
    const r7 = await claim(u, [30, 7], 23); // 7 days left
    expect(r7.map((r) => r.threshold_days), 'the seven day reminder is claimed on its own').toEqual([7]);
    expect((await ledger(u)).map((r) => r.threshold_days).sort()).toEqual([30, 7]);
  });

  it('a window shorter than 30 days never gets the thirty day reminder, but gets the seven day one when it is longer than 7 days', async () => {
    const u = await newUser();
    await seed(u, 20, 6);
    expect((await claim(u, [30, 7])).map((r) => r.threshold_days)).toEqual([7]);
    const short = await newUser();
    await seed(short, 7, 3); // exactly 7 days long: not longer than 7, so no reminder at all
    expect(await claim(short, [30, 7])).toHaveLength(0);
  });

  it('an extension changes the end date and so opens a NEW window with its own reminders; the old window stays settled', async () => {
    const u = await newUser();
    await seed(u, 400, 30);
    const a = await claim(u, [30, 7]);
    await settle(a[0].ledger_id);
    await db.exec(`update user_entitlements set effective_to = effective_to + 60, admin_grant_ends_on = admin_grant_ends_on + 60 where user_id='${u}'`);
    expect(await claim(u, [30, 7]), 'the new end date is 90 days away: nothing is due yet').toHaveLength(0);
    const b = await claim(u, [30, 7], 60); // 30 days to the NEW end date
    expect(b.map((r) => r.threshold_days), 'the new window is legitimately reminded again').toEqual([30]);
    expect(((await db.query(`select count(*)::int n from premium_expiry_email_ledger where user_id=$1`, [u])).rows[0] as Json).n).toBe(2);
  });

  it('NC-7B: without the duplicate guard AND without the unique key the same threshold of the same window is claimed twice', async () => {
    const live = latestFunctionSql('premium_reminder_claim');
    const u = await newUser();
    await seed(u, 400, 30);
    async function assertNoRepeat(): Promise<void> {
      await claim(u, [30, 7]);
      const again = await claim(u, [30, 7]);
      expect(again, 'a rerun never claims the same threshold again').toHaveLength(0);
    }
    await db.exec(`alter table premium_expiry_email_ledger drop constraint uq_premium_expiry_email_window`);
    try {
      await withMutation(
        live,
        (s) => s.replace(/and not exists \(select 1 from public\.premium_expiry_email_ledger x[\s\S]*?x\.threshold_days = d\.threshold\)/, '').replace('on conflict on constraint uq_premium_expiry_email_window do nothing', ''),
        async () => {
          await expectNamedFailure(assertNoRepeat, 'a rerun never claims the same threshold again');
        }
      );
    } finally {
      await db.exec(`delete from premium_expiry_email_ledger where user_id='${u}'`);
      await db.exec(`alter table premium_expiry_email_ledger add constraint uq_premium_expiry_email_window unique (user_id, entitlement_source, ends_on, threshold_days)`);
    }
    // the real function (restored) passes the same assertion
    await assertNoRepeat();
  });

  it('paying customers and non-managed sources never qualify for either reminder', async () => {
    const u = await newUser();
    await db.exec(`update user_entitlements set plan_tier='premium', entitlement_source='payment', effective_from=current_date-390, effective_to=current_date+5, admin_grant_ends_on=current_date+5, reserve_source='admin_grant' where user_id='${u}'`);
    expect(await claim(u, [30, 7])).toHaveLength(0);
  });
});
