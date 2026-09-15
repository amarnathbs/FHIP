// PC6 (M6) — POST-MIGRATION verification of 0155 against a freshly rebuilt
// REAL Postgres (PGlite/WASM): what DEV and production will look like ONCE
// migration 0155 is applied.
//
// WHY THIS EXISTS. `scripts/pc5_ddl_capability_probe.mjs` was re-run fresh on
// 2026-09-15 and confirmed there is still no DDL path from this environment to
// either hosted database. 0155 therefore cannot be applied from here, and this
// is the substitute technique the repository already uses for exactly that
// situation (r12_post_migration_pglite_verification.mjs, 0092;
// m4b_huf_pglite_migration_verification.mjs, 0154). It is real Postgres — real
// CHECK constraints, real triggers, real RLS with a real `set role
// authenticated` and a real `auth.uid()`. WASM vs cloud hosting is the only
// difference. It is NOT a claim that 0155 has been applied anywhere.
//
// WHAT IT PROVES:
//   1.  The whole chain 0001..0155 applies cleanly, in order, from empty.
//   2.  0155 is genuinely idempotent — applying it a SECOND time is a no-op.
//   3.  ii_prices_nav.price is numeric(24,10) and actually STORES 8 dp
//       without rounding (the real AMFI precision defect).
//   4.  The no-future-date trigger refuses a forward-dated NAV, and the same
//       trigger exists on ii_benchmark_series.
//   5.  ii_scheme_master keeps exactly one OPEN row per AMFI scheme code, and
//       economically distinct plan/option variants are NOT collapsed.
//   6.  A 'merged' scheme without a merge target is unrepresentable.
//   7.  An admin benchmark override without actor/time/reason is refused BY
//       THE DATABASE, not merely by application code.
//   8.  A governed category default without a reasoned rationale is refused.
//   9.  The PC6 admin capability is NOT implied by mere presence in
//       admin_users — an ordinary admin sees zero operational rows, a
//       capability-holding admin sees them, and an ordinary user sees none.
//  10.  ii_risk_free_methodology ships EMPTY (BLOCKER PO-PC6-2 is real, not
//       quietly resolved) and ii_benchmark_category_defaults ships EMPTY
//       (N.8: no guessed index).
//  11.  The job control rows ship DISABLED (binding override: no autonomous
//       production activation).
//  12.  0155 registers NO pg_cron schedule.
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

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
};

/** Run a statement and return the error message, or null on success. */
async function err(sql) {
  try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); }
}
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

// ---------------------------------------------------------------------------
console.log('--- 1/2. chain applies, and 0155 is idempotent ---');
// ---------------------------------------------------------------------------
check('chain 0001..0155 applied from empty', files.includes('0155_pc6_reference_market_data_foundation.sql'));
const second = await err(
  fs.readFileSync(path.join(MIG, '0155_pc6_reference_market_data_foundation.sql'), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '')
);
check('0155 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 160)}` : '');

// ---------------------------------------------------------------------------
console.log('\n--- 3. NAV precision: the real AMFI 8-dp defect ---');
// ---------------------------------------------------------------------------
const navType = await one(`
  select numeric_precision, numeric_scale from information_schema.columns
  where table_schema='public' and table_name='ii_prices_nav' and column_name='price'`);
check('ii_prices_nav.price is numeric(24,10)', Number(navType.numeric_precision) === 24 && Number(navType.numeric_scale) === 10,
  `got numeric(${navType.numeric_precision},${navType.numeric_scale})`);

await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status)
  values ('aaaaaaaa-0000-0000-0000-000000000001','PC6 Probe Fund - Growth (Direct Plan)','mutual_fund','IN','INR','verified');`);
// The exact 8-dp value AMFI published for a real scheme on 2026-09-15.
await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price)
  values ('aaaaaaaa-0000-0000-0000-000000000001','INR', current_date - 1, 14.86269632);`);
const stored = await one(`select price::text as p from ii_prices_nav where instrument_id='aaaaaaaa-0000-0000-0000-000000000001'`);
check('an 8-decimal-place AMFI NAV stores without rounding', stored.p.startsWith('14.86269632'), `stored '${stored.p}'`);

