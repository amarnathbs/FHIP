// R4 — seed ii_risk_free_rates with IN and AU reference rows (spec section 37).
//
// SCOPE OF THIS DATA: these are DEV seed rows, deliberately labelled as such
// in both `source` and `version`. They are approximate, representative
// annual averages, NOT a certified reference-data feed. Their purpose is to
// let Sharpe / Sortino / alpha compute live so the calculation path can be
// verified end to end, instead of correctly-but-untestably suppressing.
//
// Before production use, replace these with a real ingested series (RBI
// 91-day T-Bill for IN, RBA cash rate for AU) under a new `version` string.
// The version is carried into every persisted ii_analytics_results row, so
// figures computed against this seed remain identifiable and can be
// invalidated as stale when a certified series lands.
//
// Idempotent: the table's unique(country_code, period_start, period_end,
// version) constraint means re-running is a no-op.
//
// Run:  node scripts/ii_r4_seed_risk_free_rates.mjs

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

const VERSION = 'dev-seed-v1';
const IN_SOURCE = 'DEV SEED — approximate RBI 91-day T-Bill annual average (not a certified feed)';
const AU_SOURCE = 'DEV SEED — approximate RBA cash rate annual average (not a certified feed)';

// Representative annual averages. Accurate to roughly the nearest 0.1-0.5pp;
// sufficient for verifying the calculation path, not for advice.
const IN_RATES = { 2019: 0.064, 2020: 0.039, 2021: 0.035, 2022: 0.052, 2023: 0.068, 2024: 0.068, 2025: 0.065, 2026: 0.060 };
const AU_RATES = { 2019: 0.010, 2020: 0.0025, 2021: 0.001, 2022: 0.0135, 2023: 0.039, 2024: 0.0435, 2025: 0.041, 2026: 0.036 };

const rows = [];
for (const [country, table, source] of [
  ['IN', IN_RATES, IN_SOURCE],
  ['AU', AU_RATES, AU_SOURCE],
]) {
  for (const [year, rate] of Object.entries(table)) {
    rows.push({
      country_code: country,
      period_start: `${year}-01-01`,
      period_end: `${year}-12-31`,
      annualised_rate: rate.toFixed(6),
      source,
      method: 'period_average',
      version: VERSION,
    });
  }
}

const res = await fetch(`${BASE}/rest/v1/ii_risk_free_rates`, {
  method: 'POST',
  headers: {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=ignore-duplicates',
  },
  body: JSON.stringify(rows),
});

console.log(`Insert: HTTP ${res.status}`);
if (!res.ok) {
  console.error(await res.text());
  process.exit(1);
}

const check = await fetch(
  `${BASE}/rest/v1/ii_risk_free_rates?select=country_code,period_start,period_end,annualised_rate,version&order=country_code.asc,period_start.asc`,
  { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }
);
const data = await check.json();
console.log(`\nRows now present: ${data.length}`);
for (const r of data) {
  console.log(`  ${r.country_code} ${r.period_start}..${r.period_end}  ${(Number(r.annualised_rate) * 100).toFixed(3)}%  [${r.version}]`);
}
