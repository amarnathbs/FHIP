// NAV 1 monitoring truthfulness -- live proof of the REAL job-control writer
// against DEV (2026-09-27).
//
// Exercises createLiveHydrationDeps().recordJobControlOutcome -- the exact code
// production runs after each hydration batch -- against the DEV row
// ii_reference_job_control.pc6_selective_historical_hydration, then restores
// that row byte-for-byte (every column, including updated_at).
//
// Proves on a real PostgREST/Postgres:
//   P1 a success sets last_success_at + last_success_batch_id and resets the streak;
//   P2 the same success recorded again changes nothing (idempotent);
//   P3 a failure sets last_failure_at and increments the streak;
//   P4 the same failure recorded again does NOT increment it again;
//   P5 an OLDER success arriving late does not move last_success_at backwards;
//   P6 a partial outcome writes nothing;
//   P7 the row is restored exactly (residue: none).
//
// Safety: asserts the DEV host before anything; never touches `enabled` or
// `disabled_reason` (the DEV kill switch stays exactly as it was); the restore
// runs in `finally`.
//
// Usage: npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_monitoring_dev_proof.ts <outDir>

import fs from 'node:fs';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { createLiveHydrationDeps } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const JOB = 'pc6_selective_historical_hydration';
const outDir = process.argv[2];
if (!outDir) { console.error('usage: <outDir>'); process.exit(2); }
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://x').host !== DEV_HOST) {
  console.error('REFUSING: NEXT_PUBLIC_SUPABASE_URL is not the DEV project');
  process.exit(3);
}

const db = createAdminClient();
const COLS = 'job_key, enabled, disabled_reason, disabled_by_admin_id, disabled_at, last_success_at, last_success_batch_id, last_failure_at, consecutive_failures, next_attempt_not_before, updated_at';
const read = async () => {
  const { data, error } = await db.from('ii_reference_job_control').select(COLS).eq('job_key', JOB).single();
  if (error) throw new Error(`read failed: ${error.message}`);
  return data as Record<string, unknown>;
};

async function main() {
  const before = await read();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'job_control_before.json'), JSON.stringify(before, null, 1));
  const deps = createLiveHydrationDeps();
  const results: Array<{ check: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} -- ${detail}`); };
  // Timestamps in the future relative to anything stored, so the guard admits them.
  const t = (m: number) => new Date(Date.UTC(2099, 0, 1, 0, m)).toISOString();
  try {
    let r = await deps.recordJobControlOutcome!({ status: 'succeeded', finishedAt: t(10), batchId: null });
    let row = await read();
    check('P1 success recorded', r.error === null && new Date(String(row.last_success_at)).toISOString() === t(10) && row.consecutive_failures === 0, `error=${r.error} last_success_at=${row.last_success_at} cf=${row.consecutive_failures}`);

    r = await deps.recordJobControlOutcome!({ status: 'succeeded', finishedAt: t(10), batchId: null });
    const row2 = await read();
    check('P2 same success twice is a no-op', r.error === null && row2.updated_at === row.updated_at, `updated_at unchanged=${row2.updated_at === row.updated_at}`);

    r = await deps.recordJobControlOutcome!({ status: 'failed', finishedAt: t(20), batchId: null });
    row = await read();
    check('P3 failure recorded, streak 1', r.error === null && new Date(String(row.last_failure_at)).toISOString() === t(20) && row.consecutive_failures === 1, `last_failure_at=${row.last_failure_at} cf=${row.consecutive_failures}`);

    r = await deps.recordJobControlOutcome!({ status: 'failed', finishedAt: t(20), batchId: null });
    row = await read();
    check('P4 same failure twice is not double-counted', r.error === null && row.consecutive_failures === 1, `cf=${row.consecutive_failures}`);

    r = await deps.recordJobControlOutcome!({ status: 'succeeded', finishedAt: t(5), batchId: null });
    row = await read();
    check('P5 older success does not move last_success_at back', r.error === null && new Date(String(row.last_success_at)).toISOString() === t(10), `last_success_at=${row.last_success_at}`);

    const beforePartial = await read();
    r = await deps.recordJobControlOutcome!({ status: 'partial', finishedAt: t(30), batchId: null });
    row = await read();
    check('P6 partial writes nothing', r.error === null && JSON.stringify(row) === JSON.stringify(beforePartial), 'row identical');
  } finally {
    const { error } = await db.from('ii_reference_job_control').update({
      last_success_at: before.last_success_at, last_success_batch_id: before.last_success_batch_id,
      last_failure_at: before.last_failure_at, consecutive_failures: before.consecutive_failures,
      next_attempt_not_before: before.next_attempt_not_before, updated_at: before.updated_at,
    }).eq('job_key', JOB);
    const after = await read();
    const same = JSON.stringify(after) === JSON.stringify(before);
    check('P7 row restored exactly (residue none)', !error && same, `restore error=${error?.message ?? null}; identical=${same}`);
    fs.writeFileSync(path.join(outDir, 'job_control_after_restore.json'), JSON.stringify(after, null, 1));
    fs.writeFileSync(path.join(outDir, 'monitoring_dev_proof.json'), JSON.stringify({ at: new Date().toISOString(), host: DEV_HOST, results }, null, 1));
    const failed = results.filter((x) => !x.pass).length;
    console.log(`${results.length - failed}/${results.length} PASS`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
