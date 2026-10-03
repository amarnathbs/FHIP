// BENCH-1: PGlite verification for migration 0252_bench1_factsheet_benchmark_reader.sql.
//
// EVIDENCE LABEL: PGlite (real Postgres, WASM, in memory) with the whole chain before 0252 replayed from an EMPTY
// database and SYNTHETIC fixtures. This is NOT a claim that 0252 has been applied to DEV or production: it has not
// been. Nothing here touches any real database, network or fund-house site.
//
// Claims proven (each with a control that shows it bites):
//   - ADDITIVE: no pre-existing constraint, column or object changed (a before/after fingerprint of every pre-existing
//     constraint and column is identical), and 0252 re-applies cleanly;
//   - the kill switch row ships DISABLED, no pg_cron job exists, all eight seeded sources are 'not_reviewed';
//   - versions, events and the attempt ledger are APPEND-ONLY in the database (UPDATE / DELETE / TRUNCATE refused);
//   - a stale "previous version" is refused (40001), versions number 1, 2, ... and link to the one they supersede;
//   - ONE terminal result per scheme per source per month (23505), a non-terminal one may repeat;
//   - the job writers are service-role only; a signed-in user and an admin get 42501;
//   - held instruments: reversed / review_required-only instruments are excluded; no user / count / amount column;
//   - the review function: capability-gated, approve goes through the EXISTING mapping review path and creates the
//     effective-dated mapping, a repeat decision is refused, reject leaves history, acknowledge closes the old mapping;
//   - the terms-status setter needs the entitlement-approver capability and a note, and 'approved' needs a reviewer;
//   - declared_benchmark_records_for(): unsupported / awaiting-review latest versions are returned, a verified match,
//     a rejected one and an approved one are not.
//
// Run: node scripts/factsheet_reader_0252_pglite_verification.mjs
// PGLITE_MODULE=<file URL> if @electric-sql/pglite is not resolvable from this checkout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0252_bench1_factsheet_benchmark_reader.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(process.env.F0252_FILE ?? path.join(MIG, TARGET), 'utf8'));

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
let applied = 0;
for (const f of files) {
  if (f >= TARGET) break;
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  applied += 1;
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
check(`the chain before 0252 replayed from empty (${applied} migrations)`, applied > 200, `applied ${applied}`);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const sqlstate = (e) => (e && (e.code || (e.message.match(/SQLSTATE (\w+)/) ?? [])[1])) || null;
async function tryQ(sql, params = []) { try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (e) { return { rows: [], err: e }; } }
async function asRole(role, claims, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
const as = (uid, fn) => asRole('authenticated', { sub: uid, role: 'authenticated' }, fn);
const svc = (fn) => asRole('service_role', { role: 'service_role' }, fn);
const rpc = (who, name, ...args) => {
  const casts = args.map((a, i) => (typeof a === 'object' && a !== null ? `$${i + 1}::jsonb` : a === null || typeof a === 'string' ? `$${i + 1}` : `$${i + 1}`)).join(', ');
  const run = () => tryQ(`select ${name}(${casts}) as r`, args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)));
  return who === 'service' ? svc(run) : as(who, run);
};

