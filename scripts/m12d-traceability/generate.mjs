// M12D — generate the traceability matrix document.
import fs from 'fs';
import { FAM } from './families.mjs';
import { OVER } from './overrides.mjs';

const inv = JSON.parse(fs.readFileSync('inventory.json', 'utf8'));
const cites = JSON.parse(fs.readFileSync('citations.json', 'utf8'));

const STATUS_LABEL = {
  CODE: 'CODE', TEST: 'TEST', LIVEDEV: 'LIVE DEV', DECISION: 'DECISION',
  DEFERRED: 'DEFERRED', PROHIBITED: 'PROHIBITED', NA: 'NOT APPLICABLE',
  UNVERIFIED: 'UNVERIFIED',
};

function citeSummary(id) {
  const c = cites[id];
  if (!c) return null;
  // A citation inside a mission REPORT is not implementation evidence — it is
  // the mission talking about itself. Only artifact kinds count for grade A.
  const artifact = ['code', 'test', 'liveDev', 'migration', 'script'];
  const parts = [];
  for (const k of artifact) if (c[k]) parts.push(`${c[k][0]}`);
  if (parts.length) return { grade: 'artifact', refs: parts.slice(0, 2) };
  if (c.doc) return { grade: 'doc', refs: [c.doc[0]] };
  const short = artifact.concat('doc').map((k) => c[k + ':short']).filter(Boolean);
  if (short.length) return { grade: 'short', refs: [short[0][0]] };
  return null;
}

const rows = [];
const missingFam = new Set();
for (const r of inv) {
  const key = `${r.phase}/${r.family}`;
  const fam = FAM[key];
  if (!fam) { missingFam.add(key); continue; }
  const o = OVER[r.id];
  let [status, impl, test, live, grade, why] = o || fam;
  const cs = citeSummary(r.id);
  // A real, ID-specific citation upgrades the evidence grade — but only for
  // rows that are already claiming an artifact-backed status.
  let evidence;
  if (cs && cs.grade === 'artifact') {
    evidence = `id cited at ${cs.refs.join('; ')}`;
    if (['CODE', 'TEST', 'LIVEDEV'].includes(status) && grade === 'B') grade = 'A';
  } else if (cs && cs.grade === 'doc') {
    evidence = `id cited only in a mission report (${cs.refs[0]}) — not implementation evidence`;
  } else if (cs) {
    evidence = `short-form id cited at ${cs.refs[0]} (unambiguous family)`;
  } else {
    evidence = status === 'UNVERIFIED' ? 'none found' : 'family-level artifact (id not cited in repo)';
  }
  rows.push({ ...r, status, impl, test, live, grade, why, evidence });
}
if (missingFam.size) { console.error('MISSING FAMILY PROFILES:', [...missingFam]); process.exit(1); }

