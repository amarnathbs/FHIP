// Migration 0239 (BENCH-1 Phase 2: benchmark governance, staged upload pipeline,
// per-right entitlements, mapping governance, ingestion state) — verified
// against a freshly rebuilt REAL Postgres (PGlite/WASM) with the whole chain
// 0001..0239 applied from empty.
//
// EVIDENCE LABEL: PGlite verification only. This is NOT a claim that 0239 has
// been applied to DEV or production — it has not been.
//
// Every "REFUSED" check names the SQLSTATE the database returned and is
// followed (where it matters) by a check that NOTHING was written, so each
// control is shown to bite. Fixture data here is SYNTHETIC test data used only
// inside an in-memory database; nothing is published anywhere.
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
const MY = files.find((f) => f.startsWith('0239_'));
// Negative-control hook: B1P2_MIG_OVERRIDE points at a MUTATED copy of 0239 (see
// scripts/bench1_phase2_0239_negative_controls.mjs). Normal runs use the real file.
const MIG_TEXT = (f) => (f === MY && process.env.B1P2_MIG_OVERRIDE ? fs.readFileSync(process.env.B1P2_MIG_OVERRIDE, 'utf8') : fs.readFileSync(path.join(MIG, f), 'utf8'));
for (const f of files) {
  await db.exec(strip(MIG_TEXT(f)));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete — ${files.length} migrations, ending at ${files.at(-1)}\n`);

let pass = 0, fail = 0, seq = 0;
const results = [];
const check = (label, cond, detail = '') => {
  seq++;
  const id = `B1P2-PG-${String(seq).padStart(3, '0')}`;
  results.push({ id, verdict: cond ? 'PASS' : 'FAIL', label, detail });
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const sqlstate = (e) => (e && (e.code || (e.message.match(/SQLSTATE (\w+)/) ?? [])[1])) || null;
async function tryExec(sql) { try { await db.exec(sql); return null; } catch (e) { return e; } }
async function tryQuery(sql, params = []) { try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (e) { return { rows: [], err: e }; } }
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await db.query(sql, params)).rows;
async function asRole(role, sub, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claims', '${JSON.stringify(sub ? { sub, role } : { role })}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`); }
}
const as = (uid, fn) => asRole('authenticated', uid, fn);
const svc = (fn) => asRole('service_role', null, fn);
const rpc = async (uid, name, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const casts = args.map((a, i) => (typeof a === 'object' && a !== null && !Array.isArray(a) ? `$${i + 1}::jsonb` : Array.isArray(a) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
  void ph;
  const run = () => tryQuery(`select ${name}(${casts}) as r`, args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)));
  return uid === 'service' ? svc(run) : as(uid, run);
};

const U = {
  UPLOADER: '11111111-0000-0000-0000-000000000001',
  PUBLISHER: '11111111-0000-0000-0000-000000000002',
  CORRECTOR: '11111111-0000-0000-0000-000000000003',
  CATALOGUE: '11111111-0000-0000-0000-000000000004',
  APPROVER: '11111111-0000-0000-0000-000000000005',
  VIEWER: '11111111-0000-0000-0000-000000000006',
  PLAIN: '11111111-0000-0000-0000-000000000007',
  BOTH: '11111111-0000-0000-0000-000000000008', // upload + publish (self-publish case)
  ADMIN_NOCAP: '11111111-0000-0000-0000-000000000009',
};
for (const [k, id] of Object.entries(U)) await db.exec(`insert into auth.users (id, email) values ('${id}', '${k.toLowerCase()}@example.test') on conflict do nothing;`);
for (const k of ['UPLOADER', 'PUBLISHER', 'CORRECTOR', 'CATALOGUE', 'APPROVER', 'VIEWER', 'BOTH', 'ADMIN_NOCAP']) await db.exec(`insert into admin_users (user_id) values ('${U[k]}') on conflict do nothing;`);

console.log('--- 1. idempotency, shape, nothing granted ---');
const second = await tryExec(strip(MIG_TEXT(MY)));
check('0239 re-applies cleanly (idempotent)', second === null, second ? second.message.slice(0, 200) : 'second application was a no-op');
const cols = await all(`select column_name, column_default, is_nullable from information_schema.columns where table_name = 'admin_users' and column_name in ('can_publish_benchmark_data','can_correct_benchmark_data','can_manage_benchmark_catalogue','can_approve_benchmark_entitlements') order by 1`);
check('four NEW capability columns exist and default FALSE', cols.length === 4 && cols.every((c) => /false/.test(c.column_default) && c.is_nullable === 'NO'));
const granted = await one(`select count(*)::int n from admin_users where can_publish_benchmark_data or can_correct_benchmark_data or can_manage_benchmark_catalogue or can_approve_benchmark_entitlements`);
check('the migration granted NO capability to anyone (no "all admins" auto-grant)', granted.n === 0);
const sw = await all(`select job_key, enabled from ii_reference_job_control where job_key in ('benchmark_ingestion_global','benchmark_ingestion_write') order by 1`);
check('global and write kill switches ship DISABLED', sw.length === 2 && sw.every((r) => r.enabled === false));
const cron = await all(`select jobname from cron.job where jobname ilike '%benchmark%'`);
check('0239 registers NO pg_cron schedule', cron.length === 0);
const lic = await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'ii_benchmarks_licence_status_check'`);
check('no licence_status value was invented (constraint text still the 0155 four)', lic && /public_open/.test(lic.d) && /licence_required/.test(lic.d) && /licensed_held/.test(lic.d) && /unknown/.test(lic.d) && !/entitled|permitted|approved/.test(lic.d), lic?.d);
const anonExec = await one(`select has_function_privilege('anon','publish_benchmark_import(uuid,jsonb)','execute') a, has_function_privilege('authenticated','publish_benchmark_import(uuid,jsonb)','execute') b, has_function_privilege('authenticated','claim_benchmark_ingestion_lease(uuid,text,integer)','execute') c, has_function_privilege('service_role','claim_benchmark_ingestion_lease(uuid,text,integer)','execute') d, has_function_privilege('authenticated','commit_market_index_upload(text,text,text,jsonb,boolean,text)','execute') e, has_function_privilege('authenticated','publish_benchmark_feed_rows(uuid,jsonb,text,text)','execute') f`);
check('EXECUTE grants: publish for authenticated not anon; lease + feed service_role only; 0232 single-step upload RPC REVOKED from authenticated', !anonExec.a && anonExec.b && !anonExec.c && anonExec.d && !anonExec.e && !anonExec.f, JSON.stringify(anonExec));

// capabilities
await db.exec(`update admin_users set can_upload_market_index_data = true where user_id in ('${U.UPLOADER}','${U.BOTH}');
 update admin_users set can_publish_benchmark_data = true where user_id in ('${U.PUBLISHER}','${U.BOTH}');
 update admin_users set can_correct_benchmark_data = true where user_id = '${U.CORRECTOR}';
 update admin_users set can_manage_benchmark_catalogue = true where user_id = '${U.CATALOGUE}';
 update admin_users set can_approve_benchmark_entitlements = true where user_id = '${U.APPROVER}';
 update admin_users set can_view_reference_data_quality = true where user_id = '${U.VIEWER}';`);

console.log('--- 2. catalogue governance ---');
const catEntry = (key, over = {}) => ({ benchmark_key: key, official_name: `Test ${key}`, owner_name: 'Test Index Owner Ltd', official_identifier: key, asset_class: 'equity', country_code: 'IN', currency_code: 'INR', return_type: 'TRI', return_variant: 'total_return', frequency: 'business_daily', base_date: '1995-11-03', base_value: 1000, launch_date: '1996-04-22', history_start_date: '1996-04-22', history_class: 'live', calendar_code: 'IN_NSE', methodology_url: 'https://example.test/method', source_url: 'https://example.test/src', evidence_ref: 'unit-test fixture', evidence_retrieved_at: '2026-10-01', ...over });
let r = await rpc(U.PLAIN, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI'));
check('REFUSED: a plain user creating a catalogue entry', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.ADMIN_NOCAP, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI'));
check('REFUSED: an admin WITHOUT the catalogue capability', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.VIEWER, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI'));
check('REFUSED: a view-only (PC6) admin cannot write the catalogue', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
const ids = {};
for (const k of ['TEST_A_TRI', 'TEST_B_TRI']) {
  r = await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry(k));
  ids[k] = r.rows[0]?.r;
  check(`catalogue admin creates draft ${k}`, !r.err && !!ids[k], r.err?.message);
}
r = await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_P_PRI', { return_type: 'PRI', return_variant: 'price' }));
ids.TEST_P_PRI = r.rows[0]?.r;
r = await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_BAD_VARIANT', { return_type: 'PRI', return_variant: 'total_return' }));
check('REFUSED: variant inconsistent with return_type (PRI + total_return) by CHECK', sqlstate(r.err) === '23514', `SQLSTATE ${sqlstate(r.err)}`);
const verifyBad = await tryExec(`update ii_benchmarks set catalogue_status = 'verified' where benchmark_key = 'TEST_A_TRI'`);
check('REFUSED: verified status without verifier/evidence (CHECK, even for the owner role)', sqlstate(verifyBad) === '23514', `SQLSTATE ${sqlstate(verifyBad)}`);
r = await rpc(U.CATALOGUE, 'verify_benchmark_catalogue_entry', ids.TEST_A_TRI, 'short');
check('REFUSED: verification without a note of >= 10 chars', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
for (const k of ['TEST_A_TRI', 'TEST_B_TRI', 'TEST_P_PRI']) {
  r = await rpc(U.CATALOGUE, 'verify_benchmark_catalogue_entry', ids[k], 'verified against the owner page (fixture)');
  check(`catalogue admin verifies ${k}`, !r.err, r.err?.message);
}
r = await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI', { return_type: 'PRI', return_variant: 'price' }));
const stillTri = await one(`select return_variant, catalogue_status from ii_benchmarks where benchmark_key = 'TEST_A_TRI'`);
check('REFUSED: the variant of a VERIFIED benchmark is immutable (55000); the row is unchanged (identity is never loosely re-matched)', sqlstate(r.err) === '55000' && stillTri.return_variant === 'total_return' && stillTri.catalogue_status === 'verified', `SQLSTATE ${sqlstate(r.err)} ${JSON.stringify(stillTri)}`);
r = await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI', { owner_name: 'Test Index Owner Ltd (renamed)' }));
const edited = await one(`select catalogue_status, verified_by from ii_benchmarks where benchmark_key = 'TEST_A_TRI'`);
check('editing a verified entry drops it back to DRAFT (verification cleared) until re-verified', !r.err && edited.catalogue_status === 'draft' && edited.verified_by === null, JSON.stringify(edited));
await db.exec(`update ii_benchmarks set owner_name = 'Test Index Owner Ltd' where benchmark_key = 'TEST_A_TRI'`);
r = await rpc(U.CATALOGUE, 'verify_benchmark_catalogue_entry', ids.TEST_A_TRI, 're-verified after the edit (fixture)');
check('re-verification works', !r.err, r.err?.message);
const directWrite = await as(U.CATALOGUE, () => tryExec(`update ii_benchmarks set owner_name = 'x' where benchmark_key = 'TEST_A_TRI'`));
const ownerAfter = await one(`select owner_name from ii_benchmarks where benchmark_key = 'TEST_A_TRI'`);
check('direct UPDATE of ii_benchmarks by the catalogue admin changes nothing (no write policy; RPC is the only path)', ownerAfter.owner_name === 'Test Index Owner Ltd' && (directWrite === null || sqlstate(directWrite) === '42501'));

console.log('--- 3. entitlements: separate rights, fail closed ---');
const ent = (key, over = {}) => ({ benchmark_id: ids[key], entitlement_kind: 'commercial_licence', return_variant: 'total_return', currency_code: 'INR', allow_manual_ingest: true, allow_storage: true, allow_calculation: true, allow_customer_display: true, allow_report_export: true, allow_automation: false, valid_from: '2020-01-01', valid_to: '2099-12-31', post_expiry_storage: 'retain', post_expiry_calculation: true, post_expiry_display: false, evidence_reference: 'CONTRACT-FIXTURE-001', evidence_url: 'https://example.test/contract', evidence_document_date: '2026-01-01', evidence_retrieved_at: '2026-10-01', ...over });
async function makeEnt(key, over = {}, approve = true) {
  const p = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent(key, over));
  const id = p.rows[0]?.r;
  if (p.err) return { id: null, err: p.err };
  if (approve) { const a = await rpc(U.APPROVER, 'approve_benchmark_entitlement', id, 'approved (fixture)', false); if (a.err) return { id, err: a.err }; }
  return { id, err: null };
}
const allowed = async (key, right, on = null, f = null, t = null) => (await one(`select benchmark_right_allowed($1::uuid, $2, coalesce($3::date, current_date), $4::date, $5::date) as ok`, [ids[key], right, on, f, t])).ok;
check('no entitlement row => EVERY right is false (fail closed)', !(await allowed('TEST_A_TRI', 'calculation')) && !(await allowed('TEST_A_TRI', 'ingest_manual')) && !(await allowed('TEST_A_TRI', 'customer_display')));
r = await rpc(U.PLAIN, 'propose_benchmark_entitlement', ent('TEST_A_TRI'));
check('REFUSED: a plain user proposing an entitlement', sqlstate(r.err) === '42501');
r = await rpc(U.APPROVER, 'propose_benchmark_entitlement', ent('TEST_A_TRI'));
check('REFUSED: an approver WITHOUT the catalogue capability proposing (capabilities are separate)', sqlstate(r.err) === '42501');
r = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_A_TRI', { return_variant: 'price' }));
check('REFUSED: proposal whose variant differs from the catalogue row', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_A_TRI', { allow_calculation: true, allow_storage: false, allow_manual_ingest: false }));
check('REFUSED: calculation right without the storage right (rights coherence CHECK)', sqlstate(r.err) === '23514', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_A_TRI', { entitlement_kind: 'public_use_permission', evidence_url: null }));
check('REFUSED: a public-use permission without document evidence (a checkbox is not evidence)', sqlstate(r.err) === '23514', `SQLSTATE ${sqlstate(r.err)}`);
let p1 = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_A_TRI'));
const draftId = p1.rows[0]?.r;
check('a DRAFT entitlement grants nothing', !(await allowed('TEST_A_TRI', 'calculation')) && !(await allowed('TEST_A_TRI', 'ingest_manual')));
r = await rpc(U.CATALOGUE, 'approve_benchmark_entitlement', draftId, 'trying to self-approve', true);
check('REFUSED: the catalogue admin approving without the approver capability', sqlstate(r.err) === '42501');
await db.exec(`update admin_users set can_approve_benchmark_entitlements = true where user_id = '${U.CATALOGUE}'`);
r = await rpc(U.CATALOGUE, 'approve_benchmark_entitlement', draftId, 'self approval without ack', false);
check('REFUSED: proposer approving their own record without the explicit self-approval acknowledgement', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update admin_users set can_approve_benchmark_entitlements = false where user_id = '${U.CATALOGUE}'`);
r = await rpc(U.APPROVER, 'approve_benchmark_entitlement', draftId, 'approved by independent approver (fixture)', false);
check('independent approver approves', !r.err, r.err?.message);
check('approved: ingest, storage, calculation, display, export all true; automation false (each right separate)',
  (await allowed('TEST_A_TRI', 'ingest_manual')) && (await allowed('TEST_A_TRI', 'storage')) && (await allowed('TEST_A_TRI', 'calculation')) && (await allowed('TEST_A_TRI', 'customer_display')) && (await allowed('TEST_A_TRI', 'report_export')) && !(await allowed('TEST_A_TRI', 'automation')));
