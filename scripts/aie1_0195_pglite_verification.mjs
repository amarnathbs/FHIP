// AIE-1 final production completion -- PGlite verification for migration 0195
// (AI spend-cap replay refusal, DB-authoritative ceiling, anon privilege
// revocation, per-call evidence, stale-reservation release).
//
// Method, deliberately: replay the migration chain UP TO (not including) 0195,
// then run the OLD behaviour as a NEGATIVE CONTROL and require each defect to
// be demonstrably present. Only then apply 0195 and require each defect to be
// gone. A control that never fails proves nothing, so every "before" check
// below is asserted to FAIL the safety property, by name.
//
// Limitation, stated: PGlite is a single connection, so true concurrent
// same-key reservation (D2) is not exercised here; it is exercised live in
// DEV by scripts/aie1_final_cost_cap_live_dev_check.ts.
//
// Run: node scripts/aie1_0195_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0195_aie_ai_cost_replay_refusal_and_call_evidence.sql';

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes(TARGET)) throw new Error(`target migration ${TARGET} not found`);
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const before = files.filter((f) => f < TARGET);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations) -- 0195 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  const id = `AIE1-0195-${String(seq).padStart(2, '0')}`;
  if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const ledger = async () => one(`select allowance_usd::float8 a, reserved_usd::float8 r, settled_usd::float8 s, total_attempts::int n from aie_ai_cost_ledger where id='global'`);
const reserve = async (key, amount, allowance = 10) => one(`select reserved, remaining_usd::float8 rem from aie_reserve_ai_cost('global', $1, $2, $3)`, [amount, allowance, key]);
const settleV1 = async (key, reservedUsd, actual) => db.query(`select aie_settle_ai_cost('global', $1, $2, 100, 50, $3)`, [reservedUsd, actual, key]);
const resetLedger = async () => {
  await db.exec(`delete from aie_ai_cost_attempt; update aie_ai_cost_ledger set allowance_usd=10, reserved_usd=0, settled_usd=0, total_attempts=0, total_input_tokens=0, total_output_tokens=0 where id='global';`);
};
const priv = async (role, sig) => (await one(`select has_function_privilege($1, $2, 'execute') ok`, [role, sig])).ok;

// ---------------------------------------------------------------------------
console.log('NEGATIVE CONTROLS -- behaviour of 0152 as deployed (each defect must be PRESENT):');
await resetLedger();
{
  const r1 = await reserve('doc-A', 0.01);
  await settleV1('doc-A', 0.01, 0.002);
  const r2 = await reserve('doc-A', 0.01);
  check('CONTROL D1: 0152 re-admits a replayed key AFTER it was settled (unmetered provider call)', r1.reserved === true && r2.reserved === true,
    `first=${r1.reserved} replay-after-settle=${r2.reserved}`);
  const l = await ledger();
  check('CONTROL D1: the replay reserved nothing and the ledger counts one attempt, so a second real call would go uncounted', l.n === 1 && Math.abs(l.r) < 1e-9,
    `total_attempts=${l.n} reserved=${l.r}`);
}
await resetLedger();
{
  const r = await reserve('big-allowance', 50, 1000);
  const l = await ledger();
  check('CONTROL D7: 0152 lets the CALLER raise the cap (reserved $50 against a $10 ledger by passing allowance 1000)', r.reserved === true && l.a === 1000,
    `reserved=${r.reserved} ledger.allowance_usd now=${l.a}`);
}
check('CONTROL PRIV: anon holds EXECUTE on aie_reserve_ai_cost before 0195',
  await priv('anon', 'aie_reserve_ai_cost(text,numeric,numeric,text)') === true);
check('CONTROL PRIV: authenticated holds EXECUTE on aie_settle_ai_cost before 0195',
  await priv('authenticated', 'aie_settle_ai_cost(text,numeric,numeric,bigint,bigint,text)') === true);

