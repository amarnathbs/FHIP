// PC6 -- PGlite verification for migration 0204 (exact-pair NAV lookup,
// public.ii_prices_nav_existing_pairs(uuid[], date[])).
//
// Replays the real migration chain, seeds NAV rows, and proves:
//   * ANTI-VACUITY: before 0204 the function does not exist; the seeded data
//     really does make the old "instrument IN x date IN" cross product return
//     MORE rows than the exact pairs (so "exact" is a real difference, not a
//     restatement of the old query);
//   * the function returns exactly the stored rows for the given pairs, with
//     the same values the old query returned for those pairs;
//   * absent pairs return nothing; unequal array lengths raise 22023 (never
//     silently padded); empty/null arrays return nothing;
//   * it is `returns table`, SECURITY INVOKER, with a fixed search_path;
//   * EXECUTE: service_role yes; PUBLIC, anon, authenticated no -- and the
//     NEGATIVE CONTROL shows an identical function WITHOUT the revokes is
//     executable by anon under this environment's default privileges, so the
//     privilege checks are not vacuous; anon is really refused at call time;
//   * re-applying 0204 is a clean no-op.
//
// Run: node scripts/pc6_0204_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0204_pc6_prices_nav_exact_pair_lookup.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes(TARGET)) { console.error(`missing ${TARGET}`); process.exit(2); }
// Mutation testing: PC6_0204_SQL=<path> applies a different body as "0204" to prove named checks fail.
const TARGET_SQL = fs.readFileSync(process.env.PC6_0204_SQL || path.join(MIG, TARGET), 'utf8');
if (process.env.PC6_0204_SQL) console.log(`  (mutation run: 0204 body from ${process.env.PC6_0204_SQL})`);

async function replay(stopBefore = null) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (stopBefore && f >= stopBefore) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  PC6-0204-${String(pass + fail).padStart(2, '0')}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const FN = 'public.ii_prices_nav_existing_pairs(uuid[], date[])';
const fnExists = async (db) => (await db.query(`select to_regprocedure('${FN}') is not null as ok`)).rows[0].ok;

const db = await replay(TARGET);
check('ANTI-VACUITY: just before 0204 the function does not exist', (await fnExists(db)) === false);

