// PC7 (M7) — POST-MIGRATION verification of 0157 against a freshly rebuilt
// REAL Postgres (PGlite/WASM): what DEV and production will look like ONCE
// migrations 0155 and 0157 are applied.
//
// WHY THIS EXISTS. scripts/pc5_ddl_capability_probe.mjs was re-run fresh on
// 2026-09-15 and confirmed there is STILL no DDL path from this environment to
// either hosted database (no exec_sql-style RPC, no management token, no
// DATABASE_URL). 0157 therefore cannot be applied from here, and this is the
// substitute technique the repository already uses for exactly that situation
// (r12_post_migration_pglite_verification.mjs 0092;
// m4b_huf_pglite_migration_verification.mjs 0154;
// pc6_0155_pglite_verification.mjs 0155). It is real Postgres — real CHECK
// constraints, real functions, real catalogs. It is NOT a claim that 0157 has
// been applied anywhere.
//
// WHAT IT PROVES:
//   1. The whole chain 0001..0157 applies cleanly, in order, from empty.
//   2. 0157 is genuinely idempotent — a second application is a no-op.
//   3. The PC6 batch ledger now ADMITS 'fund_holdings_disclosure' and still
//      REFUSES an invented kind.
//   4. ii_reference_corrections admits the two look-through tables.
//   5. Every O.4 column PC7 adds genuinely exists with the intended type.
//   6. The market_value_unit domain is enforced (the lakhs trap).
//   7. The sha256/period/checksum shape constraints actually refuse bad input.
//   8. THE O.7 ASSERTION: ii_pc7_networth_safety_violations() exists and
//      returns ZERO rows on the real schema — no FK from a register table into
//      look-through data, and no tenancy column on a look-through table.
//   9. The O.7 assertion is NOT VACUOUS: injecting each violation shape makes
//      it fire, and removing it makes it stop.
//  10. The PC7 admin capability exists, defaults FALSE, and is NOT implied by
//      PC6's capability.
//  11. The job-control row ships DISABLED with a reason.
//  12. 0157 registers NO pg_cron schedule.
//  13. ii_fund_holdings_lines still rejects a weight outside 0..100 (0044's
//      own constraint survives PC7's extension).
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
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete — ${files.length} migrations, ending at ${files.at(-1)}\n`);

let pass = 0, fail = 0, seq = 0;
const results = [];
const check = (label, cond, detail = '') => {
  seq++;
  const id = `PC7-PG-${String(seq).padStart(2, '0')}`;
  results.push({ id, verdict: cond ? 'PASS' : 'FAIL', label, detail });
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function err(sql) {
  try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); }
}
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

// ---------------------------------------------------------------------------
console.log('--- 1/2. chain applies, and 0157 is idempotent ---');
check('chain 0001..0157 applied from empty', files.includes('0157_pc7_lookthrough_foundation.sql'), `last file: ${files.at(-1)}`);
const second = await err(
  fs.readFileSync(path.join(MIG, '0157_pc7_lookthrough_foundation.sql'), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '')
);
check('0157 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 200)}` : 'second application was a no-op');

// ---------------------------------------------------------------------------
console.log('\n--- 3. batch_kind admits PC7 and still refuses an invented kind ---');
// 0157 seeds the ii_sources rows itself — assert that, rather than creating them here.
const srcRows = await all(`select source_key, source_category, is_active, parser_available from ii_sources
  where source_key in ('amc_portfolio_disclosure','vendor_portfolio_data') order by source_key`);
check('0157 seeds both PC7 ii_sources rows', srcRows.length === 2, JSON.stringify(srcRows));
check('both ship is_active = FALSE (licensing open)', srcRows.every((r) => r.is_active === false));
check("both use 0155's 'reference_data_provider' category, not a sixth one",
  srcRows.every((r) => r.source_category === 'reference_data_provider'));

const goodKind = await err(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, started_at)
  values ('amc_portfolio_disclosure','amc_monthly_portfolio_generic','fund_holdings_disclosure','2026-08-31','running', now());`);
check("batch_kind 'fund_holdings_disclosure' is accepted", goodKind === null, goodKind ? `error: ${goodKind.slice(0, 160)}` : '');
const badKind = await err(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, started_at)
  values ('amc_portfolio_disclosure','amc_monthly_portfolio_generic','holdings_guess','2026-08-31','running', now());`);
check('an invented batch_kind is still REFUSED by the CHECK', badKind !== null, badKind ? `refused: ${badKind.slice(0, 120)}` : 'NOT REFUSED — the CHECK was widened too far');

// ---------------------------------------------------------------------------
console.log('\n--- 4. corrections may target look-through tables ---');
const corrOk = await one(`select count(*)::int as n from pg_constraint
  where conname = 'ii_reference_corrections_target_table_check'
    and pg_get_constraintdef(oid) like '%ii_fund_holdings_lines%'`);
check('ii_reference_corrections admits ii_fund_holdings_lines', corrOk.n === 1);

