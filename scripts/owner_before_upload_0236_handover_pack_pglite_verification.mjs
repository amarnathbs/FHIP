// Owner-before-upload -- PGlite verification of the PO hand-over pack docs/ownership/po_apply_0236_dev/.
//
// Proves, on a real PostgreSQL engine (NOT DEV), that the SQL files the PO pastes into the Supabase SQL
// editor do what the README says:
//   * 01/03 (inventory) reports 0 owner objects BEFORE 0236 and 12 column rows (11 new) / 13 constraints / 2 triggers /
//     2 functions AFTER; its FINGERPRINT is identical after a second apply (idempotent), and it CHANGES
//     when one constraint or one trigger is dropped (so a drifted database cannot look like a match).
//   * 04/08 (preview counts) equal the shipped script's own preview on a DEV-shaped fixture, move when the
//     fixture changes, and are all 0 after the COMMIT.
//   * 05/09 (shipped, ROLLBACK) persist nothing; 06 (COMMIT) is byte-identical to 05 but for the last line.
//   * 07 (state after backfill) shows no unbackfilled row, no invented Self, and the user_selected row intact.
// Run: node scripts/owner_before_upload_0236_handover_pack_pglite_verification.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const PACK = path.join(ROOT, 'docs', 'ownership', 'po_apply_0236_dev');
const TARGET = '0236_owner_before_upload_phase1.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const pack = (f) => fs.readFileSync(path.join(PACK, f), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const errOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
  if (f >= TARGET) break;
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
}
console.log('Hand-over pack po_apply_0236_dev -- PGlite verification');

// ---- pack integrity --------------------------------------------------------------
const mig = fs.readFileSync(path.join(MIG, TARGET), 'utf8');
const shipped = fs.readFileSync(path.join(ROOT, 'docs', 'ownership', 'owner_before_upload_phase1_backfill.sql'), 'utf8');
check('02 is byte-identical to the migration on main', pack('02_apply_0236_owner_before_upload_phase1.sql') === mig);
check('05 and 09 are byte-identical to the shipped backfill (ROLLBACK)', pack('05_backfill_PREVIEW_as_shipped_ROLLBACK.sql') === shipped && pack('09_backfill_PREVIEW_again_as_shipped_ROLLBACK.sql') === shipped);
check('06 differs from the shipped backfill ONLY in the last statement (rollback -> commit)', pack('06_backfill_COMMIT.sql') === shipped.replace(/\nrollback;\n$/, '\ncommit;\n') && pack('06_backfill_COMMIT.sql') !== shipped);
check('01 and 03 are the same bytes; 04 and 08 are the same bytes', pack('01_schema_inventory_BEFORE.sql') === pack('03_schema_inventory_AFTER.sql') && pack('04_preview_counts_readonly.sql') === pack('08_preview_counts_readonly_AGAIN.sql'));

// ---- inventory --------------------------------------------------------------------
const inv = async () => {
  const r = await db.query(pack('01_schema_inventory_BEFORE.sql'));
  const rows = r.rows;
  const by = (k) => rows.filter((x) => x.kind === k);
  return { rows, fp: by('FINGERPRINT')[0]?.detail, col: by('column').length, con: by('constraint').length, trg: by('trigger').length, fn: by('function').length, fk: by('foreign_key').length, rls: by('rls') };
};
const b0 = await inv();
check('BEFORE 0236: inventory finds no owner column, constraint, trigger or function (anti-vacuity)', b0.con === 0 && b0.trg === 0 && b0.fn === 0, JSON.stringify({ col: b0.col, con: b0.con, trg: b0.trg, fn: b0.fn }));
// owner_member_id already exists on ii_source_documents since 0032, so the BEFORE count of columns is 1 (that one), not 0.
check('BEFORE 0236: only the pre-existing ii_source_documents.owner_member_id column is reported', b0.col === 1, `columns=${b0.col}`);
check('inventory has a fingerprint row', typeof b0.fp === 'string' && b0.fp.length === 32);

