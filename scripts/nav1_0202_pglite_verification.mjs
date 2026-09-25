// NAV 1 completion (2026-09-25) -- PGlite verification for migration 0202
// (300 s pg_net timeout on the production daily-NAV and scheme-master jobs).
//
// Anti-vacuity / negative control: on a production-shaped replay just before
// 0202, both jobs exist and their commands carry NO timeout_milliseconds (the
// 5 s pg_net default that stopped the first scheduled daily tick). After 0202:
// each job exactly once, same schedule, URL, secret and body, now with the
// 300 s timeout; the hydration job untouched; a re-apply is a clean no-op. On
// DEV-shaped and policy-less replays nothing is scheduled.
//
// Run: node scripts/nav1_0202_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0202_nav1_nav_schedules_http_timeout.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

async function replay(policyEnv, stopBefore = null) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (stopBefore && f >= stopBefore) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
    if (f.startsWith('0166') && policyEnv) {
      await db.exec(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ('nav1-0189-user-held', '2026-09-21', '${policyEnv}')`);
    }
  }
  return db;
}
const jobs = async (db) => (await db.query(`select jobname, schedule, command from cron.job order by jobname`)).rows;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  NAV1-0202-${String(pass + fail).padStart(2, '0')}  ${l}${d ? '\n        ' + d : ''}`); };
const NAV = ['pc6-reference-ingest', 'pc6-scheme-master-weekly'];

{
  const db = await replay('production', TARGET);
  const j = await jobs(db);
  const nav = j.filter((x) => NAV.includes(x.jobname));
  check('ANTI-VACUITY: on production just before 0202, both NAV jobs exist', nav.length === 2, j.map((x) => x.jobname).join(', '));
  check('NEGATIVE CONTROL: before 0202 neither carries timeout_milliseconds (pg_net default 5 s)', nav.every((x) => !/timeout_milliseconds/.test(x.command)));
  const before = Object.fromEntries(nav.map((x) => [x.jobname, x]));
  const hyd = j.find((x) => x.jobname === 'pc6-selective-hydration');

  await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
  const after = await jobs(db);
  const navAfter = after.filter((x) => NAV.includes(x.jobname));
  check('after 0202 each NAV job exists exactly once', NAV.every((n) => after.filter((x) => x.jobname === n).length === 1));
  check('...with timeout_milliseconds := 300000', navAfter.every((x) => /timeout_milliseconds\s*:=\s*300000\b/.test(x.command)));
  const norm = (c) => c.replace(/,\s*timeout_milliseconds\s*:=\s*300000\b/, '').replace(/\s+/g, ' ').trim();
  check('...and otherwise the SAME schedule, URL, secret and body as 0187/0188',
    navAfter.every((x) => x.schedule === before[x.jobname].schedule && norm(x.command) === norm(before[x.jobname].command)),
    navAfter.map((x) => `${x.jobname} ${x.schedule}`).join('; '));
  check('the hydration job (0193) is untouched', JSON.stringify(after.find((x) => x.jobname === 'pc6-selective-hydration')) === JSON.stringify(hyd));
  let err = null;
  try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { err = e.message; }
  const again = await jobs(db);
  check('re-applying 0202 is a clean no-op (still exactly once each, same commands)', err === null && NAV.every((n) => again.filter((x) => x.jobname === n).length === 1)
    && JSON.stringify(again.filter((x) => NAV.includes(x.jobname)).map((x) => [x.schedule, x.command])) === JSON.stringify(navAfter.map((x) => [x.schedule, x.command])), err ?? '');
}
for (const envName of ['dev', null]) {
  const db = await replay(envName);
  const j = await jobs(db);
  check(`${envName ?? 'no policy row'}: no NAV job scheduled after the full chain`, j.every((x) => !NAV.includes(x.jobname)), j.map((x) => x.jobname).join(', ') || '(none)');
  check(`${envName ?? 'no policy row'}: no job calls the production URL`, j.every((x) => !/app\.financialhealthplatform\.com/.test(x.command)));
}
console.log(`\n=== NAV 1 / 0202 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
