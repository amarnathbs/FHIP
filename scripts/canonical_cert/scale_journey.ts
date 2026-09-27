/**
 * Canonical-upload certification, SCALE journey (DEV, localhost app, signed-in fixture user).
 *
 *   npx tsx scripts/canonical_cert/scale_journey.ts --email <e> --port 3103 --n 1000|1001 [--salt C] [--month 2026-08]
 *        [--repeat byte|reexport]   # upload the SAME statement again after approval (0 duplicate effects expected)
 *        [--out <file.json>]
 *
 * The behaviour under test goes through the real app routes as the user, exactly as the Expenses
 * "Import bank statement" panel and the category-totals review page send them:
 *   upload -> detect -> process -> categorise -> category-review -> set-category (user decisions)
 *   -> approve-all
 * The service role is used ONLY to OBSERVE row counts at each layer (never to write).
 *
 * Row counts are recorded at every layer: file data lines, the process route's parsed/created counts,
 * fdh_transactions rows in the database (exact count, not a capped read), the category review's
 * counts, and afterwards the Expenses actuals route and the Dashboard summary (as DELTAS against the
 * pre-journey values -- fixture users carry standing data). Every request is timed and compared with
 * the 28 s production request limit (Amplify kills any request at 28 s regardless of maxDuration).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseMonth, previousCompleteMonth, scaleBankStatement } from './documents/builders';
import { api } from './lib/session.mjs';
import { serviceClient } from './lib/env.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
const n = Number(arg('--n'));
const repeat = arg('--repeat') as 'byte' | 'reexport' | undefined;
if (!email || !port || !(n > 0)) throw new Error('usage: scale_journey.ts --email <e> --port <p> --n <rows> [--salt C] [--month YYYY-MM] [--repeat byte|reexport] [--out f.json]');
const month = arg('--month') ? parseMonth(arg('--month')!) : previousCompleteMonth();
const doc = scaleBankStatement(month, n, arg('--salt') ?? 'C');
const PLATFORM_LIMIT_MS = 28_000;
const FOOD = '5a8ba467-eaf4-4f68-82d5-07ed36931cd0';
const INCOME = '0c046122-43e8-431d-94e2-527e734377b1';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const timings: Array<{ step: string; ms: number; status: number; overLimit: boolean; sbRequests?: number | null; sbWaitMs?: number | null }> = [];
const evidence: Json = { email, n, file: doc.filename, fileDataLines: doc.oracle.rows, oracle: doc.oracle, steps: {}, timings };

/** Supabase round trips made by the dev server so far (dev_server.mjs --count-requests), or null. */
function sbCounter(): { requests: number; waitMs: number } | null {
  const dir = path.resolve('.canonical-cert');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^sb-requests-\d+\.json$/.test(f)) : [];
  if (files.length === 0) return null;
  return files.reduce((acc, f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { requests: acc.requests + s.requests, waitMs: acc.waitMs + s.waitMs }; } catch { return acc; }
  }, { requests: 0, waitMs: 0 });
}

async function call(step: string, method: string, route: string, opts: Json = {}) {
  const before = sbCounter();
  const t = Date.now();
  const r = await api(email!, method, route, { port, ...opts });
  const ms = Date.now() - t;
  await new Promise((res) => setTimeout(res, 200)); // let the counter flush
  const after = sbCounter();
  const sbRequests = before && after ? after.requests - before.requests : null;
  const sbWaitMs = before && after ? after.waitMs - before.waitMs : null;
  timings.push({ step, ms, status: r.status, overLimit: ms > PLATFORM_LIMIT_MS, sbRequests, sbWaitMs } as (typeof timings)[number]);
  console.log(`${step.padEnd(34)} HTTP ${r.status}  ${String(ms).padStart(6)} ms${sbRequests !== null ? `  sb=${sbRequests} (${sbWaitMs} ms waiting)` : ''}${ms > PLATFORM_LIMIT_MS ? '  > 28 s LIMIT' : ''}`);
  return r as { status: number; json: Json | null; text: string };
}