check('02 applies cleanly (first time)', (await errOf(db, pack('02_apply_0236_owner_before_upload_phase1.sql'))) === null);
const a1 = await inv();
check('AFTER one apply: 12 column rows (11 new + the 0032 owner_member_id), 13 constraints, 2 triggers, 2 functions, 4 owner foreign keys (3 new + the 0032 one)', a1.col === 12 && a1.con === 13 && a1.trg === 2 && a1.fn === 2 && a1.fk === 4, JSON.stringify({ col: a1.col, con: a1.con, trg: a1.trg, fn: a1.fn, fk: a1.fk }));
check('the trigger function is security definer and NOT callable by anon / authenticated', a1.rows.some((r) => r.kind === 'function' && r.name === 'owner_before_upload_assert_owner' && /security_definer=true/.test(r.detail) && /anon_can_run=false/.test(r.detail) && /authenticated_can_run=false/.test(r.detail)), JSON.stringify(a1.rows.filter((r) => r.kind === 'function')));
check('FINGERPRINT changed between BEFORE and AFTER (it detects the migration)', a1.fp !== b0.fp);
check('02 applies a SECOND time without error', (await errOf(db, pack('02_apply_0236_owner_before_upload_phase1.sql'))) === null);
const a2 = await inv();
check('after the second apply the FINGERPRINT is identical (nothing added, nothing changed)', a2.fp === a1.fp && a2.rows.length === a1.rows.length);

// negative controls on the fingerprint itself
await db.exec('alter table public.ii_source_documents drop constraint chk_ii_source_documents_owner_role_0236');
const d1 = await inv();
check('CONTROL: one constraint dropped -> 12 constraints and a DIFFERENT fingerprint', d1.con === 12 && d1.fp !== a1.fp, `con=${d1.con}`);
await db.exec(pack('02_apply_0236_owner_before_upload_phase1.sql'));
check('CONTROL: re-applying 02 restores the exact original fingerprint', (await inv()).fp === a1.fp);
await db.exec('drop trigger trg_ii_source_documents_owner_0236 on public.ii_source_documents');
const d2 = await inv();
check('CONTROL: one trigger dropped -> 1 trigger and a DIFFERENT fingerprint', d2.trg === 1 && d2.fp !== a1.fp);
await db.exec(pack('02_apply_0236_owner_before_upload_phase1.sql'));
check('CONTROL: re-applying 02 restores the trigger and the original fingerprint', (await inv()).fp === a1.fp);
await db.exec(`alter table public.ii_source_documents alter column owner_role type varchar(10)`);
check('CONTROL: a changed column type changes the fingerprint (drift is visible)', (await inv()).fp !== a1.fp);
await db.exec(`alter table public.ii_source_documents alter column owner_role type text`);
check('CONTROL: restoring the type restores the fingerprint', (await inv()).fp === a1.fp);

