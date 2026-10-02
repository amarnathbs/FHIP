// Negative-control proof for migrations 0228/0229's environment guard.
// Two fresh PGlite instances:
//   A) full chain replay, no platform_deployment_environment row inserted
//      (the DEV / fresh-environment / disaster-recovery-replay default) --
//      expect ZERO cron.job rows for the four purge/malware-scan-sweep names
//      after the full chain (0228 must no-op; 0229 must also no-op, since
//      there is nothing to unschedule).
//   B) full chain replay, but with the production marker row inserted
//      immediately before 0228 is applied -- expect all four cron.job rows
//      to exist, each pointing at the real production URL, and 0229 must
//      NOT remove them (0229's own inverse guard should refuse to touch a
//      database carrying the production marker).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MIG = path.join(REPO, 'supabase/migrations');
const JOB_NAMES = [
  'lr1-document-purge-sweep',
  'aie1-document-purge-sweep',
  'fdh3-malware-scan-sweep',
  'aie1-malware-scan-sweep',
];

function prepare(sql) {
  return sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '-- [PLATFORM SUBSTITUTION]');
}

async function replay({ insertProductionMarkerBefore }) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = prepare(fs.readFileSync(path.join(MIG, f), 'utf8'));
    if (insertProductionMarkerBefore && f.startsWith('0228')) {
      // The marker table is created by 0228 itself, so the insert must land
      // AFTER the `create table` statement but BEFORE the guarded `do $$`
      // block runs (otherwise the guard would see no row yet and no-op, or
      // the insert would fail with "relation does not exist"). Split 0228's
      // own file at its `do $$` guard block.
      const marker = 'do $$\nbegin\n  if not exists (select 1 from platform_deployment_environment';
      const idx = sql.indexOf(marker);
      if (idx === -1) throw new Error('0228 file shape changed -- update this test\'s split marker');
      await db.exec(sql.slice(0, idx));
      await db.exec(`insert into platform_deployment_environment (environment) values ('production') on conflict do nothing;`);
      await db.exec(sql.slice(idx));
      continue;
    }
    await db.exec(sql);
    if (f.startsWith('0001')) {
      await db.exec(fs.readFileSync(path.join(MIG, '..', 'seed.sql'), 'utf8'));
    }
  }
  return db;
}

let failures = 0;

console.log('=== Scenario A: fresh replay, NO production marker (DEV / fresh-env default) ===');
{
  const db = await replay({ insertProductionMarkerBefore: false });
  const res = await db.query(
    `select jobname, command from cron.job where jobname = any($1) order by jobname`,
    [JOB_NAMES]
  );
  console.log(`  cron.job rows for the 4 sweep jobs: ${res.rows.length} (expected 0)`);
  if (res.rows.length !== 0) {
    failures++;
    console.error('  FAIL: expected zero rows -- the production guard did not hold, or 0229 failed to clear a pre-existing row.');
    for (const r of res.rows) console.error(`    - ${r.jobname}`);
  } else {
    console.log('  PASS: no production-pointed cron jobs exist on a non-production replay.');
  }
}

console.log('\n=== Scenario B: production marker row inserted before 0228 ===');
{
  const db = await replay({ insertProductionMarkerBefore: true });
  const res = await db.query(
    `select jobname, command from cron.job where jobname = any($1) order by jobname`,
    [JOB_NAMES]
  );
  console.log(`  cron.job rows for the 4 sweep jobs: ${res.rows.length} (expected 4)`);
  if (res.rows.length !== 4) {
    failures++;
    console.error('  FAIL: expected all 4 jobs registered when the production marker is present.');
  } else {
    const allProd = res.rows.every(r => r.command.includes('https://app.financialhealthplatform.com'));
    const noneDev = res.rows.every(r => !r.command.includes('REPLACE_WITH'));
    console.log(`  each command targets the real production URL: ${allProd}`);
    console.log(`  none retain the old placeholder: ${noneDev}`);
    console.log('  0229 did NOT remove them (its own inverse guard held) since count is still 4 after the full chain.');
    if (!allProd || !noneDev) failures++;
  }
}

console.log(`\n${failures === 0 ? 'ALL SCENARIOS PASS' : `${failures} SCENARIO(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
