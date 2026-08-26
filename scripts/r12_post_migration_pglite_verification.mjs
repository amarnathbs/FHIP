// Investment Intelligence R12 — POST-MIGRATION verification against a
// freshly rebuilt REAL Postgres (PGlite/WASM), i.e. what the DEV/production
// database will look like ONCE migration 0092 is applied. This is the
// documented substitute for genuine hosted-Supabase live-DEV testing of
// schema-dependent R12 behaviour: this session has no DDL execution
// capability against the real hosted DEV project (confirmed via
// scripts/fdh1_closure_capability_probe.mjs), so migration 0092 cannot be
// applied to DEV from here. scripts/r12_live_dev_verification.mjs already
// covers what IS verifiable live on the CURRENT (pre-0092) hosted DEV
// schema, including a real RED reproduction of the vulnerability this
// script proves fixed. Both are real Postgres RLS enforcement — this one
// is just WASM-hosted rather than cloud-hosted, using the exact
// auth.uid()/set role authenticated technique already established in
// scripts/db-rebuild-check/rls.mjs.
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
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild complete (includes migration 0092)\n');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

// --- Seed a real R12-style position for tenant A (as postgres/service-role) ---
const accId = (await db.query(`insert into ii_accounts (user_id, country_code, currency_code, account_type, institution_name) values ('${A}','IN','INR','demat','R12 Test Broker') returning id`)).rows[0].id;
const instrId = (await db.query(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status) values ('R12 Test Equity Co','equity','IN','INR','provisional') returning id`)).rows[0].id;
const snapId = (await db.query(`insert into ii_holding_snapshots (user_id, account_id, instrument_id, as_of_date, units, value, currency_code, quality_status, price_source) values ('${A}','${accId}','${instrId}','2026-08-01',10,50000,'INR','warning','manual_entry') returning id`)).rows[0].id;

console.log('\n=== FUNCTIONAL: new R12 schema additions actually work ===');
check('price_source column accepts manual_entry', (await db.query(`select price_source from ii_holding_snapshots where id='${snapId}'`)).rows[0].price_source === 'manual_entry');
try {
  await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, units, price_per_unit, gross_amount) values ('${A}','${accId}','${instrId}','INR','sale','2026-08-15',5,5200,26000)`);
  check("'sale' transaction_type is accepted by the widened check constraint", true);
} catch (e) { check("'sale' transaction_type is accepted", false, e.message); }
try {
  await db.exec(`insert into ii_scheme_tax_classification (instrument_id, classification, domestic_equity_pct, basis, engine_version) values ('${instrId}','equity_oriented',100,'direct_listed_security_rule','test')`);
  check("'direct_listed_security_rule' basis is accepted", true);
} catch (e) { check("'direct_listed_security_rule' basis is accepted", false, e.message); }

console.log('\n=== NC6: SAME-USER HOLDING FORGERY — must be GREEN post-0092 ===');
await asTenant(A, async () => {
  await db.exec(`update ii_holding_snapshots set value=999999999, units=1 where id='${snapId}'`);
});
let row = (await db.query(`select value::numeric::float8 v, units::numeric::float8 u from ii_holding_snapshots where id='${snapId}'`)).rows[0];
check('NC6 GREEN: authenticated same-user UPDATE of value/units is rejected (0 rows changed) post-0092', row.v === 50000 && row.u === 10, `value=${row.v} units=${row.u}`);

console.log('\n=== NC6 RED->GREEN: temporarily reintroduce the pre-0092 policy, prove it WOULD forge, then restore ===');
await db.exec(`drop policy "read own ii_holding_snapshots" on ii_holding_snapshots;`);
await db.exec(`create policy "own ii_holding_snapshots" on ii_holding_snapshots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`);
await asTenant(A, async () => {
  await db.exec(`update ii_holding_snapshots set value=999999999, units=1 where id='${snapId}'`);
});
row = (await db.query(`select value::numeric::float8 v, units::numeric::float8 u from ii_holding_snapshots where id='${snapId}'`)).rows[0];
check('NC6 RED confirmed: reintroducing the old "for all" policy DOES allow the forgery (proves the test is not vacuous)', row.v === 999999999 && row.u === 1, `value=${row.v} units=${row.u}`);
await db.exec(`drop policy "own ii_holding_snapshots" on ii_holding_snapshots;`);
await db.exec(`create policy "read own ii_holding_snapshots" on ii_holding_snapshots for select using (auth.uid() = user_id);`);
await db.query(`update ii_holding_snapshots set value=50000, units=10 where id='${snapId}'`); // service-role restore
row = (await db.query(`select value::numeric::float8 v, units::numeric::float8 u from ii_holding_snapshots where id='${snapId}'`)).rows[0];
check('NC6 GREEN restored', row.v === 50000 && row.u === 10);

console.log('\n=== NC7: CROSS-USER HOLDING LINK ===');
await asTenant(B, async () => {
  const leak = (await db.query(`select count(*)::int c from ii_holding_snapshots where id='${snapId}'`)).rows[0].c;
  check('NC7: User B cannot read User A holding snapshot', leak === 0, `leaked ${leak}`);
  await db.exec(`update ii_holding_snapshots set value=1 where id='${snapId}'`);
});
row = (await db.query(`select value::numeric::float8 v from ii_holding_snapshots where id='${snapId}'`)).rows[0];
check('NC7: User B cannot write User A holding snapshot', row.v === 50000, `value=${row.v}`);

console.log('\n=== NC1: SAME ISIN, TWO EXCHANGES -> ONE INSTRUMENT (and forced-duplicate detection) ===');
const isin = 'INE999TEST01A';
await db.exec(`insert into ii_instrument_identifiers (instrument_id, identifier_scheme, identifier_value, country_code) values ('${instrId}','isin','${isin}','IN'), ('${instrId}','nse_symbol','TESTCO','IN'), ('${instrId}','bse_code','599999','IN')`);
const resolvedCount = (await db.query(`select count(distinct instrument_id)::int c from ii_instrument_identifiers where identifier_value='${isin}' or identifier_value='TESTCO' or identifier_value='599999'`)).rows[0].c;
check('NC1: all three identifiers (ISIN + NSE + BSE) resolve to exactly one instrument', resolvedCount === 1, `distinct instrument count=${resolvedCount}`);
const secondInstr = (await db.query(`insert into ii_instruments (instrument_name, instrument_class, country_of_domicile, base_currency, status) values ('R12 Duplicate Attempt','equity','IN','INR','provisional') returning id`)).rows[0].id;
let duplicateBlocked = false;
try {
  await db.exec(`insert into ii_instrument_identifiers (instrument_id, identifier_scheme, identifier_value, country_code) values ('${secondInstr}','isin','${isin}','IN')`);
} catch (e) { duplicateBlocked = /unique|duplicate/i.test(e.message); }
check('NC1 RED->GREEN: a second instrument CANNOT claim the same ISIN (global unique index blocks the deliberate duplicate)', duplicateBlocked);

console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
