/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * DEV-ONLY rehearsal of the PRODUCTION proof protocol (docs/ai/po_apply_premium_ai_production_proof/), run against a local
 * `next dev` of this branch wired to the DEV Supabase project, the DEV S3 + GuardDuty plan and the real gpt-4o-mini.
 *
 * It exists so that the Product Owner's production run is not the first time the synthetic documents, the expected-value sheet and
 * the evidence queries meet a real scanner and a real model. Label for everything it proves: DEV-verified, never PRODUCTION-VERIFIED.
 *
 * SAFETY
 *   - DEV only: every request asserts the DEV host; PRODUCTION_* values are never loaded; it refuses any other project.
 *   - NO password anywhere: it creates PASSWORDLESS synthetic users (e-mail on the reserved @fhip-test.invalid domain) and mints their
 *     sessions with admin generate_link + verify. It deletes them in `finally` and re-counts the rows they leave behind.
 *   - It prints no secret, no document text and no e-mail address beyond the synthetic labels. Ids are shown as 8 character prefixes.
 *   - The shared DEV cost ledger is changed TWICE on purpose (a tiny per-user cap, a tiny global ceiling) to prove the two limits refuse
 *     BEFORE the provider with no real spend; both values are restored in `finally` and re-read.
 *   - Real provider spend: the documents are read by gpt-4o-mini a handful of times (about US$0.0004 each).
 *
 * Run (server first, in another terminal; it lists the RETIRED pilot variables on purpose so the run proves they change nothing):
 *   node scripts/aie1_final_dev_server.mjs 3991
 *   npx tsx scripts/ai_production_proof_dev_journey.ts http://localhost:3991 [journey ...]
 * Journeys: bank refuse limits pdfless   (default: all)
 */
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';
import {
  PROOF_DOCUMENTS, BANK_B1_EXPECTED, BANK_B2_EXPECTED, BANK_B3_EXPECTED, BANK_B3_VARIANCE, PAYSLIP_P1_EXPECTED,
  type ExpectedBankStatement,
} from './ai_production_proof_documents';
import fs from 'node:fs';

