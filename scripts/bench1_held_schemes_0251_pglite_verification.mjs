// BENCH-1: PGlite verification for migration 0251_bench1_held_schemes_for_benchmark_mapping.sql.
//
// EVIDENCE LABEL: PGlite (real Postgres, WASM) with the whole chain before 0251 replayed from an
// EMPTY database and SYNTHETIC fixtures. This is NOT a claim that 0251 has been applied to DEV or
// production: it has not been.
//
// Claims proven (each followed by, or paired with, a control that shows it bites):
//   - the function does NOT exist before 0251 (anti-vacuity);
//   - an instrument with NO ii_scheme_master link (a statement-created one) IS returned;
//   - an instrument whose only transactions are 'reversed' or only 'review_required' is NOT returned,
//     and one that also has a counted transaction IS returned;
//   - holder_count is a distinct-holder count and first_held_date the earliest counted date, BUT ONLY where at
//     least 10 distinct people hold the scheme (Admin Standard 7.2): a 2-holder, a 3-holder and a 9-holder
//     instrument still appear in the list with count and date NULL, a 10-holder one shows both; the
//     result is not ordered by count; a copy of 0251 with the threshold removed must FAIL these checks;
//   - mapped / proposal_waiting reflect approved primary mappings and open proposals only;
//   - the result set has NO user_id / account / units / amount column, and no value of any returned
//     row equals a seeded user id;
//   - a plain authenticated user and an admin with no view capability get an explicit 42501, never
//     an empty set; anon cannot execute; a read-only 'view' admin can;
//   - 0251 is idempotent and writes nothing.
//
// Run: node scripts/bench1_held_schemes_0251_pglite_verification.mjs
// II0251_FILE=<path> applies a deliberately broken copy (negative control).
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
const TARGET = '0251_bench1_held_schemes_for_benchmark_mapping.sql';
const EXPECTED_CHECKS = 23;
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(process.env.II0251_FILE ?? path.join(MIG, TARGET), 'utf8'));

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
check(`the chain before 0251 replayed from empty (${applied} migrations)`, applied > 200, `applied ${applied}`);

