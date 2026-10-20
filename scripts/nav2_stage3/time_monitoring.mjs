// Times the monitoring snapshot as an administrator (reference-data quality capability granted for the run, removed after) and prints the storage cells.
import { db, USERS, userIdOf, api, logoutAll, save } from './_lib.mjs';
const id = await userIdOf(USERS.admin);
const prev = (await db.from('admin_users').select('*').eq('user_id', id).maybeSingle()).data;
try {
  if (!prev) await db.from('admin_users').insert({ user_id: id, notes: 'NAV2 Stage 3 temporary capability for timing (reverted)', can_view_reference_data_quality: true });
  else await db.from('admin_users').update({ can_view_reference_data_quality: true }).eq('user_id', id);
  await api(USERS.admin, 'GET', '/api/admin/investment-intelligence/nav2-monitoring'); // warm the route compile
  const times = [];
  let last;
  for (let i = 0; i < 4; i++) { const t = Date.now(); last = await api(USERS.admin, 'GET', '/api/admin/investment-intelligence/nav2-monitoring'); times.push([last.status, Date.now() - t]); }
  console.log('status/ms per call (route incl. auth and two database functions):', JSON.stringify(times));
  const snap = last.json?.data?.snapshot;
  save('monitoring_after_0271.json', last.json?.data);
  console.log('storage cells:', JSON.stringify(snap?.storage, null, 1));
  console.log('held_instruments:', JSON.stringify(snap?.held_instruments), '| refreshAttempts:', JSON.stringify(last.json?.data?.refreshAttempts).slice(0, 200));
} finally {
  if (!prev) await db.from('admin_users').delete().eq('user_id', id); else await db.from('admin_users').update({ can_view_reference_data_quality: prev.can_view_reference_data_quality }).eq('user_id', id);
  await logoutAll();
}
