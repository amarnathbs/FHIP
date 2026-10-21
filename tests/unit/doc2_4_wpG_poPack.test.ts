/**
 * Document2 (4) WP-G -- the PO-run SQL pack (docs/reviews/po_apply_wp_g): it is what the Product Owner pastes into the Supabase SQL
 * editor, so it is checked like code.
 *   - the two apply files are byte-for-byte the migrations (nothing can drift);
 *   - no comment or string anywhere in the pack contains the words into / from / join followed by a word (the SQL editor rule);
 *   - on a real Postgres (PGlite, full chain) every read-only block runs and returns what its comment promises, the schedule file
 *     registers its job, and the rollback followed by a re-apply leaves the database exactly as the migrations make it.
 * Evidence label: PGLITE-VERIFIED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildDb, MIG_DIR } from './support/fdh10LedgerPgliteHarness';
import { hazards } from './support/editorSafeSql';

const PACK = path.resolve(MIG_DIR, '..', '..', 'docs', 'reviews', 'po_apply_wp_g');
const read = (f: string) => fs.readFileSync(path.join(PACK, f), 'utf8').replace(/\r\n/g, '\n');
const mig = (f: string) => fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n');
const files = fs.readdirSync(PACK).filter((f) => f.endsWith('.sql')).sort();

let db: PGlite;
beforeAll(async () => {
  db = await buildDb();
}, 600_000);
afterAll(async () => {
  await db?.close();
});

/** Runs every statement of a pack file (they are all single-line-terminated by a semicolon at the end of a line). */
async function runFile(f: string, replace: Array<[string, string]> = []) {
  let sql = read(f);
  for (const [a, b] of replace) sql = sql.split(a).join(b);
  const results: unknown[][] = [];
  const stripped = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const statements = stripped.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
  for (const s of statements) {
    if (s.includes('cron.job_run_details')) continue; // pg_cron's run log does not exist in the test engine
    results.push((await db.query(s)).rows);
  }
  return results;
}

describe('the pack files', () => {
  it('the apply files are byte-for-byte the migrations', () => {
    expect(read('02_APPLY_0310_bank_import_jobs.sql')).toBe(mig('0310_fdh_bank_import_jobs.sql'));
    expect(read('03_APPLY_0311_unique_source_row_index.sql')).toBe(mig('0311_fdh_transactions_statement_source_row_unique.sql'));
  });

  it('every pack file and both migrations obey the Supabase SQL-editor rules (ASCII, no bare dollar quote, no percent sign, no double quote in code, no semicolon or quote in a comment, no semicolon in a string, no into / from / join + word in a comment or string)', () => {
    const bad: string[] = [];
    for (const [name, sql] of [...files.map((f) => [f, read(f)] as const), ['0310', mig('0310_fdh_bank_import_jobs.sql')], ['0311', mig('0311_fdh_transactions_statement_source_row_unique.sql')]]) {
      for (const h of hazards(sql)) bad.push(`${name}: ${h}`);
    }
    expect(bad).toEqual([]);
  });

  it('the lint really bites: a deliberately bad snippet is flagged', () => {
    expect(hazards("select 1; -- it's a comment with ; and a quote\n").length).toBeGreaterThan(0);
    expect(hazards('create function f() returns int as $$ select 1 $$ language sql;').join(' ')).toMatch(/bare dollar quote/);
    expect(hazards("-- reading from the table\nselect 1;\n").join(' ')).toMatch(/from/);
  });

  it('there are no secrets in the pack (no key, token or password literal)', () => {
    for (const f of files) expect(read(f)).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|service_role_key|password\s*=/i);
  });
});

describe('on a real Postgres', () => {
  it('01 (before) reports the new objects absent only if they are, and 04 / 07 run and return what their comments promise', async () => {
    // The full chain already includes 0310 and 0311, so the "before" block says present = true here; the shape is what matters.
    const before = await runFile('01_READ_ONLY_before_apply.sql');
    expect(before[0]).toHaveLength(4);
    expect(before[1].every((r) => (r as { present: boolean }).present)).toBe(true); // everything it builds on exists
    expect(before[2]).toHaveLength(0); // no duplicate (statement, row) pairs
    const after = await runFile('04_READ_ONLY_verify_after_apply.sql');
    expect(after[0]).toEqual([
      { table_name: 'fdh_bank_import_job_chunks', rls_on: true },
      { table_name: 'fdh_bank_import_jobs', rls_on: true },
    ]);
    expect(after[1]).toEqual([{ tablename: 'fdh_bank_import_jobs', policyname: 'own_rows_read_fdh_bank_import_jobs', cmd: 'SELECT' }]);
    const lease = (after[2] as Array<{ proname: string; anon_can_run: boolean; signed_in_browser_can_run: boolean; server_can_run: boolean }>).filter((r) => /claim|heartbeat/.test(r.proname));
    expect(lease.map((r) => r.proname).sort()).toEqual(['fdh_bank_import_claim_job', 'fdh_bank_import_claim_next', 'fdh_bank_import_heartbeat']);
    for (const r of lease) expect(r).toMatchObject({ anon_can_run: false, signed_in_browser_can_run: false, server_can_run: true });
    expect(after[3]).toHaveLength(1); // the unique line index
    expect(Number((after[4][0] as { jobs: number | string }).jobs)).toBe(0); // empty right after applying
    const watch = await runFile('07_READ_ONLY_watch_the_jobs.sql');
    expect(watch.length).toBe(5);
  });

  it('05 registers its job (the origin placeholder is replaced by the operator)', async () => {
    // the test engine's platform shim already stubs pg_cron (schedule / unschedule / the job table)
    // The statement holds a dollar-quoted body with semicolons, so it is executed whole (the read-only CHECK lines after it are not).
    await db.exec(read('05_SCHEDULE_backstop_every_minute.sql').split('-- CHECK')[0].split('REPLACE_WITH_APP_ORIGIN').join('https://example.test'));
    const rows = (await db.query<{ jobname: string; schedule: string; command: string }>(`select jobname, schedule, command from cron.job where jobname = 'fdh-bank-import-advance'`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe('*/1 * * * *');
    expect(rows[0].command).toContain('/api/financial-data-hub/bank-import-jobs/cron/advance');
    expect(rows[0].command).toContain('x-cron-secret');
    expect(rows[0].command).not.toMatch(/[A-Za-z0-9]{32,}/); // no secret value in the registered command
  });

  it('06 removes everything and 02 + 03 put it back exactly (re-applicable)', async () => {
    const shape = async () => (await db.query<{ t: string }>(
      `select string_agg(x, ',' order by x) t from (
         select 'table:' || relname x from pg_class where relname in ('fdh_bank_import_jobs','fdh_bank_import_job_chunks')
         union all select 'fn:' || proname from pg_proc where proname like 'fdh_bank_import_%'
         union all select 'ix:' || indexname from pg_indexes where indexname = 'uq_fdh_transactions_statement_source_row') s`)).rows[0].t;
    const original = await shape();
    await runFile('06_ROLLBACK_if_needed.sql');
    const gone = await shape();
    expect(gone ?? '').toBe('');
    await db.exec(read('02_APPLY_0310_bank_import_jobs.sql'));
    await db.exec(read('03_APPLY_0311_unique_source_row_index.sql'));
    expect(await shape()).toBe(original);
  });
});
