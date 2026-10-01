// Migration 0232 (market-index upload capability, append-only ledger, upload
// RPC, feed RPC, disabled job) — verified against a freshly rebuilt REAL
// Postgres (PGlite/WASM) with the whole chain 0001..0232 applied from empty.
//
// EVIDENCE LABEL: this is PGlite verification only. It is NOT a claim that
// 0232 has been applied to DEV or production — it has not been.
//
// NEGATIVE CONTROLS here prove the controls bite: each "REFUSED" check names
// the SQLSTATE the database returned, and the "after" checks prove nothing was
// written by the refused call.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const strip = (sql) => sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
const MY = files.find((f) => f.startsWith('0232_'));
console.log(`fresh rebuild complete — ${files.length} migrations, ending at ${files.at(-1)}\n`);

let pass = 0, fail = 0, seq = 0;
const results = [];
const check = (label, cond, detail = '') => {
  seq++;
  const id = `IMF-PG-${String(seq).padStart(2, '0')}`;
  results.push({ id, verdict: cond ? 'PASS' : 'FAIL', label, detail });
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function tryExec(sql) { try { await db.exec(sql); return null; } catch (e) { return e; } }
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;
const sqlstate = (e) => (e && (e.code || (e.message.match(/SQLSTATE (\w+)/) ?? [])[1])) || null;

async function asRole(role, sub, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claims', '${JSON.stringify(sub ? { sub, role } : { role })}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
}

const ADMIN_CAP = '11111111-1111-1111-1111-111111111111';
const ADMIN_NOCAP = '22222222-2222-2222-2222-222222222222';
const PLAIN = '33333333-3333-3333-3333-333333333333';
for (const [id, email] of [[ADMIN_CAP, 'cap@example.test'], [ADMIN_NOCAP, 'nocap@example.test'], [PLAIN, 'plain@example.test']]) {
  await db.exec(`insert into auth.users (id, email) values ('${id}', '${email}') on conflict do nothing;`);
}
await db.exec(`insert into admin_users (user_id) values ('${ADMIN_CAP}'), ('${ADMIN_NOCAP}') on conflict do nothing;`);

console.log('--- 1. idempotency and shape ---');
const second = await tryExec(strip(fs.readFileSync(path.join(MIG, MY), 'utf8')));
check('0232 re-applies cleanly (idempotent)', second === null, second ? second.message.slice(0, 200) : 'second application was a no-op');
const col = await one(`select column_default, is_nullable from information_schema.columns where table_name='admin_users' and column_name='can_upload_market_index_data'`);
check('admin capability column exists and defaults FALSE', col && /false/.test(col.column_default) && col.is_nullable === 'NO');
const seeded = await all(`select benchmark_key, return_type, licence_status, benchmark_category from ii_benchmarks where benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI') order by 1`);
check('two price-index benchmark rows seeded, licence_status stays unknown', seeded.length === 2 && seeded.every((r) => r.return_type === 'PRI' && r.licence_status === 'unknown'), JSON.stringify(seeded));
const mapped = await one(`select count(*)::int as n from ii_instrument_benchmarks ib join ii_benchmarks b on b.id = ib.benchmark_id where b.benchmark_key in ('IN_NIFTY_50_PRI','IN_SENSEX_PRI')`);
check('the new series are mapped to NO fund (cannot affect any benchmark comparison)', mapped.n === 0);
const job = await one(`select enabled, disabled_reason from ii_reference_job_control where job_key = 'market_index_daily_close'`);
check('daily-feed job registered DISABLED with a reason', job && job.enabled === false && /NSE and BSE/.test(job.disabled_reason));
const cronJobs = await all(`select jobname from cron.job where jobname ilike '%market%index%'`);
check('0232 registers NO pg_cron schedule', cronJobs.length === 0);
const execPub = await one(`select has_function_privilege('anon', 'commit_market_index_upload(text,text,text,jsonb,boolean,text)', 'execute') as anon_exec, has_function_privilege('authenticated', 'commit_market_index_upload(text,text,text,jsonb,boolean,text)', 'execute') as auth_exec, has_function_privilege('authenticated', 'record_market_index_feed_closes(text,jsonb,text)', 'execute') as feed_auth, has_function_privilege('service_role', 'record_market_index_feed_closes(text,jsonb,text)', 'execute') as feed_svc`);
check('EXECUTE: upload RPC not for anon, yes for authenticated; feed RPC only service_role', !execPub.anon_exec && execPub.auth_exec && !execPub.feed_auth && execPub.feed_svc, JSON.stringify(execPub));

await db.exec(`update admin_users set can_upload_market_index_data = true where user_id = '${ADMIN_CAP}';`);
const SHA = 'a'.repeat(64);
const ATT = 'I confirm I hold the right to use and store this index data in FHIP.';
const rows = JSON.stringify([{ date: '2024-03-27', close: 22123.65 }, { date: '2024-03-28', close: 22326.9 }]);
const call = (key, sha, r, att, text) => `select commit_market_index_upload('${key}', '${sha}', 'nifty.csv', '${r}'::jsonb, ${att}, ${text === null ? 'null' : `'${text}'`})`;

console.log('--- 2. database-layer authorisation (direct RPC, no API route) ---');
let e = await asRole('authenticated', PLAIN, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, true, ATT)));
check('REFUSED: a plain user calling the RPC directly', sqlstate(e) === '42501', `SQLSTATE ${sqlstate(e)}`);
e = await asRole('authenticated', ADMIN_NOCAP, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, true, ATT)));
check('REFUSED: an admin WITHOUT the named capability', sqlstate(e) === '42501', `SQLSTATE ${sqlstate(e)}`);
e = await asRole('anon', null, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, true, ATT)));
check('REFUSED: anon (no EXECUTE)', e !== null, e ? e.message.slice(0, 90) : 'no error');
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, false, ATT)));
check('REFUSED: capability holder WITHOUT the attestation flag', sqlstate(e) === '22023' && /attestation/i.test(e.message), `SQLSTATE ${sqlstate(e)}`);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, true, null)));
check('REFUSED: attestation flag but no attestation text', sqlstate(e) === '22023', `SQLSTATE ${sqlstate(e)}`);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', SHA, rows, true, 'short')));
check('REFUSED: attestation text under 20 characters', sqlstate(e) === '22023', `SQLSTATE ${sqlstate(e)}`);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', 'not-a-hash', rows, true, ATT)));
check('REFUSED: missing/invalid SHA-256', sqlstate(e) === '22023', `SQLSTATE ${sqlstate(e)}`);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_TRI', SHA, rows, true, ATT)));
check('REFUSED: an index outside the allow-list', sqlstate(e) === '22023', `SQLSTATE ${sqlstate(e)}`);
const nothing1 = await one(`select (select count(*)::int from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id where b.benchmark_key like 'IN_%_PRI') as series, (select count(*)::int from ii_market_index_batches) as batches`);
check('AFTER the refusals: nothing was written', nothing1.series === 0 && nothing1.batches === 0, JSON.stringify(nothing1));

