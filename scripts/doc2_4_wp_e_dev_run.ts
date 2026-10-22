/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * Document2 (4) WP-E DEV verification: F24 (personal liability edit) and F15 (Expenses bank-statement import).
 * Label for everything it proves: DEV-verified (project vqycarelcoijzwlpkpcz ONLY). Never PRODUCTION-VERIFIED.
 *
 * SAFETY
 *   - DEV only: every Supabase request asserts the DEV host; PRODUCTION_* values are never loaded.
 *   - NO password anywhere: PASSWORDLESS synthetic users (@fhip-test.invalid), sessions minted with admin generate_link + verify,
 *     deleted in `finally`.
 *   - Prints no secret and no document text. Ids are shown as 8 character prefixes.
 *
 * Run (server first, in another terminal):  node scripts/pdf_routes_dev_server.mjs 3947
 *   npx tsx scripts/doc2_4_wp_e_dev_run.ts http://localhost:3947 liab|bank [label]
 */
import fs from 'node:fs';
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';
import { oracleBankStatement, scaleBankStatement } from './canonical_cert/documents/builders';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

const APP = process.argv[2] ?? 'http://localhost:3947';
const which = process.argv[3] ?? 'liab';
const LABEL = process.argv[4] ?? 'run';
const { check, summary } = makeChecker(`WP-E-${which}-${LABEL}`);
const RUN = `wpe-${Date.now()}`;
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

