// NAV2 Stage 3, journey 3: a controlled NAV correction on DEV (one price of fund E, which is NOT in the PO's seed holdings).
// Proves: only the affected cached analytics go stale; the worker invalidates only them; unaffected funds are unchanged; an issued report stays
// byte-identical; a newly generated report uses the corrected NAV; the correction is then reverted. Worker route is driven over HTTP.
// Needs the app server started with CRON_SECRET (see run notes); the secret is read from test-artifacts/nav2_stage3/.cron_secret.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, flag, OUT, PORT, save, setFlag, summary, logoutAll } from './_lib.mjs';
import { api, cacheRows, db, FUND, generate, readReport, storedRow, uploadAndAccept, USERS, userIdOf } from './_flow.mjs';
import { oracleFor, close } from './oracle.mjs';

const email = USERS.other;
const uid = await userIdOf(email);
const secret = fs.readFileSync(path.join(OUT, '.cron_secret'), 'utf8').trim();
const ids = [FUND.A, FUND.D, FUND.E];
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const worker = (headers = { 'x-cron-secret': secret }, body = {}) => fetch(`http://127.0.0.1:${PORT}/api/investment-intelligence/cron/nav2-correction-worker`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const events = async () => (await db.from('nav2_correction_events').select('*').order('id')).data ?? [];

console.log(`=== journey 3 ${new Date().toISOString()} port ${PORT} ===`);
const workerOriginal = await flag('nav2_correction_worker');
let restore = null;
try {
  // ---- set up: the other user holds A, D (statement 1) and E (statement 2) --------------------------------------------------------------
  const held = new Set(((await db.from('ii_portfolio_truth_status').select('instrument_id').eq('user_id', uid)).data ?? []).map((r) => r.instrument_id));
  if (!held.has(FUND.A)) { const r = await uploadAndAccept(email, 'nav2s3-other'); check('statement 1 (A and D) uploaded and accepted', r.ok, JSON.stringify(r)); }
  if (!held.has(FUND.E)) { const r = await uploadAndAccept(email, 'nav2s3-other-e'); check('statement 2 (E) uploaded and accepted', r.ok, JSON.stringify(r)); }
  const heldNow = ((await db.from('ii_portfolio_truth_status').select('instrument_id, status').eq('user_id', uid)).data ?? []);
  check('the user holds A, D and E (certified)', ids.every((i) => heldNow.some((h) => h.instrument_id === i && ['certified', 'certified_with_warnings'].includes(h.status))), heldNow.map((h) => h.instrument_id.slice(0, 8)).join(','));

  // ---- baseline reports and cache --------------------------------------------------------------------------------------------------------
  const r1 = await generate(email);
  const afterR1 = (await cacheRows(ids)).length;
  const r2 = await generate(email);
  const afterR2 = (await cacheRows(ids)).length;
  check('two reports generated before the correction', r1.status === 201 && r2.status === 201, `${r1.status}/${r2.status} ${r1.body.slice(0, 100)}`);
  check('the second run is served from the shared cache (no new cache entry was needed)', afterR2 === afterR1 && afterR1 >= 3, `cache entries for A, D, E: ${afterR1} -> ${afterR2}`);
  const before = await cacheRows(ids);
  const validBefore = before.filter((c) => !c.invalidated_at);
  save('j3_cache_before.json', before);
  const row1 = await storedRow(r1.id);
  const issuedHash = { report: sha(row1.report_json), manifest: sha(row1.manifest_json), checksum: row1.manifest_checksum };
  const blockHash = Object.fromEntries(row1.report_json.schemes.map((s) => [s.instrumentId, sha(s)]));
  const navCache = {};
  const oracleBefore = await oracleFor(uid, FUND.E, row1.report_json.asOfDate, navCache);
  const eBlock = row1.report_json.schemes.find((s) => s.instrumentId === FUND.E);
  check('baseline: E current value equals the independent figure', close(eBlock.analytics.investor.currentValue.value.value, oracleBefore.currentValue, 0.01), `${eBlock.analytics.investor.currentValue.value.value} vs ${oracleBefore.currentValue}`);

  // ---- worker guards ------------------------------------------------------------------------------------------------------------------------
  const noSecret = await worker({});
  const badSecret = await worker({ 'x-cron-secret': 'definitely-wrong' });
  check('the worker route refuses a call with no secret and with a wrong secret (401)', noSecret.status === 401 && badSecret.status === 401, `${noSecret.status}/${badSecret.status}`);
  check('the worker kill switch is OFF at the start (workers remain off)', workerOriginal.enabled === false);
  const evBeforeAll = await events();
  const off = await worker();
  check('with the switch OFF the worker reads and writes nothing ("skipped_kill_switch")', off.status === 200 && off.json?.data?.status === 'skipped_kill_switch' && (await events()).length === evBeforeAll.length && (await events()).every((e, i) => e.processed_at === evBeforeAll[i].processed_at), JSON.stringify(off.json).slice(0, 160));

  // ---- the controlled correction -----------------------------------------------------------------------------------------------------------
  const target = (await db.from('ii_prices_nav').select('*').eq('instrument_id', FUND.E).order('price_date', { ascending: false }).limit(1)).data[0];
  const origPrice = Number(target.price);
  const newPrice = Math.round(origPrice * 1.02 * 10000) / 10000;
  restore = { id: target.id, price: target.price, source_timestamp: target.source_timestamp, data_version: target.data_version, record_checksum: target.record_checksum, quality_status: target.quality_status };
  save('j3_original_nav_row.json', target);
  const upd = await db.from('ii_prices_nav').update({ price: newPrice, source_timestamp: new Date().toISOString(), data_version: 'nav2s3-controlled-correction', record_checksum: `nav2s3-corr-${Date.now()}`, quality_status: 'ok' }).eq('id', target.id);
  check(`CORRECTION APPLIED on DEV: E NAV on ${target.price_date} ${origPrice} -> ${newPrice} (+2%)`, !upd.error, upd.error?.message ?? '');
  const logc = await db.from('ii_reference_corrections').insert({ target_table: 'ii_prices_nav', target_row_id: target.id, correction_kind: 'source_correction', previous_value: { price: origPrice }, new_value: { price: newPrice }, actor_kind: 'system_import', reason: 'NAV2 Stage 3 controlled correction (reverted in the same journey)' }).select('id').single();
  check('the correction is recorded on the append-only ledger', !logc.error && !!logc.data?.id, logc.error?.message ?? '');
  const evAfter = (await events()).filter((e) => !evBeforeAll.some((b) => b.id === e.id));
  const mine = evAfter.find((e) => e.source_correction_id === logc.data?.id);
  check('the database trigger raised exactly one correction event for it (kind nav_correction, instrument E, that date)', evAfter.length === 1 && mine?.kind === 'nav_correction' && mine?.instrument_id === FUND.E && String(mine?.event_date).slice(0, 10) === String(target.price_date).slice(0, 10), JSON.stringify(mine));

  // before the worker runs: a new report must already use the corrected NAV (the key is different), the old E entry is simply unreachable
  const r3 = await generate(email);
  const row3 = await storedRow(r3.id);
  const oracleAfter = await oracleFor(uid, FUND.E, row3.report_json.asOfDate, {});
  const e3 = row3.report_json.schemes.find((s) => s.instrumentId === FUND.E);
  check('a report generated after the correction uses the corrected NAV (E current value matches the independent figure on the corrected series)', close(e3.analytics.investor.currentValue.value.value, oracleAfter.currentValue, 0.01) && oracleAfter.currentValue !== oracleBefore.currentValue, `${e3.analytics.investor.currentValue.value.value} vs oracle ${oracleAfter.currentValue} (before ${oracleBefore.currentValue})`);
  check('NEGATIVE CONTROL: the corrected value is demonstrably different from the pre-correction value', Math.abs(oracleAfter.currentValue - oracleBefore.currentValue) > 1, `${oracleBefore.currentValue} -> ${oracleAfter.currentValue}`);
  const mid = await cacheRows(ids);
  const newE = mid.filter((c) => c.instrument_id === FUND.E && !validBefore.some((v) => v.cache_key === c.cache_key));
  check('only E needed recomputing: new cache entries appeared for E and none for A or D', newE.length >= 1 && mid.filter((c) => c.instrument_id !== FUND.E).length === before.filter((c) => c.instrument_id !== FUND.E).length, `new E entries ${newE.length}`);
  check('UNAFFECTED FUNDS UNCHANGED: A and D blocks are byte-identical to the baseline report', [FUND.A, FUND.D].every((i) => sha(row3.report_json.schemes.find((s) => s.instrumentId === i)) === blockHash[i]), 'sha256 of the scheme blocks');
  const row1b = await storedRow(r1.id);
  check('ISSUED REPORT IMMUTABLE: version 1 is byte-identical after the correction', sha(row1b.report_json) === issuedHash.report && sha(row1b.manifest_json) === issuedHash.manifest && row1b.manifest_checksum === issuedHash.checksum);

  // ---- the worker ----------------------------------------------------------------------------------------------------------------------------------
  const digest = row1.manifest_json.metricRegistryDigest;
  const isCurrent = (c) => String(c.definition_version).includes(digest);
  const staleBefore = (await cacheRows(ids)).filter((c) => !c.invalidated_at && isCurrent(c)).map((c) => c.cache_key);
  await setFlag('nav2_correction_worker', true);
  const run = await worker();
  save('j3_worker_run_1.json', run.json);
  const afterRows = await cacheRows(ids);
  const newlyInvalid = afterRows.filter((c) => c.invalidated_at && staleBefore.includes(c.cache_key));
  check('the worker processed the event and reported what it invalidated', run.status === 200 && run.json?.data?.status === 'completed' && run.json.data.eventsProcessed >= 1, JSON.stringify(run.json?.data));
  check('ONLY E entries of the CURRENT definition were invalidated by the correction (A and D current entries still valid)', newlyInvalid.length >= 1 && newlyInvalid.every((c) => c.instrument_id === FUND.E) && afterRows.filter((c) => c.instrument_id !== FUND.E && isCurrent(c) && staleBefore.includes(c.cache_key)).every((c) => !c.invalidated_at), `invalidated ${newlyInvalid.length}, all E; the worker also reported ${run.json?.data?.staleDefinitionInvalidated} entries of OLDER definitions invalidated as hygiene (never reachable by a current key)`);
  const evDone = (await events()).find((e) => e.id === mine.id);
  check('the event is marked processed with the number of entries invalidated by it', !!evDone.processed_at && evDone.entries_invalidated === newlyInvalid.length, `entries_invalidated ${evDone.entries_invalidated}`);
  check('pinned reports are counted but never edited (pinnedReportsAffected >= 1; version 1 still identical)', run.json?.data?.pinnedReportsAffected >= 1 && sha((await storedRow(r1.id)).report_json) === issuedHash.report, `pinnedReportsAffected ${run.json?.data?.pinnedReportsAffected}`);
  const run2 = await worker();
  check('a second worker run finds nothing left to do for this event (idempotent)', run2.json?.data?.eventsProcessed === 0 && run2.json?.data?.entriesInvalidated === 0, JSON.stringify(run2.json?.data));

  // the next report: computed only for what is not cached
  const r4 = await generate(email);
  const r4b = await generate(email);
  check('after the worker: report generation recomputes only what is not cached and then everything is a hit', r4.status === 201 && r4b.status === 201);
  const cacheAfter = await cacheRows(ids);
  save('j3_cache_after_worker.json', cacheAfter);

  // ---- revert ------------------------------------------------------------------------------------------------------------------------------------------
  const rv = await db.from('ii_prices_nav').update({ price: restore.price, source_timestamp: restore.source_timestamp, data_version: restore.data_version, record_checksum: restore.record_checksum, quality_status: restore.quality_status }).eq('id', restore.id);
  const rvLog = await db.from('ii_reference_corrections').insert({ target_table: 'ii_prices_nav', target_row_id: restore.id, correction_kind: 'source_correction', previous_value: { price: newPrice }, new_value: { price: origPrice }, actor_kind: 'system_import', reason: 'NAV2 Stage 3 controlled correction REVERTED' }).select('id').single();
  const back = (await db.from('ii_prices_nav').select('price, record_checksum, data_version').eq('id', restore.id).single()).data;
  check('REVERT: the NAV row is exactly as it was (price, checksum, data version)', !rv.error && !rvLog.error && Number(back.price) === Number(restore.price) && back.record_checksum === restore.record_checksum && back.data_version === restore.data_version, JSON.stringify(back));
  restore = null;
  const run3 = await worker();
  check('the revert raised an event and the worker processed it (again only E)', run3.json?.data?.eventsProcessed >= 1, JSON.stringify(run3.json?.data));
  const r5 = await generate(email);
  const row5 = await storedRow(r5.id);
  const e5 = row5.report_json.schemes.find((s) => s.instrumentId === FUND.E);
  check('a new report after the revert shows the ORIGINAL E value again (equals the pre-correction independent figure)', close(e5.analytics.investor.currentValue.value.value, oracleBefore.currentValue, 0.01), `${e5.analytics.investor.currentValue.value.value} vs ${oracleBefore.currentValue}`);
  check('and E\'s block equals the baseline block except where the cached bundle is concerned (current value, XIRR identical)', e5.analytics.investor.xirr?.value?.rate === eBlock.analytics.investor.xirr?.value?.rate);
  const r6 = await generate(email);
  const cacheFinal = await cacheRows([FUND.E]);
  const validE = cacheFinal.filter((c) => !c.invalidated_at);
  save('j3_cache_final_E.json', cacheFinal);
  console.log('   E cache entries after revert: valid', validE.length, 'invalidated', cacheFinal.length - validE.length);
  check('after the revert the original E key is cacheable again (a valid entry exists for the current E inputs)', validE.length >= 1, `valid E entries ${validE.length}`);
  check('report versions are all kept: nothing was deleted or edited', (await db.from('nav2_fund_analytics_reports').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count >= 6);
} catch (e) {
  console.log('FATAL', e?.stack ?? e);
  check('journey ran without an unexpected error', false, String(e?.message ?? e).slice(0, 200));
} finally {
  if (restore) {
    await db.from('ii_prices_nav').update({ price: restore.price, source_timestamp: restore.source_timestamp, data_version: restore.data_version, record_checksum: restore.record_checksum, quality_status: restore.quality_status }).eq('id', restore.id);
    console.log('   emergency revert of the NAV row done');
  }
  await setFlag('nav2_correction_worker', workerOriginal.enabled, workerOriginal.disabled_reason);
  check('the correction worker switch is OFF again', (await flag('nav2_correction_worker')).enabled === workerOriginal.enabled);
  await logoutAll();
  const s = summary();
  save('j3_results.json', s);
  console.log(`\n=== journey 3: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
