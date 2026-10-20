// Read-only: how do the journey-1 statement's identifiers resolve on DEV, and what NAV does each instrument have?
import { db } from './_lib.mjs';
const isins = ['INF879O01027', 'INF200K01180'];
const amfi = ['122639', '103504'];
const ids = (await db.from('ii_instrument_identifiers').select('*').in('identifier_value', [...isins, ...amfi])).data ?? [];
console.log('identifier rows:', JSON.stringify(ids.map((r) => [r.identifier_type, r.identifier_value, r.instrument_id?.slice(0, 8), r.is_active ?? r.status])));
const instIds = [...new Set(ids.map((r) => r.instrument_id))];
for (const id of instIds) {
  const inst = (await db.from('ii_instruments').select('id, instrument_name, instrument_class, base_currency, plan_type, option_type, created_at').eq('id', id).single()).data;
  const first = (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date').limit(1)).data?.[0]?.price_date;
  const last = (await db.from('ii_prices_nav').select('price_date').eq('instrument_id', id).order('price_date', { ascending: false }).limit(1)).data?.[0]?.price_date;
  const cnt = (await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', id)).count;
  console.log(id, inst?.instrument_name, '|', inst?.plan_type, inst?.option_type, '| nav', first, '->', last, 'rows', cnt);
}
const sm = (await db.from('ii_scheme_master').select('*').in('amfi_scheme_code', amfi)).data ?? [];
console.log('scheme master:', JSON.stringify(sm.map((r) => [r.amfi_scheme_code, r.scheme_name, r.isin_growth ?? r.isin, r.instrument_id?.slice(0, 8)])));