// ---- tallies ----
const byStatus = {}, byGrade = {}, byPhaseStatus = {};
for (const r of rows) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  byGrade[r.grade] = (byGrade[r.grade] || 0) + 1;
  byPhaseStatus[r.phase] = byPhaseStatus[r.phase] || {};
  byPhaseStatus[r.phase][r.status] = (byPhaseStatus[r.phase][r.status] || 0) + 1;
}
const total = rows.length;
const classified = total - (byStatus.UNVERIFIED || 0);

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ---- document ----
const out = [];
out.push(`# AIE-1 Requirement Traceability — FINAL

**Phase:** M12 Phase D (mission section 17 — "TRACEABILITY — MUST BE CLOSED")
**Date:** 2026-09-15 (authored 2026-09-16)
**Branch:** \`mission/m12d-traceability-2026-09-15\`
**Supersedes:** \`scripts/m5-aie-traceability-matrix.json\` and the L.3 verdict in
\`docs/investment-intelligence/AIE1_TERMINAL_CERTIFICATION_2026-09-15.md\` (\`M5-BLOCKER-1\`).

---

## 0. Read this before you read the table

### 0.1 The requirement universe is 2,284, not 2,214

Every prior phase of this mission has said **2,214**. That number came from
\`scripts/m5_aie_traceability_matrix.mjs\`, whose identifier regex is
\`/\\b[A-Z][A-Z0-9]{1,9}-[A-Z]{2,6}-[0-9]{2,3}\\b/\` — the middle segment is
**letters only**. Re-extracting from the Product Owner's own seven specification
files in \`C:\\Users\\user\\Downloads\\\` (read, never copied) by counting the
\`### <id> — <title>\` headings the documents actually use gives:

| Spec | File | Requirements |
|---|---|---|
| AIE-1.0 | \`AIE-1.0_Architecture_&_Privacy_Contract.md\` | 250 + 18 \`ADR-AIE-*\` register entries |
| AIE-1.1 | \`AIE-1.1_Shared_Preprocessing_Masking_and_JSON-Schema_Gateway (1).md\` | 332 |
| AIE-1.2 | \`AIE-1.2_Investment_Intelligence_Adapter.md\` | 346 |
| AIE-1.3 | \`AIE-1.3_FDH_Bank-Statement_Adapter.md\` | 346 |
| AIE-1.4 | \`AIE-1.4_Other_PDF-Enabled_FHIP_Modules.md\` | 286 |
| AIE-1.5 | \`AIE-1.5_User_Exception_Review_and_Acceptance_Integration.md\` | 346 |
| AIE-1.6 | \`AIE-1.6_Production_Cost_Security_and_Accuracy_Certification.md\` | 360 |
| | **Total** | **2,284** |

The old regex silently dropped **70 requirements** whose family segment contains a
digit — and they are not trivia:

| Family | Count | Why it matters |
|---|---|---|
| \`AIE10-PC6-01..10\` | 10 | The **binding PC6 exclusion contract** the scope ledger itself quotes. |
| \`AIE12-PC5-01..12\` | 12 | II adapter's PC5 consumption block. |
| \`AIE15-PC5-01..12\` | 12 | The **binding PC5 boundary contract** (\`AIE10-EXC-08/09/10\`'s implementation half). |
| \`AIE16-PC5-01..12\` | 12 | PC5 single-exception-system certification. |
| \`AIE16-PC6-01..12\` | 12 | PC6 separation certification. |
| \`AIE15-A11Y-01..12\` | 12 | Accessibility — the exact area M12C spent a whole section proving. |

It also counted 18 \`ADR-AIE-*\` rows, which are register entries for architecture
decision records rather than numbered requirements. They are retained here (they
are real deliverables the contract asks for) and classified honestly.

**So the denominator this phase reports against is 2,284.** A traceability pass
that discovered its own denominator was wrong, in the direction that makes its job
harder, is the correct outcome to report.

### 0.2 What the status column means

| Status | Meaning |
|---|---|
| **CODE** | A named, real source artifact in this repository implements it. |
| **TEST** | A named automated test exercises it. |
| **LIVE DEV** | A named live-DEV scenario or measured corpus run proves it against real infrastructure. |
| **DECISION** | Blocked on a **named** Product-Owner decision. Not a failure — a decision that has not been made. |
| **DEFERRED** | Deferred by a **named** decision or exclusion, with the reason quoted. |
| **PROHIBITED** | Excluded by a binding non-negotiable prohibition in the specification itself. |
| **NOT APPLICABLE** | Resolved by design so that the requirement has no subject. |
| **UNVERIFIED** | **Honest admission.** No artifact was found, and none is invented. |

\`UNVERIFIED\` is an eighth status the dispatch did not list. It exists because the
dispatch's own honesty requirement outranks its own target: *"if you cannot find
real evidence for a requirement, the honest classification is NOT APPLICABLE with
a stated reason, or an explicit note that it remains genuinely unverified, NOT a
fabricated CODE/TEST citation."* Calling "we never built an OCR subsystem" NOT
APPLICABLE would be a lie; calling it CODE would be a worse one.

### 0.3 What the evidence grade means — and why this matrix has one

A citation is not a conformance proof, and the previous pass said so. This one
grades every row:

| Grade | Meaning |
|---|---|
| **A** | The requirement ID is cited at a specific \`file:line\`, **and** that artifact demonstrably addresses this requirement's subject. |
| **B** | A named artifact was verified in this phase to implement or test this family's subject, but this individual member's conformance was not separately re-proved here. |
| **C** | A governed decision, deferral, prohibition or exclusion resolves it, and the decision is named and quoted. |
| **D** | No artifact found. Status is \`UNVERIFIED\`. |

**Grade B is the honest majority**, and the reader should treat it as *"this
requirement's subject is implemented and the implementing artifact is named"* —
not as *"this requirement was individually re-certified today."*

One worked example of why the distinction is load-bearing:
\`lib/aie/extraction/textExtraction.ts\` carries the header comment
\`"local/private native PDF text extraction (TXT-01..12)"\`. Reading the file — all
90 lines of it — shows it implements per-page text, page and character limits,
sparse-page detection and password/corrupt disambiguation, and does **not**
implement span offsets, bounding boxes, font/rotation hints, Unicode
normalisation, ligature handling or extractor versioning. This matrix therefore
credits \`AIE11-TXT-01/07/08/09\` and marks \`TXT-02/03/04/05/06/10/11\`
**UNVERIFIED**, against the file's own range citation. A matrix that honoured the
header would have scored twelve for twelve and meant nothing.

### 0.4 Grouping

Grouping is used at the **(phase, family)** level only, which is the
specifications' own structure — each family is one numbered section of 10–12
requirements on a single subject. Genuine equivalence across adapters is recorded
where it exists: the masking rule stated once per adapter in the specs is
implemented **once**, in \`lib/aie/masking/piiMasking.ts\`, and the M12C
masking-crash defect that affected all three adapters was fixed there once. Where
a family's members genuinely differ, they are split — ${Object.keys(OVER).length}
individual requirements carry their own adjudication rather than inheriting a
family verdict.

### 0.5 This phase added requirement ids to 27 real files — and grades its own additions

The dispatch asked for requirement ids to be added directly to tests and live-DEV
scenarios "wherever it costs little and adds real audit value". **91 id citations
were added across 27 files** (19 unit suites, 2 live-DEV suites, 6 live-DEV
verification scripts), each checked against that file's actual assertions, each glossed with
what it proves — and, in six places, with an explicit note that the file does
**not** discharge a neighbouring requirement (\`AIE13-MET-10\`, \`AIE15-A11Y-08\`,
\`AIE15-A11Y-12\`, and the GuardDuty suite's "decision function only, zero
production callers").

This closes \`M5-OPEN-4\`: **live-DEV requirement-id citations went from 0 to 22.**
Not one AIE requirement id had ever appeared in a \`tests/live-dev/\` suite before
this phase.

**Disclosure, because it would otherwise look circular.** Adding those ids raises
this matrix's own grade-A count, since grade A is partly earned by an ID being
cited at a real \`file:line\`. The honest numbers:

| | Grade A rows |
|---|---:|
| Before this phase's annotations | **201** |
| After | **${byGrade.A || 0}** |
| Delta attributable to this phase's own citations | **${(byGrade.A || 0) - 201}** |

Each of those ${(byGrade.A || 0) - 201} is a citation this phase wrote and verified. A reader who
regards self-added citations as weaker evidence should read the delta as grade B.

### 0.6 Requirements belonging to PC7, PC8, PC9 or PC10

**None.** The governing decisions instructed that any of the requirements
belonging to unapproved PC8/9/10 be classified DEFERRED with that exact reason
rather than orphaned. Checked: the seven AIE specification files define AIE-1.0
through AIE-1.6 only, and contain no PC8, PC9 or PC10 requirement. The
disclosure-licensing decisions \`PO-PC7-1\` and \`PO-PC7-2\` likewise govern PC7's
own Part O item set, not any of these 2,284. The PC6 decisions **do** reach into
this set, at \`AIE16-PC6-08\` and \`AIE10-PC6-10\`, and are recorded there.

---

## 1. Result

| | |
|---|---|
| Requirements in the Product Owner's specifications | **2,284** |
| Classified with a real, named, checkable basis | **${classified}** (${(classified / total * 100).toFixed(1)}%) |
| Honestly \`UNVERIFIED\` — no artifact exists, none invented | **${byStatus.UNVERIFIED || 0}** (${((byStatus.UNVERIFIED || 0) / total * 100).toFixed(1)}%) |
| **Orphan — unaccounted for entirely** | **0** |

Every one of the 2,284 has a row, a status and a stated reason. That is the sense
in which traceability is closed. It is **not** closed in the sense of
"2,284 requirements are implemented and proven" — ${byStatus.UNVERIFIED || 0} of them are
recorded as not evidenced at all, and the reasons are named.

### 1.1 By status

| Status | Count | Share |
|---|---:|---:|
${Object.entries(STATUS_LABEL).filter(([k]) => byStatus[k]).map(([k, v]) => `| ${v} | ${byStatus[k]} | ${(byStatus[k] / total * 100).toFixed(1)}% |`).join('\n')}
| **Total** | **${total}** | **100.0%** |

### 1.2 By evidence grade

| Grade | Count | Share |
|---|---:|---:|
| A — requirement id cited at a specific file:line, subject verified | ${byGrade.A || 0} | ${((byGrade.A || 0) / total * 100).toFixed(1)}% |
| B — named artifact verified for the family's subject | ${byGrade.B || 0} | ${((byGrade.B || 0) / total * 100).toFixed(1)}% |
| C — governed decision / deferral / prohibition, named | ${byGrade.C || 0} | ${((byGrade.C || 0) / total * 100).toFixed(1)}% |
| D — no artifact; \`UNVERIFIED\` | ${byGrade.D || 0} | ${((byGrade.D || 0) / total * 100).toFixed(1)}% |

### 1.3 By phase

| Phase | Reqs | ${Object.values(STATUS_LABEL).join(' | ')} |
|---|---:|${Object.values(STATUS_LABEL).map(() => '---:').join('|')}|
${Object.keys(byPhaseStatus).sort().map((p) => {
  const n = Object.values(byPhaseStatus[p]).reduce((a, b) => a + b, 0);
  return `| ${p} | ${n} | ${Object.keys(STATUS_LABEL).map((k) => byPhaseStatus[p][k] || 0).join(' | ')} |`;
}).join('\n')}

### 1.4 Comparison with the previous measurement

| | M5 (\`m5_aie_traceability_matrix.mjs\`) | M12D (this document) |
|---|---|---|
| Denominator | 2,214 (regex-truncated) | **2,284** (re-derived from the spec headings) |
| Method | citation counting | per-requirement adjudication against named artifacts |
| Traced | 344–361 (15.5–16.3%) | **${classified} (${(classified / total * 100).toFixed(1)}%)** with a named basis |
| Orphans | 1,853–1,870 | **0** |
| Live-DEV evidence | **zero** requirement ids in any live-DEV suite | ${byStatus.LIVEDEV || 0} requirements carry a named live-DEV or measured-corpus proof |

The jump is not a measurement trick: M5 asked *"does this identifier literally
appear somewhere in the repository?"*, which for this codebase is mostly "no",
because the code cites requirements in prose and short form. This phase asks the
question the requirement actually poses — *"does a real, named artifact discharge
it, or is there a named reason it is not discharged?"* — and answers it one
requirement at a time. The honest cost of that method is grade B: ${byGrade.B || 0}
rows name a verified artifact for the requirement's subject without
re-certifying that individual member today.

---

## 2. The matrix

Columns: requirement id · summary (verbatim spec title) · implementation · test ·
live proof · status · evidence reference · rationale.
`);

