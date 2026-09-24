// NAV 1 Stage D — PGlite verification for migration 0193 (hydration schedule).
//
// 0193 schedules calls to the PRODUCTION app URL, so its production-only guard
// is the part that matters: applied anywhere else it must register nothing
// and change nothing. Each case below starts from a fresh chain so no case can
// lean on another's leftovers.
//
// The scheduled command is also EXECUTED against the pg_net stub (whose
// signature mirrors real pg_net, timeout_milliseconds included), so a wrong
// argument name fails here rather than at the first production tick.
//
// Run: node scripts/nav1_0193_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0193_nav1_schedule_selective_hydration.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function freshUpTo0192() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files.filter((x) => x < TARGET)) {
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];
const jobs = async (db) => (await db.query(`select jobname, schedule, command from cron.job where jobname = 'pc6-selective-hydration'`)).rows;
const switchOn = async (db) => (await one(db, `select enabled from ii_reference_job_control where job_key = 'pc6_selective_historical_hydration'`))?.enabled;
const policy = (env) => `insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ('nav1-0189-user-held', '2026-09-21', '${env}')`;

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

// --- 1. Fresh chain / PGlite: no policy row at all ------------------------------
{
  const db = await freshUpTo0192();
  const before = await switchOn(db);
  await db.exec(target);
  check('with NO policy row (fresh chain, PGlite): nothing is scheduled', (await jobs(db)).length === 0);
  check('...and the kill switch is left exactly as it was', (await switchOn(db)) === before, `before=${before} after=${await switchOn(db)}`);
  check('...and the kill switch really was OFF to begin with (anti-vacuity)', before === false);
}

// --- 2. DEV: policy row says 'dev' ------------------------------------------------
{
  const db = await freshUpTo0192();
  await db.exec(policy('dev'));
  await db.exec(target);
  check("on DEV (policy environment = 'dev'): nothing is scheduled", (await jobs(db)).length === 0);
  check('...and the kill switch stays off', (await switchOn(db)) === false);
}

// --- 3. Production ------------------------------------------------------------------
{
  const db = await freshUpTo0192();
  await db.exec(policy('production'));
  await db.exec(target);
  const j = await jobs(db);
  check("on production (policy environment = 'production'): exactly one job is scheduled", j.length === 1);
  const cmd = j[0]?.command ?? '';
  check('it runs every 30 minutes', j[0]?.schedule === '*/30 * * * *', j[0]?.schedule);
  check('it calls the production hydration route', cmd.includes('https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-selective-hydration'));
  check('it passes the policy changeover date and a bounded batch size', cmd.includes('"changeoverDate":"2026-09-21"') && cmd.includes('"maxInstruments":10'));
  check('it authenticates with the PC6 cron secret created by 0187', cmd.includes("name = 'pc6_reference_ingest_cron_secret'"));
  check('the kill switch is now ON', (await switchOn(db)) === true);
  const reason = await one(db, `select disabled_reason, disabled_at from ii_reference_job_control where job_key = 'pc6_selective_historical_hydration'`);
  check('...with the stale "ships disabled" reason cleared', reason.disabled_reason === null && reason.disabled_at === null);

  // Execute the scheduled command itself against the pg_net stub.
  await db.exec(`create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    insert into vault.decrypted_secrets values ('pc6_reference_ingest_cron_secret', 'probe');`);
  let runErr = null;
  try { await db.exec(cmd); } catch (e) { runErr = e.message; }
  check('the scheduled command itself executes (argument names match pg_net, incl. timeout_milliseconds)', runErr === null, runErr ?? '');

  let reapplyErr = null;
  try { await db.exec(target); } catch (e) { reapplyErr = e.message; }
  check('re-applying is idempotent: no error, still exactly one job', reapplyErr === null && (await jobs(db)).length === 1, reapplyErr ?? '');
}

console.log(`\n=== NAV 1 / 0193 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
