/**
 * Document2 (4) WP-G -- migrations 0310 / 0311 on a REAL Postgres engine (PGlite, this repository's full migration chain).
 *
 * What is proven (PGLITE-VERIFIED; nothing here is DEV- or production-verified):
 *   - the lease claim has exactly ONE winner, a lease that ran out is taken over (and counted), a finished job is never claimed;
 *   - only the holder can extend a lease; a browser role cannot call any of the three functions;
 *   - one job per statement, one job per (user, idempotency key);
 *   - tenancy: a user reads only their own jobs, cannot write a job, cannot read staging at all, and a job cannot point at
 *     another user's statement (two real users);
 *   - 0311: a statement can never hold two lines with the same source row number (manual lines with no number are unaffected).
 *
 * NEGATIVE CONTROLS. Each guard is removed in turn (the function / trigger is replaced by a copy without that rule) and the SAME
 * assertion must go red; the original is restored afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildDb, MIG_DIR } from './support/fdh10LedgerPgliteHarness';
import type { PGlite } from '@electric-sql/pglite';

const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const M0310 = fs.readFileSync(path.join(MIG_DIR, '0310_fdh_bank_import_jobs.sql'), 'utf8');

let db: PGlite;
let doc1: string;
let doc2: string;

async function seedUser(id: string) {
  await db.exec(`reset role;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.query(`insert into auth.users(id, email) values ($1, $2) on conflict do nothing`, [id, `${id}@t.test`]);
  await db.query(
    `update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`,
    [id],
  );
}
async function seedDoc(userId: string): Promise<string> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  const r = await db.query<{ id: string }>(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status)
     values ($1, 'csv', 'bank_statement', 'AU', 'AUD', 'text/csv', 'queued') returning id`,
    [userId],
  );
  return r.rows[0].id;
}
async function newJob(userId: string, docId: string, key = `doc:${docId}`): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into fdh_bank_import_jobs (user_id, statement_upload_id, source_kind, idempotency_key) values ($1,$2,'csv',$3) returning id`,
    [userId, docId, key],
  );
  return r.rows[0].id;
}
async function as<T>(uid: string | null, role: 'authenticated' | 'service_role' | 'anon', fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const claim = (jobId: string, owner: string, secs = 90) =>
  as(null, 'service_role', async () => (await db.query<{ id: string; lease_owner: string; reclaim_count: number; slice_count: number; status: string }>(
    `select * from fdh_bank_import_claim_job($1,$2,$3)`, [jobId, owner, secs])).rows);
async function expireLease(jobId: string) {
  await db.query(`update fdh_bank_import_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [jobId]);
}
async function rejects(p: Promise<unknown>, re: RegExp) {
  let msg = '';
  try {
    await p;
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg, `expected a rejection matching ${re}`).toMatch(re);
}
async function withMutation<T>(original: string, mutate: (s: string) => string, fn: () => Promise<T>): Promise<T> {
  const mutated = mutate(original);
  expect(mutated, 'the negative-control mutation must actually change the SQL').not.toBe(original);
  await db.exec(mutated);
  try {
    return await fn();
  } finally {
    await db.exec(original);
  }
}
function fnSql(name: string): string {
  const re = new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$(?: language [a-z]+(?: security definer)?(?: set search_path = public)?)?;`);
  const m = M0310.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}

beforeAll(async () => {
  db = await buildDb();
  await seedUser(U1);
  await seedUser(U2);
  doc1 = await seedDoc(U1);
  doc2 = await seedDoc(U2);
}, 600_000);
afterAll(async () => {
  await db?.close();
});

describe('0310 lease claim', () => {
  it('exactly ONE of two claimants wins; the loser gets nothing', async () => {
    const job = await newJob(U1, doc1);
    const a = await claim(job, 'owner-aaaaaaaa');
    const b = await claim(job, 'owner-bbbbbbbb');
    expect(a).toHaveLength(1);
    expect(a[0].lease_owner).toBe('owner-aaaaaaaa');
    expect(a[0].status).toBe('processing');
    expect(b).toHaveLength(0);
  });

  it('a lease that ran out is taken over, the take-over is counted, and the old holder cannot extend', async () => {
    const [{ id: job }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where statement_upload_id = $1`, [doc1])).rows;
    await expireLease(job);
    const taken = await claim(job, 'owner-cccccccc');
    expect(taken).toHaveLength(1);
    expect(taken[0].lease_owner).toBe('owner-cccccccc');
    expect(taken[0].reclaim_count).toBe(1);
    expect(taken[0].slice_count).toBe(2);
    const stale = await as(null, 'service_role', async () => (await db.query<{ ok: boolean }>(`select fdh_bank_import_heartbeat($1,$2,90) ok`, [job, 'owner-aaaaaaaa'])).rows[0].ok);
    const holder = await as(null, 'service_role', async () => (await db.query<{ ok: boolean }>(`select fdh_bank_import_heartbeat($1,$2,90) ok`, [job, 'owner-cccccccc'])).rows[0].ok);
    expect(stale).toBe(false);
    expect(holder).toBe(true);
  });

  it('a finished job (completed / failed / review_required) is never claimed', async () => {
    const [{ id: job }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where statement_upload_id = $1`, [doc1])).rows;
    for (const status of ['completed', 'failed']) {
      await db.query(`update fdh_bank_import_jobs set status = $2, lease_expires_at = now() - interval '1 minute' where id = $1`, [job, status]);
      expect(await claim(job, `owner-${status}-xx`)).toHaveLength(0);
    }
    await db.query(`update fdh_bank_import_jobs set status = 'review_required', review_reason = 'ai_draft', lease_expires_at = null where id = $1`, [job]);
    expect(await claim(job, 'owner-review-xx')).toHaveLength(0);
    await db.query(`update fdh_bank_import_jobs set status = 'queued', review_reason = null, lease_owner = null, lease_expires_at = null where id = $1`, [job]);
  });

  it('claim_next returns the unfinished job whose lease ran out, and nothing while every lease is live', async () => {
    const [{ id: job }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where statement_upload_id = $1`, [doc1])).rows;
    const first = await as(null, 'service_role', async () => (await db.query<{ id: string }>(`select * from fdh_bank_import_claim_next('owner-next-0001', 90)`)).rows);
    expect(first.map((r) => r.id)).toEqual([job]);
    const none = await as(null, 'service_role', async () => (await db.query<{ id: string }>(`select * from fdh_bank_import_claim_next('owner-next-0002', 90)`)).rows);
    expect(none).toHaveLength(0);
    await expireLease(job);
    const again = await as(null, 'service_role', async () => (await db.query<{ id: string }>(`select * from fdh_bank_import_claim_next('owner-next-0003', 90)`)).rows);
    expect(again.map((r) => r.id)).toEqual([job]);
  });

  it('a browser role cannot call any lease function', async () => {
    const [{ id: job }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where statement_upload_id = $1`, [doc1])).rows;
    await rejects(as(U1, 'authenticated', () => db.query(`select * from fdh_bank_import_claim_job($1,'owner-browser-1',90)`, [job])), /permission denied/i);
    await rejects(as(U1, 'authenticated', () => db.query(`select * from fdh_bank_import_claim_next('owner-browser-1',90)`)), /permission denied/i);
    await rejects(as(U1, 'authenticated', () => db.query(`select fdh_bank_import_heartbeat($1,'owner-browser-1',90)`, [job])), /permission denied/i);
    await rejects(as(null, 'anon', () => db.query(`select * from fdh_bank_import_claim_job($1,'owner-anon-0001',90)`, [job])), /permission denied/i);
  });

  it('NEGATIVE CONTROL: with the lease condition removed two claimants both "win" (the single-winner assertion goes red)', async () => {
    const job = await newJob(U2, doc2, 'nc-claim');
    await claim(job, 'owner-first-0001');
    await withMutation(
      fnSql('fdh_bank_import_claim_job'),
      (s) => s.replace("and (j.lease_expires_at is null or j.lease_expires_at < now())", ''),
      async () => {
        const second = await claim(job, 'owner-second-002');
        // The real function returns nothing for the second claimant; the broken one hands the job out again.
        expect(second).toHaveLength(1);
      },
    );
    // restored: the guard holds again
    expect(await claim(job, 'owner-third-0003')).toHaveLength(0);
    await db.query(`delete from fdh_bank_import_jobs where id = $1`, [job]);
  });
});

describe('0310 idempotent admission (database rules)', () => {
  it('a second job for the same statement is refused', async () => {
    await rejects(newJob(U1, doc1, 'another-key'), /uq_fdh_bank_import_jobs_document|duplicate key/i);
  });
  it('the same idempotency key cannot be used twice by one user', async () => {
    const extra = await seedDoc(U1);
    await newJob(U1, extra, 'shared-key');
    const extra2 = await seedDoc(U1);
    await rejects(newJob(U1, extra2, 'shared-key'), /uq_fdh_bank_import_jobs_idempotency|duplicate key/i);
  });
});

describe('0310 tenancy (two real users)', () => {
  it('a user reads only their own jobs', async () => {
    const mine = await as(U1, 'authenticated', async () => (await db.query<{ user_id: string }>(`select user_id from fdh_bank_import_jobs`)).rows);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.user_id === U1)).toBe(true);
    const theirs = await as(U2, 'authenticated', async () => (await db.query<{ user_id: string }>(`select user_id from fdh_bank_import_jobs`)).rows);
    expect(theirs.every((r) => r.user_id === U2)).toBe(true);
    const [{ id: job1 }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where user_id = $1 limit 1`, [U1])).rows;
    const cross = await as(U2, 'authenticated', async () => (await db.query(`select * from fdh_bank_import_jobs where id = $1`, [job1])).rows);
    expect(cross).toHaveLength(0);
  });

  it('a browser role cannot create, change or delete a job', async () => {
    const [{ id: job1 }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where user_id = $1 limit 1`, [U1])).rows;
    const doc = await seedDoc(U1);
    await rejects(
      as(U1, 'authenticated', () => db.query(`insert into fdh_bank_import_jobs (user_id, statement_upload_id, source_kind, idempotency_key) values ($1,$2,'csv','browser-made')`, [U1, doc])),
      /row-level security/i,
    );
    const upd = await as(U1, 'authenticated', () => db.query(`update fdh_bank_import_jobs set status = 'completed', lease_owner = 'owner-browser-1' where id = $1 returning id`, [job1]));
    expect(upd.rows).toHaveLength(0); // no UPDATE policy: zero rows touched
    const del = await as(U1, 'authenticated', () => db.query(`delete from fdh_bank_import_jobs where id = $1 returning id`, [job1]));
    expect(del.rows).toHaveLength(0);
    const still = (await db.query<{ status: string }>(`select status from fdh_bank_import_jobs where id = $1`, [job1])).rows[0];
    expect(still.status).not.toBe('completed');
  });

  it('staging is invisible to every browser role, including the owner', async () => {
    const [{ id: job1 }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where user_id = $1 limit 1`, [U1])).rows;
    await db.query(`insert into fdh_bank_import_job_chunks (job_id, user_id, kind, seq, payload) values ($1,$2,'plan_rows',0,'{"rows":[]}')`, [job1, U1]);
    const seen = await as(U1, 'authenticated', async () => (await db.query(`select * from fdh_bank_import_job_chunks`)).rows);
    expect(seen).toHaveLength(0);
    await rejects(
      as(U1, 'authenticated', () => db.query(`insert into fdh_bank_import_job_chunks (job_id, user_id, kind, seq, payload) values ($1,$2,'plan_rows',1,'{}')`, [job1, U1])),
      /row-level security/i,
    );
    const asService = await as(null, 'service_role', async () => (await db.query(`select * from fdh_bank_import_job_chunks where job_id = $1`, [job1])).rows);
    expect(asService).toHaveLength(1);
  });

  it('a job cannot point at another user\'s statement, and a chunk cannot be attached to another user\'s job', async () => {
    await rejects(newJob(U1, doc2, 'cross-tenant'), /cross-tenant reference/i);
    const [{ id: job1 }] = (await db.query<{ id: string }>(`select id from fdh_bank_import_jobs where user_id = $1 limit 1`, [U1])).rows;
    await rejects(
      db.query(`insert into fdh_bank_import_job_chunks (job_id, user_id, kind, seq, payload) values ($1,$2,'plan_rows',9,'{}')`, [job1, U2]),
      /does not belong to the job/i,
    );
  });

  it('NEGATIVE CONTROL: with the ownership trigger removed the cross-tenant job IS accepted (the assertion goes red)', async () => {
    await db.exec(`drop trigger trg_fdh_bank_import_jobs_owner on fdh_bank_import_jobs;`);
    let id: string | null = null;
    try {
      id = await newJob(U1, doc2, 'cross-tenant-nc');
      expect(id).toBeTruthy(); // the real trigger would have refused this (previous test)
    } finally {
      if (id) await db.query(`delete from fdh_bank_import_jobs where id = $1`, [id]);
      await db.exec(`create trigger trg_fdh_bank_import_jobs_owner before insert or update of user_id, statement_upload_id on fdh_bank_import_jobs for each row execute function fdh_bank_import_assert_job_owner();`);
    }
    await rejects(newJob(U1, doc2, 'cross-tenant-again'), /cross-tenant reference/i);
  });
});

describe('0311 exactly-once lines per statement', () => {
  async function line(docId: string, userId: string, sourceRow: number | null) {
    const acc = (await db.query<{ id: string }>(
      `select id from fdh_financial_accounts where user_id = $1 limit 1`, [userId])).rows[0]
      ?? (await db.query<{ id: string }>(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','A') returning id`, [userId])).rows[0];
    await db.query(
      `insert into fdh_transactions (user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, description_raw, source_row)
       values ($1,$2,$3,'2026-08-01',10,'AUD','debit','x',$4)`,
      [userId, acc.id, docId, sourceRow],
    );
  }
  it('two lines with the same source row on one statement are refused', async () => {
    await as(null, 'service_role', () => line(doc1, U1, 1));
    await rejects(as(null, 'service_role', () => line(doc1, U1, 1)), /uq_fdh_transactions_statement_source_row|duplicate key/i);
    await as(null, 'service_role', () => line(doc1, U1, 2)); // a different row number is fine
  });
  it('lines with no row number (manual entries) never conflict', async () => {
    await as(null, 'service_role', () => line(doc1, U1, null));
    await as(null, 'service_role', () => line(doc1, U1, null));
  });
  it('the same row number on a DIFFERENT statement is fine', async () => {
    await as(null, 'service_role', () => line(doc2, U2, 1));
  });
});
