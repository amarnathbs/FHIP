// Investment Intelligence R5 — browser-QA fixture for the Portfolio X-Ray
// states that were BLOCKED before migration 0044 was applied.
//
// Seeds three throwaway DEV users, each forcing a specific set of rendered
// states, and PRINTS THEIR CREDENTIALS so a real browser session can log in
// and the rendered output can be read directly.
//
//   QA-MAIN    — a rich, realistic portfolio exercising, in ONE view:
//                  * normal look-through (top holdings, sector, market cap,
//                    concentration)
//                  * a populated overlap heatmap (three funds share holdings)
//                  * PARTIAL coverage (one fund has no disclosure at all)
//                  * a STALE-holdings warning (one fund disclosed long ago)
//                  * MIXED as-of dates across contributing funds
//                  * unresolved + cash weight preserved as an explicit remainder
//                  * debt holdings, so the debt panel renders
//   QA-NOCLASS — holdings present but entirely UNCLASSIFIED, so sector and
//                market-cap must render "not available" rather than zero buckets
//   QA-ZERO    — positions but no disclosures at all: the 0%-coverage
//                negative control
//
// Teardown: node scripts/ii_r5_browser_qa_xray_fixture.mjs --teardown
//
// Run: node scripts/ii_r5_browser_qa_xray_fixture.mjs

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
const MARKER = 'R5QA';

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { ok: res.ok, status: res.status, json, text };
}

// --------------------------------------------------------------------------
if (process.argv[2] === '--teardown') {
  const users = await sb(`/auth/v1/admin/users?per_page=200`);
  for (const u of users.json?.users ?? []) {
    if (u.email?.includes('ii-r5-xqa-')) await sb(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
  }
  const insts = await sb(`/rest/v1/ii_instruments?instrument_name=like.${MARKER}*&select=id`);
  for (const i of insts.json ?? []) {
    await sb(`/rest/v1/ii_fund_holdings_snapshots?fund_instrument_id=eq.${i.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_instruments?id=eq.${i.id}`, { method: 'DELETE' });
  }
  console.log('teardown complete');
  process.exit(0);
}

const stamp = Date.now();
const asOf = '2024-06-30';

async function makeUser(tag) {
  const email = `ii-r5-xqa-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  if (!created.json?.id) throw new Error(`user create failed: ${created.text}`);
  return { id: created.json.id, email, password };
}

const secCache = new Map();
async function security(name) {
  if (secCache.has(name)) return secCache.get(name);
  const r = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `${MARKER} ${name}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const id = r.json?.[0]?.id;
  if (!id) throw new Error(`security seed failed ${name}: ${r.text}`);
  secCache.set(name, id);
  return id;
}

async function seedFund({ userId, fundName, value, snapshots }) {
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `${MARKER} ${fundName}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const fundId = inst.json?.[0]?.id;
  if (!fundId) throw new Error(`fund seed failed ${fundName}: ${inst.text}`);

  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-${stamp}-${fundName.replace(/\s/g, '')}`, country_code: 'IN', currency_code: 'INR', status: 'active' },
  });
  await sb('/rest/v1/ii_holding_snapshots', {
    method: 'POST',
    body: { user_id: userId, account_id: acct.json[0].id, instrument_id: fundId, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: 1000, value },
  });

  for (const snap of snapshots ?? []) {
    const s = await sb('/rest/v1/ii_fund_holdings_snapshots', {
      method: 'POST', prefer: 'return=representation',
      body: {
        fund_instrument_id: fundId, holdings_as_of_date: snap.date,
        source_data_version: 'r5qa-v1', classification_version: 'amfi_sector_v1',
        source_document_version: `doc-${snap.date}`, quality_status: 'ok',
      },
    });
    const snapshotId = s.json?.[0]?.id;
    if (!snapshotId) throw new Error(`snapshot seed failed: ${s.text}`);
    const lines = [];
    for (const h of snap.holdings) {
      lines.push({
        snapshot_id: snapshotId,
        underlying_instrument_id: h.sec ? await security(h.sec) : null,
        holding_name: h.sec ? `${MARKER} ${h.sec}` : (h.name ?? 'UNIDENTIFIED HOLDING'),
        asset_kind: h.assetKind ?? 'security',
        weight_pct: h.weightPct,
        sector_code: h.sectorCode ?? null,
        market_cap_class: h.marketCapClass ?? null,
        credit_rating_band: h.creditRatingBand ?? null,
        maturity_date: h.maturityDate ?? null,
        modified_duration: h.modifiedDuration ?? null,
        resolution_method: h.sec ? 'ISIN' : 'UNRESOLVED',
      });
    }
    const l = await sb('/rest/v1/ii_fund_holdings_lines', { method: 'POST', body: lines });
    if (!l.ok) throw new Error(`lines seed failed: ${l.text}`);
  }
  return fundId;
}

