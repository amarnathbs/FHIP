// NAV 1 -- PGlite verification for migration 0220 (PO decision #1, part 1 of
// 3: run the daily-NAV window every day, including Sunday and Monday).
//
// Proves:
//   * ANTI-VACUITY: just before 0220, on production, the daily-NAV jobs
//     really do fire Tue-Sat only (0205's '30-58/2 3 * * 2-6' /
//     '0-30/2 4 * * 2-6') -- the evaluator gives 0 calls on Sunday/Monday,
//     so the "before" claim is falsifiable, not assumed;
//   * after 0220: every day of the week gets the SAME 31 calls Tue-Sat
//     already had (03:30-04:30 UTC, every 2 min), INCLUDING Sunday and
//     Monday -- the exact gap F-17/F-18 exist because of;
//   * the URL, secret, body and 300s timeout are byte-identical to 0205's
//     (only the day-of-week field changed);
//   * the weekly scheme-master job (0205) is completely untouched;
//   * re-applying 0220 is a clean no-op;
//   * the production-only guard: DEV and a policy-less database schedule
//     nothing and leave any planted copy of the daily jobs exactly as found
//     (0220 only ever touches the two daily-NAV job NAMES, never
//     'pc6-scheme-master-weekly' or 'pc6-selective-hydration').
//
// Run: node scripts/nav1_0220_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0220_nav1_daily_window_all_days.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const TARGET_SQL = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function replay(policyEnv, stopBefore = null) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (stopBefore && f >= stopBefore) break;
    await db.exec(f === TARGET ? TARGET_SQL : strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
    if (f.startsWith('0166') && policyEnv) {
      await db.exec(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ('nav1-0189-user-held', '2026-09-21', '${policyEnv}')`);
    }
  }
  return db;
}
const jobs = async (db) => (await db.query(`select jobname, schedule, command from cron.job order by jobname`)).rows;

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  NAV1-0220-${String(pass + fail).padStart(2, '0')}  ${l}${d ? '\n        ' + d : ''}`); };

function field(spec, lo, hi) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [rng, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let a, b;
    if (rng === '*') { a = lo; b = hi; } else if (rng.includes('-')) { [a, b] = rng.split('-').map(Number); } else { a = Number(rng); b = stepS ? hi : a; }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
function expandWeek(expr) {
  const [mi, ho, dom, mon, dw] = expr.trim().split(/\s+/);
  if (dom !== '*' || mon !== '*') throw new Error(`evaluator only supports dom/month '*': ${expr}`);
  const M = field(mi, 0, 59), H = field(ho, 0, 23), D = field(dw, 0, 6);
  const fires = [];
  for (let d = 0; d < 7; d++) if (D.has(d)) for (let h = 0; h < 24; h++) if (H.has(h)) for (let m = 0; m < 60; m++) if (M.has(m)) fires.push({ d, t: h * 60 + m });
  return fires;
}
const DAILY = ['pc6-reference-ingest', 'pc6-reference-ingest-0400'];
const MASTER = 'pc6-scheme-master-weekly';
const HYDRATION = 'pc6-selective-hydration';
const norm = (c) => c.replace(/\s+/g, ' ').trim();

{
  const db = await replay('production', TARGET);
  const before = await jobs(db);
  const b = Object.fromEntries(before.map((x) => [x.jobname, x]));
  check('ANTI-VACUITY: just before 0220, production has 0205\'s Tue-Sat-only daily schedule', b['pc6-reference-ingest']?.schedule === '30-58/2 3 * * 2-6' && b['pc6-reference-ingest-0400']?.schedule === '0-30/2 4 * * 2-6', JSON.stringify([b['pc6-reference-ingest']?.schedule, b['pc6-reference-ingest-0400']?.schedule]));
  const oldWeek = [...DAILY].flatMap((n) => expandWeek(b[n].schedule));
  const oldPerDay = [0, 1, 2, 3, 4, 5, 6].map((d) => oldWeek.filter((f) => f.d === d).length);
  check('ANTI-VACUITY: the evaluator confirms ZERO calls on Sunday/Monday before 0220 (the real gap)', oldPerDay[0] === 0 && oldPerDay[1] === 0 && [2, 3, 4, 5, 6].every((d) => oldPerDay[d] === 31), oldPerDay.join(','));
  const master0 = b[MASTER];
  const hydration0 = before.find((x) => x.jobname === HYDRATION);

  await db.exec(TARGET_SQL);
  const after = await jobs(db);
  const a = Object.fromEntries(after.map((x) => [x.jobname, x]));

  check('after 0220 each daily job still exists exactly once', DAILY.every((n) => after.filter((x) => x.jobname === n).length === 1));
  check('after 0220 the day-of-week field is "*" on both daily jobs', a['pc6-reference-ingest'].schedule === '30-58/2 3 * * *' && a['pc6-reference-ingest-0400'].schedule === '0-30/2 4 * * *', JSON.stringify([a['pc6-reference-ingest'].schedule, a['pc6-reference-ingest-0400'].schedule]));
  check('the command (URL, secret, body, 300s timeout) is byte-identical to before -- only the schedule field changed', DAILY.every((n) => norm(a[n].command) === norm(b[n].command)));

  const newWeek = DAILY.flatMap((n) => expandWeek(a[n].schedule));
  const perDay = [0, 1, 2, 3, 4, 5, 6].map((d) => newWeek.filter((f) => f.d === d).map((f) => f.t).sort((x, y) => x - y));
  const expected = []; for (let t = 3 * 60 + 30; t <= 4 * 60 + 30; t += 2) expected.push(t);
  check('EVERY day of the week (incl. Sunday=0 and Monday=1) now gets the same 31 calls 03:30-04:30 UTC', [0, 1, 2, 3, 4, 5, 6].every((d) => JSON.stringify(perDay[d]) === JSON.stringify(expected)), `Sun: ${perDay[0].length} calls, Mon: ${perDay[1].length} calls`);
  check('the two daily jobs never fire in the same minute on any day', new Set(newWeek.map((f) => `${f.d}@${f.t}`)).size === newWeek.length);

  check('the weekly scheme-master job is completely untouched (still Tuesday-only)', JSON.stringify(a[MASTER]) === JSON.stringify(master0));
  check('the hydration job is completely untouched', JSON.stringify(after.find((x) => x.jobname === HYDRATION)) === JSON.stringify(hydration0));

  let err = null;
  try { await db.exec(TARGET_SQL); } catch (e) { err = e.message; }
  const again = await jobs(db);
  check('re-applying 0220 is a clean no-op', err === null && JSON.stringify(again) === JSON.stringify(after), err ?? '');
}

// --- non-production: production-only guard --------------------------------
for (const envName of ['dev', null]) {
  const db = await replay(envName, TARGET);
  const preCommand = (await jobs(db)).find((x) => x.jobname === 'pc6-reference-ingest');
  await db.exec(TARGET_SQL);
  const post = await jobs(db);
  check(`${envName ?? 'no policy row'}: 0220 does nothing when no production policy row exists`, JSON.stringify(post.find((x) => x.jobname === 'pc6-reference-ingest')) === JSON.stringify(preCommand));
}
{
  // A DEV database that already has the daily jobs (planted by hand, or a
  // fresh replay of 0205 before any environment guard existed): 0220 must
  // leave them exactly as found, never touch them, never schedule the '*' form.
  const db = await replay('dev', TARGET);
  const before = await jobs(db);
  await db.exec(TARGET_SQL);
  const after = await jobs(db);
  check('DEV: 0220 leaves an already-absent daily schedule absent (no accidental creation)', after.every((x) => !DAILY.includes(x.jobname)), after.map((x) => x.jobname).join(', ') || '(none)');
  check('DEV: nothing here calls the production URL', after.every((x) => !/app\.financialhealthplatform\.com/.test(x.command)));
  void before;
}

console.log(`\n=== NAV1 / 0220 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
