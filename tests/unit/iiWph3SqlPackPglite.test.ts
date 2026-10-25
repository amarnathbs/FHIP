// Document2 (4) WP-H3 -- the PO packs for the duplicate rows a replacement reprocess left on production, run against the REAL schema
// (migration ledger replayed into PGlite) with realistic rows: five look-alike pairs from two processing runs, one new row with no twin, one
// pair of genuine same-day lines from a SINGLE run, and a second user with the same shape.
// Proves: editor-safe, the detector finds exactly the right groups, backup -> preview -> apply -> verify -> rollback work and only touch the chosen
// rows, the guards refuse unsafe runs (no backup, nothing chosen, too many), and the read-only packs change nothing.
// EVIDENCE LABEL: PGLITE-VERIFIED. Not DEV-verified, not production-verified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayAll } from './support/promoTestHelpers';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..', '..', 'docs', 'reviews', 'po_apply_wp_h3');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const EMAIL = 'po-wph3@example.test';
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

describe('pack files', () => {
  it('there are exactly the seven packs', () => {
    expect(FILES).toEqual([
      '01_READ_ONLY_detect_reparse_duplicates.sql',
      '02_READ_ONLY_look_alikes_for_new_rows.sql',
      '03_BACKUP_exact_rows_before_apply.sql',
      '04_READ_ONLY_preview_what_apply_will_do.sql',
      '05_APPLY_retire_the_duplicate_rows.sql',
      '06_READ_ONLY_verify_after_apply.sql',
      '07_ROLLBACK_put_the_rows_back.sql',
    ]);
  });
  it.each(FILES)('%s is editor-safe (ASCII, no percent, no quotes or semicolons in comments, no statement words in comments or strings)', (f) => {
    expect(hazards(read(f))).toEqual([]);
  });
  it.each(FILES.filter((f) => f.includes('READ_ONLY')))('%s contains no data-changing or schema-changing statement', (f) => {
    const code = read(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
    for (const word of ['insert ', 'update ', 'delete ', 'drop ', 'alter ', 'truncate ', 'grant ', 'revoke ']) expect(code).not.toContain(word);
    expect(code.replace('create temp table wph3_chosen', '')).not.toContain('create ');
  });
});

describe('against the real schema', () => {
  let db: PGlite;
  const U = '00000000-0000-4000-8000-0000000000e1';
  const OTHER = '00000000-0000-4000-8000-0000000000e2';
  const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const OLD_RUN = uuid(901);
  const NEW_RUN = uuid(902);
  const OTHER_OLD = uuid(903);
  const OTHER_NEW = uuid(904);

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
  const OLD_AT = '2026-09-07T10:00:00Z';
  const NEW_AT = '2026-10-25T00:33:42Z';
  let seq = 100;
  const txn = (user: string, account: number, doc: number, date: string, amount: number, units: number, price: number, run: string, at: string, type = 'sip', fp = `fp${seq}`) =>
    insert('ii_transactions', { id: uuid(++seq), user_id: user, account_id: uuid(account), instrument_id: uuid(30), source_document_id: uuid(doc), currency_code: 'INR', status: 'parsed', transaction_type: type, transaction_date: date, units, price_per_unit: price, gross_amount: amount, source_reference: null, parse_run_id: run, transaction_fingerprint: `${fp}-${seq}`, created_at: at });
  const rowsOf = async (ids?: string[]) => (await db.query<{ id: string; status: string }>(`select id, status from ii_transactions ${ids ? `where id = any($1)` : ''} order by id`, ids ? [ids] : [])).rows;
  const counts = async () => Number((await db.query<{ n: string }>(`select (select count(*) from ii_transactions) + (select count(*) from ii_audit_events) + (select count(*) from ii_transaction_source_links) as n`)).rows[0].n);
  const run = async (file: string, replace: Record<string, string> = {}) => {
    let text = read(file).replaceAll('REPLACE_WITH_ACCOUNT_EMAIL', EMAIL);
    for (const [k, v] of Object.entries(replace)) text = text.replaceAll(k, v);
    return (await db.exec(text)) as { rows: Record<string, unknown>[] }[];
  };
  const chosenNow = async () => (await db.query<{ retire_id: string }>(`select retire_id from wph3_chosen`)).rows.map((r) => r.retire_id);

  beforeAll(async () => {
    db = new PGlite();
    await replayAll(db);
    await db.exec(`set session_replication_role = replica`);
    await db.query(`insert into auth.users (id, email) values ($1, $2), ($3, 'other-wph3@example.test')`, [U, EMAIL, OTHER]);
    // five look-alike pairs: the earlier parse (wrong units) and the replacement run (right units)
    const pairs: [string, number, number, number, number][] = [
      ['2015-11-09', 1000, 6.562, 152.3899, 1],
      ['2015-12-07', 1000, 6.683, 149.6313, 1],
      ['2016-01-07', 1000, 6.836, 146.2884, 1],
      ['2016-02-08', 1000, 7.149, 139.8785, 1],
      ['2014-02-10', 10000, 766.284, 13.05, 2],
    ];
    for (const [d, amount, units, price, acc] of pairs) {
      await txn(U, 20 + acc, 10, d, amount, Math.round(units * 10 * 1e6) / 1e6, price, OLD_RUN, OLD_AT); // earlier parse: units read ten times too large, so units x price no longer equals the amount
      await txn(U, 20 + acc, 10, d, amount, units, price, NEW_RUN, NEW_AT);
    }
    // a line the replacement run found that the earlier parse never captured (no twin)
    await txn(U, 23, 10, '2009-06-10', 1000, 15.018, 66.5885, NEW_RUN, NEW_AT, 'reversal');
    // two genuine same-day purchases of one run (never reported)
    await txn(U, 24, 11, '2020-03-02', 500, 5, 100, OLD_RUN, OLD_AT);
    await txn(U, 24, 11, '2020-03-02', 500, 5, 100, OLD_RUN, OLD_AT);
    // the same shape for another user (must never be touched)
    await txn(OTHER, 25, 12, '2015-11-09', 1000, 65.62, 15.23, OTHER_OLD, OLD_AT);
    await txn(OTHER, 25, 12, '2015-11-09', 1000, 6.562, 152.3899, OTHER_NEW, NEW_AT);
    // a row WITH a provider reference is out of scope even if it repeats
    await insert('ii_transactions', { id: uuid(500), user_id: U, account_id: uuid(26), instrument_id: uuid(30), source_document_id: uuid(13), currency_code: 'INR', status: 'parsed', transaction_type: 'purchase', transaction_date: '2018-01-01', units: 1, price_per_unit: 1, gross_amount: 1, source_reference: 'REF1', parse_run_id: OLD_RUN, transaction_fingerprint: 'fpref-1', created_at: OLD_AT });
    await insert('ii_transactions', { id: uuid(501), user_id: U, account_id: uuid(26), instrument_id: uuid(30), source_document_id: uuid(13), currency_code: 'INR', status: 'parsed', transaction_type: 'purchase', transaction_date: '2018-01-01', units: 1, price_per_unit: 1, gross_amount: 1, source_reference: 'REF2', parse_run_id: NEW_RUN, transaction_fingerprint: 'fpref-2', created_at: NEW_AT });
    // each transaction has its source link
    await db.query(`select 1`);
    for (const r of (await db.query<{ id: string; source_document_id: string; user_id: string }>(`select id, source_document_id, user_id from ii_transactions`)).rows) {
      await insert('ii_transaction_source_links', { user_id: r.user_id, transaction_id: r.id, source_document_id: r.source_document_id, is_originating: true });
    }
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('pack 01 finds exactly the five look-alike groups (not the single-run pair, not the referenced rows, not the unpaired row)', async () => {
    const [byAccount, detail] = (await run('01_READ_ONLY_detect_reparse_duplicates.sql')).slice(-2);
    const total = byAccount.rows.reduce((n, r) => n + Number(r.extra_rows), 0);
    expect(total).toBe(5 + 1); // five for the first user, one for the other user
    const mine = byAccount.rows.filter((r) => r.user_id === U);
    expect(mine.reduce((n, r) => n + Number(r.duplicate_groups), 0)).toBe(5);
    expect(mine.reduce((n, r) => n + Number(r.extra_amount), 0)).toBe(4000 + 10000);
    expect(detail.rows).toHaveLength(12); // 6 groups x 2 rows
    expect(detail.rows.every((r) => day(r.transaction_date) !== '2020-03-02' && day(r.transaction_date) !== '2009-06-10')).toBe(true);
    // the plausibility column separates the wrongly read row from the right one
    const group = detail.rows.filter((r) => r.user_id === U && day(r.transaction_date) === '2015-11-09');
    expect(group.map((r) => r.consistent_units).sort()).toEqual([false, true]);
  });

  it('pack 02 explains the 2009 row: with a twin it names the relation, without one it shows nothing older', async () => {
    await db.exec(`create table if not exists wph3_probe (id int)`);
    const res = await run('02_READ_ONLY_look_alikes_for_new_rows.sql');
    const rows = res.slice(-1)[0].rows;
    const r2009 = rows.filter((r) => day(r.transaction_date) === '2009-06-10');
    expect(r2009).toHaveLength(1);
    expect(r2009[0].older_row_id).toBeNull(); // genuinely new: nothing older on that date for that fund
    const r2015 = rows.filter((r) => day(r.transaction_date) === '2015-11-09');
    expect(r2015.some((r) => r.relation === 'same date, amount and type')).toBe(true);
  });

  it('the guards refuse unsafe runs: apply without a backup, and a window that matches nothing, change nothing', async () => {
    const before = await counts();
    await expect(run('05_APPLY_retire_the_duplicate_rows.sql')).rejects.toThrow(/backup|WP-H3/i);
    await db.exec('rollback');
    await expect(run('05_APPLY_retire_the_duplicate_rows.sql', { '2026-10-25 00:33:00+00': '2030-01-01 00:00:00+00', '2026-10-25 00:34:00+00': '2030-01-01 00:01:00+00' })).rejects.toThrow(/no rows match|WP-H3/i);
    await db.exec('rollback');
    expect(await counts()).toBe(before);
  });

  it('backup, preview, apply, verify, rollback: only the five newer rows of the first user are retired, then restored exactly', async () => {
    const readOnlyBefore = await counts();
    const [pairs, effect, guard] = (await run('04_READ_ONLY_preview_what_apply_will_do.sql')).slice(-3);
    expect(await counts()).toBe(readOnlyBefore); // read only
    expect(pairs.rows).toHaveLength(5);
    expect(pairs.rows.every((r) => r.retire_consistent_units === true && r.keep_consistent_units === false)).toBe(true); // in this data the NEWER rows are the correctly read ones, so retiring them would be the wrong choice: the preview exists so the PO sees that and sets retire_which to older
    expect(effect.rows.length).toBeGreaterThan(0);
    expect(Number(guard.rows[0].pairs_chosen)).toBe(5);
    const retireIds = await chosenNow();
    expect(retireIds).toHaveLength(5);
    await db.exec(`drop table wph3_chosen`);

    const allBefore = await rowsOf();
    const [saved] = (await run('03_BACKUP_exact_rows_before_apply.sql')).slice(-1);
    expect(Number(saved.rows[0].transaction_rows_saved)).toBe(10); // 5 retired + 5 kept
    expect(Number(saved.rows[0].link_rows_saved)).toBe(10);
    await db.exec(`drop table if exists wph3_chosen`);
    await expect(run('03_BACKUP_exact_rows_before_apply.sql')).rejects.toThrow(/already exists/i); // the backup cannot be overwritten
    await db.exec('rollback');

    await run('05_APPLY_retire_the_duplicate_rows.sql');
    const afterApply = await rowsOf();
    const changed = afterApply.filter((r, i) => r.status !== allBefore[i].status).map((r) => r.id);
    expect(changed.sort()).toEqual([...retireIds].sort());
    expect(afterApply.filter((r) => r.status === 'reversed')).toHaveLength(5);
    const audit = (await db.query<{ n: string }>(`select count(*)::text n from ii_audit_events where metadata ->> 'kind' = 'wph3_duplicate_retired'`)).rows[0];
    expect(Number(audit.n)).toBe(5);
    // the other user, the single-run pair, the unpaired row and the referenced rows were not touched
    expect((await rowsOf()).filter((r) => r.status === 'reversed' && !retireIds.includes(r.id))).toEqual([]);

    const verify = (await run('06_READ_ONLY_verify_after_apply.sql')).slice(-3);
    expect(verify[0].rows.map((r) => r.user_id)).toEqual([OTHER]); // only the other user is still reported: nothing was changed for them
    expect(verify[1].rows).toHaveLength(5);
    expect(Number(verify[2].rows[0].still_counted)).toBe(0);

    // a second apply refuses: nothing left to do
    await db.exec(`drop table if exists wph3_chosen`);
    await expect(run('05_APPLY_retire_the_duplicate_rows.sql')).rejects.toThrow(/WP-H3/);
    await db.exec('rollback');

    await run('07_ROLLBACK_put_the_rows_back.sql');
    expect(await rowsOf()).toEqual(allBefore); // every status exactly as before
    expect(Number((await db.query<{ n: string }>(`select count(*)::text n from ii_audit_events where metadata ->> 'kind' = 'wph3_duplicate_rollback'`)).rows[0].n)).toBe(5);
    // rollback is idempotent: a second run restores nothing and does not fail
    await run('07_ROLLBACK_put_the_rows_back.sql');
    expect(await rowsOf()).toEqual(allBefore);
  });

  it('retire_which = older flips the pairs (the choice the preview exists to inform)', async () => {
    await db.exec(`drop table if exists wph3_chosen`);
    await run('04_READ_ONLY_preview_what_apply_will_do.sql', { "'newer'::text as retire_which": "'older'::text as retire_which" });
    const olderIds = await chosenNow();
    const rows = (await db.query<{ created_at: string }>(`select created_at from ii_transactions where id = any($1)`, [olderIds])).rows;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => new Date(r.created_at).toISOString() === '2026-09-07T10:00:00.000Z')).toBe(true);
  });
});
