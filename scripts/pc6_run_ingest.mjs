// One-time (or ad hoc) hand-run of the real PC6 reference-ingest job,
// calling runReferenceIngest() directly rather than the HTTP cron route --
// avoids needing a Vault secret / reachable app origin just to bootstrap.
// The job's own kill switch (ii_reference_job_control) must already be
// enabled for the given jobKey, or this reports 'skipped_kill_switch' and
// writes nothing -- that is the job's own real behaviour, not a script bug.
//
// Usage:
//   node scripts/pc6_run_ingest.mjs <sourceConfigId> <jobKey> [--production] [--dry] [--budget-ms=N]
//
// Examples:
//   node scripts/pc6_run_ingest.mjs amfi_scheme_master pc6_amfi_scheme_master --production
//   node scripts/pc6_run_ingest.mjs amfi_nav_daily pc6_amfi_daily_nav --production
import fs from 'fs';

const envPath = new URL('../.env.local', import.meta.url);
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const useProduction = process.argv.includes('--production');
if (useProduction) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.PRODUCTION_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
}
console.log(`Target: ${useProduction ? 'PRODUCTION' : 'DEV'} (${process.env.NEXT_PUBLIC_SUPABASE_URL})`);

const sourceConfigId = process.argv[2];
const jobKey = process.argv[3];
const dryRun = process.argv.includes('--dry');
if (!sourceConfigId || !jobKey) {
  console.error('Usage: node scripts/pc6_run_ingest.mjs <sourceConfigId> <jobKey> [--production] [--dry]');
  process.exit(1);
}

// A hand run has no 28 s platform limit, so by default it is NOT time-
// budgeted (the job itself defaults to 18 s for the HTTP route). Pass
// --budget-ms=18000 to reproduce exactly what one scheduled call does.
const budgetArg = process.argv.find((a) => a.startsWith('--budget-ms='));
const budgetMs = budgetArg ? Number(budgetArg.split('=')[1]) : Infinity;

const { runReferenceIngest } = await import('../lib/services/investment-intelligence/pc6/referenceIngestJob.ts');
const result = await runReferenceIngest({
  jobKey,
  sourceConfigId,
  asOfDate: new Date().toISOString().slice(0, 10),
  dryRun,
  budgetMs,
});
console.log(JSON.stringify(result, null, 2));