// ============================================================================ F24 liabilities
async function liab() {
  const u = await makeUser('L1', `wpe-l1-${Date.now()}@fhip-test.invalid`);
  const base = (over: Record<string, unknown>) => ({
    owner: 'self', currency_code: 'AUD', liability_name: 'WPE loan', balance: 10000, lender: 'Test Bank',
    interest_rate: 6.1, interest_rate_type: 'variable', country_code: 'AU', ...over,
  });
  const cases: Array<{ name: string; debt_type?: string; owner: string; extra?: Record<string, unknown> }> = [];
  for (const owner of ['self', 'spouse', 'joint']) {
    cases.push({ name: `personal_loan ${owner}`, owner, debt_type: 'personal_loan' });
    cases.push({ name: `mortgage ${owner}`, owner, debt_type: 'mortgage' });
    cases.push({ name: `offset/line_of_credit ${owner}`, owner, debt_type: 'line_of_credit' });
    cases.push({ name: `credit_card ${owner}`, owner, debt_type: 'credit_card', extra: { credit_limit: 15000 } });
  }
  const out: any[] = [];
  for (const c of cases) {
    const create = await app(u, '/api/liabilities', { method: 'POST', json: base({ owner: c.owner, debt_type: c.debt_type, liability_name: `WPE ${c.name}`, ...(c.extra ?? {}) }) });
    const id = create.json?.data?.id as string | undefined;
    // Reload exactly as the page does, then edit the reloaded row with the body the grid sends (nulls omitted).
    const list = await app(u, '/api/liabilities');
    const loaded = (list.json?.data?.transactions ?? []).find((r: any) => r.id === id);
    const patchBody = loaded ? Object.fromEntries(Object.entries({
      owner: loaded.owner, currency_code: loaded.currency_code, liability_name: loaded.liability_name, balance: Number(loaded.balance) + 123,
      lender: loaded.lender, interest_rate: loaded.interest_rate == null ? null : Number(loaded.interest_rate), interest_rate_type: loaded.interest_rate_type,
      country_code: loaded.country_code, masked_identifier: loaded.masked_identifier, notes: loaded.notes, monthly_repayment: loaded.monthly_repayment, minimum_payment: loaded.minimum_payment,
    }).filter(([, v]) => v != null && v !== '')) : null;
    const patch = id && patchBody ? await app(u, `/api/liabilities/${id}`, { method: 'PATCH', json: patchBody }) : null;
    const after = (await app(u, '/api/liabilities')).json?.data?.find((r: any) => r.id === id);
    const ok = create.status === 200 && patch?.status === 200 && Number(after?.balance) === 10123 && after?.owner === c.owner;
    out.push({ c: c.name, create: create.status, patch: patch?.status, owner: after?.owner, bal: after?.balance });
    check(`F24.A ${c.name}: create, reload, edit (balance +123) saves and reads back with the same owner`, ok, JSON.stringify({ create: create.status, patch: patch?.status, err: patch?.json?.error ?? create.json?.error }));
  }
  evidence.matrix = out;

  // The PO's exact case: a long number typed into "Card / Account Number (masked)".
  const tooLong = '3000017434';
  const pc = await app(u, '/api/liabilities', { method: 'POST', json: base({ owner: 'joint', debt_type: 'line_of_credit', liability_name: 'WPE offset long number', masked_identifier: tooLong }) });
  evidence.longNumberCreate = { status: pc.status, error: pc.json?.error, fields: pc.json?.fields };
  check('F24.B a 10-digit number typed into the masked field is refused with a plain, field-named, actionable message (not a database constraint name) on create', pc.status === 422 && !/chk_|violates|relation/.test(JSON.stringify(pc.json)) && /last 4|last four/i.test(JSON.stringify(pc.json)), JSON.stringify({ status: pc.status, body: pc.json }));
  const okRow = await app(u, '/api/liabilities', { method: 'POST', json: base({ owner: 'self', debt_type: 'personal_loan', liability_name: 'WPE masked ok', masked_identifier: '****7434' }) });
  const okId = okRow.json?.data?.id;
  const pe = okId ? await app(u, `/api/liabilities/${okId}`, { method: 'PATCH', json: { masked_identifier: '300017434' } }) : null;
  evidence.longNumberPatch = { status: pe?.status, error: pe?.json?.error, fields: pe?.json?.fields };
  check('F24.C the same long number on EDIT of an existing liability is refused the same plain way, and the stored value is untouched', pe?.status === 422 && !/chk_|violates|relation/.test(JSON.stringify(pe?.json)) && (await app(u, '/api/liabilities')).json?.data?.find((r: any) => r.id === okId)?.masked_identifier === '****7434', JSON.stringify({ status: pe?.status, body: pe?.json }));
  const four = okId ? await app(u, `/api/liabilities/${okId}`, { method: 'PATCH', json: { masked_identifier: '7434' } }) : null;
  check('F24.D four or six digits are accepted (a masked tail is what the field is for)', four?.status === 200, `status ${four?.status} ${four?.json?.error ?? ''}`);
  // The reverse direction: an old-style row that already carries an acceptable value still edits.
  const owners = await app(u, '/api/liabilities', { method: 'POST', json: base({ owner: 'bogus_owner', debt_type: 'personal_loan' }) });
  evidence.bogusOwner = { status: owners.status, error: owners.json?.error, fields: owners.json?.fields };
  check('F24.E an owner outside the catalogue is refused (not silently saved)', owners.status === 422, `status ${owners.status}`);
}

// ============================================================================ F15 bank import
const bankPdfLines = (rowsIn: Array<{ d: string; text: string; amt: number; dr: boolean; bal: number }>) => [
  'Commonwealth Bank of Australia',
  'Statement of Account',
  'Account Number: ****4321',
  'Statement period 01 Sep 2026 to 30 Sep 2026',
  'Opening Balance: $20,000.00',
  `Closing Balance: $${rowsIn[rowsIn.length - 1].bal.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`,
  'Date Transaction Details Debit Credit Balance',
  ...rowsIn.map((r) => `${r.d}  ${r.text}   ${r.amt.toFixed(2)} ${r.dr ? 'DR' : 'CR'}   ${r.bal.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`),
  'Page 1 of 1',
];

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