check('an unknown right name is an error, never a silent false', (await tryQuery(`select benchmark_right_allowed($1::uuid, 'everything')`, [ids.TEST_A_TRI])).err !== null);
check('data-date scope: unbounded entitlement covers any range', await allowed('TEST_A_TRI', 'calculation', null, '2006-04-01', '2026-09-30'));
// narrowed entitlement on B: calc+storage only, ingest false, scoped data range
const entB = await makeEnt('TEST_B_TRI', { allow_manual_ingest: false, allow_customer_display: false, allow_report_export: false, data_from: '2010-01-01', data_to: '2020-12-31' });
check('a rights-narrow record: calculation true, ingest false, display false', (await allowed('TEST_B_TRI', 'calculation')) && !(await allowed('TEST_B_TRI', 'ingest_manual')) && !(await allowed('TEST_B_TRI', 'customer_display')));
check('out-of-scope: a range starting before data_from is NOT allowed', !(await allowed('TEST_B_TRI', 'calculation', null, '2009-01-01', '2012-01-01')) && (await allowed('TEST_B_TRI', 'calculation', null, '2010-06-01', '2012-01-01')) && !(await allowed('TEST_B_TRI', 'calculation', null, '2015-01-01', '2021-06-01')));
// expiry
await db.exec(`update ii_benchmark_entitlements set valid_to = current_date - 1 where id = '${entB.id}'`);
check('EXPIRED, post_expiry_storage=retain + post_expiry_calculation: calculation still allowed (historical retention honoured, no blanket deletion), ingestion NOT', (await allowed('TEST_B_TRI', 'calculation')) && !(await allowed('TEST_B_TRI', 'ingest_manual')) && (await allowed('TEST_B_TRI', 'storage')));
await db.exec(`update ii_benchmark_entitlements set post_expiry_storage = 'delete' where id = '${entB.id}'`);
check('EXPIRED, post_expiry_storage=delete: calculation and storage both false', !(await allowed('TEST_B_TRI', 'calculation')) && !(await allowed('TEST_B_TRI', 'storage')));
await db.exec(`update ii_benchmark_entitlements set valid_to = null, post_expiry_storage = 'retain' where id = '${entB.id}'`);
await db.exec(`update ii_benchmark_entitlements set valid_from = current_date + 30 where id = '${entB.id}'`);
check('BEFORE valid_from nothing is granted (post-expiry retention does not apply before the term starts)', !(await allowed('TEST_B_TRI', 'calculation')) && !(await allowed('TEST_B_TRI', 'storage')));
await db.exec(`update ii_benchmark_entitlements set valid_from = date '2020-01-01' where id = '${entB.id}'`);
// variant mismatch -> false
const noVar = (await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_NOVARIANT', { return_type: null, return_variant: null }))).rows[0]?.r;
r = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_A_TRI', { benchmark_id: noVar }));
check('REFUSED: an entitlement for a catalogue row with no declared variant (complete the catalogue entry first)', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update ii_benchmarks set return_variant = 'price', return_type = 'PRI' where benchmark_key = 'TEST_B_TRI'`);
check('catalogue variant (price) differs from the entitlement variant (total_return) => no right (a price entitlement is not a TRI entitlement)', !(await allowed('TEST_B_TRI', 'calculation')));
await db.exec(`update ii_benchmarks set return_variant = 'total_return', return_type = 'TRI' where benchmark_key = 'TEST_B_TRI'`);
check('restored variant => right returns', await allowed('TEST_B_TRI', 'calculation'));
r = await rpc(U.CATALOGUE, 'propose_benchmark_entitlement', ent('TEST_P_PRI', { return_variant: 'price' }));
const pPri = r.rows[0]?.r;
await rpc(U.APPROVER, 'approve_benchmark_entitlement', pPri, 'approved (fixture)', false);
check('public_open style: a PRICE entitlement for the price benchmark works for its own benchmark only', (await allowed('TEST_P_PRI', 'calculation')) && !(await allowed('TEST_A_TRI', 'automation')));
const ev = await one(`select count(*)::int n from ii_benchmark_governance_events where event_type in ('entitlement_proposed','entitlement_approved')`);
check('every entitlement proposal/approval wrote a governance event', ev.n >= 6, `events=${ev.n}`);
const ents = await asRole('authenticated', U.PLAIN, async () => (await all(`select id from ii_benchmark_entitlements`)).length);
check('RLS: a plain user cannot read entitlement records (contract references stay private)', ents === 0);
const entsV = await as(U.VIEWER, async () => (await all(`select id from ii_benchmark_entitlements`)).length);
check('RLS: a view-only admin can read them (vacuity guard)', entsV >= 3, `rows=${entsV}`);
const act = await as(U.PLAIN, async () => await all(`select * from benchmark_entitled_actions(array['${ids.TEST_A_TRI}'::uuid, '${ids.TEST_B_TRI}'::uuid])`));
check('benchmark_entitled_actions gives a PLAIN signed-in user only booleans + scope (no contract data)', act.length === 2 && Object.keys(act[0]).sort().join() === 'benchmark_id,can_calculate,can_display,can_export,data_from,data_to' && act.find((a) => a.benchmark_id === ids.TEST_A_TRI).can_display === true);
const actAnon = await asRole('anon', null, () => tryQuery(`select * from benchmark_entitled_actions(array['${ids.TEST_A_TRI}'::uuid])`));
check('REFUSED: anon calling benchmark_entitled_actions', actAnon.err !== null);

console.log('--- 4. DATABASE-layer reader gate on ii_benchmark_series ---');
await db.exec(`insert into ii_benchmark_series (benchmark_id, series_date, value, currency_code) values ('${ids.TEST_A_TRI}', '2024-01-02', 1000, 'INR'), ('${ids.TEST_A_TRI}', '2024-01-03', 1010, 'INR'), ('${ids.TEST_P_PRI}', '2024-01-02', 500, 'INR');
 insert into ii_benchmark_series (benchmark_id, series_date, value, currency_code, quality_status) values ('${ids.TEST_A_TRI}', '2024-01-04', 9999, 'INR', 'superseded');
 insert into ii_benchmark_series (benchmark_id, series_date, value, currency_code) select id, '2024-01-02', 77, 'INR' from ii_benchmarks where benchmark_key = 'IN_NIFTY_50_PRI';`);
const seeVia = (uid) => as(uid, async () => (await all(`select b.benchmark_key, s.series_date::text d from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id order by 1, 2`)));
let seen = await seeVia(U.PLAIN);
check('ordinary user sees entitled series (A: 2 rows, P: 1 row) and NOT the superseded row and NOT the un-entitled IN_NIFTY_50_PRI', seen.length === 3 && !seen.some((x) => x.benchmark_key === 'IN_NIFTY_50_PRI') && !seen.some((x) => x.d === '2024-01-04'), JSON.stringify(seen));
seen = await seeVia(U.VIEWER);
check('vacuity guard: the viewer capability sees ALL rows (5 incl. the superseded and un-entitled ones)', seen.length === 5, `rows=${seen.length}`);
await db.exec(`update ii_benchmark_entitlements set status = 'revoked', revoked_by = '${U.APPROVER}', revoked_at = now(), revoked_reason = 'fixture revoke for the reader test' where id = '${draftId}'`);
seen = await seeVia(U.PLAIN);
check('NEGATIVE CONTROL: after revoking A\'s entitlement the ordinary user can no longer read A\'s series (revocation is effective at the DB layer)', !seen.some((x) => x.benchmark_key === 'TEST_A_TRI') && seen.length === 1, JSON.stringify(seen));
check('and benchmark_right_allowed(A, calculation) is false after revoke', !(await allowed('TEST_A_TRI', 'calculation')));
await db.exec(`update ii_benchmark_entitlements set status = 'approved', revoked_by = null, revoked_at = null, revoked_reason = null where id = '${draftId}'`);
r = await rpc(U.PLAIN, 'revoke_benchmark_entitlement', draftId, 'plain user attempting revoke');
check('REFUSED: a plain user revoking an entitlement', sqlstate(r.err) === '42501');
const plainInsert = await as(U.PLAIN, () => tryExec(`insert into ii_benchmark_series (benchmark_id, series_date, value) values ('${ids.TEST_A_TRI}', '2024-02-01', 1)`));
check('REFUSED: direct INSERT into ii_benchmark_series by an authenticated user', plainInsert !== null);
const adminInsert = await as(U.PUBLISHER, () => tryExec(`insert into ii_benchmark_series (benchmark_id, series_date, value) values ('${ids.TEST_A_TRI}', '2024-02-01', 1)`));
check('REFUSED: direct INSERT into ii_benchmark_series even by a publisher (only the RPC publishes)', adminInsert !== null);
await db.exec(`delete from ii_benchmark_series where benchmark_id in (select id from ii_benchmarks where benchmark_key in ('IN_NIFTY_50_PRI')) ; delete from ii_benchmark_series where benchmark_id in ('${ids.TEST_A_TRI}', '${ids.TEST_P_PRI}')`);

console.log('--- 5. the staged upload pipeline ---');
const sha = (c) => (c.length === 1 ? c.repeat(64) : parseInt(c, 16).toString(16).padStart(64, '0'));
const metaFor = (keys, over = {}) => ({ mode: 'new_history', shape: 'single', layout_id: 'single_date_value', file_format: 'csv', file_name: 'fixture.csv', file_sha256: sha('a'), file_bytes: 100, source_owner: 'Fixture Owner', source_reference: 'https://example.test/delivery', benchmark_keys: keys, return_variant: 'total_return', currency_code: 'INR', history_class: 'live', date_format: 'YYYY-MM-DD', number_locale: 'plain', validator_version: 'bench1-file-validator-v1', entitlement_refs: {}, ...over });
const rowsFor = (key, pairs) => pairs.map(([d, v], i) => ({ row_no: i + 2, benchmark_key: key, series_date: d, value: v }));
async function stageJob({ uid = U.UPLOADER, keys, rows, over = {}, hard = 0, acks = [], finalize = true, ents = {} }) {
  const c = await rpc(uid, 'create_benchmark_import_job', metaFor(keys, { entitlement_refs: ents, ...over }));
  if (c.err) return { err: c.err, step: 'create' };
  const jobId = c.rows[0].r;
  const s = await rpc(uid, 'stage_benchmark_import_rows', jobId, rows, []);
  if (s.err) return { err: s.err, step: 'stage', jobId };
  if (!finalize) return { jobId };
  const f = await rpc(uid, 'finalize_benchmark_import_job', jobId, { hard_error_count: hard, rows_total: rows.length, required_acks: acks, warning_count: 0, preview: { note: 'fixture' } });
  if (f.err) return { err: f.err, step: 'finalize', jobId };
  return { jobId, fin: f.rows[0].r };
}
const expected = (fin) => ({ new: fin.rows_new + fin.rows_revive, identical: fin.rows_identical, correction: fin.rows_correction });
const publish = (uid, jobId, fin, over = {}) => rpc(uid, 'publish_benchmark_import', jobId, { expected_sha256: over.sha ?? sha('a'), expected_digest: over.digest ?? fin.staging_digest, expected_counts: over.counts ?? expected(fin), acknowledged: over.acks ?? [], self_publish_ack: over.self ?? false });
const seriesCount = async (key) => (await one(`select count(*)::int n from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id where b.benchmark_key = $1 and s.quality_status = 'ok'`, [key])).n;
const dataRows = rowsFor('TEST_A_TRI', [['2024-03-25', 1000], ['2024-03-26', 1005.5], ['2024-03-27', 1003.25]]);

r = await rpc(U.PLAIN, 'create_benchmark_import_job', metaFor(['TEST_A_TRI']));
check('REFUSED: a plain user creating an import job', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.VIEWER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI']));
check('REFUSED: a view-only admin creating an import job (view-only restriction)', sqlstate(r.err) === '42501');
r = await rpc(U.PUBLISHER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI']));
check('REFUSED: a publisher WITHOUT the upload capability cannot stage (upload and publish are separate)', sqlstate(r.err) === '42501');
r = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['NO_SUCH_BENCHMARK']));
check('REFUSED: an upload naming a benchmark that is not in the catalogue (an upload never creates one)', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { return_variant: 'price' }));
check('REFUSED: upload form variant (price) differs from the catalogue variant (total_return)', sqlstate(r.err) === '22023');
r = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { currency_code: 'USD' }));
check('REFUSED: upload form currency differs from the catalogue currency', sqlstate(r.err) === '22023');
r = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { source_reference: 'x' }));
check('REFUSED: no source reference (original URL / delivery reference is required)', sqlstate(r.err) === '23514', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { mode: 'correction' }));
check('REFUSED: a correction job without a reason of >= 20 chars', sqlstate(r.err) === '22023');

// structural validation inside stage
let c = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { entitlement_refs: {} }));
const badJob = c.rows[0].r;
for (const [label, rows] of [
  ['future date', rowsFor('TEST_A_TRI', [['2999-01-01', 100]])],
  ['zero value', rowsFor('TEST_A_TRI', [['2024-03-25', 0]])],
  ['negative value', rowsFor('TEST_A_TRI', [['2024-03-25', -5]])],
  ['benchmark outside the job', rowsFor('TEST_B_TRI', [['2024-03-25', 5]])],
  ['pre-1900 date', rowsFor('TEST_A_TRI', [['1800-01-01', 5]])],
]) {
  r = await rpc(U.UPLOADER, 'stage_benchmark_import_rows', badJob, rows, []);
  check(`REFUSED at staging: ${label}`, sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
}
check('AFTER the refusals: no rows were staged', (await one(`select count(*)::int n from ii_benchmark_import_rows where job_id = $1`, [badJob])).n === 0);
r = await rpc(U.BOTH, 'stage_benchmark_import_rows', badJob, dataRows, []);
check('REFUSED: a different admin (even with the upload capability) staging into someone else\'s job', sqlstate(r.err) === '42501');
r = await rpc(U.UPLOADER, 'stage_benchmark_import_rows', badJob, [...dataRows, dataRows[0]], []);
check('REFUSED: duplicate (benchmark, date) inside the staged rows (23505) and nothing written', sqlstate(r.err) === '23505' && (await one(`select count(*)::int n from ii_benchmark_import_rows where job_id = $1`, [badJob])).n === 0, `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.UPLOADER, 'cancel_benchmark_import_job', badJob);
check('uploader can cancel own job', !r.err);

// eligibility: entitlement for A allows ingest (draftId approved) -> eligible
const entA = draftId;
let J1 = await stageJob({ keys: ['TEST_A_TRI'], rows: dataRows, ents: { TEST_A_TRI: entA } });
check('stage + finalize: 3 new rows, 0 hard errors, eligible (entitlement grants ingest+storage)', !J1.err && J1.fin.rows_new === 3 && J1.fin.hard_error_total === 0 && J1.fin.eligible === true && /^[0-9a-f]{64}$/.test(J1.fin.staging_digest), J1.err?.message ?? JSON.stringify(J1.fin));
const preSeries = await seriesCount('TEST_A_TRI');
r = await publish(U.UPLOADER, J1.jobId, J1.fin);
check('REFUSED: the staging admin WITHOUT the publish capability publishing', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await publish(U.VIEWER, J1.jobId, J1.fin);
check('REFUSED: a view-only admin publishing', sqlstate(r.err) === '42501');
r = await publish(U.CORRECTOR, J1.jobId, J1.fin);
check('REFUSED: a corrector (no publish capability) publishing NEW history (capabilities are separate)', sqlstate(r.err) === '42501');
r = await publish(U.PLAIN, J1.jobId, J1.fin);
check('REFUSED: a plain user publishing', sqlstate(r.err) === '42501');
r = await publish('11111111-0000-0000-0000-0000000000ff', J1.jobId, J1.fin);
check('REFUSED: a user with no auth/admin row at all publishing', sqlstate(r.err) === '42501');
r = await publish(U.PUBLISHER, J1.jobId, J1.fin, { sha: sha('b') });
check('REFUSED (stale): wrong file checksum', sqlstate(r.err) === '40001', `SQLSTATE ${sqlstate(r.err)}`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin, { digest: sha('c') });
check('REFUSED (stale): wrong staging digest (a preview that is not the validated staging version)', sqlstate(r.err) === '40001');
r = await publish(U.PUBLISHER, J1.jobId, J1.fin, { counts: { new: 99, identical: 0, correction: 0 } });
check('REFUSED: approved counts differ from the previewed counts', sqlstate(r.err) === '40001');
check('AFTER all those refusals nothing was published', (await seriesCount('TEST_A_TRI')) === preSeries);
// tamper with staged rows after validation
await db.exec(`update ii_benchmark_import_rows set value = 1234 where job_id = '${J1.jobId}' and series_date = '2024-03-26'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('NEGATIVE CONTROL: staged rows edited after validation => digest mismatch refused (40001)', sqlstate(r.err) === '40001', `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update ii_benchmark_import_rows set value = 1005.5 where job_id = '${J1.jobId}' and series_date = '2024-03-26'`);

// revocation between staging and publication
await db.exec(`update ii_benchmark_entitlements set status = 'revoked', revoked_by = '${U.APPROVER}', revoked_at = now(), revoked_reason = 'revoked between staging and publication' where id = '${entA}'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('REFUSED: entitlement REVOKED between staging and publication (42501) and nothing published', sqlstate(r.err) === '42501' && (await seriesCount('TEST_A_TRI')) === preSeries, `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update ii_benchmark_entitlements set status = 'approved', revoked_by = null, revoked_at = null, revoked_reason = null where id = '${entA}'`);
// expiry between staging and publication (no retention)
await db.exec(`update ii_benchmark_entitlements set valid_to = current_date - 1, post_expiry_storage = 'delete' where id = '${entA}'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('REFUSED: entitlement EXPIRED between staging and publication', sqlstate(r.err) === '42501');
await db.exec(`update ii_benchmark_entitlements set valid_to = '2099-12-31', post_expiry_storage = 'retain' where id = '${entA}'`);
// narrow the data scope so the staged range is out of scope
await db.exec(`update ii_benchmark_entitlements set data_from = '2025-01-01' where id = '${entA}'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('REFUSED: staged date range falls OUTSIDE the entitlement data scope', sqlstate(r.err) === '42501');
await db.exec(`update ii_benchmark_entitlements set data_from = null where id = '${entA}'`);
// remove only the ingest right (others stay): storage-only entitlement cannot publish
await db.exec(`update ii_benchmark_entitlements set allow_manual_ingest = false where id = '${entA}'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('REFUSED: entitlement allows storage/calculation but NOT ingestion (rights are evaluated separately)', sqlstate(r.err) === '42501');
await db.exec(`update ii_benchmark_entitlements set allow_manual_ingest = true where id = '${entA}'`);
// permission change between staging and publish
await db.exec(`update admin_users set can_publish_benchmark_data = false where user_id = '${U.PUBLISHER}'`);
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('REFUSED: publisher capability REVOKED between staging and publication', sqlstate(r.err) === '42501');
await db.exec(`update admin_users set can_publish_benchmark_data = true where user_id = '${U.PUBLISHER}'`);
// real publish
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
const pub1 = r.rows[0]?.r;
check('publish succeeds for an independent publisher: 3 inserted, atomic', !r.err && pub1.inserted === 3 && pub1.already_published === false && (await seriesCount('TEST_A_TRI')) === 3, r.err?.message ?? JSON.stringify(pub1));
const led = await one(`select batch_kind, status, rows_inserted, rows_read, source_sha256, window_from::text f, window_to::text t, notes from ii_reference_import_batches where id = $1`, [pub1.batch_id]);
check('ledger: ii_reference_import_batches row written (benchmark_level, succeeded, 3 inserted, sha, date range, actor in notes)', led && led.batch_kind === 'benchmark_level' && led.status === 'succeeded' && led.rows_inserted === 3 && led.source_sha256 === sha('a') && led.f === '2024-03-25' && led.t === '2024-03-27' && led.notes.published_by === U.PUBLISHER && led.notes.staged_by === U.UPLOADER, JSON.stringify(led));
const srow = await one(`select s.revision_no, s.import_job_id, s.history_class, s.data_version, s.import_batch_id, s.currency_code from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id where b.benchmark_key = 'TEST_A_TRI' and s.series_date = '2024-03-26'`);
check('series rows carry lineage: revision 1, job id, batch id, history class, currency', srow.revision_no === 1 && srow.import_job_id === J1.jobId && srow.import_batch_id === pub1.batch_id && srow.history_class === 'live' && srow.currency_code === 'INR');
const jobRow = await one(`select status, published_by, self_published, approved_counts, ledger_batch_id from ii_benchmark_import_jobs where id = $1`, [J1.jobId]);
check('job row: published, publisher recorded, not self-published, approved counts bound', jobRow.status === 'published' && jobRow.published_by === U.PUBLISHER && jobRow.self_published === false && jobRow.approved_counts.new === 3 && jobRow.ledger_batch_id === pub1.batch_id);
const evt = await one(`select count(*)::int n from ii_benchmark_governance_events where event_type in ('import_job_created','import_job_validated','import_job_published') and (subject_id = $1)`, [J1.jobId]);
check('complete audit evidence: created + validated + published events for the job', evt.n === 3, `events=${evt.n}`);
const st = await one(`select latest_valid_data_date::text d, last_manual_import_at is not null as m from ii_benchmark_ingestion_state where benchmark_id = $1`, [ids.TEST_A_TRI]);
check('ingestion state: latest_valid_data_date updated by the publish (2024-03-27) and last_manual_import_at set', st && st.d === '2024-03-27' && st.m === true, JSON.stringify(st));
r = await publish(U.PUBLISHER, J1.jobId, J1.fin);
check('IDEMPOTENT: publishing the same job again returns the stored result, writes nothing, adds no ledger row', !r.err && r.rows[0].r.already_published === true && (await seriesCount('TEST_A_TRI')) === 3 && (await one(`select count(*)::int n from ii_reference_import_batches where batch_kind = 'benchmark_level'`)).n === 1);
// duplicate upload of same file
const J1b = await stageJob({ keys: ['TEST_A_TRI'], rows: dataRows, ents: { TEST_A_TRI: entA } });
check('re-staging the same data: all 3 rows classify identical (no new rows) and the job records duplicate_of', J1b.fin.rows_new === 0 && J1b.fin.rows_identical === 3 && (await one(`select duplicate_of from ii_benchmark_import_jobs where id = $1`, [J1b.jobId])).duplicate_of === J1.jobId);
r = await publish(U.PUBLISHER, J1b.jobId, J1b.fin);
check('REFUSED: publishing the exact same file again (23505, no duplicate import, no duplicate ledger/audit)', sqlstate(r.err) === '23505' && (await one(`select count(*)::int n from ii_reference_import_batches where batch_kind = 'benchmark_level'`)).n === 1, `SQLSTATE ${sqlstate(r.err)}`);
await rpc(U.UPLOADER, 'cancel_benchmark_import_job', J1b.jobId);

// conflicts in new_history mode are hard errors
const Jc = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-26', 2222], ['2024-03-28', 1004]]), over: { file_sha256: sha('c') }, ents: { TEST_A_TRI: entA } });
check('new_history with a DIFFERENT value for a published date: classified conflict => hard error, not publishable', Jc.fin.hard_error_total === 1 && Jc.fin.rows_new === 1);
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jc.jobId, { expected_sha256: sha('c'), expected_digest: Jc.fin.staging_digest, expected_counts: expected(Jc.fin), acknowledged: [], self_publish_ack: false });
check('REFUSED: publication with a hard validation error (22023); the valid row is NOT silently published', sqlstate(r.err) === '22023' && (await seriesCount('TEST_A_TRI')) === 3, `SQLSTATE ${sqlstate(r.err)}`);
// client-reported hard errors block too
const Jh = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-28', 1004]]), over: { file_sha256: sha('d') }, hard: 2, ents: { TEST_A_TRI: entA } });
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jh.jobId, { expected_sha256: sha('d'), expected_digest: Jh.fin.staging_digest, expected_counts: expected(Jh.fin), acknowledged: [], self_publish_ack: false });
check('REFUSED: file-level hard errors reported at validation block publication', sqlstate(r.err) === '22023');
// required acknowledgements
const Ja = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-28', 1004]]), over: { file_sha256: sha('e') }, acks: ['large_moves'], ents: { TEST_A_TRI: entA } });
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Ja.jobId, { expected_sha256: sha('e'), expected_digest: Ja.fin.staging_digest, expected_counts: expected(Ja.fin), acknowledged: [], self_publish_ack: false });
check('REFUSED: a required review acknowledgement (large_moves) not given', sqlstate(r.err) === '22023');
// self publish
await db.exec(`update admin_users set can_publish_benchmark_data = true where user_id = '${U.BOTH}'`);
const Js = await stageJob({ uid: U.BOTH, keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-28', 1004]]), over: { file_sha256: sha('f') }, ents: { TEST_A_TRI: entA } });
r = await rpc(U.BOTH, 'publish_benchmark_import', Js.jobId, { expected_sha256: sha('f'), expected_digest: Js.fin.staging_digest, expected_counts: expected(Js.fin), acknowledged: [], self_publish_ack: false });
check('REFUSED: same admin staging and publishing without the explicit self-publish acknowledgement (separation of duties)', sqlstate(r.err) === '42501');
r = await rpc(U.BOTH, 'publish_benchmark_import', Js.jobId, { expected_sha256: sha('f'), expected_digest: Js.fin.staging_digest, expected_counts: expected(Js.fin), acknowledged: [], self_publish_ack: true });
check('with the explicit acknowledgement self-publish works and is RECORDED as self_published', !r.err && (await one(`select self_published from ii_benchmark_import_jobs where id = $1`, [Js.jobId])).self_published === true);

// stale preview + concurrent conflicting imports
const Jx = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-29', 1010]]), over: { file_sha256: sha('1') }, ents: { TEST_A_TRI: entA } });
const Jy = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-03-29', 1011]]), over: { file_sha256: sha('2') }, ents: { TEST_A_TRI: entA } });
check('two concurrent jobs staged for the same new date with different values: both look valid at preview time', Jx.fin.hard_error_total === 0 && Jy.fin.hard_error_total === 0);
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jx.jobId, { expected_sha256: sha('1'), expected_digest: Jx.fin.staging_digest, expected_counts: expected(Jx.fin), acknowledged: [], self_publish_ack: false });
check('first publishes', !r.err);
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jy.jobId, { expected_sha256: sha('2'), expected_digest: Jy.fin.staging_digest, expected_counts: expected(Jy.fin), acknowledged: [], self_publish_ack: false });
const v29 = await one(`select s.value::float v from ii_benchmark_series s join ii_benchmarks b on b.id = s.benchmark_id where b.benchmark_key = 'TEST_A_TRI' and s.series_date = '2024-03-29'`);
check('REFUSED (stale, 40001): the second concurrent import is detected, the first value stands, nothing partial written', sqlstate(r.err) === '40001' && v29.v === 1010, `SQLSTATE ${sqlstate(r.err)}, value=${v29.v}`);
await rpc(U.PUBLISHER, 'record_benchmark_import_failure', Jy.jobId, 'STALE', 'superseded by concurrent import');
check('failure bookkeeping marks the job stale (recoverable: re-stage)', (await one(`select status from ii_benchmark_import_jobs where id = $1`, [Jy.jobId])).status === 'stale');

// atomicity: multi-benchmark job, second benchmark not entitled for ingest
const entP = (await one(`select id from ii_benchmark_entitlements where benchmark_id = $1`, [ids.TEST_P_PRI])).id;
const multiRows = [...rowsFor('TEST_A_TRI', [['2024-04-01', 1020]]), ...rowsFor('TEST_P_PRI', [['2024-04-01', 520]])];
const Jm = await stageJob({ keys: ['TEST_A_TRI', 'TEST_P_PRI'], rows: multiRows, over: { shape: 'multi', file_sha256: sha('3'), return_variant: 'total_return' }, ents: { TEST_A_TRI: entA, TEST_P_PRI: entP } });
check('REFUSED at create: a multi job mixing a total_return and a price benchmark under one declared variant', Jm.err && sqlstate(Jm.err) === '22023', Jm.err ? `SQLSTATE ${sqlstate(Jm.err)}` : 'created');
// second TRI benchmark B has NO ingest right (entB allow_manual_ingest=false)
const multi2 = [...rowsFor('TEST_A_TRI', [['2024-04-01', 1020]]), ...rowsFor('TEST_B_TRI', [['2024-04-01', 2020]])];
const Jm2 = await stageJob({ keys: ['TEST_A_TRI', 'TEST_B_TRI'], rows: multi2, over: { shape: 'multi', file_sha256: sha('4') }, ents: { TEST_A_TRI: entA, TEST_B_TRI: entB.id } });
check('multi-benchmark job: eligibility is evaluated PER benchmark (B has no ingest right => eligible=false)', Jm2.fin.eligible === false && Jm2.fin.eligibility.TEST_B_TRI.eligible === false && Jm2.fin.eligibility.TEST_A_TRI.eligible === true, JSON.stringify(Jm2.fin.eligibility));
const beforeA = await seriesCount('TEST_A_TRI');
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jm2.jobId, { expected_sha256: sha('4'), expected_digest: Jm2.fin.staging_digest, expected_counts: expected(Jm2.fin), acknowledged: [], self_publish_ack: false });
check('TRANSACTION ROLLBACK: the multi job is refused as a whole; the entitled benchmark A got NO rows either', sqlstate(r.err) === '42501' && (await seriesCount('TEST_A_TRI')) === beforeA && (await seriesCount('TEST_B_TRI')) === 0, `SQLSTATE ${sqlstate(r.err)}`);
// mid-write failure: a trigger (test-only) makes the SECOND insert fail AFTER the first row was written
await db.exec(`create or replace function zz_test_fail_on_date() returns trigger language plpgsql as $f$ begin if new.series_date = date '2024-12-31' then raise exception 'zz test: forced failure mid-publish' using errcode = 'XX000'; end if; return new; end $f$;
 create trigger zz_test_fail before insert on ii_benchmark_series for each row execute function zz_test_fail_on_date();`);
const Jf = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-12-30', 1500], ['2024-12-31', 1501]]), over: { file_sha256: sha('b') }, ents: { TEST_A_TRI: entA } });
const batchesBefore = (await one(`select count(*)::int n from ii_reference_import_batches where batch_kind = 'benchmark_level'`)).n;
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jf.jobId, { expected_sha256: sha('b'), expected_digest: Jf.fin.staging_digest, expected_counts: expected(Jf.fin), acknowledged: [], self_publish_ack: false });
check('TRUE MID-WRITE ROLLBACK: a failure on the 2nd inserted row leaves NO partial rows, NO ledger row, and the job still validated (safe retry possible)', r.err !== null && (await one(`select count(*)::int n from ii_benchmark_series where series_date in ('2024-12-30','2024-12-31')`)).n === 0 && (await one(`select count(*)::int n from ii_reference_import_batches where batch_kind = 'benchmark_level'`)).n === batchesBefore && (await one(`select status from ii_benchmark_import_jobs where id = $1`, [Jf.jobId])).status === 'validated', r.err?.message?.slice(0, 80));
await db.exec(`drop trigger zz_test_fail on ii_benchmark_series; drop function zz_test_fail_on_date();`);
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jf.jobId, { expected_sha256: sha('b'), expected_digest: Jf.fin.staging_digest, expected_counts: expected(Jf.fin), acknowledged: [], self_publish_ack: false });
check('SAFE RETRY: after the fault is removed the same job publishes once, with exactly one ledger row and one set of rows', !r.err && r.rows[0].r.inserted === 2 && (await one(`select count(*)::int n from ii_reference_import_batches where batch_kind = 'benchmark_level'`)).n === batchesBefore + 1, r.err?.message);
// chunked staging
const beforeA2 = await seriesCount('TEST_A_TRI');
const bigRows = []; { let d = new Date('2023-01-02T00:00:00Z'); let v = 900; for (let i = 0; i < 1200; i++) { const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) { v += 0.37; bigRows.push({ row_no: bigRows.length + 2, benchmark_key: 'TEST_A_TRI', series_date: d.toISOString().slice(0, 10), value: Math.round(v * 100) / 100 }); } d = new Date(d.getTime() + 86400000); if (d > new Date('2024-03-20T00:00:00Z')) break; } }
const bigC = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { file_sha256: sha('5'), entitlement_refs: { TEST_A_TRI: entA } }));
const bigId = bigC.rows[0].r;
let chunkOk = true; for (let i = 0; i < bigRows.length; i += 100) { const s = await rpc(U.UPLOADER, 'stage_benchmark_import_rows', bigId, bigRows.slice(i, i + 100), []); if (s.err) chunkOk = false; }
const fin5 = (await rpc(U.UPLOADER, 'finalize_benchmark_import_job', bigId, { hard_error_count: 0, rows_total: bigRows.length, required_acks: [], preview: {} })).rows[0].r;
check('chunked staging (100-row chunks) finalizes with the full row count; nothing is canonical until publish', chunkOk && fin5.rows_new === bigRows.length && (await seriesCount('TEST_A_TRI')) === beforeA2, `rows=${bigRows.length}`);
// chunk failure (an interrupted job): stage half, never finalize => nothing canonical, publish impossible
const halfC = await rpc(U.UPLOADER, 'create_benchmark_import_job', metaFor(['TEST_A_TRI'], { file_sha256: sha('6'), entitlement_refs: { TEST_A_TRI: entA } }));
await rpc(U.UPLOADER, 'stage_benchmark_import_rows', halfC.rows[0].r, rowsFor('TEST_A_TRI', [['2024-05-01', 1100]]), []);
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', halfC.rows[0].r, { expected_sha256: sha('6'), expected_digest: sha('0'), expected_counts: { new: 1, identical: 0, correction: 0 }, acknowledged: [], self_publish_ack: false });
check('CHUNK FAILURE: a job interrupted before finalize cannot be published (55000) and published nothing', sqlstate(r.err) === '55000' && (await seriesCount('TEST_A_TRI')) === beforeA2, `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.UPLOADER, 'stage_benchmark_import_rows', bigId, rowsFor('TEST_A_TRI', [['2024-05-02', 1]]), []);
check('REFUSED: staging more rows after finalize (job is validated, not staging)', sqlstate(r.err) === '55000');
r = await publish(U.PUBLISHER, bigId, fin5, { sha: sha('5') });
check('the 300+-row chunked job publishes atomically', !r.err && r.rows[0].r.inserted === bigRows.length, r.err?.message ?? JSON.stringify(r.rows[0]?.r));

console.log('--- 6. corrections, revisions and rollback ---');
const corrRows = rowsFor('TEST_A_TRI', [['2024-03-26', 1006.0]]);
let Jk = await stageJob({ keys: ['TEST_A_TRI'], rows: corrRows, over: { mode: 'correction', reason: 'Source issued a corrected close for 26 Mar 2024 (fixture)', file_sha256: sha('7') }, ents: { TEST_A_TRI: entA } });
check('correction job: the differing row classifies as correction (before 1005.5 -> after 1006)', Jk.fin.rows_correction === 1 && Jk.fin.hard_error_total === 0, JSON.stringify(Jk.fin));
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jk.jobId, { expected_sha256: sha('7'), expected_digest: Jk.fin.staging_digest, expected_counts: expected(Jk.fin), acknowledged: [], self_publish_ack: false });
check('REFUSED: a publisher WITHOUT the correction capability publishing a correction (separate permission)', sqlstate(r.err) === '42501');
check('and the published level is unchanged (silent overwrite impossible)', (await one(`select s.value::float v from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='TEST_A_TRI' and s.series_date='2024-03-26'`)).v === 1005.5);
r = await rpc(U.CORRECTOR, 'publish_benchmark_import', Jk.jobId, { expected_sha256: sha('7'), expected_digest: Jk.fin.staging_digest, expected_counts: expected(Jk.fin), acknowledged: [], self_publish_ack: false });
check('the corrector publishes the correction', !r.err && r.rows[0].r.corrected === 1, r.err?.message);
const cv = await one(`select s.value::float v, s.revision_no rev, s.import_job_id from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='TEST_A_TRI' and s.series_date='2024-03-26'`);
check('revision 2 holds the corrected level 1006 and points at the correction job', cv.v === 1006 && cv.rev === 2 && cv.import_job_id === Jk.jobId);
const corrAudit = await one(`select previous_value, new_value, actor_kind, reason, correction_kind from ii_reference_corrections where target_table='ii_benchmark_series' order by created_at desc limit 1`);
check('revision evidence in ii_reference_corrections: before (1005.5, rev 1) / after (1006, rev 2), actor, reason', corrAudit.previous_value.value === 1005.5 && corrAudit.previous_value.revision_no === 1 && corrAudit.new_value.value === 1006 && corrAudit.actor_kind === 'admin' && /corrected close/.test(corrAudit.reason) && corrAudit.correction_kind === 'source_correction', JSON.stringify(corrAudit));
// correction target missing
const Jm3 = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2022-12-01', 1]]), over: { mode: 'correction', reason: 'There is nothing to correct for this date (fixture)', file_sha256: sha('8') }, ents: { TEST_A_TRI: entA } });
check('a correction for a date with no published row is a hard error (missing_target), not an insert', Jm3.fin.hard_error_total === 1);
// rollback permissions
r = await rpc(U.PUBLISHER, 'rollback_benchmark_import', Jk.jobId, 'publisher trying to roll back a correction job');
check('REFUSED: rollback without the correction capability', sqlstate(r.err) === '42501');
r = await rpc(U.CORRECTOR, 'rollback_benchmark_import', Jk.jobId, 'short');
check('REFUSED: rollback with a reason under 20 characters', sqlstate(r.err) === '22023');
r = await rpc(U.CORRECTOR, 'rollback_benchmark_import', Jk.jobId, 'Correction was itself wrong; restoring the previous published level (fixture)');
check('rollback restores the prior level through governance (new revision 3), audited', !r.err && r.rows[0].r.restored === 1, r.err?.message);
const rv = await one(`select s.value::float v, s.revision_no rev from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key='TEST_A_TRI' and s.series_date='2024-03-26'`);
check('after rollback: level 1005.5 again, revision 3 (history is preserved, never rewritten)', rv.v === 1005.5 && rv.rev === 3, JSON.stringify(rv));
check('rolled-back job is marked rolled_back and its ledger batch is marked rolled_back', (await one(`select status from ii_benchmark_import_jobs where id = $1`, [Jk.jobId])).status === 'rolled_back' && (await one(`select b.status from ii_reference_import_batches b join ii_benchmark_import_jobs j on j.ledger_batch_id = b.id where j.id = $1`, [Jk.jobId])).status === 'rolled_back');
r = await rpc(U.CORRECTOR, 'rollback_benchmark_import', Jk.jobId, 'Second rollback attempt must be a no-op (fixture)');
check('IDEMPOTENT: a second rollback is a no-op', !r.err && r.rows[0].r.already_rolled_back === true);
// rollback of a new-history job (retract) and re-publish (revive)
const Jn = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-06-03', 1200], ['2024-06-04', 1210]]), over: { file_sha256: sha('9') }, ents: { TEST_A_TRI: entA } });
const pubN = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jn.jobId, { expected_sha256: sha('9'), expected_digest: Jn.fin.staging_digest, expected_counts: expected(Jn.fin), acknowledged: [], self_publish_ack: false });
check('a new-history job for two later dates publishes', !pubN.err && pubN.rows[0].r.inserted === 2, pubN.err ? pubN.err.message + ' | ' + JSON.stringify(await all(`select s.series_date::text d, s.value::float v, s.quality_status q, s.revision_no r from ii_benchmark_series s where s.series_date between '2024-06-01' and '2024-06-10'`)) + ' | staged ' + JSON.stringify(await all(`select series_date::text d, classification c from ii_benchmark_import_rows where job_id = $1`, [Jn.jobId])) : '');
r = await rpc(U.CORRECTOR, 'rollback_benchmark_import', Jn.jobId, 'Wrong file was uploaded for these two dates (fixture)');
check('rollback of a new-history job RETRACTS (soft, quality_status=superseded; no row is deleted)', !r.err && r.rows[0].r.retracted === 2 && (await one(`select count(*)::int n from ii_benchmark_series where series_date in ('2024-06-03','2024-06-04') and quality_status = 'superseded'`)).n === 2, r.err?.message);
const hidden = await seeVia(U.PLAIN);
check('retracted rows are invisible to ordinary readers (R4/R5 would never see them)', !hidden.some((x) => x.d === '2024-06-03'));
const Jr = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-06-03', 1201], ['2024-06-04', 1211]]), over: { file_sha256: sha('a1') }, ents: { TEST_A_TRI: entA } });
check('re-staging the retracted dates classifies them as revive (counted as new)', Jr.fin.rows_revive === 2 && Jr.fin.hard_error_total === 0, JSON.stringify(Jr.fin));
r = await rpc(U.PUBLISHER, 'publish_benchmark_import', Jr.jobId, { expected_sha256: sha('a1'), expected_digest: Jr.fin.staging_digest, expected_counts: expected(Jr.fin), acknowledged: [], self_publish_ack: false });
check('revive publishes with a new revision', !r.err && r.rows[0].r.revived === 2 && (await one(`select revision_no from ii_benchmark_series where series_date = '2024-06-03'`)).revision_no >= 3, r.err?.message);
// rollback blocked by later revision
const Jlater = await stageJob({ keys: ['TEST_A_TRI'], rows: rowsFor('TEST_A_TRI', [['2024-06-03', 1202]]), over: { mode: 'correction', reason: 'Later correction of a revived row (fixture)', file_sha256: sha('a2') }, ents: { TEST_A_TRI: entA } });
await rpc(U.CORRECTOR, 'publish_benchmark_import', Jlater.jobId, { expected_sha256: sha('a2'), expected_digest: Jlater.fin.staging_digest, expected_counts: expected(Jlater.fin), acknowledged: [], self_publish_ack: false });
r = await rpc(U.CORRECTOR, 'rollback_benchmark_import', Jr.jobId, 'Attempting to roll back beneath a later revision (fixture)');
check('REFUSED: rolling back a job whose rows were later revised (55000); data unchanged', sqlstate(r.err) === '55000' && (await one(`select value::float v from ii_benchmark_series where series_date = '2024-06-03'`)).v === 1202, `SQLSTATE ${sqlstate(r.err)}`);

console.log('--- 7. append-only + RLS on the pipeline tables ---');
let e = await tryExec(`update ii_benchmark_governance_events set reason = 'x'`);
check('REFUSED: UPDATE on the governance event log (append-only, even for the owner)', sqlstate(e) === '42501');
e = await tryExec(`delete from ii_benchmark_governance_events`);
check('REFUSED: DELETE on the governance event log', sqlstate(e) === '42501');
e = await tryExec(`truncate ii_benchmark_governance_events`);
check('REFUSED: TRUNCATE on the governance event log', sqlstate(e) === '42501');
check('RLS: a plain user sees zero import jobs / rows / errors / events', (await as(U.PLAIN, async () => (await all(`select id from ii_benchmark_import_jobs`)).length + (await all(`select 1 from ii_benchmark_import_rows`)).length + (await all(`select id from ii_benchmark_governance_events`)).length)) === 0);
check('RLS vacuity guard: the view-only admin sees them', (await as(U.VIEWER, async () => (await all(`select id from ii_benchmark_import_jobs`)).length)) > 5);
e = await as(U.PUBLISHER, () => tryExec(`insert into ii_benchmark_import_jobs (mode, shape, file_format, file_name, file_sha256, file_bytes, source_owner, source_reference, benchmark_keys, benchmark_ids, return_variant, currency_code, history_class, validator_version, staged_by) values ('new_history','single','csv','x.csv','${sha('9')}',1,'ab','abcdef',array['X'],array['${ids.TEST_A_TRI}']::uuid[],'total_return','INR','live','v','${U.PUBLISHER}')`));
check('REFUSED: direct INSERT of an import job by an admin (the RPC is the only path)', e !== null);

console.log('--- 8. mapping governance ---');
const inst = (await one(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency) values ('Fixture Large Cap Fund', 'mutual_fund', 'IN', 'INR') returning id`)).id;
const prop = (over = {}) => ({ instrument_id: inst, benchmark_id: ids.TEST_A_TRI, proposed_benchmark_name: 'Test TEST_A_TRI', relationship_type: 'primary', effective_from: '2020-04-01', evidence_source: 'amc_sid', evidence_url: 'https://example.test/sid.pdf', evidence_title: 'Fixture SID', evidence_document_date: '2020-03-15', evidence_retrieved_at: '2026-10-01', evidence_excerpt: 'The scheme benchmark is TEST A TRI (fixture)', resolution_method: 'deterministic_exact', confidence: 'high', ...over });
r = await rpc(U.PLAIN, 'propose_benchmark_mapping', prop());
check('REFUSED: a plain user proposing a mapping', sqlstate(r.err) === '42501');
r = await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ evidence_url: null }));
check('REFUSED: a proposal without an evidence URL (table CHECK)', r.err !== null && ['23502', '23514'].includes(sqlstate(r.err)), `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ evidence_source: 'a_blog_post' }));
check('REFUSED: an evidence source type outside the allow-list', sqlstate(r.err) === '23514');
r = await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop());
const pr1 = r.rows[0]?.r;
check('catalogue admin proposes a mapping with evidence', !r.err && !!pr1, r.err?.message);
r = await rpc(U.PLAIN, 'review_benchmark_mapping', pr1, 'approve', 'plain user approving', false);
check('REFUSED: a plain user approving a mapping', sqlstate(r.err) === '42501');
r = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pr1, 'approve', 'ok', false);
check('REFUSED: approval without a review note of >= 10 chars', sqlstate(r.err) === '22023');
r = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pr1, 'approve', 'Evidence checked against the SID (fixture)', false);
const map1 = r.rows[0]?.r;
const m1 = await one(`select mapping_basis, evidence_url, evidence_document_date::text dd, resolution_method, reviewed_by, benchmark_id, effective_from::text ef from ii_instrument_benchmarks where id = $1`, [map1]);
check('approval creates the canonical effective-dated mapping WITH evidence, basis scheme_disclosed, reviewer recorded', !r.err && m1.mapping_basis === 'scheme_disclosed' && m1.evidence_url === 'https://example.test/sid.pdf' && m1.dd === '2020-03-15' && m1.reviewed_by === U.CATALOGUE && m1.ef === '2020-04-01', r.err?.message ?? JSON.stringify(m1));
r = await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ benchmark_id: ids.TEST_B_TRI, effective_from: '2023-04-01', proposed_benchmark_name: 'Test TEST_B_TRI (benchmark change)' }));
const pr2 = r.rows[0]?.r;
r = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pr2, 'approve', 'Benchmark change per addendum (fixture)', false);
check('REFUSED: a benchmark CHANGE overlapping the open primary mapping without an explicit reviewed close (23P01)', sqlstate(r.err) === '23P01', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pr2, 'approve', 'Benchmark change per addendum, closing the previous mapping (fixture)', true);
const prevMap = await one(`select effective_to::text et from ii_instrument_benchmarks where id = $1`, [map1]);
check('with p_close_previous the OLD mapping is closed at the day before (history keeps its meaning) and the new one starts', !r.err && prevMap.et === '2023-03-31', r.err?.message ?? JSON.stringify(prevMap));
const ovl = await tryExec(`insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, effective_from, effective_to) values ('${inst}', '${ids.TEST_P_PRI}', 'primary', '2022-01-01', '2024-12-31')`);
check('DATABASE rule: a direct service-role INSERT of an overlapping PRIMARY mapping is refused (23P01)', sqlstate(ovl) === '23P01', `SQLSTATE ${sqlstate(ovl)}`);
const secOk = await tryExec(`insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, effective_from) values ('${inst}', '${ids.TEST_P_PRI}', 'secondary', '2022-01-01')`);
check('a SECONDARY mapping may coexist with a primary one', secOk === null);
// auto publish
const inst2 = (await one(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency) values ('Fixture Flexi Fund', 'mutual_fund', 'IN', 'INR') returning id`)).id;
r = await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ instrument_id: inst2 }));
const prAuto = r.rows[0]?.r;
r = await rpc(U.CATALOGUE, 'auto_publish_benchmark_mapping', prAuto);
check('REFUSED: an admin session calling the auto-publish RPC (service role only)', r.err !== null);
r = await rpc('service', 'auto_publish_benchmark_mapping', prAuto);
check('AUTO-PUBLISH: deterministic, high-confidence, authoritative evidence, verified benchmark => published', !r.err && r.rows[0].r.auto_published === true && (await one(`select auto_published, status from ii_benchmark_mapping_proposals where id = $1`, [prAuto])).status === 'approved', r.err?.message ?? JSON.stringify(r.rows[0]?.r));
const inst3 = (await one(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency) values ('Fixture Ambiguous Fund', 'mutual_fund', 'IN', 'INR') returning id`)).id;
for (const [label, over] of [['ambiguity reason present', { ambiguity_reason: 'Two tiers named; unclear which is primary' }], ['medium confidence', { confidence: 'medium' }], ['admin_judgement method', { resolution_method: 'admin_judgement' }], ['evidence source "other"', { evidence_source: 'other' }], ['secondary relationship', { relationship_type: 'secondary' }]]) {
  const pa = (await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ instrument_id: inst3, ...over }))).rows[0]?.r;
  const ar = await rpc('service', 'auto_publish_benchmark_mapping', pa);
  const st2 = (await one(`select status from ii_benchmark_mapping_proposals where id = $1`, [pa])).status;
  check(`NOT auto-published (${label}): routed to admin review`, !ar.err && ar.rows[0].r.auto_published === false && st2 === 'proposed', JSON.stringify(ar.rows[0]?.r));
}
const draftBm = (await rpc(U.CATALOGUE, 'upsert_benchmark_catalogue_entry', catEntry('TEST_DRAFT_TRI'))).rows[0].r;
const pd = (await rpc(U.CATALOGUE, 'propose_benchmark_mapping', prop({ instrument_id: inst3, benchmark_id: draftBm }))).rows[0]?.r;
const ad = await rpc('service', 'auto_publish_benchmark_mapping', pd);
check('NOT auto-published: the benchmark is only a DRAFT catalogue entry (must be verified)', ad.rows[0].r.auto_published === false);
const adm = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pd, 'approve', 'Trying to approve against an unverified benchmark (fixture)', false);
check('REFUSED: even an admin cannot approve a mapping to an unverified catalogue entry (22023)', sqlstate(adm.err) === '22023');
const rej = await rpc(U.CATALOGUE, 'review_benchmark_mapping', pd, 'reject', 'Rejected: benchmark not verified (fixture)', false);
check('reject records the decision and creates no mapping', !rej.err && (await one(`select status from ii_benchmark_mapping_proposals where id = $1`, [pd])).status === 'rejected');