// ---------------------------------------------------------------------------
console.log('\nAPPLYING 0195');
await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));
await resetLedger();

console.log('\nAFTER 0195 (each defect must be GONE):');
{
  const r1 = await reserve('doc-B:attempt-1', 0.01);
  check('admitted: a fresh key under the cap is reserved', r1.reserved === true);
  const st = await one(`select settled, already_settled from aie_settle_ai_cost_v2('global','doc-B:attempt-1', 0.002, 1200, 300, 'gpt-4o-mini', array['req_abc','req_def'], 'success', false)`);
  check('settle_v2 settles once and reports it', st.settled === true && st.already_settled === false);
  const st2 = await one(`select settled, already_settled from aie_settle_ai_cost_v2('global','doc-B:attempt-1', 0.002, 1200, 300, 'gpt-4o-mini', array['req_abc'], 'success', false)`);
  check('duplicate settle_v2 is a reported no-op', st2.settled === false && st2.already_settled === true);
  const r2 = await reserve('doc-B:attempt-1', 0.01);
  check('D1 FIXED: a replayed key is NEVER re-admitted after settlement', r2.reserved === false, `replay reserved=${r2.reserved}`);
  const l = await ledger();
  check('ledger arithmetic: reserved released to 0, settled = actual $0.002 (from the stored reservation, not a caller figure)',
    Math.abs(l.r) < 1e-9 && Math.abs(l.s - 0.002) < 1e-9, `reserved=${l.r} settled=${l.s}`);
  const ev = await one(`select model, provider_request_ids, input_tokens::int it, output_tokens::int ot, call_outcome, admission_outcome, billing_uncertain from aie_ai_cost_attempt where idempotency_key='doc-B:attempt-1'`);
  check('per-call evidence recorded: model, request ids, tokens, outcome', ev.model === 'gpt-4o-mini' && ev.provider_request_ids.length === 2 && ev.it === 1200 && ev.ot === 300 && ev.call_outcome === 'success' && ev.admission_outcome === 'admitted' && ev.billing_uncertain === false,
    JSON.stringify(ev));
}
{
  const r3 = await reserve('doc-C:in-flight', 0.01);
  const r4 = await reserve('doc-C:in-flight', 0.01);
  check('D1/D2: a replay of an UNSETTLED (in-flight) key is also refused, so a duplicate cannot make a second call', r3.reserved === true && r4.reserved === false);
  const l = await ledger();
  check('the refused replay reserved nothing extra', Math.abs(l.r - 0.01) < 1e-9, `reserved=${l.r}`);
}
await resetLedger();
{
  const r = await reserve('caller-raises-cap', 50, 1000);
  const l = await ledger();
  check('D7 FIXED: a caller-supplied allowance above the stored ceiling cannot admit spend past it', r.reserved === false && l.a === 10, `reserved=${r.reserved} ledger.allowance_usd=${l.a}`);
  const r2 = await reserve('caller-lowers-cap', 3, 2);
  check('an app allowance BELOW the stored ceiling still lowers the cap', r2.reserved === false);
  const refused = await one(`select admission_outcome from aie_ai_cost_attempt where idempotency_key='caller-lowers-cap'`);
  check('a refused reservation is recorded as budget_exhausted', refused.admission_outcome === 'budget_exhausted');
}
await resetLedger();
{
  // Exhaustion: $10 ceiling, $3 reservations -> exactly 3 admitted, 4th refused.
  const outcomes = [];
  for (let i = 0; i < 4; i++) outcomes.push((await reserve(`exhaust-${i}`, 3)).reserved);
  check('exhaustion: with a $10 ceiling, three $3 reservations are admitted and the fourth is refused', JSON.stringify(outcomes) === JSON.stringify([true, true, true, false]), JSON.stringify(outcomes));
  const l = await ledger();
  check('exhaustion: reserved never exceeds the ceiling', l.r + l.s <= l.a + 1e-9, `reserved=${l.r} settled=${l.s} allowance=${l.a}`);
}
{
  let raised = false;
  try { await db.query(`select * from aie_settle_ai_cost_v2('global','never-reserved', 0.001, 1, 1, 'gpt-4o-mini', null, 'success', false)`); } catch { raised = true; }
  check('settle_v2 for a key that was never reserved raises (cannot record phantom spend)', raised);
  let raised2 = false;
  try { await db.query(`select * from aie_settle_ai_cost_v2('global','exhaust-3', 0.001, 1, 1, 'gpt-4o-mini', null, 'success', false)`); } catch { raised2 = true; }
  check('settle_v2 for a key refused by the budget raises (never admitted)', raised2);
  let raised3 = false;
  try { await reserve('zero-amount', 0); } catch { raised3 = true; }
  check('a zero reservation amount is refused', raised3);
}
{
  // Stale release: age an admitted-unsettled attempt and release it.
  await db.exec(`update aie_ai_cost_attempt set created_at = now() - interval '2 hours' where idempotency_key='exhaust-0'`);
  const before = await ledger();
  const released = (await one(`select aie_release_stale_ai_cost_reservations(60) n`)).n;
  const after = await ledger();
  const row = await one(`select settled_usd::float8 s, billing_uncertain b, settled_by, call_outcome from aie_ai_cost_attempt where idempotency_key='exhaust-0'`);
  check('stale release settles exactly the aged, unsettled, admitted attempt, conservatively at the full reservation', released === 1 && Math.abs(row.s - 3) < 1e-9 && row.b === true && row.settled_by === 'stale_release',
    `released=${released} row=${JSON.stringify(row)}`);
  check('stale release moves the amount from reserved to settled (total exposure unchanged)', Math.abs((before.r + before.s) - (after.r + after.s)) < 1e-9 && Math.abs(after.r - (before.r - 3)) < 1e-9,
    `before r=${before.r} s=${before.s} after r=${after.r} s=${after.s}`);
  const again = (await one(`select aie_release_stale_ai_cost_reservations(60) n`)).n;
  check('stale release is idempotent', again === 0);
  let raised = false;
  try { await db.query(`select aie_release_stale_ai_cost_reservations(1)`); } catch { raised = true; }
  check('stale release refuses an age under 5 minutes (cannot release in-flight calls)', raised);
}
for (const [role, sig] of [
  ['anon', 'aie_reserve_ai_cost(text,numeric,numeric,text)'],
  ['authenticated', 'aie_reserve_ai_cost(text,numeric,numeric,text)'],
  ['anon', 'aie_settle_ai_cost(text,numeric,numeric,bigint,bigint,text)'],
  ['authenticated', 'aie_settle_ai_cost(text,numeric,numeric,bigint,bigint,text)'],
  ['anon', 'aie_settle_ai_cost_v2(text,text,numeric,bigint,bigint,text,text[],text,boolean)'],
  ['authenticated', 'aie_release_stale_ai_cost_reservations(integer)'],
]) {
  check(`PRIV FIXED: ${role} has NO execute on ${sig.split('(')[0]}`, await priv(role, sig) === false);
}
check('service_role keeps execute on reserve, settle, settle_v2 and release',
  (await priv('service_role', 'aie_reserve_ai_cost(text,numeric,numeric,text)'))
  && (await priv('service_role', 'aie_settle_ai_cost(text,numeric,numeric,bigint,bigint,text)'))
  && (await priv('service_role', 'aie_settle_ai_cost_v2(text,text,numeric,bigint,bigint,text,text[],text,boolean)'))
  && (await priv('service_role', 'aie_release_stale_ai_cost_reservations(integer)')));

// Idempotent re-application of the migration file itself.
let reapplied = true;
try { await db.exec(fs.readFileSync(path.join(MIG, TARGET), 'utf8')); } catch (e) { reapplied = false; console.log('        ' + e.message); }
check('0195 re-applies cleanly (idempotent DDL)', reapplied);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
