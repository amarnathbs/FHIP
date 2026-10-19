// NAV2 Stage 3, journey 7: concurrency. (a) several simultaneous report generations for one user; (b) several simultaneous correction-worker runs
// (and retries) over one pending correction event. "One logical result": unique, contiguous versions; identical content; each event
// processed exactly once; no duplicate cache entry; nothing lost.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { check, flag, OUT, PORT, save, setFlag, summary, logoutAll } from './_lib.mjs';
import { api, cacheRows, db, FUND, USERS, userIdOf } from './_flow.mjs';

const email = USERS.other;
const uid = await userIdOf(email);
const secret = fs.readFileSync(path.join(OUT, '.cron_secret'), 'utf8').trim();
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const worker = () => fetch(`http://127.0.0.1:${PORT}/api/investment-intelligence/cron/nav2-correction-worker`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }, body: '{}' }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
console.log(`=== journey 7 ${new Date().toISOString()} ===`);

// ---- (a) concurrent generation ----------------------------------------------------------------------------------------------------
const N = 6;
const before = (await db.from('nav2_fund_analytics_reports').select('id, version_number').eq('user_id', uid).order('version_number')).data ?? [];
const t0 = Date.now();
// release candidate: each request behaves like the screen: its own Idempotency-Key, and it asks again (same key) while the answer is 202 or the typed 503 timed_out
const settle = async () => {
  const key = crypto.randomUUID();
  let r;
  for (let i = 0; i < 12; i++) {
    r = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' }, headers: { 'Idempotency-Key': key } });
    if (!(r.status === 202 || (r.status === 503 && r.json?.data?.status === 'timed_out'))) break;
    await new Promise((res) => setTimeout(res, 4000));
  }
  return r;
};
const results = await Promise.all(Array.from({ length: N }, () => settle()));
console.log(`   ${N} concurrent generations finished in ${Math.round((Date.now() - t0) / 1000)} s: statuses ${results.map((r) => r.status).join(',')}`);
const after = (await db.from('nav2_fund_analytics_reports').select('id, version_number, supersedes_report_id, report_json, manifest_json, manifest_checksum').eq('user_id', uid).order('version_number')).data ?? [];
const fresh = after.filter((r) => !before.some((b) => b.id === r.id));
// a 200 is the REPLAY of a report already issued for the same Idempotency-Key (a retry after a typed 202 or 503 whose first attempt finished in the background): it is a success and issues nothing
const okCount = results.filter((r) => r.status === 201 || r.status === 200).length;
save('j7_generation_statuses.json', results.map((r) => ({ status: r.status, body: r.text.slice(0, 160) })));
check('every concurrent request ended in a typed answer (201 ready, or 200 for the replay of the same key) or an honest typed refusal; none was a bare server error', results.every((r) => [200, 201, 202, 409, 429].includes(r.status)), results.map((r) => r.status).join(','));
check(`${okCount} reports were stored for ${okCount} successful answers (one per Idempotency-Key, however many times each was retried): nothing lost, nothing double-counted`, fresh.length === okCount, `${fresh.length} new rows`);
const versions = after.map((r) => r.version_number);
check('version numbers are unique and contiguous (no gap, no duplicate)', new Set(versions).size === versions.length && versions.every((v, i) => v === i + 1), versions.join(','));
check('each version supersedes exactly the one before it (an unbroken chain)', after.every((r, i) => (i === 0 ? r.supersedes_report_id === null : r.supersedes_report_id === after[i - 1].id)));
const stripTime = (m) => ({ ...m, calculatedAt: null });
check('ONE LOGICAL RESULT: all the concurrent reports have identical content, and identical manifests except for the calculation timestamp (which each run records)', new Set(fresh.map((r) => sha(r.report_json))).size === 1 && new Set(fresh.map((r) => sha(stripTime(r.manifest_json)))).size === 1, `${new Set(fresh.map((r) => sha(r.report_json))).size} distinct report contents; ${new Set(fresh.map((r) => sha(stripTime(r.manifest_json)))).size} distinct manifests ignoring the timestamp; ${new Set(fresh.map((r) => r.manifest_checksum)).size} distinct checksums (the checksum covers the timestamp)`);
const cache = await cacheRows([FUND.A, FUND.D, FUND.E]);
const keys = cache.map((c) => c.cache_key);
check('the shared cache holds exactly one entry per key (no duplicate under concurrency)', new Set(keys).size === keys.length);
const failing = results.filter((r) => r.status >= 500);
if (failing.length) console.log('   server errors:', failing.map((r) => r.text.slice(0, 120)).join(' | '));
check('NEGATIVE CONTROL: a deliberately duplicated version number is rejected by the database (so the checks above can fail)', !!(await db.from('nav2_fund_analytics_reports').insert({ user_id: uid, version_number: 1, as_of_date: '2026-10-05', reporting_currency: 'INR', scheme_count: 0, policy_version: 'x', engine_version: 'x', report_json: {}, manifest_json: {}, manifest_checksum: 'x', state_counts: {} })).error);

