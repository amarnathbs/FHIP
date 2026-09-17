// M7 (Part O) — PC7 live-DEV baseline of the existing look-through tables.
//
// The M0 scope ledger (2026-09-15) records ii_fund_holdings_snapshots as
// "zero rows, no ingestion code". Part W forbids claiming proof without
// re-verifying against CURRENT state, so this re-reads it. Reads only.
import fs from 'node:fs';
import path from 'node:path';

const ENV_CANDIDATES = ['.env.local', path.join('D:', 'FHIP', '.env.local')];
let raw = '';
for (const c of ENV_CANDIDATES) {
  if (fs.existsSync(c)) { raw = fs.readFileSync(c, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); break; }
}
const pick = (n) => raw.match(new RegExp(`^${n}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
const H = { apikey: key, Authorization: `Bearer ${key}` };

async function get(qs) {
  const r = await fetch(`${url}/rest/v1/${qs}`, { headers: H });
  if (!r.ok) return { error: `HTTP ${r.status}: ${await r.text()}` };
  return r.json();
}

console.log('=== ii_fund_holdings_snapshots (DEV) ===');
const snaps = await get('ii_fund_holdings_snapshots?select=id,fund_instrument_id,holdings_as_of_date,source_id,source_document_version,disclosed_weight_total_pct,quality_status,superseded_at,notes&order=holdings_as_of_date.desc');
console.log(JSON.stringify(snaps, null, 2).slice(0, 4000));

console.log('\n=== ii_fund_holdings_lines (DEV) count by snapshot ===');
console.log(JSON.stringify(await get('ii_fund_holdings_lines?select=id,snapshot_id&limit=20'), null, 2));

console.log('\n=== ii_fund_holdings (R1 shape table, DEV) ===');
const fh = await get('ii_fund_holdings?select=fund_instrument_id,underlying_instrument_id,underlying_name,disclosure_date,weight_pct,source_id&order=disclosure_date.desc&limit=40');
console.log(JSON.stringify(fh, null, 2).slice(0, 4000));

console.log('\n=== ii_sources (DEV) ===');
console.log(JSON.stringify(await get('ii_sources?select=*'), null, 2).slice(0, 3000));

console.log('\n=== ii_instruments (DEV) sample + country/type mix ===');
const inst = await get('ii_instruments?select=id,instrument_type,country_code,name,amfi_scheme_code&limit=300');
if (!inst.error) {
  const byType = {};
  for (const i of inst) byType[`${i.country_code}/${i.instrument_type}`] = (byType[`${i.country_code}/${i.instrument_type}`] || 0) + 1;
  console.log(JSON.stringify(byType, null, 2));
  console.log('sample:', JSON.stringify(inst.slice(0, 5), null, 2));
} else console.log(inst.error);
