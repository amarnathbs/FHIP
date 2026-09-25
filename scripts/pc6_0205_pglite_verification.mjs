// PC6 -- PGlite verification for migration 0205 (production-only, budgeted
// morning window for the daily NAV and weekly scheme-master ingest).
//
// Replays the real chain with the per-environment ii_nav_retention_policy
// row inserted where it would exist (as 0193/0194/0202's scripts do) and
// proves:
//   * ANTI-VACUITY: on production just before 0205, the 0187/0188 jobs exist
//     with their single-tick schedules and no pg_net timeout;
//   * after 0205: exactly the three expected jobs, each once, each with
//     timeout_milliseconds := 300000 and otherwise the SAME URL, secret and
//     body as 0187/0188; the hydration job is untouched;
//   * the schedules, EXPANDED over a real week by a small cron evaluator:
//     daily NAV every 2 min 03:30-04:30 UTC Tue-Sat (31 calls a day, none on
//     Sun/Mon), scheme master every 2 min 03:00-03:28 UTC Tuesday, finishing
//     before the first daily call. NEGATIVE CONTROL: the evaluator yields one
//     call a day for 0187's old '30 3 * * 2-6', so it is not vacuous;
//   * re-applying 0205 is a clean no-op;
//   * 0202 (unmerged NAV1 branch) applied BEFORE 0205 is fully superseded;
//     applied AFTER, it would put back the single 03:30 tick -- the hazard
//     the migration header warns about (read from git if the branch exists);
//   * DEV-shaped and policy-less replays schedule nothing and call no
//     production URL; a DEV database that somehow HAS these jobs has them
//     removed (and they really were there first).
//
// Run: node scripts/pc6_0205_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0205_pc6_nav_schedules_budgeted_window.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const TARGET_SQL = strip(fs.readFileSync(process.env.PC6_0205_SQL || path.join(MIG, TARGET), 'utf8'));
if (process.env.PC6_0205_SQL) console.log(`  (mutation run: 0205 body from ${process.env.PC6_0205_SQL})`);

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
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  PC6-0205-${String(pass + fail).padStart(2, '0')}  ${l}${d ? '\n        ' + d : ''}`); };

// --- a tiny cron evaluator (minute hour dom month dow; *, a, a-b, a-b/n, */n, lists) ---
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
/** Every firing, as 'dow HH:MM', over one week. */
function expandWeek(expr) {
  const [mi, ho, dom, mon, dw] = expr.trim().split(/\s+/);
  if (dom !== '*' || mon !== '*') throw new Error(`evaluator only supports dom/month '*': ${expr}`);
  const M = field(mi, 0, 59), H = field(ho, 0, 23), D = field(dw, 0, 6);
  const fires = [];
  for (let d = 0; d < 7; d++) if (D.has(d)) for (let h = 0; h < 24; h++) if (H.has(h)) for (let m = 0; m < 60; m++) if (M.has(m)) fires.push({ d, t: h * 60 + m });
  return fires;
}
const hhmm = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

const DAILY = ['pc6-reference-ingest', 'pc6-reference-ingest-0400'];
const MASTER = 'pc6-scheme-master-weekly';
const ALL = [...DAILY, MASTER];
const norm = (c) => c.replace(/,\s*timeout_milliseconds\s*:=\s*300000\b/, '').replace(/\s+/g, ' ').trim();

{
  const db = await replay('production', TARGET);
  const before = await jobs(db);
  const b = Object.fromEntries(before.map((x) => [x.jobname, x]));
  check('ANTI-VACUITY: on production just before 0205, the 0187/0188 jobs exist', !!b['pc6-reference-ingest'] && !!b[MASTER], before.map((x) => `${x.jobname} '${x.schedule}'`).join('; '));
  check('ANTI-VACUITY: ...with single-tick schedules and NO pg_net timeout',
    b['pc6-reference-ingest']?.schedule === '30 3 * * 2-6' && b[MASTER]?.schedule === '0 3 * * 2' && ![b['pc6-reference-ingest'], b[MASTER]].some((x) => /timeout_milliseconds/.test(x.command)));
  const oldDailyWeek = expandWeek(b['pc6-reference-ingest'].schedule);
  check('NEGATIVE CONTROL: the evaluator gives 0187\'s old schedule ONE call a day (5 a week)', oldDailyWeek.length === 5, oldDailyWeek.map((f) => `${f.d}@${hhmm(f.t)}`).join(' '));
  const hyd = before.find((x) => x.jobname === 'pc6-selective-hydration');

  await db.exec(TARGET_SQL);
  const after = await jobs(db);
  const a = Object.fromEntries(after.map((x) => [x.jobname, x]));
  check('after 0205 each of the three jobs exists exactly once', ALL.every((n) => after.filter((x) => x.jobname === n).length === 1), after.map((x) => x.jobname).join(', '));
  check('...every one with timeout_milliseconds := 300000', ALL.every((n) => /timeout_milliseconds\s*:=\s*300000\b/.test(a[n]?.command ?? '')));
  check('daily jobs: SAME URL, secret and body as 0187 (only the timeout added)', DAILY.every((n) => norm(a[n].command) === norm(b['pc6-reference-ingest'].command)));
  check('scheme master: SAME URL, secret and body as 0188 (only the timeout added)', norm(a[MASTER].command) === norm(b[MASTER].command));
  check('the hydration job (0193) is untouched', JSON.stringify(after.find((x) => x.jobname === 'pc6-selective-hydration')) === JSON.stringify(hyd));

  const daily = DAILY.flatMap((n) => expandWeek(a[n].schedule));
  const perDay = [0, 1, 2, 3, 4, 5, 6].map((d) => daily.filter((f) => f.d === d).map((f) => f.t).sort((x, y) => x - y));
  const expected = []; for (let t = 3 * 60 + 30; t <= 4 * 60 + 30; t += 2) expected.push(t);
  check('daily NAV: every 2 min from 03:30 to 04:30 UTC on each of Tue-Sat (31 calls a day)',
    [2, 3, 4, 5, 6].every((d) => JSON.stringify(perDay[d]) === JSON.stringify(expected)), `Tue: ${perDay[2].length} calls, ${hhmm(perDay[2][0] ?? 0)}-${hhmm(perDay[2].at(-1) ?? 0)}`);
  check('daily NAV: no calls on Sunday or Monday UTC', perDay[0].length === 0 && perDay[1].length === 0);
  check('daily NAV: the two jobs never fire in the same minute', new Set(daily.map((f) => `${f.d}@${f.t}`)).size === daily.length);
  const master = expandWeek(a[MASTER].schedule);
  const mExpected = []; for (let t = 3 * 60; t <= 3 * 60 + 28; t += 2) mExpected.push(t);
  check('scheme master: every 2 min 03:00-03:28 UTC, Tuesday only (15 calls)',
    master.every((f) => f.d === 2) && JSON.stringify(master.map((f) => f.t)) === JSON.stringify(mExpected), `${master.length} calls`);
  check('scheme master window closes before the first daily call', Math.max(...master.map((f) => f.t)) < Math.min(...perDay[2]));

  let err = null;
  try { await db.exec(TARGET_SQL); } catch (e) { err = e.message; }
  const again = await jobs(db);
  check('re-applying 0205 is a clean no-op', err === null && JSON.stringify(again.map((x) => [x.jobname, x.schedule, x.command])) === JSON.stringify(after.map((x) => [x.jobname, x.schedule, x.command])), err ?? '');
}

// --- interaction with the unmerged 0202 -----------------------------------
let sql0202 = null;
try {
  sql0202 = execFileSync('git', ['show', 'origin/fix/nav1-production-completion-2026-09-25:supabase/migrations/0202_nav1_nav_schedules_http_timeout.sql'], { cwd: path.resolve(HERE, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch { /* branch not available locally */ }
if (sql0202) {
  const db = await replay('production', TARGET);
  await db.exec(strip(sql0202));
  const mid = Object.fromEntries((await jobs(db)).map((x) => [x.jobname, x]));
  check('0202 BEFORE 0205: 0202 alone leaves the single 03:30 tick (with its timeout)', mid['pc6-reference-ingest']?.schedule === '30 3 * * 2-6' && /timeout_milliseconds\s*:=\s*300000/.test(mid['pc6-reference-ingest']?.command ?? ''));
  await db.exec(TARGET_SQL);
  const fin = Object.fromEntries((await jobs(db)).map((x) => [x.jobname, x]));
  check('0202 BEFORE 0205: 0205 then installs the full window (0202 fully superseded)',
    fin['pc6-reference-ingest']?.schedule === '30-58/2 3 * * 2-6' && fin['pc6-reference-ingest-0400']?.schedule === '0-30/2 4 * * 2-6' && fin[MASTER]?.schedule === '0-28/2 3 * * 2');
  await db.exec(strip(sql0202));
  const bad = Object.fromEntries((await jobs(db)).map((x) => [x.jobname, x]));
  check('HAZARD CONFIRMED: 0202 applied AFTER 0205 would put back the single 03:30 tick (so it must not be)',
    bad['pc6-reference-ingest']?.schedule === '30 3 * * 2-6' && bad[MASTER]?.schedule === '0 3 * * 2');
} else {
  console.log('  SKIP  0202 interaction checks (origin/fix/nav1-production-completion-2026-09-25 not available here)');
}

// --- non-production ---------------------------------------------------------
for (const envName of ['dev', null]) {
  const db = await replay(envName);
  const j = await jobs(db);
  check(`${envName ?? 'no policy row'}: no NAV/scheme-master job after the full chain`, j.every((x) => !ALL.includes(x.jobname)), j.map((x) => x.jobname).join(', ') || '(none)');
  check(`${envName ?? 'no policy row'}: no job calls the production URL`, j.every((x) => !/app\.financialhealthplatform\.com/.test(x.command)));
}
{
  // A DEV database that somehow holds these jobs (e.g. someone ran the old
  // migrations by hand): 0205 must remove them. Anti-vacuity: they are there first.
  const db = await replay('dev', TARGET);
  for (const n of ALL) await db.query(`select cron.schedule($1, '* * * * *', 'select net.http_post(url := ''https://app.financialhealthplatform.com/x'')')`, [n]);
  const pre = (await jobs(db)).map((x) => x.jobname);
  check('ANTI-VACUITY: the planted DEV copies exist before 0205', ALL.every((n) => pre.includes(n)), pre.join(', '));
  await db.exec(TARGET_SQL);
  const post = await jobs(db);
  check('DEV: 0205 removes every planted copy', post.every((x) => !ALL.includes(x.jobname)), post.map((x) => x.jobname).join(', ') || '(none)');
}

console.log(`\n=== PC6 / 0205 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