// Seed: 3 instruments; A and B have NAVs on d1..d4, C only on d1 (a "dormant" scheme).
const inst = {};
for (const n of ['A', 'B', 'C']) {
  inst[n] = (await db.query(
    `insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency) values ($1, 'mutual_fund', 'IN', 'INR') returning id`,
    [`PC6-0204 Fund ${n}`]
  )).rows[0].id;
}
const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
let k = 0;
for (const n of ['A', 'B']) for (const d of days) {
  k++;
  await db.query(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, record_checksum, quality_status) values ($1, 'INR', $2, $3, $4, $5)`,
    [inst[n], d, `${100 + k}.1234567890`, `ck-${n}-${d}`, k === 3 ? 'suspicious_jump' : 'ok']);
}
await db.query(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, record_checksum) values ($1, 'INR', '2016-03-31', 12.5, 'ck-C-old')`, [inst.C]);
// A has years of history, including on C's old date -- the real shape that made the old query explode.
await db.query(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, record_checksum) values ($1, 'INR', '2016-03-31', 10.25, 'ck-A-old')`, [inst.A]);

// The pairs a file would carry: A and B on the current date, C on its old date, plus one pair that has no row.
const pairs = [[inst.A, '2026-09-24'], [inst.B, '2026-09-24'], [inst.C, '2016-03-31'], [inst.C, '2026-09-24']];
const ids = [...new Set(pairs.map((p) => p[0]))];
const dates = [...new Set(pairs.map((p) => p[1]))];
const legacy = (await db.query(
  `select instrument_id, price_date::text as price_date, price::text as price, record_checksum, quality_status from ii_prices_nav where instrument_id = any($1::uuid[]) and price_date = any($2::date[]) order by 1, 2`,
  [ids, dates])).rows;
const wantKeys = new Set([`${inst.A}|2026-09-24`, `${inst.B}|2026-09-24`, `${inst.C}|2016-03-31`]);
check('ANTI-VACUITY: the old cross-product query returns rows the file never asked about', legacy.length > wantKeys.size,
  `old query: ${legacy.length} rows for ${pairs.length} pairs (${wantKeys.size} of which exist)`);

// Apply 0204.
let applyErr = null;
try { await db.exec(TARGET_SQL); } catch (e) { applyErr = e.message; }
check('0204 applies cleanly on a full-chain replay', applyErr === null, applyErr ?? '');
check('after 0204 the function exists', await fnExists(db));

const meta = (await db.query(
  `select p.proretset, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) as result, p.proacl::text as acl
   from pg_proc p where p.oid = to_regprocedure('${FN}')`)).rows[0];
check('declared `returns table (instrument_id uuid, price_date date, price numeric, record_checksum text, quality_status text)`',
  meta.proretset === true && /^TABLE\(instrument_id uuid, price_date date, price numeric, record_checksum text, quality_status text\)$/.test(meta.result), meta.result);
check('SECURITY INVOKER (not definer)', meta.prosecdef === false);
check('fixed search_path', (meta.proconfig ?? []).some((c) => /^search_path=public, ?pg_temp$/.test(c)), JSON.stringify(meta.proconfig));

const call = async (idArr, dateArr) => (await db.query(
  `select instrument_id, price_date::text as price_date, price::text as price, record_checksum, quality_status from public.ii_prices_nav_existing_pairs($1::uuid[], $2::date[]) order by 1, 2`,
  [idArr, dateArr])).rows;
const got = await call(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
const gotKeys = new Set(got.map((r) => `${r.instrument_id}|${r.price_date}`));
check('returns EXACTLY the stored rows for the asked pairs (3 of 4 exist; none extra)',
  got.length === wantKeys.size && [...wantKeys].every((x) => gotKeys.has(x)), `${got.length} rows: ${[...gotKeys].join(', ')}`);
const legacyByKey = new Map(legacy.map((r) => [`${r.instrument_id}|${r.price_date}`, r]));
check('values (price, record_checksum, quality_status) identical to the old query for those pairs',
  got.every((r) => { const l = legacyByKey.get(`${r.instrument_id}|${r.price_date}`); return l && l.price === r.price && l.record_checksum === r.record_checksum && l.quality_status === r.quality_status; }));
check('a pair with no stored row returns nothing', !gotKeys.has(`${inst.C}|2026-09-24`));
check('quality_status is carried through (a non-ok row is returned as such)',
  (await call([inst.A], ['2026-09-23'])).some((r) => r.quality_status === 'suspicious_jump'));

let lenErr = null;
try { await call([inst.A, inst.B], ['2026-09-24']); } catch (e) { lenErr = e; }
check('unequal array lengths RAISE (22023), never silently padded', lenErr !== null && /same length/.test(lenErr.message) && lenErr.code === '22023', lenErr?.message ?? 'no error');
check('empty arrays return nothing', (await call([], [])).length === 0);
check('null arrays return nothing', (await db.query(`select count(*)::int as n from public.ii_prices_nav_existing_pairs(null, null)`)).rows[0].n === 0);

// 1000 pairs, 1000 hits max: a duplicate pair is asked twice -> at most one row per INPUT pair.
const dup = await call([inst.A, inst.A], ['2026-09-24', '2026-09-24']);
check('never more rows than input pairs (duplicate input pair -> one row per input pair)', dup.length === 2);

// Privileges.
const priv = async (role) => (await db.query(`select has_function_privilege('${role}', '${FN}', 'execute') as ok`)).rows[0].ok;
check('service_role CAN execute', await priv('service_role'));
check('anon can NOT execute', (await priv('anon')) === false);
check('authenticated can NOT execute', (await priv('authenticated')) === false);
check('PUBLIC has no EXECUTE entry in the ACL', !/(^|[{,])=X/.test(meta.acl ?? ''), meta.acl ?? '(null acl = default PUBLIC execute!)');

// Negative control: the same function WITHOUT the revokes is executable by anon here.
await db.exec(`create function public.pc6_0204_negctl(p uuid[]) returns table (x uuid) language sql stable as $$ select unnest(p) $$;`);
const negAnon = (await db.query(`select has_function_privilege('anon', 'public.pc6_0204_negctl(uuid[])', 'execute') as ok`)).rows[0].ok;
check('NEGATIVE CONTROL: an identical function without the revokes IS executable by anon (the checks above are not vacuous)', negAnon === true);
await db.exec(`drop function public.pc6_0204_negctl(uuid[])`);

// Call-time refusal as anon, success as service_role.
let anonErr = null;
try {
  await db.exec(`set role anon`);
  await db.query(`select * from public.ii_prices_nav_existing_pairs(array[$1]::uuid[], array['2026-09-24']::date[])`, [inst.A]);
} catch (e) { anonErr = e.message; } finally { await db.exec(`reset role`); }
check('calling it AS anon is refused with permission denied', anonErr !== null && /permission denied/i.test(anonErr), anonErr ?? 'no error');
let srRows = null;
try {
  await db.exec(`set role service_role`);
  srRows = (await db.query(`select * from public.ii_prices_nav_existing_pairs(array[$1]::uuid[], array['2026-09-24']::date[])`, [inst.A])).rows;
} finally { await db.exec(`reset role`); }
check('calling it AS service_role returns the row', Array.isArray(srRows) && srRows.length === 1);

let reErr = null;
try { await db.exec(TARGET_SQL); } catch (e) { reErr = e.message; }
check('re-applying 0204 is a clean no-op (and privileges still correct)', reErr === null && (await priv('anon')) === false && (await priv('service_role')), reErr ?? '');

console.log(`\n=== PC6 / 0204 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
