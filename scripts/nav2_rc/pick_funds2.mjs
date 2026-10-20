// READ-ONLY (DEV database) plus public mfapi.in: picks Direct plan mutual funds from the DEV scheme master that have an ISIN and an AMFI code, whose instrument has an
// identical ISIN and AMFI identifier, that currently hold NO stored NAV history (so the planner has to fetch it for a user who holds them), and that mfapi.in
// shows at least 900 daily prices for up to October 2026. Writes test-artifacts/nav2_rc/candidate_funds.json (used by the 10 and 20 fund journeys).
import fs from 'node:fs';
import { db } from '../nav2_stage3/_lib.mjs';

const want = Number(process.argv[2] ?? 30);
const subs = ['Large Cap Fund', 'Flexi Cap Fund', 'Mid Cap Fund', 'Small Cap Fund', 'ELSS', 'Multi Cap Fund', 'Value Fund', 'Focused Fund', 'Large & Mid Cap Fund', 'Contra Fund', 'Dividend Yield Fund', 'Corporate Bond Fund', 'Banking and PSU Fund', 'Short Duration Fund', 'Aggressive Hybrid Fund', 'Index Funds', 'Equity Savings', 'Arbitrage Fund', 'Conservative Hybrid Fund', 'Dynamic Asset Allocation', 'Sectoral/Thematic', 'Gilt Fund', 'Liquid Fund', 'Ultra Short Duration Fund'];
const out = [];
const stage = { schemeMaster: 0, instrumentMatches: 0, noNav: 0, mfapiOk: 0 };
const skipAmfi = new Set(['119018', '118632', '118987', '120590', '118955', '122639']);
for (const sub of subs) {
  if (out.length >= want) break;
  const { data: sm } = await db.from('ii_scheme_master').select('instrument_id, amfi_scheme_code, scheme_name, isin_growth_or_payout, amc_name, sub_category').eq('plan_type', 'direct').eq('country_code', 'IN').eq('lifecycle_status', 'active').is('effective_to', null).not('isin_growth_or_payout', 'is', null).ilike('sub_category', `%${sub}%`).limit(60);
  stage.schemeMaster += sm?.length ?? 0;
  const ids = (sm ?? []).map((r) => r.instrument_id).filter(Boolean);
  if (!ids.length) continue;
  const { data: inst } = await db.from('ii_instruments').select('id, instrument_name, isin, instrument_class, base_currency').in('id', ids);
  const { data: idf } = await db.from('ii_instrument_identifiers').select('instrument_id, identifier_value').eq('identifier_scheme', 'amfi_scheme_code').in('instrument_id', ids);
  const { data: navd } = await db.from('ii_prices_nav').select('instrument_id').in('instrument_id', ids).limit(5000);
  const hasNav = new Set((navd ?? []).map((r) => r.instrument_id));
  const instBy = new Map((inst ?? []).map((i) => [i.id, i]));
  const idBy = new Map((idf ?? []).map((r) => [r.instrument_id, r.identifier_value]));
  let triedHere = 0;
  for (const r of sm) {
    if (out.length >= want || triedHere >= 12) break;
    const i = instBy.get(r.instrument_id);
    if (!i || i.instrument_class !== 'mutual_fund' || i.base_currency !== 'INR') continue;
    if ((i.isin ?? '').toUpperCase() !== r.isin_growth_or_payout.toUpperCase()) continue;
    if (idBy.get(r.instrument_id) !== r.amfi_scheme_code || skipAmfi.has(r.amfi_scheme_code)) continue;
    if (out.some((o) => o.instrumentId === r.instrument_id)) continue;
    stage.instrumentMatches++;
    if (hasNav.has(r.instrument_id)) continue;
    stage.noNav++;
    triedHere++;
    let meta;
    try { meta = await (await fetch(`https://api.mfapi.in/mf/${r.amfi_scheme_code}`)).json(); } catch { continue; }
    const data = meta?.data ?? [];
    if (data.length < 900) continue;
    const newest = data[0]?.date;
    if (!newest || newest.split('-').reverse().join('-') < '2026-10-01') continue;
    if (String(meta?.meta?.isin_growth ?? '').toUpperCase() !== r.isin_growth_or_payout.toUpperCase()) continue;
    stage.mfapiOk++;
    out.push({ instrumentId: r.instrument_id, name: r.scheme_name, amc: r.amc_name, sub, isin: r.isin_growth_or_payout, amfi: r.amfi_scheme_code, mfapiRows: data.length, newest });
    console.log(String(out.length).padStart(2), r.scheme_name.slice(0, 58).padEnd(60), r.isin_growth_or_payout, r.amfi_scheme_code, data.length, newest);
  }
}
fs.mkdirSync('test-artifacts/nav2_rc', { recursive: true });
fs.writeFileSync('test-artifacts/nav2_rc/candidate_funds.json', JSON.stringify(out, null, 1));
console.log('candidates', out.length, JSON.stringify(stage));
