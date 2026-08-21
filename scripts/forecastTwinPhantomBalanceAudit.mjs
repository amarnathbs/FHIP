// Forecasting + Financial Twin phantom-balance audit — read-only, against
// real DEV data. Same population dashboard.ts's Chunk 3b fix already
// measured (docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md), re-queried
// here to confirm it is the SAME live defect on the Forecasting and
// Financial Twin code paths this pass fixes, and to size the blast radius
// on each. NO WRITES — every call is .select(). Same .env.local-loading
// pattern as scripts/chunk3bMigrationAudit.mjs.
import fs from 'node:fs';

const envText = fs.readFileSync('D:\\FHIP\\.env.local', 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAllRows(table, columns, filters = (q) => q) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await filters(supabase.from(table).select(columns)).order('id', { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const CONTRIBUTION_TYPE_MASTER_ITEMS = new Set([
  'employer_contributions',
  'salary_sacrifice',
  'personal_concessional',
  'non_concessional',
  'government_co_contribution',
  'spouse_contribution',
]);

const retirement = await fetchAllRows('retirement_accounts', 'id, user_id, current_balance, master_item_key, currency_code', (q) =>
  q.eq('is_active', true)
);

const classFRows = retirement.filter((r) => CONTRIBUTION_TYPE_MASTER_ITEMS.has(r.master_item_key));
const affectedUsers = new Map(); // user_id -> phantom balance total (per currency, kept simple/nominal here)
for (const r of classFRows) {
  const key = r.user_id;
  const entry = affectedUsers.get(key) ?? { rows: 0, phantomBalanceNominal: 0 };
  entry.rows += 1;
  entry.phantomBalanceNominal += Number(r.current_balance ?? 0);
  affectedUsers.set(key, entry);
}

console.log(`Active retirement_accounts rows (DEV): ${retirement.length}`);
console.log(`Class-F contribution-type rows (phantom-balance candidates): ${classFRows.length}`);
console.log(`Distinct users with at least one Class-F row: ${affectedUsers.size}`);

// Forecasting blast radius: which of these users have a forecast_profiles
// row (i.e., have ever used Forecasting), and — more specifically — a
// scenario/profile whose forecast type is one of the two raw-summing paths
// this fix touches (cross_border, retirement)? forecast_scenarios doesn't
// carry forecast_type as a column in every schema version, so this checks
// at the profile level (any Forecasting usage) and reports it as an upper
// bound, not a scenario-type-exact count — precise enough to show the
// defect is live-reachable, not to double as a migration-completeness proof
// (there is no migration in this fix).
const affectedUserIds = Array.from(affectedUsers.keys());
let forecastProfilesForAffected = [];
if (affectedUserIds.length > 0) {
  const { data, error } = await supabase.from('forecast_profiles').select('user_id').in('user_id', affectedUserIds);
  if (error) throw new Error(`forecast_profiles: ${error.message}`);
  forecastProfilesForAffected = data;
}
const usersWithForecastProfile = new Set(forecastProfilesForAffected.map((r) => r.user_id));
console.log(`Of those, users who have used Forecasting (forecast_profiles row exists): ${usersWithForecastProfile.size}`);

// Financial Twin blast radius: loadDashboardForTwin runs for every user
// whose Financial Twin page/report renders, unconditionally (no opt-in
// table) — so every one of the affectedUsers above was getting a
// double-counted totalRetirement (and everything derived from it:
// retirement_balance, productive_asset_ratio, retirement projections,
// cross-border retirement coverage, net worth via totalAssetBase) inside
// the Financial Twin specifically, independent of whether they'd ever used
// Forecasting. No separate query needed — this IS the affected-user set.
console.log(`Financial Twin: every one of the ${affectedUsers.size} users above gets a double-counted totalRetirement inside loadDashboardForTwin (unconditional — no opt-in gate)`);

console.log('\nPer-user detail (user_id, Class-F row count, nominal phantom balance summed):');
for (const [userId, entry] of affectedUsers) {
  console.log(`  ${userId}  rows=${entry.rows}  phantom_balance_nominal=${entry.phantomBalanceNominal}`);
}