// ===========================================================================
// QA-MAIN — the rich portfolio
// ===========================================================================
const main = await makeUser('main');

// Bluechip Equity — 40% of a ₹2,500,000 portfolio, current disclosure
await seedFund({
  userId: main.id, fundName: 'Bluechip Equity Fund', value: 1000000,
  snapshots: [{ date: '2024-06-01', holdings: [
    { sec: 'Reliance Industries', weightPct: 9.5, sectorCode: 'Energy', marketCapClass: 'LARGE' },
    { sec: 'HDFC Bank', weightPct: 8.2, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
    { sec: 'Infosys', weightPct: 7.1, sectorCode: 'Information Technology', marketCapClass: 'LARGE' },
    { sec: 'ICICI Bank', weightPct: 6.4, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
    { sec: 'Tata Consultancy Services', weightPct: 5.8, sectorCode: 'Information Technology', marketCapClass: 'LARGE' },
    { sec: 'Larsen & Toubro', weightPct: 4.3, sectorCode: 'Capital Goods', marketCapClass: 'LARGE' },
    { sec: 'Bharti Airtel', weightPct: 3.9, sectorCode: 'Telecom', marketCapClass: 'LARGE' },
    { sec: 'Asian Paints', weightPct: 3.1, sectorCode: 'Consumer', marketCapClass: 'LARGE' },
    { sec: 'Sun Pharma', weightPct: 2.7, sectorCode: 'Healthcare', marketCapClass: 'LARGE' },
    { sec: 'Titan Company', weightPct: 2.4, sectorCode: 'Consumer', marketCapClass: 'LARGE' },
    { sec: null, name: 'CASH & CASH EQUIVALENTS', weightPct: 3.6, assetKind: 'cash' },
    { sec: 'Nestle India', weightPct: 40.0, sectorCode: 'Consumer', marketCapClass: 'LARGE' },
  ] }],
});

// Flexi Cap — 24%, heavy overlap with Bluechip (drives the heatmap)
await seedFund({
  userId: main.id, fundName: 'Flexi Cap Fund', value: 600000,
  snapshots: [{ date: '2024-06-01', holdings: [
    { sec: 'Reliance Industries', weightPct: 8.0, sectorCode: 'Energy', marketCapClass: 'LARGE' },
    { sec: 'HDFC Bank', weightPct: 7.5, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
    { sec: 'Infosys', weightPct: 6.0, sectorCode: 'Information Technology', marketCapClass: 'LARGE' },
    { sec: 'Persistent Systems', weightPct: 5.5, sectorCode: 'Information Technology', marketCapClass: 'MID' },
    { sec: 'Cummins India', weightPct: 5.0, sectorCode: 'Capital Goods', marketCapClass: 'MID' },
    { sec: 'Federal Bank', weightPct: 4.5, sectorCode: 'Financial Services', marketCapClass: 'MID' },
    { sec: 'Nestle India', weightPct: 60.0, sectorCode: 'Consumer', marketCapClass: 'LARGE' },
    { sec: null, name: 'UNLISTED HOLDING (PENDING DISCLOSURE)', weightPct: 3.5 },
  ] }],
});

// Corporate Bond Fund — 16%, debt holdings so the debt panel renders
await seedFund({
  userId: main.id, fundName: 'Corporate Bond Fund', value: 400000,
  snapshots: [{ date: '2024-05-31', holdings: [
    { sec: 'GOI 7.26% 2033', weightPct: 32.0, creditRatingBand: 'SOVEREIGN', maturityDate: '2033-08-22', modifiedDuration: 6.4 },
    { sec: 'HDFC Ltd NCD 2027', weightPct: 22.0, creditRatingBand: 'AAA', maturityDate: '2027-03-15', modifiedDuration: 2.3 },
    { sec: 'REC Ltd NCD 2028', weightPct: 18.0, creditRatingBand: 'AAA', maturityDate: '2028-11-30', modifiedDuration: 3.7 },
    { sec: 'Tata Capital NCD 2026', weightPct: 14.0, creditRatingBand: 'AA', maturityDate: '2026-06-30', modifiedDuration: 1.8 },
    { sec: 'Muthoot Finance NCD 2029', weightPct: 9.0, creditRatingBand: 'AA', maturityDate: '2029-09-15', modifiedDuration: 4.2 },
    { sec: null, name: 'TREPS / CASH', weightPct: 5.0, assetKind: 'cash' },
  ] }],
});

// Legacy Midcap — 12%, disclosure from Sept 2023 -> STALE + MIXED DATES
await seedFund({
  userId: main.id, fundName: 'Legacy Midcap Fund', value: 300000,
  snapshots: [{ date: '2023-09-30', holdings: [
    { sec: 'Cummins India', weightPct: 12.0, sectorCode: 'Capital Goods', marketCapClass: 'MID' },
    { sec: 'Federal Bank', weightPct: 11.0, sectorCode: 'Financial Services', marketCapClass: 'MID' },
    { sec: 'Persistent Systems', weightPct: 10.0, sectorCode: 'Information Technology', marketCapClass: 'MID' },
    { sec: 'Coforge', weightPct: 9.0, sectorCode: 'Information Technology', marketCapClass: 'MID' },
    { sec: 'AU Small Finance Bank', weightPct: 8.0, sectorCode: 'Financial Services', marketCapClass: 'MID' },
    { sec: 'Nestle India', weightPct: 42.0, sectorCode: 'Consumer', marketCapClass: 'LARGE' },
  ] }],
});

// Unlisted Opportunities — 8%, NO disclosure at all -> PARTIAL COVERAGE
{
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `${MARKER} Unlisted Opportunities Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: main.id, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-${stamp}-ND`, country_code: 'IN', currency_code: 'INR', status: 'active' },
  });
  await sb('/rest/v1/ii_holding_snapshots', {
    method: 'POST',
    body: { user_id: main.id, account_id: acct.json[0].id, instrument_id: inst.json[0].id, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: 500, value: 200000 },
  });
}

