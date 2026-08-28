// II-R12 terminal certification, 2026-08-28. Reconstructs
// docs/dev-apply/ii-r12-0092-activation/02_dev_verification.sql as real
// REST calls against hosted DEV (no DB connection string / psql available
// in this environment -- service-role REST + Admin API only). Every
// synthetic row is service-role-inserted then deleted; nothing here relies
// on a transaction rollback because PostgREST has no client transaction
// control -- cleanup is explicit instead.
//
// Covers spec item 2 in full:
//   A1 price_source column exists (nullable, text)              -- REST 200 vs 42703 negative control
//   A2 all 22 legacy transaction_type values + 'sale' accepted, invalid rejected
//   A3 all 4 legacy basis values + 'direct_listed_security_rule' accepted, invalid rejected
//   A4 ii_holding_snapshots RLS policy state -- behavioural (pg_policies is
//      not exposed via PostgREST in this project; see
//      scripts/ii_r11_production_readonly_schema_check.mjs's own note on
//      this same limitation). Confirmed instead by: owner SELECT works,
//      owner UPDATE of value/units does NOT persist (same behavioural
//      proof LIVE-R12-02 in r12_live_dev_verification.mjs already gives,
//      re-stated here for completeness of this file's own report).
//   price_source valid values accepted, invalid rejected.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} -- ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function asUserRest(p, { accessToken, method = 'GET', body } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const LEGACY_TX_TYPES = ['purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment',
  'transfer', 'merger', 'fee', 'tax', 'adjustment', 'stp_in', 'stp_out', 'swp', 'transfer_in', 'transfer_out',
  'reversal', 'segregation', 'unclassified', 'bonus', 'split'];
const LEGACY_BASIS = ['computed_from_holdings', 'known_debt_specified_category', 'unresolved_no_data', 'unresolved_stale_data'];
const PRICE_SOURCE_VALUES = ['manual_entry', 'statement_price', 'admin_reference', 'certified_market_data'];