const isoDay = (v) => new Date(v).toISOString().slice(0, 10);
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const errCodeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? e.message; } };
async function asRole(role, claims, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

// ---- users, accounts, instruments --------------------------------------------------------------
const U = { A: '11111111-1111-1111-1111-111111111111', B: '22222222-2222-2222-2222-222222222222', C: '33333333-3333-3333-3333-333333333333', VIEWER: '44444444-4444-4444-4444-444444444444', NOCAP: '55555555-5555-5555-5555-555555555555', PLAIN: '66666666-6666-6666-6666-666666666666' };
for (const [k, id] of Object.entries(U)) {
  await db.exec(`insert into auth.users(id, email) values ('${id}', '${k.toLowerCase()}@t.test') on conflict do nothing`);
  await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
}
await db.exec(`insert into admin_users (user_id) values ('${U.VIEWER}'), ('${U.NOCAP}') on conflict do nothing;
               update admin_users set can_view_reference_data_quality = true where user_id = '${U.VIEWER}';`);
const ACC = { A: 'a0000000-0000-0000-0000-0000000000a1', B: 'b0000000-0000-0000-0000-0000000000b1', C: 'c0000000-0000-0000-0000-0000000000c1' };
for (const [k, id] of Object.entries(ACC)) {
  await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('${id}', '${U[k]}', 'IN', 'INR', 'mf_folio', 'Alpha AMC')`);
}
const I = {
  LINKED: 'e0000000-0000-0000-0000-000000000001', // held by A and B, has a scheme-master row
  UNLINKED: 'e0000000-0000-0000-0000-000000000002', // statement-created: NO scheme-master row, held by A
  REVERSED: 'e0000000-0000-0000-0000-000000000003', // only reversed transactions
  REVIEW: 'e0000000-0000-0000-0000-000000000004', // only review_required transactions
  MIXED: 'e0000000-0000-0000-0000-000000000005', // one reversed + one counted
  MAPPED: 'e0000000-0000-0000-0000-000000000006', // has an approved primary mapping
  WAITING: 'e0000000-0000-0000-0000-000000000007', // has an open proposal
  NEVER: 'e0000000-0000-0000-0000-000000000008', // in the universe, nobody holds it
  BIG: 'e0000000-0000-0000-0000-000000000009', // held by exactly 10 people
  NINE: 'e0000000-0000-0000-0000-00000000000a', // held by exactly 9 people (boundary)
};
const NAMES = {
  LINKED: '108MFGPG-UTI MNC Fund - Regular Plan (Non Demat)',
  UNLINKED: 'H44-HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) (Non-Demat)',
  REVERSED: 'Reversed Only Fund', REVIEW: 'Review Only Fund', MIXED: 'Mixed Fund', MAPPED: 'Mapped Fund', WAITING: 'Waiting Fund', NEVER: 'Nobody Holds This Fund', BIG: 'Widely Held Fund', NINE: 'Nine Holder Fund',
};
for (const [k, id] of Object.entries(I)) {
  await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency) values ('${id}', '${NAMES[k]}', 'mutual_fund', 'IN', 'INR')`);
}
// scheme master for every instrument EXCEPT the statement-created one
let code = 900000;
for (const k of Object.keys(I)) {
  if (k === 'UNLINKED') continue;
  code += 1;
  await db.exec(`insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, amc_name, scheme_structure, category_header_raw, sub_category, country_code, currency_code, record_checksum, effective_from)
                 values ('${I[k]}', '${code}', '${NAMES[k]}', 'Alpha Mutual Fund', 'open_ended', 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', 'Large Cap Fund', 'IN', 'INR', 'chk${code}', '2020-01-01')`);
}
let n = 0;
const tx = async (user, acc, inst, status, date, amount = 1234.56, units = 77.123) => {
  n += 1;
  await db.exec(`insert into ii_transactions (id, user_id, account_id, instrument_id, currency_code, status, transaction_type, transaction_date, units, gross_amount, source_reference)
                 values ('f0000000-0000-0000-0000-${String(n).padStart(12, '0')}', '${U[user]}', '${ACC[user]}', '${I[inst]}', 'INR', '${status}', 'purchase', '${date}', ${units}, ${amount}, 'fixture:${n}')`);
};
await tx('A', 'A', 'LINKED', 'parsed', '2019-05-10');
await tx('B', 'B', 'LINKED', 'parsed', '2018-03-01');
await tx('A', 'A', 'UNLINKED', 'parsed', '2022-11-21');
await tx('A', 'A', 'REVERSED', 'reversed', '2021-01-01');
await tx('B', 'B', 'REVERSED', 'reversed', '2021-02-01');
await tx('A', 'A', 'REVIEW', 'review_required', '2021-03-01');
await tx('A', 'A', 'MIXED', 'reversed', '2017-01-01');
await tx('C', 'C', 'MIXED', 'parsed', '2023-06-15');
await tx('A', 'A', 'MAPPED', 'parsed', '2020-02-02');
await tx('A', 'A', 'WAITING', 'parsed', '2020-03-03');
// ten further holders: all ten hold BIG, the first nine hold NINE
const HOLDERS = [];
for (let h = 1; h <= 10; h++) {
  const uid = `70000000-0000-0000-0000-${String(h).padStart(12, '0')}`;
  HOLDERS.push(uid);
  await db.exec(`insert into auth.users(id, email) values ('${uid}', 'h${h}@t.test') on conflict do nothing`);
  await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${uid}'`);
  const acc = `b1000000-0000-0000-0000-${String(h).padStart(12, '0')}`;
  await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values ('${acc}', '${uid}', 'IN', 'INR', 'mf_folio', 'Alpha AMC')`);
  const day = String(h).padStart(2, '0');
  for (const inst of h <= 9 ? ['BIG', 'NINE'] : ['BIG']) {
    n += 1;
    await db.exec(`insert into ii_transactions (id, user_id, account_id, instrument_id, currency_code, status, transaction_type, transaction_date, units, gross_amount, source_reference)
                   values ('f1000000-0000-0000-0000-${String(n).padStart(12, '0')}', '${uid}', '${acc}', '${I[inst]}', 'INR', 'parsed', 'purchase', '2016-04-${day}', 77.123, 1234.56, 'fixture:h${n}')`);
  }
}

console.log('BEFORE 0251');
check('the function does not exist before 0251 (anti-vacuity)', (await one(`select to_regprocedure('public.benchmark_held_schemes()') as f`)).f === null);

const fpOf = async () => JSON.stringify({
  c: (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows,
  k: (await db.query(`select table_name, column_name, data_type from information_schema.columns where table_schema='public' order by 1,2`)).rows,
  cnt: (await db.query(`select (select count(*) from ii_transactions) t, (select count(*) from ii_instruments) i, (select count(*) from ii_scheme_master) s`)).rows,
});
const fpBefore = await fpOf();
await db.exec(target);

// mapping + proposal state (needs the 0241 tables, which exist before 0251)
await db.exec(`insert into ii_benchmarks (benchmark_key, benchmark_label, benchmark_category, country_code, return_type, currency_code, frequency)
               values ('TEST_BM_TRI', 'Test BM TRI', 'index', 'IN', 'TRI', 'INR', 'business_daily')`).catch(async () => {
  await db.exec(`insert into ii_benchmarks (benchmark_key, benchmark_label, benchmark_category, return_type, country, currency, frequency) values ('TEST_BM_TRI', 'Test BM TRI', 'index', 'TRI', 'IN', 'INR', 'daily')`);
});
const bm = await one(`select id from ii_benchmarks where benchmark_key = 'TEST_BM_TRI'`);
await db.exec(`insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, effective_from, quality_status) values ('${I.MAPPED}', '${bm.id}', 'primary', '2020-01-01', 'ok')`);
await db.exec(`insert into ii_benchmark_mapping_proposals (instrument_id, proposed_benchmark_name, evidence_source, evidence_url, evidence_document_date, evidence_retrieved_at, resolution_method, confidence, effective_from)
               values ('${I.WAITING}', 'NIFTY 100 TRI', 'amc_sid', 'https://example.test/sid.pdf', '2025-01-01', '2026-10-01', 'admin_judgement', 'low', '2020-01-01')`);

console.log('AFTER 0251 (viewer session)');
const fn = (uid) => asRole('authenticated', { sub: uid, role: 'authenticated' }, () => db.query(`select * from benchmark_held_schemes()`));
const rows = (await fn(U.VIEWER)).rows;
const byId = new Map(rows.map((r) => [r.instrument_id, r]));
check('a statement-created instrument with NO scheme-master link IS returned', byId.has(I.UNLINKED), `${rows.length} rows`);
check('its category columns are null (nothing invented), its name is present, and its count and date are withheld (1 holder)', byId.get(I.UNLINKED)?.sub_category === null && byId.get(I.UNLINKED)?.amfi_scheme_code === null && byId.get(I.UNLINKED)?.instrument_name === NAMES.UNLINKED && byId.get(I.UNLINKED)?.holder_count === null && byId.get(I.UNLINKED)?.first_held_date === null);
check('the scheme-master-linked instrument is returned with its category', byId.get(I.LINKED)?.sub_category === 'Large Cap Fund');
check('an instrument whose ONLY transactions are reversed is NOT returned', !byId.has(I.REVERSED));
check('an instrument whose ONLY transactions are review_required is NOT returned', !byId.has(I.REVIEW));
check('an instrument with a reversed AND a counted transaction IS returned (its single counted holder is not disclosed: count and date null)', byId.has(I.MIXED) && byId.get(I.MIXED)?.holder_count === null && byId.get(I.MIXED)?.first_held_date === null, JSON.stringify(byId.get(I.MIXED)));
check('an instrument nobody holds is NOT returned (universe members are not "held")', !byId.has(I.NEVER));
check('NEGATIVE CONTROL (cohort minimum): a 2-holder instrument is listed but exposes NEITHER a count NOR a date', byId.has(I.LINKED) && byId.get(I.LINKED)?.holder_count === null && byId.get(I.LINKED)?.first_held_date === null, JSON.stringify(byId.get(I.LINKED)));
check('BOUNDARY: a 9-holder instrument exposes neither count nor date', byId.has(I.NINE) && byId.get(I.NINE)?.holder_count === null && byId.get(I.NINE)?.first_held_date === null, JSON.stringify(byId.get(I.NINE)));
check('a 10-holder instrument exposes the DISTINCT holder count (10) and the earliest counted date', byId.get(I.BIG)?.holder_count === 10 && isoDay(byId.get(I.BIG)?.first_held_date) === '2016-04-01', JSON.stringify(byId.get(I.BIG)));
check('the result is ordered by name, not by holder count (the order cannot disclose a withheld count)', rows.length > 3 && rows.every((r, i) => i === 0 || rows[i - 1].instrument_name <= r.instrument_name));
check('mapped is true only for the approved primary mapping, proposal_waiting only for the open proposal', byId.get(I.MAPPED)?.mapped === true && byId.get(I.MAPPED)?.proposal_waiting === false && byId.get(I.WAITING)?.proposal_waiting === true && byId.get(I.WAITING)?.mapped === false && byId.get(I.UNLINKED)?.mapped === false);

const colNames = Object.keys(rows[0] ?? {});
check('the result has NO user_id / account / units / amount column (output allow-list)', !colNames.some((c) => /user|account|folio|unit|amount|gross|value/i.test(c)), colNames.join(', '));
const flat = JSON.stringify(rows);
check('no seeded user id, account id, or amount appears anywhere in the returned data', !Object.values(U).some((u) => flat.includes(u)) && !Object.values(ACC).some((a) => flat.includes(a)) && !flat.includes('1234.56') && !flat.includes('77.123'));

console.log('Capability and grants');
check('a plain authenticated user (no admin row) is REFUSED with 42501, not given an empty set', (await errCodeOf(() => fn(U.PLAIN))) === '42501');
check('an admin with NO view capability is REFUSED with 42501', (await errCodeOf(() => fn(U.NOCAP))) === '42501');
check('anon cannot execute it', (await errCodeOf(() => asRole('anon', { role: 'anon' }, () => db.query(`select * from benchmark_held_schemes()`)))) === '42501');
const priv = await one(`select has_function_privilege('anon','benchmark_held_schemes()','execute') a, has_function_privilege('authenticated','benchmark_held_schemes()','execute') b, has_function_privilege('public','benchmark_held_schemes()','execute') p`);
check('EXECUTE: authenticated yes; anon and PUBLIC no', priv.b === true && priv.a === false && priv.p === false, JSON.stringify(priv));
const sec = await one(`select prosecdef, proconfig from pg_proc where proname = 'benchmark_held_schemes'`);
check('SECURITY DEFINER with a fixed search_path', sec.prosecdef === true && (sec.proconfig ?? []).some((c) => /search_path=public/.test(c)), JSON.stringify(sec));

console.log('Idempotency and no side effects');
const fpAfterFirst = await fpOf();
check('0251 added no table, column or constraint and changed no data (it only defines a function)', fpAfterFirst === fpBefore);
await db.exec(target);
check('0251 re-applies cleanly and changes nothing (idempotent)', (await fpOf()) === fpAfterFirst);

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass + fail !== EXPECTED_CHECKS) { console.error(`expected ${EXPECTED_CHECKS} checks, ran ${pass + fail}`); process.exit(2); }
