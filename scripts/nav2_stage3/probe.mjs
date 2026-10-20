// Read-only probe of DEV state before the Stage 3 journeys.
import { db, dev, USERS, userIdOf } from './_lib.mjs';
console.log('DEV project ref:', dev.ref);
const flags = await db.from('ii_reference_job_control').select('job_key, enabled, disabled_reason').like('job_key', 'nav2_%');
console.log('nav2 flags:', JSON.stringify(flags.data));
const oth = await db.from('ii_reference_job_control').select('job_key, enabled').in('job_key', ['pc6_amfi_daily_nav', 'pc6_selective_historical_hydration', 'pc6_user_nav_history']);
console.log('other flags:', JSON.stringify(oth.data));
for (const [k, email] of Object.entries(USERS)) {
  const id = await userIdOf(email);
  const ent = await db.from('user_entitlements').select('plan_tier, effective_from, effective_to').eq('user_id', id).maybeSingle();
  const prof = await db.from('profiles').select('country_of_residence, country_confirmed_at').eq('user_id', id).maybeSingle();
  const prof2 = prof.error ? await db.from('profiles').select('*').eq('id', id).maybeSingle() : prof;
  const acc = await db.from('ii_accounts').select('id', { count: 'exact', head: true }).eq('user_id', id);
  const rep = await db.from('nav2_fund_analytics_reports').select('id', { count: 'exact', head: true }).eq('user_id', id);
  const adm = await db.from('admin_users').select('*').eq('user_id', id).maybeSingle();
  console.log(k, email, id.slice(0, 8), 'ent', JSON.stringify(ent.data), 'profile', JSON.stringify(prof2.data ? Object.fromEntries(Object.entries(prof2.data).filter(([a]) => /countr|id$/.test(a))) : prof2.error?.message), 'accounts', acc.count, 'reports', rep.count, 'admin', adm.data ? 'yes' : 'no');
}
const last = await db.from('ii_audit_events').select('created_at, event_type, user_id').order('created_at', { ascending: false }).limit(5);
console.log('latest audit events:', JSON.stringify(last.data?.map((r) => [r.created_at, r.event_type, String(r.user_id).slice(0, 8)])));
const nav = await db.from('ii_prices_nav').select('price_date').order('price_date', { ascending: false }).limit(1);
console.log('latest NAV date on DEV:', nav.data?.[0]?.price_date);
const sm = await db.from('ii_instruments').select('id', { count: 'exact', head: true });
console.log('ii_instruments rows:', sm.count);
