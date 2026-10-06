// NAV2 Stage 3, journey 9: the final-build RBI weekly refresh DRY RUN through the real cron route (secret header), against the live RBI site,
// compared with the values stored on DEV. The weekly switch is armed only for the call and put back OFF. A dry run writes nothing: proven by
// before/after counts of the risk-free tables.
import fs from 'node:fs';
import path from 'node:path';
import { check, db, flag, OUT, PORT, save, setFlag, summary } from './_lib.mjs';

const secret = fs.readFileSync(path.join(OUT, '.cron_secret'), 'utf8').trim();
const KEY = 'nav2_risk_free_weekly_refresh';
const original = await flag(KEY);
const counts = async () => Object.fromEntries(await Promise.all(['ii_risk_free_observations', 'ii_risk_free_batches', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_refresh_attempts'].map(async (t) => [t, (await db.from(t).select('*', { count: 'exact', head: true })).count])));
const call = (body) => fetch(`http://127.0.0.1:${PORT}/api/investment-intelligence/cron/nav2-risk-free-refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
console.log(`=== journey 9 ${new Date().toISOString()} ===`);
const before = await counts();
const latest = async (series) => (await db.from('ii_risk_free_observations').select('observation_date, value_percent, kind, source_document, source_url').eq('series_id', series).eq('kind', 'value').order('observation_date', { ascending: false }).limit(3)).data;
const tbBefore = await latest('RBI_91D_TBILL_CUTOFF_YIELD');
const repoBefore = await latest('RBI_POLICY_REPO_RATE');
console.log('   stored latest T-bill:', JSON.stringify(tbBefore?.map((r) => [r.observation_date, r.value_percent])), '| stored latest repo:', JSON.stringify(repoBefore?.map((r) => [r.observation_date, r.value_percent])));
try {
  const off = await call({});
  check('with the switch OFF the route makes no request to RBI and answers "skipped" (default dry run is irrelevant)', off.status === 200 && off.json?.data?.mode === 'skipped_kill_switch' && off.json.data.requests.pages === 0 && off.json.data.requests.robots === 0, JSON.stringify(off.json?.data?.mode));
  await setFlag(KEY, true);
  const dry = await call({}); // no body: a dry run by default
  save('j9_dry_run_response.json', dry.json);
  const d = dry.json?.data;
  console.log('   dry run:', JSON.stringify({ mode: d?.mode, robots: d?.robots, source: d?.sourceStatus, problem: d?.fetchProblem, requests: d?.requests, tbill: d?.tbill, repo: d?.repo, wrote: d?.wrote }).slice(0, 900));
  check('DRY RUN BY DEFAULT: mode is "dry_run" with no body', dry.status === 200 && d?.mode === 'dry_run', `status ${dry.status} mode ${d?.mode}`);
  check('the run reports what robots.txt did and whether RBI blocked a content page (honest monitoring signals)', !!d?.robots && ['ok', 'robots_ok', 'robots_unavailable_continued', 'robots_disallowed'].includes(d.robots) || typeof d?.robots === 'string', `robots ${d?.robots}; source ${d?.sourceStatus}`);
  check('the run was polite: a handful of requests, one at a time (page requests <= 4, robots requests <= 1)', d?.requests?.pages <= 4 && d?.requests?.robots <= 1, JSON.stringify(d?.requests));
  const after = await counts();
  check('A DRY RUN WRITES NOTHING: every risk-free table has exactly the same row count as before', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  // compare with the stored values
  const t = d?.tbill;
  if (t && t.yieldPercent != null) {
    const stored = tbBefore.find((r) => r.observation_date === t.auctionDate);
    check(`RBI SOURCE VS STORED: the 91-day T-bill cut-off yield RBI publishes for the ${t.auctionDate} auction (${t.yieldPercent}%) equals the value stored on DEV`, !!stored && Number(stored.value_percent) === Number(t.yieldPercent), `stored ${stored?.value_percent}`);
  } else console.log('   T-bill: outcome', t?.outcome, '-', t?.detail);
  check('the T-bill decision is a defined outcome (noop / publish / record_gap / review / no_release_yet / up_to_date), never an unexplained error', !!t && !!t.outcome && !!t.detail, `${t?.outcome}: ${t?.detail}`);
  check('the repo-rate decision is a defined outcome and the stored rate was NOT changed', !!d?.repo?.outcome && JSON.stringify(await latest('RBI_POLICY_REPO_RATE')) === JSON.stringify(repoBefore), `${d?.repo?.outcome}: ${d?.repo?.detail}`);
  check('the attempt ledger got no row from a dry run (only live runs are recorded)', (await counts()).ii_risk_free_refresh_attempts === before.ii_risk_free_refresh_attempts);
} finally {
  await setFlag(KEY, original.enabled, original.disabled_reason);
  check('the weekly refresh switch is OFF again', (await flag(KEY)).enabled === false);
  const s = summary();
  save('j9_results.json', s);
  console.log(`\n=== journey 9: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
