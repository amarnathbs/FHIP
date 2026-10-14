// NAV2 release candidate, D5 (extra rows): an ISSUED report is unchanged after (a) a new daily NAV, (b) a correction of one of the user's transactions,
// (c) the risk-free series switched OFF and back ON. (NAV correction and risk-free value correction are journeys 3 and 3b; the metric-definition change and
// a later benchmark series are unit-tested, see the certification report.) DEV only. Every change is reverted in a finally block.
//
//   node scripts/nav2_rc/d5_immutability_extra.mjs        (app on port 3981, fixture users set up, user "other" holds funds A and D)
import crypto from 'node:crypto';
import { api, check, db, logoutAll, save, summary, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
import { generate, readReport, storedRow, uploadAndAccept } from '../nav2_stage3/_flow.mjs';

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const frozen = (row) => sha({ r: row.report_json, m: row.manifest_json, c: row.manifest_checksum, v: row.version_number, t: row.created_at });
const email = USERS.other;
const uid = await userIdOf(email);
const adminEmail = USERS.admin;
const adminId = await userIdOf(adminEmail);
const TB = 'RBI_91D_TBILL_CUTOFF_YIELD';
const undo = [];
console.log(`=== D5 extra immutability  ${new Date().toISOString()} ===`);
const prevAdmin = (await db.from('admin_users').select('*').eq('user_id', adminId).maybeSingle()).data;
try {
  const held = (await db.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count;
  if (!held) { const r = await uploadAndAccept(email, 'nav2s3-other'); check('the user holds funds A and D (statement accepted)', r.ok, JSON.stringify(r).slice(0, 120)); }
  const r0 = await generate(email);
  check('Report R0 is issued', r0.status === 201 && !!r0.id, `${r0.status} ${r0.body}`);
  const row0 = await storedRow(r0.id);
  const h0 = frozen(row0);
  const stillSame = async (label) => { const x = await storedRow(r0.id); check(`R0 is byte-identical after: ${label}`, frozen(x) === h0); };
  const fundA = row0.report_json.schemes[0].instrumentId;
  const lastDateOf = (row) => row.manifest_json.schemes.find((s) => s.instrumentId === fundA).navSeries.lastDate;

  // ---- (a) a new daily NAV (one synthetic row dated after the latest stored one) ------------------------------------------------------------------------
  const { data: latest } = await db.from('ii_prices_nav').select('*').eq('instrument_id', fundA).order('price_date', { ascending: false }).limit(1);
  const L = latest[0];
  const today = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${String(L.price_date).slice(0, 10)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (next <= today) {
    const rest = { ...L };
    delete rest.id;
    const synthetic = { ...rest, price_date: next, price: Math.round(Number(L.price) * 1.01 * 10000) / 10000, record_checksum: null, correction_of_id: null, superseded_by_id: null };
    const ins = await db.from('ii_prices_nav').insert(synthetic).select('id').single();
    if (ins.error) console.log('   (synthetic NAV insert refused:', ins.error.message.slice(0, 100), ')');
    else {
      undo.push(async () => db.from('ii_prices_nav').delete().eq('id', ins.data.id));
      const rn = await generate(email);
      const rowN = await storedRow(rn.id);
      check('a NEW report picks up the new daily NAV (its series now ends on the new date)', lastDateOf(rowN) === next && lastDateOf(row0) !== next, `${lastDateOf(row0)} -> ${lastDateOf(rowN)}`);
      await stillSame('a new daily NAV');
      await db.from('ii_prices_nav').delete().eq('id', ins.data.id);
      undo.pop();
    }
  } else console.log(`   (no day free after the latest NAV ${L.price_date}: the new-daily-NAV row is not run today)`);

  // ---- (b) a correction of one transaction ------------------------------------------------------------------------------------------------------------
  const { data: tx } = await db.from('ii_transactions').select('id, units, amount').eq('user_id', uid).eq('instrument_id', fundA).order('transaction_date').limit(1);
  if (tx?.length) {
    const t = tx[0];
    const newUnits = Math.round(Number(t.units) * 1.1 * 1000) / 1000;
    const u1 = await db.from('ii_transactions').update({ units: newUnits }).eq('id', t.id);
    undo.push(async () => db.from('ii_transactions').update({ units: t.units }).eq('id', t.id));
    check('the transaction correction was applied (units +10%)', !u1.error, u1.error?.message ?? '');
    const rt = await generate(email);
    const rowT = await storedRow(rt.id);
    const invA = (row) => JSON.stringify(row.report_json.schemes.find((s) => s.instrumentId === fundA).investor ?? null);
    check('a NEW report shows the corrected holding', invA(rowT) !== invA(row0), '');
    await stillSame('a transaction correction');
    await db.from('ii_transactions').update({ units: t.units }).eq('id', t.id);
    undo.pop();
  }

  // ---- (c) the risk-free series switched OFF and back ON (needs the series-switch capability: granted to the admin fixture user for the run) -----------------
  const grant = prevAdmin ? await db.from('admin_users').update({ can_switch_risk_free_series: true }).eq('user_id', adminId) : await db.from('admin_users').insert({ user_id: adminId, can_switch_risk_free_series: true });
  check('the series-switch capability was granted to the fixture administrator for this run', !grant.error, grant.error?.message ?? '');
  undo.push(async () => (prevAdmin ? db.from('admin_users').update({ can_switch_risk_free_series: prevAdmin.can_switch_risk_free_series ?? false, can_upload_risk_free_data: prevAdmin.can_upload_risk_free_data ?? false }).eq('user_id', adminId) : db.from('admin_users').delete().eq('user_id', adminId)));
  const off = await api(adminEmail, 'POST', '/api/admin/investment-intelligence/risk-free-data/series-state', { json: { seriesId: TB, enabled: false, termsStatus: 'po_accepted_2026-10-03', reason: 'NAV2 release candidate immutability check, switched back on at once' } });
  check('the series is switched OFF through the admin route', off.status === 200, `${off.status} ${off.text.slice(0, 120)}`);
  const rOff = await generate(email);
  const rowOff = await storedRow(rOff.id);
  const sharpeOff = rowOff.report_json.schemes[0].analytics.scheme.sharpe;
  check('while OFF a new report shows Sharpe as the typed "risk-free missing" state, never a number', sharpeOff.state === 'risk_free_missing' && !('value' in sharpeOff), JSON.stringify(sharpeOff).slice(0, 100));
  await stillSame('the series switched OFF');
  const on = await api(adminEmail, 'POST', '/api/admin/investment-intelligence/risk-free-data/series-state', { json: { seriesId: TB, enabled: true, termsStatus: 'po_accepted_2026-10-03', reason: 'NAV2 release candidate immutability check finished, series back on' } });
  check('the series is switched back ON', on.status === 200, `${on.status} ${on.text.slice(0, 120)}`);
  const rOn = await generate(email);
  const rowOn = await storedRow(rOn.id);
  check('after ON again a new report has Sharpe computed again', rowOn.report_json.schemes[0].analytics.scheme.sharpe.state === 'available' || rowOn.report_json.schemes[0].analytics.scheme.sharpe.state === 'insufficient_history', rowOn.report_json.schemes[0].analytics.scheme.sharpe.state);
  await stillSame('the series switched back ON');
  // ---- D2 rows: the SWITCH administrator cannot upload, and the UPLOAD administrator cannot switch ---------------------------------------------------------
  const previewBody = { action: 'preview', seriesId: TB, fileName: 'x.csv', csvText: 'observation_date,value_percent
2026-09-30,5.5199
', firstLoad: false };
  const upAsSwitch = await api(adminEmail, 'POST', '/api/admin/investment-intelligence/risk-free-data', { json: previewBody });
  check('D2: an administrator with ONLY the series-switch permission cannot upload (403)', upAsSwitch.status === 403, `${upAsSwitch.status} ${upAsSwitch.text.slice(0, 100)}`);
  await db.from('admin_users').update({ can_switch_risk_free_series: false, can_upload_risk_free_data: true }).eq('user_id', adminId);
  const swAsUpload = await api(adminEmail, 'POST', '/api/admin/investment-intelligence/risk-free-data/series-state', { json: { seriesId: TB, enabled: true, termsStatus: 'po_accepted_2026-10-03', reason: 'An upload only administrator must not be able to do this' } });
  check('D2: an administrator with ONLY the upload permission cannot switch a series (403)', swAsUpload.status === 403, `${swAsUpload.status} ${swAsUpload.text.slice(0, 100)}`);
  const upAsUpload = await api(adminEmail, 'POST', '/api/admin/investment-intelligence/risk-free-data', { json: previewBody });
  check('D2 (control): the same administrator CAN reach the upload preview (not 403: the refusal above is the permission, not a broken route)', upAsUpload.status !== 403 && upAsUpload.status !== 401, `${upAsUpload.status} ${upAsUpload.text.slice(0, 100)}`);
  const rd = await readReport(email, r0.id);
  check('R0 still reads through the API with its original checksum', rd.status === 200 && rd.checksum === row0.manifest_checksum);
} finally {
  for (const u of undo.reverse()) { try { await u(); } catch (e) { console.log('   undo failed', e.message); } }
  const s = (await db.from('ii_risk_free_series').select('enabled').eq('series_id', TB).single()).data;
  if (s && s.enabled !== true) console.log('   WARNING: the T-bill series is not enabled; re-enable it');
  check('the T-bill series is ENABLED at the end', s?.enabled === true);
  await logoutAll();
  const s2 = summary();
  save('d5_results.json', s2);
  console.log(`\n=== D5 extra: ${s2.pass} PASS, ${s2.fail} FAIL ===`);
  process.exitCode = s2.fail ? 1 : 0;
}
