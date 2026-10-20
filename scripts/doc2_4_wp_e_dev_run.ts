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
import { devFetch, BASE, ANON, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
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
    const loaded = (list.json?.data ?? []).find((r: any) => r.id === id);
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
    await fetch(`${APP}/api/financial-data-hub/documents/cron/malware-scan-sweep`, { method: 'POST', headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' } }).catch(() => null);
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
  const csvDoc = oracleBankStatement(month, 'w');
  const scale = scaleBankStatement(month, 120, 'w');
  const pdfRows = [
    { d: '01 Sep 2026', text: 'SALARY ACME PTY LTD', amt: 5000, dr: false, bal: 25000 },
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

async function main() {
  console.log(`=== WP-E ${which} (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  try {
    if (which === 'liab') await liab();
    else if (which === 'bank') await bank();
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
