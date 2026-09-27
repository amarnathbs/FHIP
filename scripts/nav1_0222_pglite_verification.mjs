// NAV 1 -- PGlite verification for migration 0222 (PO decision #1, part 3 of
// 3: schedule the reconciliation window).
//
// Proves:
//   * ANTI-VACUITY: before 0222, no 'pc6-nav-reconciliation' cron job exists
//     on production;
//   * after 0222: exactly one job, firing every 2 minutes 10:00-10:16 UTC on
//     EVERY day of the week (9 calls/day, including Sunday and Monday --
//     consistent with 0220), calling the new route with the reconciliation
//     job key, same secret/timeout convention as 0205/0220;
//   * it starts strictly AFTER the daily window (0220) closes each day, so a
//     reconciliation call never races the collection window it is meant to
//     follow up on;
//   * re-applying 0222 is a clean no-op;
//   * the production-only guard: DEV/no-policy schedule nothing, and a
//     planted DEV copy is removed.
//
// Run: node scripts/nav1_0222_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0222_nav1_schedule_reconciliation_window.sql';
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
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  NAV1-0222-${String(pass + fail).padStart(2, '0')}  ${l}${d ? '\n        ' + d : ''}`); };

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

const RECON = 'pc6-nav-reconciliation';
const DAILY = ['pc6-reference-ingest', 'pc6-reference-ingest-0400'];

{
  const db = await replay('production', TARGET);
  const before = await jobs(db);
  check('ANTI-VACUITY: before 0222, no reconciliation job exists', !before.some((x) => x.jobname === RECON), before.map((x) => x.jobname).join(', '));
  const dailyBefore = Object.fromEntries(before.filter((x) => DAILY.includes(x.jobname)).map((x) => [x.jobname, x]));

  await db.exec(TARGET_SQL);
  const after = await jobs(db);
  const recon = after.find((x) => x.jobname === RECON);
  check('after 0222, exactly one reconciliation job exists', after.filter((x) => x.jobname === RECON).length === 1);
  check('every day of the week (incl. Sunday and Monday)', (() => {
    const week = expandWeek(recon.schedule);
    const perDay = [0, 1, 2, 3, 4, 5, 6].map((d) => week.filter((f) => f.d === d).length);
    return perDay.every((n) => n === 9);
  })(), expandWeek(recon.schedule).map((f) => `${f.d}@${f.t}`).join(' '));
  const week = expandWeek(recon.schedule);
  const times = [...new Set(week.map((f) => f.t))].sort((a, b) => a - b);
  const expected = []; for (let t = 10 * 60; t <= 10 * 60 + 16; t += 2) expected.push(t);
  check('10:00-10:16 UTC every 2 minutes (9 calls/day)', JSON.stringify(times) === JSON.stringify(expected), times.join(','));
  check('calls the NEW reconciliation route (not the main ingest route)', /\/cron\/pc6-nav-reconciliation\b/.test(recon.command));
  check('carries the reconciliation job key in its body', /"jobKey":"pc6_amfi_daily_nav_reconciliation"/.test(recon.command));
  check('reuses the SAME secret vault entry as 0205/0220 (no new secret introduced)', /pc6_reference_ingest_cron_secret/.test(recon.command));
  check('carries the same 300s pg_net timeout convention', /timeout_milliseconds\s*:=\s*300000\b/.test(recon.command));

  check('the daily-NAV jobs (0220) are completely untouched', DAILY.every((n) => JSON.stringify(after.find((x) => x.jobname === n)) === JSON.stringify(dailyBefore[n])));
  const dailyLatestEnd = Math.max(...DAILY.flatMap((n) => expandWeek(after.find((x) => x.jobname === n).schedule).map((f) => f.t)));
  const reconEarliest = Math.min(...times);
  check('the reconciliation window starts strictly AFTER the daily window closes each day (never races it)', reconEarliest > dailyLatestEnd, `daily closes by ${dailyLatestEnd}, reconciliation starts at ${reconEarliest}`);

  let err = null;
  try { await db.exec(TARGET_SQL); } catch (e) { err = e.message; }
  const again = await jobs(db);
  check('re-applying 0222 is a clean no-op', err === null && JSON.stringify(again) === JSON.stringify(after), err ?? '');
}

// --- non-production ---------------------------------------------------------
for (const envName of ['dev', null]) {
  const db = await replay(envName);
  const j = await jobs(db);
  check(`${envName ?? 'no policy row'}: no reconciliation job after the full chain`, j.every((x) => x.jobname !== RECON), j.map((x) => x.jobname).join(', ') || '(none)');
}
{
  const db = await replay('dev', TARGET);
  await db.query(`select cron.schedule($1, '* * * * *', 'select net.http_post(url := ''https://app.financialhealthplatform.com/x'')')`, [RECON]);
  const pre = (await jobs(db)).map((x) => x.jobname);
  check('ANTI-VACUITY: the planted DEV copy exists before 0222', pre.includes(RECON), pre.join(', '));
  await db.exec(TARGET_SQL);
  const post = await jobs(db);
  check('DEV: 0222 removes the planted copy', post.every((x) => x.jobname !== RECON), post.map((x) => x.jobname).join(', ') || '(none)');
}

console.log(`\n=== NAV1 / 0222 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
