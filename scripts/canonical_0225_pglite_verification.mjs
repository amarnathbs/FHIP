// AIE-1 / Approved Upload -> Canonical programme, FINAL PRODUCTION CLOSURE
// mission part 3 (2026-09-28) -- PGlite verification for migration
// 0225_aie1_canonical_close_section11_intake_insert_forgery.sql.
//
// Anti-vacuity: an authenticated user's direct PostgREST-shaped INSERT into
// aie_document_intake claiming malware_scan_status='clean' from the start
// SUCCEEDS before 0225 (the gap 0196 left open -- 0196 only guarded
// fdh_statement_uploads / ii_source_documents, and only reasoned about the
// UPDATE path for aie_document_intake), then is REFUSED (42501) after 0225,
// exactly mirroring 0196's own INSERT-time guard for its two sibling tables.
// A legitimate insert (server-default 'received' / 'not_required') still
// succeeds unchanged, and 0196's pre-existing UPDATE guard on the two
// sibling tables is re-confirmed unaffected by this migration.
//
// Run: node scripts/canonical_0225_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0225_aie1_canonical_close_section11_intake_insert_forgery.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function replayUpToTarget() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (f >= TARGET) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const errorOf = async (db, sql, params) => { try { if (params) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e.message; } };
const errCodeOf = async (db, sql, params) => { try { if (params) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e.code ?? e.message; } };

async function asUser(db, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

const A = '11111111-1111-1111-1111-111111111111';

async function seed(db) {
  await db.exec(`insert into auth.users(id, email) values ('${A}', 'a@t.test') on conflict do nothing`);
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${A}'`);
}

console.log('AIE-1/Canonical closure part 3 -- 0225 aie_document_intake insert-forgery verification');
{
  const db = await replayUpToTarget();
  await seed(db);

  // =========================================================================
  // ANTI-VACUITY: BEFORE 0225, an authenticated user can insert a row that
  // claims malware_scan_status='clean' from the start.
  // =========================================================================
  const forgedBefore = await asUser(db, A, () => errCodeOf(db,
    `insert into aie_document_intake (user_id, status, declared_mime_type, byte_size, storage_key, malware_scan_status)
     values ($1, 'quarantined', 'application/pdf', 1024, 'forged/storage/key.bin', 'clean')`, [A]));
  check('anti-vacuity: BEFORE 0225 an authenticated INSERT claiming malware_scan_status=clean succeeds', forgedBefore === null, String(forgedBefore));
  await db.exec(`delete from aie_document_intake where user_id = '${A}'`);

  // Legitimate insert also succeeds before 0225 (sanity: the table itself
  // isn't broken pre-fix).
  const legitBefore = await asUser(db, A, () => errCodeOf(db,
    `insert into aie_document_intake (user_id, status, declared_mime_type, byte_size) values ($1, 'received', 'application/pdf', 1024)`, [A]));
  check('sanity: BEFORE 0225 a legitimate default-status insert succeeds', legitBefore === null, String(legitBefore));
  await db.exec(`delete from aie_document_intake where user_id = '${A}'`);

  // =========================================================================
  // APPLY 0225.
  // =========================================================================
  const applyErr = await errorOf(db, target);
  check('0225 applies cleanly', applyErr === null, applyErr ?? '');

  // =========================================================================
  // AFTER 0225: the same forgery is refused with the same 42501 code 0196
  // already uses for the sibling tables.
  // =========================================================================
  const forgedAfter = await asUser(db, A, () => errCodeOf(db,
    `insert into aie_document_intake (user_id, status, declared_mime_type, byte_size, storage_key, malware_scan_status)
     values ($1, 'quarantined', 'application/pdf', 1024, 'forged/storage/key2.bin', 'clean')`, [A]));
  check('AFTER 0225: the same malware_scan_status=clean forgery at INSERT is REFUSED (42501)', forgedAfter === '42501', String(forgedAfter));

  const forgedObjectRefAfter = await asUser(db, A, () => errCodeOf(db,
    `insert into aie_document_intake (user_id, status, declared_mime_type, byte_size, malware_scan_object_ref)
     values ($1, 'received', 'application/pdf', 1024, '{"bucket":"x","key":"y"}'::jsonb)`, [A]));
  check('AFTER 0225: forging malware_scan_object_ref at INSERT is ALSO refused', forgedObjectRefAfter === '42501', String(forgedObjectRefAfter));

  // Legitimate insert (matching lib/aie/db/repository.ts's createIntake --
  // status:'received', no malware_scan_* columns set) still succeeds.
  const legitAfter = await asUser(db, A, () => errCodeOf(db,
    `insert into aie_document_intake (user_id, status, declared_mime_type, byte_size, display_filename, source_module_hint)
     values ($1, 'received', 'application/pdf', 2048, 'statement.pdf', 'fdh_bank')`, [A]));
  check('AFTER 0225: the real application insert shape (createIntake) still succeeds unchanged', legitAfter === null, String(legitAfter));
  const legitRow = await one(db, `select status, malware_scan_status from aie_document_intake where user_id = $1 order by created_at desc limit 1`, [A]);
  check('...and lands with the honest server defaults (received / not_required)', legitRow.status === 'received' && legitRow.malware_scan_status === 'not_required', JSON.stringify(legitRow));

  // The server (service_role, RLS-bypassing) must still be able to progress
  // the real scan-state machine -- this migration must not lock the server
  // itself out.
  await db.exec('set role service_role');
  const serverUpdateErr = await errorOf(db, `update aie_document_intake set malware_scan_status = 'clean', malware_scan_decided_at = now() where user_id = '${A}' and status = 'received'`);
  await db.exec('reset role');
  check('the server (service_role) can still legitimately record a real scan verdict', serverUpdateErr === null, serverUpdateErr ?? '');

  // =========================================================================
  // REGRESSION: 0196's own guard on the two sibling tables is unaffected by
  // this migration (CREATE OR REPLACE keeps their behaviour byte-identical).
  // =========================================================================
  await db.exec(`
    insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name)
      values ('b0000000-0000-0000-0000-000000000001', '${A}', 'transaction', 'AU', 'AUD', 'Acc A');
    insert into fdh_statement_uploads (id, user_id, financial_account_id, source_type, document_type, country_code, currency_code, processing_status, malware_scan_status)
      values ('b1000000-0000-0000-0000-000000000001', '${A}', 'b0000000-0000-0000-0000-000000000001', 'csv', 'bank_statement', 'AU', 'AUD', 'queued', 'malicious');
  `);
  const siblingForgeAfter = await asUser(db, A, () => errCodeOf(db,
    `update fdh_statement_uploads set malware_scan_status = 'clean' where id = 'b1000000-0000-0000-0000-000000000001'`));
  check('REGRESSION: fdh_statement_uploads UPDATE-forgery guard (0196) still refuses (42501), unaffected by 0225', siblingForgeAfter === '42501', String(siblingForgeAfter));
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0 || pass < 8) { console.error('FAIL: insufficient or failing checks (anti-vacuity threshold not met)'); process.exit(1); }
process.exit(0);