async function exactCount(table: string, filters: Record<string, string>) {
  const sb = await serviceClient();
  let q = sb.from(table).select('id', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function userId() {
  const sb = await serviceClient();
  const { data } = await sb.from('user_profiles').select('user_id').limit(1); // warm
  void data;
  const s = JSON.parse(fs.readFileSync(path.resolve('.canonical-cert', `session-${email!.replace(/[^a-z0-9._-]/gi, '_')}.json`), 'utf8'));
  return s.userId as string;
}

async function observe(label: string, uid: string, statementIds: string[]) {
  const o: Json = {
    fdh_transactions_user: await exactCount('fdh_transactions', { user_id: uid }),
    fdh_transactions_user_approved: await exactCount('fdh_transactions', { user_id: uid, approval_status: 'approved' }),
    fdh_statement_uploads_user: await exactCount('fdh_statement_uploads', { user_id: uid }),
    per_statement: {} as Json,
  };
  for (const sid of statementIds) {
    o.per_statement[sid] = {
      rows: await exactCount('fdh_transactions', { statement_upload_id: sid }),
      approved: await exactCount('fdh_transactions', { statement_upload_id: sid, approval_status: 'approved' }),
    };
  }
  const act = await call(`${label}: GET expenses/actuals`, 'GET', '/api/expenses/actuals?page=1&pageSize=500');
  const a = act.json?.data ?? {};
  o.expenses_actuals = {
    status: a.status, lineCount: a.lineCount, pageCount: a.pageCount, linesOnPage: a.lines?.length,
    totals: a.totals, coveredMonths: a.window?.coveredMonths, unknownPendingCount: a.unknownPendingCount,
    excludedDuplicates: a.excludedDuplicates, nonSpending: (a.nonSpending ?? []).map((b: Json) => ({ bucket: b.bucket, count: b.count, total: b.totalInWindow })),
  };
  // Last page must exist and hold the tail (a capped read would lose it).
  if (a.pageCount > 1) {
    const last = await call(`${label}: GET actuals last page`, 'GET', `/api/expenses/actuals?page=${a.pageCount}&pageSize=500`);
    o.expenses_actuals.lastPageLines = last.json?.data?.lines?.length;
  }
  const dash = await call(`${label}: GET dashboard/summary`, 'GET', '/api/dashboard/summary');
  const d = dash.json?.data ?? {};
  o.dashboard = {
    totalMonthlyExpenses: d.totalMonthlyExpenses, bankMonthlyExpenses: d.bankMonthlyExpenses, bankMonthlyIncome: d.bankMonthlyIncome,
    grossMonthlyIncome: d.grossMonthlyIncome, netMonthlyIncome: d.netMonthlyIncome, monthlySurplus: d.monthlySurplus,
    coveredMonths: d.dataStatus?.window?.coveredMonths, unknownPendingCount: d.dataStatus?.unknownPendingCount,
  };
  evidence.steps[label] = o;
  console.log(`  [${label}] ${JSON.stringify({ tx: o.fdh_transactions_user, approved: o.fdh_transactions_user_approved, per_statement: o.per_statement, actualsLines: o.expenses_actuals.lineCount, actualTotal: o.expenses_actuals.totals?.actualTotalInWindow, dashBankExp: o.dashboard.bankMonthlyExpenses, dashBankInc: o.dashboard.bankMonthlyIncome })}`);
  return o;
}

async function uploadDetectProcess(label: string, bytes: Uint8Array) {
  const qs = new URLSearchParams({ ...doc.upload.query, filename: doc.filename });
  const up = await call(`${label}: upload`, 'POST', `/api/financial-data-hub/bank-csv/upload?${qs}`, { body: bytes, contentType: 'text/csv' });
  const u = up.json?.data ?? {};
  const documentId = u.document_id as string;
  if (!documentId) throw new Error(`upload failed: ${up.text.slice(0, 300)}`);
  const out: Json = { upload: { status: up.status, document_id: documentId, duplicate_of_document_id: u.duplicate_of_document_id ?? null, account_resolution: u.account_resolution, processing_status: u.processing_status } };
  if (!u.duplicate_of_document_id) {
    const det = await call(`${label}: detect`, 'POST', `/api/financial-data-hub/bank-csv/${documentId}/detect`);
    out.detect = { status: det.status, error: det.json?.error ?? null };
  }
  const proc = await call(`${label}: process`, 'POST', `/api/financial-data-hub/bank-csv/${documentId}/process`);
  const p = proc.json?.data ?? {};
  out.process = {
    status: proc.status, error: proc.json?.error ?? null, document_id: p.document_id, duplicate: p.duplicate, duplicate_of_document_id: p.duplicate_of_document_id,
    transactions_created: p.transactions_created, duplicates_skipped: p.duplicates_skipped, rejected_rows: p.rejected_rows,
    declared_row_count: p.declared_row_count, parsed_row_count: p.parsed_row_count, reconciliation_status: p.reconciliation_status, processing_status: p.processing_status,
  };
  const cat = await call(`${label}: categorise`, 'POST', '/api/financial-data-hub/bank-transactions/categorise');
  out.categorise = { status: cat.status, summary: cat.json?.data ?? cat.json?.error };
  return { documentId, out };
}

async function review(label: string, statementId: string) {
  const r = await call(`${label}: GET category-review`, 'GET', `/api/financial-data-hub/documents/${statementId}/category-review`);
  const d = r.json?.data ?? {};
  return { status: r.status, counts: d.counts, needs: (d.needs_decision ?? []) as Json[], groups: (d.groups ?? []).map((g: Json) => ({ key: g.group_key, label: g.label, count: g.count, pending: g.pending_count })) };
}

async function main() {
  const uid = await userId();
  const csvText = Buffer.from(doc.bytes).toString('utf8');
  const fileDataLines = csvText.trim().split(/\r?\n/).length - 1;
  evidence.fileDataLinesCounted = fileDataLines;
  console.log(`scale journey: ${doc.filename} (${fileDataLines} data lines) as ${email}`);

  // --resume <partial.json>: continue a run whose client died mid-way (the server-side work it had
  // started completed); the pre-journey observation and the first steps come from that partial file.
  const resume = arg('--resume');
  let sid: string;
  let rv: Awaited<ReturnType<typeof review>>;
  if (resume) {
    const partial = JSON.parse(fs.readFileSync(resume, 'utf8'));
    Object.assign(evidence.steps, partial.steps);
    timings.push(...(partial.timings ?? []));
    evidence.resumedFrom = resume;
    sid = partial.statementId;
    evidence.statementId = sid;
    rv = await review('review#resume', sid);
    console.log(`  resumed; review counts ${JSON.stringify(rv.counts)}`);
  } else {
    await observe('pre', uid, []);
    const first = await uploadDetectProcess('first', doc.bytes);
    evidence.steps.first = first.out;
    sid = first.documentId;
    evidence.statementId = sid;
    evidence.steps.after_process_db = { rows: await exactCount('fdh_transactions', { statement_upload_id: sid }) };
    console.log(`  db rows for statement after process: ${evidence.steps.after_process_db.rows}`);

    rv = await review('review#1', sid);
    evidence.steps.review1 = { counts: rv.counts, needsDecision: rv.needs.length, groups: rv.groups };
    console.log(`  review#1 counts ${JSON.stringify(rv.counts)}`);
  }

  // User decisions: one spending line "remembered" (the realistic 1-click path for a repeated payee),
  // then every line still needing a decision decided one by one (credits -> income, debits -> food).
  const decisionMs: number[] = [];
  const firstOut = resume ? undefined : rv.needs.find((x) => x.direction === 'out' && x.can_choose_category);
  if (firstOut) {
    const t = Date.now();
    const r = await call('decide: remember payee (out)', 'POST', `/api/financial-data-hub/bank-transactions/${firstOut.id}/set-category`, { json: { category_id: FOOD, remember_payee: true } });
    decisionMs.push(Date.now() - t);
    evidence.steps.rememberPayee = { status: r.status, result: r.json?.data ?? r.json?.error };
    rv = await review('review#2', sid);
    evidence.steps.review2 = { counts: rv.counts, needsDecision: rv.needs.length };
    console.log(`  review#2 counts ${JSON.stringify(rv.counts)}`);
  }
  let decided = 0; let decideFailures = 0;
  for (const item of rv.needs) {
    if (!item.can_choose_category) continue;
    const t = Date.now();
    const r = await api(email!, 'POST', `/api/financial-data-hub/bank-transactions/${item.id}/set-category`, { port, json: { category_id: item.direction === 'in' ? INCOME : FOOD, remember_payee: false } });
    const ms = Date.now() - t;
    decisionMs.push(ms);
    if (r.status === 200) decided++; else { decideFailures++; if (decideFailures <= 3) console.log(`  set-category ${item.id} -> ${r.status} ${r.text.slice(0, 200)}`); }
    if (decisionMs.length % 50 === 0) console.log(`  ... ${decisionMs.length} decisions`);
  }
  const sorted = [...decisionMs].sort((a, b) => a - b);
  evidence.steps.decisions = { individuallyDecided: decided, failures: decideFailures, count: decisionMs.length, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted[sorted.length - 1] ?? null, overLimit: decisionMs.filter((m) => m > PLATFORM_LIMIT_MS).length };
  console.log(`  decisions ${JSON.stringify(evidence.steps.decisions)}`);

  rv = await review('review#3', sid);
  evidence.steps.review3 = { counts: rv.counts, needsDecision: rv.needs.length, groups: rv.groups };
  console.log(`  review#3 counts ${JSON.stringify(rv.counts)}`);

  const appr = await call('approve-all', 'POST', `/api/financial-data-hub/documents/${sid}/category-review/approve-all`, { json: {} });
  evidence.steps.approveAll = { status: appr.status, result: appr.json?.data ?? appr.json };
  console.log(`  approve-all ${appr.status} ${JSON.stringify(appr.json?.data ?? appr.json).slice(0, 300)}`);
  rv = await review('review#4', sid);
  evidence.steps.review4 = { counts: rv.counts };
  console.log(`  review#4 counts ${JSON.stringify(rv.counts)}`);
  await observe('post_approve', uid, [sid]);

  if (repeat) {
    const bytes = repeat === 'byte' ? doc.bytes : Buffer.from(csvText.replace(/\r?\n/g, '\r\n') + '\r\n', 'utf8');
    const again = await uploadDetectProcess(`repeat(${repeat})`, bytes);
    evidence.steps.repeat = again.out;
    evidence.repeatStatementId = again.documentId;
    const ids = again.documentId === sid ? [sid] : [sid, again.documentId];
    if (again.documentId !== sid) {
      const rr = await review('repeat review', again.documentId);
      evidence.steps.repeatReview = { status: rr.status, counts: rr.counts, needsDecision: rr.needs.length };
      console.log(`  repeat review ${rr.status} ${JSON.stringify(rr.counts)}`);
    }
    await observe('post_repeat', uid, ids);
  }

  const pre = evidence.steps.pre; const post = evidence.steps[repeat ? 'post_repeat' : 'post_approve'];
  evidence.deltas = {
    fdh_transactions_user: post.fdh_transactions_user - pre.fdh_transactions_user,
    fdh_transactions_user_approved: post.fdh_transactions_user_approved - pre.fdh_transactions_user_approved,
    expenses_actuals_lineCount: (post.expenses_actuals.lineCount ?? 0) - (pre.expenses_actuals.lineCount ?? 0),
    expenses_actuals_actualTotalInWindow: +(((post.expenses_actuals.totals?.actualTotalInWindow ?? 0) - (pre.expenses_actuals.totals?.actualTotalInWindow ?? 0))).toFixed(2),
    dashboard_bankMonthlyExpenses: +(((post.dashboard.bankMonthlyExpenses ?? 0) - (pre.dashboard.bankMonthlyExpenses ?? 0))).toFixed(2),
    dashboard_bankMonthlyIncome: +(((post.dashboard.bankMonthlyIncome ?? 0) - (pre.dashboard.bankMonthlyIncome ?? 0))).toFixed(2),
  };
  if (repeat) {
    const pa = evidence.steps.post_approve;
    evidence.repeatDeltas = {
      fdh_transactions_user: post.fdh_transactions_user - pa.fdh_transactions_user,
      fdh_transactions_user_approved: post.fdh_transactions_user_approved - pa.fdh_transactions_user_approved,
      expenses_actuals_lineCount: (post.expenses_actuals.lineCount ?? 0) - (pa.expenses_actuals.lineCount ?? 0),
      expenses_actuals_actualTotalInWindow: +(((post.expenses_actuals.totals?.actualTotalInWindow ?? 0) - (pa.expenses_actuals.totals?.actualTotalInWindow ?? 0))).toFixed(2),
      dashboard_bankMonthlyExpenses: +(((post.dashboard.bankMonthlyExpenses ?? 0) - (pa.dashboard.bankMonthlyExpenses ?? 0))).toFixed(2),
      dashboard_bankMonthlyIncome: +(((post.dashboard.bankMonthlyIncome ?? 0) - (pa.dashboard.bankMonthlyIncome ?? 0))).toFixed(2),
    };
  }
  console.log(`DELTAS ${JSON.stringify(evidence.deltas)}`);
  if (evidence.repeatDeltas) console.log(`REPEAT DELTAS ${JSON.stringify(evidence.repeatDeltas)}`);
  console.log(`requests over 28 s: ${JSON.stringify(timings.filter((t) => t.overLimit))}`);
  const out = arg('--out') ?? path.resolve('test-artifacts', 'canonical_cert', `scale-${n}${repeat ? '-' + repeat : ''}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`evidence -> ${out}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); fs.writeFileSync(path.resolve('.canonical-cert', `scale-${n}-partial.json`), JSON.stringify(evidence, null, 2)); process.exitCode = 1; });
