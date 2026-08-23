// Investment Intelligence R5 — GENUINE live-DEV end-to-end Portfolio X-Ray
// verification (LIVE-R5-005..009 plus supporting scenarios).
//
// Runnable only once migration 0044 is applied, because it seeds the real
// ii_fund_holdings_snapshots / ii_fund_holdings_lines / ii_security_classifications
// tables via the service role.
//
// WHAT MAKES THIS INDEPENDENT (spec section 93): for every scenario this
// script
//   1. seeds known holdings into the REAL DEV database,
//   2. computes the expected look-through / overlap / coverage ITSELF from
//      those seeded inputs, importing no production module,
//   3. calls the REAL running HTTP API as a REAL authenticated user,
//   4. compares, and
//   5. inspects the persisted ii_r5_analytics_results row for correct
//      versioning, coverage and as-of metadata.
//
// Run:  node scripts/ii_r5_live_xray_e2e.mjs [baseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';

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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 460)}`);
}
const near = (a, b, tol) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= tol;

async function sb(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [], instruments: [], snapshots: [] };

async function makeUser(tag) {
  const email = `ii-r5-xray-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const signIn = await sb('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
  if (!id || !signIn.json?.access_token) throw new Error(`user setup failed: ${created.text} ${signIn.text}`);
  cleanup.users.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signIn.json), 'utf8').toString('base64');
  return { id, email, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

/** Create an underlying security instrument (the look-through target). */
const securityCache = new Map();
async function security(name) {
  if (securityCache.has(name)) return securityCache.get(name);
  const r = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `R5X SEC ${name} ${stamp}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const id = r.json?.[0]?.id;
  if (!id) throw new Error(`security seed failed for ${name}: ${r.text}`);
  cleanup.instruments.push(id);
  securityCache.set(name, id);
  return id;
}

/**
 * Seed one fund: instrument, account, a user position, and a versioned
 * holdings snapshot with lines.
 *
 * holdings: [{ sec|null, weightPct, assetKind?, sectorCode?, marketCapClass?,
 *              creditRatingBand?, maturityDate?, modifiedDuration?, issuer? }]
 */
async function seedFund({ userId, name, value, holdingsAsOfDate, holdings, asOf }) {
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `R5X FUND ${name} ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const fundId = inst.json?.[0]?.id;
  if (!fundId) throw new Error(`fund seed failed: ${inst.text}`);
  cleanup.instruments.push(fundId);

  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'mf_folio', institution_name: 'R5X AMC', folio_number: `R5X-${stamp}-${cleanup.instruments.length}`, country_code: 'IN', currency_code: 'INR', status: 'active' },
  });
  const accountId = acct.json?.[0]?.id;
  if (!accountId) throw new Error(`account seed failed: ${acct.text}`);

  // The user's position in this fund.
  const hs = await sb('/rest/v1/ii_holding_snapshots', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_id: accountId, instrument_id: fundId, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: 1000, value },
  });
  if (!hs.ok) throw new Error(`position seed failed: ${hs.text}`);

  // Versioned fund-holdings snapshots (may be several, to prove selection).
  const snapshotIds = [];
  for (const snap of Array.isArray(holdingsAsOfDate) ? holdingsAsOfDate : [{ date: holdingsAsOfDate, holdings }]) {
    const s = await sb('/rest/v1/ii_fund_holdings_snapshots', {
      method: 'POST', prefer: 'return=representation',
      body: {
        fund_instrument_id: fundId,
        holdings_as_of_date: snap.date,
        source_data_version: 'r5x-v1',
        classification_version: 'r5x-classification-v1',
        source_document_version: `doc-${snap.date}`,
        quality_status: 'ok',
      },
    });
    const snapshotId = s.json?.[0]?.id;
    if (!snapshotId) throw new Error(`holdings snapshot seed failed: ${s.text}`);
    cleanup.snapshots.push(snapshotId);
    snapshotIds.push(snapshotId);

    const lines = [];
    for (const h of snap.holdings) {
      lines.push({
        snapshot_id: snapshotId,
        underlying_instrument_id: h.sec ? await security(h.sec) : null,
        holding_name: h.sec ?? h.name ?? 'UNIDENTIFIED HOLDING',
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
    if (!l.ok) throw new Error(`holdings lines seed failed: ${l.text}`);
  }
  return { fundId, accountId, snapshotIds };
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    const ping = await fetch(`${APP}/api/investment-intelligence/xray`, { redirect: 'manual' });
    if (ping.status === 0) throw new Error('no response');
  } catch (e) {
    record('LIVE-R5X-SERVER', 'Dev server reachable', 'BLOCKED', `${APP} did not respond: ${e.message}`);
    return;
  }
  record('LIVE-R5X-SERVER', 'Dev server reachable', 'PASS', APP);

  // Gate: 0044 must be applied for any of this to be meaningful.
  const gate = await sb('/rest/v1/ii_fund_holdings_snapshots?select=id&limit=1');
  if (gate.status !== 200) {
    record('LIVE-R5X-GATE', 'Migration 0044 applied', 'BLOCKED', `ii_fund_holdings_snapshots not reachable: ${gate.text.slice(0, 200)}`);
    return;
  }
  record('LIVE-R5X-GATE', 'Migration 0044 applied', 'PASS', 'ii_fund_holdings_snapshots reachable');

  const asOf = '2024-06-30';
  const A = await makeUser('a');
  const B = await makeUser('b');

  // =========================================================================
  // LIVE-R5-006 — multi-fund portfolio X-Ray with weighted effective exposure
  // LIVE-R5-005 — two overlapping funds, symmetric overlap
  //
  // Deliberately chosen so the arithmetic is hand-checkable:
  //   Fund A = 600,000 (60%): X 10%, SHARED 30%, OA 55%, CASH 5%
  //   Fund B = 400,000 (40%): X 20%, SHARED 25%, OB 55%
  // Expected effective:
  //   X      = .60*.10 + .40*.20 = .06 + .08 = 0.14
  //   SHARED = .60*.30 + .40*.25 = .18 + .10 = 0.28
  //   OA     = .60*.55 = 0.33
  //   OB     = .40*.55 = 0.22
  //   cash   = .60*.05 = 0.03
  //   total  = .14+.28+.33+.22+.03 = 1.00
  // Expected overlap(A,B) = min(.10,.20) + min(.30,.25) = .10 + .25 = 0.35
  // =========================================================================
  const fundA = await seedFund({
    userId: A.id, name: 'Alpha', value: 600000, asOf, holdingsAsOfDate: '2024-06-01',
    holdings: [
      { sec: 'X', weightPct: 10, sectorCode: 'FIN', marketCapClass: 'LARGE' },
      { sec: 'SHARED', weightPct: 30, sectorCode: 'TECH', marketCapClass: 'LARGE' },
      { sec: 'OA', weightPct: 55, sectorCode: 'ENERGY', marketCapClass: 'MID' },
      { sec: null, name: 'CASH & EQUIVALENTS', weightPct: 5, assetKind: 'cash' },
    ],
  });
  const fundB = await seedFund({
    userId: A.id, name: 'Beta', value: 400000, asOf, holdingsAsOfDate: '2024-06-01',
    holdings: [
      { sec: 'X', weightPct: 20, sectorCode: 'FIN', marketCapClass: 'LARGE' },
      { sec: 'SHARED', weightPct: 25, sectorCode: 'TECH', marketCapClass: 'LARGE' },
      { sec: 'OB', weightPct: 55, sectorCode: 'PHARMA', marketCapClass: 'SMALL' },
    ],
  });

  const xr = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, A.cookie);
  const xd = xr.json?.data;
  if (!xd || xd.available !== true) {
    record('LIVE-R5-006', 'Multi-fund portfolio X-Ray produces weighted effective exposures', 'FAIL', `HTTP ${xr.status} available=${xd?.available} ${xr.text.slice(0, 300)}`);
  } else {
    const byId = Object.fromEntries((xd.topHoldings ?? []).map((h) => [h.name.replace(`R5X SEC `, '').replace(` ${stamp}`, ''), h]));
    const expect = { X: 0.14, SHARED: 0.28, OA: 0.33, OB: 0.22 };
    const mismatches = [];
    for (const [k, v] of Object.entries(expect)) {
      const got = byId[k]?.effectiveWeight;
      if (!near(got, v, 1e-8)) mismatches.push(`${k}: api=${got} expected=${v}`);
    }
    record(
      'LIVE-R5-006',
      'Multi-fund portfolio X-Ray produces weighted effective exposures',
      mismatches.length === 0 ? 'PASS' : 'FAIL',
      mismatches.length === 0
        ? `X=0.14 SHARED=0.28 OA=0.33 OB=0.22 all exact (tol 1e-8); coverage=${xd.dataQuality.effectiveCoverage}`
        : mismatches.join(' | ')
    );

    // X is held via BOTH funds — scheme count must reflect that.
    record('LIVE-R5-006b', 'A security held via two funds reports schemeCount 2', byId.X?.schemeCount === 2 ? 'PASS' : 'FAIL', `X schemeCount=${byId.X?.schemeCount}, contributingFunds=${(byId.X?.contributingFunds ?? []).length}`);

    // Cash preserved, not redistributed.
    record('LIVE-R5-006c', 'Cash weight preserved, never redistributed across equities', near(xd.preservedBuckets?.cashWeight, 0.03, 1e-8) ? 'PASS' : 'FAIL', `cashWeight=${xd.preservedBuckets?.cashWeight} expected=0.03`);

    // No double count: everything sums to 1.
    const pb = xd.preservedBuckets ?? {};
    const sumExposures = (xd.topHoldings ?? []).reduce((s, h) => s + h.effectiveWeight, 0);
    const total = sumExposures + pb.cashWeight + pb.derivativeWeight + pb.otherWeight + pb.unresolvedWeight + pb.noSnapshotWeight + pb.undisclosedRemainderWeight;
    record('LIVE-R5-006d', 'NO DOUBLE COUNT: all weight buckets sum to exactly 1', near(total, 1, 1e-8) ? 'PASS' : 'FAIL', `sum=${total}`);

    // Effective values sum back to portfolio value (look-through adds no wealth).
    const sumValues = (xd.topHoldings ?? []).reduce((s, h) => s + h.effectiveValue, 0);
    const expectedValueOfSecurities = 0.97 * 1000000; // 97% is securities, 3% cash
    record('LIVE-R5-006e', 'Effective values sum back to the portfolio value (attribution, not extra wealth)', near(sumValues, expectedValueOfSecurities, 0.01) ? 'PASS' : 'FAIL', `Σ effectiveValue=${sumValues} expected=${expectedValueOfSecurities} (portfolio ₹1,000,000, 3% cash)`);

    // Sector aggregation, independently computed:
    // FIN  = .14 (X), TECH = .28 (SHARED), ENERGY = .33 (OA), PHARMA = .22 (OB)
    const sectors = Object.fromEntries((xd.sectorExposure?.buckets ?? []).map((b) => [b.key, b.effectiveWeight]));
    const sectorOk = near(sectors.FIN, 0.14, 1e-8) && near(sectors.TECH, 0.28, 1e-8) && near(sectors.ENERGY, 0.33, 1e-8) && near(sectors.PHARMA, 0.22, 1e-8);
    record('LIVE-R5-006f', 'Sector exposure aggregates correctly across funds', sectorOk ? 'PASS' : 'FAIL', JSON.stringify(sectors));

    // Market cap: LARGE = .14 + .28 = .42, MID = .33, SMALL = .22
    const mcap = Object.fromEntries((xd.marketCapExposure?.buckets ?? []).map((b) => [b.key, b.effectiveWeight]));
    record('LIVE-R5-006g', 'Market-cap exposure aggregates from security-level classification', near(mcap.LARGE, 0.42, 1e-8) && near(mcap.MID, 0.33, 1e-8) && near(mcap.SMALL, 0.22, 1e-8) ? 'PASS' : 'FAIL', JSON.stringify(mcap));

    // Concentration: top1 = .33 (OA), top5 = .14+.28+.33+.22 = .97
    const conc = xd.securityConcentration;
    const expectedHhi = 0.14 ** 2 + 0.28 ** 2 + 0.33 ** 2 + 0.22 ** 2;
    record('LIVE-R5-006h', 'Concentration and HHI match an independent calculation', near(conc?.top1, 0.33, 1e-8) && near(conc?.top5, 0.97, 1e-8) && near(conc?.hhi, expectedHhi, 1e-8) ? 'PASS' : 'FAIL', `top1=${conc?.top1} top5=${conc?.top5} hhi=${conc?.hhi} independentHhi=${expectedHhi}`);
  }

  // ---- overlap ----
  const ov = await app(`/api/investment-intelligence/xray/overlap?asOf=${asOf}`, A.cookie);
  const od = ov.json?.data;
  const pair = (od?.pairs ?? [])[0];
  record(
    'LIVE-R5-005',
    'Two overlapping funds produce the independently-calculated overlap',
    near(pair?.weightedOverlap, 0.35, 1e-8) && pair?.commonSecurityCount === 2 ? 'PASS' : 'FAIL',
    `API overlap=${pair?.weightedOverlap} independent=min(.10,.20)+min(.30,.25)=0.35; commonSecurityCount=${pair?.commonSecurityCount} expected=2`
  );
  const m = od?.matrix?.values;
  const symmetric = Array.isArray(m) && m.every((row, i) => row.every((v, j) => v === m[j][i]));
  const bounded = Array.isArray(m) && m.every((row) => row.every((v) => v === null || (v >= 0 && v <= 1)));
  const diagOne = Array.isArray(m) && m.every((row, i) => row[i] === 1);
  record('LIVE-R5-005b', 'Live overlap matrix is symmetric, bounded 0..1, diagonal 1', symmetric && bounded && diagOne ? 'PASS' : 'FAIL', `symmetric=${symmetric} bounded=${bounded} diagonal1=${diagOne} matrix=${JSON.stringify(m)}`);

  // =========================================================================
  // LIVE-R5-007 — partial holdings coverage reported at its TRUE fraction
  // Fund C has a position but NO holdings snapshot at all.
  // Also: fund D discloses only 80% of its portfolio.
  // =========================================================================
  const C = await makeUser('c');
  await seedFund({ userId: C.id, name: 'Covered', value: 700000, asOf, holdingsAsOfDate: '2024-06-01', holdings: [{ sec: 'X', weightPct: 80 }] });
  // A fund with a position but no snapshot: create instrument+position only.
  {
    const inst = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R5X FUND NoDisclosure ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } });
    const fid = inst.json[0].id;
    cleanup.instruments.push(fid);
    const acct = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: C.id, account_type: 'mf_folio', institution_name: 'R5X AMC', folio_number: `R5X-ND-${stamp}`, country_code: 'IN', currency_code: 'INR', status: 'active' } });
    await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: C.id, account_id: acct.json[0].id, instrument_id: fid, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: 100, value: 300000 } });
  }
  // Expected: schemeCoverage = 700k/1000k = 0.70; within-scheme coverage = 0.80
  // effectiveCoverage = 0.70 * 0.80 = 0.56; noSnapshotWeight = 0.30
  const xrC = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, C.cookie);
  const cd = xrC.json?.data;
  record(
    'LIVE-R5-007',
    'Partial holdings coverage is reported at its true fraction, never rounded up',
    near(cd?.dataQuality?.effectiveCoverage, 0.56, 1e-8) && near(cd?.dataQuality?.schemeCoverage, 0.70, 1e-8) && near(cd?.preservedBuckets?.noSnapshotWeight, 0.30, 1e-8) ? 'PASS' : 'FAIL',
    `effectiveCoverage=${cd?.dataQuality?.effectiveCoverage} (independent 0.70×0.80=0.56); schemeCoverage=${cd?.dataQuality?.schemeCoverage}; noSnapshotWeight=${cd?.preservedBuckets?.noSnapshotWeight}; undisclosedRemainder=${cd?.preservedBuckets?.undisclosedRemainderWeight}`
  );
  record('LIVE-R5-007b', 'Undisclosed remainder retained rather than rescaled to 100%', near(cd?.preservedBuckets?.undisclosedRemainderWeight, 0.14, 1e-8) ? 'PASS' : 'FAIL', `undisclosedRemainderWeight=${cd?.preservedBuckets?.undisclosedRemainderWeight} expected=0.70×0.20=0.14`);
  record('LIVE-R5-007c', 'PARTIAL_COVERAGE quality status raised, COMPLETE not claimed', (cd?.dataQuality?.qualityStatuses ?? []).includes('PARTIAL_COVERAGE') && !(cd?.dataQuality?.qualityStatuses ?? []).includes('COMPLETE') ? 'PASS' : 'FAIL', JSON.stringify(cd?.dataQuality?.qualityStatuses));

  // =========================================================================
  // LIVE-R5-008 — stale holdings + future-snapshot exclusion + mixed dates
  // =========================================================================
  const D = await makeUser('d');
  await seedFund({
    userId: D.id, name: 'Stale', value: 1000000, asOf,
    holdingsAsOfDate: [
      { date: '2023-01-31', holdings: [{ sec: 'OLD', weightPct: 100 }] },      // very stale
      { date: '2024-09-30', holdings: [{ sec: 'FUTURE', weightPct: 100 }] },   // AFTER as-of: must be ignored
    ],
  });
  const xrD = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, D.cookie);
  const dd = xrD.json?.data;
  const names = (dd?.topHoldings ?? []).map((h) => h.name);
  const usedFuture = names.some((n) => n.includes('FUTURE'));
  const usedOld = names.some((n) => n.includes('OLD'));
  record(
    'LIVE-R5-008',
    'Stale holdings raise a stale warning and are never shown as current',
    dd?.dataQuality?.freshness === 'VERY_STALE' && (dd?.dataQuality?.qualityStatuses ?? []).includes('STALE_HOLDINGS') ? 'PASS' : 'FAIL',
    `freshness=${dd?.dataQuality?.freshness} statuses=${JSON.stringify(dd?.dataQuality?.qualityStatuses)} holdingsAsOfDate=${dd?.holdingsAsOfDate}`
  );
  record(
    'LIVE-R5-008b',
    'A FUTURE snapshot is never used to describe an earlier analytics date',
    !usedFuture && usedOld ? 'PASS' : 'FAIL',
    `holdings used: ${JSON.stringify(names)}; future snapshot (2024-09-30) used = ${usedFuture}`
  );

  // =========================================================================
  // LIVE-R5-009 — debt fund X-Ray shows only supportable measures
  // =========================================================================
  const E = await makeUser('e');
  await seedFund({
    userId: E.id, name: 'Debt', value: 1000000, asOf, holdingsAsOfDate: '2024-06-01',
    holdings: [
      { sec: 'GOI2030', weightPct: 40, creditRatingBand: 'SOVEREIGN', maturityDate: '2030-04-30', modifiedDuration: 4.9 },
      { sec: 'CORPAAA', weightPct: 30, creditRatingBand: 'AAA', maturityDate: '2026-08-31', modifiedDuration: 2.0 },
      { sec: 'CORPAA', weightPct: 20, creditRatingBand: 'AA', maturityDate: '2028-02-28', modifiedDuration: 3.3 },
      { sec: 'UNRATEDBOND', weightPct: 10, maturityDate: '2027-01-31', modifiedDuration: 2.5 },
    ],
  });
  const xrE = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, E.cookie);
  const ed = xrE.json?.data;
  const credit = Object.fromEntries((ed?.debt?.creditQuality?.buckets ?? []).map((b) => [b.key, b.effectiveWeight]));
  // Independent: weights are already portfolio-level (single fund at 100%).
  const creditOk = near(credit.SOVEREIGN, 0.40, 1e-8) && near(credit.AAA, 0.30, 1e-8) && near(credit.AA, 0.20, 1e-8) && near(credit.UNRATED, 0.10, 1e-8);
  record('LIVE-R5-009', 'Debt X-Ray credit bands match an independent calculation', ed?.debt?.applicable === true && creditOk ? 'PASS' : 'FAIL', `applicable=${ed?.debt?.applicable} buckets=${JSON.stringify(credit)}`);
  record('LIVE-R5-009b', 'A missing rating lands in UNRATED, never a credit band', near(credit.UNRATED, 0.10, 1e-8) ? 'PASS' : 'FAIL', `UNRATED=${credit.UNRATED} expected=0.10 (the one bond with no rating)`);
  // Weighted duration = (.4*4.9 + .3*2.0 + .2*3.3 + .1*2.5) / 1.0
  const expectedDur = 0.4 * 4.9 + 0.3 * 2.0 + 0.2 * 3.3 + 0.1 * 2.5;
  record('LIVE-R5-009c', 'Weighted modified duration matches an independent calculation', near(ed?.debt?.duration?.weightedModifiedDuration, expectedDur, 1e-6) ? 'PASS' : 'FAIL', `API=${ed?.debt?.duration?.weightedModifiedDuration} independent=${expectedDur}`);
  const mat = Object.fromEntries((ed?.debt?.maturity?.buckets ?? []).map((b) => [b.key, b.effectiveWeight]));
  record('LIVE-R5-009d', 'Maturity buckets place each bond in the correct band', near(mat.Y1_3, 0.40, 1e-8) && near(mat.Y3_5, 0.20, 1e-8) && near(mat.Y5_10, 0.40, 1e-8) ? 'PASS' : 'FAIL', `${JSON.stringify(mat)} (expected Y1_3=.30+.10=.40, Y3_5=.20, Y5_10=.40)`);

  // =========================================================================
  // Missing-classification state, with holdings present
  // =========================================================================
  const F = await makeUser('f');
  await seedFund({ userId: F.id, name: 'Unclassified', value: 500000, asOf, holdingsAsOfDate: '2024-06-01', holdings: [{ sec: 'NOCLASS1', weightPct: 60 }, { sec: 'NOCLASS2', weightPct: 40 }] });
  const xrF = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, F.cookie);
  const fd = xrF.json?.data;
  record(
    'LIVE-R5-CLASS',
    'Holdings present but unclassified -> sector/market-cap UNAVAILABLE, not zero buckets',
    fd?.available === true && fd?.sectorExposure?.status === 'unavailable' && (fd?.sectorExposure?.buckets ?? []).length === 0 && fd?.marketCapExposure?.status === 'unavailable' ? 'PASS' : 'FAIL',
    `available=${fd?.available} sector.status=${fd?.sectorExposure?.status} sectorBuckets=${(fd?.sectorExposure?.buckets ?? []).length} mcap.status=${fd?.marketCapExposure?.status} statuses=${JSON.stringify(fd?.dataQuality?.qualityStatuses)}`
  );
  record('LIVE-R5-CLASS-b', 'Look-through itself still works despite missing classification', near(fd?.topHoldings?.[0]?.effectiveWeight, 0.60, 1e-8) ? 'PASS' : 'FAIL', `top holding weight=${fd?.topHoldings?.[0]?.effectiveWeight} expected=0.60`);

  // =========================================================================
  // Unresolved holdings retained, and excluded from overlap matching
  // =========================================================================
  const G = await makeUser('g');
  await seedFund({ userId: G.id, name: 'UnresA', value: 500000, asOf, holdingsAsOfDate: '2024-06-01', holdings: [{ sec: 'X', weightPct: 40 }, { sec: null, name: 'MYSTERY HOLDING', weightPct: 60 }] });
  await seedFund({ userId: G.id, name: 'UnresB', value: 500000, asOf, holdingsAsOfDate: '2024-06-01', holdings: [{ sec: 'X', weightPct: 30 }, { sec: null, name: 'MYSTERY HOLDING', weightPct: 70 }] });
  const xrG = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, G.cookie);
  const gd = xrG.json?.data;
  record('LIVE-R5-UNRES', 'Unresolved weight retained and reported, never dropped', near(gd?.preservedBuckets?.unresolvedWeight, 0.65, 1e-8) && (gd?.dataQuality?.qualityStatuses ?? []).includes('UNDERLYING_UNRESOLVED') ? 'PASS' : 'FAIL', `unresolvedWeight=${gd?.preservedBuckets?.unresolvedWeight} expected=.5*.6+.5*.7=0.65`);
  const ovG = await app(`/api/investment-intelligence/xray/overlap?asOf=${asOf}`, G.cookie);
  const pairG = (ovG.json?.data?.pairs ?? [])[0];
  record(
    'LIVE-R5-UNRES-b',
    'Identically-NAMED unresolved holdings are NOT treated as matched in overlap',
    near(pairG?.weightedOverlap, 0.30, 1e-8) && pairG?.commonSecurityCount === 1 ? 'PASS' : 'FAIL',
    `overlap=${pairG?.weightedOverlap} expected=min(.40,.30)=0.30 from X ONLY; commonSecurityCount=${pairG?.commonSecurityCount} expected=1 (MYSTERY HOLDING excluded despite identical names)`
  );

  // =========================================================================
  // LIVE-R5-010 — cross-user isolation on the X-Ray surface
  // =========================================================================
  // Empty-user check first (weakest form).
  const xrBEmpty = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, B.cookie);
  record('LIVE-R5-010', "User B's X-Ray returns none of user A's positions", xrBEmpty.json?.data?.empty === true ? 'PASS' : 'FAIL', `empty=${xrBEmpty.json?.data?.empty} totalPortfolioValue=${xrBEmpty.json?.data?.totalPortfolioValue}`);

  // Now provision B with their OWN fund, so the refusals below are genuine
  // ownership checks rather than an incidental empty-dataset short circuit.
  const fundBOwn = await seedFund({
    userId: B.id, name: 'BOwn', value: 250000, asOf, holdingsAsOfDate: '2024-06-01',
    holdings: [{ sec: 'BONLY1', weightPct: 50, sectorCode: 'FIN' }, { sec: 'BONLY2', weightPct: 50, sectorCode: 'TECH' }],
  });
  const xrBOwn = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, B.cookie);
  const bOwnNames = (xrBOwn.json?.data?.topHoldings ?? []).map((h) => h.name);
  const bSeesOwn = bOwnNames.some((n) => n.includes('BONLY'));
  const bSeesA = bOwnNames.some((n) => n.includes(' X ') || n.includes('SHARED') || n.includes('OA') || n.includes('OB'));
  record(
    'LIVE-R5-010b',
    "A fully-provisioned user B sees ONLY their own holdings, never user A's",
    bSeesOwn && !bSeesA ? 'PASS' : 'FAIL',
    `B's look-through contains: ${JSON.stringify(bOwnNames)}; sees own=${bSeesOwn}; leaked A's securities=${bSeesA}`
  );

  const ovB = await app(`/api/investment-intelligence/xray/overlap?fundA=${fundA.fundId}&fundB=${fundB.fundId}&asOf=${asOf}`, B.cookie);
  record(
    'LIVE-R5-010c',
    "A fully-provisioned user B cannot request overlap for user A's fund ids",
    ovB.status === 404 ? 'PASS' : 'FAIL',
    `HTTP ${ovB.status} ${ovB.text.slice(0, 200)} (B holds ${fundBOwn.fundId}, requested A's ${fundA.fundId}/${fundB.fundId})`
  );

  // And B's own pair request must still work, proving the refusal is ownership.
  const ovBOwn = await app(`/api/investment-intelligence/xray/overlap?asOf=${asOf}`, B.cookie);
  record(
    'LIVE-R5-010d',
    "User B's own overlap request still works (the refusal above is ownership, not breakage)",
    ovBOwn.status === 200 && (ovBOwn.json?.data?.available === true || ovBOwn.json?.data?.available === false) ? 'PASS' : 'FAIL',
    `HTTP ${ovBOwn.status} available=${ovBOwn.json?.data?.available}`
  );

  // =========================================================================
  // Persistence: the analytics row must now actually land, with correct
  // versioning/coverage/as-of metadata.
  // =========================================================================
  const persisted = await sb(`/rest/v1/ii_r5_analytics_results?user_id=eq.${A.id}&metric_key=eq.xray_lookthrough&select=*`);
  const row = persisted.json?.[0];
  record(
    'LIVE-R5-PERSIST',
    'X-Ray result persisted with correct versioning, coverage and as-of metadata',
    row && row.engine_version === 'xray-engine-r5-v1' && near(Number(row.coverage), 1, 1e-6) && row.data_as_of_date === asOf && Array.isArray(row.holdings_snapshot_ids) && row.holdings_snapshot_ids.length === 2 ? 'PASS' : 'FAIL',
    row ? `engine=${row.engine_version} coverage=${row.coverage} asOf=${row.data_as_of_date} portfolioAsOf=${row.portfolio_as_of_date} holdingsAsOf=${row.holdings_as_of_date} snapshotIds=${row.holdings_snapshot_ids?.length} classification=${row.classification_version} inputHash=${String(row.input_snapshot_version).slice(0, 16)}…` : `no row persisted: ${persisted.text.slice(0, 200)}`
  );

  // Determinism: a second identical call must reuse the same input fingerprint.
  const xr2 = await app(`/api/investment-intelligence/xray?asOf=${asOf}`, A.cookie);
  record('LIVE-R5-DETERMINISM', 'Re-running the same analysis reproduces an identical input fingerprint', xr2.json?.data?.inputSnapshotVersion === xd?.inputSnapshotVersion ? 'PASS' : 'FAIL', `run1=${String(xd?.inputSnapshotVersion).slice(0, 24)}… run2=${String(xr2.json?.data?.inputSnapshotVersion).slice(0, 24)}…`);

  // =========================================================================
  // No-net-worth-impact: look-through must not have created any register row.
  // =========================================================================
  const invAfter = await sb(`/rest/v1/investments?user_id=eq.${A.id}&select=id`);
  const assetsAfter = await sb(`/rest/v1/assets?user_id=eq.${A.id}&select=id`);
  const nAssets = Array.isArray(assetsAfter.json) ? assetsAfter.json.length : 'n/a';
  const nInv = Array.isArray(invAfter.json) ? invAfter.json.length : 'n/a';
  record('LIVE-R5-NETWORTH', 'X-Ray look-through created NO investments/assets rows', nInv === 0 && nAssets === 0 ? 'PASS' : 'FAIL', `investments=${nInv} assets=${nAssets} (both must be 0 — look-through is attribution, not wealth)`);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  record('HARNESS', 'Harness execution', 'BLOCKED', `${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`);
  exitCode = 2;
} finally {
  for (const id of cleanup.users) await sb(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  for (const id of cleanup.snapshots) await sb(`/rest/v1/ii_fund_holdings_snapshots?id=eq.${id}`, { method: 'DELETE' });
  for (const id of cleanup.instruments) await sb(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
  console.log('\nCleanup done.');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY: PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length})`);
  fs.writeFileSync(path.join(__dirname, 'ii-r5-certification', 'live_xray_e2e_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), appBaseUrl: APP, results }, null, 2));
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
}