// ---- (b) concurrent correction workers ------------------------------------------------------------------------------------------------------
const workerOriginal = await flag('nav2_correction_worker');
const target = (await db.from('ii_prices_nav').select('*').eq('instrument_id', FUND.E).order('price_date', { ascending: false }).limit(1)).data[0];
const restore = { price: target.price, source_timestamp: target.source_timestamp, data_version: target.data_version, record_checksum: target.record_checksum, quality_status: target.quality_status };
try {
  await setFlag('nav2_correction_worker', true);
  await worker(); // drain anything pending so the count below is this correction's alone
  const evBefore = (await db.from('nav2_correction_events').select('id').order('id')).data?.length ?? 0;
  const newPrice = Math.round(Number(target.price) * 1.01 * 10000) / 10000;
  await db.from('ii_prices_nav').update({ price: newPrice, source_timestamp: new Date().toISOString(), data_version: 'nav2s3-concurrency', record_checksum: `nav2s3-conc-${Date.now()}`, quality_status: 'ok' }).eq('id', target.id);
  const logc = await db.from('ii_reference_corrections').insert({ target_table: 'ii_prices_nav', target_row_id: target.id, correction_kind: 'source_correction', previous_value: { price: Number(target.price) }, new_value: { price: newPrice }, actor_kind: 'system_import', reason: 'NAV2 Stage 3 concurrency journey (reverted)' }).select('id').single();
  const ev = (await db.from('nav2_correction_events').select('*').eq('source_correction_id', logc.data.id)).data ?? [];
  check('one correction raised exactly one event', ev.length === 1, `${ev.length}`);
  // make sure there is something to invalidate: generate once under the corrected NAV (fills the cache for E under the corrected key)
  const validKeysBefore = new Set((await cacheRows([FUND.A, FUND.D, FUND.E])).filter((c) => !c.invalidated_at).map((c) => c.cache_key));
  await settle();
  const runs = await Promise.all(Array.from({ length: 5 }, () => worker()));
  save('j7_worker_runs.json', runs.map((r) => r.json));
  const evDone = (await db.from('nav2_correction_events').select('*').eq('id', ev[0].id).single()).data;
  check('FIVE SIMULTANEOUS worker runs: every one answered "completed" (no 5xx)', runs.every((r) => r.status === 200 && r.json?.data?.status === 'completed'), runs.map((r) => r.status).join(','));
  check('the event is processed exactly once in the database (processed_at set, entries_invalidated fixed)', !!evDone.processed_at && Number.isInteger(evDone.entries_invalidated), JSON.stringify({ processed_at: evDone.processed_at, entries_invalidated: evDone.entries_invalidated }));
  const totalInvalidatedReported = runs.reduce((s, r) => s + (r.json?.data?.entriesInvalidated ?? 0), 0);
  check('the invalidations the runs reported add up to what the database says (no run counted work another run did)', totalInvalidatedReported === evDone.entries_invalidated, `reported ${totalInvalidatedReported}, recorded ${evDone.entries_invalidated}; events processed per run ${runs.map((r) => r.json?.data?.eventsProcessed).join(',')}`);
  const retry = await worker();
  check('RETRY: a later run finds nothing to do and changes nothing', retry.json?.data?.eventsProcessed === 0 && retry.json?.data?.entriesInvalidated === 0, JSON.stringify(retry.json?.data));
  const rows = await cacheRows([FUND.A, FUND.D, FUND.E]);
  const digest = (await db.from('nav2_fund_analytics_reports').select('manifest_json').eq('user_id', uid).order('version_number', { ascending: false }).limit(1).single()).data.manifest_json.metricRegistryDigest;
  check('only E entries were touched; A and D entries of the current definition are still valid', rows.filter((c) => c.instrument_id !== FUND.E && String(c.definition_version).includes(digest) && validKeysBefore.has(c.cache_key)).every((c) => !c.invalidated_at));
} finally {
  await db.from('ii_prices_nav').update(restore).eq('id', target.id);
  await db.from('ii_reference_corrections').insert({ target_table: 'ii_prices_nav', target_row_id: target.id, correction_kind: 'source_correction', previous_value: { price: 'corrected' }, new_value: { price: Number(restore.price) }, actor_kind: 'system_import', reason: 'NAV2 Stage 3 concurrency journey REVERTED' });
  const back = (await db.from('ii_prices_nav').select('price, record_checksum').eq('id', target.id).single()).data;
  check('REVERT: the NAV row is exactly as before', Number(back.price) === Number(restore.price) && back.record_checksum === restore.record_checksum);
  await worker();
  await setFlag('nav2_correction_worker', workerOriginal.enabled, workerOriginal.disabled_reason);
  check('correction worker switch OFF again', (await flag('nav2_correction_worker')).enabled === workerOriginal.enabled);
  await logoutAll();
  const s = summary();
  save('j7_results.json', s);
  console.log(`\n=== journey 7: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
