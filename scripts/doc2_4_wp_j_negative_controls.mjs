/**
 * Document2 (4) WP-J negative controls: removes ONE guard at a time from the source, runs the named tests that depend on it, and prints
 * which went red. The source file is always restored (also on error). A control that leaves its tests green proves nothing, so the script
 * exits non-zero if any mutation fails to turn at least one named test red.
 *
 *   node scripts/doc2_4_wp_j_negative_controls.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SUITE = 'tests/unit/doc2_4_wpJ_statementJobPglite.test.ts';
const PIPE = 'lib/services/investment-intelligence/statementPipeline.ts';
const STORE = 'lib/services/investment-intelligence/statementJob/store.ts';
const DEAD = 'lib/services/investment-intelligence/statementJob/deadRuns.ts';
const WORKER = 'lib/services/investment-intelligence/statementJob/worker.ts';

const controls = [
  {
    name: 'a row this run already wrote is no longer recognised after a kill (it is linked as a duplicate, never as the originating row)',
    file: PIPE,
    from: 'if (ex.source_document_id === sourceDocumentId && ex.parse_run_id === parseRunId) {',
    to: 'if (false) {',
    filter: 'killed at transactions:rows_written_before_links: the resumed job',
  },
  {
    name: 'the claims recorded before the write are ignored on resume (a stored row can be decided again)',
    file: PIPE,
    from: 'if (rec) {\n          twin = storedById.get(rec.oldId) ?? null;',
    to: 'if (false) {\n          twin = storedById.get((rec as ClaimRecord).oldId) ?? null;',
    filter: 'claimed once and corrected once',
  },
  {
    name: 'the stored rows claimed by EARLIER batches are no longer excluded (two lines can claim the same stored row)',
    file: PIPE,
    from: '...earlierClaims.map((c) => c.oldId), ',
    to: '',
    filter: 'claimed ONCE across slices',
  },
  {
    name: 'the replaced rows are never reversed (no correction exactly once at the end of the transaction step)',
    file: PIPE,
    from: 'if (!state.cursors.reversalDone) {',
    to: 'if (false) {',
    filter: 'corrected re-read replaces each aged row exactly once',
  },
  {
    name: 'fencing removed: a write to the job row no longer requires the lease holder',
    file: STORE,
    from: "    .eq('id', jobId)\n    .eq('lease_owner', owner)\n    .select('*')\n    .maybeSingle();\n  if (error) raise(error);\n  return (data as StatementJobRow | null) ?? null;\n}\n\n/** Ends a slice",
    to: "    .eq('id', jobId)\n    .select('*')\n    .maybeSingle();\n  if (error) raise(error);\n  return (data as StatementJobRow | null) ?? null;\n}\n\n/** Ends a slice",
    filter: 'a slice that lost its lease writes nothing',
  },
  {
    name: 'the dead-run guard treats every run as alive (a killed request blocks the statement for ever)',
    file: DEAD,
    from: 'return Number.isFinite(startedAt) && nowMs - startedAt < JOBLESS_RUN_DEAD_AFTER_MS;',
    to: 'return true;',
    filter: 'the dead-run guard',
  },
  {
    name: 'the password is written into the checkpoint (staged with the job)',
    file: PIPE,
    from: '  state.extractionMethod = extractionMethod;\n  state.detection =',
    to: '  (state as unknown as Record<string, unknown>).leak = env.password;\n  state.extractionMethod = extractionMethod;\n  state.detection =',
    filter: 'a protected statement',
  },
  {
    name: 'a job that failed for good leaves its parse run running',
    file: WORKER,
    from: "      .eq('id', state.parseRunId)\n      .in('run_status', ['queued', 'running']);",
    to: "      .eq('id', '00000000-0000-4000-8000-000000000000')\n      .in('run_status', ['queued', 'running']);",
    filter: 'three unexpected errors in a row',
  },
  {
    name: 'a certification pair is evaluated with the wrong owner flag source (every account counts as unresolved)',
    file: PIPE,
    from: 'state.ownerUnresolved && !explicitCache.get(accountId)',
    to: 'true',
    filter: '25 positions x 12 purchases \\(no references\\)',
  },
];

let bad = 0;
for (const c of controls) {
  const original = fs.readFileSync(c.file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const norm = original.replace(/\r\n/g, '\n');
  if (!norm.includes(c.from)) {
    console.log(`[SKIP] ${c.name}: the guarded text was not found (source changed)`);
    bad += 1;
    continue;
  }
  fs.writeFileSync(c.file, norm.replace(c.from, c.to).replace(/\n/g, eol));
  try {
    const r = spawnSync('npx', ['vitest', 'run', SUITE, '-t', `"${c.filter}"`, '--testTimeout=300000', '--reporter=json'], { encoding: 'utf8', shell: true, maxBuffer: 128 * 1024 * 1024 });
    let failed = [];
    try {
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      failed = json.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
    } catch {
      failed = ['(suite failed to run)'];
    }
    console.log(`[CONTROL] ${c.name}\n  red: ${failed.length}`);
    for (const f of failed.slice(0, 4)) console.log(`   - ${f}`);
    if (failed.length === 0) bad += 1;
  } finally {
    fs.writeFileSync(c.file, original);
  }
}
if (bad > 0) {
  console.log(`\n${bad} control(s) did NOT turn a named test red`);
  process.exit(1);
}
console.log('\nevery control turned at least one named test red; sources restored');