const fingerprint = async () => JSON.stringify({
  constraints: (await all(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)),
  columns: (await all(`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' order by 1,2`)),
  funcs: (await all(`select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2`)).map((r) => [r.proname, r.d]),
});
const before = await fingerprint();
console.log('BEFORE 0252');
check('the new tables do not exist before 0252 (anti-vacuity)', (await one(`select to_regclass('public.ii_factsheet_sources') a, to_regclass('public.ii_scheme_declared_benchmark_versions') b`)).a === null);
await db.exec(target);
const after = await fingerprint();
const beforeObj = JSON.parse(before);
const afterObj = JSON.parse(after);
const NEW_TABLES = new Set(['ii_factsheet_sources', 'ii_scheme_declared_benchmark_versions', 'ii_factsheet_version_events', 'ii_factsheet_attempts']);
const isNewConstraint = (c) => NEW_TABLES.has(String(c.t).replace('public.', ''));
check('ADDITIVE: every pre-existing constraint is byte-identical after 0252 (no drop-and-recreate, no widened CHECK)', JSON.stringify(afterObj.constraints.filter((c) => !isNewConstraint(c))) === JSON.stringify(beforeObj.constraints));
check('ADDITIVE: every pre-existing column is identical after 0252', JSON.stringify(afterObj.columns.filter((c) => !NEW_TABLES.has(c.table_name))) === JSON.stringify(beforeObj.columns));
const beforeFuncs = new Map(beforeObj.funcs);
const changed = afterObj.funcs.filter(([n, d]) => beforeFuncs.has(n) && beforeFuncs.get(n) !== d).map(([n]) => n);
check('ADDITIVE: no pre-existing function body changed (the 0241 mapping / review / auto-publish functions are untouched)', changed.length === 0, changed.join(', '));
let second = null;
try { await db.exec(target); } catch (e) { second = e; }
check('0252 re-applies cleanly (idempotent)', second === null, second ? second.message.slice(0, 200) : 'second application was a no-op');
const seeds = await all(`select source_key, terms_review_status, host from ii_factsheet_sources order by 1`);
check('eight sources are seeded and ALL are not_reviewed (re-applying did not duplicate or change them)', seeds.length === 8 && seeds.every((s) => s.terms_review_status === 'not_reviewed'), JSON.stringify(seeds.map((s) => s.source_key)));
check('only official hosts are seeded (hdfcfund.com, sbimf.com, mf.nipponindiaim.com, icicipruamc.com)', seeds.every((s) => /(^|\.)(hdfcfund\.com|sbimf\.com|mf\.nipponindiaim\.com|icicipruamc\.com)$/.test(s.host)), JSON.stringify([...new Set(seeds.map((s) => s.host))]));
const sw = await one(`select enabled, disabled_reason from ii_reference_job_control where job_key = 'factsheet_benchmark_reader'`);
check('the kill switch ships DISABLED, with a reason', sw && sw.enabled === false && sw.disabled_reason?.length > 20);
check('0252 registers NO pg_cron schedule', (await all(`select jobname from cron.job where jobname ilike '%factsheet%'`)).length === 0);
const approvedBad = await tryQ(`update ii_factsheet_sources set terms_review_status = 'approved' where source_key = 'sbi_contra_sid_2025_10'`);
check('REFUSED: "approved" without a reviewer, a time and a note (CHECK), even for the table owner', sqlstate(approvedBad.err) === '23514', `SQLSTATE ${sqlstate(approvedBad.err)}`);

// ---- fixtures ---------------------------------------------------------------------------------------------------
const U = { CAT: '11111111-0000-0000-0000-000000000001', APPROVER: '11111111-0000-0000-0000-000000000002', VIEWER: '11111111-0000-0000-0000-000000000003', PLAIN: '11111111-0000-0000-0000-000000000004', INV: '11111111-0000-0000-0000-000000000005', NOCAP: '11111111-0000-0000-0000-000000000006' };
for (const [k, id] of Object.entries(U)) {
  await db.exec(`insert into auth.users (id, email) values ('${id}', '${k.toLowerCase()}@example.test') on conflict do nothing;`);
  await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
}
for (const k of ['CAT', 'APPROVER', 'VIEWER', 'NOCAP']) await db.exec(`insert into admin_users (user_id) values ('${U[k]}') on conflict do nothing;`);
await db.exec(`update admin_users set can_manage_benchmark_catalogue = true where user_id = '${U.CAT}';
               update admin_users set can_approve_benchmark_entitlements = true where user_id = '${U.APPROVER}';
               update admin_users set can_view_reference_data_quality = true where user_id = '${U.VIEWER}';`);