async function bankJourney(u: U, tag: string, file: { name: string; csv: boolean; bytes: Uint8Array }) {
  const j: any = { tag, file: file.name, steps: [] };
  const step = (name: string, r: { status: number; ms: number; json: any }, extra: any = {}) => { j.steps.push({ name, status: r.status, ms: r.ms, error: r.json?.error ?? null, ...extra }); };
  const qs = await ownerQuery(u, { country_code: 'AU', currency_code: 'AUD', filename: file.name, statement_period_start: '2026-09-01', statement_period_end: '2026-09-30' });
  const up = await app(u, `/api/financial-data-hub/${file.csv ? 'bank-csv' : 'bank-pdf'}/upload?${qs}`, { method: 'POST', body: new Uint8Array(file.bytes), headers: { 'Content-Type': file.csv ? 'text/csv' : 'application/pdf', 'Content-Length': String(file.bytes.length) } });
  const docId = up.json?.data?.document_id as string | undefined;
  step('upload', up, { account_resolution: up.json?.data?.account_resolution, error_code: up.json?.data?.error_code, processing_status: up.json?.data?.processing_status });
  if (!docId) return j;
  recordArtefact({ kind: 'fdh_statement_uploads', id: docId, userId: u.id, run: RUN });
  j.docId = docId.slice(0, 8);
  const scan = await waitScan(docId);
  j.scanWaitMs = scan.waitMs;
  j.afterScan = { malware: scan.doc?.malware_scan_status, processing: scan.doc?.processing_status, error_code: scan.doc?.error_code, account: scan.doc?.financial_account_id ? 'set' : null };
  // Account resolution when the upload could not settle it (the panel's choose-account step).
  if (up.json?.data?.account_resolution === 'ambiguous') {
    j.ambiguous = true;
  }
  if (file.csv) {
    const det = await app(u, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
    step('detect', det, { detected: det.json?.data?.adapter_id ?? det.json?.data?.detected_adapter_id ?? null });
  }
  const proc = await app(u, `/api/financial-data-hub/${file.csv ? 'bank-csv' : 'bank-pdf'}/${docId}/process`, { method: 'POST', ...(file.csv ? {} : { json: {} }) });
  step('process', proc, { message: proc.json?.message ?? null, tx: proc.json?.data?.transactions_created, dup: proc.json?.data?.duplicates_skipped, recon: proc.json?.data?.reconciliation_status, pipeline: proc.json?.data?.pipeline_status, error_code: proc.json?.data?.error_code });
  j.doc = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0] ? ((d) => ({ processing: d.processing_status, cert: d.certification_status, error_code: d.error_code, parsed: d.parsed_row_count, declared: d.declared_row_count, account: d.financial_account_id ? 'set' : null }))((await rows('fdh_statement_uploads', `id=eq.${docId}`))[0]) : null;
  return j;
}

