/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * Document2 (4) WP-G DEV certification: F15 bank-statement import as a BACKGROUND JOB (PO-D24-03).
 * Label for everything it proves: DEV-verified (project vqycarelcoijzwlpkpcz ONLY). Never PRODUCTION-VERIFIED.
 *
 * SAFETY
 *   - DEV only: every Supabase request asserts the DEV host; PRODUCTION_* values are never loaded.
 *   - NO password anywhere: PASSWORDLESS synthetic users (@fhip-test.invalid), sessions minted with admin generate_link + verify,
 *     deleted in `finally`.
 *   - Prints no secret and no document text. Ids are shown as 8 character prefixes.
 *
 * Run (server first, in another terminal):  node scripts/pdf_routes_dev_server.mjs 3947
 *   npx tsx scripts/doc2_4_wp_g_dev_run.ts http://localhost:3947 scale|ai|robust [label] [sizes]
 * REQUIRES migrations 0310 and 0311 on DEV (docs/reviews/po_apply_wp_g); the script refuses to run otherwise.
 */
import fs from 'node:fs';
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';
import { scaleBankStatement } from './canonical_cert/documents/builders';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

const APP = process.argv[2] ?? 'http://localhost:3947';
const which = process.argv[3] ?? 'scale';
const LABEL = process.argv[4] ?? 'run';
const { check, summary } = makeChecker(`WP-G-${which}-${LABEL}`);
const RUN = `wpg-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad';
const evidence: Record<string, any> = { run: RUN, which, label: LABEL, app: APP, startedAt: new Date().toISOString() };

interface U { id: string; email: string; cookie: string; label: string }
const created: U[] = [];

async function makeUser(label: string, email: string): Promise<U> {
  assertDev(BASE);
  const c = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, email_confirm: true } }); // NO password
  const id = c.json?.id as string;
  if (!id) throw new Error(`create ${label} failed: ${c.status} ${c.text.slice(0, 120)}`);
  recordArtefact({ kind: 'auth_user', id, label, run: RUN });
  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  if (!Array.isArray(prof.json) || prof.json.length !== 1) throw new Error(`profile ${label}: ${prof.status}`);
  const link = await devFetch('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email } });
  const hashed = link.json?.hashed_token ?? link.json?.properties?.hashed_token;
  if (!hashed) throw new Error(`generate_link ${label} failed: ${link.status}`);
  const v = await fetch(`${BASE}/auth/v1/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) });
  const s: any = await v.json();
  if (!s.access_token) throw new Error(`verify ${label} failed: ${v.status}`);
  const session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600), expires_in: s.expires_in ?? 3600, token_type: s.token_type ?? 'bearer', user: s.user };
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const name = `sb-${REF}-auth-token`;
  const CHUNK = 3180;
  const cookie = encoded.length <= CHUNK ? `${name}=${encoded}` : Array.from({ length: Math.ceil(encoded.length / CHUNK) }, (_, i) => `${name}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`).join('; ');
  const u = { id, email, cookie, label };
  created.push(u);
  return u;
}

async function setPlan(u: U, plan: 'free' | 'premium') {
  const body = plan === 'free' ? { plan_tier: 'free', effective_from: day(-1), effective_to: null } : { plan_tier: 'premium', effective_from: day(-30), effective_to: day(30) };
  const r = await devFetch(`/rest/v1/user_entitlements?user_id=eq.${u.id}`, { method: 'PATCH', prefer: 'return=representation', body });
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new Error(`entitlement ${u.label}: ${r.status} ${r.text.slice(0, 100)}`);
}

