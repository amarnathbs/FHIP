// Investment Intelligence R5 — schema probe for migration 0044.
//
// Two jobs:
//   1. Determine whether this session has ANY DDL capability against DEV
//      (probes candidate exec_sql-style RPCs and a direct Postgres connection).
//   2. Report, column by column, whether migration 0044 is applied.
//
// Run: node scripts/ii_r5_schema_probe.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function tableExists(t) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  return { ok: r.status === 200, status: r.status, body: r.status === 200 ? '' : (await r.text()).slice(0, 160) };
}
async function columnExists(t, c) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=${c}&limit=1`, { headers: H });
  return r.status === 200;
}

console.log('=== 1. DDL CAPABILITY PROBE ===');
const rpcCandidates = ['exec_sql', 'execute_sql', 'run_sql', 'sql', 'exec', 'admin_exec_sql', 'pg_execute'];
let ddlAvailable = false;
for (const name of rpcCandidates) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify({ query: 'select 1', sql: 'select 1' }) });
  const txt = (await r.text()).slice(0, 120);
  const missing = txt.includes('PGRST202') || r.status === 404;
  console.log(`  rpc/${name}: HTTP ${r.status} ${missing ? '(not found)' : txt}`);
  if (!missing && r.status < 400) ddlAvailable = true;
}
console.log(`  -> DDL via PostgREST RPC available: ${ddlAvailable ? 'YES' : 'NO'}`);
console.log(`  -> Direct Postgres connection string in env: ${env.DATABASE_URL || env.POSTGRES_URL ? 'YES' : 'NO'}`);

console.log('\n=== 2. MIGRATION 0044 APPLICATION STATUS ===');
const expected = [
  ['ii_fund_holdings_snapshots', ['holdings_as_of_date', 'source_data_version', 'classification_version', 'disclosed_weight_total_pct', 'quality_status']],
  ['ii_fund_holdings_lines', ['snapshot_id', 'underlying_instrument_id', 'holding_name', 'asset_kind', 'weight_pct', 'sector_code', 'market_cap_class', 'credit_rating_band', 'agency_ratings', 'maturity_date', 'modified_duration', 'resolution_method']],
  ['ii_security_classifications', ['instrument_id', 'classification_version', 'taxonomy_key', 'sector_code', 'market_cap_class']],
  ['ii_security_aliases', ['instrument_id', 'alias_normalised', 'alias_raw']],
  ['ii_sip_series', ['user_id', 'series_key', 'cadence', 'detection_confidence', 'detection_method_version']],
  ['ii_r5_analytics_results', ['user_id', 'scope_type', 'metric_key', 'engine_version', 'input_snapshot_version', 'holdings_snapshot_ids', 'coverage', 'quality_status', 'result_value']],
];

let allApplied = true;
for (const [table, cols] of expected) {
  const t = await tableExists(table);
  if (!t.ok) {
    allApplied = false;
    console.log(`  ${table}: MISSING (HTTP ${t.status}) ${t.body}`);
    continue;
  }
  const missing = [];
  for (const c of cols) {
    if (!(await columnExists(table, c))) missing.push(c);
  }
  if (missing.length) {
    allApplied = false;
    console.log(`  ${table}: EXISTS but missing columns: ${missing.join(', ')}`);
  } else {
    console.log(`  ${table}: OK (${cols.length} columns verified)`);
  }
}

console.log(`\nMIGRATION 0044 FULLY APPLIED: ${allApplied ? 'YES' : 'NO'}`);
process.exit(allApplied ? 0 : 1);
