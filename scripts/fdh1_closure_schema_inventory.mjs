// FDH-1 closure: build a LIVE schema inventory of every fdh_* table in DEV from the
// PostgREST OpenAPI definition (the only catalog channel reachable from this
// environment: information_schema / pg_catalog / the migration ledger are all
// unexposed). Emits JSON to scripts/.fdh1-live-inventory.json for diffing against
// the migration definitions. Read-only.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (!fs.existsSync(p)) continue;
    const env = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  }
  throw new Error('no .env.local');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const res = await fetch(`${BASE}/rest/v1/`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
const spec = await res.json();

const out = {};
const allTables = Object.keys(spec.definitions || {}).sort();
for (const t of allTables) {
  if (!t.startsWith('fdh_')) continue;
  const def = spec.definitions[t];
  const cols = {};
  for (const [name, p] of Object.entries(def.properties || {})) {
    const d = p.description || '';
    cols[name] = {
      type: p.format || p.type,
      required: (def.required || []).includes(name),
      pk: /<pk\/>/.test(d),
      fk: (d.match(/<fk table='([^']+)' column='([^']+)'\/>/) || []).slice(1, 3),
      default: p.default,
      maxLength: p.maxLength,
      enum: p.enum,
    };
  }
  out[t] = cols;
}

const summary = {};
for (const [t, cols] of Object.entries(out)) {
  summary[t] = {
    columnCount: Object.keys(cols).length,
    pk: Object.entries(cols).filter(([, c]) => c.pk).map(([n]) => n),
    fks: Object.entries(cols).filter(([, c]) => c.fk.length === 2).map(([n, c]) => `${n} -> ${c.fk[0]}.${c.fk[1]}`),
  };
}

fs.writeFileSync(path.join(repoRoot, 'scripts', '.fdh1-live-inventory.json'), JSON.stringify(out, null, 2));

console.log(`Total tables exposed in public schema: ${allTables.length}`);
console.log(`fdh_* tables: ${Object.keys(out).length}\n`);
let totalFk = 0;
for (const t of Object.keys(summary).sort()) {
  const s = summary[t];
  totalFk += s.fks.length;
  console.log(`${t}  cols=${s.columnCount}  pk=[${s.pk.join(',')}]  fks=${s.fks.length}`);
  for (const f of s.fks) console.log(`     ${f}`);
}
console.log(`\nLIVE FDH FK-bearing columns total: ${totalFk}`);
console.log(`\n--- non-fdh tables present (for cross-stream drift observation only) ---`);
console.log(allTables.filter((t) => !t.startsWith('fdh_')).join(', '));
