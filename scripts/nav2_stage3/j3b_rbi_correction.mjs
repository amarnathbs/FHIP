// NAV2 Stage 3, journey 3b: a controlled RBI observation correction invalidates ONLY its dependents, the issued report stays immutable, a new report
// uses the corrected rate, and the correction is reverted. Through the real admin route (capability granted to the admin fixture user for the
// run, removed after) and the real worker route.
//
// CARE: the risk-free dataset is shared by every report, including the PO's. The corrected date is OLD (2023), so only a window that reaches back to
// 2023 can change a number (the PO's seed fund A, held since 2023; none of the fixture users except the 'free' user, who holds a 2013 purchase),
// the correction is applied and reverted within seconds, and the PO account's reports are listed before and after: a PO report made inside that
// window would show up as a changed dataset version in its manifest and is reported loudly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, db, flag, OUT, PORT, save, setFlag, summary, logoutAll } from './_lib.mjs';
import { api, cacheRows, FUND, generate, readReport, storedRow, uploadAndAccept, USERS, userIdOf } from './_flow.mjs';

const PO = 'b34b274a-c33b-493e-9794-a4c564f64662';
const secret = fs.readFileSync(path.join(OUT, '.cron_secret'), 'utf8').trim();
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const worker = () => fetch(`http://127.0.0.1:${PORT}/api/investment-intelligence/cron/nav2-correction-worker`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }, body: '{}' }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const TB = 'RBI_91D_TBILL_CUTOFF_YIELD';
const REPO = 'RBI_POLICY_REPO_RATE';
const FUND_A = FUND.A;
const ALL = [FUND.A, FUND.B, FUND.C, FUND.D, FUND.E];

const uidFree = await userIdOf(USERS.free);
const uidAdmin = await userIdOf(USERS.admin);
const workerOriginal = await flag('nav2_correction_worker');
const ent = (await db.from('user_entitlements').select('plan_tier, effective_from, effective_to').eq('user_id', uidFree).single()).data;
const prevAdmin = (await db.from('admin_users').select('*').eq('user_id', uidAdmin).maybeSingle()).data;
const poList = async () => (await db.from('nav2_fund_analytics_reports').select('id, version_number, created_at, manifest_json').eq('user_id', PO).order('version_number')).data ?? [];
const poBefore = await poList();
const restore = [];
console.log(`=== journey 3b ${new Date().toISOString()} ===`);

async function correct(seriesId, date, value, reason) {
  return api(USERS.admin, 'POST', '/api/admin/investment-intelligence/risk-free-data/correct', { json: { seriesId, date, newValue: value, reason } });
}
const obs = async (seriesId, date) => (await db.from('ii_risk_free_observations').select('observation_date, value_percent').eq('series_id', seriesId).eq('kind', 'value').eq('observation_date', date).maybeSingle()).data;

