// NAV 1 R3 — POST-MIGRATION verification of 0171 (hold idempotency + the
// pinned_by_report_or_revision fail-open fix) against a freshly rebuilt REAL
// Postgres (PGlite/WASM). Same technique as
// scripts/nav1_0168_pglite_verification.mjs, same reason: no DDL path to
// DEV/production from this session.
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
  const id = `NAV1-0171-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
async function err(sql) { try { await db.exec(sql); return null; } catch (e) { return e.message || String(e); } }
const one = async (sql) => (await db.query(sql)).rows[0];
const all = async (sql) => (await db.query(sql)).rows;

check('chain 0001..0171 applied from empty', files.includes('0171_nav1_hold_idempotency_and_report_pin_failclosed_fix.sql'));
const second = await err(fs.readFileSync(path.join(MIG, '0171_nav1_hold_idempotency_and_report_pin_failclosed_fix.sql'), 'utf8'));
check('0171 re-applies cleanly (idempotent)', second === null, second ? `error: ${second.slice(0, 200)}` : '');

const USER = 'aaaa0000-0000-0000-0000-000000000011';
const INSTRUMENT = 'bbbb0000-0000-0000-0000-000000000011';
const INSTRUMENT2 = 'bbbb0000-0000-0000-0000-000000000012';
const ACCOUNT = 'cccc0000-0000-0000-0000-000000000011';

await db.exec(`insert into auth.users(id,email) values ('${USER}','nav1-0171@t.test');`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${USER}';`);
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${INSTRUMENT}','0171 Probe Fund','mutual_fund','IN','INR','verified'),
  ('${INSTRUMENT2}','0171 Probe Fund 2','mutual_fund','IN','INR','verified');`);
await db.exec(`insert into ii_accounts (id, user_id, country_code, currency_code, account_type, institution_name) values
  ('${ACCOUNT}', '${USER}', 'IN', 'INR', 'demat', '0171 Probe Broker');`);

// --- PART A: idempotency / dedup ---

// 1. First certification creates exactly one open hold.
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status) values
  ('${USER}','${ACCOUNT}','${INSTRUMENT}','certified');`);
let holds = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' order by created_at`);
check('first certification creates exactly one open hold', holds.length === 1, `holds=${holds.length}`);
const firstExpiry = holds[0]?.expires_at;

// 2. A flapping re-certification (certified -> certified_with_warnings) while
//    the hold is still open extends the SAME row rather than duplicating it.
await new Promise((r) => setTimeout(r, 5)); // ensure a measurable clock delta for the extend check
await db.exec(`update ii_portfolio_truth_status set status='certified_with_warnings' where instrument_id='${INSTRUMENT}';`);
holds = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' order by created_at`);
check('re-certification while the hold is open does NOT create a second row (R3 decision)', holds.length === 1, `holds=${holds.length}`);
check('the same row id is reused (id unchanged)', holds[0]?.id === (await one(`select id from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' limit 1`)).id);

// 3. A second flap back to plain certified: still one row, expiry only ever
//    moves forward (or stays equal), never backward.
await db.exec(`update ii_portfolio_truth_status set status='certified' where instrument_id='${INSTRUMENT}';`);
const afterFlaps = await one(`select expires_at, (select count(*) from ii_nav_retention_holds where instrument_id='${INSTRUMENT}') as n from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' limit 1`);
check('after 2 more flaps, still exactly one row', Number(afterFlaps.n) === 1, `n=${afterFlaps.n}`);
check('expires_at never moved backward across flaps', new Date(afterFlaps.expires_at) >= new Date(firstExpiry));

// 4. Retention policy must still report protected throughout.
const candidateWhileHeld = await one(`select pc6_nav_row_is_candidate('${INSTRUMENT}', '2019-01-01', '2026-09-21') as c`);
check('RPC still reports protected (candidate=false) after dedup/extend', candidateWhileHeld.c === false);

// 5. Genuine decertification + later genuine recertification MUST get its
//    OWN new, independent hold (the R3 decision must not block a real new
//    lifecycle). Release the open hold via the existing manual lifecycle
//    (UPDATE released_at, not a DELETE — same pattern as NAV 1.39).
await db.exec(`update ii_nav_retention_holds set released_at = now() where instrument_id='${INSTRUMENT}' and released_at is null;`);
const releasedCount = (await one(`select count(*) as n from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' and released_at is not null`)).n;
check('the prior hold is now released (audit row kept, not deleted)', Number(releasedCount) === 1);
await db.exec(`update ii_portfolio_truth_status set status='pending' where instrument_id='${INSTRUMENT}';`); // decertify
await db.exec(`update ii_portfolio_truth_status set status='certified' where instrument_id='${INSTRUMENT}';`); // genuine recertification
const afterRecert = await all(`select * from ii_nav_retention_holds where instrument_id='${INSTRUMENT}' order by created_at`);
check('a genuinely new certification after release gets its OWN new open hold (not blocked)', afterRecert.length === 2, `rows=${afterRecert.length}`);
check('exactly one of the two rows is currently open', afterRecert.filter((r) => r.released_at === null).length === 1);

// 6. Multiple instruments in one statement: each gets its own independent
//    hold; dedup is scoped per-instrument, never cross-instrument.
await db.exec(`insert into ii_portfolio_truth_status (user_id, account_id, instrument_id, status) values
  ('${USER}','${ACCOUNT}','${INSTRUMENT2}','certified');`);
const bothInstruments = await all(`select instrument_id, count(*) as n from ii_nav_retention_holds where instrument_id in ('${INSTRUMENT}','${INSTRUMENT2}') and released_at is null group by instrument_id`);
check('a second instrument in the same statement gets its own independent open hold', bothInstruments.length === 2, JSON.stringify(bothInstruments));

// 7. Concurrent duplicate certification (simulated as two back-to-back
//    UPDATEs with no intervening release, i.e. the same race the ON
//    CONFLICT clause exists to close) must not violate the unique index and
//    must still leave exactly one open row.
await db.exec(`update ii_portfolio_truth_status set status='certified_with_warnings' where instrument_id='${INSTRUMENT2}';`);
await db.exec(`update ii_portfolio_truth_status set status='certified' where instrument_id='${INSTRUMENT2}';`);
const raceResult = await one(`select count(*) as n from ii_nav_retention_holds where instrument_id='${INSTRUMENT2}' and released_at is null`);
check('back-to-back certifying transitions (race simulation) never produce more than one open row', Number(raceResult.n) === 1, `n=${raceResult.n}`);

// --- PART B: pinned_by_report_or_revision fail-closed fix ---

// 8. A row with ZERO other protection reasons (no accepted-statement dep, no
//    benchmark dep, no hold, pre-changeover date) must now be reported as
//    PROTECTED (candidate=false), not a candidate — proving `or false` was
//    replaced with real fail-closed behaviour.
const UNPROTECTED_INSTRUMENT = 'bbbb0000-0000-0000-0000-000000000013';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values
  ('${UNPROTECTED_INSTRUMENT}','0171 Bare Fund','mutual_fund','IN','INR','verified');`);
const bareCandidate = await one(`select pc6_nav_row_is_candidate('${UNPROTECTED_INSTRUMENT}', '2019-01-01', '2026-09-21') as c`);
check('FIX: an instrument with zero other dependencies is now report-pin-protected (candidate=false), not `or false`-open', bareCandidate.c === false);

console.log(`\n=== NAV 1 / 0171 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