const APP = process.argv[2] ?? 'http://localhost:3991';
const selected = new Set(process.argv.slice(3));
const want = (j: string) => selected.size === 0 || selected.has(j);
const { check, summary } = makeChecker('PROOF-DEV');
const RUN = `proofdev-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;
const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const evidence: Record<string, any> = { run: RUN, app: APP, startedAt: new Date().toISOString() };
const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad';

interface U { id: string; email: string; cookie: string; label: string }
const created: U[] = [];
const doc = (id: string) => PROOF_DOCUMENTS.find((d) => d.id === id)!;

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

async function setPlan(u: U, plan: 'free' | 'premium' | 'expired') {
  const body = plan === 'free' ? { plan_tier: 'free', effective_from: day(-1), effective_to: null }
    : plan === 'premium' ? { plan_tier: 'premium', effective_from: day(-30), effective_to: day(30) }
      : { plan_tier: 'premium', effective_from: day(-60), effective_to: day(-1) };
  const r = await devFetch(`/rest/v1/user_entitlements?user_id=eq.${u.id}`, { method: 'PATCH', prefer: 'return=representation', body });
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new Error(`entitlement ${u.label}: ${r.status} ${r.text.slice(0, 100)}`);
}

async function app(u: U | null, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(u ? { Cookie: u.cookie } : {}), ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${APP}${p}`, { method: init.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const cron = async (p: string) => (await fetch(`${APP}${p}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } })).status;
async function rows(table: string, filter: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?${filter}&select=${select}`);
  return (Array.isArray(r.json) ? r.json : []) as any[];
}
const row = async (table: string, id: string, select = '*') => (await rows(table, `id=eq.${id}`, select))[0] ?? null;
const ledger = async () => (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0];
const audits = (documentId: string) => rows('fdh_document_audit_events', `document_id=eq.${documentId}&order=created_at.asc`, 'event_type,metadata');
const drafts = (documentId: string) => rows('fdh_ai_fallback_drafts', `statement_upload_id=eq.${documentId}`, 'id,status,document_type,payload,provider_idempotency_key,confirmed_at');
const attemptsFor = (userId: string) => rows('aie_ai_cost_attempt', `user_id=eq.${userId}`, 'idempotency_key,admission_outcome,reserved_usd,settled_usd,model,input_tokens,output_tokens,call_outcome,provider_request_ids');

async function ownerQuery(u: U, flow: string, extra: Record<string, string>): Promise<string> {
  const owner = await resolveSyntheticOwner(fetchOwnerRequest(APP, u.cookie), 'self', flow);
  return new URLSearchParams({ ...extra, owner: JSON.stringify(owner) }).toString();
}

async function uploadBank(u: U, d: ReturnType<typeof doc>, tag: string) {
  const bytes = d.build();
  const qs = await ownerQuery(u, 'bank', { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-${tag}.pdf` });
  const r = await app(u, `/api/financial-data-hub/bank-pdf/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
  const documentId = r.json?.data?.document_id as string | undefined;
  if (documentId) recordArtefact({ kind: 'fdh_statement_uploads', id: documentId, userId: u.id, run: RUN });
  let rowDoc = documentId ? await row('fdh_statement_uploads', documentId) : null;
  const t0 = Date.now();
  while (rowDoc && rowDoc.processing_status === 'validating' && Date.now() - t0 < 240_000) {
    await sleep(3000);
    await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep');
    rowDoc = await row('fdh_statement_uploads', documentId!);
  }
  return { upload: r, documentId: documentId!, doc: rowDoc, scanWaitMs: Date.now() - t0 };
}

const bankPanelBody = (d: any) => ({ rows: d.rows, statementPeriodStart: d.statementPeriodStart, statementPeriodEnd: d.statementPeriodEnd, declaredOpeningBalance: d.declaredOpeningBalance, declaredClosingBalance: d.declaredClosingBalance, maskedAccountIdentifier: d.maskedAccountIdentifier });

function draftMatches(draft: any, e: ExpectedBankStatement): [boolean, string] {
  if (!draft) return [false, 'no draft'];
  const rowsOk = draft.rows.length === e.rows.length && e.rows.every((x, i) => draft.rows[i]?.transactionDate === x.date && near(draft.rows[i]?.amountOriginal, x.amount) && draft.rows[i]?.creditDebit === x.direction && near(draft.rows[i]?.balanceAfter, x.balanceAfter));
  const ok = rowsOk && near(draft.declaredOpeningBalance, e.opening) && near(draft.declaredClosingBalance, e.printedClosing) && draft.statementPeriodStart === e.periodStart && draft.statementPeriodEnd === e.periodEnd;
  return [ok, JSON.stringify({ o: draft.declaredOpeningBalance, c: draft.declaredClosingBalance, ps: draft.statementPeriodStart, pe: draft.statementPeriodEnd, inst: draft.institutionName, listed: draft.allTransactionsListed, warnings: draft.warnings, rows: draft.rows.map((r: any) => `${r.transactionDate} ${r.creditDebit} ${r.amountOriginal} bal ${r.balanceAfter}`) })];
}

async function storageHas(ref: string | null): Promise<boolean> {
  if (!ref) return false;
  const dir = ref.slice(0, ref.lastIndexOf('/'));
  const name = ref.slice(ref.lastIndexOf('/') + 1);
  const list = await devFetch('/storage/v1/object/list/fdh-source-documents', { method: 'POST', body: { prefix: dir, search: name, limit: 10 } });
  return Array.isArray(list.json) && list.json.some((o: any) => o.name === name);
}

/** Time-shift the upload so the 50 minute hard backstop is due, then run the real purge sweep (the simulated clock is stated in every label). */
async function backstopPurge(documentId: string, userId: string) {
  await devFetch(`/rest/v1/fdh_statement_uploads?id=eq.${documentId}&user_id=eq.${userId}`, { method: 'PATCH', body: { uploaded_at: new Date(Date.now() - 3 * 3600_000).toISOString() } });
  await cron('/api/financial-data-hub/documents/cron/purge-sweep');
  await sleep(1500);
  await cron('/api/financial-data-hub/documents/cron/purge-sweep');
}

const cleanupLedger: { allowance?: number; cap?: number } = {};

async function main() {
  console.log(`=== PRODUCTION-PROOF REHEARSAL on DEV (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable: start scripts/aie1_final_dev_server.mjs first');
  const ledgerStart = await ledger();
  cleanupLedger.allowance = Number(ledgerStart.allowance_usd);
  cleanupLedger.cap = Number(ledgerStart.user_daily_cap_usd);
  evidence.ledgerStart = ledgerStart;

  const p1 = await makeUser('P1', `proof-p1-${Date.now()}@fhip-test.invalid`);
  const p2 = await makeUser('P2', `proof-p2-${Date.now()}@fhip-test.invalid`);
  // The server below lists this exact address on the RETIRED pilot variables (see aie1_final_dev_server.mjs): a "former pilot" account.
  const former = await makeUser('X1-former-pilot', 'aie1-final-pilot-b@fhip-test.invalid');
  const free = await makeUser('F1', `proof-f1-${Date.now()}@fhip-test.invalid`);
  await setPlan(p1, 'premium'); await setPlan(p2, 'premium'); await setPlan(former, 'premium'); await setPlan(free, 'free');
  evidence.users = Object.fromEntries(created.map((u) => [u.label, u.id.slice(0, 8)]));

  // ============================================================== Journey 1 (continuous bank PDF)
  if (want('bank')) {
    console.log('\n--- J1 bank PDF, P1 (Premium, never in the pilot): scan -> parser shortfall -> real gpt-4o-mini -> review -> deletion -> acceptance AFTER deletion -> canonical ---');
    const before = await ledger();
    const d = doc('DOC-B1');
    const up = await uploadBank(p1, d, 'b1');
    check('J1.1 Premium admitted through the normal upload route; the real GuardDuty scan is clean and bound to the uploaded object (expected version and ETag equal the stored object reference)',
      up.upload.status === 200 && up.doc?.malware_scan_status === 'clean' && up.doc?.processing_status === 'queued'
        && !!up.doc?.malware_scan_object_ref?.ref?.versionId && up.doc.malware_scan_object_ref.ref.versionId === up.doc.malware_scan_object_ref.expected?.expectedVersionId
        && up.doc.malware_scan_object_ref.ref.eTag === up.doc.malware_scan_object_ref.expected?.expectedETag && up.doc.malware_scan_object_ref.ref.objectKey === up.doc.malware_scan_object_ref.expected?.objectKey,
      JSON.stringify({ http: up.upload.status, scan: up.doc?.malware_scan_status, p: up.doc?.processing_status, waitMs: up.scanWaitMs, decidedAt: up.doc?.malware_scan_decided_at, s3Purge: up.doc?.malware_scan_object_ref?.s3Purge ?? null }));
    const t0 = Date.now();
    const proc = await app(p1, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const latencyMs = Date.now() - t0;
    const draft = proc.json?.data?.ai_fallback_draft;
    const trail = await audits(up.documentId);
    check('J1.2 the deterministic parser started and could not read it (unsupported layout), and the AI fallback produced a draft (nothing was disabled or broken)',
      proc.status === 200 && proc.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft && trail.some((a) => a.event_type === 'pdf_native_extraction_started') && trail.some((a) => a.event_type === 'bank_statement_ai_fallback_attempted'),
      `${proc.status} ${JSON.stringify({ pipeline: proc.json?.data?.pipeline_status, events: trail.map((a) => a.event_type) }).slice(0, 400)}`);
    const [dOk, dDetail] = draftMatches(draft, BANK_B1_EXPECTED);
    check('J1.3 the draft equals the hand-computed expected values (6 lines, balances, opening 3,215.40, closing 4,369.65, period)', dOk, dDetail);
    const ready = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_draft_ready');
    const dRows = await drafts(up.documentId);
    check('J1.4 the structured draft is durable (pending review) and linked to the metered call, before the person sees it', dRows.length === 1 && dRows[0].status === 'pending_review' && dRows[0].provider_idempotency_key === ready?.metadata?.ai_cost_key, JSON.stringify(dRows.map((x) => ({ s: x.status, t: x.document_type }))));
    const att = await attemptsFor(p1.id);
    const a0 = att.find((a) => a.idempotency_key === ready?.metadata?.ai_cost_key);
    const after = await ledger();
    check('J1.5 cost accounting: one metered attempt reserved then settled (> $0 and < $0.01), model gpt-4o-mini, request id + tokens recorded, reservation released, global ledger moved by exactly the settled amount',
      att.length === 1 && !!a0 && a0.model === 'gpt-4o-mini' && Number(a0.settled_usd) > 0 && Number(a0.settled_usd) < 0.01 && Number(a0.reserved_usd) >= Number(a0.settled_usd) && (a0.provider_request_ids ?? []).length >= 1 && Number(a0.input_tokens) > 0 && Number(a0.output_tokens) > 0
        && Number(after.reserved_usd) === Number(before.reserved_usd) && Math.abs(Number(after.settled_usd) - Number(before.settled_usd) - Number(a0.settled_usd)) < 0.000002 && Number(after.total_attempts) === Number(before.total_attempts) + 1,
      JSON.stringify({ attempts: att.length, settled: a0?.settled_usd, reserved: a0?.reserved_usd, tokens: [a0?.input_tokens, a0?.output_tokens], outcome: a0?.call_outcome, ledgerDelta: Number(after.settled_usd) - Number(before.settled_usd) }));
    const txMid = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    const docMid = await row('fdh_statement_uploads', up.documentId);
    check('J1.6 nothing canonical written before review: no transactions, document parked in processing; original still stored', txMid.length === 0 && docMid.processing_status === 'processing' && !!docMid.raw_document_storage_reference && await storageHas(docMid.raw_document_storage_reference), JSON.stringify({ tx: txMid.length, p: docMid.processing_status }));

    // replay BEFORE deletion: same draft, no second charge
    const again = await app(p1, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const midLedger = await ledger();
    check('J1.7 replay of /process returns the same pending draft and makes no second provider call or charge', again.json?.data?.pipeline_status === 'ai_fallback_available' && Number(midLedger.total_attempts) === Number(after.total_attempts) && Number(midLedger.settled_usd) === Number(after.settled_usd), JSON.stringify({ p: again.json?.data?.pipeline_status, attempts: [after.total_attempts, midLedger.total_attempts] }));
    const dup = await uploadBank(p1, d, 'b1-dup');
    const midLedger2 = await ledger();
    check('J1.8 re-uploading the identical file is recognised as a copy of the original upload (no new reading, no charge)',
      dup.upload.json?.data?.duplicate_of_document_id === up.documentId && Number(midLedger2.total_attempts) === Number(after.total_attempts), JSON.stringify({ dupOf: dup.upload.json?.data?.duplicate_of_document_id === up.documentId, attempts: midLedger2.total_attempts }));

    // cross-tenant
    const x1 = await app(p2, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const x2 = await app(p2, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    const x3 = await app(free, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    const stillPending = (await drafts(up.documentId))[0]?.status === 'pending_review';
    check('J1.9 cross-tenant: another Premium account (P2) and a Free account cannot process or confirm P1\'s document; the draft stays pending', [x1.status, x2.status, x3.status].every((s) => s >= 400 && s !== 500) && stillPending, JSON.stringify({ processByP2: x1.status, confirmByP2: x2.status, confirmByFree: x3.status }));

    // deletion BEFORE acceptance (the 50 minute hard backstop, clock time-shifted)
    await backstopPurge(up.documentId, p1.id);
    const docDel = await row('fdh_statement_uploads', up.documentId);
    const listed = await storageHas(up.doc?.raw_document_storage_reference ?? null);
    const dStill = (await drafts(up.documentId))[0];
    check('J1.10 [clock time-shifted by 3 h: the real purge sweep] the original PDF is purged and its absence independently verified (storage listing + purge status + scan-copy purge) while the structured draft is still pending',
      docDel.raw_document_purge_status === 'purged' && !docDel.raw_document_storage_reference && !listed && dStill?.status === 'pending_review' && docDel.processing_status !== 'rejected',
      JSON.stringify({ purge: docDel.raw_document_purge_status, processing: docDel.processing_status, listed, s3Purge: docDel.malware_scan_object_ref?.s3Purge ?? null, draft: dStill?.status }));
    const resumed = await app(p1, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    check('J1.11 after deletion the person can still reopen the reviewed draft (no file needed, no second charge)', resumed.json?.data?.pipeline_status === 'ai_fallback_available' && Number((await ledger()).total_attempts) === Number(after.total_attempts), JSON.stringify({ http: resumed.status, p: resumed.json?.data?.pipeline_status }));

    // acceptance AFTER deletion
    const confirm = await app(p1, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    check('J1.12 the person accepts AFTER the file is gone, with the exact body the panel sends', confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 200)}`);
    const replay = await app(p1, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'amount_original,credit_debit,transaction_date,balance_after');
    const recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${up.documentId}`, 'status,variance,opening_balance,reported_closing_balance');
    const debits = tx.filter((t) => t.credit_debit === 'debit').reduce((s, t) => s + Number(t.amount_original), 0);
    const credits = tx.filter((t) => t.credit_debit === 'credit').reduce((s, t) => s + Number(t.amount_original), 0);
    const docEnd = await row('fdh_statement_uploads', up.documentId);
    check('J1.13 canonical result is exactly right: 6 transactions, money out 1,795.75, money in 2,950.00, reconciled with variance 0, certified; a replayed confirm is refused (409) and writes nothing',
      tx.length === 6 && near(debits, BANK_B1_EXPECTED.debits) && near(credits, BANK_B1_EXPECTED.credits) && recon.length === 1 && recon[0].status === 'reconciled' && near(recon[0].variance, 0) && replay.status === 409 && docEnd.certification_status === 'certified',
      JSON.stringify({ tx: tx.length, debits, credits, recon, replay: replay.status, cert: docEnd.certification_status, p: docEnd.processing_status }));
    const afterConfirm = await ledger();
    check('J1.14 confirming and replaying charged nothing further', Number(afterConfirm.total_attempts) === Number(after.total_attempts) && Number(afterConfirm.settled_usd) === Number(after.settled_usd), JSON.stringify({ attempts: afterConfirm.total_attempts }));
    const act = await app(p1, '/api/financial-data-hub/activity/transactions');
    evidence.j1 = { documentId: up.documentId, scanWaitMs: up.scanWaitMs, latencyMs, attempt: a0 ? { model: a0.model, settled: a0.settled_usd, reserved: a0.reserved_usd, tokens: [a0.input_tokens, a0.output_tokens], requestIds: (a0.provider_request_ids ?? []).length } : null, tx: tx.length, debits, credits, recon, cert: docEnd.certification_status, downstreamActivityHttp: act.status, downstreamActivityTxCount: Array.isArray(act.json?.data?.transactions) ? act.json.data.transactions.length : Array.isArray(act.json?.data) ? act.json.data.length : null };

    // ---------------------------------------------------------------- DOC-B2 (P2 outside the pilot) + isolation
    console.log('\n--- J1b bank PDF, P2 (second Premium account) ---');
    const b2 = await uploadBank(p2, doc('DOC-B2'), 'b2');
    const p2proc = await app(p2, `/api/financial-data-hub/bank-pdf/${b2.documentId}/process`, { method: 'POST', json: {} });
    const [b2Ok, b2Detail] = draftMatches(p2proc.json?.data?.ai_fallback_draft, BANK_B2_EXPECTED);
    check('J1b.1 P2 gets an independent draft that equals the expected values for DOC-B2', b2.upload.status === 200 && b2.doc?.malware_scan_status === 'clean' && b2Ok, b2Detail);
    const p2c = await app(p2, `/api/financial-data-hub/bank-pdf/${b2.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(p2proc.json?.data?.ai_fallback_draft) });
    const p2tx = await rows('fdh_transactions', `statement_upload_id=eq.${b2.documentId}`, 'amount_original,credit_debit');
    const p1sees = await rows('fdh_transactions', `statement_upload_id=eq.${b2.documentId}&user_id=eq.${p1.id}`, 'id');
    check('J1b.2 P2 accepts: 6 transactions, money out 2,630.45, money in 3,104.15; none of them belongs to P1', p2c.status === 200 && p2tx.length === 6 && near(p2tx.filter((t) => t.credit_debit === 'debit').reduce((s, t) => s + Number(t.amount_original), 0), BANK_B2_EXPECTED.debits) && near(p2tx.filter((t) => t.credit_debit === 'credit').reduce((s, t) => s + Number(t.amount_original), 0), BANK_B2_EXPECTED.credits) && p1sees.length === 0, JSON.stringify({ confirm: p2c.status, tx: p2tx.length }));

    // ---------------------------------------------------------------- DOC-B3 wrong on purpose
    console.log('\n--- J1c bank PDF with an arithmetic error on the page (DOC-B3), P2 ---');
    const b3 = await uploadBank(p2, doc('DOC-B3'), 'b3');
    const b3proc = await app(p2, `/api/financial-data-hub/bank-pdf/${b3.documentId}/process`, { method: 'POST', json: {} });
    const b3draft = b3proc.json?.data?.ai_fallback_draft;
    const [b3Ok, b3Detail] = draftMatches(b3draft, BANK_B3_EXPECTED);
    check('J1c.1 the model reports the figures AS PRINTED (last balance and closing 9,300.00); it does not correct the page', b3Ok, b3Detail);
    const b3c = await app(p2, `/api/financial-data-hub/bank-pdf/${b3.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(b3draft ?? { rows: [] }) });
    const b3recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${b3.documentId}`, 'status,variance');
    const b3doc = await row('fdh_statement_uploads', b3.documentId);
    check('J1c.2 the statement is NOT certified: reconciliation failed with the 43.95 variance kept, document needs review', b3c.status === 200 && b3recon.length === 1 && b3recon[0].status === 'failed' && near(Math.abs(Number(b3recon[0].variance)), BANK_B3_VARIANCE) && b3doc.certification_status !== 'certified' && b3doc.processing_status === 'review_required', JSON.stringify({ confirm: b3c.status, recon: b3recon, cert: b3doc.certification_status, p: b3doc.processing_status }));
    evidence.j1c = { documentId: b3.documentId, recon: b3recon, cert: b3doc.certification_status };
  }

  // ============================================================== Refusals
  if (want('refuse')) {
    console.log('\n--- R: refusals happen BEFORE any provider call or chargeable processing ---');
    const base = await ledger();
    const bytes = doc('DOC-B1').build();
    const qs = await ownerQuery(free, 'bank', { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-free.pdf` });
    const f = await app(free, `/api/financial-data-hub/bank-pdf/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
    const fRows = await rows('fdh_statement_uploads', `user_id=eq.${free.id}`, 'id');
    const afterF = await ledger();
    check('R1 Free user: upload refused 403 PREMIUM_REQUIRED before the body is stored; no document row, nothing scanned or charged', f.status === 403 && /PREMIUM_REQUIRED/i.test(f.text) && fRows.length === 0 && Number(afterF.total_attempts) === Number(base.total_attempts), JSON.stringify({ http: f.status, code: f.json?.data?.code ?? f.json?.code, rows: fRows.length }));
    const forged = await app(free, `/api/financial-data-hub/bank-pdf/upload?${qs}&plan_tier=premium&premium=true&user_id=${p1.id}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'x-plan-tier': 'premium', 'x-user-id': p1.id, 'x-premium': 'true' } });
    check('R2 forged plan / user claims (query, headers) from a Free session are ignored: still refused, still nothing created', forged.status === 403 && (await rows('fdh_statement_uploads', `user_id=eq.${free.id}`, 'id')).length === 0, JSON.stringify({ http: forged.status }));
    const anon = await app(null, `/api/financial-data-hub/bank-pdf/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
    check('R3 no session: refused (401), nothing created', anon.status === 401, `http ${anon.status}`);

    // Lapsed after upload: the former-pilot account (listed on the retired variables) uploads as Premium, then its plan ends BEFORE the first processing run.
    const lap = await uploadBank(former, doc('DOC-B1'), 'lapse');
    await setPlan(former, 'free');
    const preLapse = await ledger();
    const lapProc = await app(former, `/api/financial-data-hub/bank-pdf/${lap.documentId}/process`, { method: 'POST', json: {} });
    const lapTrail = await audits(lap.documentId);
    const refusal = lapTrail.find((a) => a.event_type === 'bank_statement_ai_fallback_not_usable');
    const postLapse = await ledger();
    check('R4 FORMER-PILOT account (still listed on the retired variables) whose plan ended: AI refused as premium_required (not cohort_denied), no provider attempt, no draft, nothing reserved or charged',
      refusal?.metadata?.reason === 'premium_required' && lapProc.json?.data?.ai_fallback_refusal === 'premium_required' && (await drafts(lap.documentId)).length === 0
        && Number(postLapse.total_attempts) === Number(preLapse.total_attempts) && Number(postLapse.settled_usd) === Number(preLapse.settled_usd) && Number(postLapse.reserved_usd) === Number(preLapse.reserved_usd)
        && (await attemptsFor(former.id)).length === 0,
      JSON.stringify({ reason: refusal?.metadata?.reason, field: lapProc.json?.data?.ai_fallback_refusal, http: lapProc.status }));
    // Expired window (not just Free)
    const exp = await uploadBank(p2, { ...doc('DOC-B1'), build: () => doc('DOC-B2').build() } as any, 'expired');
    await setPlan(p2, 'expired');
    const preExp = await ledger();
    const expProc = await app(p2, `/api/financial-data-hub/bank-pdf/${exp.documentId}/process`, { method: 'POST', json: {} });
    const postExp = await ledger();
    check('R5 expired Premium window: a new unreadable document is refused premium_required with no provider call (a duplicate of an accepted upload is answered from the original, which is allowed)',
      (expProc.json?.data?.ai_fallback_refusal === 'premium_required' || expProc.json?.data?.duplicate === true) && Number(postExp.total_attempts) === Number(preExp.total_attempts), JSON.stringify({ refusal: expProc.json?.data?.ai_fallback_refusal, dup: expProc.json?.data?.duplicate }));
    await setPlan(p2, 'premium');
    // Upgrade is seen on the next request (no cache): the same Free account becomes Premium and can upload
    await setPlan(free, 'premium');
    const up2 = await app(free, `/api/financial-data-hub/bank-pdf/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
    check('R6 upgrade is honoured on the very next request, with the same session (no cache)', up2.status === 200, `http ${up2.status}`);
    await setPlan(free, 'free');
  }

  // ============================================================== Limits (bounded, no real spend)
  if (want('limits')) {
    console.log('\n--- L: the per-user cap and the global ceiling refuse BEFORE the provider (tiny temporary values, restored afterwards) ---');
    const u = await makeUser('L1', `proof-l1-${Date.now()}@fhip-test.invalid`);
    await setPlan(u, 'premium');
    // per-user cap: below the ~US$0.009 reservation of one statement read
    await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { user_daily_cap_usd: 0.001 } });
    const before = await ledger();
    const up = await uploadBank(u, doc('DOC-B2'), 'cap');
    const proc = await app(u, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const att = await attemptsFor(u.id);
    const after = await ledger();
    check('L1 per-user daily cap: refused daily_limit_reached before the provider; the attempt row is user_daily_cap_reached with nothing reserved; global reserved/settled unchanged; no draft',
      proc.json?.data?.ai_fallback_refusal === 'daily_limit_reached' && att.some((a) => a.admission_outcome === 'user_daily_cap_reached' && Number(a.reserved_usd) === 0) && att.every((a) => (a.provider_request_ids ?? []).length === 0)
        && Number(after.reserved_usd) === Number(before.reserved_usd) && Number(after.settled_usd) === Number(before.settled_usd) && (await drafts(up.documentId)).length === 0,
      JSON.stringify({ field: proc.json?.data?.ai_fallback_refusal, attempts: att.map((a) => a.admission_outcome) }));
    await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { user_daily_cap_usd: cleanupLedger.cap } });
    // global ceiling: stored allowance below what is already settled
    await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { allowance_usd: 0.001 } });
    const u2 = await makeUser('L2', `proof-l2-${Date.now()}@fhip-test.invalid`);
    await setPlan(u2, 'premium');
    const up2 = await uploadBank(u2, doc('DOC-B1'), 'global');
    const proc2 = await app(u2, `/api/financial-data-hub/bank-pdf/${up2.documentId}/process`, { method: 'POST', json: {} });
    const att2 = await attemptsFor(u2.id);
    check('L2 global allowance: refused (capacity) before the provider, attempt recorded budget_exhausted, no draft', ['capacity', 'budget_exhausted', 'service_capacity'].includes(proc2.json?.data?.ai_fallback_refusal) || (proc2.json?.data?.ai_fallback_refusal ?? null) === null && att2.some((a) => a.admission_outcome === 'budget_exhausted'),
      JSON.stringify({ field: proc2.json?.data?.ai_fallback_refusal ?? null, attempts: att2.map((a) => a.admission_outcome) }));
    check('L2b the attempt row says budget_exhausted and no provider request id exists', att2.some((a) => a.admission_outcome === 'budget_exhausted') && att2.every((a) => (a.provider_request_ids ?? []).length === 0), JSON.stringify(att2.map((a) => a.admission_outcome)));
    await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { allowance_usd: cleanupLedger.allowance } });
  }

  // ============================================================== Payslip PDF (second PDF class)
  if (want('pdfless') || want('payslip')) {
    console.log('\n--- P payslip PDF (DOC-P1), P1: second PDF class through the same machinery ---');
    const d = doc('DOC-P1');
    const bytes = d.build();
    const before = await ledger();
    const sess = await app(p1, '/api/financial-data-hub/documents/upload-sessions', {
      method: 'POST',
      json: { document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: bytes.length, owner: await resolveSyntheticOwner(fetchOwnerRequest(APP, p1.cookie), 'self', 'payslip') },
    });
    const comp = sess.status === 200 ? await app(p1, `/api/financial-data-hub/documents/upload-sessions/${sess.json.data.session_id}/complete`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': 'application/pdf' } }) : sess;
    const documentId = comp.json?.data?.document_id as string | undefined;
    if (!documentId) {
      check('P1 payslip upload accepted through the upload-session route', false, `${sess.status} ${comp.status} ${comp.text.slice(0, 200)}`);
    } else {
      recordArtefact({ kind: 'fdh_statement_uploads', id: documentId, userId: p1.id, run: RUN });
      let rd = await row('fdh_statement_uploads', documentId);
      const t0 = Date.now();
      while (rd && rd.processing_status === 'validating' && Date.now() - t0 < 240_000) { await sleep(3000); await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep'); rd = await row('fdh_statement_uploads', documentId); }
      const proc = await app(p1, `/api/financial-data-hub/payslip/${documentId}/process`, { method: 'POST', json: {} });
      const draft = proc.json?.data?.ai_fallback_draft;
      const after = await ledger();
      check('P2 payslip: scan clean; parser cannot read it; the AI draft equals gross 3,200.00, tax 512.00, net 2,488.00, fortnightly, paid 15/08/2026 (one metered attempt)',
        rd?.malware_scan_status === 'clean' && proc.json?.data?.pipeline_status === 'ai_fallback_available' && near(draft?.grossPay, PAYSLIP_P1_EXPECTED.grossPay) && near(draft?.taxWithheld, PAYSLIP_P1_EXPECTED.taxWithheld) && near(draft?.netPay, PAYSLIP_P1_EXPECTED.netPay) && draft?.payFrequency === 'fortnightly' && draft?.paymentDate === PAYSLIP_P1_EXPECTED.paymentDate && Number(after.total_attempts) === Number(before.total_attempts) + 1,
        JSON.stringify({ http: proc.status, p: proc.json?.data?.pipeline_status, gross: draft?.grossPay, tax: draft?.taxWithheld, net: draft?.netPay, freq: draft?.payFrequency, paid: draft?.paymentDate, keys: draft ? Object.keys(draft) : null }).slice(0, 500));
      evidence.payslip = { documentId };
    }
  }

  evidence.ledgerEnd = await ledger();
}

async function cleanup() {
  // restore the two shared ledger values first, then delete the synthetic users and re-count residue
  try {
    if (cleanupLedger.allowance !== undefined) await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { allowance_usd: cleanupLedger.allowance, user_daily_cap_usd: cleanupLedger.cap } });
    const l = await ledger();
    console.log(`ledger restored: allowance=${l.allowance_usd} per_user_cap=${l.user_daily_cap_usd} reserved=${l.reserved_usd}`);
    check('cleanup: the shared ledger ceilings are back to their starting values', Number(l.allowance_usd) === cleanupLedger.allowance && Number(l.user_daily_cap_usd) === cleanupLedger.cap);
  } catch (e) { console.log('ledger restore problem:', (e as Error).message); }
  const residue: Record<string, number> = {};
  for (const u of created) {
    // storage objects of the user's documents (should already be purged)
    const docs = await rows('fdh_statement_uploads', `user_id=eq.${u.id}`, 'id,raw_document_storage_reference');
    for (const dd of docs) if (dd.raw_document_storage_reference) await devFetch(`/storage/v1/object/fdh-source-documents/${dd.raw_document_storage_reference}`, { method: 'DELETE' });
    const del = await devFetch(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    if (!del.ok) console.log(`could not delete ${u.label}: ${del.status}`);
  }
  for (const t of ['fdh_statement_uploads', 'fdh_transactions', 'fdh_ai_fallback_drafts', 'fdh_document_audit_events', 'fdh_reconciliation_results']) {
    let n = 0;
    for (const u of created) n += (await rows(t, `user_id=eq.${u.id}`, 'id')).length;
    residue[t] = n;
  }
  const attemptsLeft = (await Promise.all(created.map((u) => rows('aie_ai_cost_attempt', `user_id=eq.${u.id}`, 'idempotency_key')))).flat().length;
  residue.aie_ai_cost_attempt_user_set = attemptsLeft;
  const usersLeft = (await Promise.all(created.map((u) => devFetch(`/auth/v1/admin/users/${u.id}`)))).filter((r) => r.ok).length;
  residue.auth_users = usersLeft;
  evidence.residue = residue;
  check('cleanup: no synthetic user, upload, transaction, draft, audit or reconciliation row is left (cost attempts stay as accounting, detached from the deleted users)', Object.entries(residue).filter(([k]) => k !== 'aie_ai_cost_attempt_user_set').every(([, v]) => v === 0), JSON.stringify(residue));
}

main()
  .catch((e) => { console.error('RUN ABORTED:', e instanceof Error ? e.message : e); evidence.aborted = String(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup error:', e instanceof Error ? e.message : e));
    evidence.finishedAt = new Date().toISOString();
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(`${SCRATCH}/${RUN}.evidence.json`, JSON.stringify(evidence, null, 2));
    const failed = summary();
    console.log(`evidence file: ${SCRATCH}/${RUN}.evidence.json`);
    if (failed) process.exitCode = 1;
  });
