// Document2 (4) WP-B -- the three READ-ONLY PO packs, run against the REAL schema (the whole migration ledger replayed into an isolated
// in-memory Postgres, PGlite), with realistic rows, to prove: they execute in the editor-safe dialect, they classify what the app
// classifies, and they change nothing.
//
// EVIDENCE LABEL: PGLITE-VERIFIED (isolated replay). Not DEV-verified, not production-verified.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayAll } from './support/promoTestHelpers';
import { hazards } from './support/sqlEditorHazards';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '..', '..', 'docs', 'reviews', 'po_apply_wp_b');
const PACKS = fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f: string) => fs.readFileSync(path.join(PACK_DIR, f), 'utf8');

describe('pack files', () => {
  it('there are exactly the three read-only packs', () => {
    expect(PACKS).toEqual(['01_readonly_open_case_classification.sql', '02_readonly_owner_unmatched_causes.sql', '03_readonly_review_item_regeneration.sql']);
  });
  it.each(PACKS)('%s is editor-safe (ASCII, no percent, no quotes or semicolons in comments, no statement words in comments or strings)', (f) => {
    expect(hazards(read(f))).toEqual([]);
  });
  it.each(PACKS)('%s contains no data-changing or schema-changing statement', (f) => {
    const code = read(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
    for (const word of ['insert ', 'update ', 'delete ', 'drop ', 'alter ', 'truncate ', 'create ', 'grant ', 'revoke ']) expect(code).not.toContain(word);
  });
});

describe('packs against the real schema', () => {
  let db: PGlite;
  const EMAIL = 'po-wpb@example.test';
  const U = '00000000-0000-4000-8000-0000000000a1';
  const OTHER = '00000000-0000-4000-8000-0000000000a2';
  const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** Inserts a row, filling every NOT NULL column that has no default with a type-appropriate dummy, so the test names only what matters. */
  async function insert(table: string, values: Record<string, unknown>) {
    const cols = (
      await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [table],
      )
    ).rows;
    const row: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (c.column_name in row || c.is_nullable === 'YES' || c.column_default !== null) continue;
      const t = c.data_type;
      row[c.column_name] = t === 'uuid' ? '99999999-9999-4999-8999-999999999999' : t.includes('timestamp') ? '2026-10-01T00:00:00Z' : t === 'date' ? '2026-10-01' : t === 'boolean' ? false : ['integer', 'bigint', 'numeric', 'smallint'].includes(t) ? 0 : t === 'jsonb' || t === 'json' ? '{}' : 'x';
    }
    const names = Object.keys(row);
    await db.query(`insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`, names.map((n) => row[n]));
  }

  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of ['ii_reconciliation_cases', 'ii_source_documents', 'ii_accounts', 'ii_review_items', 'ii_holding_snapshots']) {
      out[t] = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0].n);
    }
    return out;
  };

  beforeAll(async () => {
    db = new PGlite();
    await replayAll(db);
    await db.exec(`set session_replication_role = replica`); // referenced rows (instruments, members, runs) are irrelevant to what the packs read
    await db.query(`insert into auth.users (id, email) values ($1, $2), ($3, 'other@example.test')`, [U, EMAIL, OTHER]);

    const doc = (id: number, status: string, purged: boolean, user = U) =>
      insert('ii_source_documents', { id: uuid(id), user_id: user, status, original_filename: `d${id}.pdf`, storage_path: `u/d${id}.pdf`, storage_purged_at: purged ? '2026-10-02T00:00:00Z' : null, checksum: `sum${id}`, mime_type: 'application/pdf', document_type: 'cas_statement', country_code: 'IN' });
    await doc(1, 'password_required', true); // file deleted, needs a password
    await doc(2, 'parsed', true); // parsed, file deleted, data retained
    await doc(3, 'password_required', false); // file still stored
    await doc(9, 'password_required', true, OTHER);
    await insert('ii_holding_snapshots', { id: uuid(50), user_id: U, source_document_id: uuid(2), account_id: uuid(21), instrument_id: uuid(31), as_of_date: '2026-09-04', units: 10, value: 100, currency_code: 'INR' });

    await insert('ii_accounts', { id: uuid(21), user_id: U, owner_member_id: uuid(41), institution_name: 'AMC', account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', status: 'active' }); // explicit owner
    await insert('ii_accounts', { id: uuid(22), user_id: U, owner_member_id: null, institution_name: 'AMC', account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', status: 'active' }); // never chosen

    const kase = (id: number, type: string, doc: number, subject: number, extra: Record<string, unknown> = {}) =>
      insert('ii_reconciliation_cases', { id: uuid(id), user_id: U, subject_type: 'account', subject_id: uuid(subject), discrepancy_type: type, severity: 'blocking', status: 'open', source_document_id: uuid(doc), opened_at: `2026-10-0${(id % 8) + 1}T00:00:00Z`, ...extra });
    await kase(101, 'owner_unmatched', 2, 21); // explicit owner exists: the app will close this one
    await kase(102, 'owner_unmatched', 2, 22);
    await kase(103, 'owner_unmatched', 2, 22); // repeats from reprocessing
    await kase(104, 'owner_unmatched', 2, 22);
    await kase(105, 'owner_unmatched', 2, 22, { status: 'resolved', resolution_method: 'user_mapped_owner' });
    await kase(111, 'document_password_required', 1, 1);
    await kase(112, 'document_password_required', 3, 3);
    await kase(113, 'value_mismatch', 2, 21);
    await kase(114, 'transaction_missing_from_restatement', 2, 21, { severity: 'medium' });
    await insert('ii_reconciliation_cases', { id: uuid(190), user_id: OTHER, subject_type: 'account', subject_id: uuid(9), discrepancy_type: 'owner_unmatched', severity: 'blocking', status: 'open', source_document_id: uuid(9) });

    const item = (id: number, key: string, status: string) =>
      insert('ii_review_items', { id: uuid(id), user_id: U, rule_key: 'reconciliation_open', identity_key: key, status, review_type: 'data_quality', category: 'reconciliation_open', severity: 'medium', compliance_classification: 'observation', title: 't', description: 'd', evidence: '{}', source_module: 'ii_data_quality', review_engine_version: 'v', rule_version: 'v', as_of_date: '2026-10-01' });
    await item(201, 'k-regenerated', 'dismissed');
    await item(202, 'k-regenerated', 'open');
    await item(203, 'k-fine', 'dismissed');
  }, 600_000);

  afterAll(async () => {
    await db?.close();
  });

  async function run(file: string) {
    const results = (await db.exec(read(file).replaceAll('REPLACE_WITH_ACCOUNT_EMAIL', EMAIL))) as { rows: Record<string, unknown>[] }[];
    return results.filter((r) => r.rows && r.rows.length >= 0);
  }

  it('pack 01 classifies every open case the way the app does, only for the named account', async () => {
    const [res] = (await run('01_readonly_open_case_classification.sql')).slice(-1);
    const rows = res.rows as { discrepancy_type: string; file_stored: boolean; data_retained: boolean; open_cases: number; what_it_really_needs: string; action_offered: string }[];
    const find = (type: string, stored: boolean) => rows.find((r) => r.discrepancy_type === type && r.file_stored === stored);
    expect(find('document_password_required', false)?.what_it_really_needs).toBe('information no longer exists');
    expect(find('document_password_required', false)?.action_offered).toMatch(/replacement copy or close as stale/);
    expect(find('document_password_required', true)?.what_it_really_needs).toBe('password and reprocess'); // file present: the password flow still works
    const owner = rows.find((r) => r.discrepancy_type === 'owner_unmatched');
    expect(owner?.what_it_really_needs).toBe('owner selection');
    expect(Number(owner?.open_cases)).toBe(4);
    expect(find('value_mismatch', false)?.what_it_really_needs).toBe('information no longer exists');
    expect(rows.find((r) => r.discrepancy_type === 'transaction_missing_from_restatement')?.what_it_really_needs).toBe('informational');
    // the other user's case never appears: 4 owner + 2 password + 1 value + 1 missing = 8 open cases for this account
    expect(rows.reduce((n, r) => n + Number(r.open_cases), 0)).toBe(8);
  });

  it('pack 02 shows the causes: repeats per account, and which open questions already have an explicit owner', async () => {
    const sets = await run('02_readonly_owner_unmatched_causes.sql');
    const [byStatus, repeats, explicit] = sets.map((s) => s.rows) as Record<string, unknown>[][];
    expect(byStatus.find((r) => r.status === 'open')?.cases).toBe(4 as never);
    expect(byStatus.find((r) => r.status === 'resolved')?.resolution_method).toBe('user_mapped_owner');
    expect(repeats).toHaveLength(1);
    expect(Number(repeats[0].cases_for_this_account_and_statement)).toBe(4);
    expect(Number(repeats[0].still_open)).toBe(3);
    const yes = explicit.find((r) => r.explicit_owner === true);
    const no = explicit.find((r) => r.explicit_owner === false);
    expect(Number(yes?.open_cases)).toBe(1); // the app closes it: an owner was already chosen
    expect(Number(no?.open_cases)).toBe(3); // nobody chose: stays open, never guessed
  });

  it('pack 03 finds only the item that was dismissed and raised again', async () => {
    const [res] = (await run('03_readonly_review_item_regeneration.sql')).slice(-1);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].identity_key).toBe('k-regenerated');
  });

  it('running all three packs changed nothing (READ ONLY proved by row counts and by an actual read-only transaction)', async () => {
    const before = await counts();
    for (const f of PACKS) await run(f);
    expect(await counts()).toEqual(before);
    // and the packs also succeed inside a transaction the database itself forces to be read only
    await db.exec('begin read only');
    for (const f of PACKS) await db.exec(read(f).replaceAll('REPLACE_WITH_ACCOUNT_EMAIL', EMAIL));
    await db.exec('rollback');
  });
});
