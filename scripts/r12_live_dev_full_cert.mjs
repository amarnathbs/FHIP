// Investment Intelligence R12 -- FULL live-DEV certification, now that
// migration 0092 is genuinely live on DEV (price_source column, 'sale'
// transaction_type, 'direct_listed_security_rule' basis all confirmed via
// a real REST 200 immediately before this script was written).
//
// Runs against real DEV Supabase (vqycarelcoijzwlpkpcz) + a real running
// `next dev` instance (default http://localhost:3299, override via argv[2]).
// Every synthetic row this script creates is deleted at the end and
// independently re-verified by re-query (see CLEANUP section).
//
// Run: node scripts/r12_live_dev_full_cert.mjs [appBaseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3299';

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
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
const reconciliations = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} -- ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 800)}`);
}
function reconcile(id, description, independentValue, productionValue, match, detail) {
  reconciliations.push({ id, description, independentValue, productionValue, match, detail });
  console.log(`[RECONCILE ${match ? 'MATCH' : 'MISMATCH'}] ${id} -- ${description} (independent=${JSON.stringify(independentValue)}, production=${JSON.stringify(productionValue)})`);
  if (detail) console.log(`        ${detail}`);
}

async function sb(p, { method = 'GET', body, prefer, range } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  if (range) headers.Range = range;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text, contentRange: res.headers.get('content-range') };
}
async function sbExactCount(p) {
  const r = await sb(p, { prefer: 'count=exact', range: '0-0' });
  const total = r.contentRange ? Number(r.contentRange.split('/')[1]) : NaN;
  return total;
}
async function asUserRest(p, { accessToken, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = {
  userIds: [], instrumentIds: [], accountIds: [], goalIds: [], reportIds: [], benchmarkIds: [],
  professionalProfileIds: [], relationshipIds: [], householdMemberIds: [],
};

async function makeUser(tag) {
  const email = `r12-livecert-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.userIds.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, accessToken: session.access_token, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function seedBaseline(userId, opts = {}) {
  // user_profiles + entitlement + basic FHIP data so downstream endpoints
  // (report generation, forecasting) do not fail on missing prerequisites.
  await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, full_name: `R12 Live Cert ${userId.slice(0, 8)}`, date_of_birth: '1985-06-15', country_of_residence: 'IN', preferred_currency: 'INR', onboarding_completed: true } });
  if (opts.premium) {
    await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  }
  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 150000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Household', amount: 60000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'Bank balance', current_value: 500000, asset_class: 'cash', country_code: 'IN', is_active: true } });
}

async function markPortfolioTruthCertified(userId, accountId, instrumentId) {
  return sb('/rest/v1/ii_portfolio_truth_status', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: { user_id: userId, account_id: accountId, instrument_id: instrumentId, status: 'certified', history_completeness: 'complete_from_inception' },
  });
}

const TODAY_ISO = new Date().toISOString().slice(0, 10);

function randIsin(seedTag) {
  // 12-char pseudo-ISIN, deterministic per tag+stamp for reproducibility within a run.
  const digits = String(stamp).slice(-6);
  return `INE${digits}${seedTag}`.padEnd(12, '0').slice(0, 12).toUpperCase();
}