console.log('--- 3. row validation inside the RPC ---');
for (const [label, bad] of [
  ['future date', [{ date: '2999-01-01', close: 100 }]],
  ['zero value', [{ date: '2024-03-27', close: 0 }]],
  ['negative value', [{ date: '2024-03-27', close: -5 }]],
  ['duplicate dates', [{ date: '2024-03-27', close: 100 }, { date: '2024-03-27', close: 101 }]],
  ['date before 1979', [{ date: '1970-01-01', close: 100 }]],
]) {
  e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', 'b'.repeat(64), JSON.stringify(bad), true, ATT)));
  check(`REFUSED: ${label}`, e !== null && ['22023', '23514'].includes(sqlstate(e)), `SQLSTATE ${sqlstate(e)}`);
}
const nothing2 = await one(`select count(*)::int as n from ii_market_index_batches`);
check('AFTER the invalid-row refusals: no batch row exists (the transaction rolled back)', nothing2.n === 0);

console.log('--- 4. successful, audited, idempotent commit ---');
let res = await asRole('authenticated', ADMIN_CAP, () => one(call('IN_NIFTY_50_PRI', SHA, rows, true, ATT)));
const out = res.commit_market_index_upload;
check('commit succeeds for the capability holder with the attestation', out.inserted === 2 && out.already_committed === false, JSON.stringify(out));
const batch = await one(`select * from ii_market_index_batches`);
check('batch row records uploader, file hash, row count, date range and the attestation', batch.uploader_user_id === ADMIN_CAP && batch.file_sha256 === SHA && batch.row_count_submitted === 2 && new Date(batch.date_from).toISOString().slice(0, 10) === '2024-03-27' && new Date(batch.date_to).toISOString().slice(0, 10) === '2024-03-28' && batch.attested === true && batch.attestation_text === ATT && batch.attested_at !== null, JSON.stringify({ ...batch, attested_at: '<ts>', created_at: '<ts>' }));
const stored = await all(`select s.series_date::text as d, s.value::float as v, s.import_batch_id from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id where b.benchmark_key='IN_NIFTY_50_PRI' order by 1`);
check('series rows stored with the batch lineage', stored.length === 2 && stored[1].v === 22326.9 && stored.every((r) => r.import_batch_id === batch.id));
res = await asRole('authenticated', ADMIN_CAP, () => one(call('IN_NIFTY_50_PRI', SHA, rows, true, ATT)));
check('re-uploading the same file is an idempotent no-op (already_committed)', res.commit_market_index_upload.already_committed === true && (await one(`select count(*)::int n from ii_market_index_batches`)).n === 1);
const overlap = JSON.stringify([{ date: '2024-03-28', close: 22326.9 }, { date: '2024-04-01', close: 22462.0 }]);
res = await asRole('authenticated', ADMIN_CAP, () => one(call('IN_NIFTY_50_PRI', 'c'.repeat(64), overlap, true, ATT)));
check('an overlapping file inserts only the new date and counts the identical one', res.commit_market_index_upload.inserted === 1 && res.commit_market_index_upload.identical === 1, JSON.stringify(res.commit_market_index_upload));

