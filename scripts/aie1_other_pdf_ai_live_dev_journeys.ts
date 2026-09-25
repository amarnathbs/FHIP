/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * AIE other-PDF AI proof (2026-09-25) -- LIVE DEV journeys for the AI
 * fallback of every document type other than payslip, with REAL GPT-4o mini.
 *
 * Real HTTP against the app on this branch (`scripts/aie1_final_dev_server.mjs`
 * -- DEV Supabase, DEV S3 malware bucket + DEV GuardDuty plan, every per-type
 * AI flag on, the production cohort SHAPE with synthetic pilot emails).
 * Synthetic users and documents only; every artefact goes to the manifest;
 * every DEV write asserts the DEV host. Ground truth is read back from the
 * database with the service role, never taken from the API's own answer.
 * No document text is ever printed or saved.
 *
 * Run (server up on :3962):
 *   AIE1_MANIFEST=<scratch>/aie1_other_pdf_manifest.jsonl \
 *     npx tsx scripts/aie1_other_pdf_ai_live_dev_journeys.ts http://localhost:3962 [journey...]
 * Journeys: bank bank-outsider bank-nonrecon bank-insufficient liability retirement investment
 *           liability-nonrecon retirement-nonrecon outsiders
 */
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import * as fx from './aie1_other_pdf_fixtures';
import { maskedSurvivors } from './aie1_other_pdf_masking_precheck';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:3962';
const selected = new Set(process.argv.slice(3));
const want = (j: string) => selected.size === 0 || selected.has(j);
const { check, summary } = makeChecker('AIE1-OTHER');
const RUN = `aie1other-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, any> = { run: RUN, app: APP, startedAt: new Date().toISOString() };
const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/otherpdf';
const PILOT_EMAIL = 'aie1-final-pilot-b@fhip-test.invalid';
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;

interface U { id: string; email: string; cookie: string }

async function findUserByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const r = await devFetch(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = (r.json?.users ?? []) as Array<{ id: string; email: string }>;
    const hit = users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (users.length < 200) return null;
  }
  return null;
}

async function makeUser(email: string, tag: string): Promise<U> {
  const existing = await findUserByEmail(email);
  if (existing) await devFetch(`/auth/v1/admin/users/${existing}`, { method: 'DELETE' });
  const password = `Aie1Other!${Date.now()}Zz9`;
  const created = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id as string;
  if (!id) throw new Error(`create ${tag} failed: ${created.status}`);
  recordArtefact({ kind: 'auth_user', id, email, tag, run: RUN });
  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  if (!Array.isArray(prof.json) || prof.json.length !== 1) throw new Error(`profile ${tag}: ${prof.status}`);
  assertDev(BASE);
  const tok = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tok.json();
  if (!session.access_token) throw new Error(`sign-in ${tag} failed`);
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const name = `sb-${REF}-auth-token`;
  const CHUNK = 3180;
  const cookie = encoded.length <= CHUNK
    ? `${name}=${encoded}`
    : Array.from({ length: Math.ceil(encoded.length / CHUNK) }, (_, i) => `${name}.${i}=${encoded.slice(i * CHUNK, (i + 1) * CHUNK)}`).join('; ');
  return { id, email, cookie };
}

async function app(u: U, p: string, init: { method?: string; body?: BodyInit; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Cookie: u.cookie, ...(init.headers ?? {}) };
  let body = init.body;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`${APP}${p}`, { method: init.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function cron(p: string) {
  const res = await fetch(`${APP}${p}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
  return { status: res.status };
}
async function row(table: string, id: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?id=eq.${id}&select=${select}`);
  return (r.json?.[0] ?? null) as any;
}
async function rows(table: string, filter: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?${filter}&select=${select}`);
  return (Array.isArray(r.json) ? r.json : []) as any[];
}
async function ledger() { return (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0]; }
async function audits(documentId: string) {
  return rows('fdh_document_audit_events', `document_id=eq.${documentId}&order=created_at.asc`, 'event_type,metadata');
}
async function drafts(documentId: string) {
  return rows('fdh_ai_fallback_drafts', `statement_upload_id=eq.${documentId}`, 'id,status,document_type,payload,provider_idempotency_key,confirmed_at');
}