const catEntry = (key) => ({ benchmark_key: key, official_name: `Test ${key}`, owner_name: 'Test Index Owner Ltd', official_identifier: key, asset_class: 'equity', country_code: 'IN', currency_code: 'INR', return_type: 'TRI', return_variant: 'total_return', frequency: 'business_daily', base_date: '1995-11-03', base_value: 1000, launch_date: '1996-04-22', history_start_date: '1996-04-22', history_class: 'live', calendar_code: 'IN_NSE', methodology_url: 'https://example.test/method', source_url: 'https://example.test/src', evidence_ref: 'unit-test fixture', evidence_retrieved_at: '2026-10-01' });
const bmA = (await rpc(U.CAT, 'upsert_benchmark_catalogue_entry', catEntry('TEST_A_TRI'))).rows[0].r;
const bmB = (await rpc(U.CAT, 'upsert_benchmark_catalogue_entry', catEntry('TEST_B_TRI'))).rows[0].r;
for (const id of [bmA, bmB]) await rpc(U.CAT, 'verify_benchmark_catalogue_entry', id, 'verified against the owner page (fixture)');

const ins = async (name) => (await one(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency) values ($1, 'mutual_fund', 'IN', 'INR') returning id`, [name])).id;
const I = { HELD: await ins('Held Fund'), REVERSED: await ins('Reversed Only Fund'), REVIEW: await ins('Review Only Fund'), NEVER: await ins('Nobody Holds This Fund'), CHANGE: await ins('Change Fund'), COMPOSITE: await ins('Composite Fund'), AUTO: await ins('Auto Fund'), VERIFIED: await ins('Verified Match Fund'), REJ: await ins('Rejected Fund') };
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('a0000000-0000-0000-0000-0000000000a1', '${U.INV}', 'IN', 'INR', 'mf_folio', 'Alpha AMC')`);
let n = 0;
const tx = async (inst, status) => {
  n += 1;
  await db.exec(`insert into ii_transactions (id, user_id, account_id, instrument_id, currency_code, status, transaction_type, transaction_date, units, gross_amount, source_reference)
                 values ('f0000000-0000-0000-0000-${String(n).padStart(12, '0')}', '${U.INV}', 'a0000000-0000-0000-0000-0000000000a1', '${I[inst]}', 'INR', '${status}', 'purchase', '2022-01-0${(n % 9) + 1}', 10, 1000, 'fixture:${n}')`);
};
await tx('HELD', 'parsed');
await tx('REVERSED', 'reversed');
await tx('REVIEW', 'review_required');
await db.exec(`insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, amc_name, scheme_structure, category_header_raw, sub_category, country_code, currency_code, record_checksum, effective_from)
               values ('${I.HELD}', '910001', 'Held Fund', 'Alpha Mutual Fund', 'open_ended', 'x', 'Large Cap Fund', 'IN', 'INR', 'chk1', '2020-01-01')`);
const srcId = (await one(`select id from ii_factsheet_sources where source_key = 'sbi_contra_sid_2025_10'`)).id;
const srcId2 = (await one(`select id from ii_factsheet_sources where source_key = 'hdfc_baf_sid_2024_06'`)).id;

