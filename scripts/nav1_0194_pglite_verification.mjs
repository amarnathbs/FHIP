// NAV 1 — PGlite verification for migration 0194 (production-only 0187/0188
// NAV schedules).
//
// Each case replays the real chain in order, with the per-environment
// ii_nav_retention_policy row inserted where it would exist, so 0187/0188
// genuinely register their jobs before 0194 runs. The anti-vacuity check
// proves the jobs really are there just before 0194 -- otherwise "removed"
// would be trivially true.
//
// Run: node scripts/nav1_0194_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0194_nav1_production_only_nav_schedules.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const NAV_JOBS = ['pc6-reference-ingest', 'pc6-scheme-master-weekly'];

/** Replays the chain; inserts the policy row (if any) right after the table exists (0166). Stops before `stopBefore` if given. */
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
const jobNames = async (db) => (await db.query(`select jobname from cron.job order by jobname`)).rows.map((r) => r.jobname);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

// --- Anti-vacuity: just BEFORE 0194, a fresh replay really has the jobs ------------
{
  const db = await replay(null, TARGET);
  const j = await jobNames(db);
  check('ANTI-VACUITY: just before 0194, a fresh replay HAS both 0187/0188 jobs (so their removal below is real)',
    NAV_JOBS.every((n) => j.includes(n)), `jobs: ${j.join(', ')}`);
}

// --- Fresh replay (no policy row) ----------------------------------------------------
{
  const db = await replay(null);
  const j = await jobNames(db);
  check('fresh replay, no policy row: neither 0187/0188 job remains', NAV_JOBS.every((n) => !j.includes(n)), `jobs: ${j.join(', ') || '(none)'}`);
  check('...and no job at all calls the production app URL',
    (await db.query(`select count(*)::int n from cron.job where command like '%app.financialhealthplatform.com%'`)).rows[0].n === 0);
}

// --- DEV --------------------------------------------------------------------------------
{
  const db = await replay('dev');
  const j = await jobNames(db);
  check("DEV (policy environment = 'dev'): neither 0187/0188 job remains", NAV_JOBS.every((n) => !j.includes(n)), `jobs: ${j.join(', ') || '(none)'}`);
  check('...and no job calls the production app URL',
    (await db.query(`select count(*)::int n from cron.job where command like '%app.financialhealthplatform.com%'`)).rows[0].n === 0);
}

// --- Production ----------------------------------------------------------------------------
{
  const db = await replay('production');
  const j = await jobNames(db);
  check("production (policy environment = 'production'): both 0187/0188 jobs are KEPT", NAV_JOBS.every((n) => j.includes(n)), `jobs: ${j.join(', ')}`);
  check('...alongside 0193\'s hydration job', j.includes('pc6-selective-hydration'));
  let reapplyErr = null;
  try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
  const again = await jobNames(db);
  check('re-applying 0194 on production is idempotent and still keeps them', reapplyErr === null && NAV_JOBS.every((n) => again.includes(n)), reapplyErr ?? '');
}

// --- An environment where 0187/0188 were already applied, then made non-production ----
{
  const db = await replay(null, TARGET);            // jobs registered, as on a DEV that ran 0187/0188
  await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
  let reapplyErr = null;
  try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'))); } catch (e) { reapplyErr = e.message; }
  const j = await jobNames(db);
  check('where the jobs already existed, 0194 removes them -- and a second apply is a clean no-op', reapplyErr === null && NAV_JOBS.every((n) => !j.includes(n)), reapplyErr ?? `jobs: ${j.join(', ') || '(none)'}`);
}

console.log(`\n=== NAV 1 / 0194 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
