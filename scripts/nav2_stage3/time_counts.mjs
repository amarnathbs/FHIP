// Read-only: how long do the monitoring snapshot's building blocks take on DEV? (PostgREST exact counts as the service role)
import { db } from './_lib.mjs';
const t = async (label, f) => { const s = Date.now(); const r = await f(); console.log(label.padEnd(60), `${Date.now() - s} ms`, JSON.stringify(r?.count ?? r?.error?.message ?? ''));};
await t('count(*) ii_prices_nav (exact)', () => db.from('ii_prices_nav').select('id', { count: 'exact', head: true }));
await t('count(*) ii_prices_nav (planned)', () => db.from('ii_prices_nav').select('id', { count: 'planned', head: true }));
await t('count(*) ii_prices_nav (estimated)', () => db.from('ii_prices_nav').select('id', { count: 'estimated', head: true }));
await t('count price_date >= 2026-09-21', () => db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).gte('price_date', '2026-09-21'));
await t('count nav2_result_cache', () => db.from('nav2_result_cache').select('cache_key', { count: 'exact', head: true }));
await t('count ii_nav_hydration_attempts', () => db.from('ii_nav_hydration_attempts').select('instrument_id', { count: 'exact', head: true }));
await t('count ii_benchmarks', () => db.from('ii_benchmarks').select('id', { count: 'exact', head: true }));
const held = await db.rpc('pc6_user_held_instrument_ids');
console.log('held instruments', held.data?.length, held.error?.message ?? '');