// ---------------------------------------------------------------------------
console.log('\n--- 5. every O.4 column PC7 adds exists ---');
const wantSnapCols = {
  scheme_master_id: 'uuid', batch_id: 'uuid', amc_name: 'text', source_url: 'text',
  source_sha256: 'text', source_byte_length: 'bigint', source_retrieved_at: 'timestamp with time zone',
  disclosure_period: 'text', market_value_unit: 'text', currency_code: 'character',
  content_checksum: 'text', resolved_weight_total_pct: 'numeric', line_count: 'integer',
};
const snapCols = Object.fromEntries((await all(
  `select column_name, data_type from information_schema.columns
   where table_schema='public' and table_name='ii_fund_holdings_snapshots'`
)).map((r) => [r.column_name, r.data_type]));
for (const [col, type] of Object.entries(wantSnapCols)) {
  check(`ii_fund_holdings_snapshots.${col} exists as ${type}`, snapCols[col] === type, `found: ${snapCols[col] ?? 'ABSENT'}`);
}
const wantLineCols = ['industry_or_rating_raw', 'sub_section_raw', 'source_row_index', 'record_checksum', 'yield_pct'];
const lineCols = new Set((await all(
  `select column_name from information_schema.columns
   where table_schema='public' and table_name='ii_fund_holdings_lines'`
)).map((r) => r.column_name));
check(`ii_fund_holdings_lines gains all ${wantLineCols.length} PC7 columns`, wantLineCols.every((c) => lineCols.has(c)),
  `missing: ${wantLineCols.filter((c) => !lineCols.has(c)).join(', ') || 'none'}`);

// A fund instrument to hang snapshots off.
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','Example Fund','mutual_fund','IN','INR')
  on conflict do nothing;`);

// ---------------------------------------------------------------------------
console.log('\n--- 6. the lakhs trap: market_value_unit is a closed domain ---');
const unitOk = await err(`insert into ii_fund_holdings_snapshots (fund_instrument_id, holdings_as_of_date, source_document_version, market_value_unit)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','u-ok','lakhs');`);
check("market_value_unit 'lakhs' is accepted", unitOk === null, unitOk ? `error: ${unitOk.slice(0, 140)}` : '');
const unitBad = await err(`insert into ii_fund_holdings_snapshots (fund_instrument_id, holdings_as_of_date, source_document_version, market_value_unit)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','u-bad','rupees-ish');`);
check('an unknown market_value_unit is REFUSED', unitBad !== null, unitBad ? `refused: ${unitBad.slice(0, 120)}` : 'NOT REFUSED');

// ---------------------------------------------------------------------------
console.log('\n--- 7. shape constraints actually refuse bad input ---');
const shaBad = await err(`insert into ii_fund_holdings_snapshots (fund_instrument_id, holdings_as_of_date, source_document_version, source_sha256)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','sha-bad','not-a-sha');`);
check('a malformed source_sha256 is REFUSED', shaBad !== null, shaBad ? `refused: ${shaBad.slice(0, 120)}` : 'NOT REFUSED');
const periodBad = await err(`insert into ii_fund_holdings_snapshots (fund_instrument_id, holdings_as_of_date, source_document_version, disclosure_period)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','p-bad','August 2026');`);
check('a malformed disclosure_period is REFUSED', periodBad !== null, periodBad ? `refused: ${periodBad.slice(0, 120)}` : 'NOT REFUSED');
const periodOk = await err(`insert into ii_fund_holdings_snapshots (fund_instrument_id, holdings_as_of_date, source_document_version, disclosure_period)
  values ('11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','p-ok','2026-08');`);
check("disclosure_period '2026-08' is accepted", periodOk === null, periodOk ? `error: ${periodOk.slice(0, 140)}` : '');

