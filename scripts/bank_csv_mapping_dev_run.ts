/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * Bank CSV column mapping (28-10-2026) DEV certification. Label for everything it proves: DEV-verified (project vqycarelcoijzwlpkpcz ONLY).
 * Never PRODUCTION-VERIFIED.
 *
 * What it drives, over HTTP against a local dev server wired to DEV (real S3 + GuardDuty scan, the real routes, the real database):
 *   upload -> detect (unrecognised layout) -> process refused (the old dead end) -> columns -> map -> process (the background job) ->
 *   the lines -> a second identical upload -> a second DIFFERENT upload of the same layout (no mapping asked) -> a wrong mapping corrected
 *   without a second upload -> the Bank Australia recognised layout -> two users on the new routes -> a Free user.
 * ALL DATA IS SYNTHETIC (tests/support/buildPoShapedBankCsv.ts). Nothing from the Product Owner's real file is read or sent.
 *
 * SAFETY
 *   - DEV only: every Supabase request asserts the DEV host; PRODUCTION_* values are never loaded.
 *   - NO password anywhere: PASSWORDLESS synthetic users (@fhip-test.invalid), sessions minted with admin generate_link + verify,
 *     deleted in `finally` (their rows go with them).
 *   - Prints no secret and no document text. Ids are shown as 8 character prefixes.
 *
 * Run (server first, in another terminal):  node scripts/pdf_routes_dev_server.mjs 3951
 *   npx tsx scripts/bank_csv_mapping_dev_run.ts http://localhost:3951 [label]
 * REQUIRES migrations 0310 and 0311 on DEV (already applied there by WP-G). No migration of this change is needed.
 */
import fs from 'node:fs';
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';
import { buildPoShapedCsv, UNRECOGNISED_VARIANT } from '../tests/support/buildPoShapedBankCsv';
import { adviseDateFormat, suggestMapping, toMapRequest } from '../lib/financial-data-hub/bank-csv/mappingAssist';
import { detectBankCsvFormat } from '../lib/financial-data-hub/bank-csv/detection';

