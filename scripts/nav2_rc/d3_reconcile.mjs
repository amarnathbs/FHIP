// NAV2 release candidate, D3: the same holdings, valued at ONE timestamp, on every surface that shows them, against an independent calculation.
// Surfaces: Holdings (Performance tab drilldown), Performance (analytics total), Investment Intelligence overview, Investments (published valuations),
// Dashboard / Net Worth, and the Fund Analytics report. Independent: canonical units (sum of the user's transactions) x the latest ELIGIBLE NAV on or before the
// valuation date (INR, quality ok, not superseded, never a future date), computed from the raw rows with the stage 3 oracle, not from any surface.
// Then the exclusion cases: a FUTURE-dated NAV and a WRONG-CURRENCY NAV are inserted for a held fund (marked, removed again in a finally block) and no surface
// may move. A manual investment must be byte-identical before and after.
//   node scripts/nav2_rc/d3_reconcile.mjs      (app on port 3981, fixture user "holder" holds A, B (active) and C (redeemed); A is published by journey 1+2)
import crypto from 'node:crypto';
import { api, check, db, logoutAll, save, summary, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
import { generate, storedRow } from '../nav2_stage3/_flow.mjs';
import { loadNav, navOnOrBefore } from '../nav2_stage3/oracle.mjs';

const email = USERS.holder;
const uid = await userIdOf(email);
const asOf = new Date().toISOString().slice(0, 10);
const MARK = 'NAV2RC_FIXTURE:d3-exclusion';
const undo = [];
const r2 = (x) => Math.round(x * 100) / 100;
console.log(`=== D3 financial reconciliation  valuation date ${asOf}  ${new Date().toISOString()} ===`);
try {
  // ---- independent figures -------------------------------------------------------------------------------------------------------------------------------
  const tx = (await db.from('ii_transactions').select('instrument_id, transaction_type, units, status').eq('user_id', uid).neq('status', 'reversed')).data ?? [];
  const buy = (t) => ['purchase', 'sip', 'switch_in', 'reinvestment'].includes(t.transaction_type);
  const units = new Map();
  for (const t of tx) units.set(t.instrument_id, (units.get(t.instrument_id) ?? 0) + (buy(t) ? 1 : -1) * Number(t.units ?? 0));
  const indep = new Map();
  for (const [id, u0] of units) {
    const u = Math.round(u0 * 1e6) / 1e6;
    const nav = await loadNav(id);
    const last = navOnOrBefore(nav, asOf, 3650);
    indep.set(id, { units: u, nav: last?.nav ?? null, navDate: last?.date ?? null, value: u === 0 ? 0 : r2(u * last.nav) });
  }
  const indepTotal = r2([...indep.values()].reduce((s, x) => s + x.value, 0));
  console.log('independent:', JSON.stringify([...indep].map(([id, x]) => [id.slice(0, 8), x.units, x.navDate, x.value])), 'total', indepTotal);

  const manualBefore = (await db.from('investments').select('id, current_value, updated_at, investment_name').eq('user_id', uid).is('ii_canonical_account_id', null)).data ?? [];
  const manualHash = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const mh0 = manualHash(manualBefore);
  console.log(`   manual investments (not created by publishing): ${manualBefore.length}, sum ${manualBefore.reduce((s, x) => s + Number(x.current_value), 0)}`);

  // ---- surfaces ----------------------------------------------------------------------------------------------------------------------------------------
  async function surfaces(label) {
    const out = { label };
    const h = (await api(email, 'GET', '/api/investment-intelligence/holdings')).json?.data;
    out.holdings = new Map((h?.holdings ?? []).map((x) => [x.instrumentId, { value: x.marketValue, nav: x.nav, navDate: x.navDate, basis: x.valuationBasis }]));
    out.holdingsTotal = r2([...out.holdings.values()].reduce((s, x) => s + (x.value ?? 0), 0));
    const a = (await api(email, 'GET', '/api/investment-intelligence/analytics')).json?.data?.results;
    out.performanceTotal = a?.portfolios?.[0]?.totalValue ?? null;
    out.performanceAsOf = a?.asOfDate ?? null;
    const o = (await api(email, 'GET', '/api/investment-intelligence/overview')).json?.data;
    out.overviewTotal = o?.portfolio?.valueByCurrency?.[0]?.totalValue ?? null;
    const pv = (await api(email, 'GET', '/api/investments/published-valuations')).json;
    out.publishedLines = pv?.lines ?? pv?.data?.lines ?? [];
    out.publishedSummary = pv?.summary ?? pv?.data?.summary ?? null;
    const dsh = (await api(email, 'GET', '/api/dashboard/summary')).json?.data;
    out.dashboard = { totalInvestments: dsh?.totalInvestments, netWorth: dsh?.netWorth, totalAssets: dsh?.totalAssets };
    const g = await generate(email);
    out.reportOk = g.status === 201;
    if (g.id) {
      const row = await storedRow(g.id);
      out.report = new Map(row.report_json.schemes.map((s) => [s.instrumentId, { value: s.investor?.valuation?.marketValue ?? null, basis: s.investor?.valuation?.basis ?? null }]));
      out.reportId = g.id;
    }
    return out;
  }
  const s1 = await surfaces('baseline');
  save('d3_baseline.json', { ...s1, holdings: [...s1.holdings], report: s1.report ? [...s1.report] : null });
  console.log('   performance as-of', s1.performanceAsOf, '| dashboard', JSON.stringify(s1.dashboard), '| published lines', s1.publishedLines.length, JSON.stringify(s1.publishedSummary));

  for (const [id, x] of indep) {
    const hv = s1.holdings.get(id)?.value;
    check(`HOLDINGS equals units x latest NAV for ${id.slice(0, 8)} (${x.value})`, hv !== undefined && Math.abs(hv - x.value) < 0.02, `surface ${hv}`);
    const rv = s1.report?.get(id)?.value;
    check(`FUND ANALYTICS equals units x latest NAV for ${id.slice(0, 8)}`, rv !== undefined && rv !== null && Math.abs(rv - x.value) < 0.02, `surface ${rv}`);
  }
  check('HOLDINGS total equals the independent total', Math.abs(s1.holdingsTotal - indepTotal) < 0.05, `${s1.holdingsTotal} vs ${indepTotal}`);
  check('PERFORMANCE total equals the independent total', s1.performanceTotal !== null && Math.abs(s1.performanceTotal - indepTotal) < 0.05, `${s1.performanceTotal} vs ${indepTotal}`);
  check('OVERVIEW total equals the independent total', s1.overviewTotal !== null && Math.abs(s1.overviewTotal - indepTotal) < 0.05, `${s1.overviewTotal} vs ${indepTotal}`);
  const fundTotal = r2([...(s1.report?.values() ?? [])].reduce((s, x) => s + (x.value ?? 0), 0));
  check('FUND ANALYTICS total equals the independent total (personal funds, joint at the user\'s share)', Math.abs(fundTotal - indepTotal) < 0.05, `${fundTotal} vs ${indepTotal}`);
  const red = [...indep].filter(([, x]) => x.units === 0);
  check('a fully REDEEMED holding is exactly zero on Holdings and the report', red.length >= 1 && red.every(([id]) => s1.holdings.get(id)?.value === 0 && s1.report?.get(id)?.value === 0));
  check('every active holding is valued on the latest market NAV (not the statement)', [...indep].filter(([, x]) => x.units > 0).every(([id]) => s1.holdings.get(id)?.basis === 'market_nav'));
  check('INVESTMENTS (published valuations) marks the published position at the same NAV-based value', s1.publishedLines.length === 0 || s1.publishedLines.every((l) => { const v = l.marketValue ?? l.currentValue ?? l.value; const id = l.instrumentId; return id ? Math.abs(v - (indep.get(id)?.value ?? NaN)) < 0.02 : true; }), JSON.stringify(s1.publishedLines).slice(0, 200));

  // ---- the manual investments are untouched by all of this -------------------------------------------------------------------------------------------
  const manualAfter = (await db.from('investments').select('id, current_value, updated_at, investment_name').eq('user_id', uid).is('ii_canonical_account_id', null)).data ?? [];
  check('MANUAL investments are byte-identical after the valuations and the report', manualHash(manualAfter) === mh0);

  // ---- a FUTURE-dated NAV and a WRONG-CURRENCY NAV must move nothing ---------------------------------------------------------------------------------
  const heldFund = [...indep].find(([, x]) => x.units > 0)[0];
  const lastRow = (await db.from('ii_prices_nav').select('*').eq('instrument_id', heldFund).order('price_date', { ascending: false }).limit(1)).data[0];
  const day = (d, n) => new Date(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const future = { ...lastRow, id: undefined, price_date: day(asOf, 3), price: Number(lastRow.price) * 10, data_version: MARK, record_checksum: null };
  // wrong currency: a date after the latest real NAV but not after today, in AUD, at ten times the price
  const wrongDate = day(lastRow.price_date, 1) <= asOf ? day(lastRow.price_date, 1) : null;
  const wrong = wrongDate ? { ...lastRow, id: undefined, price_date: wrongDate, price: Number(lastRow.price) * 10, currency_code: 'AUD', data_version: MARK, record_checksum: null } : null;
  for (const [label, row] of [['future-dated', future], ['wrong-currency', wrong]]) {
    if (!row) { console.log(`   (${label}: no free date between the latest NAV ${lastRow.price_date} and today)`); continue; }
    delete row.id;
    const ins = await db.from('ii_prices_nav').insert(row).select('id').single();
    if (ins.error) { check(`the synthetic ${label} NAV could be inserted for the test`, false, ins.error.message.slice(0, 120)); continue; }
    undo.push(async () => db.from('ii_prices_nav').delete().eq('id', ins.data.id));
    check(`a synthetic ${label} NAV (ten times the price) was inserted for fund ${heldFund.slice(0, 8)}`, true);
  }
  const s2 = await surfaces('with the future-dated and wrong-currency NAV present');
  check('EXCLUDED: Holdings value of the fund is unchanged by a future-dated and a wrong-currency NAV', s2.holdings.get(heldFund)?.value === s1.holdings.get(heldFund)?.value, `${s1.holdings.get(heldFund)?.value} -> ${s2.holdings.get(heldFund)?.value}`);
  check('EXCLUDED: Performance and Overview totals are unchanged', Math.abs((s2.performanceTotal ?? 0) - (s1.performanceTotal ?? 0)) < 0.02 && Math.abs((s2.overviewTotal ?? 0) - (s1.overviewTotal ?? 0)) < 0.02);
  check('EXCLUDED: the Fund Analytics value of the fund is unchanged (and a NEW report was made)', s2.reportId !== s1.reportId && s2.report?.get(heldFund)?.value === s1.report?.get(heldFund)?.value, `${s1.report?.get(heldFund)?.value} -> ${s2.report?.get(heldFund)?.value}`);
  check('EXCLUDED: the Dashboard figures are unchanged', JSON.stringify(s2.dashboard) === JSON.stringify(s1.dashboard));
  for (const u of undo.splice(0)) await u();
  const left = (await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('data_version', MARK)).count;
  check('the synthetic NAV rows are removed again', left === 0, `${left} left`);
} finally {
  for (const u of undo.splice(0)) { try { await u(); } catch (e) { console.log('   undo failed', e.message); } }
  await logoutAll();
  const s = summary();
  save('d3_results.json', s);
  console.log(`\n=== D3: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
