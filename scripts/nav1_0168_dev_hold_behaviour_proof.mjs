// NAV 1 completion (2026-09-25) -- live DEV proof of the 0168/0171 statement-
// certification hold, with FULL cleanup (the DEV counterpart of the rolled-back
// production proof, docs/nav1/NAV1_D10_manifest_sql_for_PO.sql Q7).
//
// Uses an existing DEV synthetic fixture account (no user is created) and a
// NEW synthetic instrument, so no pre-existing hold can mask the result.
// Steps: non-certifying insert -> no hold; certify -> exactly one open hold,
// reason statement_reconciliation_in_progress, ~30 days; unchanged-status and
// unrelated updates -> still one; a SECOND certifying row for the same
// instrument -> still one hold (0171 idempotency), expiry not shortened.
// Then deletes every row it created and proves zero residue by count.
// DEV host asserted before every request.
//
// Usage: node scripts/nav1_0168_dev_hold_behaviour_proof.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const env = Object.fromEntries(fs.readFileSync('D:/FHIP/.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const BASE = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
async function dev(q, { method = 'GET', body, prefer } = {}) {
  if (new URL(BASE).host !== DEV_HOST) throw new Error('NOT DEV -- refusing');
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.status >= 400) throw new Error(`${method} ${q.slice(0, 80)} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}

const ACCOUNT = 'fae0ba75-d393-4137-ad9c-3e608678d1e4'; // pre-existing DEV fixture account ("R6-FINAL Test AMC")
const INST = crypto.randomUUID();
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };
const holds = async () => dev(`ii_nav_retention_holds?select=id,reason,expires_at,released_at&instrument_id=eq.${INST}`);
const truthIds = [];

const acct = await dev(`ii_accounts?select=id,user_id&id=eq.${ACCOUNT}`);
if (acct.length !== 1) throw new Error('fixture account missing on DEV');
const USER = acct[0].user_id;

try {
  await dev('ii_instruments', { method: 'POST', body: { id: INST, instrument_name: 'NAV1 0168 DEV proof (synthetic, deleted after)', instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' }, prefer: 'return=representation' });

  const t1 = await dev('ii_portfolio_truth_status', { method: 'POST', body: { user_id: USER, account_id: ACCOUNT, instrument_id: INST, status: 'reconciliation_required' }, prefer: 'return=representation' });
  truthIds.push(t1[0].id);
  check('a NON-certifying status creates no hold', (await holds()).length === 0);

  await dev(`ii_portfolio_truth_status?id=eq.${t1[0].id}`, { method: 'PATCH', body: { status: 'certified' }, prefer: 'return=representation' });
  const h1 = await holds();
  const days = h1[0] ? Math.round((Date.parse(h1[0].expires_at) - Date.now()) / 86400000) : null;
  check('certifying creates exactly one open hold', h1.length === 1 && h1[0].released_at === null, JSON.stringify(h1.map((h) => ({ reason: h.reason, days }))));
  check('...with reason statement_reconciliation_in_progress and a ~30-day expiry', h1[0]?.reason === 'statement_reconciliation_in_progress' && days >= 29 && days <= 30);

  await dev(`ii_portfolio_truth_status?id=eq.${t1[0].id}`, { method: 'PATCH', body: { status: 'certified' }, prefer: 'return=representation' });
  check('an unchanged-status update creates no second hold', (await holds()).length === 1);
  await dev(`ii_portfolio_truth_status?id=eq.${t1[0].id}`, { method: 'PATCH', body: { blocking_reasons: [] }, prefer: 'return=representation' });
  check('an unrelated column update creates no second hold', (await holds()).length === 1);

  // Re-certification (0171): back to a non-certifying status, then certified
  // again. The trigger fires a second time; it must extend the open hold,
  // not add a second one. (A second truth row for the same account+instrument
  // is impossible -- unique key -- so this is the real repeat path.)
  await dev(`ii_portfolio_truth_status?id=eq.${t1[0].id}`, { method: 'PATCH', body: { status: 'reconciliation_required' }, prefer: 'return=representation' });
  await new Promise((r) => setTimeout(r, 1200));
  await dev(`ii_portfolio_truth_status?id=eq.${t1[0].id}`, { method: 'PATCH', body: { status: 'certified_with_warnings' }, prefer: 'return=representation' });
  const h2 = await holds();
  check('re-certification (the trigger firing again) keeps ONE open hold and extends, never shortens, its expiry (0171)',
    h2.length === 1 && h2[0].id === h1[0].id && Date.parse(h2[0].expires_at) > Date.parse(h1[0].expires_at),
    JSON.stringify({ holds: h2.length, same_row: h2[0]?.id === h1[0]?.id, extended_ms: h2[0] ? Date.parse(h2[0].expires_at) - Date.parse(h1[0].expires_at) : null }));
} finally {
  // Cleanup: every row this proof created, in dependency order, each delete returning its rows.
  const dh = await dev(`ii_nav_retention_holds?instrument_id=eq.${INST}`, { method: 'DELETE', prefer: 'return=representation' });
  const dt = truthIds.length ? await dev(`ii_portfolio_truth_status?instrument_id=eq.${INST}`, { method: 'DELETE', prefer: 'return=representation' }) : [];
  const di = await dev(`ii_instruments?id=eq.${INST}`, { method: 'DELETE', prefer: 'return=representation' });
  console.log(`  cleanup: deleted ${dh.length} hold(s), ${dt.length} truth row(s), ${di.length} instrument(s)`);
  const residue = (await dev(`ii_nav_retention_holds?select=id&instrument_id=eq.${INST}`)).length
    + (await dev(`ii_portfolio_truth_status?select=id&instrument_id=eq.${INST}`)).length
    + (await dev(`ii_instruments?select=id&id=eq.${INST}`)).length;
  check('zero residue after cleanup (holds + truth rows + instrument)', residue === 0, `residue=${residue}`);
}
console.log(`\n=== NAV 1 / 0168 DEV hold behaviour: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