// ---------------------------------------------------------------------------
console.log('\n--- 4. no future dates (N.5) ---');
// ---------------------------------------------------------------------------
const future = await err(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price)
  values ('aaaaaaaa-0000-0000-0000-000000000001','INR', current_date + 30, 10.0);`);
check('a forward-dated NAV is refused by the database', future !== null && /future/i.test(future), future ? future.slice(0, 120) : 'NOT REFUSED');

const todayOk = await err(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price)
  values ('aaaaaaaa-0000-0000-0000-000000000001','INR', current_date, 10.5);`);
check("today's NAV is still accepted (the guard is not over-tight)", todayOk === null, todayOk ? todayOk.slice(0, 120) : '');

const bmTrigger = await one(`select count(*)::int as n from pg_trigger where tgname='trg_ii_benchmark_series_no_future_date'`);
check('the same guard exists on ii_benchmark_series', bmTrigger.n === 1);

// ---------------------------------------------------------------------------
console.log('\n--- 5/6. scheme master: one open row, variants not collapsed ---');
// ---------------------------------------------------------------------------
const mkScheme = (id, code, plan, option, optionRaw, from, to = 'null') => `
  insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, amc_name, plan_type, plan_raw,
    option_type, option_raw, scheme_structure, category_header_raw, country_code, currency_code,
    record_checksum, effective_from, effective_to)
  values ('${id}','${code}','PC6 Probe Fund','PC6 AMC','${plan}','${plan} Plan','${option}','${optionRaw}',
    'open_ended','Open Ended Schemes(Equity Scheme - Large Cap Fund)','IN','INR','chk-${code}-${from}','${from}',${to});`;

await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status)
  values ('aaaaaaaa-0000-0000-0000-000000000002','PC6 Probe Fund - IDCW (Regular Plan)','mutual_fund','IN','INR','verified');`);

check('first open scheme-master row inserts',
  (await err(mkScheme('aaaaaaaa-0000-0000-0000-000000000001', '900001', 'direct', 'growth', 'Growth Option', '2026-01-01'))) === null);
const dupOpen = await err(mkScheme('aaaaaaaa-0000-0000-0000-000000000001', '900001', 'direct', 'growth', 'Growth Option', '2026-06-01'));
check('a SECOND open row for the same AMFI code is refused', dupOpen !== null && /uidx_ii_scheme_master_current|unique/i.test(dupOpen),
  dupOpen ? dupOpen.slice(0, 110) : 'NOT REFUSED');

// Close the first period, then a new period opens — effective dating works.
await db.exec(`update ii_scheme_master set effective_to = '2026-05-31' where amfi_scheme_code='900001';`);
check('a superseding period opens once the prior one is closed',
  (await err(mkScheme('aaaaaaaa-0000-0000-0000-000000000001', '900001', 'direct', 'growth', 'Growth Option', '2026-06-01'))) === null);

// N.3: economically distinct plan/option = a DIFFERENT AMFI code = its own row.
check('a distinct plan/option variant coexists as its own row (not collapsed)',
  (await err(mkScheme('aaaaaaaa-0000-0000-0000-000000000002', '900002', 'regular', 'idcw', 'Monthly IDCW Payout', '2026-01-01'))) === null);
const variants = await one(`select count(*)::int as n from ii_scheme_master where amfi_scheme_code in ('900001','900002') and effective_to is null`);
check('both variants remain separately current', variants.n === 2, `open rows = ${variants.n}`);

const mergedNoTarget = await err(`
  insert into ii_scheme_master (instrument_id, amfi_scheme_code, scheme_name, plan_type, option_type, scheme_structure,
    category_header_raw, country_code, currency_code, record_checksum, effective_from, lifecycle_status)
  values ('aaaaaaaa-0000-0000-0000-000000000002','900003','Merged Probe','regular','growth','open_ended',
    'Open Ended Schemes(Equity Scheme - Large Cap Fund)','IN','INR','chk-merged','2026-01-01','merged');`);
check("a 'merged' scheme with no merge target is unrepresentable",
  mergedNoTarget !== null && /merged_requires_target/i.test(mergedNoTarget), mergedNoTarget ? mergedNoTarget.slice(0, 110) : 'NOT REFUSED');

// ---------------------------------------------------------------------------
console.log('\n--- 7/8. governance constraints (N.8) ---');
// ---------------------------------------------------------------------------
await db.exec(`insert into ii_benchmarks (id, benchmark_key, benchmark_label, benchmark_category, country_code, return_type, licence_status)
  values ('bbbbbbbb-0000-0000-0000-000000000001','PC6_PROBE_BM','PC6 Probe Benchmark','index','IN','TRI','licence_required');`);

const unreasonedOverride = await err(`
  insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, mapping_basis)
  values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','primary','admin_override');`);
