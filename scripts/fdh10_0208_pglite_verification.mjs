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

// ===========================================================================
// WP-10 additions (forward port as 0208): new evidence columns, the two
// unique indexes and their loud pre-checks, the extended F.2 trigger,
// idempotency and zero rows rewritten.
// ===========================================================================
const M0208 = '0208_fdh10_atomic_liability_statement_persist.sql';
const SQL_0208 = fs.readFileSync(path.join(MIG, M0208), 'utf8');
async function buildUpTo(stopBefore) {
  const d = await PGlite.create();
  await d.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (f >= stopBefore) break;
    await d.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await d.exec(seed);
  }
  return d;
}
const protectedCols = (body) => new Set([...(body ?? '').matchAll(/new\.([a-z_]+) is distinct from old\.\1/g)].map((m) => m[1]));
const lastFnBody = (sql, name) => {
  const all = [...sql.matchAll(new RegExp(`create or replace function ${name}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'g'))];
  return all.length ? all[all.length - 1][1] : null;
};

console.log('\n=== 4. WP-10: the evidence the old path dropped is persisted (G5, G6, G4) ===');
{
  const doc = await newUpload(A);
  const r = await rpc(A, doc, { ...STATEMENT, adjustments_total: -30, capitalised_total: null, extraction_warnings: [{ code: 'zero_amount', row: 4 }] }, [
    act(250, 1, { gst_amount_raw: '22.73' }),
    act(220, 2, { activity_type: 'PAYMENT', bank_match_status: 'multiple_candidates', bank_match_candidate_ids: ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'] }),
  ]);
  check('persist with the new evidence succeeds', r.ok === true, JSON.stringify(r));
  const st = (await db.query(`select extraction_warnings, adjustments_total::text adj from fdh_liability_statements where id = $1`, [r.statement_id])).rows[0];
  check('extraction_warnings stored (G6)', st.extraction_warnings.length === 1 && st.extraction_warnings[0].code === 'zero_amount' && st.extraction_warnings[0].row === 4, JSON.stringify(st.extraction_warnings));
  check('signed adjustments_total stored (G5; it was never written)', st.adj === '-30.0000', st.adj);
  const acts = (await db.query(`select gst_amount_raw, bank_match_candidate_ids from fdh_liability_statement_activities where statement_id = $1 order by source_row_number`, [r.statement_id])).rows;
  check('gst_amount_raw stored (G6; it was extracted then dropped)', acts[0].gst_amount_raw === '22.73');
  check('bank_match_candidate_ids stored for the ambiguous repayment (G4 picker)', Array.isArray(acts[1].bank_match_candidate_ids) && acts[1].bank_match_candidate_ids.length === 2);
  const bad = await rpc(A, await newUpload(A), { ...STATEMENT, extraction_warnings: { code: 'not an array' } }, [act(1, 1)]);
  check('a non-array extraction_warnings is refused (INVALID_PAYLOAD), nothing written', bad.ok === false && bad.code === 'INVALID_PAYLOAD', JSON.stringify(bad));
}

console.log('\n=== 5. WP-10: the unique indexes bite (one statement per document; one bank debit per repayment) ===');
{
  const doc = await newUpload(A);
  const first = await rpc(A, doc, STATEMENT, [act(10, 1)]);
  const direct = await attempt(() => asRole('service_role', null, () => db.query(
    `insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code) values ($1,$2,'credit_card','credit_card','AU','AUD')`, [A, doc])));
  check('a second statement for the same document is refused by uq_fdh_liability_statements_upload_0208 even outside the RPC', first.ok && !direct.ok && /uq_fdh_liability_statements_upload_0208/.test(direct.message), direct.message ?? 'INSERTED');
  await asRole('service_role', null, () => db.query(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Bank')`, [A]));
  const bankTxn = (await asRole('service_role', null, () => db.query(
    `insert into fdh_transactions (user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, approval_status, approved_at, approved_by)
     select $1, id, '2026-07-10', 200, 'AUD', 'debit', 'approved', now(), $1 from fdh_financial_accounts where user_id = $1 limit 1 returning id`, [A]))).rows[0].id;
  const m1 = await rpc(A, await newUpload(A), STATEMENT, [act(200, 1, { activity_type: 'PAYMENT', bank_match_status: 'matched', linked_transaction_id: bankTxn })]);
  check('a repayment matched to a bank debit persists', m1.ok === true, JSON.stringify(m1));
  const doc2 = await newUpload(A);
  const m2 = await attempt(() => rpc(A, doc2, STATEMENT, [act(200, 1, { activity_type: 'PAYMENT', bank_match_status: 'matched', linked_transaction_id: bankTxn })]));
  check('the SAME bank debit matched by a second statement is refused (23505, uq_fdh_liability_activities_bank_txn_0208) and that statement is not written', !m2.ok && /uq_fdh_liability_activities_bank_txn_0208/.test(m2.message), m2.message ?? 'PERSISTED');
}

