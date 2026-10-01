// BENCH-1 Phase 2 - NEGATIVE CONTROLS for the TypeScript governance / entitlement / scheduling / route rules.
//
// For each rule: break ONE line of the source, run the named vitest file, record which tests FAIL, then restore
// the file BYTE-EXACTLY (hash-verified, try/finally). A control that makes no named test fail is reported as
// NOT DEMONSTRATED (the test is too weak). Output: docs/investment-intelligence/evidence/bench1_phase2/core_negative_controls.json
//
// Run (one control at a time; the machine is slow):  node scripts/bench1_core_negative_controls.mjs [ruleIdPrefix]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/investment-intelligence/evidence/bench1_phase2/core_negative_controls.json');
const BD = 'lib/services/investment-intelligence/benchmarkData';
const T = {
  ent: 'tests/unit/benchmarkDataEntitlements.test.ts',
  ing: 'tests/unit/benchmarkDataIngestion.test.ts',
  api: 'tests/unit/benchmarkDataAdminRoutes.test.ts',
};

const CONTROLS = [
  { id: 'ENT-01', rule: 'a draft or revoked entitlement grants nothing', file: `${BD}/entitlements.ts`, find: "if (e.status !== 'approved') return false;", replace: '', test: T.ent },
  { id: 'ENT-02', rule: 'the variant must equal the catalogue variant (a price entitlement is not a TRI entitlement)', file: `${BD}/entitlements.ts`, find: 'e.returnVariant === identity.returnVariant &&', replace: '', test: T.ent },
  { id: 'ENT-03', rule: 'post-expiry retention never applies before the term starts', file: `${BD}/entitlements.ts`, find: "e.postExpiryStorage === 'retain' && e.validTo !== null && on > e.validTo", replace: "e.postExpiryStorage === 'retain'", test: T.ent },
  { id: 'ENT-04', rule: 'a customer-visible comparison needs the DISPLAY right as well as calculation', file: `${BD}/entitlements.ts`, find: "display_comparison: ['calculation', 'customer_display'],", replace: "display_comparison: ['calculation'],", test: T.ent },
  { id: 'ENT-05', rule: 'a manual-ingest licence is not automation permission', file: `${BD}/entitlements.ts`, find: "publish_automated: ['automation', 'storage'],", replace: "publish_automated: ['ingest_manual', 'storage'],", test: T.ent },
  { id: 'ENT-06', rule: 'data-date scope is enforced (a range outside the entitled range is refused)', file: `${BD}/entitlements.ts`, find: '(q.dataFrom == null || e.dataFrom === null || q.dataFrom >= e.dataFrom) &&', replace: '', test: T.ent },
  { id: 'ACC-01', rule: 'consumer gate fails closed for an unknown benchmark', file: 'lib/services/investment-intelligence/benchmarkAccess.ts', find: 'if (!a) return false;', replace: 'if (!a) return true;', test: T.ent },
  { id: 'ACC-02', rule: 'an entitlement lookup failure blocks everything (never a partial grant)', file: 'lib/services/investment-intelligence/benchmarkAccess.ts', find: 'if (error) return { access: new Map(), error: error.message };', replace: 'if (error) return { access, error: null };', test: T.ent },
  { id: 'ACC-03', rule: 'series outside the entitled data-date scope are dropped', file: 'lib/services/investment-intelligence/benchmarkAccess.ts', find: 'return points.filter((p) => inDataScope(a, dateOf(p)));', replace: 'return [...points];', test: T.ent },
  { id: 'ING-01', rule: 'the global kill switch stops everything before any other read', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (!(await deps.isGlobalEnabled())) return { ...base, status:', replace: 'if (false) return { ...base, status:', test: T.ing },
  { id: 'ING-02', rule: 'the central entitlement (automation + storage) gates every run', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (!decision.allowed) {', replace: 'if (false) {', test: T.ing },
  { id: 'ING-03', rule: 'single-flight lease: an overlapping run is refused', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (!(await deps.claimLease(state.benchmarkId, deps.holderId, LEASE_TTL_SECONDS))) {', replace: 'if (false) {', test: T.ing },
  { id: 'ING-04', rule: 'the write kill switch makes a run a dry run (nothing written)', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (!writeEnabled) {', replace: 'if (false) {', test: T.ing },
  { id: 'ING-05', rule: 'HTTP 200 with no expected data is NOT success unless coverage is already complete', file: `${BD}/ingestion/orchestrator.ts`, find: "await finish(complete ? 'complete_no_new_data' : 'empty_response', complete, { httpStatus: outcome.httpStatus ?? 200 }, complete ?", replace: "await finish('complete_no_new_data', true, { httpStatus: outcome.httpStatus ?? 200 }, complete ?", test: T.ing },
  { id: 'ING-06', rule: 'a source refusal (403/captcha) stops the run (no probing of further benchmarks)', file: `${BD}/ingestion/orchestrator.ts`, find: "          blockedBySource = true;\n          await finish('blocked'", replace: "          await finish('blocked'", test: T.ing },
  { id: 'ING-07', rule: 'an implausible (>25%) value is never written', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (ref !== null && Math.abs(r.value / ref - 1) > FEED_OUTLIER_FRACTION) {', replace: 'if (false) {', test: T.ing },
  { id: 'ING-08', rule: 'manual-import benchmarks are never fetched', file: `${BD}/ingestion/orchestrator.ts`, find: "if (state.ingestionMode !== 'automated' || !state.automationEnabled || !state.adapterId) {", replace: 'if (false) {', test: T.ing },
  { id: 'ING-09', rule: 'the daily late-retry budget is bounded', file: `${BD}/ingestion/orchestrator.ts`, find: "if (opts.runKind === 'late_retry' && used >= DAILY_RETRY_BUDGET) {", replace: 'if (false) {', test: T.ing },
  { id: 'ING-10', rule: 'a backoff window is honoured', file: `${BD}/ingestion/orchestrator.ts`, find: 'if (state.nextAttemptNotBefore && state.nextAttemptNotBefore > deps.nowIso) {', replace: 'if (false) {', test: T.ing },
  { id: 'CAL-01', rule: 'gap tolerance is bounded (a long gap stops the completeness watermark)', file: `${BD}/ingestion/calendar.ts`, find: 'export const DEFAULT_MAX_TOLERABLE_GAP_WEEKDAYS = 3;', replace: 'export const DEFAULT_MAX_TOLERABLE_GAP_WEEKDAYS = 999;', test: T.ing },
  { id: 'PND-01', rule: 'a manual import becomes OVERDUE past the threshold', file: `${BD}/ingestion/pending.ts`, find: "behind === 0 ? 'current' : behind > overdueAfter ? 'overdue' : 'due'", replace: "behind === 0 ? 'current' : 'due'", test: T.ing },
  { id: 'PND-02', rule: 'a benchmark never imported is reported as never_imported (not current)', file: `${BD}/ingestion/pending.ts`, find: "status: 'never_imported',", replace: "status: 'current',", test: T.ing },
  { id: 'DEM-01', rule: 'only HELD schemes create benchmark demand (no full-universe backfill)', file: `${BD}/demand.ts`, find: 'if (!inst || !inst.held) continue;', replace: 'if (!inst) continue;', test: T.ing },
  { id: 'DEM-02', rule: 'mapping-effective periods bound the demand', file: `${BD}/demand.ts`, find: 'if (effEnd < engineStart) continue;', replace: '', test: T.ing },
  { id: 'ENV-01', rule: 'a DEV job cannot ingest into another project (environment ref guard)', file: `${BD}/ingestion/liveDeps.ts`, find: 'if (allowed !== actual) return', replace: 'if (false) return', test: T.ing },
  { id: 'API-01', rule: 'a CORRECTION publish needs the correct capability (not the publish capability)', file: 'app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/publish/route.ts', find: "const cap = (job as { mode: string }).mode === 'correction' ? 'correct' : 'publish';", replace: "const cap = 'publish';", test: T.api },
  { id: 'API-02', rule: 'the guard denies a caller lacking the capability', file: `${BD}/guards.ts`, find: "if (flags[cap] !== true) return { user: null, flags, forbidden: bad(`Benchmark data ${cap} access required`, 403) };", replace: '', test: T.api },
  { id: 'API-03', rule: 'unauthenticated callers get 401', file: `${BD}/guards.ts`, find: "if (unauthenticated || !user) return { user: null, flags, forbidden: bad('unauthenticated', 401) };", replace: '', test: T.api },
  { id: 'API-04', rule: 'a role-resolution error fails closed', file: `${BD}/guards.ts`, find: 'if (error || !data) return { user, flags: { ...NO_BENCHMARK_CAPABILITIES }, unauthenticated: false };', replace: "if (error || !data) return { user, flags: { upload: true, publish: true, correct: true, catalogue: true, entitlementApprove: true, view: true }, unauthenticated: false };", test: T.api },
  { id: 'API-05', rule: 'only a literal true is a grant', file: `${BD}/guards.ts`, find: 'const t = (k: string) => row[k] === true;', replace: 'const t = (k: string) => Boolean(row[k]);', test: T.api },
  { id: 'API-06', rule: 'a stale-preview refusal maps to 409 (never success)', file: `${BD}/publishService.ts`, find: "    case '40001':\n      return { status: 'failed', kind: 'stale', httpStatus: 409, message, code };", replace: "    case '40001':\n      return { status: 'failed', kind: 'stale', httpStatus: 200, message, code };", test: T.api },
  { id: 'API-07', rule: 'the rollback route requires the correct capability', file: 'app/api/admin/investment-intelligence/benchmark-data/jobs/[id]/rollback/route.ts', find: "guarded('correct')", replace: "guarded('upload')", test: T.api },
  { id: 'API-08', rule: 'entitlement approval is its own capability', file: 'app/api/admin/investment-intelligence/benchmark-data/entitlements/[id]/approve/route.ts', find: "guarded('entitlementApprove')", replace: "guarded('catalogue')", test: T.api },
];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const only = process.argv[2];
const results = fs.existsSync(OUT) && only ? JSON.parse(fs.readFileSync(OUT, 'utf8')).results ?? [] : [];

for (const c of CONTROLS.filter((x) => !only || x.id.startsWith(only))) {
  const abs = path.join(ROOT, c.file);
  const original = fs.readFileSync(abs);
  const before = sha(original);
  const text = original.toString('utf8');
  const entry = { id: c.id, rule: c.rule, mutatedFile: c.file, testFile: c.test, status: 'NOT_RUN', failingTests: [] };
  try {
    // The repository mixes CRLF and LF files: match either line-ending convention.
    const crlf = text.includes('\r\n');
    const find = crlf ? c.find.replace(/\n/g, '\r\n') : c.find;
    const replace = crlf ? c.replace.replace(/\n/g, '\r\n') : c.replace;
    if (!text.includes(find)) { entry.status = 'MUTATION_TARGET_NOT_FOUND'; }
    else {
      fs.writeFileSync(abs, text.replace(find, replace));
      const r = spawnSync('npx', ['vitest', 'run', c.test, '--reporter=json'], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
      const out = r.stdout ?? '';
      const start = out.indexOf('{');
      let failing = [];
      try {
        const j = JSON.parse(out.slice(start));
        for (const f of j.testResults) for (const a of f.assertionResults) if (a.status === 'failed') failing.push(a.fullName);
      } catch { entry.note = 'vitest json not parseable: ' + (r.stderr ?? '').slice(0, 200); }
      entry.failingTests = failing.slice(0, 12);
      entry.failingCount = failing.length;
      entry.status = failing.length > 0 ? 'DEMONSTRATED' : 'NOT_DEMONSTRATED';
    }
  } finally {
    fs.writeFileSync(abs, original);
    if (sha(fs.readFileSync(abs)) !== before) { console.error(`RESTORE FAILED for ${c.file}`); process.exit(3); }
  }
  const i = results.findIndex((x) => x.id === c.id);
  if (i >= 0) results[i] = entry; else results.push(entry);
  console.log(`${entry.status.padEnd(26)} ${c.id}  ${c.rule}  (${entry.failingCount ?? 0} failing: ${entry.failingTests[0] ?? '-'})`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedBy: 'scripts/bench1_core_negative_controls.mjs', note: 'One rule broken at a time; the named test file was run; the file was restored byte-exactly.', results }, null, 2));
}
const bad = results.filter((r) => r.status !== 'DEMONSTRATED');
console.log(`\n${results.length - bad.length}/${results.length} controls demonstrated`);
process.exit(bad.length ? 1 : 0);
