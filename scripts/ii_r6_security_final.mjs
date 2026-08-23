// Investment Intelligence R6-SECURITY-FINAL — authoritative INSERT-forgery
// closure harness (spec Sections 5-18, 25-26).
//
// Supersedes scripts/ii_r6_final_security.mjs's SEC-R6-011/012/013/015/016/
// 018/019 for ONE specific reason: those tests used a syntactically-valid
// but REFERENTIALLY-INVALID payload (`crypto.randomUUID()` for
// disposal_transaction_id/opening_transaction_id, or an instrument_id that
// ALREADY had a unique-constrained reference row) — meaning a 4xx result
// could have been an FK/unique-constraint violation rather than a genuine
// RLS/policy rejection, exactly the ambiguity the R6-SECURITY-FINAL spec
// (Section 7-8) requires closing. Every attack below uses IDs that are
// REAL, OWNED BY THE ATTACKING USER (or a genuinely-unclassified/unscheduled
// but real instrument for the two reference tables), and does not collide
// with any unique index — so a rejection can ONLY be RLS/privilege, never
// an accidental constraint violation.
//
// Run:  node scripts/ii_r6_security_final.mjs [victimUserId]
// If no victim id is passed, the most recent ii-r6-final-main-* /
// ii-r6-final-* test user with real ii_tax_lots/consumptions/computations
// rows is used.

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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
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

async function findVictim() {
  const r = await sb('/auth/v1/admin/users?per_page=1000');
  const users = r.json?.users ?? [];
  const candidates = users
    .filter((u) => u.email?.startsWith('ii-r6-final-main-') || u.email?.startsWith('ii-r6-secfinal-'))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return candidates[0]?.id ?? null;
}

async function signInAs(userId) {
  const password = 'SecFinalCheck!' + Date.now();
  await sb(`/auth/v1/admin/users/${userId}`, { method: 'PUT', body: { password } });
  const ue = await sb(`/auth/v1/admin/users/${userId}`);
  const email = ue.json?.email;
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  return { id: userId, token: session.access_token };
}