async function bank() {
  const u = await makeUser('B1', `wpe-b1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  evidence.journeys = [];
  const month = { year: 2026, month: 9 };
  const salt = String(Date.now() % 100000); // a fresh file every run, so a re-run is never a byte-identical duplicate
  const csvDoc = oracleBankStatement(month, salt);
  const scale = scaleBankStatement(month, 120, salt);
  const pdfRows = [
    { d: '01 Sep 2026', text: `SALARY ACME PTY LTD ${salt}`, amt: 5000, dr: false, bal: 25000 },
    { d: '03 Sep 2026', text: 'CARD PURCHASE WOOLWORTHS 1234', amt: 200, dr: true, bal: 24800 },
    { d: '10 Sep 2026', text: 'NETFLIX SUBSCRIPTION', amt: 15.99, dr: true, bal: 24784.01 },
  ];
  const pdf = buildMinimalTextPdf([bankPdfLines(pdfRows)]);
  const files = [
    { name: `${RUN}-oracle.csv`, csv: true, bytes: csvDoc.bytes },
    { name: `${RUN}-scale120.csv`, csv: true, bytes: scale.bytes },
    { name: `${RUN}-cba.pdf`, csv: false, bytes: new Uint8Array(pdf) },
  ];
  for (const f of files) {
    const j = await bankJourney(u, f.name, f);
    evidence.journeys.push(j);
    console.log(JSON.stringify(j));
    const proc = j.steps.find((s: any) => s.name === 'process');
    check(`F15.A ${f.name}: upload -> scan -> process completes without a server error`, !!proc && proc.status === 200 && !proc.error_code, JSON.stringify({ proc, afterScan: j.afterScan, doc: j.doc }));
  }
  const tx = await rows('fdh_transactions', `user_id=eq.${u.id}`, 'id');
  evidence.transactionsTotal = tx.length;
}

// PostgREST caps a plain read at 1000 rows: page through, so a count of a 3000 row statement is a real count.
async function allRows(table: string, filter: string, select = '*') {
  const out: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rows(table, `${filter}&order=id.asc&limit=1000&offset=${offset}`, select);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// Timing and scale: the PO's real statements are long (a year of lines). Same real routes, bigger files; per-step wall time is the evidence.
async function bankscale() {
  const u = await makeUser('S1', `wpe-s1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  evidence.journeys = [];
  const month = { year: 2026, month: 9 };
  const salt = String(Date.now() % 100000);
  const sizes = (process.argv[5] ?? '400,1500').split(',').map(Number);
  const files: Array<{ name: string; csv: boolean; bytes: Uint8Array }> = [];
  for (const n of sizes) files.push({ name: `${RUN}-scale${n}.csv`, csv: true, bytes: scaleBankStatement(month, n, salt).bytes });
  for (const n of sizes.filter((x) => x <= 400)) {
    let bal = 20000;
    const r: Array<{ d: string; text: string; amt: number; dr: boolean; bal: number }> = [];
    for (let i = 0; i < n; i++) {
      const dr = i % 9 !== 0;
      const amt = 10 + ((i * 7919) % 900) + 0.35;
      bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
      r.push({ d: `${String(1 + (i % 28)).padStart(2, '0')} Sep 2026`, text: `MERCHANT ${i + 1} ${salt}`, amt, dr, bal });
    }
    const lines = bankPdfLines(r);
    const pages: string[][] = [];
    for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
    files.push({ name: `${RUN}-cba${n}.pdf`, csv: false, bytes: new Uint8Array(buildMinimalTextPdf(pages)) });
  }
  for (const f of files) {
    const j = await bankJourney(u, f.name, f);
    evidence.journeys.push(j);
    console.log(JSON.stringify({ file: f.name, bytes: f.bytes.length, steps: j.steps.map((s: any) => ({ n: s.name, st: s.status, ms: s.ms, e: s.error, tx: s.tx, pipe: s.pipeline, ec: s.error_code })), doc: j.doc }));
    const proc = j.steps.find((s: any) => s.name === 'process');
    check(`F15.S ${f.name}: every step answers under the 28 s platform limit and process succeeds`, !!proc && proc.status === 200 && j.steps.every((s: any) => s.ms < 28000), JSON.stringify(j.steps.map((s: any) => [s.name, s.status, s.ms])));
  }
}

// A real bank PDF is usually NOT one of the four certified layouts, so the file falls to the AI reading inside the same request.
// This mode times exactly that, with a statement of realistic length in an unrecognised layout. The server must be started with
// AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED=true (the production switch for this reading).
async function bankai() {
  const u = await makeUser('A1', `wpe-a1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  evidence.journeys = [];
  const sizes = (process.argv[5] ?? '25,120').split(',').map(Number);
  for (const n of sizes) {
    const salt = String(Date.now() % 100000);
    let bal = 20000;
    const lines = ['EXAMPLE CREDIT UNION', 'Everyday account statement', 'Account ending 4321', 'Period: 01/09/2026 to 30/09/2026', 'Opening balance 20,000.00', 'Date | Details | Withdrawals | Deposits | Balance'];
    for (let i = 0; i < n; i++) {
      const dr = i % 7 !== 0;
      const amt = Math.round((10 + ((i * 7919) % 900) + 0.35) * 100) / 100;
      bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
      lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1} ${salt} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
    }
    lines.push(`Closing balance ${bal.toFixed(2)}`);
    const pages: string[][] = [];
    for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
    const f = { name: `${RUN}-ai${n}.pdf`, csv: false, bytes: new Uint8Array(buildMinimalTextPdf(pages)) };
    const j = await bankJourney(u, f.name, f);
    evidence.journeys.push(j);
    console.log(JSON.stringify({ file: f.name, lines: n, steps: j.steps.map((s: any) => ({ n: s.name, st: s.status, ms: s.ms, e: s.error, pipe: s.pipeline, ec: s.error_code })), doc: j.doc }));
    const proc = j.steps.find((s: any) => s.name === 'process');
    check(`F15.AI ${n}-line unrecognised-layout PDF: process answers under the 28 s platform limit`, !!proc && proc.ms < 28000, JSON.stringify(j.steps.map((s: any) => [s.name, s.status, s.ms, s.pipeline])));
  }
}

// A platform timeout (28 s on the hosting platform) KILLS the request mid-run; the handler gets no chance to mark the document failed.
// Emulated faithfully: the server's whole process tree is killed once the first chunk of transactions is committed, a fresh server is
// started (the platform brings a fresh instance up) and the user's retry is made against it.
async function killresume() {
  const { spawn, execSync } = await import('node:child_process');
  const u = await makeUser('K1', `wpe-k1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  const month = { year: 2026, month: 9 };
  const N = Number(process.argv[5] ?? 3000);
  const file = { name: `${RUN}-kill${N}.csv`, csv: true, bytes: scaleBankStatement(month, N, String(Date.now() % 100000)).bytes };
  const qs = await ownerQuery(u, { country_code: 'AU', currency_code: 'AUD', filename: file.name, statement_period_start: '2026-09-01', statement_period_end: '2026-09-30' });
  const up = await app(u, `/api/financial-data-hub/bank-csv/upload?${qs}`, { method: 'POST', body: new Uint8Array(file.bytes), headers: { 'Content-Type': 'text/csv', 'Content-Length': String(file.bytes.length) } });
  const docId = up.json?.data?.document_id as string;
  recordArtefact({ kind: 'fdh_statement_uploads', id: docId, userId: u.id, run: RUN });
  await waitScan(docId);
  const det = await app(u, `/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
  check('F15.K0 setup: uploaded, scanned, detected', up.status === 200 && det.status === 200, JSON.stringify({ up: up.status, det: det.status }));

  const port = new URL(APP).port;
  const kill = (pid: number | undefined) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ } };
  const stopPort = () => { try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }"`, { stdio: 'ignore' }); } catch { /* none */ } };
  const startServer = async () => {
    const child = spawn('node', ['scripts/pdf_routes_dev_server.mjs', port], { stdio: 'ignore', shell: false });
    for (let i = 0; i < 120; i++) { if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 200) break; await sleep(2000); }
    return child;
  };
  const zero = '00000000-0000-0000-0000-000000000000';
  const warm = async (cookie: string) => { await fetch(`${APP}/api/financial-data-hub/bank-csv/${zero}/process`, { method: 'POST', headers: { Cookie: cookie } }).catch(() => null); };
  stopPort();
  await sleep(2000);
  const srv = await startServer(); // a server this script owns, so it can be killed
  try {
    await warm(u.cookie);
    const inflight = fetch(`${APP}/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST', headers: { Cookie: u.cookie } }).then((r) => r.status).catch(() => 'connection-lost');
    let partial = 0;
    for (let i = 0; i < 600; i++) {
      await sleep(60);
      partial = (await rows('fdh_transactions', `statement_upload_id=eq.${docId}`, 'id')).length;
      if (partial > 0) break;
    }
    kill(srv.pid);
    stopPort();
    evidence.killedAfterPartialRows = partial;
    evidence.inflightResult = await Promise.race([inflight, sleep(8000).then(() => 'still-open')]);
  } finally {
    kill(srv.pid);
    stopPort();
  }
  await sleep(2000);
  const srv2 = await startServer(); // the platform brings a fresh instance up
  try {
    await warm(u.cookie);
    const stuck = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
    const txMid = (await allRows('fdh_transactions', `statement_upload_id=eq.${docId}`, 'id')).length;
    evidence.afterKill = { processing: stuck?.processing_status, cert: stuck?.certification_status, tx: txMid, expected: N };
    console.log('AFTER KILL', JSON.stringify(evidence.afterKill));
    check('F15.K1 the kill really interrupted the run (document not finished, some but not all rows written)', stuck?.processing_status === 'processing' && txMid > 0 && txMid < N, JSON.stringify(evidence.afterKill));

    // Retry 1, right away: the run is not yet old enough to be called dead -> a plain "still being read" (fixed code) / a re-run on the debris (old code).
    const rNow = await app(u, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
    evidence.retryImmediately = { status: rNow.status, error: rNow.json?.error, created: rNow.json?.data?.transactions_created };
    console.log('RETRY-NOW', JSON.stringify(evidence.retryImmediately));
    // Minutes later (simulated by moving the run's start back 5 minutes, service role, synthetic row only).
    const cur = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
    if (cur?.processing_status === 'processing') await devFetch(`/rest/v1/fdh_statement_uploads?id=eq.${docId}&user_id=eq.${u.id}`, { method: 'PATCH', body: { processing_started_at: new Date(Date.now() - 300_000).toISOString() } });
    const r1 = await app(u, `/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' });
    const d1 = (await rows('fdh_statement_uploads', `id=eq.${docId}`))[0];
    const tx1 = await allRows('fdh_transactions', `statement_upload_id=eq.${docId}`, 'id,source_row,economic_fingerprint,dedup_status');
    const dupRows = tx1.length - new Set(tx1.map((t: any) => t.source_row)).size;
    evidence.retryLater = {
      status: r1.status, error: r1.json?.error, created: r1.json?.data?.transactions_created, skippedDup: r1.json?.data?.duplicates_skipped,
      processing: d1?.processing_status, cert: d1?.certification_status, certifiedRows: d1?.certified_row_count, duplicateRows: d1?.duplicate_row_count, parsed: d1?.parsed_row_count,
      recon: d1?.reconciliation_status, txTotal: tx1.length, duplicateSourceRows: dupRows,
      dedupStatuses: tx1.reduce((a: any, t: any) => { a[t.dedup_status] = (a[t.dedup_status] ?? 0) + 1; return a; }, {}),
    };
    console.log('RETRY-LATER', JSON.stringify(evidence.retryLater));
    check(`F15.K2 after an interrupted run, asking again finishes the statement with exactly ${N} transactions, none twice, none reported as skipped duplicates`,
      r1.status === 200 && tx1.length === N && dupRows === 0 && Number(d1?.duplicate_row_count ?? 0) === 0 && d1?.processing_status !== 'processing', JSON.stringify(evidence.retryLater));

    // The panel's "Try again" is a fresh upload of the same file: nothing is added a second time.
    const up2 = await app(u, `/api/financial-data-hub/bank-csv/upload?${qs}`, { method: 'POST', body: new Uint8Array(file.bytes), headers: { 'Content-Type': 'text/csv', 'Content-Length': String(file.bytes.length) } });
    const doc2 = up2.json?.data?.document_id as string | undefined;
    const allTx = (await allRows('fdh_transactions', `user_id=eq.${u.id}`, 'id')).length;
    evidence.reupload = { status: up2.status, duplicate_of: up2.json?.data?.duplicate_of_document_id ?? null, sameDoc: doc2 === docId, txForUser: allTx };
    check('F15.K3 re-uploading the same file afterwards creates no second set of transactions', allTx === N, JSON.stringify(evidence.reupload));
  } finally {
    kill(srv2.pid);
    stopPort();
  }
}

