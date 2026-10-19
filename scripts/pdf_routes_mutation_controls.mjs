/**
 * MUTATION-SENSITIVE NEGATIVE CONTROLS for the PDF routes (docs/ai/pdf_routes_liab_ret_auinv/).
 *
 * A green test is indistinguishable from a test that never applied, so each guard below is REMOVED in turn (one source line changed), the
 * named test file is run, and the control is accepted only if a test whose name matches the expected pattern FAILS. The source is restored
 * in a finally block (and from a saved copy if the process is interrupted). The mutations are never committed.
 *
 *   node scripts/pdf_routes_mutation_controls.mjs [--only=M3,M7]
 *
 * Writes docs/ai/pdf_routes_liab_ret_auinv/MUTATION_CONTROLS_RESULT.md and .json. Takes about 10 minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const R = (p) => path.join(root, p);

const LIAB_SVC = 'lib/financial-data-hub/services/liabilityStatementProcessingService.ts';
const LIAB_ROUTE = 'app/api/financial-data-hub/liability-statement/upload/route.ts';
const LIAB_READER = 'lib/financial-data-hub/liability/pdfStatement.ts';
const RET_SVC = 'lib/financial-data-hub/services/retirementStatementProcessingService.ts';
const INV_SVC = 'lib/financial-data-hub/services/investmentStatementProcessingService.ts';
const CLASSIFY = 'lib/financial-data-hub/pdf-statements/classify.ts';
const MASKING = 'lib/aie/masking/piiMasking.ts';
const CORPUS = 'scripts/pdf_routes_corpus.ts';

const T_SVC = 'tests/unit/pdfRoutesServices.test.ts';
const T_ROUTE = 'tests/unit/pdfRoutesRoutes.test.ts';
const T_LR = 'tests/unit/pdfLiabilityReader.test.ts';
const T_CORPUS = 'tests/unit/pdfRoutesCorpus.test.ts';
const T_MASK = 'tests/unit/pdfRoutesMasking.test.ts';

const MUTATIONS = [
  { id: 'M1', what: 'Premium guard removed from the liability upload route', file: LIAB_ROUTE, find: '  if (importDenied) return importDenied;', replace: '  /* mutated: premium guard removed */', tests: [T_ROUTE], expect: /Free/ },
  { id: 'M2', what: 'PDF switch check removed from the liability upload route', file: LIAB_ROUTE, find: 'if (isPdf && !isLiabilityPdfRouteEnabled()) return bad(PDF_ROUTE_DISABLED_MESSAGE, 403);', replace: 'if (false) return bad(PDF_ROUTE_DISABLED_MESSAGE, 403);', tests: [T_ROUTE], expect: /switch OFF|literal/ },
  { id: 'M3', what: 'PDF switch check removed from the liability service (the guard behind the route)', file: LIAB_SVC, find: 'if (isPdf && !isLiabilityPdfRouteEnabled()) {', replace: 'if (false) {', tests: [T_SVC], expect: /switch off|literal/ },
  { id: 'M4', what: 'document-class check removed from the liability reader (a bank statement is no longer refused)', file: LIAB_READER, find: "if (!checkLiabilityClass(text.text, statementType).ok) return pdfFailure('not_this_class');", replace: '/* mutated: class check removed */', tests: [T_LR, T_SVC], expect: /LB-08|not this class|negative/ },
  { id: 'M5', what: 'AI eligibility widened (every refusal now reaches the model)', file: LIAB_SVC, find: 'if (!isAiEligiblePdfFailure(read.kind)) return refuseLiabilityPdf(userId, document, read.kind);', replace: '/* mutated: eligibility check removed */', tests: [T_SVC], expect: /NO model call|LB-08|LB-05|refused/ },
  { id: 'M6', what: 'strictness removed from the liability reader (an unreadable line is silently dropped)', file: LIAB_READER, find: '  if (unread > 0) return pdfFailure(', replace: '  if (false) return pdfFailure(', tests: [T_LR], expect: /LB-07|unread/ },
  { id: 'M7', what: 'summary-line exclusion removed from the liability reader (totals become activities)', file: LIAB_READER, find: 'if (SUMMARY_DESC_RE.test(lead.rest))', replace: 'if (false && SUMMARY_DESC_RE.test(lead.rest))', tests: [T_LR, T_SVC], expect: /LB-06/ },
  { id: 'M8', what: 'provenance guard removed (an invented AI line is kept)', file: LIAB_SVC, find: "if (mapped && sourceFormat === 'pdf') {", replace: "if (false && mapped && sourceFormat === 'pdf') {", tests: [T_SVC], expect: /INVENTED/ },
  { id: 'M9', what: 'deletion after durable evidence removed', file: LIAB_SVC, find: '  await purgeRawPdfAfterDurableEvidence(userId, document.id);', replace: '  /* mutated: no purge after evidence */', tests: [T_SVC], expect: /LB-01|original is deleted|clean/ },
  { id: 'M10', what: 'deletion after a refusal removed', file: LIAB_SVC, find: '  await purgeRawPdfAfterRefusal(userId, document.id);', replace: '  /* mutated: no purge after refusal */', tests: [T_SVC], expect: /original deleted|refused/ },
  { id: 'M11', what: 'deletion after a durable draft removed', file: LIAB_SVC, find: '      await purgeRawPdfAfterDurableDraft(userId, document.id);', replace: '      /* mutated: no purge after draft */', tests: [T_SVC], expect: /deleted while the draft is pending|LB-03/ },
  { id: 'M12', what: 'PDF review policy removed from the retirement writer (a wrong-on-the-page statement needs no review)', file: RET_SVC, find: "(!fromPdf || (reconciliation.status === 'reconciled' && ex.warnings.length === 0))", replace: 'true', tests: [T_SVC], expect: /RT-04|RT-03/ },
  { id: 'M13', what: 'line-check variance override removed from the investment writer', file: INV_SVC, find: "const reconciliationStatus = (params.lineChecksFailed ?? 0) > 0 ? 'variance' : totals.status;", replace: 'const reconciliationStatus = totals.status;', tests: [T_SVC], expect: /STILL add up|line check/ },
  { id: 'M14', what: 'printed-total tie removed from the AI investment confirm', file: INV_SVC, find: 'closingPortfolioValue: pdfDraft?.printedTotals?.closingPortfolioValue ?? undefined,', replace: 'closingPortfolioValue: undefined,', tests: [T_SVC], expect: /AI-03/ },
  { id: 'M15', what: 'a hand-computed corpus figure is wrong (LB-01 printed closing 1,407.90 instead of 1,407.80)', file: CORPUS, find: 'printedClosing: 1407.8, closingByLines: 1407.8,', replace: 'printedClosing: 1407.9, closingByLines: 1407.8,', tests: [T_CORPUS], expect: /LB-01/ },
  { id: 'M16', what: 'class-signal threshold lowered to zero', file: CLASSIFY, find: 'export const MIN_CLASS_SIGNALS = 2;', replace: 'export const MIN_CLASS_SIGNALS = 0;', tests: [T_LR, T_SVC], expect: /LB-08|not this class|negative/ },
  { id: 'M17', what: 'multiple-account check removed from the liability reader', file: LIAB_READER, find: 'if (identifiers.size >= 2 && openingLabels >= 2) return', replace: 'if (false && identifiers.size >= 2 && openingLabels >= 2) return', tests: [T_LR, T_SVC], expect: /LB-05|two accounts|multiple/ },
  { id: 'M18', what: 'password check removed from the liability PDF resolver (a protected file is downloaded)', file: LIAB_SVC, find: "if (document.error_code === 'password_required') return refuseLiabilityPdf(userId, document, 'password_required');", replace: '/* mutated: password check removed */', tests: [T_SVC], expect: /password/ },
  { id: 'M19', what: 'cardholder label removed from the masking rule (a cardholder name reaches the model)', file: MASKING, find: String.raw`|client|card[^\S\r\n]*holder|cardholder)(?:[^\S\r\n]*name)?`, replace: String.raw`|client)(?:[^\S\r\n]*name)?`, tests: [T_MASK], expect: /LB-03/ },
  { id: 'M20', what: 'masking of the broker account-holder line removed', file: MASKING, find: String.raw`/^([^\S\r\n]*account[^\S\r\n]*:[^\S\r\n]*)((?!(?:HIN|SRN)\b)`, replace: String.raw`/^([^\S\r\n]*accountXX[^\S\r\n]*:[^\S\r\n]*)((?!(?:HIN|SRN)\b)`, tests: [T_MASK], expect: /AI-01|AI-02/ },
];

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const results = [];
const saved = new Map();

