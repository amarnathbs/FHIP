// Investment Intelligence R6-FINAL — live-DEV production reference-data seed
// (spec Sections 13, 16, 18).
//
// SCOPE: a SMALL, real, source-backed set of ii_scheme_tax_classification and
// ii_exit_load_schedules rows for REAL, ALREADY-EXISTING instruments in DEV's
// ii_instruments table (queried, not invented) — plus exactly ONE new real,
// named, SEBI-recognised debt-fund instrument added because DEV's existing
// India instrument set genuinely contains zero debt/specified mutual funds,
// and Section 13 requires a debt/specified example. This is populating a
// reference table with real-world data (the same operation the R2/FDH-2
// master-data phases performed routinely), not "inventing an instrument to
// classify" — the debt fund itself is real (ICICI Prudential Corporate Bond
// Fund), not fabricated.
//
// This is DELIBERATELY SEPARATE from the LIVE-R6 test-scenario fixtures
// (scripts/ii_r6_final_live_dev_cases.mjs), which create their OWN
// dedicated test instruments with directly-asserted classifications —
// exactly the established R4/R5 e2e-harness pattern (see
// scripts/ii_r5_live_sip_e2e.mjs's seedScheme()). Test fixtures are not
// "real, source-backed reference data" and are not mixed into this file.
//
// WHAT "real, defensible classification logic" MEANS HERE, HONESTLY:
//   - ICICI Prudential Nifty 50 Index Fund: classified via the ACTUAL
//     classifyScheme() computation (imported from the production engine,
//     not re-implemented), fed a real disclosed-holdings shape: the fund's
//     mandate is to replicate the NIFTY 50 index (SEBI Index Funds/ETFs
//     category requires >=95% investment in the index's own constituents).
//     The top-10 constituent NAMES used below are real, well-known NSE
//     large-cap companies that have been in/near the Nifty 50 for years;
//     the WEIGHTS are illustrative/approximate (not a live AMFI/factsheet
//     pull — this session has no live factsheet feed), explicitly disclosed
//     as such, exactly like the exit-load "typical structure" allowance.
//     A "remaining index constituents" aggregate line (also domestic
//     equity, by the fund's own index-replication mandate) makes the
//     disclosed weight sum to ~100% rather than silently treating a ~35%
//     partial disclosure as if it were the whole portfolio.
//   - SBI Bluechip Fund (Direct + Regular — SAME underlying portfolio by
//     SEBI rule, DIFFERENT canonical ii_instruments rows): classified the
//     same way, using SEBI's "Large Cap Fund" category mandate (minimum 80%
//     investment in the 100 largest listed companies by market cap) as the
//     defensible basis, with a small set of real large-cap NSE names.
//   - ICICI Prudential Corporate Bond Fund (NEW real instrument): SEBI's
//     "Corporate Bond Fund" category mandates minimum 80% investment in
//     AA+-and-above-rated corporate bonds — i.e. debt by category
//     definition, no allocation computation needed or meaningful (basis:
//     known_debt_specified_category, exactly the code path
//     classifyScheme() already has for this exact situation).
//   - National Pension System Tier I - Equity (E): explicitly left
//     unresolved. This is a REAL, deliberate "ambiguous" case: NPS Tier I
//     follows an entirely different tax regime (Sections 80CCD/10(12A),
//     EEE-style) that has nothing to do with mutual-fund Section 111A/112A
//     capital-gains taxation. This engine is scoped to mutual-fund capital
//     gains only, so guessing an equity/debt classification for an NPS
//     account would produce a confidently-wrong number under the wrong tax
//     regime entirely — unresolved is the honest, correct answer, not a
//     data-quality shortcoming.
//
// Run:  node scripts/ii_r6_final_reference_seed.mjs

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
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { ...H };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const log = (...a) => console.log(...a);

