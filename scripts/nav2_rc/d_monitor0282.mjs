// DEV proof for migration 0282: the monitoring page's "statement lines held back for review" count reads the new function. Needs the app on port 3981,
// the fixture administrator (setup.mjs apply), and ideally a held-back line (journey 5b opens one).
//   node scripts/nav2_rc/d_monitor0282.mjs
import { api, check, db, logoutAll, save, summary, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';

const adminId = await userIdOf(USERS.admin);
const prev = (await db.from('admin_users').select('*').eq('user_id', adminId).maybeSingle()).data;
// the monitoring page needs the reference-data permission: granted to the fixture administrator for this run, reverted in the finally block
if (!prev) await db.from('admin_users').insert({ user_id: adminId, notes: 'NAV2 release candidate: temporary capability for the 0282 monitoring check (reverted)', can_view_reference_data_quality: true });
else await db.from('admin_users').update({ can_view_reference_data_quality: true }).eq('user_id', adminId);
try {
  const r = await api(USERS.admin, 'GET', '/api/admin/investment-intelligence/nav2-monitoring');
  check('the monitoring route answers 200 for the administrator', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
  const c = r.json?.data?.identifierConflicts ?? r.json?.identifierConflicts;
  console.log('identifierConflicts:', JSON.stringify(c)?.slice(0, 400));
  check('the held-back count is AVAILABLE now (0282 applied), not the "not available until the migration" state', !!c && c.state !== 'unavailable', JSON.stringify(c)?.slice(0, 160));
  const direct = await db.rpc('nav2_ambiguity_case_summary');
  console.log('service role call of the function:', direct.error ? `${direct.error.code} ${direct.error.message.slice(0, 80)}` : 'allowed');
  const anon = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/rest/v1/rpc/nav2_ambiguity_case_summary`, { method: 'POST', headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  if (anon) check('an anonymous caller cannot call the function', anon.status === 401 || anon.status === 403 || anon.status === 404, `http ${anon.status}`);
} finally {
  if (!prev) await db.from('admin_users').delete().eq('user_id', adminId);
  else await db.from('admin_users').update({ can_view_reference_data_quality: prev.can_view_reference_data_quality }).eq('user_id', adminId);
  await logoutAll();
  const s = summary();
  save('d_monitor0282_results.json', s);
  console.log(`=== 0282 monitoring: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
