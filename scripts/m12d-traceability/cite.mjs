// M12D — index every requirement-id citation in the repository, with file:line.
// STRICT = fully-qualified id (AIE12-ACCT-03). Unambiguous.
// SHORT  = phase-prefix-dropped form (ACCT-03) — only counted where the family is
//          UNIQUE to one phase across the whole inventory, otherwise ambiguous and dropped.
import fs from 'fs';
import path from 'path';

const REPO = process.argv[2];
const inv = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

// families that exist in more than one phase => short form ambiguous
const famPhases = new Map();
for (const r of inv) {
  if (!famPhases.has(r.family)) famPhases.set(r.family, new Set());
  famPhases.get(r.family).add(r.phase);
}
const shortToId = new Map(); // "ACCT-03" -> id, only when unambiguous
for (const r of inv) {
  if (r.family === 'ADR') continue;
  if (famPhases.get(r.family).size !== 1) continue;
  const parts = r.id.split('-');
  shortToId.set(`${parts[1]}-${parts[2]}`, r.id);
}

const byId = new Map();
for (const r of inv) byId.set(r.id, r);

const ROOTS = ['lib', 'app', 'components', 'tests', 'scripts', 'supabase/migrations', 'docs', 'types', 'hooks', 'utils'];
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.claude', 'coverage']);
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.md', '.json', '.yml', '.yaml']);
// the M5 script's own output is a bulk ID dump, not real evidence — excluded (self-contamination guard)
// SELF-CONTAMINATION GUARD. M5's own script produced a wrong-in-the-reassuring-
// direction 100%/zero-orphan result because it wrote its orphan list into a file
// under a root it then scanned. This phase's own rule tables are dense with
// requirement ids, so the whole m12d-traceability directory, its output matrix,
// this phase's closure report and M5's JSON are excluded by name. Verified
// idempotent across consecutive runs.
const EXCLUDE_DIRS = ['scripts/m12d-traceability'];
const EXCLUDE = new Set([
  'scripts/m5-aie-traceability-matrix.json',
  'docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md',
  'docs/investment-intelligence/M12D_TRACEABILITY_CLOSURE_2026-09-15.md',
]);

function kindOf(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('tests/live-dev/')) return 'liveDev';
  if (p.startsWith('scripts/') && /live_dev|live-dev/i.test(p)) return 'liveDev';
  if (p.startsWith('tests/')) return 'test';
  if (p.startsWith('supabase/migrations/')) return 'migration';
  if (p.startsWith('docs/')) return 'doc';
  if (p.startsWith('scripts/')) return 'script';
  return 'code';
}

const cites = new Map(); // id -> { kind -> [ "rel:line" ] }
function note(id, kind, ref) {
  if (!byId.has(id)) return;
  let rec = cites.get(id);
  if (!rec) { rec = {}; cites.set(id, rec); }
  (rec[kind] = rec[kind] || []).push(ref);
}

const STRICT = /\b(?:AIE1[0-6]-[A-Z0-9]+-[0-9]+[a-z]?|ADR-AIE-[0-9]{3})\b/g;
const SHORT = /\b([A-Z][A-Z0-9]{1,7}-[0-9]{2,3})\b/g;
// Ranges/lists the codebase genuinely writes: "AIE13-RECON-01..12",
// "AIE10-EXC-08/09/10", "AIE13-AI-01/02/03", "AIE11-PII-01-06".
// Expanding these is not inflation — the citation really does name each member.
const RANGE = /\b(AIE1[0-6]-[A-Z0-9]+)-([0-9]{2})\s*(?:\.\.|–|—|-)\s*([0-9]{2})\b/g;
const LIST = /\b(AIE1[0-6]-[A-Z0-9]+)-([0-9]{2}(?:\s*\/\s*[0-9]{2})+)\b/g;
function expand(L) {
  const ids = [];
  for (const m of L.matchAll(RANGE)) {
    const a = parseInt(m[2], 10), b = parseInt(m[3], 10);
    if (b > a && b - a <= 20) for (let n = a; n <= b; n++) ids.push(`${m[1]}-${String(n).padStart(2, '0')}`);
  }
  for (const m of L.matchAll(LIST)) {
    for (const n of m[2].split('/')) ids.push(`${m[1]}-${n.trim()}`);
  }
  return ids;
}

let scanned = 0;
function walk(dir, rel) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(abs, r); continue; }
    if (!EXT.has(path.extname(e.name))) continue;
    if (EXCLUDE.has(r) || EXCLUDE_DIRS.some((d) => r.startsWith(d + '/'))) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    scanned++;
    const kind = kindOf(r);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (!/[A-Z]-[0-9]/.test(L)) continue;
      for (const m of L.matchAll(STRICT)) note(m[0], kind, `${r}:${i + 1}`);
      for (const id of expand(L)) note(id, kind, `${r}:${i + 1}`);
      for (const m of L.matchAll(SHORT)) {
        const full = shortToId.get(m[1]);
        if (full) note(full, kind + ':short', `${r}:${i + 1}`);
      }
    }
  }
}
for (const root of ROOTS) walk(path.join(REPO, root), root);

const out = {};
for (const [id, rec] of cites) {
  const o = {};
  for (const k of Object.keys(rec)) o[k] = [...new Set(rec[k])].slice(0, 6);
  out[id] = o;
}
fs.writeFileSync(process.argv[4], JSON.stringify(out, null, 1));

// summary
let strictAny = 0, strictCode = 0, strictTest = 0, strictLive = 0, shortAny = 0, none = 0;
for (const r of inv) {
  const c = cites.get(r.id);
  if (!c) { none++; continue; }
  const hasStrict = ['code', 'test', 'liveDev', 'migration', 'script', 'doc'].some(k => c[k]);
  const hasStrictNonDoc = ['code', 'test', 'liveDev', 'migration', 'script'].some(k => c[k]);
  if (hasStrict) strictAny++; else shortAny++;
  if (c.code) strictCode++;
  if (c.test) strictTest++;
  if (c.liveDev) strictLive++;
}
console.log(JSON.stringify({ files: scanned, total: inv.length, strictAny, shortOnly: shortAny, none, strictCode, strictTest, strictLive, unambiguousShortKeys: shortToId.size }, null, 1));
