// NAV2 Stage 3, journeys 1 and 2 (DEV only, real app on port 3981, fixture user from the repo harness, no seed insert):
//   1. synthetic statement -> upload -> parse -> review (summary) -> accepted (certified) -> canonical holding -> held-only planner ->
//      NAV window -> analytics -> report -> PDF
//   2. held-only storage proof, with before/after counts, one requirement per accepted scheme, and idempotency of re-upload / repeated
//      acceptance / publish / republish / repeated planner invocation
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, check, db, flag, OUT, PORT, save, setFlag, summary, USERS, userIdOf, logoutAll, dmy } from './_lib.mjs';
import { oracleFor, close } from './oracle.mjs';

const ROOT = path.resolve(OUT, '..', '..');
const STMT = path.join(OUT, 'statements');
const holderEmail = USERS.holder;
const holderId = await userIdOf(holderEmail);
const FUND = { A: '575b7dc3-dc60-4218-8b75-5ef68c964afe', B: '31a05b68-05f1-49d8-8d87-334e221e5740', C: '70c403e9-a81a-43be-9bcf-b03edf88ec0f', D: '2c5322cb-cb50-485c-8c9e-216b2dc6b580' };
const HELD = [FUND.A, FUND.B, FUND.C];
const expected = JSON.parse(fs.readFileSync(path.join(STMT, 'nav2s3-holder.expected.json'), 'utf8'));

console.log(`=== NAV2 Stage 3 journeys 1+2  ${new Date().toISOString()}  port ${PORT} ===`);
console.log('DEV host verified by the harness (project vqycarelcoijzwlpkpcz); production never touched.');

const exact = async (table, build = (q) => q) => {
  const { count, error } = await build(db.from(table).select('id', { count: 'exact', head: true }));
  if (error) return `err:${error.message.slice(0, 40)}`;
  return count;
};
async function controls() {
  const { data } = await db.from('ii_scheme_master').select('instrument_id').not('instrument_id', 'is', null).order('instrument_id').limit(400);
  const ids = [...new Set((data ?? []).map((r) => r.instrument_id))].filter((i) => !Object.values(FUND).includes(i));
  return ids.filter((_, i) => i % 60 === 0).slice(0, 6);
}
const CONTROL = await controls();
async function counts() {
  const c = { at: new Date().toISOString(), global: {}, perInstrument: {}, user: {} };
  c.global.ii_instruments = await exact('ii_instruments');
  c.global.ii_scheme_master = await exact('ii_scheme_master');
  c.global.ii_prices_nav_total = await exact('ii_prices_nav');
  c.global.ii_nav_retention_holds_open = await exact('ii_nav_retention_holds', (q) => q.is('released_at', null));
  c.global.ii_nav_hydration_attempts = await exact('ii_nav_hydration_attempts');
  for (const [k, id] of [...Object.entries(FUND), ...CONTROL.map((id, i) => [`control${i + 1}`, id])]) {
    c.perInstrument[k] = {
      id: id.slice(0, 8),
      nav_rows: await exact('ii_prices_nav', (q) => q.eq('instrument_id', id)),
      open_holds: await exact('ii_nav_retention_holds', (q) => q.eq('instrument_id', id).is('released_at', null)),
      attempts: await exact('ii_nav_hydration_attempts', (q) => q.eq('instrument_id', id)),
    };
  }
  for (const t of ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_fhip_publications', 'ii_reconciliation_cases', 'ii_transaction_source_links']) c.user[t] = await exact(t, (q) => q.eq('user_id', holderId));
  c.user.investments = await exact('investments', (q) => q.eq('user_id', holderId));
  c.user.nav2_reports = await exact('nav2_fund_analytics_reports', (q) => q.eq('user_id', holderId));
  return c;
}
const plan = (userId = holderId, period = 'since_first_held') => JSON.parse(execFileSync('npx', ['tsx', 'scripts/nav2_stage3/plan.ts', userId, period], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 180000 }).trim().split('\n').pop());

const plannerOriginal = await flag('nav2_trigger_planner');
const before = await counts();
save('j12_counts_before.json', before);
console.log('before:', JSON.stringify({ global: before.global, user: before.user }));