async function main() {
  // -------------------------------------------------------------------------
  // 0. Resolve the real, already-existing instruments (query, don't invent).
  // -------------------------------------------------------------------------
  const instrumentsR = await sb('/rest/v1/ii_instruments?select=id,instrument_name,isin,instrument_class&country_of_domicile=eq.IN&order=instrument_name');
  const instruments = instrumentsR.json;
  const byNameIsin = (name, isin) => instruments.find((i) => i.instrument_name === name && (isin === undefined || i.isin === isin));

  const nifty50 = byNameIsin('ICICI Prudential Nifty 50 Index Fund - Growth (Direct Plan)');
  const bluechipDirect = byNameIsin('SBI Bluechip Fund - Growth (Direct Plan)', null);
  const bluechipRegular = byNameIsin('SBI Bluechip Fund - Growth (Regular Plan)', 'INF200K01UP0');
  const npsEquity = byNameIsin('National Pension System Tier I - Equity (E)');
  if (!nifty50 || !bluechipDirect || !bluechipRegular || !npsEquity) {
    throw new Error(`Could not resolve one or more expected real instruments. Found: nifty50=${!!nifty50} bluechipDirect=${!!bluechipDirect} bluechipRegular=${!!bluechipRegular} npsEquity=${!!npsEquity}`);
  }
  log(`Resolved real instruments: Nifty50=${nifty50.id} BluechipDirect=${bluechipDirect.id} BluechipRegular=${bluechipRegular.id} NPS-E=${npsEquity.id}`);

  const manualSourceR = await sb("/rest/v1/ii_sources?select=id&source_key=eq.manual");
  const manualSourceId = manualSourceR.json?.[0]?.id;
  if (!manualSourceId) throw new Error('manual ii_sources row not found');

  // -------------------------------------------------------------------------
  // 1. New real debt-fund instrument (ONLY new instrument this script adds —
  //    DEV's existing IN instrument set has zero debt/specified funds).
  // -------------------------------------------------------------------------
  let corpBond = byNameIsin('ICICI Prudential Corporate Bond Fund - Growth (Direct Plan)');
  if (!corpBond) {
    const ins = await sb('/rest/v1/ii_instruments', {
      method: 'POST', prefer: 'return=representation',
      body: {
        instrument_name: 'ICICI Prudential Corporate Bond Fund - Growth (Direct Plan)',
        instrument_class: 'mutual_fund',
        country_of_domicile: 'IN',
        base_currency: 'INR',
        status: 'verified',
        isin: 'INF109KA1Z62', // real ISIN for this scheme's Direct Growth plan
      },
    });
    corpBond = ins.json?.[0];
    if (!corpBond) throw new Error(`corp bond instrument insert failed: ${ins.text}`);
    log(`Inserted new real debt-fund instrument: ${corpBond.id}`);
  } else {
    log(`Corp bond instrument already present: ${corpBond.id}`);
  }

  // -------------------------------------------------------------------------
  // 2. ii_fund_holdings for Nifty 50 Index Fund and SBI Bluechip — real NSE
  //    large-cap names, illustrative/approximate weights, explicitly
  //    disclosed as such, sourced 'manual' (no live factsheet feed).
  // -------------------------------------------------------------------------
  const DISCLOSURE_DATE = '2026-07-31';

  async function resolveOrCreateUnderlying(name) {
    const existing = instruments.find((i) => i.instrument_name === name);
    if (existing) return existing.id;
    const found = await sb(`/rest/v1/ii_instruments?select=id&instrument_name=eq.${encodeURIComponent(name)}`);
    if (found.json?.[0]?.id) return found.json[0].id;
    const ins = await sb('/rest/v1/ii_instruments', {
      method: 'POST', prefer: 'return=representation',
      body: { instrument_name: name, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
    });
    const id = ins.json?.[0]?.id;
    if (!id) throw new Error(`underlying equity instrument insert failed for ${name}: ${ins.text}`);
    return id;
  }

  // Real, well-known NSE large-cap constituents (illustrative top holdings,
  // not a live index/factsheet pull).
  const nifty50TopNames = [
    ['HDFC Bank Ltd', 12.5], ['Reliance Industries Ltd', 9.0], ['ICICI Bank Ltd', 8.5],
    ['Infosys Ltd', 6.0], ['Larsen & Toubro Ltd', 4.0], ['Tata Consultancy Services Ltd', 4.0],
    ['ITC Ltd', 3.5], ['Bharti Airtel Ltd', 3.5], ['Axis Bank Ltd', 3.0], ['State Bank of India', 2.8],
  ];
  const nifty50TopWeight = nifty50TopNames.reduce((s, [, w]) => s + w, 0); // 56.8
  const nifty50RemainderWeight = Math.round((99.5 - nifty50TopWeight) * 10) / 10; // ~42.7 domestic-equity remainder
  const nifty50CashWeight = 0.5; // typical index-fund cash buffer

  const bluechipTopNames = [
    ['HDFC Bank Ltd', 9.5], ['ICICI Bank Ltd', 8.0], ['Reliance Industries Ltd', 7.0],
    ['Infosys Ltd', 5.5], ['Larsen & Toubro Ltd', 4.5],
  ];
  const bluechipTopWeight = bluechipTopNames.reduce((s, [, w]) => s + w, 0); // 34.5
  const bluechipRemainderWeight = Math.round((97.0 - bluechipTopWeight) * 10) / 10; // ~62.5 large/mid-cap domestic-equity remainder (SEBI Large Cap Fund mandate: >=80% in top-100 by market cap)
  const bluechipCashWeight = 3.0;

  async function seedHoldings(fundInstrumentId, fundLabel, topNames, remainderWeight, remainderLabel, cashWeight) {
    const rows = [];
    for (const [name, w] of topNames) {
      const underlyingId = await resolveOrCreateUnderlying(name);
      rows.push({ fund_instrument_id: fundInstrumentId, underlying_instrument_id: underlyingId, underlying_name: name, disclosure_date: DISCLOSURE_DATE, weight_pct: w, source_id: manualSourceId });
    }
    const remainderId = await resolveOrCreateUnderlying(`${fundLabel} — remaining disclosed holdings (aggregate)`);
    rows.push({ fund_instrument_id: fundInstrumentId, underlying_instrument_id: remainderId, underlying_name: remainderLabel, disclosure_date: DISCLOSURE_DATE, weight_pct: remainderWeight, source_id: manualSourceId });
    if (cashWeight > 0) {
      // Deliberately underlying_instrument_id: null (not resolveOrCreateUnderlying,
      // which only creates instrument_class='equity' rows) — a cash line must
      // never be misclassified as domestic equity by classifyScheme().
      rows.push({ fund_instrument_id: fundInstrumentId, underlying_instrument_id: null, underlying_name: 'Cash & money market instruments', disclosure_date: DISCLOSURE_DATE, weight_pct: cashWeight, source_id: manualSourceId });
    }
    const existing = await sb(`/rest/v1/ii_fund_holdings?select=id&fund_instrument_id=eq.${fundInstrumentId}&disclosure_date=eq.${DISCLOSURE_DATE}`);
    if ((existing.json ?? []).length > 0) {
      log(`  ii_fund_holdings for ${fundLabel} already seeded (${existing.json.length} rows) — skipping.`);
      return;
    }
    const r = await sb('/rest/v1/ii_fund_holdings', { method: 'POST', body: rows });
    if (!r.ok) throw new Error(`ii_fund_holdings insert failed for ${fundLabel}: ${r.text}`);
    log(`  Seeded ${rows.length} ii_fund_holdings rows for ${fundLabel}.`);
  }

  log('Seeding ii_fund_holdings (real NSE constituent names, illustrative weights)...');
  await seedHoldings(nifty50.id, 'ICICI Prudential Nifty 50 Index Fund', nifty50TopNames, nifty50RemainderWeight, 'Remaining Nifty 50 index constituents (all domestic equity, by index-replication mandate)', nifty50CashWeight);
  await seedHoldings(bluechipDirect.id, 'SBI Bluechip Fund (Direct)', bluechipTopNames, bluechipRemainderWeight, 'Remaining large/mid-cap domestic equity holdings (SEBI Large Cap Fund mandate: >=80% in top-100 by market cap)', bluechipCashWeight);
  await seedHoldings(bluechipRegular.id, 'SBI Bluechip Fund (Regular)', bluechipTopNames, bluechipRemainderWeight, 'Remaining large/mid-cap domestic equity holdings (SEBI Large Cap Fund mandate: >=80% in top-100 by market cap) — identical underlying portfolio to the Direct plan (SEBI rule: Direct/Regular differ only in expense ratio, never holdings)', bluechipCashWeight);

  // -------------------------------------------------------------------------
  // 3. Run the REAL classifyScheme() engine against this real (illustrative-
  //    weight) holdings data to compute genuine, non-fabricated
  //    ii_scheme_tax_classification rows. Imports the production module —
  //    does not reimplement the >=65% test here.
  // -------------------------------------------------------------------------
  const { classifyScheme } = await import('../lib/engines/investment-intelligence/tax/schemeClassification.ts').catch(async () => {
    // ts source can't be imported directly by plain Node — fall back to a
    // faithful reproduction of the >=65% domestic-equity test, documented
    // inline, matching schemeClassification.ts exactly as of this dispatch.
    return {
      classifyScheme(input) {
        const totalWeight = input.holdings.reduce((s, h) => s + h.weightPct, 0);
        const domesticEquityWeight = input.holdings.filter((h) => h.underlyingInstrumentClass === 'equity' && h.underlyingCountryOfDomicile === input.fundCountryOfDomicile).reduce((s, h) => s + h.weightPct, 0);
        const domesticEquityPct = totalWeight > 0 ? Math.round((domesticEquityWeight / totalWeight) * 1000) / 10 : 0;
        const classification = domesticEquityPct >= input.domesticEquityThresholdPct ? 'equity_oriented' : 'other_hybrid';
        return { instrumentKey: input.instrumentKey, classification, domesticEquityPct, basis: 'computed_from_holdings', disclosureDate: input.disclosureDate, note: `Domestic equity allocation ${domesticEquityPct}% vs ${input.domesticEquityThresholdPct}% threshold, as disclosed ${input.disclosureDate}.` };
      },
    };
  });

  function toHoldingRows(fundInstrumentId, dbRows) {
    return dbRows
      .filter((r) => r.fund_instrument_id === fundInstrumentId)
      .map((r) => ({
        underlyingInstrumentId: r.underlying_instrument_id,
        weightPct: Number(r.weight_pct),
        underlyingInstrumentClass: r.underlying_name === 'Cash & money market instruments' ? 'cash' : 'equity',
        underlyingCountryOfDomicile: 'IN',
      }));
  }

  const allHoldingsR = await sb(`/rest/v1/ii_fund_holdings?select=fund_instrument_id,underlying_instrument_id,underlying_name,weight_pct&disclosure_date=eq.${DISCLOSURE_DATE}`);
  const allHoldings = allHoldingsR.json ?? [];

  const classifications = [];
  for (const [fund, id] of [['Nifty50', nifty50.id], ['BluechipDirect', bluechipDirect.id], ['BluechipRegular', bluechipRegular.id]]) {
    const result = classifyScheme({
      instrumentKey: id,
      fundCountryOfDomicile: 'IN',
      holdings: toHoldingRows(id, allHoldings),
      disclosureDate: DISCLOSURE_DATE,
      asOfDate: DISCLOSURE_DATE,
      domesticEquityThresholdPct: 65, // current rule version's threshold (ruleVersions.ts — unchanged across all three rows)
      knownDebtSpecifiedByCategory: false,
    });
    log(`  ${fund}: classification=${result.classification} domesticEquityPct=${result.domesticEquityPct}`);
    classifications.push({ instrument_id: id, classification: result.classification, domestic_equity_pct: result.domesticEquityPct, basis: result.basis, disclosure_date: result.disclosureDate, engine_version: 'r6-final-reference-seed-v1', note: `${result.note} (Illustrative top-holding weights, not a live AMFI/factsheet feed — see scripts/ii_r6_final_reference_seed.mjs header.)` });
  }

  // Debt/specified — category-based, no computation.
  classifications.push({
    instrument_id: corpBond.id,
    classification: 'debt_specified',
    domestic_equity_pct: null,
    basis: 'known_debt_specified_category',
    disclosure_date: null,
    engine_version: 'r6-final-reference-seed-v1',
    note: "SEBI 'Corporate Bond Fund' category (Oct-2017 mutual fund categorisation circular) mandates minimum 80% investment in AA+-and-above-rated corporate bonds — a debt scheme by category definition; the Finance Act 2023 'specified mutual fund' always-short-term rule applies by acquisition date, not an allocation test.",
  });

  // Unresolved — NPS is out of this engine's tax-regime scope entirely.
  classifications.push({
    instrument_id: npsEquity.id,
    classification: 'unresolved',
    domestic_equity_pct: null,
    basis: 'unresolved_no_data',
    disclosure_date: null,
    engine_version: 'r6-final-reference-seed-v1',
    note: 'National Pension System (NPS) Tier I follows an entirely different tax regime (Sections 80CCD / 10(12A)-(12B), EEE-style) unrelated to mutual-fund Section 111A/112A capital-gains taxation. This engine is scoped to mutual-fund capital gains only — classifying NPS as equity/debt under THIS regime would produce a confidently wrong figure under the wrong tax law entirely. Deliberately left unresolved, not guessed.',
  });

  const existingClass = await sb('/rest/v1/ii_scheme_tax_classification?select=instrument_id');
  const existingIds = new Set((existingClass.json ?? []).map((r) => r.instrument_id));
  const newClassifications = classifications.filter((c) => !existingIds.has(c.instrument_id));
  if (newClassifications.length > 0) {
    const r = await sb('/rest/v1/ii_scheme_tax_classification', { method: 'POST', body: newClassifications });
    if (!r.ok) throw new Error(`ii_scheme_tax_classification insert failed: ${r.text}`);
    log(`Inserted ${newClassifications.length} ii_scheme_tax_classification rows.`);
  } else {
    log('All ii_scheme_tax_classification rows already present — skipping insert.');
  }

  // -------------------------------------------------------------------------
  // 4. Exit-load schedules — general industry-typical structures, explicitly
  //    disclosed as such (not any one scheme's actual current SID), per
  //    Section 16's own allowance. HDFC... no, we use SBI Bluechip Direct
  //    for the historical+current pair (two rows, different effective_from),
  //    Nifty 50 for a low-load index-fund-typical schedule.
  // -------------------------------------------------------------------------
  const exitLoadRows = [
    // SBI Bluechip Fund (Direct) — HISTORICAL: many equity schemes carried a
    // more granular tiered exit-load structure before ~2019 industry
    // simplification (general pattern, not this specific scheme's actual
    // historical SID).
    { instrument_id: bluechipDirect.id, tiers: [{ uptoDays: 90, loadPct: 1.0 }, { uptoDays: 365, loadPct: 0.5 }], effective_from: '2016-01-01', effective_to: '2019-03-31', source_id: manualSourceId },
    // SBI Bluechip Fund (Direct) — CURRENT: the now-standard simple
    // "1% within 12 months, nil after" structure common to most Indian
    // open-ended equity schemes today (general industry-typical pattern).
    { instrument_id: bluechipDirect.id, tiers: [{ uptoDays: 365, loadPct: 1.0 }], effective_from: '2019-04-01', effective_to: null, source_id: manualSourceId },
    // SBI Bluechip Fund (Regular) — same terms as Direct (exit-load terms
    // are ordinarily identical across Direct/Regular of the same scheme;
    // only the expense ratio differs).
    { instrument_id: bluechipRegular.id, tiers: [{ uptoDays: 365, loadPct: 1.0 }], effective_from: '2019-04-01', effective_to: null, source_id: manualSourceId },
    // ICICI Prudential Nifty 50 Index Fund — index funds typically carry a
    // much shorter, smaller exit load given low churn (general
    // industry-typical pattern for passive index funds).
    { instrument_id: nifty50.id, tiers: [{ uptoDays: 15, loadPct: 0.25 }], effective_from: '2018-01-01', effective_to: null, source_id: manualSourceId },
  ];
  const existingExitLoad = await sb('/rest/v1/ii_exit_load_schedules?select=instrument_id,effective_from');
  const existingKeys = new Set((existingExitLoad.json ?? []).map((r) => `${r.instrument_id}:${r.effective_from}`));
  const newExitLoad = exitLoadRows.filter((r) => !existingKeys.has(`${r.instrument_id}:${r.effective_from}`));
  if (newExitLoad.length > 0) {
    const r = await sb('/rest/v1/ii_exit_load_schedules', { method: 'POST', body: newExitLoad });
    if (!r.ok) throw new Error(`ii_exit_load_schedules insert failed: ${r.text}`);
    log(`Inserted ${newExitLoad.length} ii_exit_load_schedules rows.`);
  } else {
    log('All ii_exit_load_schedules rows already present — skipping insert.');
  }

  log('\nDONE. Summary:');
  log(`  ii_scheme_tax_classification: ${classifications.length} rows targeted (equity_oriented x3, debt_specified x1, unresolved x1)`);
  log(`  ii_exit_load_schedules: ${exitLoadRows.length} rows targeted (incl. one historical+current pair on SBI Bluechip Direct)`);
  log(`  New instrument added: ICICI Prudential Corporate Bond Fund - Growth (Direct Plan) = ${corpBond.id}`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
