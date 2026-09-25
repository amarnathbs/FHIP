// AIE-1 final production completion -- PGlite verification for migration 0196
// (malware-scan verdict integrity + ii_source_documents real-scan columns).
//
// Method: replay the chain up to (not including) 0196, prove as a NEGATIVE
// CONTROL that an authenticated owner can forge the verdict on their own
// fdh_statement_uploads row (the defect, also proven live in DEV by
// scripts/aie1_malware_column_forgery_live_dev_probe.mjs), then apply 0196 and
// require every forgery to be refused while the server (service_role) and the
// ordinary owner flows keep working.
//
// Run: node scripts/aie1_0196_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0196_malware_scan_verdict_integrity_and_ii_scan_columns.sql';

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes(TARGET)) throw new Error(`target ${TARGET} missing`);
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
for (const f of files.filter((x) => x < TARGET)) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('chain replayed up to 0195 -- 0196 NOT yet applied\n');

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `AIE1-0196-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const U = 'aaaa0000-0000-0000-0000-000000000196';
await db.exec(`insert into auth.users(id,email) values ('${U}','aie1-0196@t.test');`);
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${U}';`);

async function asOwner(fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try { return await fn(); } finally { await db.exec('reset role;'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}
async function attempt(fn) {
  try { await fn(); return { ok: true }; } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 120) }; }
}
async function seedBlockedFdh() {
  const r = await q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, processing_status, error_code, malware_scan_status)
    values ('${U}','pdf_native','payslip','AU','AUD','failed','malware_detected','malicious') returning id`);
  return r[0].id;
}

// --- NEGATIVE CONTROL ------------------------------------------------------
console.log('NEGATIVE CONTROL (before 0196):');
{
  const id = await seedBlockedFdh();
  const r1 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set malware_scan_status='clean' where id=$1`, [id])));
  const r2 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set error_code=null where id=$1`, [id])));
  const after = (await q(`select malware_scan_status s, error_code e from fdh_statement_uploads where id=$1`, [id]))[0];
  check('CONTROL: before 0196 the owner CAN flip malicious -> clean and clear malware_detected', r1.ok && r2.ok && after.s === 'clean' && after.e === null, JSON.stringify({ r1, r2, after }));
  const cols = await q(`select column_name from information_schema.columns where table_name='ii_source_documents' and column_name like 'malware_scan%'`);
  check('CONTROL: before 0196 ii_source_documents has no real-scan columns', cols.length === 0, `columns=${cols.length}`);
}

// --- APPLY 0196 ------------------------------------------------------------
console.log('\nAPPLYING 0196');
await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

console.log('\nAFTER 0196:');
{
  const id = await seedBlockedFdh();
  const r1 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set malware_scan_status='clean' where id=$1`, [id])));
  check('owner can NOT rewrite fdh malware_scan_status', !r1.ok, r1.message);
  const r2 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set error_code=null where id=$1`, [id])));
  check('owner can NOT clear a malware_detected error code', !r2.ok, r2.message);
  const r3 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set malware_scan_object_ref='{"ref":null}'::jsonb where id=$1`, [id])));
  check('owner can NOT rewrite the scan object reference', !r3.ok, r3.message);
  const r4 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set malware_scan_decided_at=now() where id=$1`, [id])));
  check('owner can NOT rewrite the decision timestamp', !r4.ok, r4.message);
  const after = (await q(`select malware_scan_status s, error_code e from fdh_statement_uploads where id=$1`, [id]))[0];
  check('the blocked verdict is intact after every attempt', after.s === 'malicious' && after.e === 'malware_detected', JSON.stringify(after));

  const r5 = await asOwner(() => attempt(() => q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, malware_scan_status) values ('${U}','pdf_native','payslip','AU','AUD','clean')`)));
  check('owner can NOT insert a row that claims to be pre-scanned clean', !r5.ok, r5.message);
  const r6 = await asOwner(() => attempt(() => q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code) values ('${U}','pdf_native','payslip','AU','AUD') returning id`)));
  check('owner CAN still create an ordinary upload row (defaults) -- no regression to createUploadSession', r6.ok, r6.message ?? '');

  // Ordinary owner updates that do not touch the verdict still work.
  const plain = (await q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, processing_status) values ('${U}','pdf_native','payslip','AU','AUD','created') returning id`))[0].id;
  const r7 = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set original_filename_sanitised='x.pdf' where id=$1`, [plain])));
  check('owner CAN still update non-verdict columns on their own row', r7.ok, r7.message ?? '');
  const r7b = await asOwner(() => attempt(() => q(`update fdh_statement_uploads set error_code='file_corrupt' where id=$1`, [plain])));
  check('owner-context writes of a NON-malware error code still work (structural rejection path)', r7b.ok, r7b.message ?? '');

  // The server (service_role / no JWT) is unaffected.
  const r8 = await attempt(() => q(`update fdh_statement_uploads set malware_scan_status='clean', error_code=null where id=$1`, [id]));
  check('server (no authenticated JWT) CAN still record a verdict', r8.ok, r8.message ?? '');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  const r9 = await attempt(() => q(`update fdh_statement_uploads set malware_scan_status='malicious' where id=$1`, [id]));
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  check('service_role JWT CAN still record a verdict', r9.ok, r9.message ?? '');
}
{
  const cols = await q(`select column_name, column_default from information_schema.columns where table_name='ii_source_documents' and column_name like 'malware_scan%' order by column_name`);
  check('ii_source_documents now has the four real-scan columns', cols.length === 4, cols.map((c) => c.column_name).join(','));
  const def = cols.find((c) => c.column_name === 'malware_scan_status')?.column_default ?? '';
  check("ii_source_documents.malware_scan_status defaults to 'not_required'", def.includes('not_required'), def);
  let bad = false;
  try { await q(`insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, malware_scan_status) values ('${U}','IN','uploaded','k/x.pdf','x.pdf','application/pdf',1,'bogus')`); } catch { bad = true; }
  check('ii_source_documents rejects an unknown scan status (CHECK)', bad);

  const ii = (await q(`insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, malware_scan_status) values ('${U}','IN','uploaded','k/y.pdf','y.pdf','application/pdf',1,'malicious') returning id`))[0].id;
  const r1 = await asOwner(() => attempt(() => q(`update ii_source_documents set malware_scan_status='clean' where id=$1`, [ii])));
  check('owner can NOT rewrite ii_source_documents malware_scan_status', !r1.ok, r1.message);
  const r2 = await asOwner(() => attempt(() => q(`insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, malware_scan_status) values ('${U}','IN','uploaded','k/z.pdf','z.pdf','application/pdf',1,'clean')`)));
  check('owner can NOT insert an ii_source_documents row claiming clean', !r2.ok, r2.message);
  const r3 = await asOwner(() => attempt(() => q(`insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size) values ('${U}','IN','uploaded','k/w.pdf','w.pdf','application/pdf',1)`)));
  check('owner CAN still insert an ordinary ii_source_documents row (upload route shape)', r3.ok, r3.message ?? '');
  const r4 = await asOwner(() => attempt(() => q(`update ii_source_documents set status='parsed' where id=$1`, [ii])));
  check('owner CAN still update non-verdict ii_source_documents columns', r4.ok, r4.message ?? '');
}
{
  let reapplied = true;
  try { await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8')); } catch (e) { reapplied = false; console.log('        ' + e.message); }
  check('0196 re-applies cleanly (idempotent)', reapplied);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
