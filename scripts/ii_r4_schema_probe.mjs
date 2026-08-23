// Investment Intelligence R4 — live DEV schema probe.
// Verifies exactly which parts of migration 0043 have landed in DEV.
// Read-only: issues only SELECT ... LIMIT 1 requests. Never writes.
//
// Run:  node scripts/ii_r4_schema_probe.mjs
// Reads credentials from .env.local at the repo root (gitignored), falling
// back to the parent checkout's .env.local when run inside a worktree.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const candidates = [
    path.join(repoRoot, '.env.local'),
    path.resolve(repoRoot, '..', '..', '..', '.env.local'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return { env, source: p };
    }
  }
  throw new Error(`No .env.local found in any of: ${candidates.join(', ')}`);
}

const { env, source } = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !SERVICE) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

console.log(`Credentials source: ${source}`);
console.log(`Project URL host:   ${new URL(URL_BASE).host}`);
console.log('');

async function selectCols(table, cols) {
  const url = `${URL_BASE}/rest/v1/${table}?select=${encodeURIComponent(cols)}&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
}

// [table, column] pairs introduced by sections 1-3 of migration 0043.
const ALTERS = [
  ['ii_prices_nav', 'source_timestamp'],
  ['ii_prices_nav', 'data_version'],
  ['ii_prices_nav', 'quality_status'],
  ['ii_benchmarks', 'return_type'],
  ['ii_benchmark_series', 'currency_code'],
  ['ii_benchmark_series', 'source_id'],
  ['ii_benchmark_series', 'data_version'],
  ['ii_benchmark_series', 'quality_status'],
  ['ii_instrument_benchmarks', 'effective_from'],
  ['ii_instrument_benchmarks', 'effective_to'],
  ['ii_instrument_benchmarks', 'source_id'],
  ['ii_instrument_benchmarks', 'mapping_version'],
  ['ii_instrument_benchmarks', 'quality_status'],
];

// New tables from sections 4-5.
const NEW_TABLES = ['ii_risk_free_rates', 'ii_analytics_results'];

const missing = [];
const present = [];

console.log('--- Sections 1-3: ALTER TABLE columns ---');
for (const [table, col] of ALTERS) {
  const r = await selectCols(table, col);
  if (r.ok) {
    present.push(`${table}.${col}`);
    console.log(`  [PRESENT] ${table}.${col}`);
  } else {
    missing.push(`${table}.${col}`);
    console.log(`  [MISSING] ${table}.${col} -> HTTP ${r.status} ${r.body}`);
  }
}

console.log('');
console.log('--- Sections 4-5: new tables ---');
const tableState = {};
for (const t of NEW_TABLES) {
  const r = await selectCols(t, '*');
  tableState[t] = r.ok;
  if (r.ok) {
    const countRes = await fetch(`${URL_BASE}/rest/v1/${t}?select=*`, {
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const range = countRes.headers.get('content-range');
    console.log(`  [PRESENT] ${t} (content-range: ${range})`);
  } else {
    console.log(`  [MISSING] ${t} -> HTTP ${r.status} ${r.body}`);
  }
}

console.log('');
console.log('=== SUMMARY ===');
console.log(`ALTER columns present: ${present.length}/${ALTERS.length}`);
console.log(`ALTER columns missing: ${missing.length}/${ALTERS.length}`);
if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
console.log(`New tables present: ${NEW_TABLES.filter((t) => tableState[t]).length}/${NEW_TABLES.length}`);
const fullyApplied = missing.length === 0 && NEW_TABLES.every((t) => tableState[t]);
console.log('');
console.log(`MIGRATION 0043 FULLY APPLIED: ${fullyApplied ? 'YES' : 'NO'}`);
process.exit(fullyApplied ? 0 : 1);
