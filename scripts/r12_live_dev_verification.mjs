// Investment Intelligence R12 — Live DEV verification, real Supabase, real
// synthetic users, real JWTs, real RLS. Run against the CURRENT (pre-0092)
// DEV schema — this session has no DDL execution capability against the
// hosted Supabase project (confirmed via scripts/fdh1_closure_capability_probe.mjs:
// no exec_sql/execute_sql/run_sql/admin_exec RPC exists, and PostgREST does
// not expose a DDL path). Migration 0092 has NOT been applied to DEV.
//
// Scope of what CAN be verified live, honestly, without 0092:
//   LIVE-R12-01  Existing mutual-fund regression (unchanged pre-R12 schema/RLS)
//   LIVE-R12-02  SAME-USER HOLDING FORGERY on ii_holding_snapshots — RED
//                reproduction of the real, live, pre-existing vulnerability
//                this round's architecture discovery found (not hypothetical)
//   LIVE-R12-03  Cross-user holding access — already blocked pre-0092 (the
//                ownership USING clause was always correct; only the
//                COLUMN-level same-user forgery was the gap)
//   LIVE-R12-04  Same ISIN, two exchange identifiers -> one canonical
//                instrument (structurally available since migration 0031,
//                does not need 0092)
//
// What CANNOT be verified live this round (needs 0092 applied to DEV first):
//   the 'sale' transaction_type, the price_source column, the
//   ii_scheme_tax_classification 'direct_listed_security_rule' basis, and
//   therefore the POST-FIX GREEN state of LIVE-R12-02. See
//   R12_LIVE_DEV_VERIFICATION.md for the full accounting against the
//   spec's 25-scenario target.
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
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
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
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { userIds: [], instrumentIds: [], accountIds: [] };

