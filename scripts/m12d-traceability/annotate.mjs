// M12D — add Product-Owner requirement ids to the suites that actually prove them.
// Every id below was checked against the file's real assertions in this phase.
// Ids a suite only touches incidentally are deliberately NOT listed, and where a
// suite does NOT discharge a neighbouring requirement that is said so explicitly.
import fs from 'fs';
import path from 'path';

const REPO = process.argv[2];

const ANN = {
  'tests/live-dev/aieM3InvestmentDispatchLiveDev.test.ts': [
    ['AIE10-QA-02', 'Create a proof that deterministic route makes zero provider calls — L1 asserts aiWasUsed=false against real DEV infrastructure.'],
    ['AIE10-QA-09', 'Create a proof that deletion racing with processing cannot resurrect data — L4 (delete, independently verify absent, then record), L5 (TTL fires on age alone on a NON-terminal run), L6 (negative control: a row inside TTL survives the same sweep).'],
    ['AIE11-DEV-02', 'Process a deterministic-complete synthetic PDF and prove zero provider calls.'],
    ['AIE12-LIVE-02', 'Process a known deterministic native-text investment statement with zero provider calls.'],
    ['AIE12-LIVE-12', 'Delete all synthetic users/documents/artifacts/items/canonical rows and independently verify zero residue — 8 tables re-queried, both runs.'],
  ],
  'tests/live-dev/aieM2RealProviderProof.live.test.ts': [
    ['AIE10-QA-03', 'Create a proof that seeded PII is removed before a captured provider-bound payload — 7 PII sentinels asserted absent pre-egress against the REAL provider.'],
    ['AIE11-GW-01', 'Expose one typed internal extraction operation; no public/browser provider endpoint — asserted by instanceof OpenAiAieProvider and NOT MockAieProvider through the real gateway.'],
    ['AIE16-MASK-06', 'Capture exact provider-bound payloads in the certification environment.'],
  ],
  'tests/unit/aiePiiMasking.test.ts': [
    ['AIE10-MASK-01', 'Typed placeholder vocabulary for person, address, account, card, member/tax ID, email, phone, employer.'],
    ['AIE10-MASK-09', 'Fail-closed masking admission threshold. NOTE: isBelowMaskingPolicy is tested here but is INERT in production — its only caller passes labelsSeenRaw: [] pending PO-BLOCKER-3.'],
    ['AIE11-PII-02', 'Typed detection for person, address, account, card, member/tax id, email, phone and employer.'],
    ['AIE11-PII-05', 'Document-local placeholder scope by default.'],
  ],
  'tests/unit/aieIdentifierTokenOneWay.test.ts': [
    ['AIE10-MASK-03', 'Collision resistance — two distinct people/accounts cannot share a token within a reconciliation scope.'],
    ['AIE10-MASK-04', 'Reversible versus irreversible masking. Resolved by PO-BLOCKER-2 in favour of one-way HMAC; the reversible escrow was DELETED, so there are no reversible maps to key-separate.'],
    ['AIE11-PII-06', 'Collision-resistant tokens preventing cross-user correlation — the same folio under two users yields two different tokens, and an untenanted call throws.'],
  ],
  'tests/unit/aieStateMachine.test.ts': [
    ['AIE11-FSM-06', 'Enforce allowed transitions server-side rather than trusting UI sequence.'],
    ['AIE11-FSM-12', 'Test every legal transition and representative illegal transitions.'],
  ],
  'tests/unit/aieCostAdmissionPglitePostgresProof.test.ts': [
    ['AIE10-QA-05', 'Create a proof that repeated jobs collapse to one provider attempt — on real Postgres, seeded from the repository\'s own full migration chain.'],
    ['AIE11-CST-05', 'Collapse concurrent identical calls under one idempotency identity.'],
    ['AIE16-IDEM-11', 'Verify one provider charge/decision/write and immutable conflict outcomes.'],
  ],
  'tests/unit/aiePc5ExceptionInterface.test.ts': [
    ['AIE10-QA-06', 'Create a proof that PC5 can consume and resolve one synthetic AIE ownership item.'],
    ['AIE10-EXC-08', 'Governed read/query API or DB view — listUnresolvedItemsForPc5 is capability-gated and delegates to AIE\'s own repository read.'],
    ['AIE10-EXC-09', 'PC5 cannot mutate statuses directly — every status change PC5 causes goes through AIE\'s own version-checked, idempotency-keyed gate.'],
    ['AIE10-EXC-10', 'No separate PC5 exception tables/counters/review UI unless projections over AIE truth — newStatus is typed to the literal \'in_review\' only.'],
    ['AIE15-PC5-01', 'Expose a governed AIE query/view for ownership and reconciliation reason families.'],
  ],
  'tests/unit/m12aFdhBankAccuracyCorpus.test.ts': [
    ['AIE13-AI-06', 'Forbid AI invention of missing transactions, balances, dates, signs, account identity or currency — unreadable rows are REPORTED as unreadable, never guessed.'],
    ['AIE13-MET-12', 'Measure false-clean rate and predeclare thresholds by certified adapter — measured NON-ZERO (20.00% false accept, 8.33% false canonical write), fixed, re-measured 0.00%/0.00%.'],
    ['AIE16-FDH-03', 'Measure transaction row recall/precision — 100.00% field precision and recall (215/215) across 12 documents.'],
    ['AIE16-FDH-07', 'Measure opening, closing and running-balance exactness.'],
    ['AIE16-FDH-10', 'Seed omitted/duplicated row, wrong sign and decimal-shift errors and prove blocking — FDH-A06/A08/A11.'],
    ['AIE13-MET-10', 'NOT discharged here. Evidence-coordinate correctness cannot be measured: the parser bridge reports sourcePage: 1 for every row (M12A-O2).'],
  ],
  'tests/unit/m12bInsuranceAccuracyCorpus.test.ts': [
    ['AIE14-INS-10', 'Create identity/ownership/coverage-date/value exceptions rather than guessing — and, after M12B-F4/F5, make that silence VISIBLE rather than silent.'],
    ['AIE14-TEST-11', 'Insurance accuracy measurement — 100.00% field precision and recall (169/169) across 14 documents.'],
    ['AIE16-OTH-01', 'Measure Insurance policy owner/insured/cover/premium/date extraction and reconciliation.'],
    ['AIE14-TEST-12', 'Document fixture provenance, coverage gaps and limitations — only ONE bounded generic Label:Value layout is certified; no real insurer PDF has ever been sourced.'],
  ],
  'tests/unit/m12bAiPrivacyProof.test.ts': [
    ['AIE10-QA-03', 'Create a proof that seeded PII is removed before a captured provider-bound payload — measured on the real provider\'s own outbound HTTP body, with only the network substituted.'],
    ['AIE11-PII-11', 'Prevent raw/masked mapping from appearing in errors, logs, traces or analytics.'],
    ['AIE16-MASK-05', 'Measure masking recall and precision by PII class — this measurement FOUND a genuine pre-egress leak (M12B-F1).'],
    ['AIE16-MASK-06', 'Capture exact provider-bound payloads in the certification environment.'],
    ['AIE16-MASK-08', 'Verify raw identifiers and reversible token maps are absent from prohibited surfaces.'],
  ],
  'tests/unit/m12aFdhBankIntakeGate.test.ts': [
    ['AIE13-IMPORT-02', 'Validate tenant, account, accepted run version and reconciliation status server-side.'],
    ['AIE13-IMPORT-12', 'Prevent direct AIE/AI writes to transaction tables outside this service — M2-OPEN-6 reproduced RED, then the inline intake-time write was removed along with its import.'],
    ['AIE16-ATOM-08', 'Verify every canonical record links to AIE document/run/decision/write batch.'],
  ],
  'tests/unit/aieM2PromptInjection.test.ts': [
    ['AIE10-AI-05', 'Prompt templates treat document content as hostile evidence and ignore embedded instructions.'],
    ['AIE10-SEC-03', 'Model prompt injection in visible text, metadata, white-on-white text and table cells.'],
    ['AIE16-INJ-01', 'Place instruction injection in visible document text.'],
    ['AIE16-INJ-10', 'Verify no arbitrary tool/network action is available to extraction calls — no tools or functions are ever sent to the model, and the only fetch in lib/aie is a hardcoded module-level constant.'],
  ],
  'tests/unit/aieFileValidation.test.ts': [
    ['AIE11-QUA-02', 'Validate declared MIME, extension, magic bytes and parser recognition independently.'],
    ['AIE11-QUA-04', 'Reject PDF JavaScript, launch actions, embedded executables — including inside deflate-compressed streams.'],
    ['AIE11-QUA-05', 'Detect polyglot files and suspicious trailing content after %%EOF.'],
    ['AIE11-QUA-06', 'Decompression, object count, nesting and page limits.'],
    ['AIE16-PDF-01', 'Test MIME spoof and extension mismatch.'],
    ['AIE16-PDF-04', 'Test embedded JavaScript, launch actions, files and executable content.'],
  ],
  'tests/unit/aiePurgeService.test.ts': [
    ['AIE10-QA-09', 'Create a proof that deletion racing with processing cannot resurrect data — the delete/verify-absent/record ORDER is asserted by source position so a reordering fails the test.'],
    ['AIE16-RET-06', 'Delete a document in every processing/review/write state.'],
  ],
  'tests/unit/aieSchemaRegistry.test.ts': [
    ['AIE10-QA-01', 'Create contract tests for example envelopes and strict schema behaviour.'],
    ['AIE10-SCH-10', 'Default to rejecting additional JSON properties.'],
    ['AIE11-JSC-01', 'Publish immutable schema versions with owner, adapter compatibility and status — the registry throws rather than guessing on an unknown schema.'],
  ],
  'tests/unit/aieReviewAriaLabels.test.ts': [
    ['AIE15-A11Y-03', 'Associate every input, error, help text and unit/currency label.'],
  ],
  'tests/unit/aieGuardDutyScanResultHandler.test.ts': [
    ['AIE11-QUA-03', 'Malware scanning with signature/version recorded, failing closed on scanner failure. IMPORTANT: this suite proves the DECISION FUNCTION only — it has zero production callers and no scanner exists (PO-BLOCKER-1 / OA-2a).'],
    ['AIE16-PDF-08', 'Verify malware scanner failure is fail-closed according to policy — proven in isolation, never in a live pipeline.'],
  ],
  'tests/unit/m12cCostRetryAccounting.test.ts': [
    ['AIE10-AI-11', 'Store provider/model/template/schema versions and token/cost totals without prohibited payload content.'],
    ['AIE16-COST-03', 'Measure AI input/output tokens, calls, RETRIES/REPAIRS and cost — M2-OPEN-5 was an all-attempts-fail sequence settling ZERO tokens after up to three real HTTP requests.'],
  ],
  'tests/unit/m12cServerOnlySecretBoundary.test.ts': [
    ['AIE10-TRUST-04', 'Identify service-role credentials and reduce each to least privilege.'],
    ['AIE16-CFG-03', 'Inventory provider/OCR/storage/queue/database secrets without exposing their values.'],
    ['AIE16-CFG-04', 'Verify secrets are environment-scoped and unavailable to browser bundles — proven by a value-import graph walk from every \'use client\' component. CONDITIONAL: the canonical server-only package is not installed, so there is no build-time error (M12C-O4).'],
  ],
  'tests/unit/m12cMultilineAddressMasking.test.ts': [
    ['AIE10-MASK-06', 'Handle identifiers split across spans, table cells, headers/footers and repeated pages.'],
    ['AIE10-MASK-07', 'Mask free-text narration and counterparties without destroying the debit/credit/table structure needed for extraction.'],
    ['AIE11-PII-04', 'Detect identifiers split across spans, lines, table cells and OCR tokens.'],
    ['AIE11-PII-09', 'Mask free-text narration/counterparties according to policy without destroying requested layout.'],
  ],
  'tests/unit/aieIiAdapterProhibitions.test.ts': [
    ['AIE10-AI-02', 'Prohibited uses: identity adjudication, ownership invention, security-master creation, undocumented FX, reconciliation override.'],
    ['AIE12-WRITE-01', 'Use one domain-owned atomic import service, not direct scattered table writes — asserted as an executable guard, not a convention.'],
  ],
  'scripts/m12c_pc5_accessibility_live_dev.ts': [
    ['AIE15-A11Y-01', 'Semantic headings, landmarks and one clear page title — axe wcag2a+wcag2aa, 0 violations across all seven states.'],
    ['AIE15-A11Y-02', 'Logical keyboard focus order — 37 tab stops, monotonic DOM order, reaching "Save this answer".'],
    ['AIE15-A11Y-06', 'Announce processing/rechecking/success/failure through live regions — verified against a REAL API failure surfacing in role="alert".'],
    ['AIE16-REV-10', 'Test WCAG conformance.'],
    ['AIE15-A11Y-08', 'NOT discharged here. color-contrast returned INCOMPLETE (needs human review) on all seven states (M12C-O12).'],
    ['AIE15-A11Y-12', 'NOT discharged here. No screen reader is installed or drivable in this environment; live-region behaviour was verified programmatically, which is not the same thing.'],
  ],
  'scripts/aiecl_masking_before_egress_live_dev_check.ts': [
    ['AIE10-QA-03', 'Create a proof that seeded PII is removed before a captured provider-bound payload.'],
    ['AIE11-PII-01', 'Run masking after local extraction and before any provider payload builder.'],
    ['AIE16-MASK-06', 'Capture exact provider-bound payloads in the certification environment.'],
  ],
  'scripts/aiecl_review_route_cross_tenant_live_dev_check.ts': [
    ['AIE10-QA-08', 'Create a proof that cross-tenant status/evidence access fails closed.'],
    ['AIE10-SEC-05', 'Model cross-tenant IDOR across upload, status, preview, evidence, decision, cancel and delete.'],
    ['AIE16-AUTH-02', 'Test user A access to user B identifiers across every route.'],
  ],
  'scripts/aiecl_0152_cost_idempotency_live_dev_verify.mjs': [
    ['AIE10-QA-05', 'Create a proof that repeated jobs collapse to one provider attempt — live, against real DEV.'],
    ['AIE16-IDEM-11', 'Verify one provider charge/decision/write and immutable conflict outcomes.'],
  ],
  'scripts/aiecl_pc5_interface_live_dev_check.ts': [
    ['AIE10-QA-06', 'Create a proof that PC5 can consume and resolve one synthetic AIE ownership item.'],
    ['AIE16-PC5-01', 'Search code, migrations, routes and UI for competing active PC5 exception storage.'],
  ],
  'scripts/m12c_pc4_synthetic_pack_live_dev.ts': [
    ['AIE10-QA-09', 'Create a proof that deletion racing with processing cannot resurrect data — S10 re-queried 26 tables and 11 storage objects to zero against a pre-cleanup control of 204 rows.'],
    ['AIE12-LIVE-12', 'Delete all synthetic users/documents/artifacts/items/canonical rows and independently verify zero residue.'],
    ['AIE16-RET-06', 'Delete a document in every processing/review/write state.'],
  ],
};

