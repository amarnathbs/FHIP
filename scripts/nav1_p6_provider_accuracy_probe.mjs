// NAV 1 completion (2026-09-25), brief P6 -- provider accuracy, READ-ONLY.
//
// For the instruments users hold (the only ones hydration writes):
//   1. provenance of every stored NAV row (provider prefix of data_version),
//      and structural validity (positive NAV, one row per date);
//   2. an INDEPENDENT reconciliation against AMFI: a fresh fetch of AMFI's
//      NAV history for sampled windows, parsed here with a separate parser
//      (not the adapter under test), compared value-for-value with the rows
//      on file;
//   3. plan/option coverage of the sample (direct/regular, growth/IDCW).
// Production is read with GET only (host asserted, non-GET refused). AMFI is
// called sequentially with a pause between requests.
//
// Usage: node scripts/nav1_p6_provider_accuracy_probe.mjs <prod|dev> <outFile>

import fs from 'node:fs';

const TARGETS = {
  prod: { host: 'twwpnltizhtjxhamyoxt.supabase.co', urlKey: 'PRODUCTION_SUPABASE_URL', keyKey: 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY' },
  dev: { host: 'vqycarelcoijzwlpkpcz.supabase.co', urlKey: 'NEXT_PUBLIC_SUPABASE_URL', keyKey: 'SUPABASE_SERVICE_ROLE_KEY' },
};
const T = TARGETS[process.argv[2]];
const outFile = process.argv[3];
if (!T || !outFile) { console.error('usage: <prod|dev> <outFile>'); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync('D:/FHIP/.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const BASE = env[T.urlKey], KEY = env[T.keyKey];
async function get(q) {
  if (new URL(BASE).host !== T.host) throw new Error('HOST ASSERTION FAILED');
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method: 'GET', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (r.status >= 400) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function pageAll(q, order) {
  const out = [];
  for (let o = 0; ; o += 1000) { const b = await get(`${q}&order=${order}&limit=1000&offset=${o}`); out.push(...b); if (b.length < 1000) return out; }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const amfiDate = (iso) => `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const isoFromAmfi = (d) => { const [dd, mmm, yyyy] = d.split('-'); return `${yyyy}-${String(MONTHS.indexOf(mmm) + 1).padStart(2, '0')}-${dd.padStart(2, '0')}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { environment: T.host, at: new Date().toISOString(), instruments: [], reconciliation: [], summary: {} };

// ---- 1. provenance + structure -------------------------------------------------
const held = (await pageAll('rpc/pc6_user_held_instrument_ids?select=instrument_id', 'instrument_id')).map((r) => r.instrument_id);
const houses = new Map((await get('ii_amfi_fund_houses?select=fund_house_code,amc_name')).map((r) => [r.amc_name.replace(/\s+/g, ' ').trim().toLowerCase(), r.fund_house_code]));
const providerTotals = {};
for (const id of held) {
  const rows = await pageAll(`ii_prices_nav?select=id,price_date,price,data_version&instrument_id=eq.${id}`, 'id');
  const byProvider = {};
  for (const r of rows) { const p = (r.data_version ?? 'null').split(':')[0]; byProvider[p] = (byProvider[p] ?? 0) + 1; providerTotals[p] = (providerTotals[p] ?? 0) + 1; }
  const dates = new Set(rows.map((r) => r.price_date));
  const code = (await get(`ii_instrument_identifiers?select=identifier_value&instrument_id=eq.${id}&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true`))[0]?.identifier_value ?? null;
  const sm = code ? (await get(`ii_scheme_master?select=amc_name,plan_type,option_type&amfi_scheme_code=eq.${code}&limit=1`))[0] : null;
  result.instruments.push({
    instrument_id: id, amfi_code: code, plan_type: sm?.plan_type ?? null, option_type: sm?.option_type ?? null,
    fund_house: sm?.amc_name ? houses.get(sm.amc_name.replace(/\s+/g, ' ').trim().toLowerCase()) ?? null : null,
    rows: rows.length, first: rows.map((r) => r.price_date).sort()[0], by_provider: byProvider,
    non_positive_nav: rows.filter((r) => !(Number(r.price) > 0)).length, duplicate_dates: rows.length - dates.size,
    _rows: rows,
  });
}
result.summary.provenance_all_held_rows = providerTotals;
result.summary.structural = { non_positive_nav: result.instruments.reduce((a, x) => a + x.non_positive_nav, 0), duplicate_dates: result.instruments.reduce((a, x) => a + x.duplicate_dates, 0) };

// ---- 2. independent AMFI reconciliation ----------------------------------------------
// Three sample windows per instrument, spread across its history, 20 days each.
const sampleWindows = (first) => {
  const f = Date.parse(first), c = Date.parse('2026-09-18');
  return [0.15, 0.5, 0.85].map((q) => { const s = new Date(f + (c - f) * q); const e = new Date(s.getTime() + 20 * 86400000); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]; });
};
let compared = 0, matched = 0, amfiMissing = 0, dbMissing = 0, requests = 0;
for (const inst of result.instruments) {
  if (!inst.amfi_code || !inst.fund_house) { result.reconciliation.push({ instrument_id: inst.instrument_id, skipped: 'no AMFI code or fund house' }); continue; }
  const onFile = new Map(inst._rows.map((r) => [r.price_date, Number(r.price)]));
  for (const [from, to] of sampleWindows(inst.first)) {
    const url = `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${amfiDate(from)}&todt=${amfiDate(to)}&mf=${inst.fund_house}`;
    requests++;
    const res = await fetch(url, { headers: { 'User-Agent': 'FHIP-NAV1-P6-independent-reconciliation/1.0' }, signal: AbortSignal.timeout(45000) }).catch((e) => ({ status: 0, text: async () => String(e) }));
    const body = (await res.text()).replace(/^\uFEFF/, '');
    await sleep(1500);
    if (!body.trimStart().startsWith('Scheme Code;')) {
      result.reconciliation.push({ instrument_id: inst.instrument_id, window: [from, to], http: res.status, amfi: /No data found/i.test(body) ? 'no_data' : 'unrecognised_body' });
      continue;
    }
    // Independent parse, columns located BY HEADER NAME. AMFI's layout today is
    // 'Scheme Code;NAV Name;Plan;Option;ISIN..;ISIN..;Net Asset Value;Date'.
    const lines = body.split(/\r?\n/);
    const header = lines[0].split(';').map((h) => h.trim());
    const iCode = header.indexOf('Scheme Code'), iNav = header.indexOf('Net Asset Value'), iDate = header.indexOf('Date');
    if (iCode < 0 || iNav < 0 || iDate < 0) throw new Error(`AMFI header changed: ${lines[0]}`);
    const amfi = new Map();
    for (const line of lines.slice(1)) {
      const f = line.split(';');
      if (f.length > iDate && f[iCode].trim() === inst.amfi_code && /^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(f[iDate].trim())) amfi.set(isoFromAmfi(f[iDate].trim()), Number(f[iNav]));
    }
    const mism = [];
    let c = 0, m = 0, am = 0, dm = 0;
    for (const [d, v] of amfi) { if (!onFile.has(d)) { dm++; continue; } c++; if (onFile.get(d) === v) m++; else mism.push({ date: d, amfi: v, on_file: onFile.get(d) }); }
    for (const d of onFile.keys()) if (d >= from && d <= to && !amfi.has(d)) am++;
    compared += c; matched += m; amfiMissing += am; dbMissing += dm;
    result.reconciliation.push({ instrument_id: inst.instrument_id, amfi_code: inst.amfi_code, window: [from, to], amfi_dates: amfi.size, compared: c, exact_matches: m, mismatches: mism.slice(0, 5), on_file_not_in_amfi: am, amfi_not_on_file: dm });
  }
}
for (const i of result.instruments) delete i._rows;
result.summary.reconciliation = { amfi_requests: requests, values_compared: compared, exact_matches: matched, mismatches: compared - matched, on_file_not_in_amfi: amfiMissing, amfi_not_on_file: dbMissing };
result.summary.plan_option_mix = result.instruments.reduce((a, i) => { const k = `${i.plan_type}/${i.option_type}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.summary, null, 1));
