// DEV only, release candidate fixture: the five standing funds (A to E) have no NAV after 01-10-2026 on DEV because no daily ingest has run there since, so every
// ten-day boundary rule makes a report as at today "insufficient history". This loads the PUBLISHED AMFI NAV (via mfapi.in, the same source the repo's statement
// builder uses) for the missing days, for those five funds only, marked data_version = NAV2RC_FIXTURE:mfapi so the cleanup deletes exactly these rows.
//   node scripts/nav2_rc/load_recent_nav.mjs            load
//   node scripts/nav2_rc/load_recent_nav.mjs --remove   delete exactly the rows carrying the marker
import { db } from '../nav2_stage3/_lib.mjs';
import { FUND } from '../nav2_stage3/_flow.mjs';

const MARK = 'NAV2RC_FIXTURE:mfapi';
const AMFI = { A: '119018', B: '118632', C: '118987', D: '120590', E: '118955' };
if (process.argv.includes('--remove')) {
  const { data: rows } = await db.from('ii_prices_nav').select('id').eq('data_version', MARK);
  const ids = (rows ?? []).map((r) => r.id);
  let removed = 0;
  for (let i = 0; i < ids.length; i += 200) { const r = await db.from('ii_prices_nav').delete().in('id', ids.slice(i, i + 200)).select('id'); if (r.error) throw new Error(r.error.message); removed += r.data.length; }
  console.log(`marked rows found ${ids.length}, deleted ${removed}`);
  const { count } = await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('data_version', MARK);
  console.log(`remaining with the marker: ${count}`);
  process.exit(0);
}
let inserted = 0;
for (const [k, id] of Object.entries(FUND)) {
  const amfi = AMFI[k];
  if (!amfi) continue;
  const { data: last } = await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date', { ascending: false }).limit(1);
  const from = last?.[0]?.price_date ?? '1900-01-01';
  const j = await (await fetch(`https://api.mfapi.in/mf/${amfi}`)).json();
  const rows = j.data.map((r) => ({ date: r.date.split('-').reverse().join('-'), nav: Number(r.nav) })).filter((r) => r.date > String(from).slice(0, 10) && r.nav > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) { console.log(k, 'nothing newer than', from); continue; }
  const payload = rows.map((r) => ({ instrument_id: id, source_id: null, currency_code: 'INR', price_date: r.date, price: r.nav, data_version: MARK, quality_status: 'ok', source_timestamp: new Date().toISOString() }));
  const ins = await db.from('ii_prices_nav').insert(payload).select('id');
  if (ins.error) { console.log(k, 'INSERT FAILED', ins.error.message.slice(0, 150)); continue; }
  inserted += ins.data.length;
  console.log(k, `inserted ${ins.data.length} (${rows[0].date} .. ${rows[rows.length - 1].date}) after ${String(from).slice(0, 10)}`);
}
console.log('total inserted', inserted);
