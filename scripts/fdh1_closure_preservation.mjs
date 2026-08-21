// FDH-1 closure: confirm the FDH work left existing FHIP / Investment Intelligence
// / Resources data untouched. Row counts only — no PII, no financial values read.
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

async function count(t) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=*`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = r.headers.get('content-range');
  return cr ? cr.split('/')[1] : `http ${r.status}`;
}

const GROUPS = {
  'FHIP Input Data': ['households', 'household_members', 'income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies', 'user_profiles'],
  'FHIP calculations': ['financial_health_scores', 'financial_health_component_scores', 'resilience_scores', 'forecast_runs', 'forecast_results', 'financial_twin_runs', 'reports', 'user_goals'],
  'Investment Intelligence (canonical)': ['ii_accounts', 'ii_instruments', 'ii_transactions', 'ii_holding_snapshots', 'ii_prices_nav', 'ii_fhip_publications', 'ii_tax_lots', 'ii_analytics_results'],
  'Resources': ['resource_posts', 'resource_categories', 'resource_ctas', 'resource_sources'],
  'Shared reference': ['countries', 'currencies', 'master_financial_items', 'goal_types'],
};
for (const [g, tables] of Object.entries(GROUPS)) {
  console.log(`\n=== ${g} ===`);
  for (const t of tables) console.log(`  ${t}: ${await count(t)}`);
}
console.log('\n=== the known cross-stream drift (observed, NOT fixed here) ===');
for (const t of ['financial_section_status', 'user_financial_section_status']) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  console.log(`  ${t}: http ${r.status} ${r.status === 404 ? '(ABSENT — Resources 0031 lineage never applied)' : '(present)'}`);
}
