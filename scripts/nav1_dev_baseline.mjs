// NAV 1.05/1.06/1.08/1.09 — real live-DEV database and consumer baseline.
// Read-only: every request below is a GET with select=... or a HEAD-style
// exact count (Prefer: count=exact, range 0-0). Writes nothing.
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!URL_ || !KEY) { console.error('DEV credentials not present.'); process.exit(1); }

async function exactCount(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range'); // e.g. "0-0/1234"
  const total = range?.split('/')[1];
  return total === undefined ? null : Number(total);
}
async function getJson(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return res.json();
}

console.log(`=== NAV 1.05/1.06/1.08/1.09 live DEV baseline (${new URL(URL_).host}) — ${new Date().toISOString()} ===\n`);

console.log('--- 1.05: NAV table sizing ---');
console.log('ii_prices_nav total rows:', await exactCount('ii_prices_nav?select=id'));
console.log('ii_instruments total rows (mutual_fund):', await exactCount('ii_instruments?select=id&instrument_class=eq.mutual_fund'));
console.log('ii_scheme_master total rows (open/current):', await exactCount('ii_scheme_master?select=id&effective_to=is.null'));

console.log('\n--- 1.08: scheme lifecycle breakdown ---');
for (const status of ['active', 'closed', 'merged', 'suspended', 'unknown']) {
  console.log(`  lifecycle_status=${status}:`, await exactCount(`ii_scheme_master?select=id&effective_to=is.null&lifecycle_status=eq.${status}`));
}

console.log('\n--- 1.09: accepted-statement dependency sizing ---');
for (const status of ['pending', 'parsed', 'reconciliation_required', 'certified_with_warnings', 'certified', 'failed', 'superseded', 'archived']) {
  console.log(`  ii_portfolio_truth_status status=${status}:`, await exactCount(`ii_portfolio_truth_status?select=id&status=eq.${status}`));
}
console.log('  distinct instruments with an accepted (certified*) status:');
const acceptedRows = await getJson('ii_portfolio_truth_status?select=instrument_id,status,history_completeness&status=in.(certified,certified_with_warnings)&limit=1000');
const distinctAccepted = new Set(acceptedRows.map((r) => r.instrument_id));
console.log('   ', distinctAccepted.size, '(first page, limit 1000 — see note below if this equals 1000 exactly)');
const completenessCounts = {};
for (const r of acceptedRows) completenessCounts[r.history_completeness ?? 'null'] = (completenessCounts[r.history_completeness ?? 'null'] ?? 0) + 1;
console.log('   history_completeness distribution (first page):', completenessCounts);

console.log('\n--- benchmark dependency sizing ---');
console.log('ii_instrument_benchmarks total rows:', await exactCount('ii_instrument_benchmarks?select=instrument_id'));
console.log('distinct instruments ever benchmark-mapped:', new Set((await getJson('ii_instrument_benchmarks?select=instrument_id&limit=1000')).map((r) => r.instrument_id)).size, '(first page)');

console.log('\n--- 1.42 concurrency/holds ---');
console.log('ii_nav_retention_holds total rows:', await exactCount('ii_nav_retention_holds?select=id'));
console.log('ii_nav_retention_policy total rows:', await exactCount('ii_nav_retention_policy?select=id'));

console.log('\n--- job control state ---');
console.log(JSON.stringify(await getJson('ii_reference_job_control?select=job_key,enabled,disabled_reason,last_success_at,last_failure_at,consecutive_failures'), null, 2));

console.log('\n--- recent import batches (last 10) ---');
console.log(JSON.stringify(await getJson('ii_reference_import_batches?select=source_key,batch_kind,status,started_at,finished_at,rows_inserted,rows_read&order=started_at.desc&limit=10'), null, 2));

console.log('\n--- ii_transactions / ii_holding_snapshots sizing (consumer-side) ---');
console.log('ii_transactions total rows:', await exactCount('ii_transactions?select=id'));
console.log('ii_holding_snapshots total rows:', await exactCount('ii_holding_snapshots?select=id'));