async function app(u: U | null, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(u ? { Cookie: u.cookie } : {}), ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const t0 = Date.now();
  const res = await fetch(`${APP}${p}`, { method: init.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, ms: Date.now() - t0 };
}
async function rows(table: string, filter: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?${filter}&select=${select}`);
  return (Array.isArray(r.json) ? r.json : []) as any[];
}

async function cleanup() {
  for (const u of created) {
    try {
      await devFetch(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
}

async function ownerQuery(u: U, extra: Record<string, string>) {
  const owner = await resolveSyntheticOwner(fetchOwnerRequest(APP, u.cookie), 'self', 'bank');
  return new URLSearchParams({ ...extra, owner: JSON.stringify(owner) }).toString();
}

async function waitScan(docId: string) {
  const t0 = Date.now();
  let d = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
  while (d && d.processing_status === 'validating' && Date.now() - t0 < 240_000) {
    await sleep(3000);
    await fetch(`${APP}/api/financial-data-hub/documents/cron/malware-scan-sweep`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET ?? '' } }).catch(() => null);
    d = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
  }
  return { doc: d, waitMs: Date.now() - t0 };
}


// ============================================================================ WP-G: bank import as a background job
const REQUEST_LIMIT_MS = 28_000;
const timings: Array<{ what: string; ms: number }> = [];
const slow = () => timings.filter((t) => t.ms >= REQUEST_LIMIT_MS);

async function timed(u: U | null, what: string, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const r = await app(u, p, init);
  timings.push({ what, ms: r.ms });
  return r;
}

async function uploadStatement(u: U, file: { name: string; csv: boolean; bytes: Uint8Array }) {
  const qs = await ownerQuery(u, { country_code: 'AU', currency_code: 'AUD', filename: file.name, statement_period_start: '2026-09-01', statement_period_end: '2026-09-30' });
  const up = await app(u, `/api/financial-data-hub/${file.csv ? 'bank-csv' : 'bank-pdf'}/upload?${qs}`, { method: 'POST', body: new Uint8Array(file.bytes), headers: { 'Content-Type': file.csv ? 'text/csv' : 'application/pdf', 'Content-Length': String(file.bytes.length) } });
  const docId = up.json?.data?.document_id as string | undefined;
  if (!docId) throw new Error(`upload failed: ${up.status} ${up.text.slice(0, 120)}`);
  recordArtefact({ kind: 'fdh_statement_uploads', id: docId, userId: u.id, run: RUN });
  await waitScan(docId);
  if (file.csv) await app(u, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  return docId;
}

const processPath = (csv: boolean, docId: string) => `/api/financial-data-hub/${csv ? 'bank-csv' : 'bank-pdf'}/${docId}/process`;
const jobRows = (docId: string) => rows('fdh_bank_import_jobs', `statement_upload_id=eq.${docId}`);
const txRows = async (docId: string) => rows('fdh_transactions', `statement_upload_id=eq.${docId}`, 'source_row');

/** Drives a job like the browser: ask `advance` until it stops. Every request is timed. */
async function drive(u: U, jobId: string, label: string, stopAt: Array<'completed' | 'failed' | 'review_required'> = ['completed', 'failed', 'review_required']) {
  let slices = 0;
  let busy = 0;
  let view: any = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25 * 60_000) {
    const r = await timed(u, `${label} advance`, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' });
    view = r.json?.data?.job;
    if (!view) return { slices, busy, view: null, status: r.status, totalMs: Date.now() - t0 };
    if (r.json?.data?.busy) { busy += 1; await sleep(3000); } else slices += 1;
    if (stopAt.includes(view.status)) break;
  }
  return { slices, busy, view, status: 200, totalMs: Date.now() - t0 };
}

async function scale() {
  const u = await makeUser('G1', `wpg-g1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  const sizes = (process.argv[5] ?? '25,120,500,1500,3000').split(',').map(Number);
  evidence.scale = [];
  for (const n of sizes) {
    const salt = String(Date.now() % 100000) + n;
    const file = { name: `${RUN}-scale${n}.csv`, csv: true, bytes: scaleBankStatement({ year: 2026, month: 9 }, n, salt).bytes };
    const docId = await uploadStatement(u, file);
    const adm = await timed(u, `scale${n} admission`, processPath(true, docId), { method: 'POST' });
    check(`G.${n}.A admission answers 202 with a job id, quickly (${adm.ms} ms), and wrote no line`, adm.status === 202 && !!adm.json?.data?.job_id && adm.ms < 8000 && (await txRows(docId)).length === 0, JSON.stringify({ status: adm.status, ms: adm.ms }));
    const jobId = adm.json?.data?.job_id as string;
    const d = await drive(u, jobId, `scale${n}`);
    const tx = await txRows(docId);
    const distinct = new Set(tx.map((t) => t.source_row)).size;
    const doc = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
    const chunks = await rows('fdh_bank_import_job_chunks', `job_id=eq.${jobId}`, 'id');
    check(`G.${n}.B ${n} rows -> job completed, exactly ${n} stored lines, none twice, certified (slices ${d.slices}, busy ${d.busy}, ${Math.round(d.totalMs / 1000)} s)`, d.view?.status === 'completed' && tx.length === n && distinct === n && doc?.certification_status === 'certified', JSON.stringify({ status: d.view?.status, tx: tx.length, distinct, cert: doc?.certification_status, err: d.view?.error_code }));
    check(`G.${n}.C staging is cleaned when the job completes`, chunks.length === 0, `chunks ${chunks.length}`);
    const again = await timed(u, `scale${n} process again`, processPath(true, docId), { method: 'POST' });
    check(`G.${n}.D asking to process again answers 200 with the stored result and writes nothing`, again.status === 200 && (await txRows(docId)).length === n, `status ${again.status}`);
    evidence.scale.push({ n, slices: d.slices, busy: d.busy, totalMs: d.totalMs, maxRequestMs: Math.max(...timings.filter((t) => t.what.startsWith(`scale${n} `)).map((t) => t.ms)) });
  }
  check('G.S every request of every run ended under the 28 s platform limit', slow().length === 0, JSON.stringify(slow()));
  evidence.timings = timings;
}

function unrecognisedPdfLines(n: number, salt: string) {
  let bal = 20000;
  const lines = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Period: 01/09/2026 to 30/09/2026', 'Opening balance 20000.00', 'Date | Details | Withdrawals | Deposits | Balance'];
  for (let i = 0; i < n; i++) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1} ${salt} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
  }
  lines.push(`Closing balance ${bal.toFixed(2)}`);
  return lines;
}

