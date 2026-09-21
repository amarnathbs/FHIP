// NAV 1.25/1.39 — POST-MIGRATION verification of 0168 (acceptance-triggered
// hold) against a freshly rebuilt REAL Postgres (PGlite/WASM). Same
// technique as scripts/nav1_0166_pglite_verification.mjs, same reason: no
// DDL path to DEV/production from this session.
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
const check = (label, cond, detail = '') => {
  seq++;
  const id = `NAV1-0168-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function err(sql) { try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); } }
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

check('chain 0001..0168 applied from empty', files.includes('0168_nav1_acceptance_triggered_hold.sql'));
const second = await err(fs.readFileSync(path.join(MIG, '0168_nav1_acceptance_triggered_hold.sql'), 'utf8'));
check('0168 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 200)}` : '');

const USER = 'aaaa0000-0000-0000-0000-000000000009';
const INSTRUMENT = 'bbbb0000-0000-0000-0000-000000000009';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000009';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0168@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT}','0168 Probe Fund','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}', '${USER}', 'IN', 'INR', 'demat', '0168 Probe Broker');`);

// 1. Inserting a 'pending' status must NOT create a hold.
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status) values
  ('${USER}','${ACCOUNT}','${INSTRUMENT}','pending');`);
let holds = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}'`);
check('a non-certifying status (pending) creates NO hold', holds.length === 0, `holds=${holds.length}`);

// 2. Transitioning to 'certified' MUST create exactly one bounded hold.
await db.exec(`update ii_portfolio_truth_status set status='certified' where instrument_id='${INSTRUMENT}';`);
holds = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}'`);
check('transitioning to certified creates exactly one hold', holds.length === 1, `holds=${holds.length}`);
check('the hold has reason statement_reconciliation_in_progress', holds[0]?.reason === 'statement_reconciliation_in_progress');
check('the hold is bounded (expires_at is set, not permanent)', holds[0]?.expires_at !== null);
check('the hold is active (released_at is null)', holds[0]?.released_at === null);

// 3. pc6_nav_row_is_candidate must now report protected for this instrument.
const candidateWhileHeld = await one(`select pc6_nav_row_is_candidate('${INSTRUMENT}', '2019-01-01', '2026-09-21') as c`);
check('the RPC reports protected (candidate=false) for this instrument while the trigger-created hold is active', candidateWhileHeld.c === false);

// 4. Re-saving the SAME status (no transition) must NOT create a second hold.
await db.exec(`update ii_portfolio_truth_status set last_evaluated_at = now() where instrument_id='${INSTRUMENT}';`); // touches an unrelated column, status unchanged
holds = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}'`);
check('re-saving without a status transition does NOT create a duplicate hold', holds.length === 1, `holds=${holds.length}`);

// 5. certified_with_warnings also triggers (not just plain certified).
const INSTRUMENT2 = 'bbbb0000-0000-0000-0000-000000000010';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT2}','0168 Probe Fund 2','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status) values
  ('${USER}','${ACCOUNT}','${INSTRUMENT2}','certified_with_warnings');`);
const holds2 = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT2}'`);
check('certified_with_warnings ALSO creates a hold (not just plain certified)', holds2.length === 1, `holds=${holds2.length}`);

console.log(`\n=== NAV 1 / 0168 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
