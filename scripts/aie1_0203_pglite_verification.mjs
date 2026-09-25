// AIE other-PDF AI proof (2026-09-25) -- PGlite verification for migration
// 0202 (ii_ai_extraction_reviews: owner reads, server writes).
//
// NEGATIVE CONTROL FIRST, and it must demonstrably break something: with the
// chain replayed up to (and including) 0160 but WITHOUT 0202, the owner can,
// through their own authenticated role, (a) mint a review row no upload or AI
// call produced and (b) flip an ACCEPTED review back to pending_review, which
// would let the application accept (write canonical rows from) it again. Each
// is asserted to SUCCEED before 0202 and to FAIL after it.
//
// Run: node scripts/aie1_0202_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0202_ii_ai_extraction_reviews_server_write_only.sql';

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes(TARGET)) throw new Error(`target ${TARGET} missing`);
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const before = files.filter((x) => x < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`chain replayed (${before.length} files, last ${before[before.length - 1]}) -- 0202 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `AIE1-0202-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const attempt = async (fn) => { try { const r = await fn(); return { ok: true, r }; } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 140) }; } };

const A = 'aaaa0000-0000-0000-0000-000000000202';
const B = 'bbbb0000-0000-0000-0000-000000000202';
await db.exec(`insert into auth.users(id,email) values ('${A}','a-0202@t.test'),('${B}','b-0202@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${A}','${B}');`);
async function as(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try { return await fn(); } finally { await db.exec('reset role;'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}

const docA = (await q(`insert into ii_source_documents (user_id, country_code, storage_path, original_filename, mime_type, file_size, status) values ($1,'IN','u/a.pdf','a.pdf','application/pdf',100,'ai_review_pending') returning id`, [A]))[0].id;
const holdings = JSON.stringify([{ schemeName: 'Synthetic Fund', isin: null, amcName: 'Synthetic AMC', folioNumber: 'SYN-1', costValue: 1000, marketValue: 1100, units: 10, asOfDateIso: '2026-08-31', transactions: [] }]);
const insertAs = (uid) => attempt(() => q(`insert into ii_ai_extraction_reviews (user_id, source_document_id, trigger_reason, status, extracted_holdings) values ($1,$2,'format_unrecognized','pending_review',$3) returning id`, [uid, docA, holdings]));

console.log('NEGATIVE CONTROL (0160 applied, 0202 NOT):');
const t = await q(`select to_regclass('public.ii_ai_extraction_reviews') r`);
check('CONTROL: 0160 is in the chain (the table exists)', t[0].r !== null);
const forged = await as(A, () => insertAs(A));
check('CONTROL: the owner CAN mint a review row no AI call produced (the defect)', forged.ok && forged.r.length === 1, forged.message ?? '');
const serverReview = (await q(`insert into ii_ai_extraction_reviews (user_id, source_document_id, trigger_reason, status, extracted_holdings, decided_at, decided_by) values ($1,$2,'format_unrecognized','accepted',$3, now(), $1) returning id`, [A, docA, holdings]))[0].id;
const flip = await as(A, () => attempt(() => q(`update ii_ai_extraction_reviews set status='pending_review', decided_at=null where id=$1 returning id`, [serverReview])));
check('CONTROL: the owner CAN flip an accepted review back to pending_review (re-accept door)', flip.ok && flip.r.length === 1, flip.message ?? '');
await q(`update ii_ai_extraction_reviews set status='accepted', decided_at=now() where id=$1`, [serverReview]);
await q(`delete from ii_ai_extraction_reviews where status='pending_review'`);

console.log('\nAPPLYING 0202');
await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

console.log('\nAFTER 0202:');
const forged2 = await as(A, () => insertAs(A));
check('the owner can NOT mint a review row', !forged2.ok, forged2.message ?? '');
const flip2 = await as(A, () => attempt(() => q(`update ii_ai_extraction_reviews set status='pending_review', decided_at=null where id=$1 returning id`, [serverReview])));
check('the owner can NOT flip an accepted review back to pending_review', !flip2.ok || flip2.r.length === 0, flip2.message ?? `rows=${flip2.r?.length}`);
const edit2 = await as(A, () => attempt(() => q(`update ii_ai_extraction_reviews set extracted_holdings='[]'::jsonb where id=$1 returning id`, [serverReview])));
check('the owner can NOT rewrite staged holdings', !edit2.ok || edit2.r.length === 0, edit2.message ?? '');
const del2 = await as(A, () => attempt(() => q(`delete from ii_ai_extraction_reviews where id=$1 returning id`, [serverReview])));
check('the owner can NOT delete a review', !del2.ok || del2.r.length === 0, del2.message ?? '');
const stillAccepted = (await q(`select status from ii_ai_extraction_reviews where id=$1`, [serverReview]))[0];
check('the accepted review is untouched by every owner attempt', stillAccepted.status === 'accepted');

const ownerRead = await as(A, () => q(`select id, status from ii_ai_extraction_reviews where id=$1`, [serverReview]));
check('the owner CAN still read their review (the review panel GET)', ownerRead.length === 1);
const otherRead = await as(B, () => q(`select id from ii_ai_extraction_reviews`));
check('another tenant sees nothing', otherRead.length === 0);
await db.exec('set role anon;');
const anonRead = await attempt(() => q(`select id from ii_ai_extraction_reviews`));
await db.exec('reset role;');
check('anon has no access', !anonRead.ok, anonRead.message ?? '');

const staged = (await q(`insert into ii_ai_extraction_reviews (user_id, source_document_id, trigger_reason, status, extracted_holdings) values ($1,$2,'format_unrecognized','pending_review',$3) returning id`, [A, docA, holdings]))[0].id;
check('the server (service role) can still stage a review', !!staged);
const claim = `update ii_ai_extraction_reviews set status='accepted', decided_at=now(), decided_by=$2 where id=$1 and user_id=$2 and status='pending_review' returning id`;
const c1 = await q(claim, [staged, A]);
const c2 = await q(claim, [staged, A]);
check('accept-once: the first claim takes the review', c1.length === 1);
check('accept-once: a replayed claim finds nothing pending and writes nothing', c2.length === 0);

const statusCheck = await attempt(() => q(`update ii_source_documents set status='ai_review_pending' where id=$1 returning id`, [docA]));
check("0202 touches no CHECK: ii_source_documents still accepts 0160's 'ai_review_pending'", statusCheck.ok && statusCheck.r.length === 1, statusCheck.message ?? '');

let reapplied = true;
try { await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8')); } catch (e) { reapplied = false; console.log('        ' + e.message); }
check('0202 re-applies cleanly (idempotent)', reapplied);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