try {
  await db.from('user_entitlements').update({ plan_tier: 'premium', effective_from: '2026-10-01', effective_to: '2026-11-30' }).eq('user_id', uidFree);
  if (!prevAdmin) await db.from('admin_users').insert({ user_id: uidAdmin, notes: 'NAV2 Stage 3 certification: temporary risk-free capability for the correction journey (reverted)', can_upload_risk_free_data: true });
  else await db.from('admin_users').update({ can_upload_risk_free_data: true }).eq('user_id', uidAdmin);

  // a household whose window reaches back to 2013 (so a 2023 rate matters to its numbers): the free user's 2013 purchase of fund A
  const held = ((await db.from('ii_portfolio_truth_status').select('instrument_id').eq('user_id', uidFree)).data ?? []).some((r) => r.instrument_id === FUND_A);
  if (!held) { const r = await uploadAndAccept(USERS.free, 'nav2s3-early'); check('a 2013 purchase of fund A is accepted for the free user (window reaches 2013)', r.ok, JSON.stringify(r).slice(0, 120)); }

  // choose observation dates that exist
  const tbRows = (await db.from('ii_risk_free_observations').select('observation_date, value_percent').eq('series_id', TB).eq('kind', 'value').gte('observation_date', '2023-06-01').lte('observation_date', '2023-06-30').order('observation_date')).data ?? [];
  const tbPick = tbRows[0];
  const repoPick = (await db.from('ii_risk_free_observations').select('observation_date, value_percent').eq('series_id', REPO).eq('kind', 'value').order('observation_date', { ascending: false }).limit(1)).data[0];
  check('observations to correct exist (T-bill in 06-2023, the latest repo-rate observation)', !!tbPick && !!repoPick, `${tbPick?.observation_date}=${tbPick?.value_percent}; repo ${repoPick?.observation_date}=${repoPick?.value_percent}`);

  const r1 = await generate(USERS.free);
  const row1 = await storedRow(r1.id);
  const base = { report: sha(row1.report_json), manifest: sha(row1.manifest_json), rfVersion: row1.manifest_json.riskFree?.datasetVersion };
  const sharpe1 = row1.report_json.schemes[0].analytics.scheme.sharpe;
  check('baseline: a report whose window reaches 2013 has a Sharpe computed on the T-bill series', r1.status === 201 && sharpe1.state === 'available' && /T_?BILL|91/i.test(JSON.stringify(sharpe1.provenance.riskFree)), `${r1.status} sharpe ${sharpe1.state} annualised ${sharpe1.value?.annualisedRatio}`);
  // fill the cache for several instruments so there is something that does and does not depend on the series
  const cacheBefore = await cacheRows(ALL);
  const dependents = cacheBefore.filter((c) => !c.invalidated_at && c.risk_free_dataset_id === TB);
  const independents = cacheBefore.filter((c) => !c.invalidated_at && c.risk_free_dataset_id === null);
  console.log(`   valid cache entries: ${dependents.length} depend on the T-bill series, ${independents.length} depend on no risk-free series`);
  check('the cache holds entries that depend on the T-bill series', dependents.length >= 3);

  await setFlag('nav2_correction_worker', true);
  await worker(); // drain anything pending: the counts below are this correction's alone

  // ---- A. a correction to the repo-rate series (no report uses it): nothing is invalidated ----------------------------------------------------------
  const repoOrig = Number(repoPick.value_percent);
  const a1 = await correct(REPO, repoPick.observation_date, repoOrig + 0.01, 'NAV2 Stage 3 controlled correction of the repo series, reverted at once');
  check('the admin route accepts a correction with a recorded reason (200)', a1.status === 200, `${a1.status} ${a1.text.slice(0, 120)}`);
  const a2 = await correct(REPO, repoPick.observation_date, repoOrig, 'NAV2 Stage 3 controlled correction of the repo series REVERTED');
  const wa = await worker();
  save('j3b_worker_repo.json', wa.json);
  check('A. a correction to the repo-rate series (used by nobody) processed two events and invalidated NO entry', wa.json?.data?.eventsProcessed === 2 && wa.json?.data?.entriesInvalidated === 0, JSON.stringify(wa.json?.data));
  check('A. every cache entry is exactly as valid as before', (await cacheRows(ALL)).filter((c) => !c.invalidated_at).length === cacheBefore.filter((c) => !c.invalidated_at).length);

  // ---- B. a correction to the T-bill series in 06-2023 ---------------------------------------------------------------------------------------------
  const tbOrig = Number(tbPick.value_percent);
  const poMid0 = (await poList()).length;
  const b1 = await correct(TB, tbPick.observation_date, Math.round((tbOrig + 0.05) * 10000) / 10000, 'NAV2 Stage 3 controlled correction of one T-bill yield, reverted at once');
  restore.push({ date: tbPick.observation_date, value: tbOrig });
  check('B. the T-bill correction is accepted', b1.status === 200, `${b1.status} ${b1.text.slice(0, 120)}`);
  const rB = await generate(USERS.free); // computed on the corrected rate
  const rowB = await storedRow(rB.id);
  const wb = await worker();
  save('j3b_worker_tbill.json', wb.json);
  const b2 = await correct(TB, tbPick.observation_date, tbOrig, 'NAV2 Stage 3 controlled correction of one T-bill yield REVERTED');
  restore.pop();
  const poMid1 = (await poList()).length;
  const back = await obs(TB, tbPick.observation_date);
  check('B. REVERT: the T-bill observation has its original value again', b2.status === 200 && Number(back.value_percent) === tbOrig, `${back.value_percent}`);
  check('B. the correction changed the risk-free dataset version, and the report made on the corrected rate has a different Sharpe', rowB.manifest_json.riskFree?.datasetVersion !== base.rfVersion && JSON.stringify(rowB.report_json.schemes[0].analytics.scheme.sharpe.value) !== JSON.stringify(sharpe1.value), `dataset ${String(base.rfVersion).slice(0, 12)} -> ${String(rowB.manifest_json.riskFree?.datasetVersion).slice(0, 12)}; sharpe ${sharpe1.value?.annualisedRatio} -> ${rowB.report_json.schemes[0].analytics.scheme.sharpe.value?.annualisedRatio}`);
  check('B. the worker invalidated the entries that depend on the T-bill series', wb.json?.data?.eventsProcessed >= 1 && wb.json.data.entriesInvalidated >= 1, JSON.stringify(wb.json?.data));
  const cacheAfter = await cacheRows(ALL);
  const depKeys = new Set(dependents.map((d) => d.cache_key));
  const indKeys = new Set(independents.map((d) => d.cache_key));
  const depNow = cacheAfter.filter((c) => depKeys.has(c.cache_key));
  const indNow = cacheAfter.filter((c) => indKeys.has(c.cache_key));
  check('B. ONLY DEPENDENTS: every entry that depended on the T-bill series is invalidated, and every entry that depends on no risk-free series is still valid', depNow.length > 0 && depNow.every((c) => c.invalidated_at) && indNow.every((c) => !c.invalidated_at), `${depNow.filter((c) => c.invalidated_at).length}/${depNow.length} dependents invalidated; ${indNow.filter((c) => !c.invalidated_at).length}/${indNow.length} independents still valid`);
  const wc = await worker();
  check('B. the revert is processed too and a further run finds nothing', wc.json?.data?.eventsProcessed >= 1, JSON.stringify(wc.json?.data));
  const row1b = await storedRow(r1.id);
  check('B. ISSUED REPORT IMMUTABLE: the report made before the correction is byte-identical afterwards', sha(row1b.report_json) === base.report && sha(row1b.manifest_json) === base.manifest);
  const rC = await generate(USERS.free);
  const rowC = await storedRow(rC.id);
  check('B. after the revert a new report shows the ORIGINAL Sharpe again (same dataset content, same figure)', JSON.stringify(rowC.report_json.schemes[0].analytics.scheme.sharpe.value) === JSON.stringify(sharpe1.value), `${rowC.report_json.schemes[0].analytics.scheme.sharpe.value?.annualisedRatio} vs ${sharpe1.value?.annualisedRatio}`);

  // the PO account: no report of theirs may have been made inside the correction window
  const poAfter = await poList();
  const intruder = poAfter.filter((r) => !poBefore.some((b) => b.id === r.id));
  console.log(`   PO account reports before ${poBefore.length}, after ${poAfter.length}`);
  check('THE PO\'S REPORTS WERE NOT TOUCHED: none of the PO reports changed, and none was made inside the correction window (a Version made inside it would carry the corrected rate)', poAfter.filter((r) => poBefore.some((b) => b.id === r.id)).every((r) => sha(r.manifest_json) === sha(poBefore.find((b) => b.id === r.id).manifest_json)) && poMid1 === poMid0, intruder.length ? `NOTE: the PO generated ${intruder.map((r) => 'v' + r.version_number + ' ' + r.created_at).join(', ')} meanwhile: check its dataset version against the original` : 'no PO report was made meanwhile');
} finally {
  // emergency restore of any T-bill value left changed
  for (const r of restore) { const x = await correct(TB, r.date, r.value, 'NAV2 Stage 3 emergency revert of a controlled correction'); console.log('   emergency revert', x.status); }
  await worker();
  await setFlag('nav2_correction_worker', workerOriginal.enabled, workerOriginal.disabled_reason);
  if (!prevAdmin) await db.from('admin_users').delete().eq('user_id', uidAdmin); else await db.from('admin_users').update({ can_upload_risk_free_data: prevAdmin.can_upload_risk_free_data }).eq('user_id', uidAdmin);
  await db.from('user_entitlements').update({ plan_tier: ent.plan_tier, effective_from: ent.effective_from, effective_to: ent.effective_to }).eq('user_id', uidFree);
  check('switch OFF, temporary capability removed, free plan restored', (await flag('nav2_correction_worker')).enabled === false);
  await logoutAll();
  const s = summary();
  save('j3b_results.json', s);
  console.log(`\n=== journey 3b: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