const APP = process.argv[2] ?? 'http://localhost:3951';
const LABEL = process.argv[3] ?? 'run';
const { check, summary } = makeChecker(`MAP-${LABEL}`);
const RUN = `map-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad';
const evidence: Record<string, any> = { run: RUN, label: LABEL, app: APP, startedAt: new Date().toISOString() };

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
    try { await devFetch(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' }); } catch { /* best effort */ }
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

async function upload(u: U, name: string, bytes: Uint8Array) {
  const qs = await ownerQuery(u, { country_code: 'AU', currency_code: 'AUD', filename: name });
  const up = await app(u, `/api/financial-data-hub/bank-csv/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'text/csv', 'Content-Length': String(bytes.length) } });
  const docId = up.json?.data?.document_id as string | undefined;
  if (!docId) throw new Error(`upload failed: ${up.status} ${up.text.slice(0, 160)}`);
  recordArtefact({ kind: 'fdh_statement_uploads', id: docId, userId: u.id, run: RUN });
  const scanned = await waitScan(docId);
  return { docId, up, scanned };
}
const detect = (u: U, docId: string) => app(u, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
const processDoc = (u: U, docId: string) => app(u, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
const txRows = async (docId: string) => {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await devFetch(`/rest/v1/fdh_transactions?statement_upload_id=eq.${docId}&select=source_row,economic_fingerprint,transaction_date,description_raw&order=source_row.asc`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    const page = Array.isArray(r.json) ? r.json : [];
    out.push(...page);
    if (page.length < 1000) return out;
  }
};
async function drive(u: U, jobId: string) {
  let slices = 0;
  let view: any = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const r = await app(u, `/api/financial-data-hub/bank-import-jobs/${jobId}/advance`, { method: 'POST' });
    view = r.json?.data?.job;
    if (!view) return { slices, view: null, totalMs: Date.now() - t0 };
    if (r.json?.data?.busy) await sleep(2000); else slices += 1;
    if (['completed', 'failed', 'review_required'].includes(view.status)) break;
  }
  return { slices, view, totalMs: Date.now() - t0 };
}
/** The request body the screen builds from a file's own header (suggestion + proven date style), optionally with a deliberate mistake. */
function screenBody(bytes: Uint8Array, over: { dateFormat?: any; remember?: boolean } = {}) {
  const { header, rows: sample } = detectBankCsvFormat(bytes).parsed!;
  const s = suggestMapping(header, sample);
  const advice = adviseDateFormat(header, sample, s.draft.transactionDate);
  return toMapRequest(s.draft, s.amountStyle!, over.dateFormat ?? advice.proven!, ',', { remember: over.remember ?? true, allowSharedColumns: false });
}
const layout = (n: number, seed: number, ref: string) => buildPoShapedCsv(n, seed, { omit: ['Transaction type'], renames: { 'Reference no': ref } });

async function main() {
  console.log(`=== bank CSV column mapping (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  const probe = await devFetch('/rest/v1/fdh_bank_import_jobs?select=id&limit=1');
  if (probe.status !== 200) throw new Error(`migration 0310 is not applied on DEV (HTTP ${probe.status})`);
  try {
    const u1 = await makeUser('M1', `map-m1-${Date.now()}@fhip-test.invalid`);
    const u2 = await makeUser('M2', `map-m2-${Date.now()}@fhip-test.invalid`);
    const u3 = await makeUser('M3free', `map-m3-${Date.now()}@fhip-test.invalid`);
    await setPlan(u1, 'premium');
    await setPlan(u2, 'premium');
    await setPlan(u3, 'free');

    // ---- 1. the unrecognised layout of 342 rows: the dead end, then the way out
    const N = 342;
    const first = layout(N, 1, 'Reference no');
    const a = await upload(u1, `${RUN}-a.csv`, first.bytes);
    check('M.1 the upload is stored and scanned clean', a.scanned.doc?.malware_scan_status === 'clean' || a.scanned.doc?.processing_status === 'queued', JSON.stringify({ scan: a.scanned.doc?.malware_scan_status, status: a.scanned.doc?.processing_status }));
    const d1 = await detect(u1, a.docId);
    check('M.2 detect says the layout is not recognised (manual_mapping_required)', d1.status === 200 && d1.json?.data?.detection_status === 'manual_mapping_required' && d1.json?.data?.saved_layout_used === false, JSON.stringify(d1.json?.data));
    const p0 = await processDoc(u1, a.docId);
    check('M.3 process still refuses with the stable code mapping_required and a message that says what to do', p0.status === 400 && p0.json?.error === 'mapping_required' && /Choose the columns/.test(p0.json?.message ?? ''), JSON.stringify({ status: p0.status, error: p0.json?.error }));
    const cols = await app(u1, `/api/financial-data-hub/bank-csv/${a.docId}/columns`);
    check('M.4 the columns route returns the 10 headings, 100 sample rows and the true row count', cols.status === 200 && cols.json?.data?.header?.length === 10 && cols.json?.data?.rows?.length === 100 && cols.json?.data?.total_rows === N, JSON.stringify({ status: cols.status, header: cols.json?.data?.header?.length, rows: cols.json?.data?.rows?.length, total: cols.json?.data?.total_rows }));

    // two users on every new route
    const x1 = await app(u2, `/api/financial-data-hub/bank-csv/${a.docId}/columns`);
    const x2 = await app(u2, `/api/financial-data-hub/bank-csv/${a.docId}/remap`, { method: 'POST' });
    const x3 = await app(u2, `/api/financial-data-hub/bank-csv/${a.docId}/map`, { method: 'POST', json: screenBody(first.bytes) });
    const x4 = await app(null, `/api/financial-data-hub/bank-csv/${a.docId}/columns`);
    check('M.5 another user gets 404 on columns, remap and map; signed out is refused', x1.status === 404 && x2.status === 404 && x3.status === 404 && (x4.status === 401 || x4.status === 403 || x4.status === 307), JSON.stringify({ columns: x1.status, remap: x2.status, map: x3.status, anon: x4.status }));
    check('M.5b the other user\'s refusal revealed no column heading', !/Effective date/.test(x1.text + x2.text + x3.text));

    const bad = await app(u1, `/api/financial-data-hub/bank-csv/${a.docId}/map`, { method: 'POST', json: { ...screenBody(first.bytes), column_mapping: { ...screenBody(first.bytes).column_mapping, description: 'No such column' } } });
    check('M.6 a column that is not in the file is refused with 422 and a plain message', bad.status === 422 && /not in this file/.test(bad.json?.error ?? ''), JSON.stringify({ status: bad.status, error: bad.json?.error }));

    const map = await app(u1, `/api/financial-data-hub/bank-csv/${a.docId}/map`, { method: 'POST', json: screenBody(first.bytes) });
    check('M.7 the suggested columns, confirmed, are saved (200, detected, a remembered layout)', map.status === 200 && map.json?.data?.detection_status === 'detected' && !!map.json?.data?.mapping_template_id, JSON.stringify(map.json?.data));
    const tpl = (await rows('fdh_csv_mapping_templates', `id=eq.${map.json?.data?.mapping_template_id}`))[0];
    check('M.8 the stored layout has every key (amount null) and the PO date style', tpl?.status === 'user_confirmed' && tpl?.column_mapping && 'amount' in tpl.column_mapping && tpl.column_mapping.amount === null && tpl.date_format === 'h:mma ddd D MMMM, YYYY', JSON.stringify({ status: tpl?.status, date_format: tpl?.date_format, hasAmountKey: tpl?.column_mapping && 'amount' in tpl.column_mapping }));

    const adm = await processDoc(u1, a.docId);
    check('M.9 process then answers 202 with a job id and writes no line', adm.status === 202 && !!adm.json?.data?.job_id && (await txRows(a.docId)).length === 0, JSON.stringify({ status: adm.status }));
    const run = await drive(u1, adm.json?.data?.job_id);
    const tx = await txRows(a.docId);
    const doc = (await rows('fdh_statement_uploads', `id=eq.${a.docId}`))[0];
    check(`M.10 the job completes: exactly ${N} stored lines, none twice, in review`, run.view?.status === 'completed' && tx.length === N && new Set(tx.map((t) => t.source_row)).size === N && doc?.certification_status === 'review_required', JSON.stringify({ status: run.view?.status, tx: tx.length, cert: doc?.certification_status, slices: run.slices }));
    check('M.11 the first line has the right day and carries the long description', tx[0]?.transaction_date === '2025-07-01' && /Synthetic Merchant/.test(tx[0]?.description_raw ?? ''), JSON.stringify({ date: tx[0]?.transaction_date }));
    const again = await processDoc(u1, a.docId);
    check('M.12 asking again answers 200 with the stored result and writes nothing', again.status === 200 && (await txRows(a.docId)).length === N, `status ${again.status}`);

    // ---- 2. a second IDENTICAL upload, then a different file of the same layout
    const b = await upload(u1, `${RUN}-b.csv`, first.bytes);
    await detect(u1, b.docId);
    const pb = await processDoc(u1, b.docId);
    check('M.13 a second identical upload is a copy: no mapping asked, 200, nothing created', pb.status === 200 && (await txRows(b.docId)).length === 0, JSON.stringify({ status: pb.status, created: pb.json?.data?.transactions_created }));
    const longer = layout(N + 58, 1, 'Reference no');
    const c = await upload(u1, `${RUN}-c.csv`, longer.bytes);
    const dc = await detect(u1, c.docId);
    check('M.14 a different file with the SAME layout uses the remembered layout (detected, saved_layout_used, no question)', dc.status === 200 && dc.json?.data?.detection_status === 'detected' && dc.json?.data?.saved_layout_used === true, JSON.stringify(dc.json?.data));
    const pc = await processDoc(u1, c.docId);
    const runC = await drive(u1, pc.json?.data?.job_id);
    const txC = await txRows(c.docId);
    const allRows = [...(await txRows(a.docId)), ...txC];
    const fps = allRows.map((t) => t.economic_fingerprint);
    check('M.15 only the 58 new lines are added; the overlap is not duplicated (no economic fingerprint twice across both statements)', runC.view?.status === 'completed' && txC.length === 58 && new Set(fps).size === fps.length && allRows.length === N + 58, JSON.stringify({ status: runC.view?.status, added: txC.length, total: allRows.length, distinct: new Set(fps).size }));

    // ---- 3. a wrong mapping corrected without a second upload
    const wrongBytes = layout(50, 9, 'Ref B');
    const w = await upload(u1, `${RUN}-w.csv`, wrongBytes.bytes);
    await detect(u1, w.docId);
    const wm = await app(u1, `/api/financial-data-hub/bank-csv/${w.docId}/map`, { method: 'POST', json: screenBody(wrongBytes.bytes, { dateFormat: 'DD/MM/YYYY', remember: false }) });
    const wp = await processDoc(u1, w.docId);
    const wrun = await drive(u1, wp.json?.data?.job_id);
    check('M.16 a wrong date style reads nothing (0 lines) and the job still ends cleanly', wm.status === 200 && wrun.view?.status === 'completed' && (await txRows(w.docId)).length === 0, JSON.stringify({ map: wm.status, status: wrun.view?.status, tx: (await txRows(w.docId)).length }));
    const rm = await app(u1, `/api/financial-data-hub/bank-csv/${w.docId}/remap`, { method: 'POST' });
    check('M.17 remap takes the statement back to the columns (no upload) and removes its job', rm.status === 200 && rm.json?.data?.detection_status === 'manual_mapping_required' && (await rows('fdh_bank_import_jobs', `statement_upload_id=eq.${w.docId}`, 'id')).length === 0, JSON.stringify({ status: rm.status, data: rm.json?.data }));
    const wm2 = await app(u1, `/api/financial-data-hub/bank-csv/${w.docId}/map`, { method: 'POST', json: screenBody(wrongBytes.bytes) });
    const wp2 = await processDoc(u1, w.docId);
    const wrun2 = await drive(u1, wp2.json?.data?.job_id);
    const wtx = await txRows(w.docId);
    check('M.18 the corrected columns read all 50 lines, once', wm2.status === 200 && wrun2.view?.status === 'completed' && wtx.length === 50 && new Set(wtx.map((t) => t.source_row)).size === 50, JSON.stringify({ map: wm2.status, status: wrun2.view?.status, tx: wtx.length }));

    // ---- 4. Bank Australia recognised layout (experimental)
    const ba = buildPoShapedCsv(N, 2);
    const e = await upload(u1, `${RUN}-ba.csv`, ba.bytes);
    const de = await detect(u1, e.docId);
    check('M.19 the full Bank Australia header is recognised (detected, no mapping asked)', de.status === 200 && de.json?.data?.detection_status === 'detected' && de.json?.data?.adapter_key === 'au_bank_australia_debit_credit_v1', JSON.stringify(de.json?.data));
    const pe = await processDoc(u1, e.docId);
    const rune = await drive(u1, pe.json?.data?.job_id);
    const txE = await txRows(e.docId);
    const docE = (await rows('fdh_statement_uploads', `id=eq.${e.docId}`))[0];
    check(`M.20 ${N} lines stored once; an experimental layout lands in review, never certified`, rune.view?.status === 'completed' && txE.length === N && new Set(txE.map((t) => t.source_row)).size === N && docE?.certification_status === 'review_required', JSON.stringify({ status: rune.view?.status, tx: txE.length, cert: docE?.certification_status }));
    const rm2 = await app(u1, `/api/financial-data-hub/bank-csv/${e.docId}/remap`, { method: 'POST' });
    check('M.21 a recognised layout has no mapping to change (remap refused, lines untouched)', rm2.status === 400 && (await txRows(e.docId)).length === N, JSON.stringify({ status: rm2.status }));

    // ---- 5. Premium preserved
    const qs = await ownerQuery(u3, { country_code: 'AU', currency_code: 'AUD', filename: 'free.csv' }).catch(() => '');
    const free = qs ? await app(u3, `/api/financial-data-hub/bank-csv/upload?${qs}`, { method: 'POST', body: new Uint8Array(first.bytes), headers: { 'Content-Type': 'text/csv', 'Content-Length': String(first.bytes.length) } }) : { status: 0, json: null };
    check('M.22 a Free user is refused at upload (Premium upload entitlement preserved)', free.status === 403, JSON.stringify({ status: free.status, error: free.json?.error }));
    const freeRemap = await app(u3, `/api/financial-data-hub/bank-csv/${w.docId}/remap`, { method: 'POST' });
    check('M.23 a Free user cannot remap (refused, and it is not another user\'s statement to reveal)', freeRemap.status === 403 || freeRemap.status === 404, `status ${freeRemap.status}`);

    evidence.counts = { first: N, longerAdded: txC.length, remapped: wtx.length, bankAustralia: txE.length };
  } finally {
    await cleanup();
    evidence.cleanedUsers = created.length;
    fs.writeFileSync(`${SCRATCH}/bank_csv_mapping_${LABEL}.json`, JSON.stringify(evidence, null, 2));
    summary();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
