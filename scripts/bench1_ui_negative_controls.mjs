#!/usr/bin/env node
// BENCH-1 Phase 2 -- negative controls for the Market Index Data Admin UI decision logic.
//
// For each control: (1) confirm the test files are green on the UNMUTATED source,
// (2) apply ONE tiny mutation that removes/weakens exactly one rule in
// components/admin/benchmarkData/benchmarkDataUiLogic.ts, (3) run the matching
// vitest file(s) and require that a NAMED test fails, (4) restore the source
// byte-exactly (try/finally + exit/signal handlers) and verify the restore with
// a SHA-256 hash. A control whose named test does not fail is reported as NOT
// demonstrated and the script exits non-zero.
//
// Usage (from the repository root):  node scripts/bench1_ui_negative_controls.mjs [--only <id-or-text>]
// Output: docs/investment-intelligence/evidence/bench1_phase2/ui_negative_controls.json
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'components/admin/benchmarkData/benchmarkDataUiLogic.ts';
const LOGIC_TEST = 'tests/unit/benchmarkDataUiLogic.test.ts';
const STATES_TEST = 'tests/unit/benchmarkDataClientStates.test.ts';
const OUT = path.join(ROOT, 'docs/investment-intelligence/evidence/bench1_phase2/ui_negative_controls.json');

/** @type {Array<{id:string, rule:string, edits:Array<{find:string, replace:string}>, tests:string[], expect:string[]}>} */
const CONTROLS = [
  { id: 'U01', rule: 'Publish is disabled while hard validation errors remain (no partial publication)', edits: [{ find: '  if (i.hardErrorCount > 0) reasons.push(', replace: '  if (false) reasons.push(' }], tests: [LOGIC_TEST, STATES_TEST], expect: ['publish stays disabled while hard errors remain', 'Publish is rendered disabled while hard errors remain'] },
  { id: 'U02', rule: 'A correction needs a written reason of at least 20 characters', edits: [{ find: '      if (f.reason.trim().length < 20) out.push(', replace: '      if (false) out.push(' }], tests: [LOGIC_TEST], expect: ['a correction needs a written reason'] },
  { id: 'U03', rule: 'The date format has no default: the operator must choose', edits: [{ find: "    dateFormat: '',", replace: "    dateFormat: 'YYYY-MM-DD'," }], tests: [LOGIC_TEST], expect: ['ambiguous date format has no default'] },
  { id: 'U04', rule: 'A missing required acknowledgement keeps Publish disabled', edits: [{ find: '  for (const m of missing) reasons.push(', replace: '  for (const m of []) reasons.push(' }], tests: [LOGIC_TEST, STATES_TEST], expect: ['required acknowledgement is missing', 'required acknowledgements render as explicit checkboxes'] },
  { id: 'U05', rule: 'The publish control is not shown to a user without the publish capability', edits: [{ find: "  return mode === 'correction' ? caps.correct === true : caps.publish === true;", replace: '  return true;' }], tests: [LOGIC_TEST, STATES_TEST], expect: ['never sees the publish control', 'sees no Publish button'] },
  { id: 'U06', rule: 'Self-publication needs its own explicit confirmation when staged by me', edits: [{ find: '  if (i.stagedByMe && !i.selfPublishAck) reasons.push(', replace: '  if (false) reasons.push(' }], tests: [LOGIC_TEST, STATES_TEST], expect: ['self-publication confirmation is required', 'self-publication needs its own box'] },
  { id: 'U07', rule: 'An XLSX file requires an explicit sheet choice', edits: [{ find: '  if (!sheetName) return { required: true, ok: false,', replace: '  if (false) return { required: true, ok: false,' }], tests: [LOGIC_TEST], expect: ['cannot proceed without an explicit sheet choice'] },
  { id: 'U08', rule: 'No approved entitlement blocks the upload (a file upload does not establish permission)', edits: [{ find: '  if (approved.length === 0) return { ok: false, message: NO_ENTITLEMENT_MESSAGE };', replace: '  if (false) return { ok: false, message: NO_ENTITLEMENT_MESSAGE };' }, { find: '  if (eligibleEntitlements(row, asOfDate).length === 0) {', replace: '  if (false) {' }], tests: [LOGIC_TEST], expect: ['no approved entitlement for the benchmark'] },
  { id: 'U09', rule: 'Capabilities are independent: upload does not grant publish', edits: [{ find: "    canPublishNew: c('publish'),", replace: "    canPublishNew: c('publish') || c('upload')," }], tests: [LOGIC_TEST], expect: ['granting one capability never switches on another control group'] },
  { id: 'U10', rule: 'A public-use permission requires the evidence URL', edits: [{ find: "    if (!f.evidenceUrl.trim()) e.evidenceUrl = 'A public-use permission", replace: "    if (false) e.evidenceUrl = 'A public-use permission" }], tests: [LOGIC_TEST], expect: ['public-use permission requires the evidence'] },
  { id: 'U11', rule: 'Automated mode is not shown as automated while recurring ingestion is OFF', edits: [{ find: "      return ing.automationEnabled && effectivelyEnabled ? { label: 'Automated', tone: 'ok' } :", replace: "      return true ? { label: 'Automated', tone: 'ok' } :" }], tests: [LOGIC_TEST], expect: ['NEVER describes manual import as automatic'] },
];

// ------------------------------------------------------------------ helpers ---
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const onlyArg = process.argv.indexOf('--only') >= 0 ? process.argv[process.argv.indexOf('--only') + 1] : null;

