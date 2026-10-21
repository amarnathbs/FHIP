/**
 * Document2 (4) WP-G negative controls: removes ONE guard at a time from the source, runs the worker suite, and prints which named
 * tests went red. The source file is always restored (also on error). A control that leaves the suite green proves nothing, so the
 * script exits non-zero if any mutation fails to turn at least one named test red.
 *
 *   node scripts/doc2_4_wp_g_negative_controls.mjs
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SUITE = 'tests/unit/doc2_4_wpG_bankImportWorker.test.ts';
const controls = [
  {
    name: 'persist writes every staged line again (no "only what is missing" rule)',
    file: 'lib/financial-data-hub/services/bankImportWorker.ts',
    from: 'const todo = rowsStillToWrite((chunk.payload.rows ?? []) as Array<{ source_row?: unknown }>, stored);',
    to: 'const todo = ((chunk.payload.rows ?? []) as Array<{ source_row?: unknown }>);',
  },
  {
    name: 'finalize does not clear what a killed finalize derived',
    file: 'lib/financial-data-hub/services/bankImportWorker.ts',
    from: '  await clearDerived(userId, documentId);\n  if (',
    to: '  if (',
  },
  {
    name: 'fencing removed: a write no longer requires the lease holder',
    file: 'lib/financial-data-hub/services/bankImportJobStore.ts',
    from: "    .eq('id', jobId)\n    .eq('lease_owner', owner)\n    .select('*')",
    to: "    .eq('id', jobId)\n    .select('*')",
  },
  {
    name: 'the dead-run reaper no longer spares job-owned statements',
    file: 'lib/financial-data-hub/bank-csv/repository.ts',
    from: '    if (owned.has(id)) continue;\n',
    to: '',
  },
  {
    name: 'the read phase no longer clears what an earlier attempt wrote',
    file: 'lib/financial-data-hub/services/bankImportWorker.ts',
    from: "  await clearImportArtifacts(userId, documentId);\n  await patchDoc(userId, documentId, { processing_status: 'processing', processing_started_at: new Date(c.now()).toISOString(), error_code: null });\n  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_processing_started'",
    to: "  await patchDoc(userId, documentId, { processing_status: 'processing', processing_started_at: new Date(c.now()).toISOString(), error_code: null });\n  await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_csv_processing_started'",
  },
  {
    name: 'a failed job no longer removes its partial lines',
    file: 'lib/financial-data-hub/services/bankImportWorker.ts',
    from: "    if ((options.clean ?? 'import') === 'import') {\n      await clearImportArtifacts(userId, documentId);",
    to: "    if ((options.clean ?? 'import') === 'import') {\n      // control: no clearing",
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
    const r = spawnSync('npx', ['vitest', 'run', SUITE, '--testTimeout=120000', '--reporter=json'], { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
    let failed = [];
    try {
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      failed = json.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
    } catch {
      failed = ['(suite failed to run)'];
    }
    console.log(`[CONTROL] ${c.name}\n  red: ${failed.length}`);
    for (const f of failed.slice(0, 6)) console.log(`   - ${f}`);
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
