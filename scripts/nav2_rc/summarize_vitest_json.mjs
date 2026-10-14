// Summarises a vitest --reporter=json file: totals and the list of failed tests (file, full name). Optional second file: prints the failures that are NOT in it.
//   node scripts/nav2_rc/summarize_vitest_json.mjs <run.json> [baseline.json] [--names]
import fs from 'node:fs';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const failed = (j) => {
  const out = [];
  for (const f of j.testResults ?? []) {
    const file = String(f.name).replace(/\\/g, '/').replace(/^.*\/tests\/unit\//, 'tests/unit/');
    if (f.status === 'failed' && (f.assertionResults ?? []).every((a) => a.status !== 'failed')) out.push({ file, name: '(suite failed to run) ' + String(f.message ?? '').slice(0, 38) });
    for (const a of f.assertionResults ?? []) if (a.status === 'failed') out.push({ file, name: a.fullName, msg: (a.failureMessages ?? [])[0]?.slice(0, 140) });
  }
  return out;
};
const [run, base] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const j = load(run);
console.log(`${run}: files ${j.numTotalTestSuites ?? '?'} total tests ${j.numTotalTests} passed ${j.numPassedTests} failed ${j.numFailedTests} pending ${j.numPendingTests}; failed files ${new Set(failed(j).map((x) => x.file)).size}`);
const f = failed(j);
if (!base) { for (const x of f) console.log(`  FAIL ${x.file} :: ${x.name}${x.msg ? ' :: ' + x.msg.replace(/\s+/g, ' ') : ''}`.slice(0, 300)); process.exit(0); }
const b = load(base);
const bset = new Set(failed(b).map((x) => `${x.file}::${x.name}`));
console.log(`${base}: total tests ${b.numTotalTests} passed ${b.numPassedTests} failed ${b.numFailedTests}`);
const onlyRun = f.filter((x) => !bset.has(`${x.file}::${x.name}`));
const rset = new Set(f.map((x) => `${x.file}::${x.name}`));
const onlyBase = failed(b).filter((x) => !rset.has(`${x.file}::${x.name}`));
console.log(`failing in the run but NOT in the baseline: ${onlyRun.length}`);
for (const x of onlyRun) console.log(`  NEW  ${x.file} :: ${x.name}${x.msg ? ' :: ' + x.msg.replace(/\s+/g, ' ') : ''}`.slice(0, 300));
console.log(`failing in the baseline but not in the run: ${onlyBase.length}`);
for (const x of onlyBase) console.log(`  BASE ${x.file} :: ${x.name}`.slice(0, 220));
