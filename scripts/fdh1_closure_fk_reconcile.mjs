// FDH-1 closure: reconcile the FK set DEFINED by migrations 0045-0048 against the
// FK set OBSERVED live in DEV, and prove every FDH FK carries an explicit
// ON DELETE action. Read-only; parses SQL + reads the live inventory JSON.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGS = [
  '0045_fdh_reference_foundation.sql',
  '0046_fdh_accounts_documents_jobs.sql',
  '0047_fdh_transactions_and_classification.sql',
  '0048_fdh_review_quality_provenance.sql',
];

// Parse `create table X ( ... );` blocks, then per-column `references` clauses.
const defined = []; // {table, column, target, onDelete, migration}
const noOnDelete = [];
const tablesCreated = [];
const rlsEnabled = new Set();
const policies = []; // {table, name, verb}

for (const m of MIGS) {
  const sql = fs.readFileSync(path.join(repoRoot, 'supabase', 'migrations', m), 'utf8');
  // strip line comments so commentary mentioning "references" is ignored
  const code = sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

  for (const mm of code.matchAll(/create table (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const table = mm[1];
    const body = mm[2];
    tablesCreated.push({ table, migration: m });
    for (const line of body.split('\n')) {
      const ref = line.match(/^\s*(\w+)\s+[^,]*?references\s+([\w.]+)\s*\(\s*(\w+)\s*\)([^,]*)/i);
      if (!ref) continue;
      const [, column, refTable, refCol, tail] = ref;
      const od = tail.match(/on delete\s+(cascade|restrict|set null|set default|no action)/i);
      const rec = {
        table,
        column,
        target: `${refTable}.${refCol}`,
        onDelete: od ? od[1].toLowerCase() : null,
        migration: m,
      };
      defined.push(rec);
      if (!od) noOnDelete.push(rec);
    }
  }
  for (const mm of code.matchAll(/alter table (\w+) enable row level security/g)) rlsEnabled.add(mm[1]);
  for (const mm of code.matchAll(/create policy "([^"]+)" on (\w+)\s*\n?\s*for (\w+)/g)) {
    policies.push({ name: mm[1], table: mm[2], verb: mm[3].toLowerCase() });
  }
}

const live = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', '.fdh1-live-inventory.json'), 'utf8'));

console.log('=== FDH tables created by 0045-0048 ===');
console.log(`defined: ${tablesCreated.length}   live fdh_* tables: ${Object.keys(live).length}`);
const definedNames = tablesCreated.map((t) => t.table).sort();
const liveNames = Object.keys(live).sort();
console.log(`missing live: ${definedNames.filter((t) => !liveNames.includes(t)).join(',') || 'NONE'}`);
console.log(`extra live  : ${liveNames.filter((t) => !definedNames.includes(t)).join(',') || 'NONE'}`);

console.log('\n=== FK totals ===');
console.log(`FKs defined in migrations : ${defined.length}`);
const authFks = defined.filter((f) => f.target.startsWith('auth.'));
const publicFks = defined.filter((f) => !f.target.startsWith('auth.'));
console.log(`  -> targeting auth.users : ${authFks.length}  (NOT annotated by PostgREST: auth schema unexposed)`);
console.log(`  -> targeting public.*   : ${publicFks.length}  (should equal live OpenAPI count)`);

let liveFkCount = 0;
const liveFkSet = new Set();
for (const [t, cols] of Object.entries(live)) {
  for (const [c, meta] of Object.entries(cols)) {
    if (meta.fk && meta.fk.length === 2) {
      liveFkCount++;
      liveFkSet.add(`${t}.${c}`);
    }
  }
}
console.log(`FKs observed live (public targets): ${liveFkCount}`);
console.log(`RECONCILES: ${publicFks.length === liveFkCount ? 'YES' : 'NO'}  (${publicFks.length} defined vs ${liveFkCount} live)`);

const definedPublicSet = new Set(publicFks.map((f) => `${f.table}.${f.column}`));
const onlyDefined = [...definedPublicSet].filter((k) => !liveFkSet.has(k));
const onlyLive = [...liveFkSet].filter((k) => !definedPublicSet.has(k));
console.log(`defined-but-not-live: ${onlyDefined.join(', ') || 'NONE'}`);
console.log(`live-but-not-defined: ${onlyLive.join(', ') || 'NONE'}`);

console.log('\n=== explicit ON DELETE coverage ===');
console.log(`FKs WITHOUT an explicit ON DELETE: ${noOnDelete.length}`);
for (const f of noOnDelete) console.log(`  !! ${f.table}.${f.column} -> ${f.target} (${f.migration})`);
const byAction = {};
for (const f of defined) byAction[f.onDelete ?? 'UNSPECIFIED'] = (byAction[f.onDelete ?? 'UNSPECIFIED'] || 0) + 1;
console.log(`breakdown: ${JSON.stringify(byAction)}`);

console.log('\n=== per-table FK count: migration-defined (public only) vs live ===');
for (const t of definedNames) {
  const d = publicFks.filter((f) => f.table === t).length;
  const l = live[t] ? Object.values(live[t]).filter((c) => c.fk && c.fk.length === 2).length : -1;
  console.log(`${d === l ? 'OK  ' : 'DIFF'} ${t}: defined=${d} live=${l}`);
}

console.log('\n=== RLS / policy definitions in migrations ===');
console.log(`tables with "enable row level security": ${rlsEnabled.size} of ${tablesCreated.length}`);
console.log(`tables MISSING enable RLS: ${definedNames.filter((t) => !rlsEnabled.has(t)).join(',') || 'NONE'}`);
const byTable = {};
for (const p of policies) (byTable[p.table] ||= []).push(p.verb);
for (const t of definedNames) console.log(`  ${t}: [${(byTable[t] || []).join(', ') || 'NO POLICY'}]`);
