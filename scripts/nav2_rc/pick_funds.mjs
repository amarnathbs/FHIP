// READ-ONLY: picks mutual funds on DEV with a long stored NAV history, an ISIN and an AMFI code, for the 1/4/10/20-fund timing statements.
// Writes test-artifacts/nav2_rc/picked_funds.json (instrument id, name, ISIN, AMFI, row count, first and last NAV date).
import fs from 'node:fs';
import path from 'node:path';
import { db, OUT } from '../nav2_stage3/_lib.mjs';

const want = Number(process.argv[2] ?? 24);
const { data: held } = await db.rpc('pc6_user_held_instrument_ids');
const heldIds = new Set((held ?? []).map((r) => r.instrument_id ?? r));
console.log('held instrument ids (any user):', heldIds.size);
const out = [];
// candidates: instruments that already have identifiers; iterate instruments with a scheme master, check NAV count
const { data: inst } = await db.from('ii_instruments').select('id, instrument_name, isin, instrument_class, base_currency, status').in('id', [...heldIds]).eq('instrument_class', 'mutual_fund').eq('base_currency', 'INR').not('isin', 'is', null);
console.log('held mutual funds with ISIN:', inst?.length);
for (const i of inst ?? []) {
  if (out.length >= want * 3) break;
  const { count } = await db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', i.id);
  if ((count ?? 0) < 700) continue;
  const { data: idf } = await db.from('ii_instrument_identifiers').select('identifier_scheme, identifier_value').eq('instrument_id', i.id).eq('identifier_scheme', 'amfi_scheme_code');
  const amfi = idf?.[0]?.identifier_value;
  if (!amfi) continue;
  const { data: first } = await db.from('ii_prices_nav').select('price_date').eq('instrument_id', i.id).order('price_date').limit(1);
  const { data: last } = await db.from('ii_prices_nav').select('price_date').eq('instrument_id', i.id).order('price_date', { ascending: false }).limit(1);
  out.push({ instrumentId: i.id, name: i.instrument_name, isin: i.isin, amfi, rows: count, first: first?.[0]?.price_date, last: last?.[0]?.price_date, held: heldIds.has(i.id) });
}
fs.mkdirSync(path.join(OUT, '..', 'nav2_rc'), { recursive: true });
fs.writeFileSync(path.join(OUT, '..', 'nav2_rc', 'picked_funds.json'), JSON.stringify(out, null, 1));
console.log('picked', out.length);
for (const o of out.slice(0, 30)) console.log(o.name.slice(0, 55).padEnd(56), o.isin, o.amfi, o.rows, o.first, o.last, o.held ? 'held' : '');
