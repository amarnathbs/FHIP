// NAV2 -- PGlite verification of migration 0294 on top of the WHOLE real migration ledger (0001 to the migration before 0294, with the
// platform shim), then 0294 applied twice. Evidence label: PGLITE (an in-process Postgres), NOT DEV and NOT production.
//
// The unit suites (tests/unit/nav2/nav2RiskFreeVerifiedThrough*.test.ts) run the same SQL on a reduced database (the platform shim plus the two
// tables 0260 needs). This script is the "does it work on the real chain" proof: every earlier migration is replayed, so a collision with a
// function, policy or grant created anywhere in the ledger would show here.
//
// Run: node scripts/nav2_0294_pglite_verification.mjs        (about three minutes)

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const F0294 = files.find((f) => f.startsWith('0294_'));
if (!F0294) throw new Error('migration 0294 not found');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const before = files.filter((f) => f < F0294);
for (const f of before) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`chain replayed up to ${before.at(-1)} (${before.length} migrations); 0294 NOT yet applied\n`);

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  NAV2-0294-${String(seq).padStart(2, '0')}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (sql) => (await db.query(sql)).rows[0];
const asRole = async (role, sub, sql) => {
  try {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false); select set_config('request.jwt.claim.role', '${role}', false);`);
    const r = await db.query(sql);
    return { ok: true, v: r.rows[0]?.v, rows: r.rows };
  } catch (e) {
    return { ok: false, msg: e.message };
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.role', '', false);`);
  }
};

const U = { up: 'aaaa0000-0000-0000-0000-000000000294', sw: 'aaaa0000-0000-0000-0000-000000000295', none: 'aaaa0000-0000-0000-0000-000000000296', user: 'aaaa0000-0000-0000-0000-000000000297' };
for (const [k, id] of Object.entries(U)) await db.exec(`insert into auth.users(id,email) values ('${id}','nav2-0294-${k}@t.test');`);
await db.exec(`insert into admin_users (user_id) values ('${U.up}'), ('${U.sw}'), ('${U.none}');`);
await db.exec(`update admin_users set can_upload_risk_free_data = true where user_id = '${U.up}'; update admin_users set can_switch_risk_free_series = true where user_id = '${U.sw}';`);

const SQL = strip(fs.readFileSync(path.join(MIG, F0294), 'utf8'));
await db.exec(SQL);
let again = null;
try { await db.exec(SQL); } catch (e) { again = e.message; }
check('0294 applies on the whole ledger and a second apply does not error (idempotent)', again === null, again ?? '');

const today = (await one(`select to_char(risk_free_today(), 'YYYY-MM-DD') v`)).v;
check('risk_free_today() is the Asia/Kolkata day', today === (await one(`select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') v`)).v);

const REASON = 'Checked the RBI press releases up to today: no change to the policy repo rate.';
const row = (d, v, retrieved) => ({ date: d, value_percent: v, kind: 'value', source_document: 'SYNTHETIC verification fixture', source_url: null, retrieved_on: retrieved, notes: null });
const ATT = 'I confirm that these values were read from the Reserve Bank of India publication named in each row and have not been altered, and that the Product Owner decision covers storing them in FHIP.';
const commit = (series, sha, rows, through) =>
  asRole('authenticated', U.up, `select commit_risk_free_upload('${series}', '${sha}', 'f.csv', '${JSON.stringify(rows)}'::jsonb, true, '${ATT}', 'admin_upload', ${through ? `'${through}'::date` : 'null'}) v`);
const confirm = (uid, series, date, reason = REASON) => asRole(uid ? 'authenticated' : 'anon', uid, `select confirm_risk_free_verified_through('${series}', ${date ? `'${date}'::date` : 'null'}, ${reason === null ? 'null' : `'${reason}'`}) v`);
const through = async (s) => (await one(`select to_char(verified_through_date, 'YYYY-MM-DD') v from ii_risk_free_series where series_id = '${s}'`)).v;

