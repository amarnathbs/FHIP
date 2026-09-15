// M5 (Part L.3) — AIE-1.0 .. AIE-1.6 requirement traceability matrix.
//
// WHAT PROBLEM THIS SOLVES. L.3 requires every AIE-1.0 through AIE-1.6
// requirement to map onto a code artifact, a migration where relevant, an
// automated test, live-DEV evidence where required, security/privacy
// evidence, a production enablement state and a residual risk — with "no
// orphan requirements". Prior phases asserted coverage narratively. There
// are 2,200+ numbered requirements, so a narrative assertion is not
// checkable, and neither is a hand-written table.
//
// METHOD, AND ITS HONEST LIMITS.
//   * The authoritative requirement sets live in Product-Owner files OUTSIDE
//     version control (M0 §2). They are READ here and never copied: this
//     script extracts requirement IDENTIFIERS only — no requirement text,
//     no financial data, no PII — and writes only counts and ID lists.
//   * Coverage is measured by CITATION: a requirement is "traced" when its
//     ID appears in at least one repository artifact. That is a real,
//     falsifiable signal (this codebase's own convention is to cite the
//     governing requirement ID in the header of the file that implements
//     it), and it is the strongest automatable one available.
//   * It is NOT proof that the requirement is correctly IMPLEMENTED. A
//     citation proves traceability, not conformance. Conformance evidence
//     is the per-item verdict work in the M2/M3/M4/M4B reports and in this
//     phase's own L.4-L.9 sections. This script answers exactly one
//     question — "is any requirement completely unaccounted for?" — and the
//     terminal report must not overstate it as more than that.
//
// Writes one JSON artifact; changes nothing else. Reads no database.
import fs from 'fs';
import path from 'path';

const SPEC_DIR = 'C:/Users/user/Downloads';
const SPECS = [
  ['AIE-1.0', 'AIE-1.0_Architecture_&_Privacy_Contract.md'],
  ['AIE-1.1', 'AIE-1.1_Shared_Preprocessing_Masking_and_JSON-Schema_Gateway (1).md'],
  ['AIE-1.2', 'AIE-1.2_Investment_Intelligence_Adapter.md'],
  ['AIE-1.3', 'AIE-1.3_FDH_Bank-Statement_Adapter.md'],
  ['AIE-1.4', 'AIE-1.4_Other_PDF-Enabled_FHIP_Modules.md'],
  ['AIE-1.5', 'AIE-1.5_User_Exception_Review_and_Acceptance_Integration.md'],
  ['AIE-1.6', 'AIE-1.6_Production_Cost_Security_and_Accuracy_Certification.md'],
];

// A requirement id looks like AIE12-ACCT-03 / AIE10-EXC-08 / ADR-AIE-002.
const ID_RE = /\b[A-Z][A-Z0-9]{1,9}-[A-Z]{2,6}-[0-9]{2,3}\b/g;

// THE CITATION CONVENTION THIS CODEBASE ACTUALLY USES. A first run of this
// script matched only the fully-qualified form and reported 2.4% coverage,
// which was an artifact of the regex, not a finding. In practice `lib/aie`
// cites requirements in SHORT form with the phase prefix dropped — `GW-03`,
// `QUA-05`, `PII-06`, `CST-08`, `JSC-01` — because inside an AIE-1.1 module
// the `AIE11-` prefix is redundant. 921 distinct short-form ids are cited in
// lib/app/components/tests alone.
//
// So coverage is measured TWICE and both numbers are reported:
//   STRICT      — the fully-qualified id only. An unambiguous LOWER BOUND.
//   CONVENTION  — fully-qualified OR short form. The realistic number, but an
//                 UPPER BOUND, because a short form is ambiguous across
//                 phases: `COST-01` is defined by AIE-1.2, 1.3, 1.4 and 1.6,
//                 and a single citation credits all of them. Reported as a
//                 range rather than picking the flattering end.
const SHORT_RE = /\b[A-Z][A-Z0-9]{1,7}-[0-9]{2,3}\b/g;
const shortOf = (id) => {
  const parts = id.split('-');
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : null;
};

// ---------------------------------------------------------------------------
// 1. Extract the requirement inventory from the Product-Owner specs.
// ---------------------------------------------------------------------------
const inventory = new Map(); // phase -> Set(id)
for (const [phase, file] of SPECS) {
  const full = path.join(SPEC_DIR, file);
  if (!fs.existsSync(full)) {
    console.error(`MISSING SPEC: ${file}`);
    inventory.set(phase, new Set());
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  const ids = new Set(text.match(ID_RE) ?? []);
  inventory.set(phase, ids);
}

// ---------------------------------------------------------------------------
// 2. Index every requirement-id citation in the repository, by artifact kind.
// ---------------------------------------------------------------------------
const ROOTS = ['lib', 'app', 'components', 'tests', 'scripts', 'supabase/migrations', 'docs'];
const SKIP_DIR = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.claude']);
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.sql', '.md', '.json', '.yml']);

// SELF-CONTAMINATION GUARD, added after this script produced a wrong answer
// in the reassuring direction — disclosed rather than quietly corrected.
// The first run wrote its 2,161 orphan ids into this JSON artifact under
// `scripts/`, which is itself a scanned root. The SECOND run then found every
// one of those ids "cited" — by its own previous output — and reported 100%
// coverage with ZERO orphans on both the strict and convention measures. A
// 2.7% -> 100.0% jump in the strict column is what exposed it; had the first
// run not existed, the contaminated number would have looked plausible.
// The output file is therefore excluded by name from the scan.
const SELF_OUTPUT = 'scripts/m5-aie-traceability-matrix.json';

/** Which evidence column a file counts towards. Order matters — a file under
 *  tests/ is test evidence even though it is also .ts source. */
function kindOf(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('tests/live-dev/')) return 'liveDev';
  if (p.startsWith('tests/')) return 'test';
  if (p.startsWith('supabase/migrations/')) return 'migration';
  if (p.startsWith('docs/')) return 'doc';
  if (p.startsWith('scripts/')) return 'script';
  return 'code';
}