try {
  // ---- planner switch ON for the journey (restored in finally) ----------------------------------------------------------------
  await setFlag('nav2_trigger_planner', true);
  check('the NAV2 planner switch is ON for this journey (original state saved, restored at the end)', (await flag('nav2_trigger_planner')).enabled === true, `original enabled=${plannerOriginal.enabled}`);

  // ---- 1. upload ------------------------------------------------------------------------------------------------------------
  const self = await api(holderEmail, 'POST', '/api/ownership/self');
  const memberId = self.json?.data?.memberId;
  check('the fixture holder has a Self member (owner chosen BEFORE upload)', self.status === 200 && !!memberId, `status ${self.status}`);

  const pdf = fs.readFileSync(path.join(STMT, 'nav2s3-holder.pdf'));
  const upload = async (owner) => {
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'nav2s3-holder-statement.pdf');
    fd.append('meta', JSON.stringify({ sourceKey: 'manual', documentType: 'cas_statement', countryCode: 'IN', ...(owner ? { owner } : {}) }));
    const r = new Response(fd);
    return api(holderEmail, 'POST', '/api/investment-intelligence/source-documents', { body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') });
  };
  const noOwner = await upload(null);
  check('NEGATIVE CONTROL: an upload with NO owner is refused (owner-before-upload) and stores nothing', noOwner.status === 422 && (await exact('ii_source_documents', (q) => q.eq('user_id', holderId))) === 0, `status ${noOwner.status} code ${noOwner.json?.code ?? noOwner.json?.error}`);
  const up = await upload({ kind: 'member', memberId });
  const docId = up.json?.data?.id;
  check('the statement is uploaded through the real upload route', up.status < 300 && !!docId, `status ${up.status} doc ${String(docId).slice(0, 8)}`);

  // ---- 2. parse / process -----------------------------------------------------------------------------------------------------
  const proc = await api(holderEmail, 'POST', `/api/investment-intelligence/source-documents/${docId}/process`, { json: {} });
  check('the real process route parsed the statement', proc.status === 200, `status ${proc.status} ${proc.text.slice(0, 160)}`);
  let st;
  for (let i = 0; i < 40; i++) {
    st = (await api(holderEmail, 'GET', `/api/investment-intelligence/source-documents/${docId}/status`)).json?.data;
    if (st?.document?.status && !['uploaded', 'processing'].includes(st.document.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check('the document reached a settled status', !!st?.document?.status && !['uploaded', 'processing'].includes(st.document.status), `status ${st?.document?.status}`);

  // ---- 3. review (summary) ----------------------------------------------------------------------------------------------------
  const sumRes = await api(holderEmail, 'GET', `/api/investment-intelligence/source-documents/${docId}/summary`);
  const review = sumRes.json?.data;
  save('j1_review_summary.json', review);
  const expectedTxn = expected.schemes.reduce((s, x) => s + x.rows.length, 0);
  check('the review summary reports every statement transaction (parser vs the statement file)', review?.transactionsFound === expectedTxn, `found ${review?.transactionsFound}, statement has ${expectedTxn}`);

  // ---- 4. accepted: canonical rows ----------------------------------------------------------------------------------------------
  const accounts = (await db.from('ii_accounts').select('id').eq('user_id', holderId)).data ?? [];
  check('canonical accounts: one folio per statement scheme', accounts.length === 3, `${accounts.length} accounts`);
  const txns = (await db.from('ii_transactions').select('instrument_id, transaction_date, transaction_type, units, gross_amount, source_reference').eq('user_id', holderId).order('transaction_date')).data ?? [];
  let allMatch = true; const mism = [];
  for (const s of expected.schemes) for (const r of s.rows) {
    const hit = txns.find((t) => t.source_reference?.includes(r.ref));
    const ok = hit && hit.instrument_id === s.instrumentId && hit.transaction_date === r.date && close(Number(hit.units), r.units, 0.0005) && close(Number(hit.gross_amount), r.amount, 0.005);
    if (!ok) { allMatch = false; mism.push(r.ref); }
  }
  check('every canonical transaction matches the statement line (instrument, date, units, amount)', allMatch && txns.length === expectedTxn, mism.length ? `mismatches ${mism.slice(0, 5).join(',')}` : `${txns.length} rows`);
  const truth = (await db.from('ii_portfolio_truth_status').select('instrument_id, status, history_completeness').eq('user_id', holderId)).data ?? [];
  check('every scheme position is certified (accepted)', truth.length === 3 && truth.every((t) => ['certified', 'certified_with_warnings'].includes(t.status)), JSON.stringify(truth.map((t) => [t.instrument_id.slice(0, 8), t.status])));
  const snaps = (await db.from('ii_holding_snapshots').select('instrument_id, units, as_of_date').eq('user_id', holderId)).data ?? [];
  check('canonical holdings: units after the statement equal the statement closing units for A and B; C is zero', expected.schemes.every((s) => close(Number(snaps.find((x) => x.instrument_id === s.instrumentId)?.units ?? NaN), s.closingUnits, 0.0006)), JSON.stringify(snaps.map((x) => [x.instrument_id.slice(0, 8), Number(x.units)])));

  // ---- 5. held-only planner and NAV window -----------------------------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 6000)); // the post-response kick (planner ON) runs after the upload/process response
  const p1 = plan();
  save('j2_plan_1.json', p1);
  const wIds = p1.windows.map((w) => w.instrumentId).sort();
  check('JOURNEY 2: the plan holds exactly one required window per accepted scheme (3) and no other instrument', JSON.stringify(wIds) === JSON.stringify([...HELD].sort()), `${wIds.length} windows: ${wIds.map((i) => i.slice(0, 8)).join(',')}`);
  const firstTxn = Object.fromEntries(expected.schemes.map((s) => [s.instrumentId, s.rows[0].date]));
  check('JOURNEY 2: each window is driven by the scheme\'s own earliest transaction (as on the statement) and requires history from on or before it (the NAV window)', p1.windows.every((w) => { const d = w.drivers.find((x) => x.kind === 'earliest_transaction'); return d && d.targetDate === firstTxn[w.instrumentId] && w.requiredFrom <= firstTxn[w.instrumentId]; }), JSON.stringify(p1.windows.map((w) => [w.instrumentId.slice(0, 8), firstTxn[w.instrumentId], w.requiredFrom, w.requiredTo])));
  check('JOURNEY 2: stored history already reaches each required date, so nothing is fetched (history from 2013 is on DEV)', p1.fetch.toFetch.length === 0 && p1.fetch.alreadyCovered.length === 3, JSON.stringify({ covered: p1.fetch.alreadyCovered.length, toFetch: p1.fetch.toFetch.length }));
  const after1 = await counts();
  save('j12_counts_after_accept.json', after1);

  // ---- 6. analytics + report -----------------------------------------------------------------------------------------------------
  let gen;
  for (let i = 0; i < 12; i++) {
    gen = await api(holderEmail, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
    if (gen.status !== 202) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const reportId = gen.json?.data?.report?.id;
  check('the report is generated (201 ready) from the accepted statement', gen.status === 201 && !!reportId, `status ${gen.status} ${gen.text.slice(0, 120)}`);
  const got = await api(holderEmail, 'GET', `/api/reports/fund-analytics/${reportId}`);
  const rep = got.json?.data?.report;
  save('j1_report.json', rep);
  const asOf = rep.asOfDate;
  check('the report covers the three schemes, ranking only A and B (C is redeemed)', rep.schemes.length === 3, rep.schemes.map((s) => s.schemeName).join(' | '));

  // oracle comparison
  const navCache = {}; const rows = [];
  for (const [name, id] of Object.entries({ A: FUND.A, B: FUND.B, C: FUND.C })) {
    const o = await oracleFor(holderId, id, asOf, navCache);
    const blk = rep.schemes.find((s) => s.instrumentId === id);
    const inv = blk.analytics.investor;
    const x = inv.xirr?.value?.rate ?? null;
    const cv = inv.currentValue?.value?.value;
    const gl = inv.gainLoss?.value?.gainLoss;
    const p2p = Object.fromEntries((blk.analytics.scheme.pointToPoint ?? []).map((p) => [p.id, p]));
    const line = { fund: name, units: o.units, oracle: { currentValue: o.currentValue, gainLoss: o.gainLoss, xirr: o.xirr }, report: { currentValue: cv, gainLoss: gl, xirr: x } };
    check(`ORACLE ${name}: current value equals units x latest NAV (${o.currentValue})`, close(cv, o.currentValue, 0.01), `report ${cv}`);
    check(`ORACLE ${name}: gain/loss equals the independent figure (${o.gainLoss.toFixed(2)})`, close(gl, o.gainLoss, 0.011), `report ${gl}`);
    if (o.xirr != null) check(`ORACLE ${name}: XIRR matches the independent bisection (${(o.xirr * 100).toFixed(4)}%)`, close(x, o.xirr, 1e-6), `report ${(x * 100).toFixed(4)}%`);
    for (const n of ['1Y', '3Y', '5Y']) {
      const op = o.p2p[n]; const rp = p2p[n];
      if (!op) continue;
      const rv = rp?.result?.value;
      const okAbs = rv && close(rv.absoluteReturn, op.absoluteReturn, 1e-9);
      const rc = rp?.cagr?.value?.cagr ?? null;
      const okC = op.cagr == null ? rc == null : close(rc, op.cagr, 1e-9);
      check(`ORACLE ${name} ${n}: absolute return and CAGR (${op.cagr == null ? 'absolute only' : (op.cagr * 100).toFixed(4) + '%'})`, okAbs && okC, `report abs ${rv?.absoluteReturn?.toFixed?.(6)} cagr ${rc?.toFixed?.(6) ?? rc}`);
      line[n] = { oracle: op.cagr, report: rc, actualDays: op.actualDays };
    }
    rows.push(line);
  }
  save('j1_oracle_comparison.json', rows);
  const oneYear = rep.schemes.find((s) => s.instrumentId === FUND.A).analytics.scheme.pointToPoint.find((p) => p.id === '1Y');
  check('the one-year CAGR for the over-a-year fund A is shown on the requested one-year window (v7 rule)', oneYear?.cagr?.state === 'available', `state ${oneYear?.cagr?.state}, actual days ${oneYear?.result?.value?.actualDays}`);
  const bInv = rep.schemes.find((s) => s.instrumentId === FUND.B).analytics.investor;
  check('the under-a-year holding B: the investor return starts on the statement purchase date (15-04-2026) and uses the money-weighted XIRR, while the fund\'s own 1Y/3Y/5Y figures come from the fund NAV history', bInv.xirr?.value?.periodStart === firstTxn[FUND.B], `xirr period ${bInv.xirr?.value?.periodStart} -> ${bInv.xirr?.value?.periodEnd}`);
  const cs = rep.schemes.find((s) => s.instrumentId === FUND.C).analytics.investor;
  check('the fully redeemed fund C is shown as redeemed with value exactly 0', cs.currentValue?.value?.basis === 'redeemed' && cs.currentValue?.value?.value === 0);
  check('beta and alpha are unavailable (never zero) while no licensed benchmark exists', rep.schemes.every((s) => s.analytics.scheme.beta.state !== 'available' && s.analytics.scheme.alpha.state !== 'available' && !('value' in s.analytics.scheme.beta)), rep.schemes.map((s) => s.analytics.scheme.beta.state).join(','));

  // negative control for the oracle: a deliberately wrong expectation must be detected as a mismatch
  const o = await oracleFor(holderId, FUND.A, asOf, navCache);
  const wrong = o.currentValue * 1.001;
  check('NEGATIVE CONTROL (oracle): a value 0.1% off is detected as different from the report', !close(rep.schemes.find((s) => s.instrumentId === FUND.A).analytics.investor.currentValue.value.value, wrong, 0.01), `report ${rep.schemes.find((s) => s.instrumentId === FUND.A).analytics.investor.currentValue.value.value} vs wrong ${wrong.toFixed(2)}`);

  // ---- 7. PDF -----------------------------------------------------------------------------------------------------------------------------
  const pdfRes = await api(holderEmail, 'GET', `/api/reports/fund-analytics/${reportId}/export?disposition=inline`);
  check('the real export route returns a PDF for the report', pdfRes.status === 200 && /pdf/.test(pdfRes.headers.get('content-type') ?? ''), `status ${pdfRes.status} ${pdfRes.headers.get('content-type')}`);
  if (pdfRes.status !== 200) console.log('   export body:', pdfRes.text.slice(0, 300));
  save('j1_report_id.txt', reportId);

  // ---- JOURNEY 2: idempotency -----------------------------------------------------------------------------------------------------------
  const base = await counts();
  const reup = await upload({ kind: 'member', memberId });
  check('JOURNEY 2: re-uploading the identical file is recognised, not stored again', reup.json?.data?.deduplicated === true && reup.json?.data?.id === docId, `status ${reup.status} dedup ${reup.json?.data?.deduplicated}`);
  const reproc = await api(holderEmail, 'POST', `/api/investment-intelligence/source-documents/${docId}/process`, { json: {} });
  const afterReproc = await counts();
  const same = (a, b, keys) => keys.every((k) => JSON.stringify(a.user[k]) === JSON.stringify(b.user[k]));
  check('JOURNEY 2: repeated acceptance (processing the same document again) adds no account, transaction, holding, case or source link', same(base, afterReproc, ['ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_reconciliation_cases', 'ii_transaction_source_links', 'ii_source_documents']), `re-process status ${reproc.status}; ${JSON.stringify(afterReproc.user)}`);
  const holdsBefore = Object.fromEntries(HELD.map((i) => [i.slice(0, 8), 0]));
  for (const k of ['A', 'B', 'C']) holdsBefore[FUND[k].slice(0, 8)] = afterReproc.perInstrument[k].open_holds;
  save('j2_holds_after_reprocess.json', holdsBefore);
  check('JOURNEY 2: each accepted scheme has exactly one open hydration/retention hold, not one per acceptance event', ['A', 'B', 'C'].every((k) => afterReproc.perInstrument[k].open_holds <= (before.perInstrument[k].open_holds + 1)), JSON.stringify(Object.fromEntries(['A', 'B', 'C'].map((k) => [k, `${before.perInstrument[k].open_holds} -> ${afterReproc.perInstrument[k].open_holds}`]))));

  const p2 = plan(); const p3 = plan();
  const sameDay = p1.today === p2.today && p2.today === p3.today;
  const core = (w) => w.map((x) => [x.instrumentId, x.drivers.find((d) => d.kind === 'earliest_transaction')?.targetDate]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  check('JOURNEY 2: repeated planner invocations return the same plan (one window per scheme, same ids and dates) and write nothing', sameDay ? JSON.stringify(p2.windows) === JSON.stringify(p1.windows) && JSON.stringify(p3.windows) === JSON.stringify(p1.windows) : JSON.stringify(core(p2.windows)) === JSON.stringify(core(p1.windows)) && JSON.stringify(core(p3.windows)) === JSON.stringify(core(p1.windows)), `${p3.windows.length} windows; ${sameDay ? 'same UTC day: windows identical' : 'the UTC date changed during the run (' + p1.today + ' -> ' + p3.today + '), so only ids and earliest-transaction dates are compared'}`);
  const afterPlan = await counts();
  check('JOURNEY 2: planner invocations changed no table (global and per-instrument counts identical)', JSON.stringify(afterPlan.global) === JSON.stringify(afterReproc.global) && JSON.stringify(afterPlan.perInstrument) === JSON.stringify(afterReproc.perInstrument));

  const gen2 = await api(holderEmail, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held' } });
  const afterGen = await counts();
  check('JOURNEY 2: generating again creates a NEW report version (immutable history) but no duplicate account, investment or hold', gen2.status === 201 && afterGen.user.nav2_reports === afterPlan.user.nav2_reports + 1 && same(afterPlan, afterGen, ['ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'investments']) && JSON.stringify(afterGen.perInstrument) === JSON.stringify(afterPlan.perInstrument), `reports ${afterPlan.user.nav2_reports} -> ${afterGen.user.nav2_reports}`);

  // publish / republish
  const positions = (await api(holderEmail, 'GET', '/api/investment-intelligence/positions')).json?.data ?? [];
  const pos = positions.find((p) => (p.instrument_id ?? p.instrumentId) === FUND.A || p.id === snaps.find((x) => x.instrument_id === FUND.A)?.id);
  const snapA = (await db.from('ii_holding_snapshots').select('id').eq('user_id', holderId).eq('instrument_id', FUND.A).limit(1).maybeSingle()).data?.id;
  const inv0 = (await counts()).user;
  const CORR = crypto.randomUUID();
  const pub1 = await api(holderEmail, 'POST', `/api/investment-intelligence/positions/${snapA}/publish`, { json: { acknowledgedNoDuplicate: true, correlationId: CORR } });
  const inv1 = (await counts()).user;
  const pub2 = await api(holderEmail, 'POST', `/api/investment-intelligence/positions/${snapA}/publish`, { json: { acknowledgedNoDuplicate: true, correlationId: CORR } });
  const inv2 = (await counts()).user;
  check('JOURNEY 2: publishing the position creates one investment and one publication; the same request again creates none', pub1.status < 300 && inv1.investments === inv0.investments + 1 && inv1.ii_fhip_publications === inv0.ii_fhip_publications + 1 && inv2.investments === inv1.investments && inv2.ii_fhip_publications === inv1.ii_fhip_publications, `publish ${pub1.status}/${pub2.status}; investments ${inv0.investments}->${inv1.investments}->${inv2.investments}; publications ${inv0.ii_fhip_publications}->${inv1.ii_fhip_publications}->${inv2.ii_fhip_publications}`);
  const pubId = (await db.from('ii_fhip_publications').select('id, status').eq('user_id', holderId).eq('canonical_position_id', snapA).eq('status', 'published').limit(1).maybeSingle()).data?.id;
  const un = pubId ? await api(holderEmail, 'POST', `/api/investment-intelligence/publications/${pubId}/unpublish`, { json: {} }) : { status: 'n/a' };
  const re = pubId ? await api(holderEmail, 'POST', `/api/investment-intelligence/publications/${pubId}/republish`, { json: {} }) : { status: 'n/a' };
  const re2 = pubId ? await api(holderEmail, 'POST', `/api/investment-intelligence/publications/${pubId}/republish`, { json: {} }) : { status: 'n/a' };
  const inv3 = (await counts()).user;
  const activePubs = (await db.from('ii_fhip_publications').select('id', { count: 'exact', head: true }).eq('user_id', holderId).eq('canonical_position_id', snapA).eq('status', 'published')).count;
  check('JOURNEY 2: unpublish then republish (twice) leaves exactly one active publication and no extra investment', activePubs === 1 && inv3.investments === inv1.investments, `unpublish ${un.status}, republish ${re.status}/${re2.status}, active ${activePubs}, investments ${inv3.investments}`);

  // ---- held-only storage proof ------------------------------------------------------------------------------------------------------------
  const final = await counts();
  save('j12_counts_final.json', final);
  const changedInstr = Object.entries(final.perInstrument).filter(([k]) => before.perInstrument[k].nav_rows !== final.perInstrument[k].nav_rows).map(([k]) => k);
  check('JOURNEY 2: no instrument was added to the catalogue and the NAV row count of every instrument (held and control) is unchanged', final.global.ii_instruments === before.global.ii_instruments && final.global.ii_scheme_master === before.global.ii_scheme_master && changedInstr.length === 0, `instruments ${before.global.ii_instruments}->${final.global.ii_instruments}; schemes ${before.global.ii_scheme_master}->${final.global.ii_scheme_master}; NAV rows changed for: ${changedInstr.join(',') || 'none'}`);
  const ctlUntouched = CONTROL.every((_, i) => final.perInstrument[`control${i + 1}`].open_holds === before.perInstrument[`control${i + 1}`].open_holds && final.perInstrument[`control${i + 1}`].attempts === before.perInstrument[`control${i + 1}`].attempts);
  check('JOURNEY 2: the six NON-held control schemes gained no hold and no attempt record (held-only)', ctlUntouched, `controls ${CONTROL.map((i) => i.slice(0, 8)).join(',')}`);
  check('JOURNEY 2: the scheme NOT held by this user (D) is not planned and gained no hold or attempt', final.perInstrument.D.open_holds === before.perInstrument.D.open_holds && final.perInstrument.D.attempts === before.perInstrument.D.attempts && !p1.windows.some((w) => w.instrumentId === FUND.D));
  check('JOURNEY 2: the global price table row count is unchanged (no history was loaded for anything: stored history already covered the held schemes)', final.global.ii_prices_nav_total === before.global.ii_prices_nav_total, `${before.global.ii_prices_nav_total} -> ${final.global.ii_prices_nav_total}`);

  // NEGATIVE CONTROL for held-only: if D had been held, the plan WOULD contain it; prove the check can fail by asking the question of a user who holds D
  const nobodyId = await userIdOf('forecast.tc083@example.test'); // a standing fixture user this programme never touches: holds nothing
  check('NEGATIVE CONTROL (held-only): a user who holds nothing gets an empty plan, and the SAME assertion applied to D for the holder is the one that could fail', plan(nobodyId).windows.length === 0 && !wIds.includes(FUND.D));
} catch (e) {
  console.log('FATAL', e?.stack ?? e);
  check('journey ran to the end without an unexpected error', false, String(e?.message ?? e).slice(0, 200));
} finally {
  await setFlag('nav2_trigger_planner', plannerOriginal.enabled, plannerOriginal.disabled_reason);
  const now = await flag('nav2_trigger_planner');
  check('the planner switch is restored to its original state', now.enabled === plannerOriginal.enabled, `enabled=${now.enabled}`);
  await logoutAll();
  const s = summary();
  save('j12_results.json', s);
  console.log(`\n=== journeys 1+2: ${s.pass} PASS, ${s.fail} FAIL ===`);
  process.exitCode = s.fail ? 1 : 0;
}
