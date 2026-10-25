/**
 * Document2 (4) WP-J -- migrations 0312 and 0313 on a REAL Postgres engine (PGlite, this repository's full migration chain).
 *
 * 0312 (columns only):
 *   - applying it where 0159 already added the three counters changes nothing (exactly idempotent), and twice is the same as once,
 *   - applying it where the columns are ABSENT adds exactly the three int not null default 0 columns, and existing rows read zero,
 *   - its effect is identical to the statement the Product Owner applied by hand on production (compared column by column),
 *   - it touches no constraint (the discrepancy-type CHECK of ii_reconciliation_cases is byte-identical before and after).
 * 0313 (statement jobs): one claim winner, take-over counted, finished jobs never claimed, only the holder extends a lease, one active job
 *   per statement, one job per (user, key), the staging kinds, the cross-tenant guards; every guard has a NEGATIVE CONTROL (the guard is
 *   removed and the same assertion goes red).
 * Both files obey the SQL editor rules (the Product Owner pastes migrations by hand).
 *
 * Evidence label: PGLITE-VERIFIED (a real Postgres engine; NOT DEV-verified, NOT production-verified).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb, MIG_DIR } from './support/fdh10LedgerPgliteHarness';
import { hazards } from './support/sqlEditorHazards';

const M0312 = fs.readFileSync(path.join(MIG_DIR, '0312_ii_document_parse_runs_counters.sql'), 'utf8');
const M0313 = fs.readFileSync(path.join(MIG_DIR, '0313_ii_statement_jobs.sql'), 'utf8');
/** The statement the Product Owner applied by hand on production on 22-10-2026 (docs/reviews/po_apply_parse_run_counters/02), verbatim. */
const PO_HAND_APPLIED = `
alter table ii_document_parse_runs add column if not exists duplicate_transactions_linked int not null default 0;
alter table ii_document_parse_runs add column if not exists new_transactions_count int not null default 0;
alter table ii_document_parse_runs add column if not exists missing_transactions_count int not null default 0;
`;

const U1 = '00000000-0000-4000-8000-0000000000c1';
const U2 = '00000000-0000-4000-8000-0000000000c2';
const COLS = ['duplicate_transactions_linked', 'new_transactions_count', 'missing_transactions_count'];

async function columnShape(db: PGlite) {
  return (
    await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'ii_document_parse_runs' and column_name = any($1) order by column_name`,
      [COLS],
    )
  ).rows;
}
const checkDef = async (db: PGlite) =>
  (await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ii_reconciliation_cases_discrepancy_type_check'`)).rows[0]?.def;