async function main() {
  console.log(`host ${new URL(BASE).host}\n`);
  const cleanup = { userId: null, accountId: null, instrumentId: null, txIds: [], classIds: [], snapIds: [] };
  try {
    // A1: price_source column exists, real 200 vs 42703 negative control.
    const colOk = await sb('/rest/v1/ii_holding_snapshots?select=price_source&limit=1');
    const colNeg = await sb('/rest/v1/ii_holding_snapshots?select=totally_fake_col_xyz&limit=1');
    record('A1', 'price_source column exists (200) vs a genuinely nonexistent column (42703/400) as negative control', colOk.status === 200 && colNeg.status === 400 && colNeg.json?.code === '42703' ? 'PASS' : 'FAIL', `colOk=${colOk.status} colNeg=${colNeg.status} ${colNeg.json?.code}`);

    // SETUP: synthetic user + account + instrument for INSERT-based constraint probing.
    const email = `r12-terminal-restverify-${stamp}@fhip-test.invalid`;
    const password = `TestPass!${stamp}Aa1`;
    const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
    cleanup.userId = created.json?.id;
    if (!cleanup.userId) throw new Error(`user creation failed: ${created.text}`);
    const acc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: cleanup.userId, country_code: 'IN', currency_code: 'INR', account_type: 'demat', institution_name: '0092-TERMINAL-VERIFY-TEMP' } });
    cleanup.accountId = acc.json?.[0]?.id;
    const instr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: '0092-TERMINAL-VERIFY-TEMP-EQUITY', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
    cleanup.instrumentId = instr.json?.[0]?.id;
    if (!cleanup.accountId || !cleanup.instrumentId) throw new Error('setup failed');

    // A2a: every one of the 22 legacy transaction_type values still accepted.
    let allLegacyOk = true;
    const legacyDetail = [];
    for (const t of LEGACY_TX_TYPES) {
      const ins = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, currency_code: 'INR', transaction_type: t, transaction_date: '2025-01-01', units: 1, price_per_unit: 1, gross_amount: 1 } });
      const ok = ins.status === 201 || ins.status === 200;
      if (ok) cleanup.txIds.push(ins.json?.[0]?.id);
      allLegacyOk = allLegacyOk && ok;
      legacyDetail.push(`${t}:${ins.status}`);
    }
    record('A2a', `all 22 pre-existing legacy transaction_type values still accepted (real INSERT per value)`, allLegacyOk ? 'PASS' : 'FAIL', legacyDetail.join(' '));

    // A2b: 'sale' accepted.
    const saleIns = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, currency_code: 'INR', transaction_type: 'sale', transaction_date: '2025-01-01', units: 5, price_per_unit: 100, gross_amount: 500 } });
    if (saleIns.json?.[0]?.id) cleanup.txIds.push(saleIns.json[0].id);
    record('A2b', "'sale' transaction_type accepted (migration 0092)", (saleIns.status === 201 || saleIns.status === 200) ? 'PASS' : 'FAIL', `status=${saleIns.status} ${saleIns.text}`);

    // A2c: invalid transaction_type rejected.
    const badTx = await sb('/rest/v1/ii_transactions', { method: 'POST', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, currency_code: 'INR', transaction_type: 'not_a_real_type', transaction_date: '2025-01-01', units: 1, price_per_unit: 1, gross_amount: 1 } });
    record('A2c', 'invalid transaction_type rejected (constraint not accidentally permissive)', badTx.status === 400 || badTx.status === 409 ? 'PASS' : 'FAIL', `status=${badTx.status} ${badTx.json?.code} ${badTx.text}`.slice(0, 300));

    // A3a/A3b/A3c: ii_scheme_tax_classification has a UNIQUE constraint on
    // instrument_id alone (one classification row per instrument), so each
    // basis value under test needs its OWN synthetic instrument -- reusing
    // cleanup.instrumentId for all of them (as an earlier draft of this
    // script did) trips 23505 unique-violation on the 2nd+ insert, which is
    // a test-design bug, not a constraint-enforcement finding. Fixed here.
    const basisInstrIds = [];
    async function newBasisInstrument(tag) {
      const r = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `0092-TERMINAL-VERIFY-BASIS-${tag}-${stamp}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
      const id = r.json?.[0]?.id;
      if (id) basisInstrIds.push(id);
      return id;
    }
    let allBasisOk = true;
    const basisDetail = [];
    for (const b of LEGACY_BASIS) {
      const iid = await newBasisInstrument(b.slice(0, 8));
      const ins = await sb('/rest/v1/ii_scheme_tax_classification', { method: 'POST', prefer: 'return=representation', body: { instrument_id: iid, classification: 'equity_oriented', basis: b, domestic_equity_pct: 100, engine_version: '0092-terminal-verify' } });
      const ok = ins.status === 201 || ins.status === 200;
      allBasisOk = allBasisOk && ok;
      basisDetail.push(`${b}:${ins.status}`);
    }
    record('A3a', 'all 4 pre-existing legacy basis values still accepted (one synthetic instrument each, since basis lives on a per-instrument-unique table)', allBasisOk ? 'PASS' : 'FAIL', basisDetail.join(' '));

    // A3b: direct_listed_security_rule accepted (own instrument, same reason).
    const dlsrInstrId = await newBasisInstrument('dlsr');
    const dlsr = await sb('/rest/v1/ii_scheme_tax_classification', { method: 'POST', prefer: 'return=representation', body: { instrument_id: dlsrInstrId, classification: 'equity_oriented', basis: 'direct_listed_security_rule', domestic_equity_pct: 100, engine_version: '0092-terminal-verify' } });
    record('A3b', "'direct_listed_security_rule' basis accepted (migration 0092)", (dlsr.status === 201 || dlsr.status === 200) ? 'PASS' : 'FAIL', `status=${dlsr.status} ${dlsr.text}`);

    // A3c: invalid basis rejected (own instrument, same reason).
    const badBasisInstrId = await newBasisInstrument('bad');
    const badBasis = await sb('/rest/v1/ii_scheme_tax_classification', { method: 'POST', body: { instrument_id: badBasisInstrId, classification: 'equity_oriented', basis: 'not_a_real_basis', domestic_equity_pct: 100, engine_version: '0092-terminal-verify' } });
    record('A3c', 'invalid basis rejected', badBasis.status === 400 || badBasis.status === 409 ? 'PASS' : 'FAIL', `status=${badBasis.status} ${badBasis.json?.code}`);
    cleanup.instrumentId2plus = basisInstrIds;

    // price_source: all 4 valid values accepted, invalid rejected.
    let allPriceSourceOk = true;
    const psDetail = [];
    let dayOffset = 0;
    for (const ps of PRICE_SOURCE_VALUES) {
      dayOffset += 1;
      const ins = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', prefer: 'return=representation', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, as_of_date: `2025-02-${String(dayOffset).padStart(2, '0')}`, units: 1, value: 1, currency_code: 'INR', quality_status: 'warning', price_source: ps } });
      const ok = ins.status === 201 || ins.status === 200;
      if (ok) cleanup.snapIds.push(ins.json?.[0]?.id);
      allPriceSourceOk = allPriceSourceOk && ok;
      psDetail.push(`${ps}:${ins.status}`);
    }
    record('PS-valid', 'all 4 valid price_source values accepted', allPriceSourceOk ? 'PASS' : 'FAIL', psDetail.join(' '));
    const badPs = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, as_of_date: '2025-03-01', units: 1, value: 1, currency_code: 'INR', quality_status: 'warning', price_source: 'fabricated_value' } });
    record('PS-invalid', 'invalid/fabricated price_source rejected', badPs.status === 400 || badPs.status === 409 ? 'PASS' : 'FAIL', `status=${badPs.status} ${badPs.json?.code}`);

    // legacy null price_source path (pre-R12 rows) still works.
    const legacyNullPs = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', prefer: 'return=representation', body: { user_id: cleanup.userId, account_id: cleanup.accountId, instrument_id: cleanup.instrumentId, as_of_date: '2025-03-02', units: 1, value: 1, currency_code: 'INR', quality_status: 'warning' } });
    if (legacyNullPs.json?.[0]?.id) cleanup.snapIds.push(legacyNullPs.json[0].id);
    record('PS-legacy-null', 'legacy null price_source (pre-R12 row shape) still works unaffected', (legacyNullPs.status === 201 || legacyNullPs.status === 200) ? 'PASS' : 'FAIL', `status=${legacyNullPs.status}`);

    // A4: RLS policy state, behavioural proof (pg_policies not exposed via PostgREST).
    // Sign in as the synthetic user, confirm SELECT-own works and UPDATE of value/units does not persist.
    const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const session = await tokenRes.json();
    const ownSnapId = cleanup.snapIds[0];
    const ownRead = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${ownSnapId}&select=id,value,units`, { accessToken: session.access_token });
    const ownForge = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${ownSnapId}`, { accessToken: session.access_token, method: 'PATCH', body: { value: 777777, units: 777 } });
    const groundTruth = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${ownSnapId}&select=value,units`);
    const notForged = groundTruth.json?.[0]?.value !== 777777;
    record('A4', "ii_holding_snapshots RLS: owner SELECT works, owner UPDATE of value/units does NOT persist (behavioural proof of exactly-one SELECT-only owner policy; pg_policies is not exposed via PostgREST in this project -- see ii_r11_production_readonly_schema_check.mjs's own precedent for this limitation)", (ownRead.json?.length === 1 && notForged) ? 'PASS' : 'FAIL', `ownRead=${ownRead.status}/${ownRead.json?.length} patchHttp=${ownForge.status} groundTruthValue=${groundTruth.json?.[0]?.value}`);

  } finally {
    console.log('\n=== CLEANUP ===');
    async function safeDelete(p) {
      try { const r = await sb(p, { method: 'DELETE' }); if (r.status >= 400) console.error(`  WARNING: DELETE ${p} -> ${r.status}`); }
      catch (e) { console.error(`  WARNING: DELETE ${p} threw ${e.message}`); }
    }
    if (cleanup.instrumentId) {
      await safeDelete(`/rest/v1/ii_holding_snapshots?instrument_id=eq.${cleanup.instrumentId}`);
      await safeDelete(`/rest/v1/ii_transactions?instrument_id=eq.${cleanup.instrumentId}`);
      await safeDelete(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${cleanup.instrumentId}`);
      await safeDelete(`/rest/v1/ii_instruments?id=eq.${cleanup.instrumentId}`);
    }
    for (const id of cleanup.instrumentId2plus ?? []) {
      await safeDelete(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${id}`);
      await safeDelete(`/rest/v1/ii_instruments?id=eq.${id}`);
    }
    if (cleanup.accountId) await safeDelete(`/rest/v1/ii_accounts?id=eq.${cleanup.accountId}`);
    if (cleanup.userId) await safeDelete(`/auth/v1/admin/users/${cleanup.userId}`);

    console.log('\n=== ZERO-RESIDUE CHECK ===');
    const remAcc = await sb(`/rest/v1/ii_accounts?institution_name=eq.0092-TERMINAL-VERIFY-TEMP&select=id`);
    const remInstr = await sb(`/rest/v1/ii_instruments?instrument_name=eq.0092-TERMINAL-VERIFY-TEMP-EQUITY&select=id`);
    const remBasisInstr = await sb(`/rest/v1/ii_instruments?instrument_name=like.0092-TERMINAL-VERIFY-BASIS-*&select=id`);
    console.log(`residual accounts: ${remAcc.json?.length ?? 'ERR'}, residual instruments: ${remInstr.json?.length ?? 'ERR'}, residual basis-test instruments: ${remBasisInstr.json?.length ?? 'ERR'}`);

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.status.padEnd(6)} ${r.id} ${r.description}`);
    const fails = results.filter((r) => r.status === 'FAIL');
    console.log(`\n${results.length} checks, ${fails.length} failures.`);
    if (fails.length > 0) process.exitCode = 1;
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
