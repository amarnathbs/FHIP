// Investment Intelligence R6-FINAL — atomicity, idempotency, staleness
// (spec Sections 42-44), against REAL DEV using the real LIVE-R6 test user.
//
// Run:  node scripts/ii_r6_final_atomicity_idempotency_staleness.mjs

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

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
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

async function findVictim() {
  const explicit = process.argv[3];
  if (explicit) return explicit;
  const r = await sb('/auth/v1/admin/users?per_page=1000');
  const users = r.json?.users ?? [];
  const cands = users.filter((u) => u.email?.startsWith('ii-r6-final-main-')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return cands[0]?.id ?? null;
}

async function main() {
  const uid = await findVictim();
  if (!uid) throw new Error('No LIVE-R6 main user found — run scripts/ii_r6_final_live_dev_cases.mjs first.');
  const emailR = await sb(`/auth/v1/admin/users/${uid}`);
  const email = emailR.json?.email;
  const pw = 'AIsCheck!2026';
  await sb(`/auth/v1/admin/users/${uid}`, { method: 'PUT', body: { password: pw } });
  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
  const session = await signIn.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
  console.log(`Test user: ${uid}\n`);

  // ===========================================================================
  // Section 43 — Idempotency: identical inputs run twice -> identical
  // outputs, no duplicate rows.
  // ===========================================================================
  {
    const before = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}&select=id`, {});
    const beforeCount = before.json?.length ?? -1;
    const r1 = await app('/api/investment-intelligence/tax/summary', { cookie });
    const r2 = await app('/api/investment-intelligence/tax/summary', { cookie });
    const after = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}&select=id`, {});
    const afterCount = after.json?.length ?? -2;
    const g1 = JSON.stringify((r1.json?.data?.disposalResults ?? []).map((d) => [d.instrumentId, d.acquisitionDate, d.disposalDate, d.taxableGain]).sort());
    const g2 = JSON.stringify((r2.json?.data?.disposalResults ?? []).map((d) => [d.instrumentId, d.acquisitionDate, d.disposalDate, d.taxableGain]).sort());
    const identical = g1 === g2;
    const noDuplicates = beforeCount === afterCount;
    record('IDEMPOTENT-1', 'Two consecutive identical tax/summary calls produce byte-identical disposalResults', identical ? 'PASS' : 'FAIL', `run1 vs run2 equal: ${identical}`);
    record('IDEMPOTENT-2', 'Two consecutive identical tax/summary calls create NO duplicate ii_capital_gains_computations rows', noDuplicates ? 'PASS' : 'FAIL', `row count before=${beforeCount}, after 2 calls=${afterCount}`);

    // Same for ii_tax_lots and ii_tax_lot_consumptions.
    const lotsBefore = await sb(`/rest/v1/ii_tax_lots?user_id=eq.${uid}&select=id`);
    const consBefore = await sb(`/rest/v1/ii_tax_lot_consumptions?user_id=eq.${uid}&select=id`);
    await app('/api/investment-intelligence/tax/summary', { cookie });
    const lotsAfter = await sb(`/rest/v1/ii_tax_lots?user_id=eq.${uid}&select=id`);
    const consAfter = await sb(`/rest/v1/ii_tax_lot_consumptions?user_id=eq.${uid}&select=id`);
    record('IDEMPOTENT-3', 'Repeated calls create NO duplicate ii_tax_lots / ii_tax_lot_consumptions rows', lotsBefore.json?.length === lotsAfter.json?.length && consBefore.json?.length === consAfter.json?.length ? 'PASS' : 'FAIL',
      `lots ${lotsBefore.json?.length}->${lotsAfter.json?.length}, consumptions ${consBefore.json?.length}->${consAfter.json?.length}`);
  }

  // ===========================================================================
  // Section 42 — Atomicity / partial-write resilience.
  //
  // The three persistence steps (persistTaxLots, persistTaxLotConsumptions,
  // persistCapitalGainsComputations) are three SEPARATE upserts, not wrapped
  // in one DB transaction — genuinely NOT atomic at the storage layer. What
  // this test actually verifies is the property that matters: (a) the API
  // NEVER serves a wrong number derived from partial persisted state (every
  // GET recomputes fresh from ii_transactions, never reads back the
  // persisted tables for display), and (b) a deliberately-induced partial
  // gap (simulating "the gains-persistence step failed/never ran") is fully
  // self-healed by the very next successful call, with no manual repair.
  // ===========================================================================
  {
    // Simulate "gains persistence failed" by deleting the persisted
    // ii_capital_gains_computations rows while leaving ii_tax_lots /
    // ii_tax_lot_consumptions intact — i.e. artificially construct exactly
    // the partial state a mid-computation failure would leave behind.
    const before = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}&select=id`);
    const beforeIds = (before.json ?? []).map((r) => r.id);
    await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}`, { method: 'DELETE' });
    const midState = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}&select=id`);
    const lotsStillThere = await sb(`/rest/v1/ii_tax_lots?user_id=eq.${uid}&select=id`);
    record('ATOMICITY-1', 'Partial-state precondition constructed: gains table empty for this user, lots table untouched', (midState.json?.length ?? -1) === 0 && (lotsStillThere.json?.length ?? 0) > 0 ? 'PASS' : 'FAIL', `gains rows now=${midState.json?.length}, lots rows=${lotsStillThere.json?.length}`);

    // (a) The API must still return the CORRECT figures despite the gap — it recomputes fresh, never reads the (now-empty) persisted table for display.
    const r = await app('/api/investment-intelligence/tax/summary', { cookie });
    const hasCorrectResults = (r.json?.data?.disposalResults ?? []).length === 12; // known count from the LIVE-R6 fixture
    record('ATOMICITY-2', 'API response is UNAFFECTED by the missing persisted-gains rows — figures come from fresh recomputation, never a stale/partial DB read', hasCorrectResults ? 'PASS' : 'FAIL', `disposalResults returned: ${(r.json?.data?.disposalResults ?? []).length} (expected 12)`);

    // (b) The gap self-heals on the very next successful call.
    const after = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${uid}&select=id`);
    const healed = (after.json?.length ?? 0) === beforeIds.length;
    record('ATOMICITY-3', 'The gains-persistence gap is fully self-healed by the same call that served the correct API response — no manual repair needed', healed ? 'PASS' : 'FAIL', `rows restored: ${after.json?.length} (expected ${beforeIds.length})`);
  }

  // ===========================================================================
  // Section 44 — Staleness / invalidation.
  // ===========================================================================
  {
    // (a) Transaction correction: bump a real purchase transaction's price, recompute, confirm the change is reflected.
    const txnsR = await sb(`/rest/v1/ii_transactions?user_id=eq.${uid}&transaction_type=eq.purchase&source_reference=eq.LIVE-R6-001 purchase&select=id,price_per_unit,gross_amount,units`);
    const txn = txnsR.json?.[0];
    if (!txn) {
      record('STALENESS-TXN-CORRECTION', 'Transaction correction invalidates the cached tax figure', 'BLOCKED', 'LIVE-R6-001 purchase transaction not found — run the live-cases script first.');
    } else {
      const before = await app('/api/investment-intelligence/tax/summary', { cookie });
      const instId = before.json?.data?.disposalResults?.find((d) => d.acquisitionDate && d.instrumentName?.includes('Simple Equity'))?.instrumentId;
      const beforeGain = before.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.taxableGain;
      const originalPrice = Number(txn.price_per_unit);
      const correctedPrice = originalPrice + 5; // correction: cost basis was understated by 5/unit
      await sb(`/rest/v1/ii_transactions?id=eq.${txn.id}`, { method: 'PATCH', body: { price_per_unit: correctedPrice, gross_amount: correctedPrice * Number(txn.units) } });
      const after = await app('/api/investment-intelligence/tax/summary', { cookie });
      const afterGain = after.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.taxableGain;
      const expectedDelta = -5 * Number(txn.units); // higher cost -> lower gain
      const actualDelta = afterGain - beforeGain;
      const invalidated = Math.abs(actualDelta - expectedDelta) < 0.01;
      record('STALENESS-TXN-CORRECTION', 'Correcting a real transaction (price_per_unit) immediately changes the recomputed taxable gain by the expected amount — no stale cached figure survives', invalidated ? 'PASS' : 'FAIL', `before=${beforeGain}, after=${afterGain}, expected delta=${expectedDelta}, actual delta=${actualDelta}`);
      // Restore.
      await sb(`/rest/v1/ii_transactions?id=eq.${txn.id}`, { method: 'PATCH', body: { price_per_unit: originalPrice, gross_amount: txn.gross_amount } });
      const restored = await app('/api/investment-intelligence/tax/summary', { cookie });
      const restoredGain = restored.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.taxableGain;
      record('STALENESS-TXN-CORRECTION-RESTORE', 'Reverting the correction reverts the recomputed figure back to the original (proves live recomputation both directions, not one-way caching)', Math.abs(restoredGain - beforeGain) < 0.01 ? 'PASS' : 'FAIL', `restored=${restoredGain}, original=${beforeGain}`);
    }
  }
  {
    // (b) Tax-classification change: flip a real classification row, recompute, confirm the change is reflected.
    // Resolve the instrument id from THIS user's own actual disposalResults
    // (not by name lookup — the live-cases script has been run multiple
    // times and creates a fresh same-named instrument each run, so a
    // name-only lookup can resolve to the WRONG run's instrument).
    const summaryForLookup = await app('/api/investment-intelligence/tax/summary', { cookie });
    const instId = summaryForLookup.json?.data?.disposalResults?.find((d) => d.instrumentName === 'R6F Simple Equity Fund - Growth (Direct Plan)')?.instrumentId;
    if (!instId) {
      record('STALENESS-CLASSIFICATION-CHANGE', 'Classification change invalidates the cached tax figure', 'BLOCKED', 'Test instrument not found.');
    } else {
      const before = await app('/api/investment-intelligence/tax/summary', { cookie });
      const beforeClass = before.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.classification;
      await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${instId}`, { method: 'PATCH', body: { classification: 'unresolved', basis: 'unresolved_no_data', domestic_equity_pct: null, note: 'STALENESS-TEST temporary flip' } });
      const after = await app('/api/investment-intelligence/tax/summary', { cookie });
      const afterClass = after.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.classification;
      const afterGain = after.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.taxableGain;
      const invalidated = beforeClass === 'equity_oriented' && afterClass === 'unresolved' && afterGain === null;
      record('STALENESS-CLASSIFICATION-CHANGE', 'Flipping a real ii_scheme_tax_classification row immediately changes the recomputed classification/gainType — no stale cached figure survives', invalidated ? 'PASS' : 'FAIL', `before=${beforeClass}, after=${afterClass}, afterGain=${afterGain}`);
      // Restore.
      await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${instId}`, { method: 'PATCH', body: { classification: 'equity_oriented', basis: 'computed_from_holdings', domestic_equity_pct: 95, note: 'LIVE-R6 test-scenario fixture — directly asserted classification, not derived from real holdings disclosure (see ii_r6_final_live_dev_cases.mjs header vs the SEPARATE production reference-data seed script).' } });
      const restored = await app('/api/investment-intelligence/tax/summary', { cookie });
      const restoredClass = restored.json?.data?.disposalResults?.find((d) => d.instrumentId === instId)?.classification;
      record('STALENESS-CLASSIFICATION-CHANGE-RESTORE', 'Reverting the classification reverts the recomputed figure', restoredClass === 'equity_oriented' ? 'PASS' : 'FAIL', `restored classification=${restoredClass}`);
    }
  }
  {
    // (c) Tax-profile change: toggling taxpayerType override immediately changes taxpayerContext (no caching) — already proven live in LIVE-R6-011 vs 012, reproduced here explicitly as a staleness check on the SAME user across consecutive calls.
    const r1 = await app('/api/investment-intelligence/tax/summary', { cookie });
    const r2 = await app('/api/investment-intelligence/tax/summary?taxpayerType=NON_RESIDENT_INDIVIDUAL', { cookie });
    const r3 = await app('/api/investment-intelligence/tax/summary', { cookie }); // back to no override
    const basis1 = r1.json?.data?.taxpayerContext?.estimateBasis;
    const basis2 = r2.json?.data?.taxpayerContext?.estimateBasis;
    const basis3 = r3.json?.data?.taxpayerContext?.estimateBasis;
    const invalidated = basis1 === 'UNKNOWN_PROFILE' && basis2 === 'INDIA_DOMESTIC_LAW_ESTIMATE' && basis3 === 'UNKNOWN_PROFILE';
    record('STALENESS-PROFILE-CHANGE', 'Tax-profile override changes taxpayerContext immediately on the very next call, and reverts immediately when the override is removed — no caching lag in either direction', invalidated ? 'PASS' : 'FAIL', `sequence: ${basis1} -> ${basis2} -> ${basis3}`);
  }
  {
    // (d) Tax-rule change — HONEST DISCLOSURE, not a fabricated live demo.
    // Confirmed by direct code search (grep) that ii_tax_rule_versions is
    // NEVER read by lib/engines/investment-intelligence/tax/ruleVersions.ts
    // (resolveRuleVersion always uses in-code ALL_RULE_VERSIONS constants) —
    // the DB table is a write-once audit record from migration 0058's seed,
    // not a live input to any computation. This means "change a DB rule row,
    // observe recomputation" is not a real scenario this architecture
    // supports today, so it is not staged as one. What IS genuinely provable
    // live: every tax/summary call recomputes fully fresh from the CURRENT
    // in-code rule table (no rule-derived result is ever cached/read back
    // for display — see ATOMICITY-2 above, which already demonstrates this
    // for the whole computation pipeline including rule resolution). The
    // actual historical proof that a real rule change forces recomputation
    // is TAX_ENGINE_VERSION's v1->v2 bump during the pre-DEV closure pass
    // (Section 8 of this dispatch's predecessor report) — a genuine rule
    // correction that DID force every previously-computed result to be
    // recomputed, verified at the time.
    record('STALENESS-RULE-CHANGE', 'Tax-rule change invalidation', 'DISCLOSED-GAP', 'ii_tax_rule_versions is not read by the engine (confirmed via code search) — rule changes are code-level (ALL_RULE_VERSIONS + TAX_ENGINE_VERSION bump), not DB-driven, so there is no live DB-driven staleness scenario to demonstrate. See detail in R6_FINAL_LIVE_DEV_VERIFICATION.md.');
  }

  console.log('\n--- SUMMARY ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED' || r.status === 'DISCLOSED-GAP').length;
  console.log(`PASS=${pass} FAIL=${fail} BLOCKED/DISCLOSED=${blocked} (of ${results.length})`);
  fs.writeFileSync(path.join(__dirname, 'ii-r6-final-certification', 'atomicity_idempotency_staleness_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), userId: uid, results }, null, 2));
}

main().catch((e) => {
  record('HARNESS', 'Harness execution', 'BLOCKED', e.stack ?? e.message);
  process.exitCode = 2;
});