let restoreNow = null; // set while a mutation is applied
function safeRestore() {
  if (restoreNow) {
    try {
      restoreNow();
    } catch (e) {
      console.error('RESTORE FAILED', e);
    }
  }
}
process.on('exit', safeRestore);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    safeRestore();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  console.error(e);
  safeRestore();
  process.exit(1);
});

function runVitest(testFile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench1-ui-nc-'));
  const outFile = path.join(dir, 'result.json');
  try {
    const res = spawnSync('npx', ['vitest', 'run', testFile, '--reporter=json', `--outputFile=${outFile}`], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
    if (!existsSync(outFile)) return { ran: false, failed: [], total: 0, passed: 0, note: `vitest produced no JSON (exit ${res.status}): ${(res.stderr || '').slice(-400)}` };
    const json = JSON.parse(readFileSync(outFile, 'utf8'));
    const failed = [];
    for (const f of json.testResults ?? []) {
      for (const a of f.assertionResults ?? []) if (a.status === 'failed') failed.push(a.fullName || a.title);
      if ((f.assertionResults ?? []).length === 0 && f.status === 'failed') failed.push(`(file failed to run) ${f.message ?? ''}`.slice(0, 200));
    }
    return { ran: true, failed, total: json.numTotalTests ?? 0, passed: json.numPassedTests ?? 0, note: '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function countOccurrences(text, needle) {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

// --------------------------------------------------------------------- main ---
const controls = CONTROLS.filter((c) => !onlyArg || c.id.includes(onlyArg) || c.rule.includes(onlyArg));
const abs = path.join(ROOT, TARGET);
const baseline = {};
for (const testFile of [...new Set(controls.flatMap((c) => c.tests))]) {
  const r = runVitest(testFile);
  baseline[testFile] = { ran: r.ran, total: r.total, passed: r.passed, failed: r.failed };
  console.log(`baseline ${testFile}: ${r.passed}/${r.total} passed${r.failed.length ? ` -- FAILING: ${r.failed.join(' | ')}` : ''}`);
  if (!r.ran || r.failed.length > 0 || r.total === 0) {
    console.error('Baseline is not green; refusing to run controls (a control is meaningless against a red baseline).');
    process.exit(2);
  }
}

const results = [];
for (const c of controls) {
  const original = readFileSync(abs);
  const originalHash = sha(original);
  let text = original.toString('utf8');
  const entry = { id: c.id, rule: c.rule, mutatedFile: TARGET, edits: c.edits, testFiles: c.tests, expectedNamedFailures: c.expect, failingTests: [], namedFailingTests: [], demonstrated: false, restoredByteExact: false, note: '' };
  let applicable = true;
  for (const e of c.edits) {
    const n = countOccurrences(text, e.find);
    if (n !== 1) {
      applicable = false;
      entry.note = `mutation target found ${n} times (expected exactly 1): ${JSON.stringify(e.find).slice(0, 120)}`;
      break;
    }
    text = text.replace(e.find, () => e.replace);
  }
  if (!applicable) {
    entry.restoredByteExact = true;
    results.push(entry);
    console.log(`${c.id} SKIPPED: ${entry.note}`);
    continue;
  }
  restoreNow = () => writeFileSync(abs, original);
  try {
    writeFileSync(abs, text);
    const failing = [];
    for (const t of c.tests) {
      const r = runVitest(t);
      if (!r.ran) entry.note += ` ${t}: ${r.note}`;
      failing.push(...r.failed);
    }
    entry.failingTests = failing;
    entry.namedFailingTests = failing.filter((name) => c.expect.some((s) => name.toLowerCase().includes(s.toLowerCase())));
    entry.demonstrated = entry.namedFailingTests.length > 0;
  } finally {
    writeFileSync(abs, original);
    restoreNow = null;
    entry.restoredByteExact = sha(readFileSync(abs)) === originalHash;
    if (!entry.restoredByteExact) {
      console.error(`FATAL: ${TARGET} was NOT restored byte-exactly`);
      process.exitCode = 3;
    }
  }
  results.push(entry);
  console.log(`${c.id} ${entry.demonstrated ? 'DEMONSTRATED' : 'NOT DEMONSTRATED'} -- ${c.rule} -- named failing: ${entry.namedFailingTests.length}, total failing: ${entry.failingTests.length}`);
}

// A final green run proves the restored source passes again.
const after = {};
for (const testFile of [...new Set(controls.flatMap((c) => c.tests))]) {
  const r = runVitest(testFile);
  after[testFile] = { ran: r.ran, total: r.total, passed: r.passed, failed: r.failed };
  console.log(`after-restore ${testFile}: ${r.passed}/${r.total} passed`);
}

mkdirSync(path.dirname(OUT), { recursive: true });
const summary = {
  controls: results.length,
  demonstrated: results.filter((r) => r.demonstrated).length,
  notDemonstrated: results.filter((r) => !r.demonstrated).map((r) => r.id),
  allRestoredByteExact: results.every((r) => r.restoredByteExact),
  greenAfterRestore: Object.values(after).every((a) => a.ran && a.failed.length === 0 && a.total > 0),
};
writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), method: 'one tiny mutation per rule in benchmarkDataUiLogic.ts; the matching vitest file(s) must FAIL at least one NAMED test; source restored byte-exactly and verified by SHA-256', baseline, summary, controls: results, afterRestore: after }, null, 2) + '\n',
);
console.log(`\n${summary.demonstrated}/${summary.controls} controls demonstrated; restore byte-exact: ${summary.allRestoredByteExact}; green after restore: ${summary.greenAfterRestore}`);
console.log(`evidence: ${path.relative(ROOT, OUT)}`);
if (summary.notDemonstrated.length > 0 || !summary.allRestoredByteExact || !summary.greenAfterRestore) process.exitCode = process.exitCode || 1;