// ===========================================================================
// QA-NOCLASS — holdings present, entirely unclassified
// ===========================================================================
const noclass = await makeUser('noclass');
await seedFund({
  userId: noclass.id, fundName: 'Unclassified Holdings Fund', value: 500000,
  snapshots: [{ date: '2024-06-01', holdings: [
    { sec: 'Unclassified Alpha', weightPct: 45 },
    { sec: 'Unclassified Beta', weightPct: 35 },
    { sec: 'Unclassified Gamma', weightPct: 20 },
  ] }],
});

// ===========================================================================
// QA-ZERO — positions but no disclosures: the 0%-coverage control
// ===========================================================================
const zero = await makeUser('zero');
{
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `${MARKER} No Disclosure Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: zero.id, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-${stamp}-ZERO`, country_code: 'IN', currency_code: 'INR', status: 'active' },
  });
  await sb('/rest/v1/ii_holding_snapshots', {
    method: 'POST',
    body: { user_id: zero.id, account_id: acct.json[0].id, instrument_id: inst.json[0].id, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: 100, value: 750000 },
  });
}

console.log(JSON.stringify({
  asOf,
  main: { email: main.email, password: main.password, portfolio: '₹2,500,000 across 5 funds (4 disclosed, 1 not)' },
  noclass: { email: noclass.email, password: noclass.password },
  zero: { email: zero.email, password: zero.password },
}, null, 2));