console.log('\n=== 6. WP-10: F.2 (activities) is a strict superset of its predecessor and protects the new columns ===');
{
  const pre = protectedCols(lastFnBody(fs.readFileSync(path.join(MIG, '0096_fdh10_credit_cards_loans_intelligence.sql'), 'utf8'), 'fdh10_liability_activities_assert_authoritative_write'));
  const post = protectedCols(lastFnBody(SQL_0208, 'fdh10_liability_activities_assert_authoritative_write'));
  check('0208 F.2 protects every column 0096 protected', pre.size === 9 && [...pre].every((c) => post.has(c)), `${pre.size} -> ${post.size}`);
  check('...plus bank_match_candidate_ids, gst_amount_raw, ledger_transaction_id', ['bank_match_candidate_ids', 'gst_amount_raw', 'ledger_transaction_id'].every((c) => post.has(c)));
  for (const set of [`gst_amount_raw = 'forged'`, `bank_match_candidate_ids = null`]) {
    const r = await attempt(() => asTenant(A, () => db.query(`update fdh_liability_statement_activities set ${set} where user_id = $1`, [A])));
    check(`authenticated direct UPDATE refused: ${set.split(' ')[0]}`, !r.ok && /system-authoritative/.test(r.message), r.message ?? 'UPDATED');
  }
}

console.log('\n=== 7. WP-10 ANTI-VACUITY: before 0208 the duplicates are possible; the pre-check refuses them loudly ===');
{
  const d = await buildUpTo(M0208);
  const U = '44444444-4444-4444-4444-444444444444';
  await d.exec(`insert into auth.users(id,email) values ('${U}','d@t.test'); update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id='${U}';`);
  await d.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  const up = (await d.query(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values ($1,'csv','credit_card_statement','AU','AUD','text/csv','queued') returning id`, [U])).rows[0].id;
  const s1 = await attempt(() => d.query(`insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code) values ($1,$2,'credit_card','credit_card','AU','AUD')`, [U, up]));
  const s2 = await attempt(() => d.query(`insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code) values ($1,$2,'credit_card','credit_card','AU','AUD')`, [U, up]));
  check('BEFORE 0208: two statements for one document are accepted (the DEV retry defect)', s1.ok && s2.ok);
  const xmin = (await d.query(`select id::text, xmin::text from fdh_liability_statements order by 1`)).rows;
  const r = await attempt(() => d.exec(SQL_0208));
  check('0208 over that data raises PRE-CHECK FAILED (1 document) instead of failing an index build obscurely', !r.ok && /0208 PRE-CHECK FAILED: 1 document/.test(r.message), r.message ?? 'APPLIED');
  const fnAbsent = Number((await d.query(`select count(*) n from pg_proc where proname = 'fdh10_persist_liability_statement'`)).rows[0].n) === 0;
  const colAbsent = Number((await d.query(`select count(*) n from information_schema.columns where column_name = 'bank_match_candidate_ids'`)).rows[0].n) === 0;
  check('...and nothing of 0208 was applied (no function, no column)', fnAbsent && colAbsent);
  // The PO remedy for the orphan (0 activities, never approved), then 0208 applies -- twice, idempotently.
  await d.query(`delete from fdh_liability_statements where id = (select id from fdh_liability_statements where statement_upload_id = $1 order by created_at desc, id desc limit 1)`, [up]);
  const xminKept = (await d.query(`select id::text, xmin::text from fdh_liability_statements order by 1`)).rows;
  const ok1 = await attempt(() => d.exec(SQL_0208));
  check('after the remedy 0208 applies', ok1.ok, ok1.message ?? '');
  const xminAfter = (await d.query(`select id::text, xmin::text from fdh_liability_statements order by 1`)).rows;
  check('zero rows rewritten by 0208 (xmin unchanged)', JSON.stringify(xminKept) === JSON.stringify(xminAfter) && xmin.length === 2);
  const snap = async () => JSON.stringify((await d.query(`select md5(prosrc) m from pg_proc where proname in ('fdh10_persist_liability_statement','fdh10_liability_activities_assert_authoritative_write') union all select md5(indexdef) from pg_indexes where indexname like '%0208' order by 1`)).rows);
  const before = await snap();
  const ok2 = await attempt(() => d.exec(SQL_0208));
  check('re-applying 0208 raises nothing and changes no function or index', ok2.ok && before === (await snap()), ok2.message ?? '');
  await d.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