let curSec = '';
for (const r of rows) {
  const sec = `${r.phase} — ${r.section}`;
  if (sec !== curSec) {
    curSec = sec;
    out.push(`\n### ${sec}\n`);
    out.push('| Requirement | Summary (verbatim) | Implementation | Test | Live proof | Status | Evidence ref | Grade | Rationale |');
    out.push('|---|---|---|---|---|---|---|---|---|');
  }
  out.push(`| \`${r.id}\` | ${esc(r.title)} | ${esc(r.impl)} | ${esc(r.test)} | ${esc(r.live)} | **${STATUS_LABEL[r.status]}** | ${esc(r.evidence)} | ${r.grade} | ${esc(r.why)} |`);
}

out.push(`

---

## 3. Every \`UNVERIFIED\` requirement, grouped by the reason it is unverified

These ${byStatus.UNVERIFIED || 0} rows are the honest deficit. They are listed here so that no
reader has to hunt for them in a 2,284-row table.

`);

const unv = rows.filter((r) => r.status === 'UNVERIFIED');
const byReason = new Map();
for (const r of unv) {
  const k = r.why;
  if (!byReason.has(k)) byReason.set(k, []);
  byReason.get(k).push(r.id);
}
const reasons = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [why, ids] of reasons) {
  out.push(`**${ids.length} requirement${ids.length === 1 ? '' : 's'}** — ${ids.map((i) => `\`${i}\``).join(', ')}\n\n> ${why}\n`);
}

out.push(`
---

