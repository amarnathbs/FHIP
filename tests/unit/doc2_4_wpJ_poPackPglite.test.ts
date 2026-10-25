/**
 * Document2 (4) WP-J -- the PO-run SQL pack (docs/reviews/po_apply_wp_j), run on a REAL Postgres (PGlite, this repository's whole chain).
 * PGLITE-VERIFIED. Nothing here has been run on DEV or production.
 *
 *   - every file obeys the SQL editor rules (a test already applies them to every migration; the pack is hand-pasted too),
 *   - the two apply files are byte-equal to the migrations,
 *   - every read-only block runs and returns what it promises, on the migrated database,
 *   - the schedule is ONE job, reads the secret from the Vault at run time, writes no secret, and calls a route that exists,
 *   - the rollback removes the job objects and re-applying restores the exact shape,
 *   - the optional close of the old stuck runs touches only dead runs with no unfinished job, saves them first, never marks one succeeded,
 *     and the undo puts them back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb, MIG_DIR } from './support/fdh10LedgerPgliteHarness';
import { hazards } from './support/sqlEditorHazards';

const PACK = path.resolve(__dirname, '../../docs/reviews/po_apply_wp_j');
const read = (f: string) => fs.readFileSync(path.join(PACK, f), 'utf8');
const files = fs.readdirSync(PACK).filter((f) => f.endsWith('.sql')).sort();

/** The runnable blocks of a read-only file: split at "-- BLOCK n:" headers. */
function blocks(sql: string): string[] {
  return sql
    .split(/^-- BLOCK \d+:/m)
    .slice(1)
    .map((b) => b.split('\n').slice(1).filter((l) => !l.startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

describe('the pack files', () => {
  it('has the files the README lists', () => {
    expect(files).toEqual([
      '01_READ_ONLY_before_apply.sql',
      '02_APPLY_0312_parse_run_counters_columns_only.sql',
      '03_APPLY_0313_statement_jobs.sql',
      '04_READ_ONLY_verify_after_apply.sql',
      '05_SCHEDULE_backstop_every_minute.sql',
      '06_ROLLBACK_if_needed.sql',
      '07_READ_ONLY_watch_the_jobs.sql',
      '08_OPTIONAL_close_the_old_stuck_runs.sql',
      '09_UNDO_close_the_old_stuck_runs.sql',
    ]);
    const readme = read('README.md');
    for (const f of files) expect(readme, `README mentions ${f}`).toContain(f);
  });

  it('every file obeys the SQL editor rules, and the rule checker really bites', () => {
    for (const f of files) expect(hazards(read(f)), f).toEqual([]);
    expect(hazards('-- insert into x\nselect 1;').length).toBeGreaterThan(0); // control: the words are caught inside a comment
    expect(hazards('select "a";').length).toBeGreaterThan(0); // control: a double quote in code
  });

  it('the apply files are byte-equal to the migrations', () => {
    expect(read('02_APPLY_0312_parse_run_counters_columns_only.sql')).toBe(fs.readFileSync(path.join(MIG_DIR, '0312_ii_document_parse_runs_counters.sql'), 'utf8'));
    expect(read('03_APPLY_0313_statement_jobs.sql')).toBe(fs.readFileSync(path.join(MIG_DIR, '0313_ii_statement_jobs.sql'), 'utf8'));
  });

  it('no secret, key or token is written anywhere in the pack', () => {
    for (const f of [...files, 'README.md']) {
      const text = read(f);
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // a JWT
      expect(text, f).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(text, f).not.toMatch(/service_role_key|SUPABASE_SERVICE_ROLE_KEY\s*=/i);
    }
  });
});

describe('the schedule', () => {
  const sql = read('05_SCHEDULE_backstop_every_minute.sql');
  it('is one job, replaces itself, reads the secret from the Vault at run time and calls the backstop route that exists', () => {
    expect((sql.match(/cron\.schedule\(/g) ?? []).length).toBe(1);
    expect(sql.indexOf('cron.unschedule')).toBeLessThan(sql.indexOf('cron.schedule('));
    expect(sql).toContain("from vault.decrypted_secrets where name = 'lr1_purge_sweep_cron_secret'");
    expect(sql).toContain('REPLACE_WITH_APP_ORIGIN/api/investment-intelligence/statement-jobs/cron/advance');
    expect(fs.existsSync(path.resolve(__dirname, '../../app/api/investment-intelligence/statement-jobs/cron/advance/route.ts'))).toBe(true);
  });
});

describe('on the migrated database', () => {
  let db: PGlite;
  const U1 = '00000000-0000-4000-8000-0000000000d1';
  const U2 = '00000000-0000-4000-8000-0000000000d2';
  beforeAll(async () => {
    db = await buildDb();
    for (const u of [U1, U2]) {
      await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [u, `${u}@t.test`]);
      await db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [u]);
    }
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  async function seedRun(userId: string, status: string, ageMinutes: number, key: string): Promise<{ docId: string; runId: string }> {
    const docId = (
      await db.query<{ id: string }>(
        `insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
         values ($1, 'IN', 'uploaded', 'x/' || gen_random_uuid()::text, 'y.pdf', 'application/pdf', 1, gen_random_uuid()::text, 'cas_statement') returning id`,
        [userId],
      )
    ).rows[0].id;
    const runId = (
      await db.query<{ id: string }>(
        `insert into ii_document_parse_runs (user_id, source_document_id, parser_code, parser_version, run_status, started_at, idempotency_key)
         values ($1, $2, 'p', 'v', $3, now() - ($4 || ' minutes')::interval, $5) returning id`,
        [userId, docId, status, String(ageMinutes), key],
      )
    ).rows[0].id;
    return { docId, runId };
  }

  it('01 read-only before: runs on the database as it is today and says nothing exists yet for the job objects', async () => {
    // Before 0313 the ledger here already holds it (the whole chain is applied), so this checks that every block RUNS and the shapes are right.
    const bs = blocks(read('01_READ_ONLY_before_apply.sql'));
    expect(bs.length).toBe(4);
    for (const b of bs) await db.query(b);
    const first = (await db.query<{ item: string; present: boolean }>(bs[0])).rows;
    expect(first.map((r) => r.item)).toEqual([
      'ii_statement_jobs table',
      'ii_statement_job_chunks table',
      'claim function',
      'counter column duplicate_transactions_linked',
      'counter column new_transactions_count',
      'counter column missing_transactions_count',
    ]);
    const second = (await db.query<{ present: boolean }>(bs[1])).rows;
    expect(second.every((r) => r.present === true)).toBe(true);
  });

  it('04 verify after: columns, row level security, one policy, server-only functions, indexes, empty tables', async () => {
    const bs = blocks(read('04_READ_ONLY_verify_after_apply.sql'));
    expect(bs.length).toBe(6);
    const cols = (await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string }>(bs[0])).rows;
    expect(cols.map((c) => c.column_name)).toEqual(['duplicate_transactions_linked', 'missing_transactions_count', 'new_transactions_count']);
    expect(cols.every((c) => c.data_type === 'integer' && c.is_nullable === 'NO' && c.column_default === '0')).toBe(true);
    expect((await db.query<{ rls_on: boolean }>(bs[1])).rows.map((r) => r.rls_on)).toEqual([true, true]);
    expect((await db.query<{ tablename: string; cmd: string }>(bs[2])).rows).toEqual([{ tablename: 'ii_statement_jobs', policyname: 'own_rows_read_ii_statement_jobs', cmd: 'SELECT' }].map((r) => expect.objectContaining(r)));
    const fns = (await db.query<{ function_name: string; browser_can_call: boolean; server_can_call: boolean }>(bs[3])).rows;
    expect(fns.map((f) => f.function_name)).toEqual(['ii_statement_job_claim', 'ii_statement_job_claim_next', 'ii_statement_job_heartbeat']);
    expect(fns.every((f) => f.browser_can_call === false && f.server_can_call === true)).toBe(true);
    expect((await db.query<{ indexname: string }>(bs[4])).rows.map((r) => r.indexname)).toEqual(['idx_ii_statement_jobs_work', 'uq_ii_statement_jobs_idempotency', 'uq_ii_statement_jobs_one_active']);
    expect((await db.query<{ jobs: string; staging_rows: string }>(bs[5])).rows[0]).toEqual({ jobs: 0, staging_rows: 0 });
  });

  it('07 watch: every block runs', async () => {
    for (const b of blocks(read('07_READ_ONLY_watch_the_jobs.sql'))) await db.query(b);
  });

  it('08 / 09: closes only dead runs with no unfinished job, saves them first, never marks one succeeded; 09 puts them back', async () => {
    const dead = await seedRun(U1, 'running', 60 * 24 * 3, 'k-dead-1');
    const young = await seedRun(U1, 'running', 2, 'k-young-1'); // too young
    const withJob = await seedRun(U1, 'running', 120, 'k-job-1'); // an unfinished job belongs to the statement
    await db.query(`insert into ii_statement_jobs (user_id, source_document_id, idempotency_key) values ($1, $2, 'k-job-key-1')`, [U1, withJob.docId]);
    const done = await seedRun(U2, 'succeeded', 60 * 24, 'k-done-1'); // not running at all
    const otherUserDead = await seedRun(U2, 'queued', 300, 'k-dead-2');

    await db.exec(read('08_OPTIONAL_close_the_old_stuck_runs.sql'));
    const status = async (id: string) => (await db.query<{ run_status: string; errors: Array<{ code: string }> }>(`select run_status, errors from ii_document_parse_runs where id = $1`, [id])).rows[0];
    expect((await status(dead.runId)).run_status).toBe('failed');
    expect((await status(dead.runId)).errors[0].code).toBe('run_abandoned');
    expect((await status(otherUserDead.runId)).run_status).toBe('failed');
    expect((await status(young.runId)).run_status).toBe('running');
    expect((await status(withJob.runId)).run_status).toBe('running');
    expect((await status(done.runId)).run_status).toBe('succeeded');
    const saved = (await db.query<{ id: string }>(`select id from ii_document_parse_runs_backup_wpj_20261025 order by id`)).rows.map((r) => r.id).sort();
    expect(saved).toEqual([dead.runId, otherUserDead.runId].sort());
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_document_parse_runs where run_status = 'succeeded' and errors @> '[{"code":"run_abandoned"}]'::jsonb`)).rows[0].n), 'never marked succeeded').toBe(0);

    await db.exec(read('09_UNDO_close_the_old_stuck_runs.sql'));
    expect((await status(dead.runId)).run_status).toBe('running');
    expect((await status(otherUserDead.runId)).run_status).toBe('queued');
  });

  it('06 rollback removes the job objects only; re-applying 03 restores the exact shape', async () => {
    const shape = async () =>
      (
        await db.query<{ t: string }>(
          `select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ',' order by table_name, ordinal_position) as t from information_schema.columns where table_name in ('ii_statement_jobs', 'ii_statement_job_chunks')`,
        )
      ).rows[0].t;
    const before = await shape();
    const runsBefore = Number((await db.query<{ n: string }>(`select count(*)::text n from ii_document_parse_runs`)).rows[0].n);
    // cron is not installed in this engine: run the rollback without its schedule statement
    const rollback = read('06_ROLLBACK_if_needed.sql').replace(/select cron\.unschedule[\s\S]*?;\n/, '');
    expect(rollback).not.toContain('cron.unschedule');
    await db.exec(rollback);
    expect((await db.query<{ n: string }>(`select count(*)::text n from information_schema.tables where table_name in ('ii_statement_jobs', 'ii_statement_job_chunks')`)).rows[0].n).toBe('0');
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_document_parse_runs`)).rows[0].n), 'no run row was touched').toBe(runsBefore);
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from information_schema.columns where table_name = 'ii_document_parse_runs' and column_name = 'new_transactions_count'`)).rows[0].n), '0312 columns stay').toBe(1);
    await db.exec(read('03_APPLY_0313_statement_jobs.sql'));
    expect(await shape()).toBe(before);
  });
});
