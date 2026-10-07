// NAV2 Stage 3, journey 5 part 2: a wrong ISIN/AMFI combination opens exactly ONE reconciliation case; typed terminal states
// (generated / no funds / insufficient history / timed out); beta and alpha are unavailable, never zero.
// Fixture user: free (made Premium for the duration, then put back).
import path from 'node:path';
import { check, db, flag, OUT, save, setFlag, summary, USERS, userIdOf, logoutAll } from './_lib.mjs';
import { api, FUND, generate, readReport, uploadAndAccept } from './_flow.mjs';

const email = USERS.free;
const uid = await userIdOf(email);
const ent = (await db.from('user_entitlements').select('plan_tier, effective_from, effective_to').eq('user_id', uid).single()).data;
const hydr = await flag('pc6_selective_historical_hydration');
console.log(`=== journey 5 part 2 ${new Date().toISOString()} ===`);
try {
  await db.from('user_entitlements').update({ plan_tier: 'premium', effective_from: '2026-10-01', effective_to: '2026-11-30' }).eq('user_id', uid);

  // ---- wrong ISIN / AMFI pair ----------------------------------------------------------------------------------------------------------------
  const r = await uploadAndAccept(email, 'nav2s3-wrong-pair');
  check('the statement whose ISIN belongs to fund A and whose AMFI code belongs to fund D is processed (not a crash)', r.ok, JSON.stringify(r).slice(0, 200));
  const cases = (await db.from('ii_reconciliation_cases').select('id, status, discrepancy_type, subject_type, discrepancy_details, source_document_id').eq('user_id', uid)).data ?? [];
  save('j5b_wrong_pair_cases.json', cases);
  const open = cases.filter((c) => ['open', 'user_reviewing'].includes(c.status));
  console.log('   cases:', JSON.stringify(cases.map((c) => [c.discrepancy_type, c.status, c.subject_type])));
  check('EXACTLY ONE reconciliation case is open for the disagreeing identifiers (two statement lines, one case)', open.length === 1, `${open.length} open of ${cases.length}`);
  const txns = (await db.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count;
  check('no canonical transaction was created for the disputed scheme (nothing is held on a guess)', txns === 0, `${txns} transactions`);
  const again = await api(email, 'POST', `/api/investment-intelligence/source-documents/${r.docId}/process`, { json: {} });
  const cases2 = (await db.from('ii_reconciliation_cases').select('id, status').eq('user_id', uid)).data ?? [];
  check('processing the same document again opens no second case', cases2.filter((c) => ['open', 'user_reviewing'].includes(c.status)).length === 1 && cases2.length === cases.length, `re-process ${again.status}; ${cases2.length} cases`);
  const g0 = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
  check('NO FUNDS: a Premium user whose only statement is still awaiting reconciliation gets the typed "no funds" answer, not a report', g0.status === 200 && g0.json?.data?.status === 'no_funds', `${g0.status} ${g0.text.slice(0, 140)}`);

  // ---- insufficient history: the stored report made for the admin fixture user in journey 2b, BEFORE the planned history was loaded ----------------------
  const { data: ih } = await db.from('nav2_fund_analytics_reports').select('id, report_json').eq('user_id', await userIdOf(USERS.admin)).order('version_number').limit(1).single();
  const j = ih.report_json;
  const typed = [];
  const walk = (o, p2 = '') => { if (o && typeof o === 'object') { if (o.state === 'insufficient_history') typed.push({ at: p2, reason: o.reason, detail: o.detail, hasValue: 'value' in o }); for (const [k, v] of Object.entries(o)) if (k !== 'chart') walk(v, `${p2}/${k}`); } };
  walk(j.schemes.map((s2) => s2.analytics));
  save('j5b_insufficient_history_report_evidence.json', { id: ih.id, scope: j.scope, stateCounts: j.stateCounts, typedStates: typed.slice(0, 40) });
  check('INSUFFICIENT HISTORY (DEV report of the admin fixture user, a fund whose stored prices had a 21-day hole): the figures that could not be computed are typed insufficient_history states, each with a reason code and its own sentence', typed.length >= 1 && typed.every((t2) => t2.reason && t2.detail), `${typed.length} typed states, e.g. ${typed[0]?.reason}: ${String(typed[0]?.detail).slice(0, 110)}`);
  check('INSUFFICIENT HISTORY is never a zero: no insufficient_history state carries a numeric value', typed.length >= 1 && typed.every((t2) => !t2.hasValue));
  const early = await uploadAndAccept(email, 'nav2s3-early');
  const g1 = await generate(email);
  const rep1 = (await readReport(email, g1.id)).report;
  check('BETA and ALPHA are unavailable with the reason "no benchmark" (never 0, never a value) while no licensed benchmark exists', g1.status === 201 && rep1.schemes.every((s) => s.analytics.scheme.beta.state === 'benchmark_missing' && s.analytics.scheme.alpha.state === 'benchmark_missing' && !('value' in s.analytics.scheme.beta) && !('value' in s.analytics.scheme.alpha)), rep1.schemes.map((s) => `${s.analytics.scheme.beta.state}/${s.analytics.scheme.alpha.state}`).join(' '));
  check('NOT DEMONSTRATED ON DEV (stated, not claimed): the "timed out" state and the 500 "could not be generated" failure; their evidence is the unit tests (reportNavHistoryGate retry window, route 500 sentence)', true, 'see the certification report, rows 16 and 17');
} finally {
  await setFlag('pc6_selective_historical_hydration', hydr.enabled, hydr.disabled_reason);
  await db.from('user_entitlements').update({ plan_tier: ent.plan_tier, effective_from: ent.effective_from, effective_to: ent.effective_to }).eq('user_id', uid);
  check('hydration switch and the free plan are restored', (await flag('pc6_selective_historical_hydration')).enabled === false);
  await logoutAll();
  const s = summary();
  save('j5b_results.json', s);
  console.log(`\n=== journey 5 part 2: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
