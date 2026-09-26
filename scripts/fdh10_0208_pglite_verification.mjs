// FDH-10 migration 0208 — `fdh10_persist_liability_statement` verified against
// a freshly rebuilt REAL Postgres (PGlite/WASM) with every migration applied,
// using the same auth.uid()/`set role authenticated` technique as
// scripts/mcc_pglite_certification.mjs.
//
// Why PGlite: this machine has PostgREST keys for DEV but no database
// connection string or management token, so 0208 cannot be applied to DEV
// from here. This proves the SQL itself — real CHECK constraints, real RLS,
// real 0096/0108 triggers — ahead of the operator applying it.
//
// Section 1 is the NEGATIVE CONTROL: the pre-fix write sequence (separate
// statements) on the same real schema leaves an orphan statement row, i.e.
// the DEV incident of 2026-09-25 reproduces here. Every later section must
// then show the RPC does not.
//
// Run: node scripts/fdh10_0208_pglite_verification.mjs   (exit 0 = all pass)
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes('0208_fdh10_atomic_liability_statement_persist.sql')) {
  console.error('FAIL  migration 0208 not found — nothing to verify');
  process.exit(2);
}
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete (${files.length} migrations, last ${files[files.length - 1]})\n`);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function asRole(role, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role;'); }
}
const asTenant = (uid, fn) => asRole('authenticated', uid, fn);
const attempt = async (fn) => { try { return { ok: true, value: await fn() } } catch (e) { return { ok: false, message: e.message } } };

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333'; // never confirms a country
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test'),('${C}','c@t.test');`);
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id in ('${A}','${B}')`);

async function newUpload(uid) {
  const { rows } = await db.query(
    `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status)
     values ($1,'csv','credit_card_statement','AU','AUD','text/csv','queued') returning id`, [uid]);
  return rows[0].id;
}
const counts = async (docId) => (await db.query(
  `select (select count(*)::int from fdh_liability_statements where statement_upload_id=$1) s,
          (select count(*)::int from fdh_liability_statement_activities a join fdh_liability_statements st on st.id=a.statement_id where st.statement_upload_id=$1) a,
          (select processing_status from fdh_statement_uploads where id=$1) p`, [docId])).rows[0];

const STATEMENT = {
  statement_type: 'credit_card', facility_type: 'credit_card', country_code: 'AU', currency_code: 'AUD',
  purchases_total: 85.4, payments_total: 200, reconciliation_status: 'insufficient_data',
  parser_name: 'fdh10_generic_liability_csv', parser_version: '1.0.0', extraction_confidence: 0.7, review_status: 'pending',
};
const act = (amount, row, extra = {}) => ({
  activity_type: 'PURCHASE', activity_date: '2026-07-05', amount, currency_code: 'AUD',
  bank_match_status: 'not_attempted', review_status: 'not_required', source_row_number: row, ...extra,
});
const rpc = (uid, docId, statement, activities) => asTenant(uid, () => db.query(
  `select fdh10_persist_liability_statement($1::uuid, $2::jsonb, $3::jsonb) r`,
  [docId, JSON.stringify(statement), JSON.stringify(activities)])).then((x) => x.rows[0].r);

console.log('=== 1. NEGATIVE CONTROL: the pre-fix separate-statement sequence orphans a statement on real Postgres ===');
{
  const doc = await newUpload(A);
  const stmt = await attempt(() => asTenant(A, () => db.query(
    `insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code)
     values ($1,$2,'credit_card','credit_card','AU','AUD') returning id`, [A, doc])));
  check('pre-fix step 1: statement INSERT commits on its own', stmt.ok, stmt.message ?? '');
  const zero = await attempt(() => asTenant(A, () => db.query(
    `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code)
     values ($1,$2,'PURCHASE','2026-07-01',0,'AUD')`, [A, stmt.value.rows[0].id])));
  check('pre-fix step 2: zero-amount activity INSERT fails on the named CHECK',
    !zero.ok && /fdh_liability_statement_activities_amount_check/.test(zero.message), zero.message ?? '');
  const c = await counts(doc);
  check('pre-fix result: ORPHAN — 1 statement row, 0 activities, document still queued (the DEV incident)', c.s === 1 && c.a === 0 && c.p === 'queued', JSON.stringify(c));

  const jump = await attempt(() => asTenant(A, () => db.query(
    `update fdh_statement_uploads set processing_status='extracted' where id=$1`, [doc])));
  check('pre-fix final step: the direct queued -> extracted UPDATE is refused by the 0076 guard (why DEV upload 33f47e18 is stuck queued)',
    !jump.ok && /queued -> extracted is not permitted/.test(jump.message), jump.message ?? 'UPDATE SUCCEEDED');

  const retry = await rpc(A, doc, STATEMENT, [act(85.4, 2)]);
  check('the RPC refuses to add a second statement next to that orphan (EVIDENCE_EXISTS)', retry.ok === false && retry.code === 'EVIDENCE_EXISTS', JSON.stringify(retry));
  check('...and the orphan is still the only row', (await counts(doc)).s === 1);
}

console.log('\n=== 2. The RPC is all-or-nothing ===');
{
  const doc = await newUpload(A);
  const r = await attempt(() => rpc(A, doc, STATEMENT, [act(85.4, 2), act(0, 1)]));
  check('a zero-amount activity makes the RPC raise the same named CHECK', !r.ok && /fdh_liability_statement_activities_amount_check/.test(r.message), r.message ?? '');
  let c = await counts(doc);
  check('...and NOTHING is committed: 0 statements, 0 activities, document still queued', c.s === 0 && c.a === 0 && c.p === 'queued', JSON.stringify(c));

  const split = await attempt(() => rpc(A, doc, STATEMENT, [act(85.4, 2), act(100, 3, { activity_type: 'PAYMENT', principal_component: 90, interest_component: 20 })]));
  check('a non-zero failure (decomposition CHECK on the LAST activity) also raises', !split.ok && /chk_fdh_liability_activities_decomposition_sum/.test(split.message), split.message ?? '');
  c = await counts(doc);
  check('...and also commits nothing', c.s === 0 && c.a === 0 && c.p === 'queued', JSON.stringify(c));

  const good = await rpc(A, doc, STATEMENT, [act(85.4, 2), act(200, 3, { activity_type: 'PAYMENT' })]);
  check('a valid persist returns ok with activity_count 2', good.ok === true && good.activity_count === 2 && typeof good.statement_id === 'string', JSON.stringify(good));
  c = await counts(doc);
  check('...1 statement, 2 activities, document extracted — in the same transaction', c.s === 1 && c.a === 2 && c.p === 'extracted', JSON.stringify(c));
  const done = (await db.query(`select processing_completed_at, error_code from fdh_statement_uploads where id=$1`, [doc])).rows[0];
  check('...processing_completed_at set, error_code null', done.processing_completed_at !== null && done.error_code === null, JSON.stringify(done));
  const again = await rpc(A, doc, STATEMENT, [act(1, 1)]);
  check('a replay on the now-extracted document is refused (INVALID_STATE), no second row', again.ok === false && again.code === 'INVALID_STATE' && (await counts(doc)).s === 1, JSON.stringify(again));
}

console.log('\n=== 3. SECURITY INVOKER: no privilege beyond the caller\'s own ===');
{
  const docA = await newUpload(A);
  const cross = await rpc(B, docA, STATEMENT, [act(10, 1)]);
  check('tenant B cannot persist onto tenant A\'s document (DOCUMENT_NOT_FOUND)', cross.ok === false && cross.code === 'DOCUMENT_NOT_FOUND', JSON.stringify(cross));
  check('...and nothing was written for it', (await counts(docA)).s === 0);

  const spoof = await rpc(A, docA, { ...STATEMENT, user_id: B, approval_status: 'approved', approved_at: '2026-09-25T00:00:00Z' }, [act(10, 1, { user_id: B })]);
  const row = (await db.query(`select user_id, approval_status, approved_at from fdh_liability_statements where id=$1`, [spoof.statement_id])).rows[0];
  const actOwner = (await db.query(`select distinct user_id from fdh_liability_statement_activities where statement_id=$1`, [spoof.statement_id])).rows;
  check('payload user_id is ignored: rows are owned by auth.uid()', spoof.ok && row.user_id === A && actOwner.length === 1 && actOwner[0].user_id === A, JSON.stringify(row));
  check('payload approval_status/approved_at are ignored (closed column list)', row.approval_status === 'pending' && row.approved_at === null, JSON.stringify(row));

  // The 0108 trigger also guards the upload INSERT, so C's upload is seeded
  // (as the harness superuser) with that one trigger disabled for the INSERT
  // only; it is re-enabled before C calls the RPC.
  await db.exec('alter table fdh_statement_uploads disable trigger trg_enforce_country_confirmed;');
  const docC = await newUpload(C);
  await db.exec('alter table fdh_statement_uploads enable trigger trg_enforce_country_confirmed;');
  const unconfirmed = await attempt(() => rpc(C, docC, STATEMENT, [act(10, 1)]));
  check('0108 country-confirmation trigger still applies inside the RPC (unconfirmed user refused)', !unconfirmed.ok || unconfirmed.value?.ok === false, unconfirmed.message ?? JSON.stringify(unconfirmed.value));
  check('...and nothing was written for the unconfirmed user', (await counts(docC)).s === 0);

  const anon = await attempt(() => asRole('anon', null, () => db.query(`select fdh10_persist_liability_statement($1::uuid, '{}'::jsonb, '[]'::jsonb)`, [docA])));
  check('anon cannot execute the function', !anon.ok && /permission denied/.test(anon.message), anon.message ?? 'EXECUTED');
  const fnMeta = (await db.query(`select prosecdef from pg_proc where proname='fdh10_persist_liability_statement'`)).rows[0];
  check('function is SECURITY INVOKER (prosecdef = false)', fnMeta && fnMeta.prosecdef === false, JSON.stringify(fnMeta));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