console.log('--- 9. recurring-ingestion state, leases, kill switches ---');
r = await rpc(U.PLAIN, 'set_benchmark_ingestion_mode', ids.TEST_A_TRI, 'manual_import', null, null, false, 1, 'manual import mode (fixture)');
check('REFUSED: a plain user setting the ingestion mode', sqlstate(r.err) === '42501');
r = await rpc(U.CATALOGUE, 'set_benchmark_ingestion_mode', ids.TEST_A_TRI, 'automated', 'fixture_src', 'fixture_adapter', true, 1, 'try to automate without a right');
check('REFUSED: automation cannot be enabled without an approved AUTOMATION entitlement (a licence for storage/calculation is not automation permission)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CATALOGUE, 'set_benchmark_ingestion_mode', ids.TEST_A_TRI, 'manual_import', null, null, false, 1, 'governed manual import mode (fixture)');
check('manual_import mode can be set with a reason', !r.err);
const claim = (holder, ttl = 60) => rpc('service', 'claim_benchmark_ingestion_lease', ids.TEST_A_TRI, holder, ttl);
r = await rpc(U.CATALOGUE, 'claim_benchmark_ingestion_lease', ids.TEST_A_TRI, 'x', 60);
check('REFUSED: an authenticated admin claiming an ingestion lease (service role only)', r.err !== null);
let c1 = await claim('runner-1');
check('lease: first claimant wins', c1.rows[0].r.claimed === true);
let c2 = await claim('runner-2');
check('SINGLE-FLIGHT: an overlapping second runner is refused while the lease is live', c2.rows[0].r.claimed === false && c2.rows[0].r.holder === 'runner-1');
await db.exec(`update ii_benchmark_ingestion_state set lease_expires_at = now() - interval '1 minute' where benchmark_id = '${ids.TEST_A_TRI}'`);
c2 = await claim('runner-2');
check('LEASE EXPIRY: an expired lease can be taken over', c2.rows[0].r.claimed === true && c2.rows[0].r.holder === 'runner-2');
r = await rpc('service', 'claim_benchmark_ingestion_lease', ids.TEST_A_TRI, 'x', 5);
check('REFUSED: a lease TTL under 30 seconds', sqlstate(r.err) === '22023');
await rpc('service', 'release_benchmark_ingestion_lease', ids.TEST_A_TRI, 'runner-1');
check('releasing someone else\'s lease is a no-op', (await one(`select lease_holder from ii_benchmark_ingestion_state where benchmark_id = $1`, [ids.TEST_A_TRI])).lease_holder === 'runner-2');
await rpc('service', 'release_benchmark_ingestion_lease', ids.TEST_A_TRI, 'runner-2');
// attempts and independent watermarks
const before = await one(`select last_successful_run_at, latest_valid_data_date::text d from ii_benchmark_ingestion_state where benchmark_id = $1`, [ids.TEST_A_TRI]);
r = await rpc('service', 'record_benchmark_ingestion_attempt', ids.TEST_A_TRI, { run_kind: 'daily', status: 'empty_response', success: false, http_status: 200, rows_fetched: 0, error_code: 'EMPTY_200', error_detail: 'HTTP 200 with no expected rows' });
let after = await one(`select last_attempt_at, last_successful_run_at, consecutive_failures, last_run_status, latest_valid_data_date::text d from ii_benchmark_ingestion_state where benchmark_id = $1`, [ids.TEST_A_TRI]);
check('WATERMARKS: an empty HTTP 200 moves last_attempt_at but NOT last_successful_run_at, and counts as a failure', after.last_attempt_at !== null && String(after.last_successful_run_at) === String(before.last_successful_run_at) && after.consecutive_failures === 1 && after.last_run_status === 'empty_response', JSON.stringify(after));
r = await rpc('service', 'record_benchmark_ingestion_attempt', ids.TEST_A_TRI, { run_kind: 'daily', status: 'succeeded', success: true, completeness_watermark: '2099-01-01', rows_fetched: 1, rows_inserted: 1 });
after = await one(`select last_successful_run_at, consecutive_failures, latest_valid_data_date::text d, completeness_watermark::text w from ii_benchmark_ingestion_state where benchmark_id = $1`, [ids.TEST_A_TRI]);
check('success moves last_successful_run_at and clears the failure streak; the completeness watermark is CLAMPED to the latest valid data date (cannot claim coverage beyond real data)', after.last_successful_run_at !== null && after.consecutive_failures === 0 && after.w === after.d, JSON.stringify(after));
const runs = await one(`select count(*)::int n from ii_benchmark_ingestion_runs where benchmark_id = $1`, [ids.TEST_A_TRI]);
check('every attempt is in the run history', runs.n === 2);
e = await tryExec(`update ii_benchmark_ingestion_state set completeness_watermark = '2099-01-01' where benchmark_id = '${ids.TEST_A_TRI}'`);
check('REFUSED by CHECK: a watermark beyond latest_valid_data_date (even for the owner role)', sqlstate(e) === '23514', `SQLSTATE ${sqlstate(e)}`);
e = await tryExec(`update ii_benchmark_ingestion_state set automation_enabled = true where benchmark_id = '${ids.TEST_A_TRI}'`);
check('REFUSED by CHECK: automation_enabled while the mode is not automated', sqlstate(e) === '23514');
// feed write path
const feedRows = [{ date: '2024-07-01', value: 1300 }];
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, feedRows, 'feed.example.test', 'daily');
check('REFUSED: the feed write path while the global/write kill switches are OFF (55000)', sqlstate(r.err) === '55000', `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update ii_reference_job_control set enabled = true, disabled_reason = null where job_key in ('benchmark_ingestion_global','benchmark_ingestion_write')`);
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, feedRows, 'feed.example.test', 'daily');
check('REFUSED: kill switches on but the benchmark is not in automated mode (55000)', sqlstate(r.err) === '55000');
// add an automation entitlement
const autoEnt = await makeEnt('TEST_A_TRI', { allow_automation: true, evidence_reference: 'CONTRACT-FIXTURE-AUTOMATION' });
r = await rpc(U.CATALOGUE, 'set_benchmark_ingestion_mode', ids.TEST_A_TRI, 'automated', 'fixture_src', 'fixture_adapter', true, 1, 'automation entitlement approved (fixture)');
check('with an approved AUTOMATION entitlement the mode can be set automated', !r.err, r.err?.message);
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, feedRows, 'feed.example.test', 'daily');
check('feed write succeeds only when ALL gates pass (kill switches on, automated, entitlement)', !r.err && r.rows[0].r.inserted === 1, r.err?.message);
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, [{ date: '2024-07-01', value: 9999 }, { date: '2024-07-02', value: 1305 }], 'feed.example.test', 'weekly_gap');
const fv = await one(`select s.value::float v from ii_benchmark_series s where s.benchmark_id = $1 and s.series_date = '2024-07-01'`, [ids.TEST_A_TRI]);
check('feed never overwrites: the differing value is counted as a conflict, the published value stands, the new day is inserted', !r.err && r.rows[0].r.conflicts_skipped === 1 && r.rows[0].r.inserted === 1 && fv.v === 1300, JSON.stringify(r.rows[0]?.r));
await db.exec(`update ii_benchmark_entitlements set status = 'revoked', revoked_by = '${U.APPROVER}', revoked_at = now(), revoked_reason = 'revoking the automation grant (fixture)' where id = '${autoEnt.id}'`);
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, [{ date: '2024-07-03', value: 1306 }], 'feed.example.test', 'daily');
check('REFUSED: after the automation grant is revoked the feed write is refused (42501)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
await db.exec(`update ii_reference_job_control set enabled = false, disabled_reason = 'fixture reset' where job_key = 'benchmark_ingestion_write'`);
r = await rpc('service', 'publish_benchmark_feed_rows', ids.TEST_A_TRI, [{ date: '2024-07-03', value: 1306 }], 'feed.example.test', 'daily');
check('REFUSED: the WRITE kill switch alone stops writes (55000)', sqlstate(r.err) === '55000');
r = await rpc(U.PUBLISHER, 'publish_benchmark_feed_rows', ids.TEST_A_TRI, feedRows, 'x', 'daily');
check('REFUSED: an admin session cannot call the feed write path at all', r.err !== null);

console.log('--- 10. legacy 0232 write paths no longer bypass the gate ---');
r = await as(U.UPLOADER, () => tryQuery(`select commit_market_index_upload('IN_NIFTY_50_PRI', '${sha('b')}', 'x.csv', '[{"date":"2024-03-27","close":22123.65}]'::jsonb, true, 'I confirm I hold the right to use and store this data')`));
check('REFUSED: the 0232 single-step upload RPC is no longer executable by an authenticated admin (permission denied)', r.err !== null && /permission denied|42501/i.test(r.err.message + sqlstate(r.err)), r.err?.message?.slice(0, 80));
await db.exec(`update ii_reference_job_control set enabled = true, disabled_reason = null where job_key = 'market_index_daily_close'`);
r = await rpc('service', 'record_market_index_feed_closes', 'IN_NIFTY_50_PRI', [{ date: '2024-03-27', close: 22123.65 }], 'example.test');
check('REFUSED: the 0232 feed RPC now requires an approved automation+storage entitlement for the index (42501) and wrote nothing', sqlstate(r.err) === '42501' && (await one(`select count(*)::int n from ii_benchmark_series s join ii_benchmarks b on b.id=s.benchmark_id where b.benchmark_key = 'IN_NIFTY_50_PRI'`)).n === 0, `SQLSTATE ${sqlstate(r.err)}`);

console.log('--- 11. demand + retention ---');
r = await rpc(U.PUBLISHER, 'upsert_benchmark_history_demand', [{ benchmark_id: ids.TEST_A_TRI, required_from: '2006-03-24', required_to: '2026-09-30' }], 'v1');
check('REFUSED: an admin session writing the demand table (service role only)', r.err !== null);
r = await rpc('service', 'upsert_benchmark_history_demand', [{ benchmark_id: ids.TEST_A_TRI, required_from: '2006-03-24', required_from_investor: '2015-08-11', required_to: '2026-09-30', scheme_count: 4, family_count: 3, demand_basis: { holdings: 4 } }], 'bench1-demand-v1');
check('service role upserts aggregate demand (no user detail by construction)', !r.err && r.rows[0].r === 1);
const cols2 = await all(`select column_name from information_schema.columns where table_name = 'ii_benchmark_history_demand'`);
check('the demand table has NO user/account/holding identifier column', !cols2.some((c) => /user|account|holding|folio|household/i.test(c.column_name)), cols2.map((c) => c.column_name).join(','));
r = await rpc(U.PUBLISHER, 'expire_benchmark_import_jobs');
check('REFUSED: an admin session calling the expiry job (service role only)', r.err !== null);
await db.exec(`update ii_benchmark_import_jobs set expires_at = now() - interval '1 day' where status = 'validated'`);
r = await rpc('service', 'expire_benchmark_import_jobs');
check('service role expiry: stale validated jobs become expired and their staged rows are purged', !r.err && r.rows[0].r.expired_jobs >= 1 && (await one(`select count(*)::int n from ii_benchmark_import_rows r join ii_benchmark_import_jobs j on j.id = r.job_id where j.status = 'expired'`)).n === 0, JSON.stringify(r.rows[0]?.r));
const pubStillThere = await seriesCount('TEST_A_TRI');
check('expiry never touches canonical published rows', pubStillThere >= 6, `rows=${pubStillThere}`);

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(process.env.B1P2_RESULTS_OUT ?? path.join(HERE, 'bench1-phase2-0239-pglite-results.json'), JSON.stringify({ migration: MY, generatedBy: 'scripts/bench1_phase2_0239_pglite_verification.mjs', note: 'PGlite verification only; 0239 is NOT applied to DEV or production. All data is synthetic fixture data inside an in-memory database.', pass, fail, results }, null, 2));
process.exit(fail === 0 ? 0 : 1);