// A real bank PDF in an unrecognised layout goes through the AI reading in PARTS. Needs the dev server started with the AI switches
// (scripts/pdf_routes_dev_server.mjs does that).
async function ai() {
  const u = await makeUser('G2', `wpg-g2-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  const sizes = (process.argv[5] ?? '25,120,500').split(',').map(Number);
  evidence.ai = [];
  for (const n of sizes) {
    const salt = String(Date.now() % 100000) + n;
    const lines = unrecognisedPdfLines(n, salt);
    const pages: string[][] = [];
    for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
    const docId = await uploadStatement(u, { name: `${RUN}-ai${n}.pdf`, csv: false, bytes: new Uint8Array(buildMinimalTextPdf(pages)) });
    const adm = await timed(u, `ai${n} admission`, processPath(false, docId), { method: 'POST', json: {} });
    check(`G.AI${n}.A admission answers 202 (${adm.ms} ms)`, adm.status === 202 && adm.ms < 8000, JSON.stringify({ status: adm.status, ms: adm.ms, err: adm.json?.error }));
    const jobId = adm.json?.data?.job_id as string;
    const d = await drive(u, jobId, `ai${n}`);
    check(`G.AI${n}.B read in parts, the reading waits for a check (slices ${d.slices}, ${Math.round(d.totalMs / 1000)} s)`, d.view?.status === 'review_required' && d.view?.review_reason === 'ai_draft', JSON.stringify({ status: d.view?.status, err: d.view?.error_code, msg: d.view?.error_message }));
    if (d.view?.status !== 'review_required') continue;
    const draftRes = await timed(u, `ai${n} reopen draft`, processPath(false, docId), { method: 'POST', json: {} });
    const draft = draftRes.json?.data?.ai_fallback_draft;
    check(`G.AI${n}.C asking again returns the saved draft inline (no second reading), ${draft?.rows?.length} lines`, draftRes.status === 200 && Array.isArray(draft?.rows) && draft.rows.length >= Math.round(n * 0.9), JSON.stringify({ status: draftRes.status, rows: draft?.rows?.length, listed: draft?.allTransactionsListed }));
    const body = { rows: draft.rows, statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd, declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: draft.maskedAccountIdentifier };
    const c1 = await timed(u, `ai${n} confirm`, `/api/financial-data-hub/bank-pdf/${docId}/ai-fallback/confirm`, { method: 'POST', json: body });
    const c2 = await timed(u, `ai${n} confirm replay`, `/api/financial-data-hub/bank-pdf/${docId}/ai-fallback/confirm`, { method: 'POST', json: body });
    check(`G.AI${n}.D confirm answers 202 and a replay finds the same job`, c1.status === 202 && c2.status === 202 && c1.json?.data?.job_id === c2.json?.data?.job_id, JSON.stringify({ c1: c1.status, c2: c2.status }));
    const e = await drive(u, jobId, `ai${n}-write`, ['completed', 'failed']);
    const tx = await txRows(docId);
    check(`G.AI${n}.E ${draft.rows.length} checked lines -> exactly that many stored, none twice`, e.view?.status === 'completed' && tx.length === draft.rows.length && new Set(tx.map((t) => t.source_row)).size === draft.rows.length, JSON.stringify({ status: e.view?.status, tx: tx.length, rows: draft.rows.length }));
    evidence.ai.push({ n, read: { slices: d.slices, totalMs: d.totalMs }, write: { slices: e.slices, totalMs: e.totalMs }, rows: draft.rows.length });
  }
  check('G.AI.S every request ended under the 28 s platform limit', slow().length === 0, JSON.stringify(slow()));
  evidence.timings = timings;
}

// Duplicate admission, repeated polling, reload, a worker that dies (its lease is held and never renewed), and the backstop.
async function robust() {
  const u = await makeUser('G3', `wpg-g3-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  const N = 1500;
  const salt = String(Date.now() % 100000);
  const docId = await uploadStatement(u, { name: `${RUN}-robust.csv`, csv: true, bytes: scaleBankStatement({ year: 2026, month: 9 }, N, salt).bytes });

  const adm = await Promise.all([1, 2, 3, 4].map(() => app(u, processPath(true, docId), { method: 'POST' })));
  const ids = new Set(adm.map((r) => r.json?.data?.job_id));
  check('G.R1 four admissions at the same moment create ONE job', ids.size === 1 && (await jobRows(docId)).length === 1, JSON.stringify({ statuses: adm.map((r) => r.status), ids: ids.size }));
  const jobId = [...ids][0] as string;

  const list = await app(u, '/api/financial-data-hub/bank-import-jobs');
  check('G.R2 a reloaded page finds the unfinished job (list)', (list.json?.data?.jobs ?? []).some((j: any) => j.job_id === jobId), JSON.stringify(list.json?.data?.jobs?.map((j: any) => j.status)));

  const both = await Promise.all([app(u, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' }), app(u, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' })]);
  check('G.R3 two polls at the same moment: one works, the other is told it is busy', both.filter((r) => r.json?.data?.busy).length === 1 && both.filter((r) => r.json?.data?.advanced && !r.json?.data?.busy).length === 1, JSON.stringify(both.map((r) => ({ s: r.status, busy: r.json?.data?.busy }))));

  // A worker that dies: it takes the lease (as a slice would) and is never heard from again.
  await new Promise((r) => setTimeout(r, 1500));
  const claim = await devFetch('/rest/v1/rpc/fdh_bank_import_claim_job', { method: 'POST', body: { p_job_id: jobId, p_owner: 'dead-owner-dev-run', p_lease_seconds: 20 } });
  const held = await app(u, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' });
  check('G.R4 while the dead worker\'s lease is live nobody else may work on the job', (Array.isArray(claim.json) ? claim.json.length : 0) === 1 && held.json?.data?.busy === true, JSON.stringify({ claim: claim.status, busy: held.json?.data?.busy }));
  await sleep(22_000);
  const d = await drive(u, jobId, 'robust');
  const job = (await jobRows(docId))[0];
  const tx = await txRows(docId);
  check(`G.R5 after the lease ran out the job was taken over and ended exactly: ${N} lines, none twice`, d.view?.status === 'completed' && tx.length === N && new Set(tx.map((t) => t.source_row)).size === N && Number(job?.reclaim_count) >= 1, JSON.stringify({ status: d.view?.status, tx: tx.length, reclaim: job?.reclaim_count }));
  const poll = await app(u, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' });
  check('G.R6 polling a finished job changes nothing', poll.json?.data?.advanced === false && (await txRows(docId)).length === N, JSON.stringify(poll.json?.data?.job?.status));

  // The backstop with no browser at all.
  const docB = await uploadStatement(u, { name: `${RUN}-backstop.csv`, csv: true, bytes: scaleBankStatement({ year: 2026, month: 9 }, 600, salt + 'b').bytes });
  const admB = await app(u, processPath(true, docB), { method: 'POST' });
  await app(u, `/api/financial-data-hub/bank-import-jobs/${admB.json?.data?.job_id}/advance`, { method: 'POST' });
  let ticks = 0;
  for (; ticks < 40; ticks++) {
    const c = await timed(null, 'cron advance', '/api/financial-data-hub/bank-import-jobs/cron/advance', { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET ?? '' } });
    if (c.status !== 200) break;
    if ((await jobRows(docB))[0]?.status === 'completed') break;
    await sleep(1500);
  }
  check('G.R7 the scheduled backstop finishes an abandoned job with no browser', (await jobRows(docB))[0]?.status === 'completed' && (await txRows(docB)).length === 600, `ticks ${ticks}`);
  const noSecret = await app(null, '/api/financial-data-hub/bank-import-jobs/cron/advance', { method: 'POST' });
  check('G.R8 the backstop refuses a call without the secret', noSecret.status === 401, `status ${noSecret.status}`);

  // Tenancy on the real database.
  const other = await makeUser('G4', `wpg-g4-${Date.now()}@fhip-test.invalid`);
  const peek = await app(other, `/api/financial-data-hub/bank-import-jobs/${jobId}`);
  const poke = await app(other, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' });
  const listOther = await app(other, '/api/financial-data-hub/bank-import-jobs');
  const admOther = await app(other, processPath(true, docId), { method: 'POST' });
  check('G.R9 another user cannot read, advance, list or admit this user\'s job (404 / empty)', peek.status === 404 && poke.status === 404 && (listOther.json?.data?.jobs ?? []).length === 0 && admOther.status === 404, JSON.stringify({ peek: peek.status, poke: poke.status, admit: admOther.status }));
  check('G.R.S every request ended under the 28 s platform limit', slow().length === 0, JSON.stringify(slow()));
  evidence.timings = timings;
}

async function main() {
  console.log(`=== WP-G ${which} (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  const probe = await devFetch('/rest/v1/fdh_bank_import_jobs?select=id&limit=1');
  if (probe.status !== 200) throw new Error(`migration 0310 is not applied on DEV (HTTP ${probe.status}); apply docs/reviews/po_apply_wp_g/02 and 03 first`);
  try {
    if (which === 'scale') await scale();
    else if (which === 'ai') await ai();
    else if (which === 'robust') await robust();
  } finally {
    await cleanup();
    evidence.cleanedUsers = created.length;
    fs.writeFileSync(`${SCRATCH}/wpg_${which}_${LABEL}.json`, JSON.stringify(evidence, null, 2));
    summary();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