const REPO = 'RBI_POLICY_REPO_RATE', TBILL = 'RBI_91D_TBILL_CUTOFF_YIELD';
const r1 = await commit(REPO, 'a'.repeat(64), [row('2025-12-05', 5.25, '2026-10-01')], '2026-10-02');
check('first load of the repo series with a verified-through date stores it', r1.ok && r1.v.verified_through === '2026-10-02' && r1.v.verified_through_moved === true, JSON.stringify(r1));
const r2 = await commit(REPO, 'b'.repeat(64), [row('2026-10-07', 5.5, '2026-10-08')], null);
check('the 07-10-2026 rate file with no date leaves the date at 02-10-2026', r2.ok && (await through(REPO)) === '2026-10-02', JSON.stringify(r2));
const r3 = await commit(REPO, 'b'.repeat(64), [row('2026-10-07', 5.5, '2026-10-08')], today);
check('the SAME file again with the India day typed moves the date, the answer says so', r3.ok && r3.v.already_committed === true && r3.v.verified_through_moved === true && (await through(REPO)) === today, JSON.stringify(r3));
const r4 = await commit(REPO, 'b'.repeat(64), [row('2026-10-07', 5.5, '2026-10-08')], '2026-10-10');
check('an earlier day does not move it back and the answer says moved = false', r4.ok && r4.v.verified_through_moved === false && (await through(REPO)) === today, JSON.stringify(r4));
const r5 = await commit(TBILL, 'c'.repeat(64), [row('2026-09-30', 5.5199, '2026-10-03')], '2026-10-02');
check('a date sent for the weekly T-bill series is ignored, not stored', r5.ok && (await through(TBILL)) === null && r5.v.verified_through_moved === false, JSON.stringify(r5));
const r6 = await commit(REPO, 'd'.repeat(64), [row('2026-10-07', 5.5, '2026-10-08')], (await one(`select to_char(risk_free_today() + 1, 'YYYY-MM-DD') v`)).v);
check('NEGATIVE CONTROL: a day after the India day is refused', !r6.ok && /future/.test(r6.msg), JSON.stringify(r6));

// The dedicated control, on a fresh state: reset the date so a confirmation can be exercised (test fixture only, as the table owner).
await db.exec(`update ii_risk_free_series set verified_through_date = date '2026-10-02' where series_id = '${REPO}'`);
const c1 = await confirm(U.up, REPO, today);
check('confirm: the upload-capability holder moves the date forward', c1.ok && c1.v.previous === '2026-10-02' && c1.v.new === today && (await through(REPO)) === today, JSON.stringify(c1));
const log = await one(`select count(*)::int n, bool_and(actor_user_id = '${U.up}') who, bool_and(reason like 'Confirmed still current through %') shape from ii_risk_free_series_state_log where reason like 'Confirmed still current%'`);
check('confirm: exactly one audit row, by the acting user', log.n === 1 && log.who && log.shape, JSON.stringify(log));
const c2 = await confirm(U.up, REPO, today);
check('NEGATIVE CONTROL: the same day again is refused (never a silent no-op)', !c2.ok && /already confirmed through/.test(c2.msg), JSON.stringify(c2));
const c3 = await confirm(U.up, REPO, '2026-10-06');
check('NEGATIVE CONTROL: a day before the last published rate is refused', !c3.ok && /earlier than the last published rate/.test(c3.msg), JSON.stringify(c3));
const c4 = await confirm(U.up, TBILL, today);
check('NEGATIVE CONTROL: the weekly series is refused', !c4.ok && /only a policy-change series/.test(c4.msg), JSON.stringify(c4));
const c5 = await confirm(U.up, REPO, today, 'too short');
check('NEGATIVE CONTROL: a reason under 20 characters is refused', !c5.ok && /at least 20 characters/.test(c5.msg), JSON.stringify(c5));
for (const [who, uid] of [['switch-only holder', U.sw], ['admin without the capability', U.none], ['ordinary user', U.user], ['anon', null]]) {
  const r = await confirm(uid, REPO, today);
  check(`NEGATIVE CONTROL: ${who} is refused`, !r.ok && /not authorised|permission denied/.test(r.msg), JSON.stringify(r));
}
const direct = await asRole('authenticated', U.up, `update ii_risk_free_series set verified_through_date = date '2026-10-20' where series_id = '${REPO}'`);
check('NEGATIVE CONTROL: a signed-in session cannot write the series table directly', !direct.ok && /permission denied/.test(direct.msg), JSON.stringify(direct));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
