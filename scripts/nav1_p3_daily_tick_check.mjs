// NAV 1 completion (2026-09-25), brief P3 -- READ-ONLY check of a scheduled
// daily NAV tick in production, plus an INDEPENDENT comparison against AMFI's
// own NAVAll.txt for the NAV date the tick should have collected.
//
// Production is read with GET only (host asserted). AMFI: one request.
//
// Usage: node scripts/nav1_p3_daily_tick_check.mjs <tickIsoUtc> <navDate yyyy-mm-dd> <outFile>
//   e.g. node scripts/nav1_p3_daily_tick_check.mjs 2026-09-25T03:30:00Z 2026-09-24 out.json

import fs from 'node:fs';

const [tick, navDate, outFile] = process.argv.slice(2);
if (!tick || !navDate || !outFile) { console.error('usage: <tickIsoUtc> <navDate> <outFile>'); process.exit(2); }
const HOST = 'twwpnltizhtjxhamyoxt.supabase.co';
const env = Object.fromEntries(fs.readFileSync('D:/FHIP/.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const BASE = env.PRODUCTION_SUPABASE_URL, KEY = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
async function get(q, prefer) {
  if (new URL(BASE).host !== HOST) throw new Error('HOST ASSERTION FAILED');
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method: 'GET', headers });
  if (r.status >= 400) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return { body: await r.json(), range: r.headers.get('content-range') };
}
async function pageAll(q, order) {
  const out = [];
  for (let o = 0; ; o += 1000) { const { body } = await get(`${q}&order=${order}&limit=1000&offset=${o}`); out.push(...body); if (body.length < 1000) return out; }
}
const count = async (t, f) => Number((await get(`${t}?select=*&${f}&limit=1`, 'count=exact')).range.split('/')[1]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const amfiDate = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;

const out = { tick, navDate, checkedAt: new Date().toISOString() };
const t0 = new Date(Date.parse(tick) - 5 * 60000).toISOString();
const t1 = new Date(Date.parse(tick) + 60 * 60000).toISOString();

// 1. The batch(es) the tick produced.
out.batches = (await get(`ii_reference_import_batches?select=id,source_key,batch_kind,status,started_at,finished_at,as_of_date,rows_read,rows_accepted,rows_rejected,rows_inserted,rows_unchanged,rows_superseded,error_code,source_retrieved_at,source_sha256,parser_version&started_at=gte.${t0}&started_at=lt.${t1}&batch_kind=neq.nav_hydration&order=started_at.asc`)).body
  .map((b) => ({ ...b, source_sha256: b.source_sha256 ? `${b.source_sha256.slice(0, 12)}…` : null, seconds_after_tick: (Date.parse(b.started_at) - Date.parse(tick)) / 1000, duration_s: b.finished_at ? (Date.parse(b.finished_at) - Date.parse(b.started_at)) / 1000 : null }));
out.daily_batches_in_window = out.batches.filter((b) => b.batch_kind === 'daily_nav').length;
// 2. Job control.
out.job_control = (await get(`ii_reference_job_control?select=job_key,enabled,last_success_at,last_failure_at,consecutive_failures&job_key=in.(pc6_amfi_daily_nav,pc6_amfi_scheme_master,pc6_full_universe_historical_backfill,pc6_selective_historical_hydration)&order=job_key`)).body;
// 3. Coverage for the NAV date, and the trailing dates (drift watch).
out.coverage = {};
for (let i = 0; i < 7; i++) {
  const d = new Date(Date.parse(`${navDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
  out.coverage[d] = await count('ii_prices_nav', `price_date=eq.${d}`);
}
// 4. Provenance of the NAV-date rows.
const rows = await pageAll(`ii_prices_nav?select=id,instrument_id,price,data_version,source_timestamp&price_date=eq.${navDate}`, 'id');
out.nav_date_rows = rows.length;
out.nav_date_provenance = rows.reduce((a, r) => { const k = (r.data_version ?? 'null').split(':')[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
out.nav_date_source_timestamp_range = [rows.map((r) => r.source_timestamp).sort()[0], rows.map((r) => r.source_timestamp).sort().at(-1)];
out.nav_date_duplicate_instruments = rows.length - new Set(rows.map((r) => r.instrument_id)).size;
out.nav_date_non_positive = rows.filter((r) => !(Number(r.price) > 0)).length;

// 5. Independent AMFI comparison (NAVAll.txt, one request).
const res = await fetch('https://portal.amfiindia.com/spages/NAVAll.txt', { headers: { 'User-Agent': 'FHIP-NAV1-P3-independent-check/1.0' }, signal: AbortSignal.timeout(60000) });
const text = (await res.text()).replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);
const hdr = lines.find((l) => l.startsWith('Scheme Code;')).split(';').map((h) => h.trim());
const iCode = hdr.indexOf('Scheme Code'), iNav = hdr.indexOf('Net Asset Value'), iDate = hdr.indexOf('Date');
const amfi = new Map();
const amfiDates = {};
for (const l of lines) {
  const f = l.split(';');
  if (f.length <= iDate || !/^\d+$/.test(f[iCode]?.trim() ?? '')) continue;
  const d = f[iDate].trim();
  amfiDates[d] = (amfiDates[d] ?? 0) + 1;
  if (d === amfiDate(navDate) && Number(f[iNav]) > 0) amfi.set(f[iCode].trim(), Number(f[iNav]));
}
out.amfi_navall = { http: res.status, schemes_total: Object.values(amfiDates).reduce((a, b) => a + b, 0), schemes_for_nav_date: amfi.size, top_dates: Object.entries(amfiDates).sort((a, b) => b[1] - a[1]).slice(0, 4) };
const ids = await pageAll('ii_instrument_identifiers?select=id,instrument_id,identifier_value&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true', 'id');
const codeOf = new Map(ids.map((r) => [r.instrument_id, r.identifier_value]));
let compared = 0, exact = 0, notOnFile = 0;
const mism = [];
const onFileCodes = new Set();
for (const r of rows) {
  const code = codeOf.get(r.instrument_id);
  if (!code) continue;
  onFileCodes.add(code);
  if (!amfi.has(code)) continue;
  compared++;
  if (amfi.get(code) === Number(r.price)) exact++; else mism.push({ code, amfi: amfi.get(code), on_file: Number(r.price) });
}
for (const c of amfi.keys()) if (!onFileCodes.has(c)) notOnFile++;
out.amfi_comparison = { compared, exact, mismatches: compared - exact, mismatch_sample: mism.slice(0, 5), amfi_schemes_for_date_not_on_file: notOnFile, on_file_without_amfi_code: rows.filter((r) => !codeOf.get(r.instrument_id)).length };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