console.log('--- held instruments ---');
let r = await rpc(U.INV, 'factsheet_reader_held_instruments');
check('REFUSED: a signed-in user cannot list held instruments (service role only)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'factsheet_reader_held_instruments');
check('REFUSED: an admin with every benchmark capability still cannot (the job is the service role)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
const anonExec = await one(`select has_function_privilege('anon','factsheet_reader_held_instruments()','execute') a, has_function_privilege('authenticated','factsheet_reader_held_instruments()','execute') b, has_function_privilege('service_role','factsheet_reader_held_instruments()','execute') c`);
check('EXECUTE: service_role only on the held-instruments function', !anonExec.a && !anonExec.b && anonExec.c, JSON.stringify(anonExec));
r = await rpc('service', 'factsheet_reader_held_instruments');
const heldNames = r.rows.map((x) => x.r).join('|');
const heldRows = (await svc(() => tryQ(`select * from factsheet_reader_held_instruments()`))).rows;
check('held = at least one counted transaction: the reversed-only and review_required-only instruments are NOT returned, the held one IS (with its AMFI code)', heldRows.length === 1 && heldRows[0].instrument_name === 'Held Fund' && heldRows[0].amfi_scheme_code === '910001', JSON.stringify(heldRows));
check('the result has exactly four columns and no user, count, unit or amount (and no value equals the investor id)', Object.keys(heldRows[0]).join(',') === 'instrument_id,instrument_name,amc_name,amfi_scheme_code' && !JSON.stringify(heldRows).includes(U.INV), Object.keys(heldRows[0]).join(','));
void heldNames;

console.log('--- job writers: service role only ---');
const verPayload = (instr, over = {}) => ({ instrument_id: instr, tier1_name: 'BSE 500 TRI', tier1_variant_hint: 'total_return', additional_names: [], benchmark_kind: 'single_index', composition: [{ weight_pct: null, name: 'BSE 500 TRI' }], catalogue_state: 'matched_verified', matched_benchmark_id: bmA, match_confidence: 'high', effective_from: '2025-08-01', effective_from_basis: 'estimated_document_month', source_id: srcId, source_url: 'https://www.sbimf.com/docs/x.pdf', source_title: null, source_document_type: 'amc_sid', document_date: '2025-08-31', document_date_precision: 'day', document_month: '2025-08-01', retrieved_at: '2026-10-03T02:00:00Z', document_checksum: 'a'.repeat(64), extraction_method: 'text_pattern', extractor_version: 'factsheet-pattern-v1', ai_model: null, extraction_confidence: 'high', extractors_agree: null, evidence_excerpt: 'First Tier Benchmark: BSE 500 TRI', review_state: 'awaiting_confirmation', review_reason: null, ...over });
r = await rpc(U.CAT, 'record_factsheet_version', verPayload(I.CHANGE), null);
check('REFUSED: an admin cannot write a version (service role only)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.INV, 'record_factsheet_attempt', { run_id: '00000000-0000-4000-8000-000000000001', run_month: '2026-10-01', source_id: srcId, instrument_id: I.CHANGE, attempted_at: '2026-10-03T00:00:00Z', outcome: 'confirmed_unchanged' });
check('REFUSED: an investor cannot write the attempt ledger', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
const direct = await as(U.CAT, () => tryQ(`insert into ii_scheme_declared_benchmark_versions (instrument_id, version_no, tier1_name, benchmark_kind, catalogue_state, effective_from, effective_from_basis, source_id, source_url, source_document_type, document_month, retrieved_at, document_checksum, extraction_method, extractor_version, extraction_confidence, review_state) values ('${I.CHANGE}', 1, 'X TRI', 'single_index', 'matched_verified', '2025-01-01', 'document_stated', '${srcId}', 'https://x.test/', 'amc_sid', '2025-01-01', now(), 'c', 'text_pattern', 'v', 'high', 'pending_review')`));
check('REFUSED: a direct INSERT into the versions table by an authenticated admin (no write grant: only the function writes)', direct.err !== null, `SQLSTATE ${sqlstate(direct.err)}`);

r = await rpc('service', 'record_factsheet_version', verPayload(I.CHANGE), null);
const v1 = r.rows[0]?.r;
check('service role appends version 1', !r.err && !!v1, r.err?.message);
r = await rpc('service', 'record_factsheet_version', verPayload(I.CHANGE, { tier1_name: 'Nifty 500 TRI' }), null);
check('REFUSED: appending with a STALE "previous" (null, but v1 exists): serialization failure 40001, nothing written', sqlstate(r.err) === '40001', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc('service', 'record_factsheet_version', verPayload(I.CHANGE, { tier1_name: 'Nifty 500 TRI', review_state: 'pending_review', review_reason: 'changed', effective_from: '2026-02-01', document_month: '2026-02-01' }), v1);
const v2 = r.rows[0]?.r;
const vs = await all(`select version_no, supersedes_version_id, tier1_name from ii_scheme_declared_benchmark_versions where instrument_id = '${I.CHANGE}' order by version_no`);
check('a CHANGE is a NEW version numbered 2 that supersedes version 1; version 1 is still there, unchanged', !r.err && vs.length === 2 && vs[0].tier1_name === 'BSE 500 TRI' && vs[1].version_no === 2 && vs[1].supersedes_version_id === v1, JSON.stringify(vs));
for (const [verb, sql] of [['UPDATE', `update ii_scheme_declared_benchmark_versions set tier1_name = 'tampered' where id = '${v1}'`], ['DELETE', `delete from ii_scheme_declared_benchmark_versions where id = '${v1}'`], ['TRUNCATE (CASCADE, so the foreign keys do not refuse it first and the trigger itself is exercised)', 'truncate ii_scheme_declared_benchmark_versions cascade'], ['TRUNCATE of the attempt ledger', 'truncate ii_factsheet_attempts'], ['TRUNCATE of the events', 'truncate ii_factsheet_version_events']]) {
  const e = (await tryQ(sql)).err;
  check(`APPEND-ONLY: ${verb} on versions refused even for the table owner`, sqlstate(e) === '42501' && /append-only/.test(e.message), `SQLSTATE ${sqlstate(e)}`);
}
check('version 1 is byte-for-byte unchanged after the refused attempts', (await one(`select tier1_name from ii_scheme_declared_benchmark_versions where id = '${v1}'`)).tier1_name === 'BSE 500 TRI');
const bad = await rpc('service', 'record_factsheet_version', verPayload(I.COMPOSITE, { catalogue_state: 'invented_state' }), null);
check('REFUSED: a catalogue state outside the five (CHECK)', sqlstate(bad.err) === '23514', `SQLSTATE ${sqlstate(bad.err)}`);

const att = (over = {}) => ({ run_id: '00000000-0000-4000-8000-000000000001', run_month: '2026-10-01', source_id: srcId, instrument_id: I.CHANGE, attempted_at: '2026-10-03T00:00:00Z', outcome: 'confirmed_unchanged', ...over });
r = await rpc('service', 'record_factsheet_attempt', att());
check('service role records a terminal attempt', !r.err, r.err?.message);
r = await rpc('service', 'record_factsheet_attempt', att({ outcome: 'recorded_change' }));
check('IDEMPOTENT MONTH: a second TERMINAL result for the same scheme, source and month is refused (23505)', sqlstate(r.err) === '23505', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc('service', 'record_factsheet_attempt', att({ run_month: '2026-11-01' }));
check('the next month is a new month: allowed', !r.err, r.err?.message);
r = await rpc('service', 'record_factsheet_attempt', att({ source_id: srcId2 }));
check('another source for the same scheme in the same month is a different result: allowed', !r.err, r.err?.message);
for (let i = 0; i < 3; i++) r = await rpc('service', 'record_factsheet_attempt', att({ instrument_id: I.VERIFIED, outcome: 'fetch_failed' }));
check('a NON-terminal outcome (fetch_failed) may repeat within the month (bounded by the runner)', !r.err && (await one(`select count(*)::int n from ii_factsheet_attempts where instrument_id = '${I.VERIFIED}'`)).n === 3);
const aDel = (await tryQ(`delete from ii_factsheet_attempts`)).err;
check('APPEND-ONLY: the attempt ledger refuses DELETE', sqlstate(aDel) === '42501', `SQLSTATE ${sqlstate(aDel)}`);
const bogus = await rpc('service', 'record_factsheet_attempt', att({ outcome: 'made_up' , run_month: '2026-12-01' }));
check('REFUSED: an outcome outside the list (CHECK)', sqlstate(bogus.err) === '23514', `SQLSTATE ${sqlstate(bogus.err)}`);

console.log('--- the review function (existing mapping review path) ---');
// give CHANGE a proposal for v2 (single index, verified benchmark), as the runner would
const prop = { instrument_id: I.CHANGE, benchmark_id: bmB, proposed_benchmark_name: 'Nifty 500 TRI', relationship_type: 'primary', effective_from: '2026-02-01', evidence_source: 'amc_sid', evidence_url: 'https://www.sbimf.com/docs/x.pdf', evidence_document_date: '2026-02-01', evidence_retrieved_at: '2026-10-03', resolution_method: 'admin_judgement', confidence: 'high', ambiguity_reason: 'The declared benchmark changed.' };
const pid = (await rpc('service', 'propose_benchmark_mapping', prop)).rows[0]?.r;
await rpc('service', 'record_factsheet_version_event', { version_id: v2, event_type: 'proposal_created', proposal_id: pid });
const oldProp = { ...prop, benchmark_id: bmA, proposed_benchmark_name: 'BSE 500 TRI', effective_from: '2025-08-01', resolution_method: 'deterministic_exact', ambiguity_reason: null, evidence_document_date: '2025-08-31' };
const pid1 = (await rpc('service', 'propose_benchmark_mapping', oldProp)).rows[0]?.r;
const auto = (await rpc('service', 'auto_publish_benchmark_mapping', pid1)).rows[0]?.r;
check('the EXISTING auto-publish function publishes the first (clean, deterministic) mapping', auto?.auto_published === true, JSON.stringify(auto));
await rpc('service', 'record_factsheet_version_event', { version_id: v1, event_type: 'auto_published', proposal_id: pid1, mapping_id: auto?.mapping_id });
r = await rpc(U.INV, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', true);
check('REFUSED: an investor cannot decide a change', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.VIEWER, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', true);
check('REFUSED: a view-only admin cannot decide a change', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.APPROVER, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', true);
check('REFUSED: an entitlement approver (a different capability) cannot decide a change', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'review_factsheet_change', v2, 'approve', 'short', true);
check('REFUSED: a note of fewer than 10 characters', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'review_factsheet_change', v2, 'publish-it', 'a long enough review note', true);
check('REFUSED: an unknown decision', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', false);
check('REFUSED: approving a CHANGE without closing the previous mapping (the existing overlap rule bites, 23P01); nothing was decided', sqlstate(r.err) === '23P01' && (await one(`select count(*)::int n from ii_factsheet_version_events where version_id = '${v2}' and event_type = 'approved'`)).n === 0, `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', true);
const maps = await all(`select b.benchmark_key, m.effective_from::text ef, m.effective_to::text et from ii_instrument_benchmarks m join ii_benchmarks b on b.id = m.benchmark_id where m.instrument_id = '${I.CHANGE}' and m.relationship_type = 'primary' order by m.effective_from`);
check('approve with closePrevious creates the effective-dated mapping through the existing review path: the old one ends the day before, the new one is open', !r.err && maps.length === 2 && maps[0].benchmark_key === 'TEST_A_TRI' && maps[0].et === '2026-01-31' && maps[1].benchmark_key === 'TEST_B_TRI' && maps[1].et === null, JSON.stringify(maps));
r = await rpc(U.CAT, 'review_factsheet_change', v2, 'approve', 'approved after reading the document', true);
check('REFUSED: deciding the same item twice (55000)', sqlstate(r.err) === '55000', `SQLSTATE ${sqlstate(r.err)}`);
check('both versions are still on record after the approval (history is never edited)', (await one(`select count(*)::int n from ii_scheme_declared_benchmark_versions where instrument_id = '${I.CHANGE}'`)).n === 2);

// reject / acknowledge
const rejV = (await rpc('service', 'record_factsheet_version', verPayload(I.REJ, { review_state: 'pending_review', review_reason: 'x', catalogue_state: 'no_catalogue_match', matched_benchmark_id: null, match_confidence: null }), null)).rows[0]?.r;
r = await rpc(U.CAT, 'review_factsheet_change', rejV, 'approve', 'approve with no proposal at all', false);
check('REFUSED: approve when there is no mapping proposal (unsupported items can only be acknowledged, rejected or entered manually)', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.CAT, 'review_factsheet_change', rejV, 'reject', 'the reader misread this benchmark', false);
check('reject records the decision and keeps the version', !r.err && (await one(`select count(*)::int n from ii_factsheet_version_events where version_id = '${rejV}' and event_type = 'rejected'`)).n === 1);

const compV = (await rpc('service', 'record_factsheet_version', verPayload(I.COMPOSITE, { benchmark_kind: 'composite', catalogue_state: 'unsupported_composite', matched_benchmark_id: null, match_confidence: null, review_state: 'pending_review', tier1_name: '45% BSE 500 TRI + 40% Crisil Composite Bond Fund Index + 10% Domestic prices of Gold + 5% Domestic prices of silver', composition: [{ weight_pct: 45, name: 'BSE 500 TRI' }, { weight_pct: 40, name: 'Crisil Composite Bond Fund Index' }, { weight_pct: 10, name: 'Domestic prices of Gold' }, { weight_pct: 5, name: 'Domestic prices of silver' }] }), null)).rows[0]?.r;
const opIdx = (await rpc('service', 'propose_benchmark_mapping', { ...prop, instrument_id: I.COMPOSITE, effective_from: '2023-10-31' })).rows[0]?.r;
void opIdx;
await db.exec(`insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, effective_from, mapping_basis, mapping_version, quality_status) values ('${I.COMPOSITE}', '${bmA}', 'primary', '2020-01-01', 'scheme_disclosed', 'fixture', 'ok')`);
r = await rpc(U.CAT, 'review_factsheet_change', compV, 'acknowledge', 'composite recorded; close the old mapping', true);
const compMap = await one(`select effective_to::text et from ii_instrument_benchmarks where instrument_id = '${I.COMPOSITE}' and relationship_type = 'primary'`);
check('acknowledge (an unsupported composite): nothing published; the scheme\'s open mapping is closed the day before the composite took effect', !r.err && compMap.et === '2025-07-31', JSON.stringify(compMap));

console.log('--- terms status (entitlement-approver capability) ---');
r = await rpc(U.CAT, 'set_factsheet_source_terms_status', srcId, 'approved', 'terms reviewed by counsel on 3 Oct 2026');
check('REFUSED: a catalogue admin cannot approve a source\'s terms (a different capability)', sqlstate(r.err) === '42501', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.APPROVER, 'set_factsheet_source_terms_status', srcId, 'approved', 'short');
check('REFUSED: no note of at least 10 characters', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.APPROVER, 'set_factsheet_source_terms_status', srcId, 'maybe', 'a long enough note for it');
check('REFUSED: an unknown status', sqlstate(r.err) === '22023', `SQLSTATE ${sqlstate(r.err)}`);
r = await rpc(U.APPROVER, 'set_factsheet_source_terms_status', srcId, 'approved', 'terms reviewed by counsel on 3 Oct 2026');
const approved = await one(`select terms_review_status, terms_reviewed_by::text rb, terms_reviewed_at is not null ra from ii_factsheet_sources where id = '${srcId}'`);
check('the entitlement approver can set the status; the reviewer and time are recorded; the change is in the governance log', !r.err && approved.terms_review_status === 'approved' && approved.rb === U.APPROVER && approved.ra && (await one(`select count(*)::int n from ii_benchmark_governance_events where event_type = 'factsheet_source_terms_status_set'`)).n === 1);
check('only that one source changed (the other seven are still not_reviewed)', (await one(`select count(*)::int n from ii_factsheet_sources where terms_review_status = 'not_reviewed'`)).n === 7);

console.log('--- declared_benchmark_records_for() (the end-user read function) ---');
const anon = await asRole('anon', { role: 'anon' }, () => tryQ(`select * from declared_benchmark_records_for(array['${I.COMPOSITE}']::uuid[])`));
check('REFUSED: anon cannot call it (no EXECUTE)', anon.err !== null, `SQLSTATE ${sqlstate(anon.err)}`);
const plain = await as(U.PLAIN, () => tryQ(`select * from declared_benchmark_records_for(array['${I.COMPOSITE}', '${I.CHANGE}', '${I.REJ}', '${I.AUTO}']::uuid[])`));
const got = Object.fromEntries(plain.rows.map((x) => [x.instrument_id, x]));
check('an unsupported COMPOSITE (latest version, acknowledged) is returned with its name as stated', !plain.err && got[I.COMPOSITE]?.catalogue_state === 'unsupported_composite' && /45% BSE 500 TRI/.test(got[I.COMPOSITE].declared_name), JSON.stringify(plain.rows));
check('NOT returned: an APPROVED single-series change (it has a mapping now), a REJECTED one, and a scheme with no record', !got[I.CHANGE] && !got[I.REJ] && !got[I.AUTO]);
const big = await as(U.PLAIN, () => tryQ(`select * from declared_benchmark_records_for(array(select gen_random_uuid() from generate_series(1, 501)))`));
check('REFUSED: more than 500 instruments in one call', sqlstate(big.err) === '22023', `SQLSTATE ${sqlstate(big.err)}`);
check('the function returns exactly four columns: no user, holding or amount', plain.rows[0] && Object.keys(plain.rows[0]).join(',') === 'instrument_id,declared_name,benchmark_kind,catalogue_state');
const vmatch = (await rpc('service', 'record_factsheet_version', verPayload(I.VERIFIED), null)).rows[0]?.r;
const awaiting = await as(U.PLAIN, () => tryQ(`select * from declared_benchmark_records_for(array['${I.VERIFIED}']::uuid[])`));
check('NOT returned: a verified, clean single-index reading that has no mapping yet (it keeps the category fallback until it is published)', vmatch && awaiting.rows.length === 0);
const other = (await rpc('service', 'record_factsheet_version', verPayload(I.AUTO, { catalogue_state: 'matched_other', match_confidence: 'medium', review_state: 'pending_review' }), null)).rows[0]?.r;
const awaitingReview = await as(U.PLAIN, () => tryQ(`select * from declared_benchmark_records_for(array['${I.AUTO}']::uuid[])`));
check('a declared record awaiting review (a possible but unconfirmed catalogue match) IS returned, so a possibly different category index is never swapped in', other && awaitingReview.rows.length === 1 && awaitingReview.rows[0].catalogue_state === 'matched_other');

console.log('--- RLS: the new tables are readable by benchmark viewers only ---');
const viewerRead = await as(U.VIEWER, () => tryQ(`select count(*)::int n from ii_scheme_declared_benchmark_versions`));
const investorRead = await as(U.INV, () => tryQ(`select count(*)::int n from ii_scheme_declared_benchmark_versions`));
const nocapRead = await as(U.NOCAP, () => tryQ(`select count(*)::int n from ii_factsheet_attempts`));
check('a view-only admin can read versions; an investor and an admin with no benchmark capability read ZERO rows (RLS)', !viewerRead.err && viewerRead.rows[0].n > 0 && investorRead.rows[0].n === 0 && nocapRead.rows[0].n === 0, JSON.stringify([viewerRead.rows, investorRead.rows, nocapRead.rows]));
const srcUpd = await as(U.CAT, () => tryQ(`update ii_factsheet_sources set terms_review_status = 'approved' where id = '${srcId2}'`));
check('REFUSED: an admin cannot flip a source to approved by a direct UPDATE (no write grant; only the capability-checked function)', srcUpd.err !== null || (await one(`select terms_review_status s from ii_factsheet_sources where id = '${srcId2}'`)).s === 'not_reviewed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
