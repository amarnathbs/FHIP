// DEV only, release candidate timing fixture. The application's own selective hydration was proven for the big-user fund set (see the report), but the public
// source (mfapi.in) timed out for many of the funds from this machine, so the 20-fund TIMING needs the missing history from another path: the published AMFI NAV
// series for each chosen fund, fetched here with generous timeouts and retries, and inserted for the dates BEFORE the earliest stored price, marked
// data_version = NAV2RC_FIXTURE:mfapi-history so the cleanup deletes exactly these rows (cleanup_rc.mjs removes every NAV2RC_FIXTURE row).
//   node scripts/nav2_rc/load_history_fixture.mjs <ids-file.json>      ids-file = JSON array of { instrumentId, amfi }
import fs from 'node:fs';
import { db } from '../nav2_stage3/_lib.mjs';

const MARK = 'NAV2RC_FIXTURE:mfapi-history';
const funds = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const get = async (amfi) => {
  for (let a = 1; a <= 6; a++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch(`https://api.mfapi.in/mf/${amfi}`, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 3000 * a));
  }
  return null;
};
let total = 0;
for (const f of funds) {
  const { data: first } = await db.from('ii_prices_nav').select('price_date').eq('instrument_id', f.instrumentId).order('price_date', { ascending: true }).limit(1);
  const before = first?.[0]?.price_date ? String(first[0].price_date).slice(0, 10) : '2026-09-21';
  if (before <= (process.env.RC_REACH ?? '2019-03-01')) { console.log(f.instrumentId.slice(0, 8), 'already reaches back to', before); continue; }
  const j = await get(f.amfi);
  if (!j?.data) { console.log(f.instrumentId.slice(0, 8), 'source unavailable after retries'); continue; }
  const rows = j.data.map((r) => ({ date: r.date.split('-').reverse().join('-'), nav: Number(r.nav) })).filter((r) => r.date < before && r.nav > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const payload = rows.slice(i, i + 500).map((r) => ({ instrument_id: f.instrumentId, source_id: null, currency_code: 'INR', price_date: r.date, price: r.nav, data_version: MARK, quality_status: 'ok', source_timestamp: new Date().toISOString() }));
    const ins = await db.from('ii_prices_nav').insert(payload).select('id');
    if (ins.error) { console.log(f.instrumentId.slice(0, 8), 'INSERT FAILED', ins.error.message.slice(0, 120)); break; }
    n += ins.data.length;
  }
  total += n;
  console.log(f.instrumentId.slice(0, 8), `inserted ${n} rows before ${before}${rows[0] ? ` (from ${rows[0].date})` : ''}`);
}
console.log('total inserted', total);
