// FDH-1 closure preflight: what do the shared dependency tables require, and are
// the user-owned FDH tables actually EMPTY? (If empty, an "anon sees 0 rows"
// assertion proves nothing — it would pass with RLS switched off.) Read-only.
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
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

async function count(table) {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=*`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  });
  return r.headers.get('content-range') || `http ${r.status}`;
}

const USER_TABLES = [
  'fdh_financial_accounts', 'fdh_statement_uploads', 'fdh_ingestion_jobs',
  'fdh_transactions', 'fdh_transaction_allocations', 'fdh_transaction_links',
  'fdh_duplicate_candidates', 'fdh_user_classification_rules',
  'fdh_classification_history', 'fdh_recurring_transactions', 'fdh_review_items',
  'fdh_reconciliation_results', 'fdh_data_quality_results', 'fdh_data_provenance',
  'fdh_evidence_links',
];
console.log('=== row counts, service role (total/x = exact count) ===');
for (const t of USER_TABLES) console.log(`${t}: ${await count(t)}`);
console.log('\n=== master tables ===');
for (const t of ['fdh_source_types', 'fdh_financial_institutions', 'fdh_categories', 'fdh_subcategories', 'fdh_merchants', 'fdh_classification_rules', 'fdh_parser_registry', 'fdh_parser_versions']) {
  console.log(`${t}: ${await count(t)}`);
}
console.log('\n=== shared dependency reference data ===');
for (const t of ['countries?select=country_code', 'currencies?select=currency_code']) {
  const r = await fetch(`${BASE}/rest/v1/${t}`, { headers: H });
  console.log(`${t.split('?')[0]}: ${(await r.text()).slice(0, 300)}`);
}
console.log('\n=== households shape ===');
const r = await fetch(`${BASE}/rest/v1/households?select=*&limit=1`, { headers: H });
console.log((await r.text()).slice(0, 500));
console.log(`households count: ${await count('households')}`);