console.log('--- 5. never overwrite a published value ---');
const conflict = JSON.stringify([{ date: '2024-03-28', close: 99999.0 }, { date: '2024-04-02', close: 22500 }]);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(call('IN_NIFTY_50_PRI', 'd'.repeat(64), conflict, true, ATT)));
check('REFUSED: a different close for an already-published date (23505)', sqlstate(e) === '23505', `SQLSTATE ${sqlstate(e)}`);
const after = await one(`select (select count(*)::int from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='IN_NIFTY_50_PRI') as series, (select value::float from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='IN_NIFTY_50_PRI' and s.series_date='2024-03-28') as v, (select count(*)::int from ii_market_index_batches) as batches`);
check('AFTER the conflict: the published value is unchanged, the non-conflicting row was NOT written, no batch added', after.series === 3 && after.v === 22326.9 && after.batches === 2, JSON.stringify(after));

console.log('--- 6. append-only ledger and RLS ---');
e = await tryExec(`update ii_market_index_batches set file_name = 'x'`);
check('REFUSED: UPDATE on the ledger (even as the owner)', sqlstate(e) === '42501', `SQLSTATE ${sqlstate(e)}`);
e = await tryExec(`delete from ii_market_index_batches`);
check('REFUSED: DELETE on the ledger', sqlstate(e) === '42501', `SQLSTATE ${sqlstate(e)}`);
e = await tryExec(`truncate ii_market_index_batches`);
check('REFUSED: TRUNCATE on the ledger', sqlstate(e) === '42501', `SQLSTATE ${sqlstate(e)}`);
e = await tryExec(`insert into ii_market_index_batches (benchmark_key, source_kind, file_sha256, row_count_submitted, rows_inserted) values ('IN_SENSEX_PRI','admin_csv','${'e'.repeat(64)}',1,1)`);
check('REFUSED: an admin_csv batch row without attestation/uploader (CHECK, even for the owner role)', e !== null && sqlstate(e) === '23514', `SQLSTATE ${sqlstate(e)}`);
let rowsSeen = await asRole('authenticated', PLAIN, async () => (await all(`select id from ii_market_index_batches`)).length);
check('RLS: a plain user sees ZERO ledger rows', rowsSeen === 0);
rowsSeen = await asRole('authenticated', ADMIN_NOCAP, async () => (await all(`select id from ii_market_index_batches`)).length);
check('RLS: an admin without the capability sees ZERO ledger rows', rowsSeen === 0);
rowsSeen = await asRole('authenticated', ADMIN_CAP, async () => (await all(`select id from ii_market_index_batches`)).length);
check('RLS: the capability holder sees the ledger', rowsSeen === 2);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(`insert into ii_market_index_batches (benchmark_key, source_kind, row_count_submitted, rows_inserted) values ('IN_SENSEX_PRI','daily_feed',1,1)`));
check('REFUSED: even the capability holder cannot write the ledger directly (no INSERT grant/policy)', e !== null, e ? e.message.slice(0, 90) : 'no error');
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(`insert into ii_benchmark_series (benchmark_id, series_date, value) select id, '2024-04-03', 1 from ii_benchmarks where benchmark_key='IN_SENSEX_PRI'`));
check('REFUSED: direct write to ii_benchmark_series by an authenticated user (existing RLS unchanged)', e !== null, e ? e.message.slice(0, 90) : 'no error');

console.log('--- 7. feed RPC: service role only, never overwrites ---');
const feedRows = JSON.stringify([{ date: '2024-04-03', close: 22514.65 }, { date: '2024-03-28', close: 11111 }]);
e = await asRole('authenticated', ADMIN_CAP, () => tryExec(`select record_market_index_feed_closes('IN_NIFTY_50_PRI', '${feedRows}'::jsonb, 'example.test')`));
check('REFUSED: the feed RPC for an authenticated admin (service role only)', e !== null, e ? e.message.slice(0, 90) : 'no error');
res = await asRole('service_role', null, () => one(`select record_market_index_feed_closes('IN_NIFTY_50_PRI', '${feedRows}'::jsonb, 'example.test')`));
const f = res.record_market_index_feed_closes;
check('service role: inserts the new day, skips (does not overwrite) the conflicting day', f.inserted === 1 && f.conflicts_skipped === 1, JSON.stringify(f));
const keep = await one(`select value::float as v from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='IN_NIFTY_50_PRI' and s.series_date='2024-03-28'`);
check('the published value for the conflicting day is unchanged', keep.v === 22326.9);
const feedBatch = await one(`select source_kind, source_host, uploader_user_id, attested from ii_market_index_batches where source_kind = 'daily_feed'`);
check('feed run recorded in the ledger as daily_feed (no uploader, no attestation)', feedBatch.source_host === 'example.test' && feedBatch.uploader_user_id === null && feedBatch.attested === false);

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(HERE, 'india-mf-0232-pglite-results.json'), JSON.stringify({ migration: MY, generatedBy: 'scripts/india_mf_0232_pglite_verification.mjs', note: 'PGlite verification only; 0232 is NOT applied to DEV or production.', pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