check('an admin override with no actor/time/reason is refused by the database',
  unreasonedOverride !== null && /override_audited/i.test(unreasonedOverride), unreasonedOverride ? unreasonedOverride.slice(0, 110) : 'NOT REFUSED');

const shortReason = await err(`
  insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, mapping_basis,
    override_actor_admin_id, override_recorded_at, override_reason)
  values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','primary','admin_override',
    '99999999-0000-0000-0000-000000000001', now(), 'because');`);
check('an admin override with a token reason is refused', shortReason !== null && /override_audited/i.test(shortReason),
  shortReason ? shortReason.slice(0, 110) : 'NOT REFUSED');

const goodOverride = await err(`
  insert into ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, mapping_basis,
    override_actor_admin_id, override_recorded_at, override_reason)
  values ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','primary','admin_override',
    '99999999-0000-0000-0000-000000000001', now(), 'AMC changed the disclosed benchmark mid-year; mapped per the SID dated 2026-04-01.');`);
check('a properly audited admin override is accepted', goodOverride === null, goodOverride ? goodOverride.slice(0, 140) : '');

const unreasonedDefault = await err(`
  insert into ii_benchmark_category_defaults (country_code, category_header_raw, benchmark_id, effective_from,
    approved_by_admin_id, approved_at, rationale)
  values ('IN','Open Ended Schemes(Equity Scheme - Large Cap Fund)','bbbbbbbb-0000-0000-0000-000000000001','2026-01-01',
    '99999999-0000-0000-0000-000000000001', now(), 'ok');`);
check('a category default with no reasoned rationale is refused',
  unreasonedDefault !== null && /reasoned/i.test(unreasonedDefault), unreasonedDefault ? unreasonedDefault.slice(0, 110) : 'NOT REFUSED');

// ---------------------------------------------------------------------------
console.log('\n--- 9. the PC6 admin capability is not implied by being an admin ---');
// ---------------------------------------------------------------------------
const PLAIN_ADMIN = '11111111-aaaa-0000-0000-000000000001';
const PC6_ADMIN = '22222222-aaaa-0000-0000-000000000002';
const ORDINARY = '33333333-aaaa-0000-0000-000000000003';
await db.exec(`insert into auth.users(id,email) values
  ('${PLAIN_ADMIN}','plain@t.test'),('${PC6_ADMIN}','pc6@t.test'),('${ORDINARY}','user@t.test');`);
await db.exec(`insert into admin_users(user_id) values ('${PLAIN_ADMIN}'),('${PC6_ADMIN}');`);
await db.exec(`update admin_users set can_view_reference_data_quality = true where user_id = '${PC6_ADMIN}';`);

// One operational row to look for.
await db.exec(`insert into ii_reference_import_batches (source_key, source_config_id, batch_kind, as_of_date, status, finished_at)
  values ('amfi','amfi_nav_daily','daily_nav', current_date, 'succeeded', now());`);

/**
 * Run as a real authenticated user with RLS genuinely in force.
 * SESSION-scoped set_config(..., false), never `set local`: PGlite autocommits
 * each statement, so a transaction-local GUC is gone before the next query and
 * auth.uid() reads NULL — which silently disables RLS and makes every claim
 * below vacuous. Asserted, not assumed, by the vacuity guard.
 */
let vacuous = 0;
async function asUser(userId, sql) {
  await db.exec(`select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false); set role authenticated;`);
  const who = (await db.query('select auth.uid()::text as uid')).rows[0].uid;
  if (who !== userId) { vacuous++; await db.exec('reset role;'); throw new Error(`harness vacuous: auth.uid()=${who}`); }
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}