describe('0312: the parse-run counter columns, columns only', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await buildDb();
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('obeys the SQL editor rules', () => {
    expect(hazards(M0312)).toEqual([]);
    expect(hazards(M0313)).toEqual([]);
  });

  it('where the columns already exist (0159 or the manual statement ran): applying 0312 once or twice changes nothing', async () => {
    const before = await columnShape(db);
    expect(before.map((c) => c.column_name)).toEqual([...COLS].sort());
    const check = await checkDef(db);
    await db.exec(M0312);
    await db.exec(M0312);
    expect(await columnShape(db)).toEqual(before);
    expect(await checkDef(db), 'no constraint is touched').toBe(check);
  });

  it('where the columns are absent: adds exactly the three int not null default 0 columns; existing rows read zero; same shape as the manual statement', async () => {
    // a run row that exists before the columns do
    await db.query(`insert into auth.users (id, email) values ($1, 'wpj-run@example.test') on conflict do nothing`, [U1]);
    await db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [U1]);
    const doc = (
      await db.query<{ id: string }>(
        `insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
         values ($1, 'IN', 'uploaded', 'x/y.pdf', 'y.pdf', 'application/pdf', 1, 'abc', 'cas_statement') returning id`,
        [U1],
      )
    ).rows[0].id;
    await db.query(`insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, idempotency_key) values ($1, $2, 'p', 'v', 'failed', 'k-0312')`, [U1, doc]);
    const shapeWithColumns = await columnShape(db);

    for (const c of COLS) await db.exec(`alter table ii_document_parse_runs drop column ${c};`);
    expect(await columnShape(db)).toEqual([]);
    await db.exec(M0312);
    const after0312 = await columnShape(db);
    expect(after0312).toEqual(shapeWithColumns);
    for (const c of after0312) {
      expect(c.data_type).toBe('integer');
      expect(c.is_nullable).toBe('NO');
      expect(c.column_default).toBe('0');
    }
    const row = (await db.query<Record<string, number>>(`select ${COLS.join(', ')} from ii_document_parse_runs where idempotency_key = 'k-0312'`)).rows[0];
    expect(row).toEqual({ duplicate_transactions_linked: 0, new_transactions_count: 0, missing_transactions_count: 0 });

    // identical in effect to the statement applied by hand
    for (const c of COLS) await db.exec(`alter table ii_document_parse_runs drop column ${c};`);
    await db.exec(PO_HAND_APPLIED);
    expect(await columnShape(db)).toEqual(after0312);
  });

  it('negative control: a copy of 0312 that also rewrote the discrepancy-type constraint (as 0159 does) WOULD change it; 0312 does not touch it', async () => {
    expect(M0312.split(String.fromCharCode(10)).filter((l) => !l.startsWith('--')).join(' '), 'no statement of 0312 touches a constraint').not.toMatch(/constraint/i);
    const check = await checkDef(db);
    await db.exec('alter table ii_reconciliation_cases drop constraint ii_reconciliation_cases_discrepancy_type_check;');
    await db.exec(`alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in ('other'));`);
    expect(await checkDef(db), 'the control rewrite is visible').not.toBe(check);
    await db.exec('alter table ii_reconciliation_cases drop constraint ii_reconciliation_cases_discrepancy_type_check;');
    await db.exec(`alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check ${check};`);
    expect(await checkDef(db)).toBe(check);
  });
});