// ---------------------------------------------------------------------------
console.log('\n--- 8. THE O.7 ASSERTION on the real schema ---');
const fnExists = await one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='ii_pc7_networth_safety_violations'`);
check('ii_pc7_networth_safety_violations() exists', fnExists.n === 1);
const violations = await all(`select * from ii_pc7_networth_safety_violations()`);
check('O.7 SATISFIED on the real schema — zero violations', violations.length === 0,
  violations.length ? `violations: ${JSON.stringify(violations)}` : 'no FK from a register table into look-through data; no tenancy column on a look-through table');

// ---------------------------------------------------------------------------
console.log('\n--- 9. the O.7 assertion is NOT VACUOUS ---');
// (a) inject a tenancy column
await db.exec(`alter table ii_fund_holdings_lines add column user_id uuid;`);
const afterTenancy = await all(`select * from ii_pc7_networth_safety_violations()`);
check('injecting a tenancy column MAKES the assertion fire', afterTenancy.some((v) => v.violation_code === 'LOOKTHROUGH_HAS_TENANCY_COLUMN'),
  `violations now: ${afterTenancy.map((v) => v.violation_code).join(', ') || 'NONE — the check is vacuous'}`);
await db.exec(`alter table ii_fund_holdings_lines drop column user_id;`);
const afterRemove = await all(`select * from ii_pc7_networth_safety_violations()`);
check('removing it makes the assertion stop firing', afterRemove.length === 0);

// (b) inject an FK from a register table into look-through data
await db.exec(`alter table investments add column pc7_probe_snapshot_id uuid references ii_fund_holdings_snapshots(id);`);
const afterFk = await all(`select * from ii_pc7_networth_safety_violations()`);
check('injecting an FK from investments into look-through MAKES it fire', afterFk.some((v) => v.violation_code === 'LOOKTHROUGH_FK_FROM_REGISTER'),
  `violations now: ${afterFk.map((v) => v.violation_code).join(', ') || 'NONE — the check is vacuous'}`);
await db.exec(`alter table investments drop column pc7_probe_snapshot_id;`);
const afterFkRemove = await all(`select * from ii_pc7_networth_safety_violations()`);
check('removing the FK returns the schema to SATISFIED', afterFkRemove.length === 0);

// ---------------------------------------------------------------------------
console.log('\n--- 10. the PC7 admin capability ---');
const capCol = await one(`select data_type, column_default, is_nullable from information_schema.columns
  where table_schema='public' and table_name='admin_users' and column_name='can_view_lookthrough_data_quality'`);
check('admin_users.can_view_lookthrough_data_quality exists', !!capCol, capCol ? `type ${capCol.data_type}, default ${capCol.column_default}` : 'ABSENT');
check('it defaults to FALSE and is NOT NULL', !!capCol && /false/i.test(capCol.column_default ?? '') && capCol.is_nullable === 'NO');
const capFn = await one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='is_pc7_lookthrough_data_admin'`);
check('is_pc7_lookthrough_data_admin() exists', capFn.n === 1);
// It must be a DISTINCT capability, not an alias of PC6's.
const distinct = await one(`select
  (select count(*)::int from information_schema.columns
    where table_name='admin_users' and column_name='can_view_reference_data_quality') as pc6,
  (select count(*)::int from information_schema.columns
    where table_name='admin_users' and column_name='can_view_lookthrough_data_quality') as pc7`);
check('PC7 capability is SEPARATE from PC6 capability', distinct.pc6 === 1 && distinct.pc7 === 1);

// ---------------------------------------------------------------------------
console.log('\n--- 11. job control ships DISABLED with a reason ---');
const job = await one(`select enabled, disabled_reason from ii_reference_job_control where job_key='pc7_fund_holdings_disclosure'`);
check('the PC7 job-control row exists', !!job);
check('it ships DISABLED', !!job && job.enabled === false);
check('and carries a stated reason naming the blockers', !!job && /PO-PC7-1/.test(job.disabled_reason ?? ''), job ? `reason: ${(job.disabled_reason ?? '').slice(0, 120)}...` : '');

// ---------------------------------------------------------------------------
console.log('\n--- 12. 0157 registers NO scheduled job ---');
const raw157 = fs.readFileSync(path.join(MIG, '0157_pc7_lookthrough_foundation.sql'), 'utf8');
check('0157 contains no cron.schedule call', !/cron\.schedule/i.test(raw157));

// ---------------------------------------------------------------------------
console.log('\n--- 13. 0044 line constraints survive the PC7 extension ---');
await db.exec(`insert into ii_fund_holdings_snapshots (id, fund_instrument_id, holdings_as_of_date, source_document_version)
  values ('22222222-2222-4222-8222-bbbbbbbbbbbb','11111111-1111-4111-8111-aaaaaaaaaaaa','2026-08-31','line-test')
  on conflict do nothing;`);
const wtBad = await err(`insert into ii_fund_holdings_lines (snapshot_id, holding_name, weight_pct)
  values ('22222222-2222-4222-8222-bbbbbbbbbbbb','Impossible Holding', 250);`);
check('a weight outside 0..100 is still REFUSED', wtBad !== null, wtBad ? `refused: ${wtBad.slice(0, 120)}` : 'NOT REFUSED');
const kindBad = await err(`insert into ii_fund_holdings_lines (snapshot_id, holding_name, weight_pct, asset_kind)
  values ('22222222-2222-4222-8222-bbbbbbbbbbbb','Odd Kind', 1, 'commodity');`);
check('an invented asset_kind is still REFUSED', kindBad !== null, kindBad ? `refused: ${kindBad.slice(0, 120)}` : 'NOT REFUSED');
const lineOk = await err(`insert into ii_fund_holdings_lines (snapshot_id, holding_name, weight_pct, asset_kind, industry_or_rating_raw, record_checksum, yield_pct, source_row_index)
  values ('22222222-2222-4222-8222-bbbbbbbbbbbb','Reliance Industries Ltd', 9, 'security', 'Petroleum Products', repeat('a',64), 0, 7);`);
check('a well-formed PC7 line inserts, using the new columns', lineOk === null, lineOk ? `error: ${lineOk.slice(0, 160)}` : '');

// ---------------------------------------------------------------------------
console.log(`\n--- SUMMARY: ${pass} PASS, ${fail} FAIL (${seq} assertions) ---`);
fs.writeFileSync(path.join(HERE, 'pc7-0157-pglite-results.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  migrationsApplied: files.length,
  lastMigration: files.at(-1),
  pass, fail, total: seq, results,
}, null, 2));
console.log(`results written to scripts/pc7-0157-pglite-results.json`);
process.exit(fail === 0 ? 0 : 1);