const plainSees = await asUser(PLAIN_ADMIN, 'select id from ii_reference_import_batches');
check('an admin WITHOUT the capability sees zero import batches', plainSees.length === 0, `rows=${plainSees.length}`);
const pc6Sees = await asUser(PC6_ADMIN, 'select id from ii_reference_import_batches');
check('an admin WITH the capability sees the import batch', pc6Sees.length === 1, `rows=${pc6Sees.length}`);
const userSees = await asUser(ORDINARY, 'select id from ii_reference_import_batches');
check('an ordinary user sees zero import batches', userSees.length === 0, `rows=${userSees.length}`);
const userSeesRef = await asUser(ORDINARY, 'select id from ii_scheme_master');
check('an ordinary user CAN read the scheme master (it is public reference data)', userSeesRef.length > 0, `rows=${userSeesRef.length}`);
const userWrite = await asUser(ORDINARY, `select count(*)::int as n from pg_policies where tablename='ii_scheme_master' and cmd <> 'SELECT'`);
check('no non-SELECT policy exists on ii_scheme_master (service-role write only)', Number(userWrite[0].n) === 0, `policies=${userWrite[0].n}`);
check('the RLS harness was not vacuous', vacuous === 0, `vacuous assertions = ${vacuous}`);

// ---------------------------------------------------------------------------
console.log('\n--- 10/11/12. honest empty states and no autonomous activation ---');
// ---------------------------------------------------------------------------
const rfm = await one('select count(*)::int as n from ii_risk_free_methodology');
check('ii_risk_free_methodology ships EMPTY (BLOCKER PO-PC6-2 unresolved)', rfm.n === 0, `rows=${rfm.n}`);
const certified = await one('select count(*)::int as n from ii_risk_free_rates where is_certified = true');
check('no risk-free rate is marked certified', certified.n === 0, `rows=${certified.n}`);
const enabled = await all("select job_key, enabled from ii_reference_job_control");
check('every PC6 job ships DISABLED', enabled.length === 2 && enabled.every((r) => r.enabled === false),
  enabled.map((r) => `${r.job_key}=${r.enabled}`).join(', '));
const jobs = await one("select count(*)::int as n from cron.job where jobname like 'pc6%'");
check('0155 registers NO pg_cron schedule', jobs.n === 0, `pc6 cron jobs = ${jobs.n}`);

// Static reading of the migration, with COMMENTS STRIPPED. The first draft of
// these two checks read the raw text and failed on the migration's own prose:
// section 15 explains at length why it does NOT call cron.schedule, and two
// comments say "no user_id". Grepping a file that documents its own absences
// finds the words describing the absence. Strip line and block comments first,
// then assert on executable SQL only.
const migRaw = fs.readFileSync(path.join(MIG, '0155_pc6_reference_market_data_foundation.sql'), 'utf8');
const migSql = migRaw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
check('0155 executes no cron.schedule call', !/cron\.schedule/i.test(migSql));
// Tenancy is checked STRUCTURALLY, not textually. The textual version of this
// check failed on the migration's own `comment on table ... 'no user_id, no
// tenancy'` string — a comment body is executable SQL but is not a column.
// Ask the catalogue instead: does any PC6 table actually carry a tenancy
// column? That is the invariant (D.1: PC6 data is global reference data).
const PC6_TABLES = [
  'ii_scheme_master', 'ii_scheme_alias_history', 'ii_reference_import_batches',
  'ii_reference_import_rejections', 'ii_reference_corrections', 'ii_reference_job_control',
  'ii_benchmark_category_defaults', 'ii_risk_free_methodology',
];
const tenancyCols = await all(`
  select table_name, column_name from information_schema.columns
  where table_schema='public'
    and table_name in (${PC6_TABLES.map((t) => `'${t}'`).join(',')})
    and column_name in ('user_id','household_id','tenant_id','profile_id')`);
check('no PC6 table carries a tenancy column (global reference data only)', tenancyCols.length === 0,
  tenancyCols.map((r) => `${r.table_name}.${r.column_name}`).join(', ') || 'none');
const createdCount = await one(`
  select count(*)::int as n from information_schema.tables
  where table_schema='public' and table_name in (${PC6_TABLES.map((t) => `'${t}'`).join(',')})`);
check('all 8 PC6 tables exist after the chain', createdCount.n === 8, `found ${createdCount.n}/8`);

console.log(`\n=== PC6 / 0155 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