const citations = new Map(); // id -> { code:Set, test:Set, liveDev:Set, migration:Set, script:Set, doc:Set }
function noteCitation(id, kind, rel) {
  let rec = citations.get(id);
  if (!rec) {
    rec = { code: new Set(), test: new Set(), liveDev: new Set(), migration: new Set(), script: new Set(), doc: new Set() };
    citations.set(id, rec);
  }
  rec[kind].add(rel);
}

let filesScanned = 0;
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name));
    } else if (EXT.has(path.extname(e.name))) {
      const full = path.join(dir, e.name);
      const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
      if (rel === SELF_OUTPUT) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      filesScanned += 1;
      const kind = kindOf(rel);
      for (const id of new Set(text.match(ID_RE) ?? [])) noteCitation(id, kind, rel);
      for (const id of new Set(text.match(SHORT_RE) ?? [])) noteCitation(id, kind, rel);
    }
  }
}
for (const r of ROOTS) walk(r);

// ---------------------------------------------------------------------------
// 3. Score each phase.
// ---------------------------------------------------------------------------
const report = { generatedAt: new Date().toISOString(), filesScanned, phases: {}, totals: {} };
const T = { total: 0, code: 0, test: 0, liveDev: 0, migration: 0, tracedAnywhere: 0, orphans: 0 };

/** Merge the citation records for an id and (optionally) its short form. */
function lookup(id, useShort) {
  const recs = [citations.get(id)];
  if (useShort) {
    const s = shortOf(id);
    if (s) recs.push(citations.get(s));
  }
  const out = { code: 0, test: 0, liveDev: 0, migration: 0, script: 0, doc: 0 };
  let any = false;
  for (const r of recs) {
    if (!r) continue;
    for (const k of Object.keys(out)) if (r[k].size) out[k] = 1;
    any = true;
  }
  return any ? out : null;
}

for (const [phase, ids] of inventory) {
  const row = {
    total: ids.size,
    code: 0, test: 0, liveDev: 0, migration: 0, script: 0, doc: 0,
    tracedAnywhere: 0, orphans: [],
    strictTraced: 0, strictOrphanCount: 0,
  };
  for (const id of ids) {
    if (lookup(id, false)) row.strictTraced += 1;

    const c = lookup(id, true);
    if (!c) {
      row.orphans.push(id);
      continue;
    }
    row.code += c.code;
    row.test += c.test;
    row.liveDev += c.liveDev;
    row.migration += c.migration;
    row.script += c.script;
    row.doc += c.doc;
    row.tracedAnywhere += 1;
  }
  row.strictOrphanCount = row.total - row.strictTraced;
  row.orphanCount = row.orphans.length;
  row.orphans.sort();
  report.phases[phase] = row;

  T.total += row.total;
  T.code += row.code;
  T.test += row.test;
  T.liveDev += row.liveDev;
  T.migration += row.migration;
  T.tracedAnywhere += row.tracedAnywhere;
  T.orphans += row.orphanCount;
  T.strictTraced = (T.strictTraced ?? 0) + row.strictTraced;
}
report.totals = T;

fs.writeFileSync('scripts/m5-aie-traceability-matrix.json', JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------
// 4. Print.
// ---------------------------------------------------------------------------
console.log(`\nAIE-1 TRACEABILITY MATRIX — ${report.generatedAt}`);
console.log(`repository files scanned: ${filesScanned}\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('Phase', 9)}${pad('Reqs', 7)}${pad('code', 7)}${pad('test', 7)}${pad('liveDev', 9)}${pad('migr', 7)}${pad('traced', 8)}${pad('ORPHAN', 8)}${pad('cover%', 9)}strict%`);
for (const [phase, r] of Object.entries(report.phases)) {
  const pct = r.total ? ((r.tracedAnywhere / r.total) * 100).toFixed(1) : '—';
  const sp = r.total ? ((r.strictTraced / r.total) * 100).toFixed(1) : '—';
  console.log(
    `${pad(phase, 9)}${pad(r.total, 7)}${pad(r.code, 7)}${pad(r.test, 7)}${pad(r.liveDev, 9)}${pad(r.migration, 7)}${pad(r.tracedAnywhere, 8)}${pad(r.orphanCount, 8)}${pad(pct, 9)}${sp}`
  );
}
const pctT = ((T.tracedAnywhere / T.total) * 100).toFixed(1);
const spT = ((T.strictTraced / T.total) * 100).toFixed(1);
console.log(
  `${pad('TOTAL', 9)}${pad(T.total, 7)}${pad(T.code, 7)}${pad(T.test, 7)}${pad(T.liveDev, 9)}${pad(T.migration, 7)}${pad(T.tracedAnywhere, 8)}${pad(T.orphans, 8)}${pad(pctT, 9)}${spT}`
);
console.log(
  `\ncover%  = fully-qualified OR short-form citation (realistic; UPPER bound — short forms are ambiguous across phases)` +
  `\nstrict% = fully-qualified citation only (unambiguous LOWER bound)`
);
console.log(`\nfull detail incl. every orphan id: scripts/m5-aie-traceability-matrix.json`);