async function makeUser(tag) {
  const email = `r12-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.userIds.push(id);
  return { id, email, accessToken: session.access_token };
}

async function main() {
  console.log(`host ${new URL(BASE).host}\n`);

  // --- LIVE-R12-01: existing mutual-fund regression -----------------------
  const userA = await makeUser('mf-regression-a');
  const acc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'mf_folio', institution_name: 'HDFC Mutual Fund', country_code: 'IN', currency_code: 'INR', folio_number: `R12-MF-${stamp}`, status: 'active' } });
  const accId = acc.json?.[0]?.id;
  cleanup.accountIds.push(accId);
  const instr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R12 Regression Test Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
  const instrId = instr.json?.[0]?.id;
  cleanup.instrumentIds.push(instrId);
  const snap = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: accId, instrument_id: instrId, as_of_date: '2026-06-30', units: 100, value: 15000, currency_code: 'INR', quality_status: 'certified' } });
  const snapId = snap.json?.[0]?.id;
  const readOwn = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=id,units,value`, { accessToken: userA.accessToken });
  record('LIVE-R12-01', 'existing mutual-fund holding still readable by its owner (unchanged pre-R12 behaviour)', readOwn.ok && readOwn.json?.length === 1 ? 'PASS' : 'FAIL', JSON.stringify(readOwn.json));

  // --- LIVE-R12-02: SAME-USER HOLDING FORGERY (RED — real, live, pre-existing) ---
  const forgeAttempt = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`, { accessToken: userA.accessToken, method: 'PATCH', body: { value: 999999999, units: 1 } });
  const verifyForged = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=value,units`);
  const forged = verifyForged.json?.[0]?.value === 999999999;
  record(
    'LIVE-R12-02',
    'SAME-USER HOLDING FORGERY on ii_holding_snapshots — pre-existing gap, RED expected on CURRENT unmigrated DEV schema (fix is migration 0092, not yet applied to DEV)',
    forged ? 'RED-CONFIRMED (real, live, matches the code-inspection finding — fixed in migration 0092, pending DEV application)' : 'UNEXPECTED-GREEN (investigate — was 0092 already applied?)',
    `PATCH http ${forgeAttempt.status}; row now reads value=${verifyForged.json?.[0]?.value}, units=${verifyForged.json?.[0]?.units}`
  );
  // Restore ground truth immediately (service-role), regardless of outcome.
  await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`, { method: 'PATCH', body: { value: 15000, units: 100 } });
  const restored = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=value,units`);
  record('LIVE-R12-02-restore', 'ground truth restored via service-role after reproduction', restored.json?.[0]?.value === 15000 ? 'PASS' : 'FAIL', JSON.stringify(restored.json));

  // --- LIVE-R12-03: cross-user holding access (should already be blocked) ---
  const userB = await makeUser('cross-user-b');
  const crossRead = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=id,value`, { accessToken: userB.accessToken });
  record('LIVE-R12-03a', 'User B cannot READ User A holding snapshot', (crossRead.ok && (crossRead.json?.length ?? 0) === 0) ? 'PASS' : 'FAIL', `http ${crossRead.status}, rows=${crossRead.json?.length}`);
  const crossWrite = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`, { accessToken: userB.accessToken, method: 'PATCH', body: { value: 1 } });
  const verifyNotChanged = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=value`);
  record('LIVE-R12-03b', 'User B cannot WRITE User A holding snapshot (ownership USING clause already correct pre-0092 — only same-user column forgery was the gap)', verifyNotChanged.json?.[0]?.value === 15000 ? 'PASS' : 'FAIL', `http ${crossWrite.status}, value now ${verifyNotChanged.json?.[0]?.value}`);

  // --- LIVE-R12-04: same ISIN, two exchange identifiers -> one instrument ---
  const isin = `INE${stamp % 1000000}A01019`.slice(0, 12);
  const eqInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: 'R12 Test Equity Co', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
  const eqInstrId = eqInstr.json?.[0]?.id;
  cleanup.instrumentIds.push(eqInstrId);
  const idIsin = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', prefer: 'return=representation', body: { instrument_id: eqInstrId, identifier_scheme: 'isin', identifier_value: isin, country_code: 'IN' } });
  const idNse = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', prefer: 'return=representation', body: { instrument_id: eqInstrId, identifier_scheme: 'nse_symbol', identifier_value: `R12TST${stamp % 10000}`, country_code: 'IN' } });
  const idBse = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', prefer: 'return=representation', body: { instrument_id: eqInstrId, identifier_scheme: 'bse_code', identifier_value: `${500000 + (stamp % 9999)}`, country_code: 'IN' } });
  const allSameInstrument = [idIsin, idNse, idBse].every((r) => r.json?.[0]?.instrument_id === eqInstrId);
  // Attempt to mint a SECOND canonical instrument for the SAME ISIN (must be blocked by uidx_ii_instrument_identifiers_global).
  const dupInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: 'R12 Test Equity Co (duplicate attempt)', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
  const dupInstrId = dupInstr.json?.[0]?.id;
  cleanup.instrumentIds.push(dupInstrId);
  const dupIsinAttempt = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', body: { instrument_id: dupInstrId, identifier_scheme: 'isin', identifier_value: isin, country_code: 'IN' } });
  record(
    'LIVE-R12-04',
    'same ISIN across NSE+BSE identifiers resolves to ONE canonical instrument, and a second instrument cannot claim the same ISIN (global unique index)',
    allSameInstrument && dupIsinAttempt.status >= 400 ? 'PASS' : 'FAIL',
    `identifiers all point at ${eqInstrId}: ${allSameInstrument}; duplicate ISIN insert http ${dupIsinAttempt.status}`
  );

  // --- Cleanup: synthetic R12 certification data only ----------------------
  for (const id of cleanup.instrumentIds) await sb(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${id}`, { method: 'DELETE' });
  if (snapId) await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`, { method: 'DELETE' });
  for (const id of cleanup.instrumentIds) await sb(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
  for (const id of cleanup.accountIds) await sb(`/rest/v1/ii_accounts?id=eq.${id}`, { method: 'DELETE' });
  for (const id of cleanup.userIds) await sb(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.status.padEnd(40)} ${r.id} ${r.description}`);
  const genuineFailures = results.filter((r) => r.status === 'FAIL');
  console.log(`\n${results.length} checks run, ${genuineFailures.length} genuine failures, cleanup issued for ${cleanup.userIds.length} synthetic users / ${cleanup.instrumentIds.length} instruments / ${cleanup.accountIds.length} accounts.`);
  process.exit(genuineFailures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
