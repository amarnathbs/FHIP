// NAV2 release candidate: READ-ONLY DEV inventory over the REST API (service role). No write, no DDL. Never prints a secret.
// What REST can and cannot show: tables, columns (via select), rows and RPC existence are visible; pg_policies, grants,
// triggers and function bodies are NOT exposed. Those need docs/nav2/po_apply_dev_release_candidate/ (catalog query run by the PO).
import { loadDevEnv } from '../canonical_cert/lib/env.mjs';
const dev = loadDevEnv();
const H = { apikey: dev.serviceKey, Authorization: `Bearer ${dev.serviceKey}` };
async function get(p) {
  const r = await fetch(`${dev.url}/rest/v1/${p}`, { headers: { ...H, Prefer: 'count=exact' } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t, count: r.headers.get('content-range') };
}
async function rpc(fn, args = {}) {
  const r = await fetch(`${dev.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t };
}

console.log('DEV project ref:', dev.ref, '| now (UTC):', new Date().toISOString());
const tables = ['ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_corrections', 'ii_risk_free_review_items', 'ii_risk_free_series_state_log', 'ii_risk_free_refresh_attempts', 'nav2_fund_analytics_reports', 'nav2_result_cache', 'nav2_report_nav_dependencies', 'nav2_correction_events', 'nav2_report_render_tokens'];
for (const t of tables) {
  const r = await get(`${t}?select=*&limit=0`);
  console.log(t.padEnd(36), r.status === 200 ? `exists (content-range ${r.count})` : `MISSING/ERR ${r.status} ${String(r.json?.code ?? '')}`);
}
const au = await get('admin_users?select=risk_free_data_upload,risk_free_series_switch&limit=1');
console.log('admin_users risk-free columns (0260 part a):', au.status === 200 ? 'present' : `MISSING ${au.status} ${au.json?.code ?? ''} ${au.json?.message ?? ''}`);
const all = await get('ii_reference_job_control?select=job_key,enabled,disabled_reason,updated_at&order=job_key');
console.log('job control rows:');
for (const r of all.json ?? []) console.log('  ', String(r.job_key).padEnd(40), 'enabled =', r.enabled, '|', String(r.disabled_reason ?? '').slice(0, 70).replace(/\s+/g, ' '), '| updated', r.updated_at);
const series = await get('ii_risk_free_series?select=*&order=series_id');
console.log('risk-free series:', series.status, JSON.stringify(series.json).slice(0, 900));
const obs = await get('ii_risk_free_observations?select=series_id&limit=0');
console.log('risk-free observations (content-range):', obs.count);
for (const [fn, args] of [['is_risk_free_data_admin', {}], ['is_risk_free_series_switch_admin', {}], ['nav2_viewer_has_premium', {}], ['nav2_monitoring_snapshot', {}], ['nav2_refresh_attempt_summary', {}], ['nav2_monitor_cell', { p_value: 1, p_user_derived: false }], ['pc6_nav_row_is_candidate', { p_instrument_id: '00000000-0000-0000-0000-000000000000', p_price_date: '2020-01-01', p_changeover_date: '2020-01-02' }], ['commit_risk_free_upload', {}], ['correct_risk_free_observation', {}], ['record_risk_free_refresh_results', {}], ['resolve_risk_free_review_item', {}], ['set_risk_free_series_state', {}]]) {
  const r = await rpc(fn, args);
  console.log('rpc', fn.padEnd(36), r.json?.code === 'PGRST202' ? 'NOT FOUND' : `exists (http ${r.status}${r.json?.code ? ' ' + r.json.code : ''})`);
}
for (const t of ['nav2_correction_events', 'nav2_fund_analytics_reports', 'nav2_result_cache', 'nav2_report_nav_dependencies', 'nav2_report_render_tokens', 'ii_risk_free_refresh_attempts']) {
  const r = await get(`${t}?select=*&limit=0`);
  console.log(t.padEnd(36), 'rows (content-range):', r.count);
}