// ---- DEV-shaped fixture (read by Claude on DEV 06-10-2026: 6 legacy uploads; 4 CAS docs) ----------------
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const MEM_A = 'a1111111-1111-4111-8111-111111111111';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
await db.exec(`insert into auth.users(id, email) values ('${A}', 'a@t.test'), ('${B}', 'b@t.test') on conflict do nothing`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${A}','${B}')`);
await db.exec(`insert into household_members(id, user_id, full_name, relationship) values ('${MEM_A}', '${A}', 'Anil A', 'self'), ('${MEM_B}', '${B}', 'Bob B', 'self')`);
const up = (extra = '') => `insert into fdh_statement_uploads (user_id, source_type, document_type${extra ? ', ' + extra.split('|')[0] : ''}) values ('${A}', 'csv', 'bank_statement'${extra ? ', ' + extra.split('|')[1] : ''})`;
const doc = (cols, vals) => `insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, document_type${cols ? ', ' + cols : ''}) values ('${A}', 'IN', 'uploaded', 'k/${Math.random()}', 'f.pdf', 'application/pdf', 10, 'cas_statement'${vals ? ', ' + vals : ''})`;
for (let i = 0; i < 6; i++) await db.exec(up());
await db.exec(doc('owner_member_id', `'${MEM_A}'`));
await db.exec(doc('owner_member_id', `'${MEM_A}'`));
await db.exec(doc('', ''));
await db.exec(doc('owner_member_id, owner_role, owner_selection_source', `'${MEM_A}', 'self', 'user_selected'`));

const counts = async (file) => Object.fromEntries((await db.query(pack(file))).rows.map((r) => [r.what, Number(r.n)]));
const c04 = await counts('04_preview_counts_readonly.sql');
const expectDev = { 'fdh_statement_uploads: total': 6, 'fdh_statement_uploads: will copy the owner of the matched account': 0, 'fdh_statement_uploads: will be marked legacy_unset': 6, 'ii_source_documents: total': 4, 'ii_source_documents: will copy the owner member': 2, 'ii_source_documents: will be marked legacy_unset': 1 };
check('04 on the DEV-shaped fixture gives exactly the numbers the README predicts for DEV', JSON.stringify(c04) === JSON.stringify(expectDev), JSON.stringify(c04));
// 04 is the same preview as the shipped script's own first statement: compare against it by running that statement.
{
  const shippedPreview = shipped.slice(shipped.indexOf('select \'fdh_statement_uploads: total\''), shipped.indexOf('-- ---------------------------------------------------------------------------\n-- 1.'));
  const r = (await db.query(shippedPreview)).rows.map((x) => Number(x.n));
  check('04 equals the shipped script\'s own preview numbers, line for line', JSON.stringify(r) === JSON.stringify(Object.values(c04)), JSON.stringify(r));
}
// does the preview react to the data? (so a constant 0 can never pass)
await db.exec(`insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name, status, owner_role) values ('c1111111-1111-4111-8111-111111111111', '${A}', 'transaction', 'AU', 'AUD', 'x', 'active', 'smsf')`);
await db.exec(up('financial_account_id|\'c1111111-1111-4111-8111-111111111111\''));
const cMoved = await counts('04_preview_counts_readonly.sql');
check('CONTROL: a seeded statement with an owned account moves the will-copy count to 1 (the preview is not a constant)', cMoved['fdh_statement_uploads: will copy the owner of the matched account'] === 1, JSON.stringify(cMoved));
await db.exec(`delete from fdh_statement_uploads where financial_account_id is not null`);
await db.exec(`delete from fdh_financial_accounts`);

// ---- run the shipped script, ROLLBACK, then COMMIT -------------------------------------
const snap = async () => JSON.stringify([(await db.query(`select id, owner_member_id, owner_role, owner_selection_source from fdh_statement_uploads order by id`)).rows, (await db.query(`select id, owner_member_id, owner_role, owner_selection_source from ii_source_documents order by id`)).rows]);
const s0 = await snap();
check('05 (shipped, ROLLBACK) runs', (await errOf(db, pack('05_backfill_PREVIEW_as_shipped_ROLLBACK.sql'))) === null);
check('05 persisted nothing (state identical before and after)', (await snap()) === s0);
const state = async () => (await db.query(pack('07_state_after_backfill_readonly.sql'))).rows;
const pre = await state();
check('07 BEFORE the commit shows unbackfilled rows (so it can detect them)', pre.some((r) => r.source === 'unbackfilled'));
const userSelected = (await db.query(`select id, owner_member_id, owner_role, owner_selection_source, owner_allocation from ii_source_documents where owner_selection_source = 'user_selected'`)).rows;
check('06 (COMMIT) runs', (await errOf(db, pack('06_backfill_COMMIT.sql'))) === null);
const post = await state();
const find = (t, s, r) => post.find((x) => x.tbl === t && x.source === s && x.role === r);
check('07 AFTER: no unbackfilled row on either table', !post.some((r) => r.source === 'unbackfilled'), JSON.stringify(post));
check('07 AFTER: 6 bank documents legacy_unset with no role (nothing became Self)', Number(find('fdh_statement_uploads', 'legacy_unset', '(no role)')?.n) === 6, JSON.stringify(post));
check('07 AFTER: 2 CAS documents backfill_from_document with the member role self', Number(find('ii_source_documents', 'backfill_from_document', 'self')?.n) === 2);
check('07 AFTER: 1 CAS document with no member is legacy_unset and has NO role (never Self)', Number(find('ii_source_documents', 'legacy_unset', '(no role)')?.n) === 1);
check('07 AFTER: the user_selected row is still user_selected / self', Number(find('ii_source_documents', 'user_selected', 'self')?.n) === 1);
const userSelected2 = (await db.query(`select id, owner_member_id, owner_role, owner_selection_source, owner_allocation from ii_source_documents where owner_selection_source = 'user_selected'`)).rows;
check('the user_selected row is byte-for-byte unchanged by the backfill', JSON.stringify(userSelected) === JSON.stringify(userSelected2));
const c08 = await counts('08_preview_counts_readonly_AGAIN.sql');
check('08 AFTER the commit: every will-line is 0 (totals unchanged)', Object.entries(c08).every(([k, v]) => (/total/.test(k) ? v === (k.startsWith('fdh') ? 6 : 4) : v === 0)), JSON.stringify(c08));
const s1 = await snap();
check('09 (shipped again, ROLLBACK) runs and changes nothing', (await errOf(db, pack('09_backfill_PREVIEW_again_as_shipped_ROLLBACK.sql'))) === null && (await snap()) === s1);
check('a second COMMIT run changes nothing (idempotent)', (await errOf(db, pack('06_backfill_COMMIT.sql'))) === null && (await snap()) === s1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
