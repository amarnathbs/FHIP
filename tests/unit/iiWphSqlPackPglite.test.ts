// Document2 (4) WP-H -- the READ-ONLY PO pack, run against the REAL schema (migration ledger replayed into PGlite): editor-safe, correct
// on a database that HAS migration 0159, correct on one that does NOT (the DEV condition), and it changes nothing.
// EVIDENCE LABEL: PGLITE-VERIFIED (isolated replay). Not DEV-verified, not production-verified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayAll } from './support/promoTestHelpers';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '..', '..', 'docs', 'reviews', 'po_apply_wp_h');
const sql = fs.readFileSync(path.join(PACK_DIR, '01_READ_ONLY_check_parse_run_counters.sql'), 'utf8');
const sql2 = fs.readFileSync(path.join(PACK_DIR, '02_READ_ONLY_economics_before_after_for_one_account.sql'), 'utf8');

describe('pack files', () => {
  it.each([['01', sql], ['02', sql2]])('pack %s is editor-safe (ASCII, no percent, no quotes or semicolons in comments, no statement words in comments or strings)', (_n, text) => {
    expect(hazards(text)).toEqual([]);
  });
  it.each([['01', sql], ['02', sql2]])('pack %s contains no data-changing or schema-changing statement', (_n, text) => {
    const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
    for (const word of ['insert ', 'update ', 'delete ', 'drop ', 'alter ', 'truncate ', 'create ', 'grant ', 'revoke ']) expect(code).not.toContain(word);
  });
});

describe('against the real schema', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await replayAll(db);
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });
  const run = async () => (await db.exec(sql)) as { rows: Record<string, unknown>[] }[];

  it('a database with migration 0159 shows three counters, the missing-from-restatement type and no stuck run', async () => {
    const [counters, constraint, stuck] = await run();
    expect(counters.rows.map((r) => r.column_name)).toEqual(['duplicate_transactions_linked', 'missing_transactions_count', 'new_transactions_count']);
    expect(constraint.rows).toHaveLength(1);
    expect(String(constraint.rows[0].definition)).toContain('transaction_missing_from_restatement');
    expect(stuck.rows).toEqual([]);
  });

  it('a database WITHOUT the counters (the DEV condition) shows fewer than three rows, and a run left running appears in result 3', async () => {
    await db.query(`set session_replication_role = replica`);
    const u = '00000000-0000-4000-8000-0000000000b1';
    await db.query(`insert into auth.users (id, email) values ($1, 'pack@example.test')`, [u]);
    await db.query(`insert into ii_document_parse_runs (id, user_id, source_document_id, parser_code, parser_version, run_status, idempotency_key, started_at) values ($1, $2, $3, 'r2-orchestrator', 'pending', 'running', 'k1', now() - interval '30 minutes')`, ['00000000-0000-4000-8000-0000000000b2', u, '00000000-0000-4000-8000-0000000000b3']);
    const counts = async () => Number((await db.query<{ n: string }>(`select count(*)::text as n from ii_document_parse_runs`)).rows[0].n);
    const before = await counts();
    await db.exec(`alter table ii_document_parse_runs drop column new_transactions_count`);
    const [counters, , stuck] = await run();
    expect(counters.rows.map((r) => r.column_name)).toEqual(['duplicate_transactions_linked', 'missing_transactions_count']);
    expect(stuck.rows.map((r) => r.source_document_id)).toEqual(['00000000-0000-4000-8000-0000000000b3']);
    expect(await counts()).toBe(before); // READ ONLY: running the pack changed nothing
    await db.exec(`alter table ii_document_parse_runs add column new_transactions_count int not null default 0`);
  });
});

describe('pack 02 (before / after economics) against the real schema', () => {
  let db: PGlite;
  const U = '00000000-0000-4000-8000-0000000000c1';
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  async function insert(table: string, values: Record<string, unknown>) {
    const cols = (await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows;
    const row: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (c.column_name in row || c.is_nullable === 'YES' || c.column_default !== null) continue;
      const t = c.data_type;
      row[c.column_name] = t === 'uuid' ? '99999999-9999-4999-8999-999999999999' : t.includes('timestamp') ? '2026-10-01T00:00:00Z' : t === 'date' ? '2026-10-01' : t === 'boolean' ? false : ['integer', 'bigint', 'numeric', 'smallint'].includes(t) ? 0 : t === 'jsonb' || t === 'json' ? '{}' : 'x';
    }
    const names = Object.keys(row);
    await db.query(`insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`, names.map((n) => row[n]));
  }
  const run2 = async (email: string) => ((await db.exec(sql2.replaceAll('REPLACE_WITH_ACCOUNT_EMAIL', email))) as { rows: Record<string, unknown>[] }[]).slice(-1)[0].rows;

  beforeAll(async () => {
    db = new PGlite();
    await replayAll(db);
    await db.exec(`set session_replication_role = replica`);
    await db.query(`insert into auth.users (id, email) values ($1, 'one@example.test'), ($2, 'two@example.test')`, [U, OTHER]);
    await insert('ii_accounts', { id: uuid(1), user_id: U, institution_name: 'AMC', account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', status: 'active' });
    await insert('ii_transactions', { id: uuid(2), user_id: U, account_id: uuid(1), gross_amount: 5000, transaction_type: 'purchase' });
    await insert('ii_transactions', { id: uuid(3), user_id: U, account_id: uuid(1), gross_amount: 2500, transaction_type: 'purchase' });
    await insert('ii_holding_snapshots', { id: uuid(4), user_id: U, account_id: uuid(1), instrument_id: uuid(9), value: 7800, as_of_date: '2025-03-31' });
    await insert('investments', { id: uuid(5), user_id: U, current_value: 7800, is_active: true });
    await insert('investments', { id: uuid(6), user_id: U, current_value: 100, is_active: false });
    await insert('ii_accounts', { id: uuid(7), user_id: OTHER, institution_name: 'AMC', account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', status: 'active' });
    await insert('ii_transactions', { id: uuid(8), user_id: OTHER, account_id: uuid(7), gross_amount: 999, transaction_type: 'purchase' });
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('counts only the named account, counts only active investments, and reports sums', async () => {
    const [r] = await run2('ONE@example.test');
    expect(r).toMatchObject({ accounts: 1, transactions: 2, holding_snapshots: 1, funds_held: 1, investments_active: 1 });
    expect(Number(r.transaction_amount_sum)).toBe(7500);
    expect(Number(r.holding_value_sum)).toBe(7800);
    expect(Number(r.investments_active_value)).toBe(7800);
  });
  it('another account has its own numbers (isolated), and an unknown email returns no row rather than zeros', async () => {
    const [r] = await run2('two@example.test');
    expect(r).toMatchObject({ accounts: 1, transactions: 1 });
    expect(await run2('nobody@example.test')).toEqual([]);
  });
  it('is read only: running it changes no row count', async () => {
    const n = async () => Number((await db.query<{ n: string }>(`select (select count(*) from ii_transactions) + (select count(*) from investments) + (select count(*) from ii_accounts) as n`)).rows[0].n);
    const before = await n();
    await run2('one@example.test');
    expect(await n()).toBe(before);
  });
});
