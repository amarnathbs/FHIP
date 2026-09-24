// NAV 1 Stage D — PGlite verification for migration 0189 (shared "user-held"
// definition for retention + hydration).
//
// Method, deliberately: replay the chain UP TO 0188, seed production-shaped
// data, and prove the OLD (0172) function marks user-held instruments as
// deletable. Only then apply 0189 and prove it keeps them. A check that only
// ever ran against the fixed function could pass without the seed data ever
// exercising the defect; running it against the broken function first is
// what makes it a real negative control.
//
// Run: node scripts/nav1_0189_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0189_nav1_user_held_retention_definition.sql';

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0189 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0189-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

// --- Seed: one user, one account, instruments held in different ways ------
const USER = 'aaaa0000-0000-0000-0000-000000000189';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000189';
const I = {
  txOnly:        '11110000-0000-0000-0000-000000000001', // held via a transaction only
  snapshotOnly:  '11110000-0000-0000-0000-000000000002', // held via a holding snapshot only
  truthRecon:    '11110000-0000-0000-0000-000000000003', // held via truth status 'reconciliation_required' only -- the production shape
  taxLotOnly:    '11110000-0000-0000-0000-000000000004', // held via a tax lot only
  reversedTx:    '11110000-0000-0000-0000-000000000005', // held via a REVERSED transaction only
  unheld:        '11110000-0000-0000-0000-000000000006', // nobody holds it
  holdOnly:      '11110000-0000-0000-0000-000000000007', // unheld, but under an open retention hold
};
const C = '2026-09-21';
const PRE = '2025-06-02';
const POST = '2026-09-23';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0189@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ${Object.entries(I).map(([k, id]) => `('${id}','0189 ${k}','mutual_fund','IN','INR','verified')`).join(',\n  ')};`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}','${USER}','IN','INR','demat','0189 Probe Broker');`);

const txType = (await one(`select pg_get_constraintdef(oid) d from pg_constraint where conname like 'ii_transactions%transaction_type%' limit 1`))?.d ?? '';
const TX_TYPE = (txType.match(/'([a-z_]+)'/) || [])[1] || 'purchase';

await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount) values
  ('${USER}','${ACCOUNT}','${I.txOnly}','INR','${TX_TYPE}','2024-01-15',10000);`);
await db.exec(`insert into ii_transactions (user_id, account_id, instrument_id, currency_code, transaction_type, transaction_date, gross_amount, status) values
  ('${USER}','${ACCOUNT}','${I.reversedTx}','INR','${TX_TYPE}','2024-02-15',5000,'reversed');`);
await db.exec(`insert into ii_holding_snapshots (user_id, account_id, instrument_id, currency_code, as_of_date, units, value) values
  ('${USER}','${ACCOUNT}','${I.snapshotOnly}','INR','2026-08-31',100,1500);`);
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status) values
  ('${USER}','${ACCOUNT}','${I.truthRecon}','reconciliation_required');`);
await db.exec(`insert into ii_tax_lots (user_id, account_id, instrument_id, acquisition_date, units_acquired, units_remaining, cost_per_unit) values
  ('${USER}','${ACCOUNT}','${I.taxLotOnly}','2023-05-01',50,50,12.5);`);
await db.exec(`insert into ii_nav_retention_holds (instrument_id, reason) values ('${I.holdOnly}','manual_admin_hold');`);

const HELD = ['txOnly', 'snapshotOnly', 'truthRecon', 'taxLotOnly', 'reversedTx'];
const isCandidate = async (id, date) => (await one(`select pc6_nav_row_is_candidate('${id}','${date}','${C}') v`)).v;

// --- NEGATIVE CONTROL: the 0172 function, before 0189 ------------------------
console.log('Negative control -- 0172 function (the production defect):');
const oldVerdicts = {};
for (const k of HELD) oldVerdicts[k] = await isCandidate(I[k], PRE);
const oldDeletable = HELD.filter((k) => oldVerdicts[k] === true);
check('the OLD function marks user-held instruments deletable (reproduces the production defect)',
  oldDeletable.length === HELD.length,
  `old verdict CANDIDATE for ${oldDeletable.length}/${HELD.length}: ${oldDeletable.join(', ')}`);

