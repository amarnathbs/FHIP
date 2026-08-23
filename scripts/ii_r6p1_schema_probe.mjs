// Investment Intelligence R6-P1 — schema probe for migration 0045.
// Same two-job pattern as ii_r5_schema_probe.mjs: (1) confirm this session
// still has no DDL capability against DEV, (2) report column-by-column
// whether migration 0045 is applied.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

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

console.log('\n=== 2. MIGRATION 0045 APPLICATION STATUS ===');
const tables = [
  'ii_scheme_tax_classification',
  'ii_exit_load_schedules',
  'ii_tax_lot_consumptions',
  'ii_capital_gains_computations',
];
let allNewTablesPresent = true;
for (const t of tables) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, { headers: H });
  const present = r.status === 200;
  if (!present) allNewTablesPresent = false;
  console.log(`  ${t}: HTTP ${r.status} ${present ? '(exists)' : '(NOT FOUND)'}`);
}

console.log('\n--- ii_tax_rule_versions (R1-shaped, R6-P1-seeded) ---');
const rRules = await fetch(`${BASE}/rest/v1/ii_tax_rule_versions?select=*&rule_set_key=eq.in_mutual_fund_capital_gains`, { headers: H });
const rulesStatus = rRules.status;
let ruleRows = [];
if (rulesStatus === 200) ruleRows = await rRules.json();
console.log(`  ii_tax_rule_versions read: HTTP ${rulesStatus}, in_mutual_fund_capital_gains rows: ${ruleRows.length} (expect 3 once seeded)`);

console.log('\n--- ii_tax_lots (R1-shaped table, already applied since R1) ---');
const rLots = await fetch(`${BASE}/rest/v1/ii_tax_lots?select=*&limit=1`, { headers: H });
console.log(`  ii_tax_lots: HTTP ${rLots.status} ${rLots.status === 200 ? '(exists, from R1 migration 0033)' : '(unexpected)'}`);

console.log('\n--- ii_transactions.transaction_type bonus/split values ---');
const rTx = await fetch(`${BASE}/rest/v1/ii_transactions?select=transaction_type&limit=1`, { headers: H });
console.log(`  ii_transactions readable: HTTP ${rTx.status} (column-value check requires an actual insert attempt, done separately)`);

console.log(`\nMIGRATION 0045 FULLY APPLIED: ${allNewTablesPresent && ruleRows.length === 3 ? 'YES' : 'NO'}`);