const HEAD = (rows) => {
  const lines = [
    '/**',
    ' * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.',
    ' *',
    ' * Added by the M12 Phase D mapping pass. Each id below was checked against this',
    ' * file\'s ACTUAL assertions; ids it only touches incidentally are deliberately',
    ' * omitted, and where this file does NOT discharge a neighbouring requirement,',
    ' * that is said so explicitly rather than left to be assumed.',
    ' * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md',
    ' *',
  ];
  for (const [id, gloss] of rows) {
    const wrapped = gloss.match(/.{1,66}(\s|$)/g) || [gloss];
    lines.push(` *   ${id.padEnd(16)} ${wrapped[0].trim()}`);
    for (const w of wrapped.slice(1)) lines.push(` *   ${' '.repeat(16)} ${w.trim()}`);
  }
  lines.push(' */');
  return lines.join('\n') + '\n';
};

let files = 0, ids = 0;
for (const [rel, rows] of Object.entries(ANN)) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) { console.error('MISSING', rel); process.exit(1); }
  const cur = fs.readFileSync(abs, 'utf8');
  if (cur.includes('M12D TRACEABILITY')) { console.error('already annotated', rel); continue; }
  fs.writeFileSync(abs, HEAD(rows) + cur);
  files++; ids += rows.length;
}
console.log(JSON.stringify({ filesAnnotated: files, idCitationsAdded: ids }, null, 1));
