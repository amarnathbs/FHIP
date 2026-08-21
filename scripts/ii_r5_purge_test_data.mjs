// Investment Intelligence R5 — teardown sweeper for DEV test data.
//
// The per-fixture teardowns use `like` filters that can miss rows when the
// pattern contains spaces, and can fail on FK ordering (a security instrument
// cannot be deleted while a fund-holdings line still references it as an
// underlying). This sweeper deletes in dependency order and reports what it
// removed, so DEV is verifiably left clean.
//
// Run: node scripts/ii_r5_purge_test_data.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let env = null;
for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
  if (fs.existsSync(p)) {
    env = {};
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    break;
  }
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function sb(p, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json, text };
}

// Every instrument-name prefix any R5 harness or fixture has ever used.
const TEST_PATTERNS = [/^R5QA /, /^R5X /, /^R5 QA /, /^E2E /, /^PAGINATION PROBE /, /^FORGED /];

console.log('=== R5 DEV test-data sweeper ===\n');

// 1. Ephemeral test users (cascades their own accounts/transactions/holdings).
const users = await sb('/auth/v1/admin/users?per_page=200');
let userCount = 0;
for (const u of users.json?.users ?? []) {
  if (/@fhip-test\.local$/.test(u.email ?? '')) {
    await sb(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    userCount++;
  }
}
console.log(`deleted ephemeral @fhip-test.local users: ${userCount}`);

// 2. Identify test instruments by name.
const instruments = await sb('/rest/v1/ii_instruments?select=id,instrument_name');
const testInstruments = (instruments.json ?? []).filter((i) => TEST_PATTERNS.some((p) => p.test(i.instrument_name)));
console.log(`test instruments found: ${testInstruments.length}`);

// 3. Delete in strict dependency order.
//    lines -> snapshots -> benchmark mappings/series -> prices -> instruments
for (const i of testInstruments) {
  const snaps = await sb(`/rest/v1/ii_fund_holdings_snapshots?fund_instrument_id=eq.${i.id}&select=id`);
  for (const s of snaps.json ?? []) {
    await sb(`/rest/v1/ii_fund_holdings_lines?snapshot_id=eq.${s.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_fund_holdings_snapshots?id=eq.${s.id}`, { method: 'DELETE' });
  }
}
// Any line still referencing a test instrument as an UNDERLYING must go before
// that instrument can be deleted.
for (const i of testInstruments) {
  await sb(`/rest/v1/ii_fund_holdings_lines?underlying_instrument_id=eq.${i.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/ii_security_classifications?instrument_id=eq.${i.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/ii_security_aliases?instrument_id=eq.${i.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${i.id}`, { method: 'DELETE' });
  await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${i.id}`, { method: 'DELETE' });
}
let deleted = 0;
const failures = [];
for (const i of testInstruments) {
  const r = await sb(`/rest/v1/ii_instruments?id=eq.${i.id}`, { method: 'DELETE' });
  if (r.status < 300) deleted++;
  else failures.push(`${i.instrument_name}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
}
console.log(`deleted test instruments: ${deleted}`);
if (failures.length) console.log('FAILURES:\n  ' + failures.join('\n  '));

// 4. Test benchmarks.
const bms = await sb('/rest/v1/ii_benchmarks?select=id,benchmark_key');
let bmCount = 0;
for (const b of bms.json ?? []) {
  if (/^(R5_QA_|E2E_BM_|FORGED_BM)/.test(b.benchmark_key)) {
    await sb(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${b.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_benchmarks?id=eq.${b.id}`, { method: 'DELETE' });
    bmCount++;
  }
}
console.log(`deleted test benchmarks: ${bmCount}`);

// 5. Verify.
console.log('\n=== POST-SWEEP STATE ===');
const after = await sb('/rest/v1/ii_instruments?select=instrument_name');
const leftover = (after.json ?? []).filter((i) => TEST_PATTERNS.some((p) => p.test(i.instrument_name)));
for (const t of ['ii_fund_holdings_snapshots', 'ii_fund_holdings_lines', 'ii_r5_analytics_results', 'ii_sip_series', 'ii_security_classifications', 'ii_security_aliases', 'ii_transactions', 'ii_holding_snapshots', 'ii_prices_nav', 'ii_benchmarks', 'ii_benchmark_series', 'ii_accounts']) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=id`, { headers: { ...H, Prefer: 'count=exact' } });
  console.log(`  ${t.padEnd(30)} ${r.headers.get('content-range')}`);
}
console.log(`  ${'ii_instruments'.padEnd(30)} total=${(after.json ?? []).length}, leftover test rows=${leftover.length}`);
if (leftover.length) console.log('  LEFTOVER: ' + leftover.map((i) => i.instrument_name).join(', '));
process.exit(leftover.length === 0 ? 0 : 1);
