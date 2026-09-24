// AIE-1 final production completion -- PGlite verification for migration 0197
// (fdh_ai_fallback_drafts: durable, server-written, confirm-once AI drafts).
//
// Negative control first: before 0197 there is NO durable place for an AI
// draft, which is the defect (the draft lived only in the HTTP response).
// After 0197 we require: the owner can read but never write drafts; a second
// pending draft for the same document is refused; the confirm-once claim is a
// single conditional UPDATE that a replay cannot repeat; another tenant sees
// nothing; deleting the document removes its drafts.
//
// Run: node scripts/aie1_0197_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0197_fdh_ai_fallback_drafts.sql';

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
console.log('chain replayed up to 0196 -- 0197 NOT yet applied\n');

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `AIE1-0197-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const attempt = async (fn) => { try { const r = await fn(); return { ok: true, r }; } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 120) }; } };

const A = 'aaaa0000-0000-0000-0000-000000000197';
const B = 'bbbb0000-0000-0000-0000-000000000197';
await db.exec(`insert into auth.users(id,email) values ('${A}','a-0197@t.test'),('${B}','b-0197@t.test');`);
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${A}','${B}');`);
async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try { return await fn(); } finally { await db.exec('reset role;'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}

console.log('NEGATIVE CONTROL (before 0197):');
{
  const t = await q(`select to_regclass('public.fdh_ai_fallback_drafts') r`);
  check('CONTROL: before 0197 there is no durable store for an AI draft (the draft lived only in the HTTP response)', t[0].r === null);
}

console.log('\nAPPLYING 0197');
await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

console.log('\nAFTER 0197:');
const doc = (await q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, processing_status) values ('${A}','pdf_native','payslip','AU','AUD','processing') returning id`))[0].id;
const payload = { grossPay: 3200, netPay: 2488, payFrequency: 'fortnightly', country: 'AU', currencyCode: 'AUD' };

const d1 = (await q(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1,$2,'payslip','aie_payslip_document_facts','1',$3) returning id`, [A, doc, JSON.stringify(payload)]))[0].id;
check('server can persist a draft', !!d1);

const dup = await attempt(() => q(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1,$2,'payslip','s','1','{}')`, [A, doc]));
check('a second PENDING draft for the same document is refused (one pending per document)', !dup.ok, dup.message ?? '');

const ownerRead = await as(A, () => q(`select id, status from fdh_ai_fallback_drafts where statement_upload_id=$1`, [doc]));
check('the owner can read their draft', ownerRead.length === 1 && ownerRead[0].status === 'pending_review');
const otherRead = await as(B, () => q(`select id from fdh_ai_fallback_drafts where statement_upload_id=$1`, [doc]));
check('another tenant sees nothing', otherRead.length === 0);

const ownerInsert = await as(A, () => attempt(() => q(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1,$2,'payslip','s','1','{}')`, [A, doc])));
check('the owner can NOT mint a draft (server-only writer)', !ownerInsert.ok, ownerInsert.message ?? '');
const ownerUpdate = await as(A, () => attempt(() => q(`update fdh_ai_fallback_drafts set payload='{"grossPay":999999}'::jsonb where id=$1 returning id`, [d1])));
check('the owner can NOT edit the issued draft', !ownerUpdate.ok || (ownerUpdate.r ?? []).length === 0, ownerUpdate.message ?? `rows=${(ownerUpdate.r ?? []).length}`);
const ownerDelete = await as(A, () => attempt(() => q(`delete from fdh_ai_fallback_drafts where id=$1 returning id`, [d1])));
check('the owner can NOT delete the issued draft', !ownerDelete.ok || (ownerDelete.r ?? []).length === 0, ownerDelete.message ?? '');
const anonRead = await (async () => { await db.exec('set role anon;'); try { return await attempt(() => q(`select id from fdh_ai_fallback_drafts`)); } finally { await db.exec('reset role;'); } })();
check('anon has no access at all', !anonRead.ok, anonRead.message ?? '');

const claim = `update fdh_ai_fallback_drafts set status='confirmed', confirmed_at=now(), confirmed_payload=$3 where statement_upload_id=$1 and user_id=$2 and status='pending_review' returning id`;
const c1 = await q(claim, [doc, A, JSON.stringify({ ...payload, grossPay: 3250 })]);
const c2 = await q(claim, [doc, A, JSON.stringify(payload)]);
check('confirm-once: the first claim takes the draft', c1.length === 1);
check('confirm-once: a REPLAYED claim finds nothing pending and writes nothing', c2.length === 0);
const after = (await q(`select status, confirmed_payload from fdh_ai_fallback_drafts where id=$1`, [d1]))[0];
check('the confirmed payload recorded is the FIRST confirmation (user correction kept), not the replay', after.status === 'confirmed' && after.confirmed_payload.grossPay === 3250, JSON.stringify(after));
const crossClaim = await q(claim, [doc, B, '{}']);
check('a claim scoped to another user id matches nothing', crossClaim.length === 0);

const badConfirm = await attempt(() => q(`update fdh_ai_fallback_drafts set status='confirmed', confirmed_at=null where id=$1`, [d1]));
check("CHECK: a 'confirmed' draft must carry confirmed_at", !badConfirm.ok, badConfirm.message ?? '');

const d2 = await attempt(() => q(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1,$2,'payslip','s','1','{}') returning id`, [A, doc]));
check('after confirmation a NEW pending draft is allowed again (e.g. a later re-process)', d2.ok);

await q(`delete from fdh_statement_uploads where id=$1`, [doc]);
const left = await q(`select count(*)::int n from fdh_ai_fallback_drafts where statement_upload_id=$1`, [doc]);
check('deleting the document removes its drafts (on delete cascade)', left[0].n === 0);

let reapplied = true;
try { await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8')); } catch (e) { reapplied = false; console.log('        ' + e.message); }
check('0197 re-applies cleanly (idempotent)', reapplied);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