describe('0313: the statement job tables and lease functions', () => {
  let db: PGlite;
  let docA: string;

  async function seedUser(id: string) {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
    await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, `${id}@t.test`]);
    await db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [id]);
  }
  async function seedDoc(userId: string): Promise<string> {
    return (
      await db.query<{ id: string }>(
        `insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
         values ($1, 'IN', 'uploaded', 'x/' || gen_random_uuid()::text || '.pdf', 'y.pdf', 'application/pdf', 1, gen_random_uuid()::text, 'cas_statement') returning id`,
        [userId],
      )
    ).rows[0].id;
  }
  const newJob = async (userId: string, docId: string, key: string) =>
    (await db.query<{ id: string }>(`insert into ii_statement_jobs (user_id, source_document_id, idempotency_key) values ($1, $2, $3) returning id`, [userId, docId, key])).rows[0].id;
  const claim = async (job: string, owner: string, secs = 60) => (await db.query(`select * from ii_statement_job_claim($1, $2, $3)`, [job, owner, secs])).rows;
  const rejects = async (p: Promise<unknown>, re: RegExp) => {
    await expect(p).rejects.toThrow(re);
  };

  beforeAll(async () => {
    db = await buildDb();
    await seedUser(U1);
    await seedUser(U2);
    docA = await seedDoc(U1);
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('the lease claim has exactly ONE winner; a lease that ran out is taken over and counted; a finished job is never claimed', async () => {
    const job = await newJob(U1, docA, 'claim-key-0001');
    const first = await claim(job, 'owner-one-1');
    expect(first).toHaveLength(1);
    expect((first[0] as { status: string; slice_count: number }).status).toBe('processing');
    expect(await claim(job, 'owner-two-2'), 'a live lease cannot be taken').toHaveLength(0);
    await db.query(`update ii_statement_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [job]);
    const taken = await claim(job, 'owner-two-2');
    expect(taken).toHaveLength(1);
    expect((taken[0] as { reclaim_count: number }).reclaim_count).toBe(1);
    await db.query(`update ii_statement_jobs set status = 'completed', lease_owner = null, lease_expires_at = null, phase = 'done' where id = $1`, [job]);
    expect(await claim(job, 'owner-three-3'), 'a finished job is not claimable').toHaveLength(0);
    await rejects(claim(job, 'short'), /owner token of at least 8/);
  });

  it('claim_next takes the most overdue unfinished job; heartbeat only extends the holder lease', async () => {
    await db.query(`update ii_statement_jobs set status = 'completed', lease_owner = null, lease_expires_at = null where status in ('queued', 'processing')`);
    const doc = await seedDoc(U1);
    const j1 = await newJob(U1, doc, 'next-key-0001');
    const next = (await db.query(`select * from ii_statement_job_claim_next('owner-next-01', 60)`)).rows as Array<{ id: string }>;
    expect(next.map((r) => r.id)).toEqual([j1]);
    expect(((await db.query(`select ii_statement_job_heartbeat($1, 'owner-next-01', 60) as ok`, [j1])).rows[0] as { ok: boolean }).ok).toBe(true);
    expect(((await db.query(`select ii_statement_job_heartbeat($1, 'someone-else-1', 60) as ok`, [j1])).rows[0] as { ok: boolean }).ok, 'only the holder may extend').toBe(false);
    expect((await db.query(`select * from ii_statement_job_claim_next('owner-next-02', 60)`)).rows, 'nothing is left to claim').toHaveLength(0);
  });

  it('one ACTIVE job per statement (a finished one does not count); one job per user and key; review_required needs a reason', async () => {
    const doc = await seedDoc(U1);
    const first = await newJob(U1, doc, 'one-active-0001');
    await rejects(newJob(U1, doc, 'one-active-0002'), /uq_ii_statement_jobs_one_active|duplicate key/);
    await db.query(`update ii_statement_jobs set status = 'completed', phase = 'done' where id = $1`, [first]);
    await newJob(U1, doc, 'one-active-0003'); // a new attempt after the last one ended
    const other = await seedDoc(U1);
    await rejects(newJob(U1, other, 'one-active-0003'), /uq_ii_statement_jobs_idempotency|duplicate key/);
    await rejects(db.query(`update ii_statement_jobs set status = 'review_required' where source_document_id = $1 and status = 'queued'`, [doc]), /chk_ii_statement_jobs_review|check constraint/);
    await rejects(db.query(`update ii_statement_jobs set status = 'bogus' where source_document_id = $1`, [doc]), /check constraint/);
  });

  it('staging accepts only the known kinds, one row per (job, kind, seq), and only for the job owner; a job cannot point at another user statement', async () => {
    const doc = await seedDoc(U1);
    const job = await newJob(U1, doc, 'staging-key-0001');
    await db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'parsed_meta', 0, '{}'::jsonb)`, [job, U1]);
    await db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'claims', 0, '{}'::jsonb)`, [job, U1]);
    await rejects(db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'parsed_meta', 0, '{}'::jsonb)`, [job, U1]), /duplicate key/);
    await rejects(db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'password', 0, '{}'::jsonb)`, [job, U1]), /check constraint/);
    await rejects(db.query(`insert into ii_statement_job_chunks (job_id, user_id, kind, seq, payload) values ($1, $2, 'acct', 0, '[]'::jsonb)`, [job, U2]), /does not belong to the user/);
    await rejects(newJob(U2, docA, 'cross-tenant-0001'), /cross-tenant/);
    // deleting the job removes its staging
    await db.query(`delete from ii_statement_jobs where id = $1`, [job]);
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_statement_job_chunks where job_id = $1`, [job])).rows[0].n)).toBe(0);
  });

  it('a browser role cannot call the lease functions; browsers read only their own jobs', async () => {
    const as = async <T,>(uid: string, fn: () => Promise<T>): Promise<T> => {
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await db.exec('set role authenticated;');
      try {
        return await fn();
      } finally {
        await db.exec('reset role;');
        await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
      }
    };
    const job = (await db.query<{ id: string }>(`select id from ii_statement_jobs where user_id = $1 limit 1`, [U1])).rows[0].id;
    await rejects(as(U1, () => db.query(`select * from ii_statement_job_claim($1, 'browser-owner-1', 60)`, [job])), /permission denied/i);
    await rejects(as(U1, () => db.query(`select * from ii_statement_job_claim_next('browser-owner-1', 60)`)), /permission denied/i);
    await rejects(as(U1, () => db.query(`select ii_statement_job_heartbeat($1, 'browser-owner-1', 60)`, [job])), /permission denied/i);
    expect((await as(U1, () => db.query(`select user_id from ii_statement_jobs`))).rows.every((r) => (r as { user_id: string }).user_id === U1)).toBe(true);
    expect((await as(U2, () => db.query(`select id from ii_statement_jobs where user_id = $1`, [U1]))).rows).toHaveLength(0);
  });

  describe('negative controls: remove one guard and the same assertion goes red', () => {
    it('without the lease condition two claimers both win', async () => {
      const doc = await seedDoc(U1);
      const job = await newJob(U1, doc, 'control-claim-01');
      expect(await claim(job, 'control-owner-1')).toHaveLength(1);
      const mutated = M0313.replace(/and \(j\.lease_expires_at is null or j\.lease_expires_at < now\(\)\)\n  returning j\.\*;/, 'returning j.*;');
      expect(mutated, 'the mutation must change the function').not.toBe(M0313);
      const fn = /create or replace function ii_statement_job_claim\(p_job_id[\s\S]*?\n\$fn\$;/.exec(mutated)![0];
      await db.exec(fn);
      expect(await claim(job, 'control-owner-2'), 'the control: a live lease is now taken over').toHaveLength(1);
      await db.exec(/create or replace function ii_statement_job_claim\(p_job_id[\s\S]*?\n\$fn\$;/.exec(M0313)![0]); // restore
      const doc2 = await seedDoc(U1);
      const job2 = await newJob(U1, doc2, 'control-claim-02');
      expect(await claim(job2, 'control-owner-1')).toHaveLength(1);
      expect(await claim(job2, 'control-owner-2'), 'restored: one winner again').toHaveLength(0);
    });

    it('without the partial unique index a statement can hold two active jobs', async () => {
      const doc = await seedDoc(U1);
      await newJob(U1, doc, 'control-active-01');
      await db.exec('drop index uq_ii_statement_jobs_one_active;');
      await newJob(U1, doc, 'control-active-02'); // the control: now allowed
      await db.query(`delete from ii_statement_jobs where source_document_id = $1 and idempotency_key = 'control-active-02'`, [doc]);
      await db.exec(`create unique index uq_ii_statement_jobs_one_active on ii_statement_jobs (source_document_id) where status in ('queued', 'processing');`);
      await rejects(newJob(U1, doc, 'control-active-03'), /uq_ii_statement_jobs_one_active|duplicate key/);
    });

    it('without the cross-tenant trigger a job can point at another user statement', async () => {
      await db.exec('drop trigger trg_ii_statement_jobs_owner on ii_statement_jobs;');
      const id = await newJob(U2, docA, 'control-tenant-01'); // the control: allowed now
      await db.query(`delete from ii_statement_jobs where id = $1`, [id]);
      await db.exec(
        'create trigger trg_ii_statement_jobs_owner before insert or update of user_id, source_document_id on ii_statement_jobs for each row execute function ii_statement_job_assert_owner();',
      );
      await rejects(newJob(U2, docA, 'control-tenant-02'), /cross-tenant/);
    });
  });
});