/** Raw-body upload through a class route, then wait out the real scan. */
async function uploadRaw(u: U, route: string, params: Record<string, string>, bytes: Buffer, mime: string) {
  const qs = new URLSearchParams(params).toString();
  const r = await app(u, `/api/financial-data-hub/${route}/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length) } });
  const documentId = r.json?.data?.document_id as string | undefined;
  if (documentId) recordArtefact({ kind: 'fdh_statement_uploads', id: documentId, userId: u.id, run: RUN });
  let doc = documentId ? await row('fdh_statement_uploads', documentId) : null;
  const t0 = Date.now();
  while (doc && doc.processing_status === 'validating' && Date.now() - t0 < 180_000) {
    await sleep(3000);
    await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep');
    doc = await row('fdh_statement_uploads', documentId!);
  }
  return { upload: r, documentId: documentId!, doc, scanWaitMs: Date.now() - t0 };
}

/** Everything the requirement means by "spend reserved and settled, with model,
 * request id and tokens recorded", read from the ledger and the per-attempt row. */
async function spendEvidence(before: any, readyMeta: any) {
  const after = await ledger();
  const key = readyMeta?.ai_cost_key as string | undefined;
  const attempt = key ? (await rows('aie_ai_cost_attempt', `idempotency_key=eq.${encodeURIComponent(key)}`))[0] : null;
  return {
    settledDeltaUsd: Number(after.settled_usd) - Number(before.settled_usd),
    attemptsDelta: Number(after.total_attempts) - Number(before.total_attempts),
    reservedBefore: Number(before.reserved_usd),
    reservedAfter: Number(after.reserved_usd),
    attempt: attempt ? {
      reserved_usd: attempt.reserved_usd, settled_usd: attempt.settled_usd, model: attempt.model,
      provider_request_ids: attempt.provider_request_ids, input_tokens: attempt.input_tokens, output_tokens: attempt.output_tokens,
      call_outcome: attempt.call_outcome, settled_by: attempt.settled_by,
    } : null,
    auditMeta: readyMeta ? { ai_model: readyMeta.ai_model, ai_provider_request_ids: readyMeta.ai_provider_request_ids, ai_input_tokens: readyMeta.ai_input_tokens, ai_output_tokens: readyMeta.ai_output_tokens, draft_persisted: readyMeta.draft_persisted } : null,
  };
}

function checkSpend(tag: string, s: Awaited<ReturnType<typeof spendEvidence>>) {
  check(`${tag} spend: one metered attempt, reserved then settled (> $0, < $0.01), reservation released, model gpt-4o-mini, an OpenAI request id and token counts recorded`,
    s.attemptsDelta === 1 && s.settledDeltaUsd > 0 && s.settledDeltaUsd < 0.01 && s.reservedAfter === s.reservedBefore
      && !!s.attempt && Number(s.attempt.reserved_usd) >= Number(s.attempt.settled_usd) && Number(s.attempt.settled_usd) > 0
      && s.attempt.model === 'gpt-4o-mini' && (s.attempt.provider_request_ids ?? []).length >= 1 && Number(s.attempt.input_tokens) > 0 && Number(s.attempt.output_tokens) > 0
      && s.auditMeta?.ai_model === 'gpt-4o-mini' && (s.auditMeta?.ai_provider_request_ids ?? []).length >= 1,
    JSON.stringify(s));
}

const PII_VALUES = Object.values(fx.PLANTED_PII);
const noPii = (x: unknown) => { const s = JSON.stringify(x ?? null); return PII_VALUES.every((v) => !s.includes(v)); };

/** The masking evidence, without ever logging content: the exact text the
 * server masks (same extractor/decoder) is masked locally with the same
 * function and every planted value must be gone; the server's own gateway
 * re-scan must have passed (a success outcome, never unmasked_pii_detected);
 * and nothing planted may come back in the model's output or the stored draft. */
async function maskingEvidence(tag: string, text: string, draftFromApi: unknown, draftRow: unknown, auditTrail: any[]) {
  const { survivors, rescanFlagged } = await maskedSurvivors(text);
  const planted = PII_VALUES.filter((v) => text.includes(v)).length;
  const blocked = auditTrail.some((a) => a.metadata?.outcome === 'unmasked_pii_detected');
  check(`${tag} masking: ${planted} planted synthetic personal details in the document, 0 survive masking, gateway pre-egress re-scan passed, none present in the model output or the stored draft`,
    planted >= 3 && survivors.length === 0 && !rescanFlagged && !blocked && noPii(draftFromApi) && noPii(draftRow),
    JSON.stringify({ planted, survivors, rescanFlagged, blocked, outputClean: noPii(draftFromApi), draftClean: noPii(draftRow) }));
  return { planted, survivors: survivors.length };
}

async function purgeAndVerify(tag: string, u: U, documentId: string) {
  await devFetch(`/rest/v1/fdh_statement_uploads?id=eq.${documentId}&user_id=eq.${u.id}`, { method: 'PATCH', body: { uploaded_at: new Date(Date.now() - 3 * 3600_000).toISOString() } });
  const storageRef = (await row('fdh_statement_uploads', documentId)).raw_document_storage_reference as string | null;
  await cron('/api/financial-data-hub/documents/cron/purge-sweep');
  await sleep(1000);
  await cron('/api/financial-data-hub/documents/cron/purge-sweep');
  const after = await row('fdh_statement_uploads', documentId);
  let listed = false;
  if (storageRef) {
    const dir = storageRef.slice(0, storageRef.lastIndexOf('/'));
    const name = storageRef.slice(storageRef.lastIndexOf('/') + 1);
    const list = await devFetch(`/storage/v1/object/list/fdh-source-documents`, { method: 'POST', body: { prefix: dir, search: name, limit: 10 } });
    listed = Array.isArray(list.json) && list.json.some((o: any) => o.name === name);
  }
  const s3Purge = after.malware_scan_object_ref?.s3Purge ?? null;
  check(`${tag} original file purged and its absence verified (storage listing), document keeps its reviewed status`,
    after.raw_document_purge_status === 'purged' && !after.raw_document_storage_reference && !listed && !!storageRef && after.processing_status !== 'rejected',
    JSON.stringify({ purge: after.raw_document_purge_status, processing: after.processing_status, listed, hadRef: !!storageRef, s3Purge }));
  return { purge: after.raw_document_purge_status, processing: after.processing_status, s3Purge };
}

async function pdfText(bytes: Buffer): Promise<string> {
  const { extractPdfPages } = await import('../lib/financial-data-hub/bank-pdf/textExtraction');
  const r: any = await extractPdfPages(new Uint8Array(bytes));
  return (r.pages as string[]).join('\n');
}
async function csvText(bytes: Buffer): Promise<string> {
  const { decodeCsvBytes } = await import('../lib/financial-data-hub/bank-csv/csv');
  return decodeCsvBytes(new Uint8Array(bytes)).text;
}

async function bankInstitution(): Promise<string | undefined> {
  return (await rows('fdh_financial_institutions', 'institution_code=eq.CBA&country_code=eq.AU', 'id'))[0]?.id;
}

async function main() {
  console.log(`=== AIE other-PDF AI LIVE DEV journeys (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  const pilot = await makeUser(PILOT_EMAIL, 'pilot-b');
  const outsider = await makeUser(`aie1-final-other-outsider-${Date.now()}@fhip-test.invalid`, 'outsider');
  evidence.users = { pilot: pilot.id, outsider: outsider.id };
  evidence.ledgerBefore = await ledger();
  const inst = await bankInstitution();

  // ------------------------------------------------------------------ bank
  async function bankUpload(u: U, bytes: Buffer, tag: string, masked: string) {
    return uploadRaw(u, 'bank-pdf', { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-${tag}.pdf`, masked_identifier: masked, ...(inst ? { institution_id: inst } : {}) }, bytes, 'application/pdf');
  }
  /** Exactly BankStatementImportPanel.handleConfirmAiDraft's body. */
  const bankPanelBody = (d: any) => ({ rows: d.rows, statementPeriodStart: d.statementPeriodStart, statementPeriodEnd: d.statementPeriodEnd, declaredOpeningBalance: d.declaredOpeningBalance, declaredClosingBalance: d.declaredClosingBalance, maskedAccountIdentifier: d.maskedAccountIdentifier });

  if (want('bank')) {
    console.log('\n--- B1 bank statement PDF the parser cannot read -> real GPT-4o mini -> review -> confirm -> transactions ---');
    const bytes = fx.bankLetterPdf(`${RUN}-b1`);
    const before = await ledger();
    const up = await bankUpload(pilot, bytes, 'b1', 'OPB1');
    check('B1 upload accepted and the real GuardDuty scan is clean', up.upload.status === 200 && up.doc?.malware_scan_status === 'clean' && up.doc?.processing_status === 'queued', JSON.stringify({ http: up.upload.status, scan: up.doc?.malware_scan_status, p: up.doc?.processing_status, waitMs: up.scanWaitMs }));
    const t0 = Date.now();
    const proc = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const latencyMs = Date.now() - t0;
    const draft = proc.json?.data?.ai_fallback_draft;
    const trail = await audits(up.documentId);
    const notUsable = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_not_usable');
    const nativeFail = trail.find((a) => a.event_type === 'pdf_native_extraction_started');
    check('B1 the deterministic parser could not read it and the AI fallback produced a draft', proc.status === 200 && proc.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft && !!nativeFail,
      `${proc.status} ${JSON.stringify({ pipeline: proc.json?.data?.pipeline_status, notUsable: notUsable?.metadata ?? null }).slice(0, 300)}`);
    const e = fx.BANK_EXPECTED;
    const rowsOk = !!draft && draft.rows.length === 3 && e.transactions.every((t, i) => draft.rows[i]?.transactionDate === t.date && near(draft.rows[i]?.amountOriginal, t.amount) && draft.rows[i]?.creditDebit === t.direction);
    check('B1 draft equals the hand-computed values (opening 2000.00, closing 2776.55, period 2026-08-01..31, 3 lines: +1850.00, -950.00, -123.45)',
      rowsOk && near(draft.declaredOpeningBalance, e.openingBalance) && near(draft.declaredClosingBalance, e.closingBalance) && draft.statementPeriodStart === e.periodStart && draft.statementPeriodEnd === e.periodEnd,
      JSON.stringify(draft ? { o: draft.declaredOpeningBalance, c: draft.declaredClosingBalance, ps: draft.statementPeriodStart, pe: draft.statementPeriodEnd, rows: draft.rows.map((r: any) => `${r.transactionDate} ${r.creditDebit} ${r.amountOriginal}`) } : null));
    check('B1 the draft carries only reviewable keys (what the confirm route accepts)', !!draft && draft.rows.every((r: any) => Object.keys(r).sort().join(',') === 'amountOriginal,balanceAfter,creditDebit,descriptionRaw,transactionDate'), JSON.stringify(draft?.rows?.[0] ? Object.keys(draft.rows[0]) : null));
    const ready = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_draft_ready');
    const dRows = await drafts(up.documentId);
    check('B1 the draft is persisted server-side (0197) before review, pending, linked to its metered call', dRows.length === 1 && dRows[0].status === 'pending_review' && dRows[0].document_type === 'bank_statement' && dRows[0].provider_idempotency_key === ready?.metadata?.ai_cost_key, JSON.stringify(dRows.map((d) => ({ s: d.status, t: d.document_type, k: !!d.provider_idempotency_key }))));
    const docMid = await row('fdh_statement_uploads', up.documentId);
    const txMid = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    check('B1 nothing canonical written before review (no transactions; document parked in processing)', txMid.length === 0 && docMid.processing_status === 'processing', JSON.stringify({ tx: txMid.length, p: docMid.processing_status }));
    const spend = await spendEvidence(before, ready?.metadata);
    checkSpend('B1', spend);
    const mask = await maskingEvidence('B1', await pdfText(bytes), draft, dRows[0]?.payload, trail);

    const confirm = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    check('B1 the user confirms through the normal confirm route, with the exact body the panel sends', confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 200)}`);
    const replay = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft) });
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'amount_original,credit_debit,transaction_date');
    const recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${up.documentId}`, 'status,variance');
    const debits = tx.filter((t) => t.credit_debit === 'debit').reduce((a, t) => a + Number(t.amount_original), 0);
    const credits = tx.filter((t) => t.credit_debit === 'credit').reduce((a, t) => a + Number(t.amount_original), 0);
    check('B1 exactly one canonical write: 3 transactions, debits 1073.45, credits 1850.00, reconciled; a replayed confirm is refused (409) and writes nothing',
      tx.length === 3 && near(debits, e.debits) && near(credits, e.credits) && recon.length === 1 && recon[0].status === 'reconciled' && replay.status === 409,
      JSON.stringify({ tx: tx.length, debits, credits, recon, replay: replay.status }));
    const dAfter = await drafts(up.documentId);
    const docAfter = await row('fdh_statement_uploads', up.documentId);
    check('B1 the draft was claimed once (confirmed) and the document completed through the native writer', dAfter.length === 1 && dAfter[0].status === 'confirmed' && !!dAfter[0].confirmed_at && ['approved', 'review_required'].includes(docAfter.processing_status), JSON.stringify({ draft: dAfter.map((d) => d.status), p: docAfter.processing_status, cert: docAfter.certification_status }));
    const purge = await purgeAndVerify('B1', pilot, up.documentId);
    evidence.b1 = { documentId: up.documentId, scanWaitMs: up.scanWaitMs, latencyMs, spend, mask, confirm: confirm.status, replay: replay.status, tx: tx.length, debits, credits, recon, docStatus: docAfter.processing_status, cert: docAfter.certification_status, purge };
  }

  if (want('bank-outsider')) {
    console.log('\n--- B2 bank: a user outside the pilot cohort is refused AI, no spend, nothing written ---');
    const before = await ledger();
    const up = await bankUpload(outsider, fx.bankLetterPdf(`${RUN}-b2`), 'b2', 'OPB2');
    const proc = await app(outsider, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const trail = await audits(up.documentId);
    const notUsable = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_not_usable');
    const after = await ledger();
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    const d = await drafts(up.documentId);
    const doc = await row('fdh_statement_uploads', up.documentId);
    check('B2 outsider: AI refused as cohort_denied (native failure was AI-eligible), no provider attempt, no draft, no transactions, document rejected honestly',
      notUsable?.metadata?.reason === 'cohort_denied' && ['unsupported_layout', 'ambiguous_layout', 'extraction_low_confidence'].includes(notUsable?.metadata?.nativePipelineStatus)
        && Number(after.total_attempts) === Number(before.total_attempts) && Number(after.settled_usd) === Number(before.settled_usd)
        && d.length === 0 && tx.length === 0 && doc.processing_status === 'rejected' && proc.json?.data?.pipeline_status !== 'ai_fallback_available',
      JSON.stringify({ reason: notUsable?.metadata?.reason, native: notUsable?.metadata?.nativePipelineStatus, attempts: [before.total_attempts, after.total_attempts], drafts: d.length, tx: tx.length, p: doc.processing_status }));
    evidence.b2 = { documentId: up.documentId, reason: notUsable?.metadata?.reason, native: notUsable?.metadata?.nativePipelineStatus };
  }

  if (want('bank-nonrecon')) {
    console.log('\n--- B3 bank: a printed closing balance that does not reconcile stays unresolved (never balanced) ---');
    const before = await ledger();
    const up = await bankUpload(pilot, fx.bankLetterPdf(`${RUN}-b3`, { closingPrinted: '2800.00' }), 'b3', 'OPB3');
    const proc = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const draft = proc.json?.data?.ai_fallback_draft;
    const trail = await audits(up.documentId);
    const ready = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_draft_ready');
    check('B3 the AI reports the closing balance AS PRINTED (2800.00) and the three lines as printed -- it does not invent a line or adjust a figure to make it add up',
      !!draft && near(draft.declaredClosingBalance, fx.BANK_NON_RECONCILING_PRINTED_CLOSING) && draft.rows.length === 3,
      JSON.stringify(draft ? { c: draft.declaredClosingBalance, rows: draft.rows.map((r: any) => `${r.creditDebit} ${r.amountOriginal}`) } : proc.json?.data ?? proc.status));
    const confirm = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: bankPanelBody(draft ?? { rows: [] }) });
    const recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${up.documentId}`, 'status,variance,expected_closing_balance,reported_closing_balance');
    const doc = await row('fdh_statement_uploads', up.documentId);
    const reviews = await rows('fdh_review_items', `statement_upload_id=eq.${up.documentId}`, 'review_type,severity,status');
    check('B3 after confirm the statement is NOT certified: reconciliation failed with the 23.45 variance kept, document review_required, a blocking reconciliation review item is open',
      confirm.status === 200 && recon.length === 1 && recon[0].status === 'failed' && near(Math.abs(Number(recon[0].variance)), fx.BANK_NON_RECONCILING_VARIANCE)
        && doc.processing_status === 'review_required' && doc.certification_status !== 'certified' && reviews.some((r) => r.review_type === 'reconciliation_failure' && r.status === 'open'),
      JSON.stringify({ confirm: confirm.status, recon, p: doc.processing_status, cert: doc.certification_status, reviews }));
    evidence.b3 = { documentId: up.documentId, spend: await spendEvidence(before, ready?.metadata), recon, docStatus: doc.processing_status, cert: doc.certification_status };
  }

  if (want('bank-insufficient')) {
    console.log('\n--- B4 bank: an AI reading with no usable transaction writes nothing ---');
    const before = await ledger();
    const up = await bankUpload(pilot, fx.bankNoTransactionsPdf(`${RUN}-b4`), 'b4', 'OPB4');
    const proc = await app(pilot, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const trail = await audits(up.documentId);
    const notUsable = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_not_usable');
    const insuff = trail.find((a) => a.event_type === 'bank_statement_ai_fallback_insufficient_fields');
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    const d = await drafts(up.documentId);
    const doc = await row('fdh_statement_uploads', up.documentId);
    const after = await ledger();
    check('B4 the model was called (billed, evidence recorded) but its reading had no transaction: insufficient_fields, no draft, no transactions, document rejected',
      notUsable?.metadata?.reason === 'insufficient_fields' && !!insuff?.metadata?.ai_model && d.length === 0 && tx.length === 0 && doc.processing_status === 'rejected' && proc.json?.data?.pipeline_status !== 'ai_fallback_available' && Number(after.reserved_usd) === Number(before.reserved_usd),
      JSON.stringify({ reason: notUsable?.metadata?.reason, evidence: insuff?.metadata ?? null, drafts: d.length, tx: tx.length, p: doc.processing_status }));
    evidence.b4 = { documentId: up.documentId, reason: notUsable?.metadata?.reason, settledDeltaUsd: Number(after.settled_usd) - Number(before.settled_usd) };
  }

  // ---------------------------------------------- statement types (CSV only)
  async function statementUpload(u: U, route: string, params: Record<string, string>, bytes: Buffer) {
    const up = await uploadRaw(u, route, params, bytes, 'text/csv');
    let res = up.upload;
    if (res.json?.data?.pipeline_status === 'pending_scan') res = await app(u, `/api/financial-data-hub/${route}/${up.documentId}/process`, { method: 'POST', json: params });
    return { ...up, res };
  }

  async function statementJourney(opts: {
    tag: string; route: string; params: Record<string, string>; bytes: Buffer; draftType: string;
    readyEvent: string; checkDraft: (d: any) => [boolean, string]; confirmBody: (d: any) => unknown;
    statementTable: string; checkEvidence: (statementId: string) => Promise<[boolean, string]>;
  }) {
    const { tag } = opts;
    const before = await ledger();
    const up = await statementUpload(pilot, opts.route, opts.params, opts.bytes);
    check(`${tag} upload accepted and the real GuardDuty scan is clean`, up.upload.status === 200 && up.doc?.malware_scan_status === 'clean', JSON.stringify({ http: up.upload.status, scan: up.doc?.malware_scan_status, waitMs: up.scanWaitMs }));
    const draft = up.res.json?.data?.ai_fallback_draft;
    const trail = await audits(up.documentId);
    check(`${tag} the deterministic CSV parser could not read it and the AI fallback produced a draft`, up.res.status === 200 && up.res.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft,
      `${up.res.status} ${JSON.stringify({ p: up.res.json?.data?.pipeline_status, f: up.res.json?.data?.failure_kind, trail: trail.map((a) => a.event_type) }).slice(0, 400)}`);
    const [draftOk, draftDetail] = draft ? opts.checkDraft(draft) : [false, 'no draft'];
    check(`${tag} draft equals the hand-computed values`, draftOk, draftDetail);
    const ready = trail.find((a) => a.event_type === opts.readyEvent);
    const dRows = await drafts(up.documentId);
    check(`${tag} the draft is persisted server-side (0197) before review, pending, linked to its metered call`, dRows.length === 1 && dRows[0].status === 'pending_review' && dRows[0].document_type === opts.draftType && dRows[0].provider_idempotency_key === ready?.metadata?.ai_cost_key, JSON.stringify(dRows.map((d) => ({ s: d.status, t: d.document_type }))));
    const stMid = await rows(opts.statementTable, `statement_upload_id=eq.${up.documentId}`, 'id');
    const docMid = await row('fdh_statement_uploads', up.documentId);
    check(`${tag} nothing written before review (no statement evidence; document still queued)`, stMid.length === 0 && ['queued', 'uploaded'].includes(docMid.processing_status), JSON.stringify({ st: stMid.length, p: docMid.processing_status }));
    // A repeated /process returns the SAME server-issued draft and never pays again.
    const again = await app(pilot, `/api/financial-data-hub/${opts.route}/${up.documentId}/process`, { method: 'POST', json: opts.params });
    const midLedger = await ledger();
    const spend = await spendEvidence(before, ready?.metadata);
    checkSpend(tag, spend);
    check(`${tag} a repeated /process returns the pending draft without a second provider call`, again.json?.data?.pipeline_status === 'ai_fallback_available' && Number(midLedger.total_attempts) === Number(before.total_attempts) + 1, JSON.stringify({ p: again.json?.data?.pipeline_status, attempts: [before.total_attempts, midLedger.total_attempts] }));
    const mask = await maskingEvidence(tag, await csvText(opts.bytes), draft, dRows[0]?.payload, trail);

    const confirm = await app(pilot, `/api/financial-data-hub/${opts.route}/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: opts.confirmBody(draft) });
    check(`${tag} the user confirms through the normal confirm route, with the exact body the panel sends`, confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 200)}`);
    const replay = await app(pilot, `/api/financial-data-hub/${opts.route}/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: opts.confirmBody(draft) });
    const st = await rows(opts.statementTable, `statement_upload_id=eq.${up.documentId}`, 'id');
    const [evOk, evDetail] = st.length === 1 ? await opts.checkEvidence(st[0].id) : [false, `statements=${st.length}`];
    check(`${tag} exactly one evidence write with the confirmed figures; a replayed confirm is refused (409) and writes nothing`, st.length === 1 && evOk && replay.status === 409, `${evDetail} replay=${replay.status} statements=${st.length}`);
    const dAfter = await drafts(up.documentId);
    check(`${tag} the draft was claimed exactly once`, dAfter.length === 1 && dAfter[0].status === 'confirmed', JSON.stringify(dAfter.map((d) => d.status)));
    const purge = await purgeAndVerify(tag, pilot, up.documentId);
    evidence[tag] = { documentId: up.documentId, spend, mask, confirm: confirm.status, replay: replay.status, evidence: evDetail, purge };
  }

  if (want('liability')) {
    console.log('\n--- L1 credit-card statement (CSV only surface) the parser cannot read -> real GPT-4o mini -> confirm ---');
    const x = fx.LIABILITY_EXPECTED;
    const params = { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'OPL1' };
    await statementJourney({
      tag: 'L1', route: 'liability-statement', params, bytes: fx.liabilityLetterCsv(`${RUN}-l1`), draftType: 'liability_statement',
      readyEvent: 'liability_statement_ai_fallback_draft_ready',
      checkDraft: (d) => {
        const acts = d.activities as any[];
        const ok = acts.length === 3 && x.activities.every((e, i) => acts[i]?.activityType === e.type && acts[i]?.activityDate === e.date && near(acts[i]?.amount, e.amount))
          && near(d.header?.openingBalance, x.openingBalance) && near(d.header?.closingBalance, x.closingBalance)
          && acts.every((a) => !('sourceRowNumber' in a));
        return [ok, JSON.stringify({ acts: acts.map((a) => `${a.activityDate} ${a.activityType} ${a.amount}`), o: d.header?.openingBalance, c: d.header?.closingBalance })];
      },
      // LiabilityImportPanel.handleConfirmAiDraft (form figures left blank, so the AI-read header values are used).
      confirmBody: (d) => ({
        metadata: {
          statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'OPL1',
          statement_period_start: d.header?.statementPeriodStart || undefined, statement_period_end: d.header?.statementPeriodEnd || undefined,
          statement_date: d.header?.statementDate || undefined, due_date: d.header?.dueDate || undefined,
          opening_balance: d.header?.openingBalance, closing_balance: d.header?.closingBalance,
          credit_limit: d.header?.creditLimit, minimum_payment: d.header?.minimumPayment,
        },
        facilityType: 'credit_card', activities: d.activities, aiWarnings: d.warnings,
      }),
      statementTable: 'fdh_liability_statements',
      checkEvidence: async (sid) => {
        const acts = await rows('fdh_liability_statement_activities', `statement_id=eq.${sid}`, 'activity_type,amount');
        const st = await row('fdh_liability_statements', sid, 'reconciliation_status');
        const sum = (t: string) => acts.filter((a) => a.activity_type === t).reduce((s, a) => s + Math.abs(Number(a.amount)), 0);
        return [acts.length === 3 && near(sum('PURCHASE'), x.purchases) && near(sum('PAYMENT'), x.payments), JSON.stringify({ acts: acts.length, purchases: sum('PURCHASE'), payments: sum('PAYMENT'), recon: st?.reconciliation_status })];
      },
    });
  }

  if (want('retirement')) {
    console.log('\n--- R1 super statement (CSV only surface) the parser cannot read -> real GPT-4o mini -> confirm ---');
    const x = fx.RETIREMENT_EXPECTED;
    const params = { jurisdiction: 'AU', currency_code: 'AUD', fund_name: 'Imaginary Super Fund', masked_account_identifier: 'OPR1', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' };
    await statementJourney({
      tag: 'R1', route: 'retirement-statement', params, bytes: fx.retirementLetterCsv(`${RUN}-r1`), draftType: 'retirement_statement',
      readyEvent: 'retirement_statement_ai_fallback_draft_ready',
      checkDraft: (d) => {
        const got = (d.activities as any[]).map((a) => `${a.activityType}:${Number(a.amount).toFixed(2)}`).sort();
        const want = x.activities.map((a) => `${a.type}:${a.amount}`).sort();
        const internal = ['parserName', 'parserVersion', 'extractionConfidence', 'warnings', 'ytdEmployerContributions'].filter((k) => k in d);
        return [JSON.stringify(got) === JSON.stringify(want) && Number(d.openingBalance) === Number(x.openingBalance) && Number(d.closingBalance) === Number(x.closingBalance) && internal.length === 0,
          JSON.stringify({ got, o: d.openingBalance, c: d.closingBalance, internalKeys: internal })];
      },
      confirmBody: (d) => d, // RetirementStatementImportPanel posts the draft verbatim.
      statementTable: 'fdh_retirement_statements',
      checkEvidence: async (sid) => {
        const acts = await rows('fdh_retirement_statement_activities', `statement_id=eq.${sid}`, 'activity_type,amount');
        const st = await row('fdh_retirement_statements', sid, 'reconciliation_status,closing_balance,opening_balance');
        const got = acts.map((a) => `${a.activity_type}:${Number(a.amount).toFixed(2)}`).sort();
        const want = x.activities.map((a) => `${a.type}:${a.amount}`).sort();
        return [JSON.stringify(got) === JSON.stringify(want) && Number(st?.closing_balance) === Number(x.closingBalance), JSON.stringify({ got, st })];
      },
    });
  }

  if (want('investment')) {
    console.log('\n--- I1 AU broker statement (CSV only surface) the parser cannot read -> real GPT-4o mini -> confirm ---');
    const x = fx.INVESTMENT_EXPECTED;
    const params = { csv_kind: 'transaction', currency_code: 'AUD', institution_name: 'Imaginary Broking', masked_account_identifier: 'OPI1' };
    await statementJourney({
      tag: 'I1', route: 'investment-statement', params, bytes: fx.investmentLetterCsv(`${RUN}-i1`), draftType: 'investment_statement',
      readyEvent: 'investment_statement_ai_fallback_draft_ready',
      checkDraft: (d) => {
        const acts = d.activities as any[];
        const buy = acts.find((a) => a.transactionType === 'BUY');
        const div = acts.find((a) => String(a.transactionType).includes('DIVIDEND'));
        const ok = acts.length === 2 && !!buy && !!div && buy.tradeDate === x.buy.date && Number(buy.quantity) === 50 && Number(buy.unitPrice) === 40 && Number(buy.amount) === 2000 && Number(buy.brokerageRaw) === 9.95
          && div.tradeDate === x.dividend.date && Number(div.amount) === 120;
        return [ok, JSON.stringify(acts.map((a) => `${a.tradeDate} ${a.transactionType} q=${a.quantity} p=${a.unitPrice} amt=${a.amount} brk=${a.brokerageRaw}`))];
      },
      // AuInvestmentStatementImportPanel.handleConfirmAiDraft.
      confirmBody: (d) => ({ csv_kind: 'transaction', holdings: d.holdings, activities: d.activities, institutionName: 'Imaginary Broking', maskedAccountIdentifier: 'OPI1', statementDate: d.statementDate, statementPeriodStart: d.statementPeriodStart, statementPeriodEnd: d.statementPeriodEnd }),
      statementTable: 'fdh_investment_statements',
      checkEvidence: async (sid) => {
        const acts = await rows('fdh_investment_statement_activities', `statement_id=eq.${sid}`, 'activity_type,amount,quantity');
        const amt = (t: string) => acts.filter((a) => String(a.activity_type).includes(t)).reduce((s, a) => s + Math.abs(Number(a.amount)), 0);
        return [acts.length === 2 && amt('BUY') === 2000 && amt('DIVIDEND') === 120, JSON.stringify({ acts: acts.length, buy: amt('BUY'), dividend: amt('DIVIDEND') })];
      },
    });
  }

  /** A figure that does not reconcile stays unresolved: the model reports the
   * printed closing, and after the user confirms, the statement's own
   * reconciliation is NOT 'reconciled'. */
  async function nonReconciling(tag: string, route: string, params: Record<string, string>, bytes: Buffer, table: string, printedClosing: number, draftClosing: (d: any) => unknown, confirmBody: (d: any) => unknown) {
    const up = await statementUpload(pilot, route, params, bytes);
    const draft = up.res.json?.data?.ai_fallback_draft;
    check(`${tag} the AI reports the closing balance AS PRINTED (${printedClosing}), not the arithmetic result`, !!draft && near(draftClosing(draft), printedClosing), JSON.stringify({ p: up.res.json?.data?.pipeline_status, closing: draft ? draftClosing(draft) : null }));
    const confirm = await app(pilot, `/api/financial-data-hub/${route}/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: confirmBody(draft) });
    const st = await rows(table, `statement_upload_id=eq.${up.documentId}`, 'id,reconciliation_status');
    check(`${tag} after confirm the statement's reconciliation is NOT reconciled (the 12.50 gap stays unresolved; nothing is balanced)`, confirm.status === 200 && st.length === 1 && st[0].reconciliation_status !== 'reconciled' && !!st[0].reconciliation_status,
      JSON.stringify({ confirm: confirm.status, st }));
    evidence[tag] = { documentId: up.documentId, closing: draft ? draftClosing(draft) : null, reconciliation: st[0]?.reconciliation_status ?? null };
  }

  if (want('liability-nonrecon')) {
    console.log('\n--- L2 liability: a printed closing that does not reconcile stays unresolved ---');
    const params = { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'OPL2' };
    await nonReconciling('L2', 'liability-statement', params, fx.liabilityLetterCsv(`${RUN}-l2`, { closingPrinted: '440.00' }), 'fdh_liability_statements', fx.LIABILITY_NON_RECONCILING_PRINTED_CLOSING,
      (d) => d.header?.closingBalance,
      (d) => ({ metadata: { ...params, opening_balance: d.header?.openingBalance, closing_balance: d.header?.closingBalance }, facilityType: 'credit_card', activities: d.activities, aiWarnings: d.warnings }));
  }
  if (want('retirement-nonrecon')) {
    console.log('\n--- R2 retirement: a printed closing that does not reconcile stays unresolved ---');
    const params = { jurisdiction: 'AU', currency_code: 'AUD', fund_name: 'Imaginary Super Fund', masked_account_identifier: 'OPR2', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' };
    await nonReconciling('R2', 'retirement-statement', params, fx.retirementLetterCsv(`${RUN}-r2`, { closingPrinted: fx.RETIREMENT_NON_RECONCILING_PRINTED_CLOSING }), 'fdh_retirement_statements', Number(fx.RETIREMENT_NON_RECONCILING_PRINTED_CLOSING),
      (d) => d.closingBalance, (d) => d);
  }

  if (want('outsiders')) {
    console.log('\n--- O1 statement types: a user outside the pilot cohort is refused AI, no spend, nothing written ---');
    const cases: Array<[string, string, Record<string, string>, Buffer, string, string]> = [
      ['liability', 'liability-statement', { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'OPO1' }, fx.liabilityLetterCsv(`${RUN}-o1`), 'liability_statement_ai_fallback_not_usable', 'fdh_liability_statements'],
      ['retirement', 'retirement-statement', { jurisdiction: 'AU', currency_code: 'AUD', fund_name: 'Imaginary Super Fund', masked_account_identifier: 'OPO2', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' }, fx.retirementLetterCsv(`${RUN}-o2`), 'retirement_statement_ai_fallback_not_usable', 'fdh_retirement_statements'],
      ['investment', 'investment-statement', { csv_kind: 'transaction', currency_code: 'AUD', institution_name: 'Imaginary Broking', masked_account_identifier: 'OPO3' }, fx.investmentLetterCsv(`${RUN}-o3`), 'investment_statement_ai_fallback_not_usable', 'fdh_investment_statements'],
    ];
    evidence.outsiders = {};
    for (const [label, route, params, bytes, event, table] of cases) {
      const before = await ledger();
      const up = await statementUpload(outsider, route, params, bytes);
      const trail = await audits(up.documentId);
      const nu = trail.find((a) => a.event_type === event);
      const after = await ledger();
      const st = await rows(table, `statement_upload_id=eq.${up.documentId}`, 'id');
      const d = await drafts(up.documentId);
      check(`O1 ${label} outsider: AI refused as cohort_denied (native failure AI-eligible), no provider attempt, no draft, no evidence written`,
        nu?.metadata?.reason === 'cohort_denied' && ['manual_mapping_required', 'ambiguous_format', 'layout_unsupported'].includes(nu?.metadata?.nativeFailureKind)
          && Number(after.total_attempts) === Number(before.total_attempts) && d.length === 0 && st.length === 0 && up.res.json?.data?.pipeline_status !== 'ai_fallback_available',
        JSON.stringify({ reason: nu?.metadata?.reason, native: nu?.metadata?.nativeFailureKind, attempts: [before.total_attempts, after.total_attempts], drafts: d.length, st: st.length, p: up.res.json?.data?.pipeline_status }));
      evidence.outsiders[label] = { documentId: up.documentId, reason: nu?.metadata?.reason, native: nu?.metadata?.nativeFailureKind };
    }
  }

  evidence.ledgerAfter = await ledger();
  evidence.totalSettledDeltaUsd = Number(evidence.ledgerAfter.settled_usd) - Number(evidence.ledgerBefore.settled_usd);
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(SCRATCH, { recursive: true });
  const out = path.join(SCRATCH, `${RUN}.evidence.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nrun settled delta: $${evidence.totalSettledDeltaUsd.toFixed(6)}   evidence: ${out}`);
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });
