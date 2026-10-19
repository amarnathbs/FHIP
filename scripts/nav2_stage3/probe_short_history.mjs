// Read-only: which coherent funds on DEV have SHORT stored NAV history (candidates for the live held-only fetch proof)?
import { db } from './_lib.mjs';
const ids = ['37a3d60e-47db-4fb9-af8b-4a174dfa1f2f'];
for (const id of ids) {
  const inst = (await db.from('ii_instruments').select('instrument_name, plan_type, option_type').eq('id', id).single()).data;
  const first = (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date').limit(1)).data?.[0]?.price_date;
  const last = (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date', { ascending: false }).limit(1)).data?.[0]?.price_date;
  const cnt = (await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', id)).count;
  const sm = (await db.from('ii_scheme_master').select('amfi_scheme_code, scheme_name, isin_growth, isin_div_payout').eq('instrument_id', id)).data;
  console.log(id.slice(0, 8), JSON.stringify(inst), first, last, cnt, JSON.stringify(sm));
  const att = (await db.from('ii_nav_hydration_attempts').select('*').eq('instrument_id', id)).data;
  console.log('attempts', JSON.stringify(att));
}
// other candidates: scheme master rows whose instrument has fewer than 40 NAV rows
const { data } = await db.from('ii_scheme_master').select('instrument_id, amfi_scheme_code, scheme_name').ilike('scheme_name', '%Flexi Cap%Direct%Growth%').not('instrument_id', 'is', null).limit(40);
for (const r of data ?? []) {
  const c = (await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', r.instrument_id)).count;
  if (c < 60) console.log('short', r.instrument_id.slice(0, 8), r.amfi_scheme_code, r.scheme_name, c);
}