function restoreAll() {
  for (const [file, text] of saved) fs.writeFileSync(R(file), text);
  saved.clear();
}
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

for (const m of MUTATIONS) {
  if (only.length && !only.includes(m.id)) continue;
  const original = fs.readFileSync(R(m.file), 'utf8');
  if (!original.includes(m.find)) {
    results.push({ ...m, expect: String(m.expect), outcome: 'MUTATION NOT APPLICABLE (source line changed)', killed: false });
    console.log(`${m.id}: NOT APPLICABLE`);
    continue;
  }
  saved.set(m.file, original);
  fs.writeFileSync(R(m.file), original.replace(m.find, m.replace));
  const out = path.join(root, `.mutation-${m.id}.json`);
  try {
    spawnSync('npx', ['vitest', 'run', ...m.tests, '--reporter=json', `--outputFile=${out}`, '--testTimeout=120000'], { cwd: root, shell: true, encoding: 'utf8', timeout: 600000 });
    let failed = [];
    if (fs.existsSync(out)) {
      const json = JSON.parse(fs.readFileSync(out, 'utf8'));
      for (const f of json.testResults ?? []) for (const t of f.assertionResults ?? []) if (t.status === 'failed') failed.push(t.fullName);
    }
    const matched = failed.filter((n) => m.expect.test(n));
    results.push({ id: m.id, what: m.what, file: m.file, tests: m.tests, expect: String(m.expect), failedCount: failed.length, matchedFailures: matched.slice(0, 3), killed: matched.length > 0 });
    console.log(`${m.id}: ${matched.length > 0 ? 'KILLED' : 'SURVIVED'} (${failed.length} failing; ${matched.length} matching)`);
  } finally {
    fs.writeFileSync(R(m.file), original);
    saved.delete(m.file);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
}

const dir = R('docs/ai/pdf_routes_liab_ret_auinv');
fs.writeFileSync(path.join(dir, 'MUTATION_CONTROLS_RESULT.json'), JSON.stringify(results, null, 2) + '\n');
const lines = ['# Mutation-sensitive negative controls: result', '', 'Each row removes ONE guard (a single source line), runs the named test file, and is accepted only if a test matching the expected pattern FAILS. The source was restored after every run (`git diff` is empty for these files). Evidence label: UNIT-TESTED.', '', '| Id | Guard removed | Test file(s) | Failing tests | Matching the expectation | Verdict |', '|---|---|---|---|---|---|'];
for (const r of results) lines.push(`| ${r.id} | ${r.what} | ${(r.tests ?? []).join(', ')} | ${r.failedCount ?? '-'} | ${(r.matchedFailures ?? []).map((x) => x.slice(0, 80)).join('; ') || '-'} | ${r.killed ? 'KILLED (the test proves the guard)' : 'SURVIVED / NOT APPLICABLE'} |`);
lines.push('', `Killed: ${results.filter((r) => r.killed).length} of ${results.length}.`);
fs.writeFileSync(path.join(dir, 'MUTATION_CONTROLS_RESULT.md'), lines.join('\n') + '\n');
process.exit(results.every((r) => r.killed) ? 0 : 1);
