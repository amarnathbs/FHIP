// Investment Intelligence R12 — Live DEV verification, real Supabase, real
// synthetic users, real JWTs, real RLS. Run against the CURRENT (pre-0092)
// DEV schema — this session has no DDL execution capability against the
// hosted Supabase project (confirmed via scripts/fdh1_closure_capability_probe.mjs:
// no exec_sql/execute_sql/run_sql/admin_exec RPC exists, and PostgREST does
// not expose a DDL path). Migration 0092 has NOT been applied to DEV.
//
// UPDATE 2026-08-27 (terminal certification continuation): a fresh re-run
// of LIVE-R12-02 found the same-user holding forgery is now BLOCKED on
// DEV (the PATCH returns HTTP 200 -- PostgREST's normal "matched but
// nothing writable" response under the current SELECT-only owner policy
// -- but the ground-truth persisted value is independently confirmed
// UNCHANGED, not merely inferred from the HTTP status). This is migration
// 0094's fix (extracted from this file's own original 0092 draft and
// shipped standalone, see 0092's own file header) -- 0094 has evidently
// already been applied to DEV independently of 0092/R12 (most likely as
// part of the standalone production hotfix rollout this repo's history
// shows for 0094). The comments and labels below were written when 0094
// was not yet live on DEV; they are corrected in-place rather than
// silently rewritten, per this project's honesty standard.
//
// Scope of what CAN be verified live, honestly, without 0092:
//   LIVE-R12-01  Existing mutual-fund regression (unchanged pre-R12 schema/RLS)
//   LIVE-R12-02  SAME-USER HOLDING FORGERY on ii_holding_snapshots — as of
//                2026-08-27, CONFIRMED BLOCKED live on DEV (0094 already
//                applied there, independently of 0092/R12)
//   LIVE-R12-03  Cross-user holding access — already blocked pre-0092 (the
//                ownership USING clause was always correct; only the
//                COLUMN-level same-user forgery was the gap, and that gap
//                is now also closed per LIVE-R12-02 above)
//   LIVE-R12-04  Same ISIN, two exchange identifiers -> one canonical
//                instrument (structurally available since migration 0031,
//                does not need 0092)
//   LIVE-R12-05  >1000-row real REST pagination proof against a genuine
//                DEV table (spec section 25's ">1000-economic-result-proof"
//                inventory item) -- does not need 0092 either
//
// What CANNOT be verified live this round (needs 0092 applied to DEV first):
//   the 'sale' transaction_type, the price_source column, the
//   ii_scheme_tax_classification 'direct_listed_security_rule' basis, and
//   the actual manual-entry equity/ETF creation API path. See
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
  // HARDENING (2026-08-27, found during this continuation's own DEV
  // cleanup re-verification): an earlier run of this exact script threw
  // partway through (an invalid identifier_scheme value on the first
  // attempt at the LIVE-R12-05 seed) and, because cleanup previously lived
  // at the tail of a single linear function body, the thrown error skipped
  // cleanup entirely -- leaving real synthetic users/instruments/accounts
  // on DEV until independently found and manually removed. Wrapped in
  // try/finally so cleanup always runs, success or failure.
  let snapId;

  try {
  // --- LIVE-R12-01: existing mutual-fund regression -----------------------
  const userA = await makeUser('mf-regression-a');
  const acc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'mf_folio', institution_name: 'HDFC Mutual Fund', country_code: 'IN', currency_code: 'INR', folio_number: `R12-MF-${stamp}`, status: 'active' } });
  const accId = acc.json?.[0]?.id;
  cleanup.accountIds.push(accId);
  const instr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R12 Regression Test Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
  const instrId = instr.json?.[0]?.id;
  cleanup.instrumentIds.push(instrId);
  const snap = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: accId, instrument_id: instrId, as_of_date: '2026-06-30', units: 100, value: 15000, currency_code: 'INR', quality_status: 'certified' } });
  snapId = snap.json?.[0]?.id;
  const readOwn = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=id,units,value`, { accessToken: userA.accessToken });
  record('LIVE-R12-01', 'existing mutual-fund holding still readable by its owner (unchanged pre-R12 behaviour)', readOwn.ok && readOwn.json?.length === 1 ? 'PASS' : 'FAIL', JSON.stringify(readOwn.json));

  // --- LIVE-R12-02: SAME-USER HOLDING FORGERY -- 0094's fix, confirmed live on DEV 2026-08-27 ---
  const forgeAttempt = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`, { accessToken: userA.accessToken, method: 'PATCH', body: { value: 999999999, units: 1 } });
  const verifyForged = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}&select=value,units`);
  const forged = verifyForged.json?.[0]?.value === 999999999;
  record(
    'LIVE-R12-02',
    "SAME-USER HOLDING FORGERY on ii_holding_snapshots -- 0094's fix (HTTP 200 is PostgREST's normal 'matched, nothing writable' response; ground truth independently verified unchanged, not inferred from status alone)",
    forged ? 'RED (real, live -- 0094 protection is NOT active on this DEV project right now, investigate immediately)' : 'GREEN-CONFIRMED (real, live, 2026-08-27 -- 0094 already applied to DEV, forgery blocked, ground truth unchanged)',
    `PATCH http ${forgeAttempt.status}; row now reads value=${verifyForged.json?.[0]?.value}, units=${verifyForged.json?.[0]?.units}`
  );
  // Trusted positive control (spec Stage A step 7's second half): the
  // SAME field a same-user forgery cannot touch must still be writable by
  // the trusted/service-role path -- see LIVE-R12-02-restore immediately
  // below, which performs exactly that write and verifies it lands.
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

  // --- LIVE-R12-05: >1000-row real REST pagination proof (spec section 25's
  // ">1000-economic-result-proof" inventory item) -- against a genuine DEV
  // table, no 0092 schema needed. Seeds 1005 real ii_instrument_identifiers
  // rows for one synthetic instrument (a real, if artificial, "many rows for
  // one economic entity" shape) with a distinguishing identifier value on
  // the LAST row (row 1005, past PostgREST's 1000-row page cap), then proves
  // a naive single-page real REST call misses it while full pagination
  // (the same fetchAllRows contract certified in
  // tests/unit/iiR12PaginationScaleCertification.test.ts) finds it.
  const scaleInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: 'R12 Scale Test Instrument', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
  const scaleInstrId = scaleInstr.json?.[0]?.id;
  cleanup.instrumentIds.push(scaleInstrId);
  const SCALE_N = 1005;
  const BATCH = 200;
  const scaleRows = [];
  for (let i = 0; i < SCALE_N; i++) {
    scaleRows.push({
      instrument_id: scaleInstrId,
      identifier_scheme: 'internal_provisional',
      identifier_value: i === SCALE_N - 1 ? `PAST-PAGE-1-MARKER-${stamp}` : `noise-${stamp}-${i}`,
      country_code: 'IN',
    });
  }
  for (let i = 0; i < scaleRows.length; i += BATCH) {
    const chunk = scaleRows.slice(i, i + BATCH);
    const ins = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', prefer: 'return=minimal', body: chunk });
    if (ins.status >= 400) throw new Error(`LIVE-R12-05 seed failed at batch ${i}: ${ins.status} ${ins.text}`);
  }
  // Naive single-page read (real REST, real PostgREST default cap).
  const naivePage = await sb(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${scaleInstrId}&select=identifier_value&order=identifier_value.asc`);
  const naiveFound = (naivePage.json ?? []).some((r) => r.identifier_value === `PAST-PAGE-1-MARKER-${stamp}`);
  const naiveCount = (naivePage.json ?? []).length;
  // Full pagination via real Range-header-driven REST calls (same technique fetchAllRows uses).
  let fullRows = [];
  for (let from = 0; ; from += 1000) {
    const rangedPage = await sb(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${scaleInstrId}&select=identifier_value&order=identifier_value.asc&limit=1000&offset=${from}`);
    if (!rangedPage.json || rangedPage.json.length === 0) break;
    fullRows = fullRows.concat(rangedPage.json);
    if (rangedPage.json.length < 1000) break;
  }
  const fullFound = fullRows.some((r) => r.identifier_value === `PAST-PAGE-1-MARKER-${stamp}`);
  record(
    'LIVE-R12-05',
    `>1000-row real REST pagination: seeded ${SCALE_N} real ii_instrument_identifiers rows for one instrument, distinguishing marker at row ${SCALE_N} (past the 1000-row page)`,
    (naiveCount <= 1000 && !naiveFound && fullRows.length === SCALE_N && fullFound) ? 'PASS (RED->GREEN both proven live)' : 'FAIL',
    `naive single-page: ${naiveCount} rows, marker found=${naiveFound} (expected false); full pagination: ${fullRows.length} rows, marker found=${fullFound} (expected true)`
  );

  } finally {
    // --- Cleanup: synthetic R12 certification data only, ALWAYS attempted,
    // success or failure above (see the hardening note at the top of main()).
    // Retries the holding-snapshot delete FIRST (it FK-blocks instrument
    // deletion) then instruments/accounts/users, and never lets one failed
    // delete abort the rest -- every step is individually wrapped.
    async function safeDelete(path) {
      try {
        const r = await sb(path, { method: 'DELETE' });
        if (r.status >= 400) console.error(`  cleanup WARNING: DELETE ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
      } catch (e) {
        console.error(`  cleanup WARNING: DELETE ${path} threw: ${e.message}`);
      }
    }
    if (snapId) await safeDelete(`/rest/v1/ii_holding_snapshots?id=eq.${snapId}`);
    for (const id of cleanup.instrumentIds) await safeDelete(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${id}`);
    for (const id of cleanup.instrumentIds) await safeDelete(`/rest/v1/ii_instruments?id=eq.${id}`);
    for (const id of cleanup.accountIds) await safeDelete(`/rest/v1/ii_accounts?id=eq.${id}`);
    for (const id of cleanup.userIds) await safeDelete(`/auth/v1/admin/users/${id}`);

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.status.padEnd(40)} ${r.id} ${r.description}`);
    const genuineFailures = results.filter((r) => r.status === 'FAIL');
    console.log(`\n${results.length} checks run, ${genuineFailures.length} genuine failures, cleanup issued for ${cleanup.userIds.length} synthetic users / ${cleanup.instrumentIds.length} instruments / ${cleanup.accountIds.length} accounts.`);
    if (genuineFailures.length > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