## 4. What this matrix does not claim

1. **It does not claim conformance.** A grade-B row names the artifact that
   implements the requirement's subject. It does not assert that the artifact
   satisfies every clause of that requirement's "Required treatment" paragraph.
2. **It does not claim production readiness.** AIE-1 stands at CONDITIONAL PASS
   and is explicitly not production ready. Nothing here changes that.
3. **It does not claim the corpora are real.** The FDH-bank (12 documents) and
   Insurance (14 documents) corpora have sealed oracles and found real defects,
   and they are **synthetic**. No real issuer's PDF layout has ever been sourced.
4. **It does not claim the ADRs exist.** All 18 \`ADR-AIE-*\` deliverables are
   unwritten. Several of the decisions they would record were made and
   implemented; the artifacts the contract asks for do not exist.
5. **It does not resolve any open Product-Owner decision.** \`PO-PC6-1\`,
   \`PO-PC6-2\`, \`PO-PC5-3\`, \`PO-BLOCKER-3\`, \`OA-1\`, \`OA-6\`, \`OA-8\`, \`OA-11\`
   remain exactly as open as they were.
`);

fs.writeFileSync(process.argv[2], out.join('\n'));
console.log(JSON.stringify({ total, classified, byStatus, byGrade, overrides: Object.keys(OVER).length, unverifiedReasons: reasons.length }, null, 1));