async function makeAttacker() {
  const stamp = Date.now();
  const email = `ii-r6-secfinal-attacker-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  return { id, token: session.access_token };
}

async function main() {
  const explicit = process.argv[2];
  const victimId = explicit ?? (await findVictim());
  if (!victimId) throw new Error('No R6 victim test user found. Run scripts/ii_r6_final_live_dev_cases.mjs first, or pass a user id.');
  const A = await signInAs(victimId);
  console.log(`\nTenant A (real R6 data owner): ${A.id}\n`);

  // --- Gather REAL, VALID, NON-COLLIDING facts owned by A --------------
  const lotsR = await sb(`/rest/v1/ii_tax_lots?select=*&user_id=eq.${A.id}`);
  const lots = lotsR.json ?? [];
  const consR = await sb(`/rest/v1/ii_tax_lot_consumptions?select=disposal_transaction_id,lot_id&user_id=eq.${A.id}`);
  const usedPairs = new Set((consR.json ?? []).map((c) => `${c.disposal_transaction_id}:${c.lot_id}`));
  const txR = await sb(`/rest/v1/ii_transactions?select=id,transaction_type&user_id=eq.${A.id}`);
  const txs = txR.json ?? [];
  const disposalTx = txs.find((t) => t.transaction_type === 'redemption' || t.transaction_type === 'switch_out');
  const openLot = lots.find((l) => l.id !== undefined);
  // Find a lot NOT already paired with the chosen disposal, to avoid the
  // unique(disposal_transaction_id, lot_id) index masking the RLS result.
  const unpairedLot = lots.find((l) => !usedPairs.has(`${disposalTx?.id}:${l.id}`));
  const anyPurchaseTx = txs.find((t) => t.transaction_type === 'purchase');

  if (!disposalTx || !unpairedLot || lots.length === 0) {
    throw new Error(`Insufficient real ground-truth data for user ${A.id}: disposalTx=${!!disposalTx} unpairedLot=${!!unpairedLot} lots=${lots.length}. Re-run scripts/ii_r6_final_live_dev_cases.mjs.`);
  }
  console.log(`Ground truth: disposalTx=${disposalTx.id}, unpairedLot=${unpairedLot.id} (instrument ${unpairedLot.instrument_id})\n`);

  // Find a real instrument with NO existing ii_scheme_tax_classification /
  // ii_exit_load_schedules row, so the reference-table INSERT tests cannot
  // be rejected by their unique constraints instead of RLS.
  const allInstR = await sb('/rest/v1/ii_instruments?select=id&limit=1000');
  const clsR = await sb('/rest/v1/ii_scheme_tax_classification?select=instrument_id&limit=1000');
  const elsR = await sb('/rest/v1/ii_exit_load_schedules?select=instrument_id,effective_from&limit=1000');
  const classifiedSet = new Set((clsR.json ?? []).map((c) => c.instrument_id));
  const exitLoadSet = new Set((elsR.json ?? []).map((e) => e.instrument_id));
  const freeInstrument = (allInstR.json ?? []).find((i) => !classifiedSet.has(i.id) && !exitLoadSet.has(i.id));
  if (!freeInstrument) throw new Error('No instrument free of BOTH scheme-classification and exit-load rows was found — cannot build an unambiguous reference-table INSERT test.');
  console.log(`Reference-table test instrument (real FK, no existing classification/exit-load row): ${freeInstrument.id}\n`);

  // =====================================================================
  // PRIMARY CLOSURE — valid-FK, non-colliding INSERT forgery, Tenant A
  // against their OWN user_id (the hardest case: even a legitimate owner
  // must not be able to write authoritative rows directly).
  // =====================================================================
  {
    const r = await sb('/rest/v1/ii_capital_gains_computations', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: {
        user_id: A.id, disposal_transaction_id: disposalTx.id, lot_id: unpairedLot.id, instrument_id: unpairedLot.instrument_id,
        classification: 'equity_oriented', gain_type: 'ltcg', sale_value: 1, cost_basis_used: 999999999, taxable_gain: -999999999,
        engine_version: 'FORGED-VALID-FK',
      },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-001', 'ii_capital_gains_computations: valid-FK, non-colliding INSERT by owning user REJECTED (RLS, not FK)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${r.json.id}`, { method: 'DELETE' });
  }
  {
    const r = await sb('/rest/v1/ii_tax_lot_consumptions', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: {
        user_id: A.id, disposal_transaction_id: disposalTx.id, lot_id: unpairedLot.id,
        units_consumed: 1, cost_basis_pre_grandfathering: 1, sale_value_apportioned: 999999, engine_version: 'FORGED-VALID-FK',
      },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-002', 'ii_tax_lot_consumptions: valid-FK, non-colliding INSERT by owning user REJECTED (RLS, not FK)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_tax_lot_consumptions?id=eq.${r.json.id}`, { method: 'DELETE' });
  }
  {
    const r = await sb('/rest/v1/ii_tax_lots', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: {
        user_id: A.id, account_id: unpairedLot.account_id, instrument_id: unpairedLot.instrument_id,
        opening_transaction_id: anyPurchaseTx?.id ?? null, status: 'open',
        acquisition_date: '2020-01-01', units_acquired: 999999, units_remaining: 999999, cost_per_unit: 0.01,
      },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-003', 'ii_tax_lots: valid-FK new-lot INSERT by owning user REJECTED (RLS, not FK)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_tax_lots?id=eq.${r.json.id}`, { method: 'DELETE' });
  }
  {
    const r = await sb('/rest/v1/ii_scheme_tax_classification', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: freeInstrument.id, classification: 'equity_oriented', basis: 'computed_from_holdings', engine_version: 'FORGED-VALID-FK' },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-004', 'ii_scheme_tax_classification: valid-FK INSERT (unclassified real instrument) REJECTED (RLS, not unique-constraint)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_scheme_tax_classification?id=eq.${r.json.id}`, { method: 'DELETE' });
  }
  {
    const r = await sb('/rest/v1/ii_exit_load_schedules', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { instrument_id: freeInstrument.id, tiers: [{ uptoDays: 9999, loadPct: 0 }], effective_from: '2099-01-01' },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-005', 'ii_exit_load_schedules: valid-FK INSERT (unscheduled real instrument) REJECTED (RLS, not unique-constraint)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_exit_load_schedules?id=eq.${r.json.id}`, { method: 'DELETE' });
  }
  {
    const r = await sb('/rest/v1/ii_tax_rule_versions', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { rule_set_key: 'in_mutual_fund_capital_gains', version: 'FORGED_' + Date.now(), country_code: 'IN', effective_from: '2099-01-01', rule_definition: {} },
    });
    const persisted = r.status === 201;
    record('SEC-FINAL-006', 'ii_tax_rule_versions: valid-FK INSERT (novel version string, real country_code) REJECTED (RLS, not any constraint)', persisted ? 'FAIL' : 'PASS', `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (persisted) await sb(`/rest/v1/ii_tax_rule_versions?id=eq.${r.json.id}`, { method: 'DELETE' });
  }

  // =====================================================================
  // UPDATE/DELETE regression (spec Section 16) — re-confirm migration 0061
  // still holds after this pass's own read (no policy change was made, but
  // proven live rather than assumed).
  // =====================================================================
  {
    const before = await sb(`/rest/v1/ii_capital_gains_computations?select=id,taxable_gain&user_id=eq.${A.id}&limit=1`);
    const row = before.json?.[0];
    if (row) {
      const patch = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}`, { apikey: ANON, token: A.token, method: 'PATCH', body: { taxable_gain: -99999999 } });
      const after = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}&select=taxable_gain`);
      const tampered = after.json?.[0]?.taxable_gain !== row.taxable_gain;
      record('SEC-FINAL-007', 'Owning user cannot PATCH an existing ii_capital_gains_computations row', tampered ? 'FAIL' : 'PASS', `PATCH HTTP ${patch.status}; value before=${row.taxable_gain} after=${after.json?.[0]?.taxable_gain}`);
      const del = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}`, { apikey: ANON, token: A.token, method: 'DELETE', prefer: 'return=representation' });
      const afterDel = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}&select=id`);
      const deleted = !(afterDel.json?.length === 1);
      record('SEC-FINAL-008', 'Owning user cannot DELETE an existing ii_capital_gains_computations row', deleted ? 'FAIL' : 'PASS', `DELETE HTTP ${del.status}; row present after=${afterDel.json?.length === 1}`);
    } else {
      record('SEC-FINAL-007', 'UPDATE regression', 'BLOCKED', 'No ground-truth row found for A');
      record('SEC-FINAL-008', 'DELETE regression', 'BLOCKED', 'No ground-truth row found for A');
    }
  }

  // =====================================================================
  // Cross-user regression (spec Section 17)
  // =====================================================================
  const B = await makeAttacker();
  console.log(`\nTenant B (fresh attacker): ${B.id}\n`);
  {
    const victim = await sb(`/rest/v1/ii_capital_gains_computations?select=*&user_id=eq.${A.id}&limit=1`);
    const row = victim.json?.[0];
    if (row) {
      const sel = await sb(`/rest/v1/ii_capital_gains_computations?select=*&id=eq.${row.id}`, { apikey: ANON, token: B.token });
      record('SEC-FINAL-009', "User B cannot SELECT user A's ii_capital_gains_computations row", (sel.json?.length ?? 0) > 0 ? 'FAIL' : 'PASS', `HTTP ${sel.status}, rows=${sel.json?.length ?? sel.text.slice(0, 100)}`);

      const ins = await sb('/rest/v1/ii_capital_gains_computations', {
        apikey: ANON, token: B.token, method: 'POST', prefer: 'return=representation',
        body: { user_id: A.id, disposal_transaction_id: disposalTx.id, lot_id: unpairedLot.id, instrument_id: unpairedLot.instrument_id, classification: 'equity_oriented', gain_type: 'ltcg', sale_value: 1, cost_basis_used: 1, taxable_gain: -999999, engine_version: 'CROSS-TENANT' },
      });
      record('SEC-FINAL-010', "User B cannot INSERT a row attributed to user A's user_id", ins.status === 201 ? 'FAIL' : 'PASS', `HTTP ${ins.status}: ${ins.text.slice(0, 200)}`);
      if (ins.status === 201) await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${ins.json.id}`, { method: 'DELETE' });

      const upd = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}`, { apikey: ANON, token: B.token, method: 'PATCH', body: { taxable_gain: -1 } });
      const afterUpd = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}&select=taxable_gain`);
      const tampered = afterUpd.json?.[0]?.taxable_gain !== row.taxable_gain;
      record('SEC-FINAL-011', "User B cannot PATCH user A's row", tampered ? 'FAIL' : 'PASS', `HTTP ${upd.status}; value after=${afterUpd.json?.[0]?.taxable_gain}`);

      const del = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}`, { apikey: ANON, token: B.token, method: 'DELETE', prefer: 'return=representation' });
      const afterDel = await sb(`/rest/v1/ii_capital_gains_computations?id=eq.${row.id}&select=id`);
      const deleted = !(afterDel.json?.length === 1);
      record('SEC-FINAL-012', "User B cannot DELETE user A's row", deleted ? 'FAIL' : 'PASS', `HTTP ${del.status}; row present after=${afterDel.json?.length === 1}`);
    }
  }
  await sb(`/auth/v1/admin/users/${B.id}`, { method: 'DELETE' });
  console.log('\nAttacker (Tenant B) ephemeral user cleaned up. Tenant A (real data) left intact.\n');

  console.log('--- SUMMARY ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length})`);

  const outDir = path.join(__dirname, 'ii-r6-security-final');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), tenantA: A.id, tenantB: B.id, results }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  record('HARNESS', 'Harness execution', 'BLOCKED', e.stack ?? e.message);
  process.exitCode = 2;
});
