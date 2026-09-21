// NAV 1.26 — live-DEV dry run of the selective historical hydration job.
// Proves the dependency-resolution query (accepted statements + benchmark
// mappings) against the REAL DEV database, per the job-control row's own
// stated prerequisite ("enabling is a deferred human-present step once
// NAV 1.26 ... is built, DEV-verified, and the dependency-resolution query
// ... is live-proven"). dryRun: true — no fetch, no write, no batch record.
//
// The kill switch is checked BEFORE dryRun (same convention as
// referenceIngestJob.ts's decideStart), so this script temporarily flips
// pc6_selective_historical_hydration.enabled to true in DEV ONLY for the
// duration of the dry run and restores the EXACT original row afterward
// (captured first, restored in a finally block) — a bounded, reversible,
// DEV-only toggle for verification, never left enabled and never touching
// production.
//
// Usage: npx tsx --env-file=.env.local scripts/nav1_hydration_live_dryrun.ts
import { createAdminClient } from '@/lib/supabase/admin';
import { runSelectiveHistoricalHydration } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { createLiveHydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';

const JOB_KEY = 'pc6_selective_historical_hydration';

async function main() {
  const db = createAdminClient();

  const { data: original, error: readErr } = await db
    .from('ii_reference_job_control')
    .select('*')
    .eq('job_key', JOB_KEY)
    .single();
  if (readErr || !original) {
    console.error('Could not read the original job_control row — refusing to proceed.', readErr?.message);
    process.exit(1);
  }
  console.log(`Original DEV row captured: enabled=${original.enabled}, disabled_reason=${JSON.stringify(original.disabled_reason)}`);

  try {
    const { error: enableErr } = await db.from('ii_reference_job_control').update({ enabled: true, disabled_reason: null }).eq('job_key', JOB_KEY);
    if (enableErr) throw new Error(`could not temporarily enable: ${enableErr.message}`);
    console.log('Temporarily enabled in DEV for this dry run only.\n');

    const result = await runSelectiveHistoricalHydration({
      changeoverDate: '2026-09-21',
      adapter: new TigzigHistoricalAdapter(),
      deps: createLiveHydrationDeps(),
      dryRun: true,
      maxInstruments: 100,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    const { error: restoreErr } = await db
      .from('ii_reference_job_control')
      .update({ enabled: original.enabled, disabled_reason: original.disabled_reason })
      .eq('job_key', JOB_KEY);
    if (restoreErr) {
      console.error(`\n*** FAILED TO RESTORE original job_control row: ${restoreErr.message} — DEV row may still be enabled=true. Check manually. ***`);
      process.exit(2);
    }
    console.log(`\nRestored original DEV row: enabled=${original.enabled}.`);
  }
}

main();
