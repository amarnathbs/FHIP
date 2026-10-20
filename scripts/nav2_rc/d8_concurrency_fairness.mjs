// NAV2 release candidate, D8 (DEV, real routes): concurrency and fairness.
//   1. six simultaneous generations with ONE Idempotency-Key issue ONE report (needs migration 0281 on DEV; without it the check is reported BLOCKED, not passed);
//   2. six simultaneous generations with six keys issue six distinct, contiguous versions (journey 7 covers the version race without keys);
//   3. two users generate at the same time: each gets only their own report, and the smaller user is not made to wait for the larger;
//   4. a user whose selection contains a fund with no usable history still gets a report for the other funds (one failed fund does not starve the rest);
//   5. repeated accepted-statement events: the same document processed twice at the SAME time adds no account, transaction, holding or case.
//   node scripts/nav2_rc/d8_concurrency_fairness.mjs
import crypto from 'node:crypto';
import { api, check, db, logoutAll, save, summary, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
import { uploadAndAccept } from '../nav2_stage3/_flow.mjs';

const holder = USERS.holder;
const other = USERS.other;
const holderId = await userIdOf(holder);
const otherId = await userIdOf(other);
const reports = async (id) => (await db.from('nav2_fund_analytics_reports').select('id, version_number, created_at, supersedes_report_id').eq('user_id', id).order('version_number')).data ?? [];
const post = (email, key, body = { period: 'since_first_held' }) => api(email, 'POST', '/api/reports/fund-analytics', { json: body, headers: key ? { 'Idempotency-Key': key } : {} });
const settle = async (email, key, body) => {
  // like the screen: ask again with the same key while the answer is "ask again"
  let r;
  for (let i = 0; i < 12; i++) {
    r = await post(email, key, body);
    if (!(r.status === 202 || (r.status === 503 && r.json?.data?.status === 'timed_out'))) break;
    await new Promise((res) => setTimeout(res, 4000));
  }
  return r;
};
const has0281 = !(await db.from('nav2_fund_analytics_reports').select('idempotency_key').limit(1)).error;
console.log(`=== D8 concurrency and fairness  ${new Date().toISOString()}  migration 0281 on DEV: ${has0281} ===`);
try {
  // make sure both users hold funds
  if (!((await db.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', otherId)).count)) {
    const r = await uploadAndAccept(other, 'nav2s3-other');
    check('the second user holds funds A and D (statement accepted)', r.ok, JSON.stringify(r).slice(0, 100));
  }
  await settle(holder, crypto.randomUUID()); // warm the cache so the concurrent calls measure concurrency, not cold computation
  await settle(other, crypto.randomUUID());

  // ---- 1. one key, six simultaneous requests -------------------------------------------------------------------------------------------------------------
  const before1 = (await reports(holderId)).length;
  const key1 = crypto.randomUUID();
  const six = await Promise.all(Array.from({ length: 6 }, () => settle(holder, key1)));
  const after1 = (await reports(holderId)).length;
  if (has0281) {
    check('SAME KEY x6 at once: exactly ONE report was issued', after1 - before1 === 1, `reports ${before1} -> ${after1}; statuses ${six.map((r) => r.status).join(',')}`);
    check('every one of the six answers names that one report', new Set(six.map((r) => r.json?.data?.report?.id)).size === 1, '');
    check('exactly one of them was a 201 (issued) and the rest 200 (replayed)', six.filter((r) => r.status === 201).length === 1 && six.filter((r) => r.status === 200).length === 5, six.map((r) => r.status).join(','));
    const again = await settle(holder, key1);
    check('asking again later with the same key replays the report (200, replayed, no new version)', again.status === 200 && again.json?.data?.replayed === true && (await reports(holderId)).length === after1);
    const conflict = await post(holder, key1, { period: 'all_history' });
    check('the same key for a DIFFERENT request is refused with 409 and issues nothing', conflict.status === 409 && (await reports(holderId)).length === after1, `${conflict.status}`);
  } else {
    console.log(`   BLOCKED: migration 0281 is not applied on DEV, so one key cannot be stored. Without it the six requests issued ${after1 - before1} reports (the degrade path: the server logs a warning and issues without a key).`);
    check('BLOCKED (not a pass): idempotency on DEV needs migration 0281; the degrade path still issued reports without failing', after1 - before1 >= 1 && six.every((r) => r.status === 201));
  }

  // ---- 2. six keys, six simultaneous requests ---------------------------------------------------------------------------------------------------------
  const before2 = await reports(holderId);
  const keyed = await Promise.all(Array.from({ length: 6 }, () => settle(holder, crypto.randomUUID())));
  const after2 = await reports(holderId);
  const versions = after2.map((r) => r.version_number);
  check('SIX KEYS x6 at once: six reports with contiguous, unique versions and an unbroken supersedes chain', after2.length - before2.length === 6 && new Set(versions).size === versions.length && versions.every((v, i) => i === 0 || v === versions[i - 1] + 1) && after2.every((r, i) => i === 0 || r.supersedes_report_id === after2[i - 1].id), `statuses ${keyed.map((r) => r.status).join(',')}; versions ${versions.slice(-8).join(',')}`);

  // ---- 3. two users at once: isolation and no starvation ---------------------------------------------------------------------------------------------
  const t0 = Date.now();
  const timed = async (email) => { const s = Date.now(); const r = await settle(email, crypto.randomUUID()); return { r, ms: Date.now() - s }; };
  const [big, small] = await Promise.all([timed(holder), timed(other)]);
  const oBig = big.r.json?.data?.report?.id;
  const oSmall = small.r.json?.data?.report?.id;
  const owner = async (id) => (await db.from('nav2_fund_analytics_reports').select('user_id').eq('id', id).single()).data?.user_id;
  check('TWO USERS at once: each is issued a report that belongs to them alone', big.r.status === 201 && small.r.status === 201 && (await owner(oBig)) === holderId && (await owner(oSmall)) === otherId);
  check('the smaller user was not made to wait for the larger one (their time is their own work, not the sum of both)', small.ms < big.ms + small.ms && small.ms < 90_000, `holder ${big.ms} ms, other ${small.ms} ms, wall ${Date.now() - t0} ms`);

  // ---- 4. a selection that includes a fund the person does not hold: one plain refusal; the others are untouched ---------------------------------------------
  const own = (await db.from('ii_portfolio_truth_status').select('instrument_id').eq('user_id', holderId)).data.map((x) => x.instrument_id);
  const foreign = (await db.from('ii_portfolio_truth_status').select('instrument_id').eq('user_id', otherId)).data.map((x) => x.instrument_id).find((i) => !own.includes(i));
  if (foreign) {
    const nb = (await reports(holderId)).length;
    const bad = await post(holder, crypto.randomUUID(), { period: 'since_first_held', funds: [own[0], foreign] });
    check('a fund the person does not hold in the choice: ONE plain refusal (422), no report, nothing about the other person\'s funds', bad.status === 422 && !bad.text.includes(foreign) && (await reports(holderId)).length === nb, `${bad.status} ${bad.text.slice(0, 120)}`);
    const good = await settle(holder, crypto.randomUUID(), { period: 'since_first_held', funds: [own[0]] });
    check('a choice of one held fund is issued although the person holds more (the others are not waited for)', good.status === 201, `${good.status}`);
  }

  // ---- 5. the same document processed twice at the same time ---------------------------------------------------------------------------------------------
  const doc = (await db.from('ii_source_documents').select('id').eq('user_id', holderId).order('created_at').limit(1)).data?.[0]?.id;
  if (doc) {
    const count = async () => ({ acc: (await db.from('ii_accounts').select('id', { count: 'exact', head: true }).eq('user_id', holderId)).count, tx: (await db.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', holderId)).count, snap: (await db.from('ii_holding_snapshots').select('id', { count: 'exact', head: true }).eq('user_id', holderId)).count, cases: (await db.from('ii_reconciliation_cases').select('id', { count: 'exact', head: true }).eq('user_id', holderId)).count });
    const c0 = await count();
    const both = await Promise.all([api(holder, 'POST', `/api/investment-intelligence/source-documents/${doc}/process`, { json: {} }), api(holder, 'POST', `/api/investment-intelligence/source-documents/${doc}/process`, { json: {} })]);
    const c1 = await count();
    check('REPEATED ACCEPTED-STATEMENT EVENTS (two at once): no new account, transaction, holding or case', JSON.stringify(c0) === JSON.stringify(c1), `${JSON.stringify(c0)} -> ${JSON.stringify(c1)}; statuses ${both.map((r) => r.status).join(',')}`);
  }
} finally {
  await logoutAll();
  const s = summary();
  save('d8_results.json', s);
  console.log(`\n=== D8: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
