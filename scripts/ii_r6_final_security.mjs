// Investment Intelligence R6-FINAL — live-DEV security harness
// (spec Sections 35-38).
//
// Tenant A = the real LIVE-R6-001..010 test user (real victim rows across
// all 4 new R6 tables, seeded by scripts/ii_r6_final_live_dev_cases.mjs —
// pass that user's id as argv[3], or this script looks up the most
// recently created ii-r6-final-main-* user itself).
// Tenant B = a fresh ephemeral attacker user created by this script.
//
// FAIL-CLOSED CONVENTION (same as every prior R1/R4/R5 live-security pack
// this session has built): no placeholder BLOCKED where a genuine
// attempted-and-observed HTTP call is possible. Every claim below is a real
// request against real DEV, with a real DB ground-truth check.
//
// Run:  node scripts/ii_r6_final_security.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';

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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
}

async function sb(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const createdUsers = [];
async function makeUser(tag) {
  const email = `ii-r6-final-sec-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  createdUsers.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, token: session.access_token, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function findMostRecentLiveR6MainUser() {
  // Falls back to searching auth admin users for the most recent ii-r6-final-main-* email.
  const r = await sb('/auth/v1/admin/users?per_page=1000', { method: 'GET' });
  const users = r.json?.users ?? [];
  const candidates = users.filter((u) => u.email?.startsWith('ii-r6-final-main-')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return candidates[0]?.id ?? null;
}

async function main() {
  const explicitVictimId = process.argv[3];
  const victimId = explicitVictimId ?? (await findMostRecentLiveR6MainUser());
  if (!victimId) throw new Error('No LIVE-R6 victim user found — run scripts/ii_r6_final_live_dev_cases.mjs first, or pass the user id as argv[3].');

  // Sign in AS the victim by resetting their password (service role can do
  // this for a DEV test user we ourselves created) — needed to also test
  // "A CAN read their own data" as a positive control alongside B's attacks.
  const newPassword = 'SecCheck!' + stamp;
  await sb(`/auth/v1/admin/users/${victimId}`, { method: 'PUT', body: { password: newPassword } });
  const victimEmailR = await sb(`/auth/v1/admin/users/${victimId}`);
  const victimEmail = victimEmailR.json?.email;
  const signInA = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: victimEmail, password: newPassword }) });
  const sessionA = await signInA.json();
  const A = { id: victimId, token: sessionA.access_token, cookie: `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(sessionA), 'utf8').toString('base64')}` };
  const B = await makeUser('attacker');

  console.log(`\nTenant A (real LIVE-R6 victim): ${A.id}\nTenant B (fresh attacker): ${B.id}\n`);

  // Real victim ground-truth rows.
  const victimClaimRow = await sb(`/rest/v1/ii_capital_gains_computations?select=*&user_id=eq.${A.id}&limit=1`);
  const victimClaim = victimClaimRow.json?.[0];
  const victimLotRow = await sb(`/rest/v1/ii_tax_lots?select=*&user_id=eq.${A.id}&limit=1`);
  const victimLot = victimLotRow.json?.[0];
  const victimConsumptionRow = await sb(`/rest/v1/ii_tax_lot_consumptions?select=*&user_id=eq.${A.id}&limit=1`);
  const victimConsumption = victimConsumptionRow.json?.[0];
  if (!victimClaim || !victimLot || !victimConsumption) {
    throw new Error(`Victim ground-truth rows missing — capital_gains=${!!victimClaim} lot=${!!victimLot} consumption=${!!victimConsumption}. Re-run scripts/ii_r6_final_live_dev_cases.mjs.`);
  }
  console.log(`Ground truth: computation=${victimClaim.id}, lot=${victimLot.id}, consumption=${victimConsumption.id}\n`);

  // ===========================================================================
  // Section 36 — cross-user reads (B cannot read A's data).
  // ===========================================================================
  {
    const r = await sb(`/rest/v1/ii_capital_gains_computations?select=*&id=eq.${victimClaim.id}`, { apikey: ANON, token: B.token });
    const leaked = Array.isArray(r.json) && r.json.length > 0;
    record('SEC-R6-001', "User B cannot READ user A's ii_capital_gains_computations row (direct PostgREST)", leaked ? 'FAIL' : 'PASS', `HTTP ${r.status}, rows=${Array.isArray(r.json) ? r.json.length : r.text.slice(0, 150)}`);
  }
  {
    const r = await sb(`/rest/v1/ii_tax_lots?select=*&id=eq.${victimLot.id}`, { apikey: ANON, token: B.token });
    const leaked = Array.isArray(r.json) && r.json.length > 0;
    record('SEC-R6-002', "User B cannot READ user A's ii_tax_lots row (direct PostgREST)", leaked ? 'FAIL' : 'PASS', `HTTP ${r.status}, rows=${Array.isArray(r.json) ? r.json.length : r.text.slice(0, 150)}`);
  }
  {
    const r = await sb(`/rest/v1/ii_tax_lot_consumptions?select=*&id=eq.${victimConsumption.id}`, { apikey: ANON, token: B.token });
    const leaked = Array.isArray(r.json) && r.json.length > 0;
    record('SEC-R6-003', "User B cannot READ user A's ii_tax_lot_consumptions row (direct PostgREST)", leaked ? 'FAIL' : 'PASS', `HTTP ${r.status}, rows=${Array.isArray(r.json) ? r.json.length : r.text.slice(0, 150)}`);
  }
  {
    // App-level: B's own tax/summary call must never include A's disposal ids.
    const r = await app('/api/investment-intelligence/tax/summary', { cookie: B.cookie });
    const ids = (r.json?.data?.disposalResults ?? []).map((d) => d.instrumentId);
    const leaked = ids.length > 0; // B has no transactions at all — any non-empty result is a leak
    record('SEC-R6-004', "User B's own tax/summary call returns EMPTY (no bleed-through of A's disposals) via the real app route", leaked ? 'FAIL' : 'PASS', `B disposalResults count=${ids.length}, HTTP ${r.status}`);
  }
  {
    // A CAN read their own data (positive control — proves SEC-R6-001 isn't blocking everyone).
    const r = await sb(`/rest/v1/ii_capital_gains_computations?select=id&id=eq.${victimClaim.id}`, { apikey: ANON, token: A.token });
    const ok = Array.isArray(r.json) && r.json.length === 1;
    record('SEC-R6-005', 'User A CAN read their own ii_capital_gains_computations row (positive control)', ok ? 'PASS' : 'FAIL', `HTTP ${r.status}, rows=${Array.isArray(r.json) ? r.json.length : r.text.slice(0, 150)}`);
  }
  {
    // App-level: A's real tax/summary DOES include their own real data.
    const r = await app('/api/investment-intelligence/tax/summary', { cookie: A.cookie });
    const has = (r.json?.data?.disposalResults ?? []).length > 0;
    record('SEC-R6-006', "User A's own tax/summary call DOES return their real disposal data (positive control)", has ? 'PASS' : 'FAIL', `A disposalResults count=${(r.json?.data?.disposalResults ?? []).length}`);
  }
  {
    // Redemption simulation against A's instrument, called AS B — must be
    // rejected (B has no holdings in that instrument at all).
    const instId = victimLot.instrument_id;
    const r = await app('/api/investment-intelligence/tax/redemption-simulation', { cookie: B.cookie, method: 'POST', body: { instrumentId: instId, units: 10, pricePerUnit: 100, disposalDate: '2026-08-22' } });
    const blocked = r.status >= 400;
    record('SEC-R6-007', "User B cannot simulate a redemption against user A's instrument/holdings (no holdings of their own)", blocked ? 'PASS' : 'FAIL', `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  {
    // Household/owner spoofing: B tries to pass A's user_id explicitly as a
    // body field to an endpoint that should NEVER read a client-supplied
    // user id (redemption-simulation has no such field, but tax/profile PUT
    // does accept a body — confirm it can't be used to write AS another user
    // by attempting a profile PUT and then checking whose profile actually
    // got written).
    await app('/api/investment-intelligence/tax/profile', { cookie: B.cookie, method: 'PUT', body: { taxpayerType: 'RESIDENT_INDIVIDUAL', userId: A.id, user_id: A.id } });
    const gt = await sb(`/rest/v1/ii_tax_profiles?select=user_id&user_id=eq.${A.id}`);
    const spoofed = Array.isArray(gt.json) && gt.json.length > 0 && gt.json.some((r) => r.user_id === A.id);
    // Since migration 0060 is not applied, this PUT is expected to fail
    // gracefully (503) either way — but the check below is what actually
    // matters: A's profile row must never appear as a side effect of B's call.
    record('SEC-R6-008', "User B's tax-profile PUT, even with a spoofed A user_id in the body, never writes a profile row attributed to A", spoofed ? 'FAIL' : 'PASS', `A profile rows found after B's spoofed PUT: ${Array.isArray(gt.json) ? gt.json.length : gt.text.slice(0, 150)}`);
  }
  {
    // Unauthenticated (no cookie at all) is blocked on every R6 app route.
    const routes = ['/api/investment-intelligence/tax/summary', '/api/investment-intelligence/tax/lots', '/api/investment-intelligence/tax/profile', '/api/investment-intelligence/tax/cost-intelligence'];
    const probes = [];
    for (const route of routes) {
      const r = await fetch(`${APP}${route}`);
      probes.push(`${route}: HTTP ${r.status}`);
    }
    const allBlocked = probes.every((p) => /HTTP (401|403|302|307)/.test(p));
    record('SEC-R6-009', 'Every R6 app route rejects/redirects an unauthenticated request', allBlocked ? 'PASS' : 'FAIL', probes.join(' | '));
  }
  {
    // Error-response leak check: B's forbidden reads must not leak A's data in the error body itself.
    const r = await sb(`/rest/v1/ii_capital_gains_computations?select=*&id=eq.${victimClaim.id}`, { apikey: ANON, token: B.token });
    const leaksTaxableGain = r.text.includes(String(victimClaim.taxable_gain));
    record('SEC-R6-010', "Blocked cross-tenant read's error/empty response body does not leak A's taxable_gain value", leaksTaxableGain ? 'FAIL' : 'PASS', `response body: ${r.text.slice(0, 150)}`);
  }

  // ===========================================================================
  // Section 37 — SAME-USER FORGERY ATTACKS (hard gate). Authenticated as A
  // (a NORMAL user, not anon/service-role), attempt direct PostgREST writes
  // to every R6 table. ANY success here is an R6 FAIL condition.
  // ===========================================================================
  {
    const forgedId = crypto.randomUUID();
    const r = await sb('/rest/v1/ii_tax_lots', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { id: forgedId, user_id: A.id, account_id: victimLot.account_id, instrument_id: victimLot.instrument_id, opening_transaction_id: crypto.randomUUID(), status: 'open', acquisition_date: '2020-01-01', units_acquired: 999999, units_remaining: 999999, cost_per_unit: 0.01 },
    });
    record('SEC-R6-011 (HARD GATE)', 'Authenticated user A CANNOT directly forge a new ii_tax_lots row via PostgREST (even for their own user_id — writes must go through the server-side engine only)', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    const r = await sb('/rest/v1/ii_tax_lot_consumptions', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, disposal_transaction_id: crypto.randomUUID(), lot_id: victimLot.id, units_consumed: 1, cost_basis_pre_grandfathering: 1, sale_value_apportioned: 999999, engine_version: 'FORGED-BY-CLIENT' },
    });
    record('SEC-R6-012 (HARD GATE)', 'Authenticated user A CANNOT directly forge a ii_tax_lot_consumptions row via PostgREST', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    const r = await sb('/rest/v1/ii_capital_gains_computations', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, disposal_transaction_id: crypto.randomUUID(), lot_id: victimLot.id, instrument_id: victimLot.instrument_id, classification: 'equity_oriented', gain_type: 'ltcg', sale_value: 1, cost_basis_used: 999999999, taxable_gain: -999999999, engine_version: 'FORGED-BY-CLIENT' },
    });
    record('SEC-R6-013 (HARD GATE)', 'Authenticated user A CANNOT directly forge/tamper a ii_capital_gains_computations row via PostgREST (e.g. inject a fake huge loss)', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    // Tampering an EXISTING real row (not just inserting a new one).
    const r = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${victimClaim.id}`, { apikey: ANON, token: A.token, method: 'PATCH', body: { taxable_gain: -99999999 } });
    const after = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${victimClaim.id}&select=taxable_gain`);
    const tampered = after.json?.[0]?.taxable_gain === -99999999;
    record('SEC-R6-014 (HARD GATE)', 'Authenticated user A CANNOT tamper (PATCH) their own EXISTING ii_capital_gains_computations row via PostgREST', tampered ? 'FAIL' : 'PASS', `PATCH HTTP ${r.status}; current value after attempt: ${after.json?.[0]?.taxable_gain}`);
    if (tampered) {
      // Immediate restore — never leave forged data in DEV, regardless of the finding.
      await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${victimClaim.id}`, { method: 'PATCH', body: { taxable_gain: victimClaim.taxable_gain } });
    }
  }
  {
    // Same tamper attempt against ii_tax_lots (pre-existing R1 policy, same
    // "for all" shape — see migration 0061's finding writeup). Not
    // "beyond scope": this dispatch's own persistTaxLots() fix is what
    // makes this table's real financial state now genuinely tamperable.
    const r = await sb(`/rest/v1/ii_tax_lots?id=eq.${victimLot.id}`, { apikey: ANON, token: A.token, method: 'PATCH', body: { units_remaining: 999999 } });
    const after = await sb(`/rest/v1/ii_tax_lots?id=eq.${victimLot.id}&select=units_remaining`);
    const tampered = after.json?.[0]?.units_remaining === 999999;
    record('SEC-R6-014B (HARD GATE)', "Authenticated user A CANNOT tamper (PATCH) their own EXISTING ii_tax_lots row's units_remaining via PostgREST", tampered ? 'FAIL' : 'PASS', `PATCH HTTP ${r.status}; current value after attempt: ${after.json?.[0]?.units_remaining}`);
    if (tampered) {
      await sb(`/rest/v1/ii_tax_lots?id=eq.${victimLot.id}`, { method: 'PATCH', body: { units_remaining: victimLot.units_remaining } });
    }
  }
  {
    // Reference-data tables: ordinary user cannot write tax rules, scheme classification, or exit-load schedules.
    const r = await sb('/rest/v1/ii_tax_rule_versions', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { rule_set_key: 'in_mutual_fund_capital_gains', version: 'FORGED', country_code: 'IN', effective_from: '2099-01-01', rule_definition: {} },
    });
    record('SEC-R6-015 (HARD GATE)', 'Authenticated user A CANNOT insert a forged ii_tax_rule_versions row', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    const r = await sb('/rest/v1/ii_scheme_tax_classification', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: victimLot.instrument_id, classification: 'equity_oriented', basis: 'computed_from_holdings', engine_version: 'FORGED-BY-CLIENT' },
    });
    record('SEC-R6-016 (HARD GATE)', 'Authenticated user A CANNOT insert/reclassify a ii_scheme_tax_classification row', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    const r = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${victimLot.instrument_id}`, { apikey: ANON, token: A.token, method: 'PATCH', body: { classification: 'debt_specified' } });
    const gt = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${victimLot.instrument_id}&select=classification`);
    const tampered = gt.json?.[0]?.classification === 'debt_specified';
    record('SEC-R6-017 (HARD GATE)', 'Authenticated user A CANNOT tamper an EXISTING ii_scheme_tax_classification row (flip equity_oriented to debt_specified)', tampered ? 'FAIL' : 'PASS', `PATCH HTTP ${r.status}; current classification: ${gt.json?.[0]?.classification}`);
  }
  {
    const r = await sb('/rest/v1/ii_exit_load_schedules', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: victimLot.instrument_id, tiers: [{ uptoDays: 9999, loadPct: 0 }], effective_from: '2099-01-01' },
    });
    record('SEC-R6-018 (HARD GATE)', 'Authenticated user A CANNOT insert a forged ii_exit_load_schedules row', r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    // Cross-tenant forgery: B attempts to insert a row directly attributed to A's user_id.
    const r = await sb('/rest/v1/ii_capital_gains_computations', {
      apikey: ANON, token: B.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, disposal_transaction_id: crypto.randomUUID(), lot_id: victimLot.id, instrument_id: victimLot.instrument_id, classification: 'equity_oriented', gain_type: 'ltcg', sale_value: 1, cost_basis_used: 1, taxable_gain: -999999, engine_version: 'CROSS-TENANT-FORGE' },
    });
    record('SEC-R6-019 (HARD GATE)', "User B CANNOT insert a ii_capital_gains_computations row attributed to A's user_id (cross-tenant forgery)", r.status === 201 ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 250)}`);
  }
  {
    // Delete attack (HARD GATE, same class as SEC-R6-014): a genuine
    // server-authoritative row must never be directly DELETE-able by the
    // owning user either — the only sanctioned way to remove/replace it is
    // the server-side engine's own upsert.
    const r = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${victimClaim.id}`, { apikey: ANON, token: A.token, method: 'DELETE' });
    const after = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${victimClaim.id}&select=id`);
    const deleted = !(Array.isArray(after.json) && after.json.length === 1);
    record('SEC-R6-020 (HARD GATE)', "Authenticated user A CANNOT DELETE their own EXISTING ii_capital_gains_computations row via PostgREST", deleted ? 'FAIL' : 'PASS', `DELETE HTTP ${r.status}; row still present after attempt: ${!deleted}`);
    if (deleted) {
      // Restore with the SAME id — service-role insert can specify id explicitly.
      await sb('/rest/v1/ii_capital_gains_computations', { method: 'POST', body: victimClaim });
    }
  }

  console.log('\n--- SUMMARY ---');
  const pass = results.filter((r) => r.status === 'PASS' || String(r.status).startsWith('PASS')).length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`PASS=${pass} FAIL=${fail} (of ${results.length})`);

  fs.writeFileSync(path.join(__dirname, 'ii-r6-final-certification', 'security_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), tenantA: A.id, tenantB: B.id, results }, null, 2));
}

main()
  .catch((e) => {
    record('HARNESS', 'Harness execution', 'BLOCKED', e.stack ?? e.message);
    process.exitCode = 2;
  })
  .finally(async () => {
    for (const id of createdUsers) await sb(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    console.log('\nAttacker (Tenant B) ephemeral user cleaned up. Tenant A (real LIVE-R6 data) left intact.');
    const fail = results.filter((r) => r.status === 'FAIL').length;
    if (fail > 0) process.exitCode = 1;
  });