// --- Apply 0189 ----------------------------------------------------------------
await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
console.log('\n0189 applied.\n');
let reapplyErr = null;
try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
check('0189 is idempotent -- a second apply does not error', reapplyErr === null, reapplyErr ?? '');

// --- The fix -----------------------------------------------------------------
for (const k of HELD) {
  check(`held via ${k}: pre-changeover row is KEEP`, (await isCandidate(I[k], PRE)) === false);
}
check('the production shape -- statement stuck at reconciliation_required -- now protects the instrument',
  (await isCandidate(I.truthRecon, PRE)) === false);

// --- Unchanged behaviour -----------------------------------------------------
check('an instrument nobody holds is still a CANDIDATE before the changeover', (await isCandidate(I.unheld, PRE)) === true);
check('...and KEEP on/after the changeover (daily collection is never deleted)', (await isCandidate(I.unheld, POST)) === false);
check('an open retention hold still protects an unheld instrument (0172 behaviour preserved)', (await isCandidate(I.holdOnly, PRE)) === false);
check('a user-held instrument is KEEP on any date, including long before its first transaction',
  (await isCandidate(I.txOnly, '2015-01-01')) === false);

// --- The two functions agree ---------------------------------------------------
const setIds = new Set((await all(`select instrument_id id from pc6_user_held_instrument_ids()`)).map((r) => r.id));
const expected = new Set(HELD.map((k) => I[k]));
check('pc6_user_held_instrument_ids() returns exactly the held instruments',
  setIds.size === expected.size && [...expected].every((x) => setIds.has(x)),
  `got ${setIds.size}, expected ${expected.size}`);
let disagreements = 0;
for (const id of Object.values(I)) {
  const b = (await one(`select pc6_instrument_is_user_held('${id}') v`)).v;
  if (b !== setIds.has(id)) disagreements++;
}
check('pc6_instrument_is_user_held() and pc6_user_held_instrument_ids() agree for every instrument', disagreements === 0,
  `${disagreements} disagreement(s)`);

// --- Coverage is DERIVED, not hardcoded -----------------------------------------
// Every public ii_* table carrying BOTH instrument_id and user_id is a place a
// user can hold an instrument. Both functions must consult exactly that set.
const derived = (await all(`
  select c.table_name from information_schema.columns c
  join information_schema.columns u on u.table_schema = c.table_schema and u.table_name = c.table_name and u.column_name = 'user_id'
  where c.table_schema = 'public' and c.column_name = 'instrument_id' and c.table_name like 'ii\\_%'
  order by 1`)).map((r) => r.table_name);
const src = async (fn) => (await one(`select prosrc from pg_proc where proname = '${fn}'`)).prosrc;
const referenced = (s) => [...new Set([...s.matchAll(/from\s+(ii_[a-z_]+)/g)].map((m) => m[1]))].sort();
const inBool = referenced(await src('pc6_instrument_is_user_held'));
const inSet = referenced(await src('pc6_user_held_instrument_ids'));
check('user-scoped ii_* tables were found (anti-vacuity)', derived.length >= 7, `${derived.length}: ${derived.join(', ')}`);
check('pc6_instrument_is_user_held() consults exactly the derived user-scoped tables',
  JSON.stringify(inBool) === JSON.stringify(derived),
  `missing: [${derived.filter((t) => !inBool.includes(t)).join(', ')}]  extra: [${inBool.filter((t) => !derived.includes(t)).join(', ')}]`);
check('pc6_user_held_instrument_ids() consults exactly the derived user-scoped tables',
  JSON.stringify(inSet) === JSON.stringify(derived),
  `missing: [${derived.filter((t) => !inSet.includes(t)).join(', ')}]  extra: [${inSet.filter((t) => !derived.includes(t)).join(', ')}]`);

// --- Read-only, as retention requires -------------------------------------------
const vol = await all(`select proname, provolatile from pg_proc where proname in
  ('pc6_instrument_is_user_held','pc6_user_held_instrument_ids','pc6_nav_row_is_candidate')`);
check('all three functions are STABLE (read-only, safe to call against production)',
  vol.length === 3 && vol.every((r) => r.provolatile === 's'), vol.map((r) => `${r.proname}=${r.provolatile}`).join(' '));

console.log(`\n=== NAV 1 / 0189 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