// Upload -> Analyse -> Review -> Accept -> Apply for Expenses: approval is the terminal state of this domain (the panel's own header), and
// an approved transaction is read by the Expenses tab straight from the transaction layer. Proves the lines appear once, and that a variant
// of the same file, an overlapping statement and a byte-identical re-upload add nothing twice.
async function applyFlow() {
  const u = await makeUser('P1', `wpe-p1-${Date.now()}@fhip-test.invalid`);
  await setPlan(u, 'premium');
  const month = { year: 2026, month: 9 };
  const salt = String(Date.now() % 100000);
  const base = oracleBankStatement(month, salt);
  const text = Buffer.from(base.bytes).toString('utf8');
  const lines = text.trim().split('\n');
  const actuals = async () => {
    const r = await app(u, '/api/expenses/actuals?page=1&pageSize=500');
    const d = r.json?.data;
    return { status: r.status, lineCount: d?.lineCount, actualTotal: d?.totals?.actualTotalInWindow, unknownPending: d?.unknownPendingCount, excludedDuplicates: d?.excludedDuplicates, keys: (d?.lines ?? []).map((l: any) => `${l.date}|${l.description}|${l.amount}`) };
  };
  // Review -> Accept: the user gives each pending line a category (the review workspace's own routes), then approves them.
  const cats = (await rows('fdh_categories', 'active=eq.true', 'id,category_key,economic_type')) as Array<{ id: string; category_key: string; economic_type: string }>;
  const expenseCat = cats.find((c) => /grocer|food/i.test(c.category_key) && c.economic_type === 'expense') ?? cats.find((c) => c.economic_type === 'expense');
  const incomeCat = cats.find((c) => c.economic_type === 'income');
  const review = async () => {
    const list = await app(u, '/api/financial-data-hub/bank-transactions?limit=500');
    const pending = (list.json?.data?.transactions ?? []).filter((t: any) => t.economic_transaction_type === 'unknown' || t.review_status === 'pending');
    let set = 0;
    for (const t of pending) {
      const cat = t.credit_debit === 'credit' ? incomeCat : expenseCat;
      if (!cat) continue;
      const r = await app(u, `/api/financial-data-hub/bank-transactions/${t.id}/set-category`, { method: 'POST', json: { category_id: cat.id } });
      if (r.status === 200) set += 1;
    }
    const ids = (await app(u, '/api/financial-data-hub/bank-transactions?limit=500')).json?.data?.transactions?.map((t: any) => t.id) ?? [];
    const ap = ids.length ? await app(u, '/api/financial-data-hub/bank-transactions/bulk-approve', { method: 'POST', json: { transaction_ids: ids } }) : null;
    return { pending: pending.length, categorised: set, approveStatus: ap?.status ?? null };
  };
  const run = async (name: string, bytes: Uint8Array) => {
    const j = await bankJourney(u, name, { name, csv: true, bytes });
    await app(u, '/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
    j.review = await review();
    return j;
  };
  const j1 = await run(`${RUN}-sep.csv`, base.bytes);
  const p1 = j1.steps.find((s: any) => s.name === 'process');
  const a1 = await actuals();
  evidence.apply = { first: { process: p1, doc: j1.doc, actuals: { ...a1, keys: a1.keys.length } } };
  console.log('FIRST', JSON.stringify({ ...evidence.apply.first, review: j1.review }));
  check('F15.P1 Upload -> Analyse -> approved: 10 transactions created, certified, reconciled', p1?.status === 200 && p1?.tx === 10 && j1.doc?.processing === 'approved' && p1?.recon === 'reconciled', JSON.stringify(p1));
  check('F15.P2 the Expenses tab reads the approved lines once (each line once, none duplicated)', a1.status === 200 && a1.lineCount > 0 && new Set(a1.keys).size === a1.keys.length, JSON.stringify({ lineCount: a1.lineCount, distinct: new Set(a1.keys).size, actualTotal: a1.actualTotal }));

  // A variant of the same statement (different bytes: Windows line endings and a trailing blank line).
  const variant = Buffer.from(text.replace(/\n/g, '\r\n') + '\r\n', 'utf8');
  const j2 = await run(`${RUN}-sep-variant.csv`, new Uint8Array(variant));
  const p2 = j2.steps.find((s: any) => s.name === 'process');
  const a2 = await actuals();
  evidence.apply.variant = { process: p2, doc: j2.doc, actuals: { ...a2, keys: a2.keys.length } };
  console.log('VARIANT', JSON.stringify(evidence.apply.variant));
  check('F15.P3 the same statement in a different file adds no second set of expenses', a2.lineCount === a1.lineCount && a2.actualTotal === a1.actualTotal && (p2?.tx ?? 0) === 0, JSON.stringify({ created: p2?.tx, skipped: p2?.dup, lineCount: [a1.lineCount, a2.lineCount], total: [a1.actualTotal, a2.actualTotal] }));

  // An overlapping statement: the last 5 rows again plus 3 new ones.
  const header = lines[0];
  const tail = lines.slice(6);
  const lastBal = Number(lines[lines.length - 1].split(',').pop());
  const extra = [
    `${lines[lines.length - 1].split(',')[0]},NEW COFFEE ${salt},-4.50,${(lastBal - 4.5).toFixed(2)}`,
    `${lines[lines.length - 1].split(',')[0]},NEW BOOKS ${salt},-30.00,${(lastBal - 34.5).toFixed(2)}`,
    `${lines[lines.length - 1].split(',')[0]},NEW TAXI ${salt},-12.00,${(lastBal - 46.5).toFixed(2)}`,
  ];
  const overlap = Buffer.from([header, ...tail, ...extra].join('\n') + '\n', 'utf8');
  const j3 = await run(`${RUN}-sep-overlap.csv`, new Uint8Array(overlap));
  const p3 = j3.steps.find((s: any) => s.name === 'process');
  const a3 = await actuals();
  evidence.apply.overlap = { process: p3, doc: j3.doc, actuals: { ...a3, keys: a3.keys.length } };
  console.log('OVERLAP', JSON.stringify(evidence.apply.overlap));
  check('F15.P4 an overlapping statement adds only its 3 new lines (overlap read as already imported, not as new spending)', (p3?.tx ?? -1) === 3 && a3.lineCount === a1.lineCount + 3 && new Set(a3.keys).size === a3.keys.length, JSON.stringify({ created: p3?.tx, skipped: p3?.dup, lineCount: [a1.lineCount, a3.lineCount], distinctKeys: new Set(a3.keys).size === a3.keys.length, doc: j3.doc }));

  // A byte-identical re-upload.
  const j4 = await run(`${RUN}-sep-same.csv`, base.bytes);
  const p4 = j4.steps.find((s: any) => s.name === 'process');
  const a4 = await actuals();
  evidence.apply.identical = { process: p4, actuals: { ...a4, keys: a4.keys.length } };
  console.log('IDENTICAL', JSON.stringify(evidence.apply.identical));
  check('F15.P5 a byte-identical re-upload adds nothing', a4.lineCount === a3.lineCount && a4.actualTotal === a3.actualTotal, JSON.stringify({ lineCount: [a3.lineCount, a4.lineCount], total: [a3.actualTotal, a4.actualTotal] }));
}

async function main() {
  console.log(`=== WP-E ${which} (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  try {
    if (which === 'liab') await liab();
    else if (which === 'bank') await bank();
    else if (which === 'bankscale') await bankscale();
    else if (which === 'killresume') await killresume();
    else if (which === 'bankai') await bankai();
    else if (which === 'applyflow') await applyFlow();
  } finally {
    await cleanup();
    evidence.cleanedUsers = created.length;
    const residue = await Promise.all(created.map(async (u) => (await rows('liabilities', `user_id=eq.${u.id}`, 'id')).length));
    evidence.residueAfterCleanup = residue;
    fs.writeFileSync(`${SCRATCH}/wpe_${which}_${LABEL}.json`, JSON.stringify(evidence, null, 2));
    summary();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
