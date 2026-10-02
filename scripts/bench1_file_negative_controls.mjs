#!/usr/bin/env node
// BENCH-1 Phase 2 -- negative controls for the file-ingest library.
//
// For each control: (1) confirm the test file is green on the UNMUTATED source,
// (2) apply ONE tiny mutation that removes/weakens exactly one rule, (3) run
// the matching vitest file and require that a NAMED test fails, (4) restore the
// source byte-exactly (try/finally + exit/signal handlers) and verify the
// restore with a SHA-256 hash. A control whose named test does not fail is
// reported as NOT demonstrated, and the script exits non-zero.
//
// Usage (from the repository root):  node scripts/bench1_file_negative_controls.mjs [--only <id-substring>]
// Output: docs/investment-intelligence/evidence/bench1_phase2/file_negative_controls.json
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'lib/services/investment-intelligence/benchmarkData/fileIngest/';
const T = (name) => `tests/unit/benchmarkDataFile${name}.test.ts`;
const OUT = path.join(ROOT, 'docs/investment-intelligence/evidence/bench1_phase2/file_negative_controls.json');

/** @type {Array<{id:string, rule:string, file:string, edits:Array<{find:string, replace:string}>, test:string, expect:string[]}>} */
const CONTROLS = [
  // ---- validator rules ----
  { id: 'C01', rule: 'future market dates are rejected', file: 'validator.ts', edits: [{ find: 'if (iso > ctx.todayIso) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['future date'] },
  { id: 'C02', rule: 'dates outside the entitlement data-date scope are rejected', file: 'validator.ts', edits: [{ find: 'if (scope && ((scope.from && iso < scope.from) || (scope.to && iso > scope.to))) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['date before entitlement scope start', 'date after entitlement scope end'] },
  { id: 'C03', rule: 'zero levels are rejected as non-positive', file: 'validator.ts', edits: [{ find: 'else if (res.value <= 0) {', replace: 'else if (res.value < 0) {' }], test: T('Validator'), expect: ['zero level'] },
  { id: 'C04', rule: 'return variant must equal the catalogue variant for every row', file: 'validator.ts', edits: [{ find: 'if (entry.returnVariant !== params.returnVariant) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['return variant differs', 'variant, currency and inactive checks apply to EVERY row'] },
  { id: 'C05', rule: 'currency must equal the catalogue currency for every row', file: 'validator.ts', edits: [{ find: 'if (entry.currencyCode !== params.currencyCode) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['currency differs'] },
  { id: 'C06', rule: 'conflicting duplicate (key,date) rows are errors, not collapsed', file: 'validator.ts', edits: [{ find: 'if (g.every((x) => sameLevel(x.value, g[0].value))) {', replace: 'if (true) {' }], test: T('Validator'), expect: ['conflicting duplicate rows'] },
  { id: 'C07', rule: 'new-history upload may not silently change a published level', file: 'validator.ts', edits: [{ find: "else if (params.mode === 'new_history') {", replace: 'else if (false) {' }], test: T('Validator'), expect: ['new-history upload conflicting with a published level'] },
  { id: 'C08', rule: 'correction mode requires an existing published level', file: 'validator.ts', edits: [{ find: "if (params.mode === 'correction') {", replace: 'if (false) {' }], test: T('Validator'), expect: ['correction with nothing to correct'] },
  { id: 'C09', rule: 'weekend-dated rows are flagged for acknowledgement (never silently dropped)', file: 'validator.ts', edits: [{ find: 'const weekend = rows.filter((r) => isWeekendDay(dayNumber(r.date)));', replace: 'const weekend: StagedRow[] = [];' }], test: T('Validator'), expect: ['weekend-dated row', 'weekend rows stay in staging'] },
  { id: 'C10', rule: 'large moves are review warnings, never errors', file: 'validator.ts', edits: [{ find: "            'warning',\n            cur.rowNumber,\n            'LARGE_MOVE',", replace: "            'error',\n            cur.rowNumber,\n            'LARGE_MOVE'," }], test: T('Validator'), expect: ['large day-over-day move', 'large moves up and down are warnings only'] },
  { id: 'C11', rule: 'suspected scale/rebasing change is flagged', file: 'validator.ts', edits: [{ find: 'export const SCALE_RATIO_HIGH = 5;', replace: 'export const SCALE_RATIO_HIGH = 5000;' }], test: T('Validator'), expect: ['suspected rebasing', 'a 10% move exactly is not flagged'] },
  { id: 'C12', rule: 'coverage gaps longer than 3 weekdays are flagged', file: 'validator.ts', edits: [{ find: 'export const GAP_WEEKDAY_THRESHOLD = 3;', replace: 'export const GAP_WEEKDAY_THRESHOLD = 300;' }], test: T('Validator'), expect: ['coverage gap of 4 weekdays', 'coverage gaps need MORE than 3'] },
  { id: 'C13', rule: 'incoming levels are compared with the nearest published neighbour', file: 'validator.ts', edits: [{ find: 'if (existingForKey && existingForKey.size > 0) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['compares the first and last incoming level'] },
  { id: 'C14', rule: 'hidden rows included on request need an acknowledgement', file: 'validator.ts', edits: [{ find: "if (params.includeHiddenRows && included.length > 0) acks.add('hidden_rows_included');", replace: "if (false) acks.add('hidden_rows_included');" }], test: T('Pipeline'), expect: ['when included on request they are processed'] },
  { id: 'C15', rule: 'Excel date system must match the workbook', file: 'validator.ts', edits: [{ find: "if (params.dateFormat === 'excel_1900' && table.date1904) {", replace: 'if (false) {' }], test: T('Pipeline'), expect: ['declaring the wrong system for the workbook'] },
  { id: 'C16', rule: 'formula cells in required columns are rejected', file: 'validator.ts', edits: [{ find: 'if (requiredIdx.has(idx)) {', replace: 'if (false) {' }], test: T('Pipeline'), expect: ['formula in the VALUE column', 'formula in the DATE column', 'formula in the benchmark_key column'] },
  { id: 'C17', rule: 'rows beyond the configured row limit are a hard error', file: 'validator.ts', edits: [{ find: 'if (dataRows.length > limits.maxRows) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['rows beyond the limit'] },
  { id: 'C18', rule: 'an empty benchmark_key in a multi file is an error', file: 'validator.ts', edits: [{ find: "if (raw === '') push('error', n, 'BENCHMARK_KEY_EMPTY'", replace: "if (false) push('error', n, 'BENCHMARK_KEY_EMPTY'" }], test: T('Validator'), expect: ['empty and unknown keys are errors'] },
  { id: 'C19', rule: 'rows left out by an index-name map are disclosed', file: 'validator.ts', edits: [{ find: 'if (excludedNames.size > 0) {', replace: 'if (false) {' }], test: T('Validator'), expect: ['indexNameToKey maps names exactly'] },
  { id: 'C20', rule: 'skipped hidden rows are disclosed as a warning', file: 'validator.ts', edits: [{ find: 'if (skipped.length > 0) {', replace: 'if (false) {' }], test: T('Pipeline'), expect: ['by default hidden rows are NOT processed'] },
  // ---- dates ----
  { id: 'C21', rule: 'DD/MM/YYYY is not treated as MM/DD/YYYY', file: 'dateParsing.ts', edits: [{ find: "return numericDmy(s, '/', format, 'dmy');", replace: "return numericDmy(s, '/', format, 'mdy');" }], test: T('DatesNumbers'), expect: ['03/04/2024 is 3 April'] },
  { id: 'C22', rule: 'timestamps are rejected as DATE_IS_TIMESTAMP, never truncated', file: 'dateParsing.ts', edits: [{ find: 'if (looksLikeTimestamp(s)) {', replace: 'if (false) {' }], test: T('DatesNumbers'), expect: ['DATE_IS_TIMESTAMP'] },
  { id: 'C23', rule: 'Excel serial 60 (1900 leap-year bug) is rejected', file: 'xlsxReader.ts', edits: [{ find: 'if (serial === 60) return null;', replace: 'void 0;' }], test: T('DatesNumbers'), expect: ['serial 60'] },
  { id: 'C24', rule: 'the 1904 date system is honoured (not treated as 1900)', file: 'xlsxReader.ts', edits: [{ find: 'epochMs = Date.UTC(1904, 0, 1) + serial * DAY_MS;', replace: 'epochMs = (serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) + serial * DAY_MS;' }], test: T('DatesNumbers'), expect: ['four years and a day apart'] },
  // ---- numbers ----
  { id: 'C25', rule: 'percentage returns are rejected as levels', file: 'numberParsing.ts', edits: [{ find: "if (s.includes('%')) {", replace: 'if (false) {' }], test: T('DatesNumbers'), expect: ['VALUE_IS_PERCENT'] },
  { id: 'C26', rule: 'a leading + is rejected', file: 'numberParsing.ts', edits: [{ find: "if (s[0] === '+')", replace: 'if (false)' }], test: T('DatesNumbers'), expect: ['VALUE_LEADING_PLUS'] },
  { id: 'C27', rule: 'more than 6 decimals is rejected, not truncated', file: 'numberParsing.ts', edits: [{ find: 'if (!/^0+$/.test(fracPart.slice(MAX_DECIMALS))) {', replace: 'if (false) {' }], test: T('DatesNumbers'), expect: ['VALUE_TOO_PRECISE', 'allows at most 6 decimals'] },
  { id: 'C28', rule: 'Indian grouping is strict (Western grouping rejected under the in locale)', file: 'numberParsing.ts', edits: [{ find: 'if (first.length < 1 || first.length > 2) return false;', replace: 'if (first.length < 1) return false;' }], test: T('DatesNumbers'), expect: ['in: Indian grouping'] },
  // ---- file inspection / zip ----
  { id: 'C29', rule: 'NUL bytes make a CSV invalid', file: 'fileInspection.ts', edits: [{ find: 'if (body.includes(0))', replace: 'if (false)' }], test: T('Inspection'), expect: ['rejects a NUL byte'] },
  { id: 'C30', rule: 'macro workbooks (vbaProject.bin) are rejected', file: 'fileInspection.ts', edits: [{ find: "if (zip.has('xl/vbaProject.bin')) {", replace: 'if (false) {' }], test: T('Inspection'), expect: ['rejects a workbook that contains a macro project'] },
  { id: 'C31', rule: 'a declared MIME type that contradicts the file is rejected', file: 'fileInspection.ts', edits: [{ find: 'if (!GENERIC_MIME.has(mime) && !CSV_MIME.has(mime)) {', replace: 'if (false) {' }], test: T('Inspection'), expect: ['rejects a declared MIME type that contradicts the file (csv)'] },
  { id: 'C32', rule: 'the byte limit is enforced', file: 'fileInspection.ts', edits: [{ find: 'if (bytes.length > limits.maxBytes) {', replace: 'if (false) {' }], test: T('Inspection'), expect: ['enforces the byte limit exactly'] },
  { id: 'C33', rule: 'invalid UTF-8 is rejected', file: 'fileInspection.ts', edits: [{ find: "new TextDecoder('utf-8', { fatal: true }).decode(body)", replace: "new TextDecoder('utf-8', { fatal: false }).decode(body)" }], test: T('Inspection'), expect: ['rejects invalid UTF-8'] },
  { id: 'C34', rule: 'the zip compression-ratio limit is enforced (limit made infinite)', file: 'types.ts', edits: [{ find: 'maxZipRatio: 100,', replace: 'maxZipRatio: Number.POSITIVE_INFINITY,' }], test: T('Inspection'), expect: ['extreme compression ratio'] },
  { id: 'C35', rule: 'a lying zip header cannot expand past its declared size at inflate time (maxOutputLength AND the size check removed)', file: 'zipReader.ts', edits: [{ find: 'maxOutputLength: Math.max(e.uncompressedSize, 1)', replace: 'maxOutputLength: 1 << 30' }, { find: 'if (out.length !== e.uncompressedSize) {', replace: 'if (false) {' }], test: T('Inspection'), expect: ['catches a LYING header at inflate time'] },
  { id: 'C36', rule: 'inflated size must equal the declared size (size check removed only)', file: 'zipReader.ts', edits: [{ find: 'if (out.length !== e.uncompressedSize) {', replace: 'if (false) {' }], test: T('Inspection'), expect: ['inflates to LESS than declared'] },
  { id: 'C37', rule: 'zip path traversal names are rejected', file: 'zipReader.ts', edits: [{ find: "if (seg === '..') return true;", replace: "if (seg === '..') return false;" }], test: T('Inspection'), expect: ['rejects path-traversal names'] },
  // ---- csv ----
  { id: 'C38', rule: 'an ambiguous delimiter is reported, not guessed', file: 'csvReader.ts', edits: [{ find: 'if (winners.length === 1) return { delimiter: winners[0].d, problems };', replace: 'if (true) return { delimiter: winners[0].d, problems };' }], test: T('Csv'), expect: ['reports AMBIGUOUS_DELIMITER'] },
  { id: 'C39', rule: 'ragged rows are reported with their row number', file: 'csvReader.ts', edits: [{ find: 'if (rows[r].length !== width) {', replace: 'if (false) {' }], test: T('Csv'), expect: ['reports ragged rows'] },
  // ---- xlsx ----
  { id: 'C40', rule: 'hidden rows are disclosed, not silently ignored', file: 'xlsxReader.ts', edits: [{ find: '(includeHidden ? hiddenIncluded : hiddenSkipped).push(r.rowNumber);', replace: 'if (includeHidden) hiddenIncluded.push(r.rowNumber);' }], test: T('Xlsx'), expect: ['excludes hidden rows by default and lists them'] },
  { id: 'C41', rule: 'DTD / entity definitions in XML are forbidden', file: 'xmlScanner.ts', edits: [{ find: "if (xml.startsWith('<!', i)) {", replace: 'if (false) {' }], test: T('Xlsx'), expect: ['rejects a DOCTYPE / entity definition'] },
  { id: 'C42', rule: 'the XLSX sheet must be chosen explicitly (silent default to the first sheet)', file: 'xlsxReader.ts', edits: [{ find: 'if (!sheetName) {', replace: 'if (false) {' }, { find: 'const sheet = wb.sheets.find((s) => s.name === sheetName);', replace: 'const sheet = sheetName ? wb.sheets.find((s) => s.name === sheetName) : wb.sheets[0];' }], test: T('Xlsx'), expect: ['requires a sheet name and lists the available sheets'] },
  { id: 'C43', rule: 'very-hidden sheets are refused', file: 'xlsxReader.ts', edits: [{ find: "if (sheet.state === 'veryHidden') {", replace: 'if (false) {' }], test: T('Xlsx'), expect: ['refuses a very-hidden sheet'] },
  { id: 'C44', rule: 'merged cells in the data area are flagged', file: 'xlsxReader.ts', edits: [{ find: 'if (m.r2 > headerRow) {', replace: 'if (false) {' }], test: T('Xlsx'), expect: ['flags merged cells'] },
  { id: 'C45', rule: 'date cells are detected from the number format', file: 'xlsxReader.ts', edits: [{ find: 'const isDate = cStyle >= 0 && dateStyles[cStyle] === true;', replace: 'const isDate = false;' }], test: T('Xlsx'), expect: ['detects date cells from built-in and custom number formats'] },
  // ---- layouts ----
  { id: 'C46', rule: 'a layout whose variant conflicts with the declared variant is a hard error', file: 'layouts.ts', edits: [{ find: 'if (variantHint !== null && variantHint !== params.returnVariant) {', replace: 'if (false) {' }], test: T('Layouts'), expect: ['a layout whose variant conflicts'] },
  // ---- error CSV ----
  { id: 'C47', rule: "error-CSV cells starting with '=' are neutralised", file: 'errorCsv.ts', edits: [{ find: "const TRIGGERS = new Set(['=', '+', '-', '@']);", replace: "const TRIGGERS = new Set(['+', '-', '@']);" }], test: T('ErrorCsvTemplates'), expect: ['prefixes a quote to', 'NEUTRALISES formula-injection payloads'] },
  { id: 'C48', rule: 'error-CSV cells starting with TAB or CR are neutralised', file: 'errorCsv.ts', edits: [{ find: "let dangerous = first === '\\t' || first === '\\r';", replace: 'let dangerous = false;' }], test: T('ErrorCsvTemplates'), expect: ['prefixes a quote to'] },
  { id: 'C49', rule: 'error-CSV cells are length-capped', file: 'errorCsv.ts', edits: [{ find: 'export const MAX_CELL_CHARS = 500;', replace: 'export const MAX_CELL_CHARS = 500000;' }], test: T('ErrorCsvTemplates'), expect: ['caps a cell at 500 characters', 'never emits a cell longer than 500'] },
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
  const dir = mkdtempSync(path.join(tmpdir(), 'bench1-nc-'));
  const outFile = path.join(dir, 'result.json');
  try {
    const res = spawnSync('npx', ['vitest', 'run', testFile, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!existsSync(outFile)) {
      return { ran: false, failed: [], total: 0, passed: 0, note: `vitest produced no JSON (exit ${res.status}): ${(res.stderr || '').slice(-400)}` };
    }
    const json = JSON.parse(readFileSync(outFile, 'utf8'));
    const failed = [];
    for (const f of json.testResults ?? []) {
      for (const a of f.assertionResults ?? []) {
        if (a.status === 'failed') failed.push(a.fullName || a.title);
      }
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
const baseline = {};
for (const testFile of [...new Set(controls.map((c) => c.test))]) {
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
  const abs = path.join(ROOT, SRC, c.file);
  const original = readFileSync(abs);
  const originalHash = sha(original);
  let text = original.toString('utf8');
  const entry = { id: c.id, rule: c.rule, mutatedFile: SRC + c.file, edits: c.edits, testFile: c.test, expectedNamedFailures: c.expect, failingTests: [], namedFailingTests: [], demonstrated: false, restoredByteExact: false, note: '' };
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
    const r = runVitest(c.test);
    entry.ranVitest = r.ran;
    entry.failingTests = r.failed;
    entry.note = r.note;
    entry.namedFailingTests = r.failed.filter((name) => c.expect.some((s) => name.toLowerCase().includes(s.toLowerCase())));
    entry.demonstrated = r.ran && entry.namedFailingTests.length > 0;
  } finally {
    writeFileSync(abs, original);
    restoreNow = null;
    const after = sha(readFileSync(abs));
    entry.restoredByteExact = after === originalHash;
    if (!entry.restoredByteExact) {
      console.error(`FATAL: ${c.file} was NOT restored byte-exactly (${originalHash} != ${after})`);
      process.exitCode = 3;
    }
  }
  results.push(entry);
  console.log(`${c.id} ${entry.demonstrated ? 'DEMONSTRATED' : 'NOT DEMONSTRATED'} -- ${c.rule} -- named failing: ${entry.namedFailingTests.length}, total failing: ${entry.failingTests.length}`);
}

// Final byte-exact check of every touched file against git HEAD-independent hashes is impossible here;
// the per-control hash comparison above is the proof. Write the evidence file.
mkdirSync(path.dirname(OUT), { recursive: true });
const summary = {
  controls: results.length,
  demonstrated: results.filter((r) => r.demonstrated).length,
  notDemonstrated: results.filter((r) => !r.demonstrated).map((r) => r.id),
  allRestoredByteExact: results.every((r) => r.restoredByteExact),
};
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      validatorVersion: 'bench1-file-validator-v1',
      method: 'one tiny mutation per rule; the matching vitest file must FAIL at least one NAMED test; source restored byte-exactly and verified by SHA-256',
      baseline,
      summary,
      // Each entry: {rule, mutatedFile, failingTests[]} plus the mutation and verdict.
      controls: results.map(({ rule, mutatedFile, failingTests, ...rest }) => ({ rule, mutatedFile, failingTests, ...rest })),
    },
    null,
    2,
  ) + '\n',
);
console.log(`\n${summary.demonstrated}/${summary.controls} controls demonstrated; restore byte-exact: ${summary.allRestoredByteExact}`);
console.log(`evidence: ${path.relative(ROOT, OUT)}`);
if (summary.notDemonstrated.length > 0 || !summary.allRestoredByteExact) process.exitCode = process.exitCode || 1;