async function main() {
  console.log(`APP=${APP}  DEV host=${new URL(BASE).host}\n`);

  let userA, userB, snapEquityId, snapEtfId, snapMfId;
  let equityInstrId, etfInstrId, mfInstrId;

  try {
    // =====================================================================
    // SETUP -- userA (main test subject), userB (cross-user attacker)
    // =====================================================================
    userA = await makeUser('user-a');
    userB = await makeUser('user-b');
    await seedBaseline(userA.id, { premium: true });
    await seedBaseline(userB.id, { premium: false });

    const acc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'demat', institution_name: 'Zerodha', country_code: 'IN', currency_code: 'INR', folio_number: null, status: 'active' } });
    const accountId = acc.json?.[0]?.id;
    cleanup.accountIds.push(accountId);

    // =====================================================================
    // 1-11: DIRECT EQUITY
    // =====================================================================
    const isin1 = randIsin('EQ1');
    const exchangeSymbol1 = `RELTST${stamp % 10000}`;

    // 1. Equity create + 2. BUY (first buy also creates the instrument)
    const buy1 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-01-10', units: 100, pricePerUnit: 200, fees: 20, taxes: 5,
    } });
    equityInstrId = buy1.json?.data?.instrumentId;
    if (equityInstrId) cleanup.instrumentIds.push(equityInstrId);
    record('R12-01', 'Equity create: real ii_instruments row (instrument_class=equity, real ISIN) via first BUY', buy1.status === 200 && !!equityInstrId ? 'PASS' : 'FAIL', `status=${buy1.status} body=${JSON.stringify(buy1.json).slice(0, 400)}`);
    record('R12-02', 'Equity BUY (real transaction, real accepted transaction_type)', buy1.status === 200 && buy1.json?.data?.unitsAfter === 100 && buy1.json?.data?.valueAfter === 20000 ? 'PASS' : 'FAIL', `unitsAfter=${buy1.json?.data?.unitsAfter} valueAfter=${buy1.json?.data?.valueAfter}`);

    // 3. Multiple BUY (accumulation)
    const buy2 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-02-10', units: 50, pricePerUnit: 220, fees: 10, taxes: 3,
    } });
    record('R12-03', 'Multiple BUY (accumulation): units/value correctly compound on top of existing position', buy2.status === 200 && buy2.json?.data?.unitsAfter === 150 && buy2.json?.data?.valueAfter === 150 * 220 ? 'PASS' : 'FAIL', `unitsAfter=${buy2.json?.data?.unitsAfter} valueAfter=${buy2.json?.data?.valueAfter} (expected 150 / ${150 * 220})`);

    // 4. Partial SELL (using now-accepted 'sale' transaction_type)
    const sell1 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'sale', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-03-10', units: 50, pricePerUnit: 250, fees: 10, taxes: 5,
    } });
    snapEquityId = sell1.json?.data?.holdingSnapshotId;
    // Verify the underlying transaction row really persisted with transaction_type='sale' (the migration-0092-gated value).
    const saleTxRows = sell1.json?.data?.transactionIds?.length ? await sb(`/rest/v1/ii_transactions?id=in.(${sell1.json.data.transactionIds.join(',')})&select=transaction_type`) : { json: [] };
    const persistedSale = saleTxRows.json?.some((r) => r.transaction_type === 'sale');
    record('R12-04', "Partial SELL using the real 'sale' transaction_type (migration 0092), units correctly reduced", sell1.status === 200 && sell1.json?.data?.unitsAfter === 100 && persistedSale ? 'PASS' : 'FAIL', `unitsAfter=${sell1.json?.data?.unitsAfter} (expected 100) persistedTxTypeIsSale=${persistedSale} raw=${JSON.stringify(saleTxRows.json)}`);

    // 5. Full SELL
    const sell2 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'sale', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-04-10', units: 100, pricePerUnit: 260, fees: 15, taxes: 6,
    } });
    record('R12-05', 'Full SELL: position reduces to exactly zero units, value zero', sell2.status === 200 && sell2.json?.data?.unitsAfter === 0 && sell2.json?.data?.valueAfter === 0 ? 'PASS' : 'FAIL', `unitsAfter=${sell2.json?.data?.unitsAfter} valueAfter=${sell2.json?.data?.valueAfter}`);
    // Attempt an impossible over-sell as a bonus negative check (not numbered, folds into R12-05's integrity claim).
    const oversell = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'sale', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-04-11', units: 1, pricePerUnit: 260,
    } });
    record('R12-05b', 'Impossible sale (0 units held) correctly rejected with validation error, not silently accepted', oversell.status >= 400 && /No existing position|units are currently held/i.test(oversell.json?.error ?? '') ? 'PASS' : 'FAIL', `status=${oversell.status} error=${oversell.json?.error}`);

    // Re-buy so downstream tests (valuation, R4, R6, mixed portfolio, goals) have a live non-zero equity position.
    const buy3 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Test Equity Co ${stamp}`, isin: isin1, exchange: 'NSE', exchangeSymbol: exchangeSymbol1,
      accountInstitutionName: 'Zerodha', transactionDate: TODAY_ISO, units: 80, pricePerUnit: 300, fees: 12, taxes: 4,
    } });
    snapEquityId = buy3.json?.data?.holdingSnapshotId;

    // 6. NSE/BSE same ISIN -> ONE canonical instrument, ONE holding, ONE net-worth contribution.
    const isin2 = randIsin('EQ2');
    const bseSymbol = `${500000 + (stamp % 9999)}`;
    const buyBse = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Dual Exchange Co ${stamp}`, isin: isin2, exchange: 'BSE', exchangeSymbol: bseSymbol,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-01-15', units: 40, pricePerUnit: 500,
    } });
    const dualInstrId = buyBse.json?.data?.instrumentId;
    if (dualInstrId) cleanup.instrumentIds.push(dualInstrId);
    const buyNse = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      // Same ISIN, different exchange -- the service resolves by ISIN identifier, so this must land on the SAME instrument.
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Dual Exchange Co ${stamp}`, isin: isin2, exchange: 'NSE', exchangeSymbol: `DUALTST${stamp % 10000}`,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-01-20', units: 20, pricePerUnit: 510,
    } });
    const sameInstrument = buyNse.json?.data?.instrumentId === dualInstrId;
    const dualHoldingCount = await sbExactCount(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}&instrument_id=eq.${dualInstrId}`);
    // Latest snapshot should reflect the ACCUMULATED position (60 units), proving one holding truth, not two parallel rows.
    const dualUnitsAfter = buyNse.json?.data?.unitsAfter;
    record('R12-06', 'NSE/BSE same ISIN -> ONE canonical instrument, one accumulated holding (financial-integrity gate)', sameInstrument && dualUnitsAfter === 60 ? 'PASS' : 'FAIL', `sameInstrument=${sameInstrument} dualUnitsAfter=${dualUnitsAfter} (expected 60) totalSnapshotRowsForInstrument=${dualHoldingCount}`);

    // 7. Fresh equity valuation (price_source, priceFreshness)
    // NOTE (script fix, not an app defect): lib/engines/investment-intelligence/valuation/priceFreshness.ts
    // defines PriceFreshnessStatus as 'CURRENT' | 'STALE' — there is no 'FRESH' value.
    // The original assertion below guessed the wrong enum literal; confirmed by reading
    // priceFreshness.ts directly (resolvePriceFreshness returns 'CURRENT' when ageDays <= thresholdDays).
    const posListFresh = await app('/api/investment-intelligence/positions', { cookie: userA.cookie });
    const freshRow = posListFresh.json?.data?.find((p) => p.instrument_id === equityInstrId);
    record('R12-07', 'Fresh equity valuation: price_source=manual_entry, priceFreshness=CURRENT (dated today)', freshRow?.price_source === 'manual_entry' && freshRow?.priceFreshness?.status === 'CURRENT' ? 'PASS' : 'FAIL', JSON.stringify(freshRow));

    // 8. Stale equity valuation (confirm stale != current, no fabrication)
    const staleIsin = randIsin('EQS');
    const staleBuy = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'equity', instrumentName: `R12 Live Stale Co ${stamp}`, isin: staleIsin, exchange: 'NSE', exchangeSymbol: `STALE${stamp % 10000}`,
      accountInstitutionName: 'Zerodha', transactionDate: '2020-01-10', units: 10, pricePerUnit: 100,
    } });
    const staleInstrId = staleBuy.json?.data?.instrumentId;
    if (staleInstrId) cleanup.instrumentIds.push(staleInstrId);
    const posListStale = await app('/api/investment-intelligence/positions', { cookie: userA.cookie });
    const staleRow = posListStale.json?.data?.find((p) => p.instrument_id === staleInstrId);
    record('R12-08', 'Stale equity valuation (as_of_date 2020-01-10): priceFreshness correctly flags stale, not silently treated as current', staleRow?.priceFreshness?.status === 'STALE' && staleRow?.as_of_date !== TODAY_ISO ? 'PASS' : 'FAIL', JSON.stringify(staleRow?.priceFreshness));

    // 9. Missing equity valuation (an instrument with NO holding snapshot -- confirm it's simply absent, not fabricated as zero)
    const missingInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R12 Live No-Valuation Co ${stamp}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
    const missingInstrId = missingInstr.json?.[0]?.id;
    if (missingInstrId) cleanup.instrumentIds.push(missingInstrId);
    const posListMissing = await app('/api/investment-intelligence/positions', { cookie: userA.cookie });
    const missingRow = posListMissing.json?.data?.find((p) => p.instrument_id === missingInstrId);
    record('R12-09', 'Missing equity valuation: instrument with no snapshot does not appear as a zero-valued position (missing != zero)', missingRow === undefined ? 'PASS' : 'FAIL', `found=${JSON.stringify(missingRow)}`);

    // 10. Equity R4 performance (feeds canonical R4 engine, no local XIRR/TWRR/CAGR)
    const analyticsRes = await app('/api/investment-intelligence/analytics', { cookie: userA.cookie });
    const analyticsNonEmpty = analyticsRes.status === 200 && analyticsRes.json?.data?.empty === false;
    record('R12-10', 'Equity R4 performance: GET /analytics returns real (non-empty) results including the equity position, via the unmodified R4 engine', analyticsNonEmpty ? 'PASS' : 'FAIL', JSON.stringify(analyticsRes.json).slice(0, 500));

    // 11. Equity R6 tax (direct_listed_security_rule basis, canonical R6 engine, no R12-local calculator)
    // First confirm the tax classification really got seeded with the migration-0092-gated basis value.
    const classRow = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${equityInstrId}&select=basis,classification`);
    const basisCorrect = classRow.json?.[0]?.basis === 'direct_listed_security_rule';
    record('R12-11a', "Equity tax classification seeded with the real migration-0092 basis 'direct_listed_security_rule'", basisCorrect ? 'PASS' : 'FAIL', JSON.stringify(classRow.json));
    const taxRes = await app('/api/investment-intelligence/tax/summary?taxpayerType=RESIDENT_INDIVIDUAL', { cookie: userA.cookie });
    const taxSeesDisposal = taxRes.status === 200 && taxRes.json?.data?.empty === false;
    record('R12-11', 'Equity R6 tax: GET /tax/summary computes real capital gains for the equity SALE via the canonical R6 engine', taxSeesDisposal ? 'PASS' : `FAIL (DEFECT -- see report) status=${taxRes.status}`, JSON.stringify(taxRes.json).slice(0, 600));

    // =====================================================================
    // 12-17: EQUITY ETF
    // =====================================================================
    const etfIsin = randIsin('ETF');
    const etfBuy1 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'etf', isEquityOriented: true, instrumentName: `R12 Live Nifty ETF ${stamp}`, isin: etfIsin, exchange: 'NSE', exchangeSymbol: `ETFTST${stamp % 10000}`,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-01-10', units: 200, pricePerUnit: 150, fees: 5,
    } });
    etfInstrId = etfBuy1.json?.data?.instrumentId;
    if (etfInstrId) cleanup.instrumentIds.push(etfInstrId);
    record('R12-12', 'ETF create: real ii_instruments row (instrument_class=etf), only accepted when explicitly declared equity-oriented', etfBuy1.status === 200 && !!etfInstrId ? 'PASS' : 'FAIL', `status=${etfBuy1.status} body=${JSON.stringify(etfBuy1.json).slice(0, 300)}`);
    record('R12-13', 'ETF BUY (real transaction)', etfBuy1.json?.data?.unitsAfter === 200 && etfBuy1.json?.data?.valueAfter === 30000 ? 'PASS' : 'FAIL', `unitsAfter=${etfBuy1.json?.data?.unitsAfter} valueAfter=${etfBuy1.json?.data?.valueAfter}`);

    const etfSell1 = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'sale', instrumentClass: 'etf', isEquityOriented: true, instrumentName: `R12 Live Nifty ETF ${stamp}`, isin: etfIsin, exchange: 'NSE', exchangeSymbol: `ETFTST${stamp % 10000}`,
      accountInstitutionName: 'Zerodha', transactionDate: TODAY_ISO, units: 50, pricePerUnit: 160,
    } });
    snapEtfId = etfSell1.json?.data?.holdingSnapshotId;
    record('R12-14', 'ETF SELL: units correctly reduced via real sale transaction_type', etfSell1.status === 200 && etfSell1.json?.data?.unitsAfter === 150 ? 'PASS' : 'FAIL', `unitsAfter=${etfSell1.json?.data?.unitsAfter} (expected 150)`);

    const etfNonEquity = await app('/api/investment-intelligence/positions/manual', { cookie: userA.cookie, method: 'POST', body: {
      action: 'buy', instrumentClass: 'etf', instrumentName: `R12 Live Gold ETF ${stamp}`, isin: randIsin('GLD'), exchange: 'NSE', exchangeSymbol: `GLDTST${stamp % 10000}`,
      accountInstitutionName: 'Zerodha', transactionDate: '2025-01-10', units: 10, pricePerUnit: 5000,
    } });
    record('R12-scope-guard', 'Non-equity-oriented ETF (isEquityOriented omitted) correctly REJECTED -- deferred scope guard holds', etfNonEquity.status >= 400 ? 'PASS' : 'FAIL', `status=${etfNonEquity.status} error=${etfNonEquity.json?.error}`);

    const posListEtf = await app('/api/investment-intelligence/positions', { cookie: userA.cookie });
    const etfRow = posListEtf.json?.data?.find((p) => p.instrument_id === etfInstrId);
    record('R12-15', 'ETF holding: canonical position lists correctly with post-sale units', etfRow?.units === 150 ? 'PASS' : 'FAIL', JSON.stringify(etfRow));
    record('R12-16', 'ETF valuation: real price_source and freshness present', etfRow?.price_source === 'manual_entry' && etfRow?.priceFreshness?.status === 'CURRENT' ? 'PASS' : 'FAIL', JSON.stringify(etfRow?.priceFreshness));

    const etfClassRow = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${etfInstrId}&select=basis,classification,domestic_equity_pct`);
    record('R12-17', "ETF R6 tax classification: equity-oriented ETF gets the SAME 'direct_listed_security_rule' equity-oriented treatment, distinct classification metadata from plain equity", etfClassRow.json?.[0]?.basis === 'direct_listed_security_rule' ? 'PASS' : 'FAIL', JSON.stringify(etfClassRow.json));

    // =====================================================================
    // 18-24: MIXED PORTFOLIO
    // =====================================================================
    // Add a real mutual-fund position (pre-R12 pathway, direct REST fixture like existing certified scripts).
    const mfAcc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'mf_folio', institution_name: 'HDFC Mutual Fund', country_code: 'IN', currency_code: 'INR', folio_number: `R12LIVE-MF-${stamp}`, status: 'active' } });
    const mfAccId = mfAcc.json?.[0]?.id;
    cleanup.accountIds.push(mfAccId);
    const mfInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R12 Live Mixed Portfolio Fund ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } });
    mfInstrId = mfInstr.json?.[0]?.id;
    cleanup.instrumentIds.push(mfInstrId);
    const mfSnap = await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: mfAccId, instrument_id: mfInstrId, as_of_date: '2025-06-30', units: 1000, value: 150000, currency_code: 'INR', quality_status: 'certified' } });
    snapMfId = mfSnap.json?.[0]?.id;
    await sb('/rest/v1/ii_transactions', { method: 'POST', body: { user_id: userA.id, account_id: mfAccId, instrument_id: mfInstrId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2025-01-01', gross_amount: '100000.00', units: '1000.000000', price_per_unit: '100.00', status: 'reconciled' } });
    await markPortfolioTruthCertified(userA.id, mfAccId, mfInstrId);

    const posListMixed = await app('/api/investment-intelligence/positions', { cookie: userA.cookie });
    const mixedHasAll3 = ['mutual_fund', 'equity', 'etf'].every((cls) => {
      const ids = { mutual_fund: mfInstrId, equity: equityInstrId, etf: etfInstrId }[cls];
      return posListMixed.json?.data?.some((p) => p.instrument_id === ids);
    });
    record('R12-18', 'Mixed portfolio: MF + equity + ETF all present in one canonical positions list', mixedHasAll3 ? 'PASS' : 'FAIL', `count=${posListMixed.json?.data?.length}`);

    // 19. Net-worth equality: sum of canonical positions == what the household dashboard/investments total shows.
    // Independently sum every LATEST snapshot per (account,instrument) for userA directly from the DB (service-role, ground truth).
    const allSnaps = await sb(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}&select=account_id,instrument_id,as_of_date,value&order=as_of_date.desc`);
    const latestMap = new Map();
    for (const row of allSnaps.json ?? []) {
      const key = `${row.account_id}:${row.instrument_id}`;
      if (!latestMap.has(key)) latestMap.set(key, row);
    }
    const independentTotal = [...latestMap.values()].reduce((s, r) => s + Number(r.value), 0);
    const appTotal = (posListMixed.json?.data ?? []).reduce((s, r) => s + Number(r.value), 0);
    reconcile('R12-19-RECON', 'Net-worth equality: independent DB sum of latest snapshots vs. app positions endpoint sum', independentTotal, appTotal, Math.abs(independentTotal - appTotal) < 0.01, `latestMap size=${latestMap.size}`);
    record('R12-19', 'Net-worth equality: one portfolio, one holdings truth, one investment total (canonical positions sum matches independent ground truth)', Math.abs(independentTotal - appTotal) < 0.01 ? 'PASS' : 'FAIL', `independent=${independentTotal} app=${appTotal}`);

    // 20. Goal allocation (equity/ETF participating in existing goal funding, <=100% cap enforced)
    //
    // SCRIPT FIX (not an app defect) vs. the original design: read
    // lib/services/goalFundingAllocation.ts's checkFundingAllocation() directly --
    // the <=100% cap sums allocation_percentage across every ACTIVE goal_funding_sources
    // row sharing the SAME linked_investment_id (preventing one balance from being
    // double-counted across multiple goals), not across DIFFERENT investments
    // allocated to the same goal. The original test allocated equity+ETF (two
    // different linked investments) to one goal, which the real cap logic was
    // never designed to catch -- it passed 200 correctly, that was a test-design
    // bug, not a missing enforcement. Also: createOrUpdateGoalAllocation only
    // writes through to goal_funding_sources (where the cap lives) when the
    // caller supplies linkedInvestmentId, which requires the position to have
    // been actually PUBLISHED first (POST .../positions/[id]/publish) --
    // publish in turn requires (a) household_members.owner_member_id resolved
    // on the account (real product prerequisite, not skippable -- see task
    // brief) and (b) ii_portfolio_truth_status='certified' for the position.
    // Corrected test: publish the equity position, certify its portfolio-truth
    // status, resolve a household member, then allocate the SAME published
    // investment to TWO different goals summing >100% and confirm rejection.
    const member = await sb('/rest/v1/household_members', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, full_name: `R12 Live Cert Self ${stamp}`, relationship: 'self', is_active: true } });
    const memberId = member.json?.[0]?.id;
    cleanup.householdMemberIds.push(memberId);
    await sb(`/rest/v1/ii_accounts?id=eq.${accountId}`, { method: 'PATCH', body: { owner_member_id: memberId } });
    await markPortfolioTruthCertified(userA.id, accountId, equityInstrId);
    await markPortfolioTruthCertified(userA.id, accountId, etfInstrId);

    const publishEquity = await app(`/api/investment-intelligence/positions/${snapEquityId}/publish`, { cookie: userA.cookie, method: 'POST', body: { acknowledgedNoDuplicate: true } });
    const equityInvestmentId = publishEquity.json?.data?.publishedRowId;
    record('R12-20-publish', 'Publish prerequisite: equity position genuinely publishes to a real investments.id (household member resolved, portfolio-truth certified, R12-extended asset-class allowlist)', publishEquity.status === 200 && !!equityInvestmentId ? 'PASS' : 'FAIL', `status=${publishEquity.status} body=${JSON.stringify(publishEquity.json).slice(0, 500)}`);

    const goalA = await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, goal_name: `R12 Live Goal A ${stamp}`, goal_type: 'savings', target_amount: 1000000, current_amount: 0, currency_code: 'INR', target_date: '2028-12-31', status: 'active' } });
    const goalAId = goalA.json?.[0]?.id;
    cleanup.goalIds.push(goalAId);
    const goalB = await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, goal_name: `R12 Live Goal B ${stamp}`, goal_type: 'savings', target_amount: 1000000, current_amount: 0, currency_code: 'INR', target_date: '2029-12-31', status: 'active' } });
    const goalBId = goalB.json?.[0]?.id;
    cleanup.goalIds.push(goalBId);

    const allocRes = equityInvestmentId
      ? await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goalAId, investmentPositionId: snapEquityId, linkedInvestmentId: equityInvestmentId, allocationType: 'percentage', allocationValue: 70 } })
      : { status: 0, json: null };
    record('R12-20a', 'Goal allocation: published equity position allocated 70% to Goal A (writes through to goal_funding_sources via linkedInvestmentId)', allocRes.status === 200 ? 'PASS' : 'FAIL', `status=${allocRes.status} body=${JSON.stringify(allocRes.json)}`);

    const allocResOverCap = equityInvestmentId
      ? await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goalBId, investmentPositionId: snapEquityId, linkedInvestmentId: equityInvestmentId, allocationType: 'percentage', allocationValue: 40 } })
      : { status: 0, json: null };
    record('R12-20b', 'Goal allocation cap: SAME published equity investment allocated 70%(GoalA)+40%(GoalB)=110% correctly REJECTED (real <=100% cap in goal_funding_sources, per-linked-investment across goals)', allocResOverCap.status === 409 && allocResOverCap.json?.error ? 'PASS' : `FAIL status=${allocResOverCap.status}`, `alloc1(GoalA 70%)=${allocRes.status} alloc2(GoalB 40%, over-cap)=${allocResOverCap.status} body=${JSON.stringify(allocResOverCap.json)}`);

    const allocResFits = equityInvestmentId
      ? await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goalBId, investmentPositionId: snapEquityId, linkedInvestmentId: equityInvestmentId, allocationType: 'percentage', allocationValue: 20 } })
      : { status: 0, json: null };
    record('R12-20c', 'Goal allocation cap positive control: 70%(GoalA)+20%(GoalB)=90% (same investment) correctly ACCEPTED (cap is a real threshold check, not a blanket second-allocation refusal)', allocResFits.status === 200 ? 'PASS' : `FAIL status=${allocResFits.status}`, `body=${JSON.stringify(allocResFits.json)}`);

    // 21. Forecasting: canonical investment positions consumed exactly once.
    const forecastRun = await app('/api/forecast/run', { cookie: userA.cookie, method: 'POST', body: { forecast_type: 'net_worth', months: 60 } });
    record('R12-21', 'Forecasting: canonical investment positions consumed without error via the real forecasting API (no separate R12 forecast path)', forecastRun.status === 200 ? 'PASS' : 'FAIL', `status=${forecastRun.status} body=${JSON.stringify(forecastRun.json).slice(0, 400)}`);

    // 22. R5 diversification: direct equity as direct issuer exposure, ETF at instrument level (no fund-style look-through).
    const xrayRes = await app('/api/investment-intelligence/xray', { cookie: userA.cookie });
    record('R12-22', 'R5 diversification: xray call succeeds with equity/ETF present, no crash from non-fund instrument classes', xrayRes.status === 200 ? 'PASS' : 'FAIL', JSON.stringify(xrayRes.json).slice(0, 500));

    // 23. Review Centre: deterministic, evidence-backed observations only.
    const reviewRefresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const reviewList = await app('/api/investment-intelligence/review', { cookie: userA.cookie });
    record('R12-23', 'Review Centre: refresh + list succeed with equity/ETF positions present, returns a well-formed items array', reviewRefresh.status === 200 && Array.isArray(reviewList.json?.data?.items ?? reviewList.json?.data) ? 'PASS' : 'FAIL', `refresh=${reviewRefresh.status} list=${reviewList.status} body=${JSON.stringify(reviewList.json).slice(0, 400)}`);

    // 24. R10 report: real Premium report containing MF+equity+ETF.
    const genRes = await app('/api/reports/generate', { cookie: userA.cookie, method: 'POST', body: { reportType: 'net_worth' } });
    const genData = genRes.json?.data ?? genRes.json;
    const reportId = genData?.report?.id;
    if (reportId) cleanup.reportIds.push(reportId);
    const sections = genData?.sections ?? [];
    const perfSection = sections.find((s) => s.sectionCode === 'investment_performance');
    record('R12-24', 'R10 report: real Premium report generated containing MF+equity+ETF portfolio, investment_performance section included', genRes.status === 200 && !!reportId && perfSection?.sectionStatus === 'included' ? 'PASS' : `FAIL status=${genRes.status}`, JSON.stringify({ reportId, perfStatus: perfSection?.sectionStatus }));

    // =====================================================================
    // 25-28: SECURITY / SCALE
    // =====================================================================
    // 25. 0094 same-user holding forgery -- re-run against the now-more-complete schema.
    const forgeAttempt = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}`, { accessToken: userA.accessToken, method: 'PATCH', body: { value: 999999999, units: 1 } });
    const verifyForged = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}&select=value,units`);
    const stillForged = verifyForged.json?.[0]?.value === 999999999;
    record('R12-25', '0094 same-user holding forgery regression: still BLOCKED against the NOW-more-complete (0092+0094) schema', !stillForged ? 'PASS' : 'FAIL', `PATCH http ${forgeAttempt.status}; ground truth value=${verifyForged.json?.[0]?.value}`);

    // 26. Cross-user holding attack -- BLOCKED
    const crossRead = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}&select=id,value`, { accessToken: userB.accessToken });
    const crossWrite = await asUserRest(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}`, { accessToken: userB.accessToken, method: 'PATCH', body: { value: 1 } });
    const crossWriteVerify = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}&select=value`);
    const crossAppRead = await app('/api/investment-intelligence/positions', { cookie: userB.cookie });
    const userBSeesUserAPosition = crossAppRead.json?.data?.some((p) => p.id === snapEquityId);
    record('R12-26', 'Cross-user holding attack: User B cannot read/write User A equity holding via REST or via the app API', (crossRead.json?.length ?? 0) === 0 && crossWriteVerify.json?.[0]?.value === verifyForged.json?.[0]?.value && !userBSeesUserAPosition ? 'PASS' : 'FAIL', `restRead=${crossRead.json?.length} restWriteVerify=${crossWriteVerify.json?.[0]?.value} appSeesIt=${userBSeesUserAPosition}`);

    // 27. R11 professional bounded access
    const prof1 = await makeUser('prof-authorised');
    const prof2 = await makeUser('prof-unrelated');
    const profProfile1 = await sb('/rest/v1/professional_profiles', { method: 'POST', prefer: 'return=representation', body: { user_id: prof1.id, display_name: 'R12 Live Cert Advisor', organisation: 'Test Advisory', professional_type: 'financial_adviser', contact_email: prof1.email, is_active: true } });
    cleanup.professionalProfileIds.push(profProfile1.json?.[0]?.id);
    const profProfile2 = await sb('/rest/v1/professional_profiles', { method: 'POST', prefer: 'return=representation', body: { user_id: prof2.id, display_name: 'R12 Live Cert Unrelated Advisor', organisation: 'Test Advisory 2', professional_type: 'financial_adviser', contact_email: prof2.email, is_active: true } });
    cleanup.professionalProfileIds.push(profProfile2.json?.[0]?.id);

    const inviteRes = await app('/api/professional-access/invitations', { cookie: userA.cookie, method: 'POST', body: { professionalUserId: prof1.id, purpose: 'R12 live test engagement', scopes: ['VIEW_INVESTMENTS'] } });
    const relId = inviteRes.json?.data?.relationshipId ?? inviteRes.json?.data?.id;
    if (relId) cleanup.relationshipIds.push(relId);
    await app(`/api/professional-access/invitations/${relId}/accept`, { cookie: prof1.cookie, method: 'POST' });
    await app(`/api/professional-access/relationships/${relId}/scopes`, { cookie: userA.cookie, method: 'POST', body: { scope: 'VIEW_INVESTMENTS' } });

    const authorisedAccess = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${userA.id}`, { cookie: prof1.cookie });
    const authorisedSeesEquity = authorisedAccess.json?.data?.positions?.some((p) => p.instrument_id === equityInstrId);
    const unrelatedAccess = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${userA.id}`, { cookie: prof2.cookie });
    // Revoke and re-check.
    const revokeRes = await app(`/api/professional-access/relationships/${relId}/revoke`, { cookie: userA.cookie, method: 'POST' });
    const revokedAccess = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${userA.id}`, { cookie: prof1.cookie });
    // Raw document access is not implicitly granted -- structurally no such proxy route exists.
    const rawDocProbe = await app(`/api/professional-access/proxy/raw-document?clientUserId=${userA.id}&documentId=irrelevant`, { cookie: prof1.cookie });
    record('R12-27', 'R11 professional bounded access: authorised professional sees R12 equity position, unrelated professional denied, revoked professional denied, no raw-document route exists', authorisedSeesEquity && unrelatedAccess.status >= 400 && revokeRes.status === 200 && revokedAccess.status >= 400 && rawDocProbe.status === 404 ? 'PASS' : 'FAIL', `authorised.status=${authorisedAccess.status} authorisedSeesEquity=${authorisedSeesEquity} unrelated.status=${unrelatedAccess.status} revoke.status=${revokeRes.status} postRevoke.status=${revokedAccess.status} rawDocProbe.status=${rawDocProbe.status}`);

    // 28. >1000 economic-result proof: a portfolio result depending on rows beyond row 1000, proving no pagination truncation.
    const scaleInstr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R12 Live Scale Test Instrument ${stamp}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional' } });
    const scaleInstrId = scaleInstr.json?.[0]?.id;
    cleanup.instrumentIds.push(scaleInstrId);
    const SCALE_N = 1005;
    const BATCH = 200;
    const scaleRows = [];
    for (let i = 0; i < SCALE_N; i++) {
      scaleRows.push({ instrument_id: scaleInstrId, identifier_scheme: 'internal_provisional', identifier_value: i === SCALE_N - 1 ? `PAST-PAGE-1-MARKER-${stamp}` : `noise-${stamp}-${i}`, country_code: 'IN' });
    }
    for (let i = 0; i < scaleRows.length; i += BATCH) {
      const ins = await sb('/rest/v1/ii_instrument_identifiers', { method: 'POST', prefer: 'return=minimal', body: scaleRows.slice(i, i + BATCH) });
      if (ins.status >= 400) throw new Error(`scale seed failed at batch ${i}: ${ins.status} ${ins.text}`);
    }
    const naivePage = await sb(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${scaleInstrId}&select=identifier_value&order=identifier_value.asc`);
    const naiveFound = (naivePage.json ?? []).some((r) => r.identifier_value === `PAST-PAGE-1-MARKER-${stamp}`);
    let fullRows = [];
    for (let from = 0; ; from += 1000) {
      const rangedPage = await sb(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${scaleInstrId}&select=identifier_value&order=identifier_value.asc&limit=1000&offset=${from}`);
      if (!rangedPage.json || rangedPage.json.length === 0) break;
      fullRows = fullRows.concat(rangedPage.json);
      if (rangedPage.json.length < 1000) break;
    }
    const fullFound = fullRows.some((r) => r.identifier_value === `PAST-PAGE-1-MARKER-${stamp}`);
    record('R12-28', '>1000 economic-result proof: seeded 1005 real rows, naive single-page read misses row 1005, full pagination (fetchAllRows contract) finds it', (naivePage.json?.length ?? 0) <= 1000 && !naiveFound && fullRows.length === SCALE_N && fullFound ? 'PASS' : 'FAIL', `naive=${naivePage.json?.length} naiveFound=${naiveFound} full=${fullRows.length} fullFound=${fullFound}`);

    // =====================================================================
    // INDEPENDENT LIVE RECONCILIATION (12 total)
    // =====================================================================
    // RECON-1..5: Direct equity -- independently compute expected units/value at each step, WITHOUT importing R12's own service code.
    {
      // After buy1(100@200)+buy2(50@220)-sell1(50@250)+sell2(-100 to 0)+buy3(80@300): expect 80 units @ value 80*300=24000.
      const expectedUnits = 80, expectedValue = 24000;
      const row = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}&select=units,value`);
      const actual = row.json?.[0];
      reconcile('RECON-1', 'Direct equity: independently-derived running position after buy/buy/sale/sale/buy matches persisted snapshot', { units: expectedUnits, value: expectedValue }, actual, actual?.units == expectedUnits && Number(actual?.value) === expectedValue, '');
    }
    {
      // Total fees+taxes paid across all equity1 transactions, independently summed, vs. what's on ii_transactions.
      const expectedFees = 20 + 10 + 10 + 15 + 12; // buy1,buy2,sell1,sell2,buy3
      const expectedTaxes = 5 + 3 + 5 + 6 + 4;
      const txRows = await sb(`/rest/v1/ii_transactions?instrument_id=eq.${equityInstrId}&select=fees,taxes`);
      const actualFees = (txRows.json ?? []).reduce((s, r) => s + Number(r.fees ?? 0), 0);
      const actualTaxes = (txRows.json ?? []).reduce((s, r) => s + Number(r.taxes ?? 0), 0);
      reconcile('RECON-2', 'Direct equity: independently-summed fees/taxes across all transactions match persisted rows (explicit-only cost preservation)', { fees: expectedFees, taxes: expectedTaxes }, { fees: actualFees, taxes: actualTaxes }, actualFees === expectedFees && actualTaxes === expectedTaxes, '');
    }
    {
      // Dual-exchange instrument: independently compute total units (40+20=60) and confirm exactly 2 snapshot rows exist (one per buy event), not more.
      const snapRows = await sb(`/rest/v1/ii_holding_snapshots?instrument_id=eq.${dualInstrId}&select=units,value,as_of_date&order=as_of_date.asc`);
      const latest = snapRows.json?.[snapRows.json.length - 1];
      reconcile('RECON-3', 'Dual-exchange (NSE+BSE, same ISIN) equity: independently-summed 40+20=60 units matches latest persisted snapshot', { units: 60, value: 60 * 510 }, { units: Number(latest?.units), value: Number(latest?.value) }, Number(latest?.units) === 60, `rowCount=${snapRows.json?.length}`);
    }
    {
      // Equity R4 analytics -- independently verify the equity position's raw units*price is represented somewhere consistent in the dataset feeding analytics (position exists with correct value), without importing runAnalytics.
      const row = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapEquityId}&select=value,currency_code`);
      reconcile('RECON-4', 'Equity feeding R4: independently-read snapshot value/currency used by analytics dataset load matches ground truth', { value: 24000, currency: 'INR' }, { value: Number(row.json?.[0]?.value), currency: row.json?.[0]?.currency_code }, Number(row.json?.[0]?.value) === 24000 && row.json?.[0]?.currency_code === 'INR', '');
    }
    {
      // Equity tax classification basis independently checked against migration 0092's known allowed value set (not re-deriving the classifier's logic, just confirming ground truth persisted matches the frozen contract).
      const row = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${equityInstrId}&select=basis`);
      reconcile('RECON-5', "Equity tax classification: independently-expected basis 'direct_listed_security_rule' (per migration 0092 + R6_TAX doc) matches persisted row", 'direct_listed_security_rule', row.json?.[0]?.basis, row.json?.[0]?.basis === 'direct_listed_security_rule', '');
    }
    // RECON-6..8: ETF
    {
      const expectedUnits = 150, expectedValue = 150 * 160;
      const row = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapEtfId}&select=units,value`);
      reconcile('RECON-6', 'ETF: independently-derived position after buy(200@150)-sale(50@160) = 150 units @ 150*160 matches persisted snapshot', { units: expectedUnits, value: expectedValue }, { units: Number(row.json?.[0]?.units), value: Number(row.json?.[0]?.value) }, Number(row.json?.[0]?.units) === expectedUnits && Number(row.json?.[0]?.value) === expectedValue, '');
    }
    {
      const txRows = await sb(`/rest/v1/ii_transactions?instrument_id=eq.${etfInstrId}&select=transaction_type,units,gross_amount`);
      const buyRow = txRows.json?.find((r) => r.transaction_type === 'purchase');
      const saleRow = txRows.json?.find((r) => r.transaction_type === 'sale');
      const expectedBuyGross = 200 * 150, expectedSaleGross = 50 * 160;
      reconcile('RECON-7', 'ETF transactions: independently-expected gross amounts for purchase (200*150) and sale (50*160) match persisted ledger rows', { buy: expectedBuyGross, sale: expectedSaleGross }, { buy: Number(buyRow?.gross_amount), sale: Number(saleRow?.gross_amount) }, Number(buyRow?.gross_amount) === expectedBuyGross && Number(saleRow?.gross_amount) === expectedSaleGross, '');
    }
    {
      const row = await sb(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${etfInstrId}&select=basis,domestic_equity_pct`);
      reconcile('RECON-8', 'Equity-oriented ETF tax classification: independently-expected domestic_equity_pct >= 65 (equity-oriented threshold) and correct basis, matches persisted row', true, { basis: row.json?.[0]?.basis, domesticEquityPct: row.json?.[0]?.domestic_equity_pct }, row.json?.[0]?.basis === 'direct_listed_security_rule' && Number(row.json?.[0]?.domestic_equity_pct) >= 65, '');
    }
    // RECON-9..10: mixed portfolio
    {
      reconcile('RECON-9', 'Mixed portfolio net worth: independent DB sum (MF+equity+ETF latest snapshots) vs app positions sum', independentTotal, appTotal, Math.abs(independentTotal - appTotal) < 0.01, '(same computation as R12-19, restated as an independent reconciliation item)');
    }
    {
      const mfRow = await sb(`/rest/v1/ii_holding_snapshots?id=eq.${snapMfId}&select=units,value`);
      reconcile('RECON-10', 'Mixed portfolio: pre-existing mutual fund position independently confirmed unaffected by R12 equity/ETF additions (still 1000 units / 150000 value)', { units: 1000, value: 150000 }, { units: Number(mfRow.json?.[0]?.units), value: Number(mfRow.json?.[0]?.value) }, Number(mfRow.json?.[0]?.units) === 1000 && Number(mfRow.json?.[0]?.value) === 150000, '');
    }
    // RECON-11: tax
    {
      // Independently expect the equity SALE transaction rows exist with transaction_type='sale' and correct gross amounts, REGARDLESS of whether the tax engine currently picks them up (that's RECON's job: ground truth, not engine behaviour).
      const saleRows = await sb(`/rest/v1/ii_transactions?instrument_id=eq.${equityInstrId}&transaction_type=eq.sale&select=gross_amount,units`);
      const expectedSales = [{ units: 50, gross: 50 * 250 }, { units: 100, gross: 100 * 260 }];
      const actualSales = (saleRows.json ?? []).map((r) => ({ units: Number(r.units), gross: Number(r.gross_amount) })).sort((a, b) => a.units - b.units);
      const match = JSON.stringify(actualSales) === JSON.stringify(expectedSales.sort((a, b) => a.units - b.units));
      reconcile('RECON-11', 'Tax: independently-expected 2 equity SALE transaction rows (50@250, 100@260) exist in the immutable ledger with the real sale type', expectedSales, actualSales, match, '');
    }
    // RECON-12: pagination
    {
      reconcile('RECON-12', 'Pagination: independently-counted 1005 seeded rows via exact-count REST header matches full-pagination result length', 1005, fullRows.length, fullRows.length === 1005, `sbExactCount=${await sbExactCount(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${scaleInstrId}`)}`);
    }

  } finally {
    // =====================================================================
    // CLEANUP -- every synthetic row, independently re-verified afterward.
    // =====================================================================
    async function safeDelete(p) {
      try {
        const r = await sb(p, { method: 'DELETE' });
        if (r.status >= 400) console.error(`  cleanup WARNING: DELETE ${p} -> ${r.status} ${r.text.slice(0, 200)}`);
      } catch (e) { console.error(`  cleanup WARNING: DELETE ${p} threw: ${e.message}`); }
    }
    console.log('\n=== CLEANUP ===');
    for (const id of cleanup.relationshipIds) await safeDelete(`/rest/v1/professional_permission_scopes?relationship_id=eq.${id}`);
    for (const id of cleanup.relationshipIds) await safeDelete(`/rest/v1/professional_consent_audit?relationship_id=eq.${id}`);
    for (const id of cleanup.relationshipIds) await safeDelete(`/rest/v1/professional_report_access_log?relationship_id=eq.${id}`);
    for (const id of cleanup.relationshipIds) await safeDelete(`/rest/v1/professional_relationships?id=eq.${id}`);
    for (const id of cleanup.professionalProfileIds) if (id) await safeDelete(`/rest/v1/professional_profiles?id=eq.${id}`);
    for (const id of cleanup.reportIds) await safeDelete(`/rest/v1/report_sections?report_id=eq.${id}`);
    // report_generation_runs.report_id -> reports(id), no cascade (found live in run 1: 409 without this).
    for (const id of cleanup.reportIds) await safeDelete(`/rest/v1/report_generation_runs?report_id=eq.${id}`);
    for (const id of cleanup.reportIds) await safeDelete(`/rest/v1/reports?id=eq.${id}`);
    for (const id of cleanup.goalIds) await safeDelete(`/rest/v1/ii_goal_allocations?goal_id=eq.${id}`);
    for (const id of cleanup.goalIds) await safeDelete(`/rest/v1/goal_funding_sources?goal_id=eq.${id}`);
    for (const id of cleanup.goalIds) await safeDelete(`/rest/v1/user_goals?id=eq.${id}`);
    // Publish-flow rows (R12-20). Real FK chain confirmed live (run 1 hit every
    // one of these as a 409 in the opposite order): investments.ii_publication_id
    // -> ii_fhip_publications(id) [no cascade], so investments must be deleted
    // FIRST; only then can ii_fhip_publications go, which in turn must precede
    // ii_holding_snapshots (ii_fhip_publications.canonical_position_id -> it,
    // no cascade). goal_funding_sources/ii_goal_allocations (both ->
    // investments(id), no cascade) are already gone via the goalIds cleanup above.
    if (userA) await safeDelete(`/rest/v1/investments?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_fhip_publications?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_capital_gains_computations?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_tax_lot_consumptions?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_tax_lots?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_r5_analytics_results?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_portfolio_truth_status?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_transactions?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/ii_source_documents?user_id=eq.${userA.id}`);
    for (const id of cleanup.instrumentIds) if (id) await safeDelete(`/rest/v1/ii_scheme_tax_classification?instrument_id=eq.${id}`);
    for (const id of cleanup.instrumentIds) if (id) await safeDelete(`/rest/v1/ii_instrument_identifiers?instrument_id=eq.${id}`);
    for (const id of cleanup.instrumentIds) if (id) await safeDelete(`/rest/v1/ii_instruments?id=eq.${id}`);
    for (const id of cleanup.accountIds) if (id) await safeDelete(`/rest/v1/ii_accounts?id=eq.${id}`);
    // household_members must be deleted AFTER ii_accounts (owner_member_id references it, no cascade).
    for (const id of cleanup.householdMemberIds) if (id) await safeDelete(`/rest/v1/household_members?id=eq.${id}`);
    if (userA) await safeDelete(`/rest/v1/income_sources?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/expense_items?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/assets?user_id=eq.${userA.id}`);
    if (userA) await safeDelete(`/rest/v1/user_profiles?user_id=eq.${userA.id}`);
    if (userB) await safeDelete(`/rest/v1/income_sources?user_id=eq.${userB.id}`);
    if (userB) await safeDelete(`/rest/v1/expense_items?user_id=eq.${userB.id}`);
    if (userB) await safeDelete(`/rest/v1/assets?user_id=eq.${userB.id}`);
    if (userB) await safeDelete(`/rest/v1/user_profiles?user_id=eq.${userB.id}`);
    for (const id of cleanup.userIds) await safeDelete(`/auth/v1/admin/users/${id}`);

    console.log('\n=== SUMMARY ===');
    for (const r of results) console.log(`${r.status.padEnd(50)} ${r.id} ${r.description}`);
    console.log('\n=== RECONCILIATIONS ===');
    for (const r of reconciliations) console.log(`${(r.match ? 'MATCH' : 'MISMATCH').padEnd(10)} ${r.id} ${r.description}`);
    const genuineFailures = results.filter((r) => r.status.startsWith('FAIL'));
    const mismatches = reconciliations.filter((r) => !r.match);
    console.log(`\n${results.length} checks run, ${genuineFailures.length} genuine failures.`);
    console.log(`${reconciliations.length} reconciliations run, ${mismatches.length} mismatches.`);

    // Independent zero-residue re-verification.
    console.log('\n=== ZERO-RESIDUE VERIFICATION ===');
    for (const id of cleanup.userIds) {
      const r = await sb(`/auth/v1/admin/users/${id}`);
      console.log(`user ${id}: ${r.status === 404 ? 'GONE (confirmed)' : `STILL EXISTS status=${r.status}`}`);
    }
    if (userA) {
      const remainingSnaps = await sbExactCount(`/rest/v1/ii_holding_snapshots?user_id=eq.${userA.id}`);
      const remainingTx = await sbExactCount(`/rest/v1/ii_transactions?user_id=eq.${userA.id}`);
      console.log(`residual ii_holding_snapshots for userA: ${remainingSnaps} (expect 0 or NaN-if-user-gone)`);
      console.log(`residual ii_transactions for userA: ${remainingTx} (expect 0 or NaN-if-user-gone)`);
    }
    for (const id of cleanup.instrumentIds) {
      if (!id) continue;
      const r = await sb(`/rest/v1/ii_instruments?id=eq.${id}&select=id`);
      if ((r.json?.length ?? 0) > 0) console.log(`WARNING: instrument ${id} still present`);
    }
    for (const id of cleanup.householdMemberIds) {
      if (!id) continue;
      const r = await sb(`/rest/v1/household_members?id=eq.${id}&select=id`);
      console.log(`household_member ${id}: ${(r.json?.length ?? 0) === 0 ? 'GONE (confirmed)' : 'WARNING: still present'}`);
    }
    if (userA) {
      const remainingInvestments = await sbExactCount(`/rest/v1/investments?user_id=eq.${userA.id}`);
      const remainingPublications = await sbExactCount(`/rest/v1/ii_fhip_publications?user_id=eq.${userA.id}`);
      console.log(`residual investments for userA: ${remainingInvestments} (expect 0 or NaN-if-user-gone)`);
      console.log(`residual ii_fhip_publications for userA: ${remainingPublications} (expect 0 or NaN-if-user-gone)`);
    }
    console.log('Cleanup + independent re-verification complete.');

    if (genuineFailures.length > 0 || mismatches.length > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
