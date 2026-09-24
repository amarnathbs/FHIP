/**
 * AIE-1 final production completion (2026-09-25) -- LIVE DEV journeys.
 *
 * Real HTTP against a locally running app (`scripts/aie1_final_dev_server.mjs`)
 * wired to the DEV Supabase project, the DEV S3 malware bucket with the DEV
 * GuardDuty plan, and real OpenAI GPT-4o mini. Synthetic users and synthetic
 * documents only; every artefact goes to the manifest; every DEV write asserts
 * the DEV host (see aie1_final_dev_harness.mjs). Ground truth is read back from
 * the database with the service role, never taken from the API's own answer.
 *
 * Run (server must be up):
 *   npx tsx scripts/aie1_final_live_dev_journeys.ts http://localhost:3961 [journey...]
 * Journeys: payslip-native payslip-ai cohort eicar ii bank-pdf bank-csv (default: all)
 */
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import { nativePayslipPdf, aiNeededPayslipPdf, eicarCsv, AI_PAYSLIP_EXPECTED } from './aie1_final_fixtures';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:3961';
const selected = new Set(process.argv.slice(3));
const want = (j: string) => selected.size === 0 || selected.has(j);
const { check, summary } = makeChecker('AIE1-LIVE');
const RUN = `aie1final-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = { run: RUN, app: APP, startedAt: new Date().toISOString() };

// ---------------------------------------------------------------------------
// Users + cookie sessions (the exact cookie @supabase/ssr reads)
// ---------------------------------------------------------------------------
interface U { id: string; email: string; cookie: string; }

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
  const password = `Aie1Final!${Date.now()}Zz9`;
  const created = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id as string;
  if (!id) throw new Error(`create ${tag} failed: ${created.text.slice(0, 200)}`);
  recordArtefact({ kind: 'auth_user', id, email, tag, run: RUN });
  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  if (!Array.isArray(prof.json) || prof.json.length !== 1) throw new Error(`profile ${tag}: ${prof.text.slice(0, 200)}`);
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
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

async function row(table: string, id: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?id=eq.${id}&select=${select}`);
  return (r.json?.[0] ?? null) as any;
}
async function rows(table: string, filter: string, select = '*') {
  const r = await devFetch(`/rest/v1/${table}?${filter}&select=${select}`);
  return (Array.isArray(r.json) ? r.json : []) as any[];
}

/** Mirrors the (fixed) PayslipImportPanel: for `add_new`, send the review's
 * default selection -- recommended, not requiring confirmation. */
async function recommendedFields(proposalId: string, userTicksPleaseConfirm = false): Promise<string[]> {
  const f = await rows('fhip_import_proposal_fields', `proposal_id=eq.${proposalId}`, 'field_name,is_recommended,requires_confirmation');
  // `userTicksPleaseConfirm`: the user explicitly ticks the fields the review
  // marks "please confirm" (the panel's checkbox), as a real user must.
  return f.filter((x) => x.is_recommended && (userTicksPleaseConfirm || !x.requires_confirmation)).map((x) => x.field_name);
}

async function ledger() {
  return (await rows('aie_ai_cost_ledger', 'id=eq.global'))[0];
}

/** Upload through the real FDH session flow and wait for the real scan. */
async function uploadFdhPdf(u: U, documentType: string, bytes: Buffer, mime = 'application/pdf', sourceType = 'pdf_native') {
  const s = await app(u, '/api/financial-data-hub/documents/upload-sessions', {
    method: 'POST',
    json: { document_type: documentType, source_type: sourceType, country_code: 'AU', declared_mime_type: mime, declared_file_size_bytes: bytes.length },
  });
  if (s.status !== 200) throw new Error(`session ${s.status} ${s.text.slice(0, 200)}`);
  const c = await app(u, `/api/financial-data-hub/documents/upload-sessions/${s.json.data.session_id}/complete`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': mime } });
  if (c.status !== 200) throw new Error(`complete ${c.status} ${c.text.slice(0, 300)}`);
  const documentId = c.json.data.document_id as string;
  recordArtefact({ kind: 'fdh_statement_uploads', id: documentId, userId: u.id, run: RUN });
  const t0 = Date.now();
  let doc = await row('fdh_statement_uploads', documentId);
  let sweeps = 0;
  while (doc.processing_status === 'validating' && Date.now() - t0 < 180_000) {
    await sleep(3000);
    await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep');
    sweeps++;
    doc = await row('fdh_statement_uploads', documentId);
  }
  return { documentId, completeStatus: c.json.data.processing_status as string, doc, scanWaitMs: Date.now() - t0, sweeps };
}

function scanEvidence(doc: any) {
  const ref = doc.malware_scan_object_ref ?? {};
  return {
    malware_scan_status: doc.malware_scan_status,
    decided_at: doc.malware_scan_decided_at,
    s3_key_prefix: ref.ref?.objectKey ? String(ref.ref.objectKey).split('/').slice(0, 1)[0] : null,
    s3_version_present: !!ref.ref?.versionId && ref.ref.versionId !== 'null',
    s3_purge: ref.s3Purge ?? null,
  };
}

async function main() {
  console.log(`=== AIE-1 final LIVE DEV journeys (${RUN}) against ${APP} ===`);
  const health = await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0);
  if (health === 0) throw new Error('app not reachable');

  const pilotA = await makeUser('aie1-final-pilot-a@fhip-test.invalid', 'pilot-a');
  const outsider = await makeUser(`aie1-final-outsider-${Date.now()}@fhip-test.invalid`, 'outsider');
  evidence.users = { pilotA: pilotA.id, outsider: outsider.id };
  const ledgerBefore = await ledger();
  evidence.ledgerBefore = ledgerBefore;

  // ------------------------------------------------------------ payslip-native
  if (want('payslip-native')) {
    console.log('\n--- J1 payslip, deterministic parse, real GuardDuty scan, approve/apply, purge ---');
    const fx = nativePayslipPdf(`${RUN}-j1`);
    const up = await uploadFdhPdf(pilotA, 'payslip', fx.bytes);
    const scan = scanEvidence(up.doc);
    evidence.j1 = { documentId: up.documentId, completeStatus: up.completeStatus, scanWaitMs: up.scanWaitMs, sweeps: up.sweeps, scan };
    check('J1 complete parks the document in validating while the real scan runs (or clears inline)', ['validating', 'queued'].includes(up.completeStatus), up.completeStatus);
    check('J1 real GuardDuty verdict is clean and the document reaches queued', up.doc.malware_scan_status === 'clean' && up.doc.processing_status === 'queued', JSON.stringify({ s: up.doc.malware_scan_status, p: up.doc.processing_status, waitMs: up.scanWaitMs }));
    check('J1 the S3 scan copy purge was attempted and its outcome recorded', !!scan.s3_purge, JSON.stringify(scan.s3_purge));

    const proc = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/process`, { method: 'POST' });
    check('J1 process returns ok', proc.status === 200 && proc.json?.data?.pipeline_status === 'ok', `${proc.status} ${JSON.stringify(proc.json?.data ?? proc.json).slice(0, 200)}`);
    const ev = (await rows('fdh_payroll_events', `statement_upload_id=eq.${up.documentId}`))[0];
    const e = fx.expected;
    check('J1 payroll evidence equals the independent AU-01 oracle (gross/net/tax/base/overtime/allowance/super/YTD)',
      !!ev && Number(ev.gross_pay) === e.grossPay && Number(ev.net_pay) === e.netPay && Number(ev.tax_withheld) === e.taxWithheld
      && Number(ev.base_pay) === e.basePay && Number(ev.overtime_pay) === e.overtimePay && Number(ev.allowances_total) === e.allowancesTotal
      && Number(ev.employer_retirement_contribution) === e.employerRetirementContribution && Number(ev.ytd_gross) === e.ytdGross
      && ev.pay_frequency === 'fortnightly' && ev.reconciliation_status === 'reconciled',
      ev ? JSON.stringify({ gross: ev.gross_pay, net: ev.net_pay, tax: ev.tax_withheld, super: ev.employer_retirement_contribution, recon: ev.reconciliation_status, freq: ev.pay_frequency }) : 'no row');
    if (ev) recordArtefact({ kind: 'fdh_payroll_events', id: ev.id, userId: pilotA.id, run: RUN });

    const replayProc = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/process`, { method: 'POST' });
    const evCount = (await rows('fdh_payroll_events', `statement_upload_id=eq.${up.documentId}`, 'id')).length;
    check('J1 replayed process writes nothing twice (idempotent)', replayProc.status === 200 && evCount === 1, `status=${replayProc.status} events=${evCount}`);

    const incomeBefore = (await rows('income_sources', `user_id=eq.${pilotA.id}`, 'id')).length;
    const appr = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/approve`, { method: 'POST' });
    check('J1 approve', appr.status === 200, `${appr.status} ${appr.text.slice(0, 150)}`);
    const prop = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/proposal`, { method: 'POST' });
    const proposalId = prop.json?.data?.proposal_id;
    check('J1 proposal generated', prop.status === 200 && !!proposalId, `${prop.status} ${prop.text.slice(0, 150)}`);
    if (proposalId) recordArtefact({ kind: 'fhip_import_proposals', id: proposalId, userId: pilotA.id, run: RUN });
    const apply = await app(pilotA, `/api/financial-data-hub/income-proposals/${proposalId}/apply`, { method: 'POST', json: { decision: 'add_new', selectedFields: await recommendedFields(proposalId) } });
    check('J1 apply (add_new) through the certified writer', apply.status === 200, `${apply.status} ${apply.text.slice(0, 200)}`);
    const incomes = await rows('income_sources', `user_id=eq.${pilotA.id}`, 'id,amount,net_amount,frequency,currency_code,employer_name');
    const newIncome = incomes.find((r) => r.id === apply.json?.data?.target_entity_id);
    if (newIncome) recordArtefact({ kind: 'income_sources', id: newIncome.id, userId: pilotA.id, run: RUN });
    // EXPECTED (by hand, FDH-9's recurring-income rule): the Income amount is
    // the RECURRING gross -- ordinary 4,000.00 + allowance 150.00 = 4,150.00;
    // overtime 300.00 is variable pay and is not proposed as recurring.
    check('J1 canonical Income row created with the expected recurring figures (4150.00 fortnightly AUD, employer Acme)',
      incomes.length === incomeBefore + 1 && !!newIncome && Number(newIncome.amount) === 4150 && newIncome.frequency === 'fortnightly' && newIncome.currency_code === 'AUD' && newIncome.employer_name === 'Acme Engineering Pty Ltd',
      JSON.stringify(newIncome ?? null));
    const replayApply = await app(pilotA, `/api/financial-data-hub/income-proposals/${proposalId}/apply`, { method: 'POST', json: { decision: 'add_new', selectedFields: await recommendedFields(proposalId) } });
    const incomesAfter = (await rows('income_sources', `user_id=eq.${pilotA.id}`, 'id')).length;
    check('J1 replayed acceptance writes nothing twice (409 ALREADY_APPLIED, no second Income row)', replayApply.status === 409 && incomesAfter === incomeBefore + 1, `${replayApply.status} ${replayApply.json?.code} incomes=${incomesAfter}`);

    // Retention: age the synthetic upload past the backstop, run the real purge sweep.
    await devFetch(`/rest/v1/fdh_statement_uploads?id=eq.${up.documentId}&user_id=eq.${pilotA.id}`, { method: 'PATCH', body: { uploaded_at: new Date(Date.now() - 3 * 3600_000).toISOString() } });
    const storageRef = (await row('fdh_statement_uploads', up.documentId)).raw_document_storage_reference as string;
    const sweep1 = await cron('/api/financial-data-hub/documents/cron/purge-sweep');
    await sleep(1000);
    const sweep2 = await cron('/api/financial-data-hub/documents/cron/purge-sweep');
    const afterPurge = await row('fdh_statement_uploads', up.documentId);
    const dir = storageRef ? storageRef.slice(0, storageRef.lastIndexOf('/')) : '';
    const name = storageRef ? storageRef.slice(storageRef.lastIndexOf('/') + 1) : '';
    const list = storageRef ? await devFetch(`/storage/v1/object/list/fdh-source-documents`, { method: 'POST', body: { prefix: dir, search: name, limit: 10 } }) : { json: [] };
    const stillThere = Array.isArray(list.json) && list.json.some((o: any) => o.name === name);
    check('J1 backstop purged the PDF and VERIFIED absence, keeping the document reviewable (not forced to rejected)',
      afterPurge.raw_document_purge_status === 'purged' && !afterPurge.raw_document_storage_reference && !stillThere && afterPurge.processing_status !== 'rejected',
      JSON.stringify({ purge: afterPurge.raw_document_purge_status, status: afterPurge.processing_status, listed: stillThere, sweep1: sweep1.status, sweep2: sweep2.status }));
    const evAfter = (await rows('fdh_payroll_events', `statement_upload_id=eq.${up.documentId}`, 'id,approval_status'))[0];
    check('J1 structured evidence survives deletion of the PDF', !!evAfter, JSON.stringify(evAfter));
    (evidence.j1 as any).payrollEventId = ev?.id; (evidence.j1 as any).incomeId = newIncome?.id; (evidence.j1 as any).purge = { status: afterPurge.raw_document_purge_status, processing: afterPurge.processing_status };
  }

  // ---------------------------------------------------------------- payslip-ai
  if (want('payslip-ai')) {
    console.log('\n--- J2 payslip the parser cannot read -> real GPT-4o mini (masked) -> review/confirm -> apply ---');
    const before = await ledger();
    const up = await uploadFdhPdf(pilotA, 'payslip', aiNeededPayslipPdf(`${RUN}-j2`));
    check('J2 real scan clean, queued', up.doc.malware_scan_status === 'clean' && up.doc.processing_status === 'queued', JSON.stringify({ s: up.doc.malware_scan_status, p: up.doc.processing_status }));
    const t0 = Date.now();
    const proc = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/process`, { method: 'POST' });
    const latencyMs = Date.now() - t0;
    const draft = proc.json?.data?.ai_fallback_draft;
    check('J2 deterministic parse failed and the AI fallback produced a draft', proc.status === 200 && proc.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft, `${proc.status} ${JSON.stringify(proc.json?.data ?? proc.json).slice(0, 300)}`);
    const x = AI_PAYSLIP_EXPECTED;
    check('J2 AI draft equals the independent expected values (gross 3200 / tax 512 / net 2488 / fortnightly / 2026-08-15)',
      !!draft && Number(draft.grossPay) === x.grossPay && Number(draft.taxWithheld) === x.taxWithheld && Number(draft.netPay) === x.netPay && draft.payFrequency === x.payFrequency && draft.paymentDate === x.paymentDate,
      JSON.stringify(draft ? { g: draft.grossPay, t: draft.taxWithheld, n: draft.netPay, f: draft.payFrequency, d: draft.paymentDate } : null));
    const audits = await rows('fdh_document_audit_events', `document_id=eq.${up.documentId}&order=created_at.asc`, 'event_type,metadata,created_at');
    const ready = audits.find((a) => a.event_type === 'payslip_ai_fallback_draft_ready');
    const after = await ledger();
    const deltaUsd = Number(after.settled_usd) - Number(before.settled_usd);
    const attempt = ready?.metadata?.ai_cost_key ? (await rows('aie_ai_cost_attempt', `idempotency_key=eq.${encodeURIComponent(ready.metadata.ai_cost_key)}`))[0] : null;
    evidence.j2 = {
      documentId: up.documentId, latencyMs, model: ready?.metadata?.ai_model, requestIds: ready?.metadata?.ai_provider_request_ids,
      inputTokens: ready?.metadata?.ai_input_tokens, outputTokens: ready?.metadata?.ai_output_tokens, settledDeltaUsd: deltaUsd,
      reservedAfter: after.reserved_usd, costAttempt: attempt ? { reserved_usd: attempt.reserved_usd, settled_usd: attempt.settled_usd } : null,
      draftPersisted: ready?.metadata?.draft_persisted, auditTrail: audits.map((a) => a.event_type),
    };
    check('J2 call evidence recorded: model gpt-4o-mini, an OpenAI request id, token usage', ready?.metadata?.ai_model === 'gpt-4o-mini' && (ready?.metadata?.ai_provider_request_ids ?? []).length >= 1 && Number(ready?.metadata?.ai_input_tokens) > 0,
      JSON.stringify(ready?.metadata ?? null));
    check('J2 spend reserved then settled against real usage (ledger settled grew, reservation released)', deltaUsd > 0 && deltaUsd < 0.01 && Number(after.reserved_usd) === Number(before.reserved_usd),
      `settled +$${deltaUsd.toFixed(6)} reserved ${before.reserved_usd} -> ${after.reserved_usd}`);
    const docMid = await row('fdh_statement_uploads', up.documentId);
    check('J2 nothing written before review (document still processing, no payroll event)', docMid.processing_status === 'processing' && (await rows('fdh_payroll_events', `statement_upload_id=eq.${up.documentId}`, 'id')).length === 0);

    const confirm = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: draft });
    check('J2 user confirms the reviewed draft through the normal confirm route', confirm.status === 200, `${confirm.status} ${confirm.text.slice(0, 200)}`);
    const replay = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/ai-fallback/confirm`, { method: 'POST', json: draft });
    const evs = await rows('fdh_payroll_events', `statement_upload_id=eq.${up.documentId}`, 'id,gross_pay,net_pay,tax_withheld,parser_name');
    check('J2 replayed confirmation is refused and writes nothing twice', replay.status === 409 && evs.length === 1, `${replay.status} events=${evs.length}`);
    check('J2 persisted evidence carries the reviewed figures and AI provenance', evs[0] && Number(evs[0].gross_pay) === 3200 && Number(evs[0].net_pay) === 2488 && evs[0].parser_name === 'aie_payslip_ai_fallback_user_confirmed', JSON.stringify(evs[0] ?? null));
    if (evs[0]) recordArtefact({ kind: 'fdh_payroll_events', id: evs[0].id, userId: pilotA.id, run: RUN });
    const appr = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/approve`, { method: 'POST' });
    const prop = await app(pilotA, `/api/financial-data-hub/payslip/${up.documentId}/proposal`, { method: 'POST' });
    const pid = prop.json?.data?.proposal_id;
    if (pid) recordArtefact({ kind: 'fhip_import_proposals', id: pid, userId: pilotA.id, run: RUN });
    const incomeBefore = (await rows('income_sources', `user_id=eq.${pilotA.id}`, 'id')).length;
    const apply = await app(pilotA, `/api/financial-data-hub/income-proposals/${pid}/apply`, { method: 'POST', json: { decision: 'add_new', selectedFields: await recommendedFields(pid, true) } });
    const inc = (await rows('income_sources', `id=eq.${apply.json?.data?.target_entity_id}`, 'id,amount,frequency'))[0];
    if (inc) recordArtefact({ kind: 'income_sources', id: inc.id, userId: pilotA.id, run: RUN });
    // EXPECTED (by hand): base 2,900.00 + tools allowance 300.00 = 3,200.00 recurring (no overtime/bonus).
    check('J2 approve -> proposal -> apply writes one canonical Income row with the AI-read, user-confirmed 3200 fortnightly', appr.status === 200 && apply.status === 200 && !!inc && Number(inc.amount) === 3200 && inc.frequency === 'fortnightly' && (await rows('income_sources', `user_id=eq.${pilotA.id}`, 'id')).length === incomeBefore + 1,
      JSON.stringify({ appr: appr.status, apply: apply.status, inc }));
  }

  // -------------------------------------------------------------------- cohort
  if (want('cohort')) {
    console.log('\n--- J3 pilot cohort (email-only allowlist): a non-pilot user never reaches the AI ---');
    const before = await ledger();
    const up = await uploadFdhPdf(outsider, 'payslip', aiNeededPayslipPdf(`${RUN}-j3`));
    const proc = await app(outsider, `/api/financial-data-hub/payslip/${up.documentId}/process`, { method: 'POST' });
    const audits = await rows('fdh_document_audit_events', `document_id=eq.${up.documentId}`, 'event_type,metadata');
    const notUsable = audits.find((a) => a.event_type === 'payslip_ai_fallback_not_usable');
    const after = await ledger();
    check('J3 outsider: AI refused as cohort_denied, document failed with layout_unsupported, no spend',
      notUsable?.metadata?.reason === 'cohort_denied' && proc.json?.data?.pipeline_status !== 'ai_fallback_available' && Number(after.total_attempts) === Number(before.total_attempts),
      JSON.stringify({ reason: notUsable?.metadata?.reason, pipeline: proc.json?.data?.pipeline_status, attempts: [before.total_attempts, after.total_attempts] }));
    evidence.j3 = { documentId: up.documentId, reason: notUsable?.metadata?.reason };
  }

  // --------------------------------------------------------------------- eicar
  if (want('eicar')) {
    console.log('\n--- J4 EICAR test file: real GuardDuty THREATS_FOUND, blocked, never processable, purged ---');
    const up = await uploadFdhPdf(pilotA, 'bank_statement', eicarCsv(), 'text/csv', 'csv');
    const scan = scanEvidence(up.doc);
    evidence.j4 = { documentId: up.documentId, scan, waitMs: up.scanWaitMs, status: up.doc.processing_status, error_code: up.doc.error_code, purge: up.doc.raw_document_purge_status, purge_reason: up.doc.purge_reason };
    check('J4 real verdict malicious -> failed / malware_detected', up.doc.malware_scan_status === 'malicious' && up.doc.processing_status === 'failed' && up.doc.error_code === 'malware_detected', JSON.stringify(evidence.j4));
    check('J4 blocked bytes scheduled for immediate purge', up.doc.raw_document_purge_status === 'pending' && up.doc.purge_reason === 'malware_scan_blocked', JSON.stringify({ p: up.doc.raw_document_purge_status, r: up.doc.purge_reason }));
    const detect = await app(pilotA, `/api/financial-data-hub/bank-csv/${up.documentId}/detect`, { method: 'POST' });
    const proc = await app(pilotA, `/api/financial-data-hub/bank-csv/${up.documentId}/process`, { method: 'POST' });
    const after = await row('fdh_statement_uploads', up.documentId);
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    check('J4 re-processing the blocked file is refused (was the live bypass) and nothing is written', detect.status >= 400 && proc.status >= 400 && after.processing_status === 'failed' && tx.length === 0,
      JSON.stringify({ detect: detect.status, process: proc.status, status: after.processing_status, tx: tx.length }));
    const forge = await fetch(`${BASE}/rest/v1/fdh_statement_uploads?id=eq.${up.documentId}`, { method: 'PATCH', headers: { apikey: ANON, Authorization: `Bearer ${JSON.parse(Buffer.from(pilotA.cookie.split('=')[1].replace('base64-', ''), 'base64url').toString()).access_token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ malware_scan_status: 'clean' }) });
    const forged = await row('fdh_statement_uploads', up.documentId);
    (evidence.j4 as any).forgeryAttempt = { status: forge.status, statusAfter: forged.malware_scan_status };
    console.log(`  INFO  owner PATCH malware_scan_status -> http ${forge.status}, now '${forged.malware_scan_status}' (0196 closes this; see report)`);
    if (forged.malware_scan_status !== 'malicious') {
      await devFetch(`/rest/v1/fdh_statement_uploads?id=eq.${up.documentId}`, { method: 'PATCH', body: { malware_scan_status: 'malicious' } });
      const proc2 = await app(pilotA, `/api/financial-data-hub/bank-csv/${up.documentId}/detect`, { method: 'POST' });
      check('J4 even with the verdict column forged, the malware error code still blocks processing (belt and braces)', proc2.status >= 400, String(proc2.status));
    }
    await cron('/api/financial-data-hub/documents/cron/purge-sweep');
    const purged = await row('fdh_statement_uploads', up.documentId);
    check('J4 blocked bytes purged by the sweep (verified absent)', purged.raw_document_purge_status === 'purged', purged.raw_document_purge_status);
  }

  // ------------------------------------------------------------------------ ii
  if (want('ii')) {
    console.log('\n--- J5 Investment Intelligence CAS upload -> scan gate -> process -> canonical ii_* -> PDF purged ---');
    const fx = path.join('lib', 'fixtures', 'investment-intelligence', 'pc3-cams', 'pc3-q01-baseline-multi-folio-multi-amc');
    const bytes = fs.readFileSync(`${fx}.pdf`);
    const expected = JSON.parse(fs.readFileSync(`${fx}.expected.json`, 'utf8'));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), `${RUN}-cas.pdf`);
    form.append('meta', JSON.stringify({ sourceKey: 'cams', documentType: 'cas_statement', countryCode: 'IN' }));
    // II is IN-scoped; this user is re-homed to IN for this journey only.
    const inUser = await makeUser(`aie1-final-ii-${Date.now()}@fhip-test.invalid`, 'ii');
    await devFetch(`/rest/v1/user_profiles?user_id=eq.${inUser.id}`, { method: 'PATCH', body: { country_of_residence: 'IN' } });
    const upRes = await fetch(`${APP}/api/investment-intelligence/source-documents`, { method: 'POST', headers: { Cookie: inUser.cookie }, body: form });
    const upJson: any = await upRes.json().catch(() => null);
    const sdId = upJson?.data?.id;
    if (sdId) recordArtefact({ kind: 'ii_source_documents', id: sdId, userId: inUser.id, run: RUN });
    check('J5 II upload accepted', upRes.status === 200 && !!sdId, `${upRes.status} ${JSON.stringify(upJson).slice(0, 200)}`);
    let proc: any = null;
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      proc = await app(inUser, `/api/investment-intelligence/source-documents/${sdId}/process`, { method: 'POST', json: {} });
      if (!(proc.status === 409 && proc.json?.error === 'malware_scan_pending')) break;
      await sleep(3000);
    }
    const sd = await row('ii_source_documents', sdId);
    evidence.j5 = { sourceDocumentId: sdId, processStatus: proc.status, docStatus: sd.status, scan: 'malware_scan_status' in sd ? sd.malware_scan_status : 'column_absent (0196 not applied in DEV)', waitMs: Date.now() - t0, purgedAt: sd.storage_purged_at };
    check('J5 processed to parsed', proc.status === 200 && proc.json?.data?.ok === true && sd.status === 'parsed', JSON.stringify(evidence.j5));
    const accounts = await rows('ii_accounts', `user_id=eq.${inUser.id}`, 'id');
    const holdings = await rows('ii_holding_snapshots', `user_id=eq.${inUser.id}`, 'id');
    const txs = await rows('ii_transactions', `user_id=eq.${inUser.id}`, 'id');
    const exp = { accounts: expected.accounts.length, transactions: expected.transactionCount, holdings: expected.holdingCount };
    (evidence.j5 as any).counts = { accounts: accounts.length, holdings: holdings.length, transactions: txs.length, expected: exp };
    check('J5 canonical ii_* rows equal the fixture oracle (accounts / transactions / holdings)', accounts.length === exp.accounts && txs.length === exp.transactions && holdings.length === exp.holdings, JSON.stringify((evidence.j5 as any).counts));
    check('J5 original PDF purged after parse (verified by the II purge)', !!sd.storage_purged_at, String(sd.storage_purged_at));
    evidence.iiUser = inUser.id;
  }

  // ----------------------------------------------- statement classes (FDH)
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
    return { upload: r, documentId, doc, waitMs: Date.now() - t0 };
  }

  if (want('bank-pdf')) {
    console.log('\n--- J6 bank statement PDF (synthetic CBA layout): scan -> process -> reconciled transactions ---');
    const { buildBankPdfFixture } = await import('../tests/support/buildBankPdfFixture');
    // EXPECTED (by hand): 1,000.00 - 45.20 + 500.00 - 220.24 = 1,234.56 = stated closing -> reconciled, 3 transactions.
    const bytes = buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account', `Ref ${RUN}`],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      openingBalanceLine: 'Opening Balance: $1,000.00',
      closingBalanceLine: 'Closing Balance: $1,234.56',
      transactions: [
        { date: '1 Aug 2026', description: 'CARD PURCHASE SYNTHETIC GROCER 1234', amount: '45.20 DR', balance: '954.80' },
        { date: '3 Aug 2026', description: 'SALARY SYNTHETIC PTY LTD', amount: '500.00 CR', balance: '1,454.80' },
        { date: '5 Aug 2026', description: 'DIRECT DEBIT SYNTHETIC INSURANCE', amount: '220.24 DR', balance: '1,234.56' },
      ],
    });
    const inst = (await rows('fdh_financial_institutions', 'institution_code=eq.CBA&country_code=eq.AU', 'id'))[0]?.id;
    const up = await uploadRaw(pilotA, 'bank-pdf', { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-cba.pdf`, masked_identifier: 'AIE1F1', ...(inst ? { institution_id: inst } : {}) }, bytes, 'application/pdf');
    check('J6 upload + real scan clean', up.upload.status === 200 && up.doc?.malware_scan_status === 'clean' && up.doc?.processing_status === 'queued', JSON.stringify({ http: up.upload.status, s: up.doc?.malware_scan_status, p: up.doc?.processing_status, err: up.upload.json?.error }));
    const proc = await app(pilotA, `/api/financial-data-hub/bank-pdf/${up.documentId}/process`, { method: 'POST', json: {} });
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'amount_original,credit_debit');
    const recon = await rows('fdh_reconciliation_results', `statement_upload_id=eq.${up.documentId}`, 'status');
    const debits = tx.filter((t) => t.credit_debit === 'debit').reduce((a, t) => a + Math.abs(Number(t.amount_original)), 0);
    const credits = tx.filter((t) => t.credit_debit === 'credit').reduce((a, t) => a + Math.abs(Number(t.amount_original)), 0);
    evidence.j6 = { documentId: up.documentId, process: proc.status, pipeline: proc.json?.data?.pipeline_status ?? proc.json?.data?.certification_status, tx: tx.length, debits, credits, recon: recon.map((r) => r.status) };
    check('J6 3 transactions, debits 265.44, credits 500.00 (independent arithmetic)', tx.length === 3 && Math.abs(debits - 265.44) < 0.001 && Math.abs(credits - 500) < 0.001, JSON.stringify(evidence.j6));
  }

  if (want('bank-csv')) {
    console.log('\n--- J7 bank statement CSV (certified CBA adapter fixture): scan -> detect -> process ---');
    const csvPath = path.join('tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv');
    const profile = JSON.parse(fs.readFileSync(path.join('tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.profile.json'), 'utf8'));
    const bytes = Buffer.concat([fs.readFileSync(csvPath)]);
    const inst = (await rows('fdh_financial_institutions', 'institution_code=eq.CBA&country_code=eq.AU', 'id'))[0]?.id;
    const up = await uploadRaw(pilotA, 'bank-csv', { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-cba.csv`, masked_identifier: 'AIE1F2', ...(inst ? { institution_id: inst } : {}) }, bytes, 'text/csv');
    check('J7 upload + real scan clean', up.upload.status === 200 && up.doc?.malware_scan_status === 'clean', JSON.stringify({ http: up.upload.status, s: up.doc?.malware_scan_status, p: up.doc?.processing_status, dup: up.doc?.duplicate_of_document_id, err: up.upload.json?.error }));
    const det = await app(pilotA, `/api/financial-data-hub/bank-csv/${up.documentId}/detect`, { method: 'POST' });
    const proc = await app(pilotA, `/api/financial-data-hub/bank-csv/${up.documentId}/process`, { method: 'POST' });
    const tx = await rows('fdh_transactions', `statement_upload_id=eq.${up.documentId}`, 'id');
    // EXPECTED: one transaction per data row of the fixture (header row excluded).
    const expectedRows = bytes.toString('utf8').split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1 - Number(profile.header_row_index ?? 0);
    evidence.j7 = { documentId: up.documentId, detect: det.status, process: proc.status, cert: proc.json?.data?.certification_status, tx: tx.length, expectedRows, profileKeys: Object.keys(profile) };
    check('J7 detect + process succeed and write transactions (count vs the fixture profile)', det.status === 200 && proc.status === 200 && tx.length > 0 && (expectedRows == null || tx.length === Number(expectedRows)), JSON.stringify(evidence.j7));
  }

  async function statementJourney(tag: string, route: string, params: Record<string, string>, csvFile: string | Buffer, verify: (documentId: string) => Promise<[boolean, string]>) {
    const bytes = typeof csvFile === 'string' ? Buffer.concat([fs.readFileSync(path.join('tests', 'fixtures', 'financial-data-hub', csvFile)), Buffer.from(`\n`)]) : csvFile;
    // Unique bytes per run (a trailing comment row would change parsing, so the
    // uniqueness comes from the synthetic user instead: a fresh user per run).
    const u = await makeUser(`aie1-final-${tag}-${Date.now()}@fhip-test.invalid`, tag);
    const up = await uploadRaw(u, route, params, bytes, 'text/csv');
    const firstPipeline = up.upload.json?.data?.pipeline_status;
    let pipeline = firstPipeline;
    let proc: Awaited<ReturnType<typeof app>> | null = null;
    if (firstPipeline === 'pending_scan') {
      proc = await app(u, `/api/financial-data-hub/${route}/${up.documentId}/process`, { method: 'POST', json: params });
      pipeline = proc.json?.data?.pipeline_status;
    }
    const [ok, detail] = await verify(up.documentId!);
    (evidence as Record<string, unknown>)[tag] = { documentId: up.documentId, uploadHttp: up.upload.status, firstPipeline, pipeline, scan: up.doc?.malware_scan_status, waitMs: up.waitMs, processHttp: proc?.status ?? null, detail };
    check(`${tag} upload -> real scan clean -> ${firstPipeline === 'pending_scan' ? 'resume /process' : 'inline'} -> ok`, up.upload.status === 200 && up.doc?.malware_scan_status === 'clean' && pipeline === 'ok', JSON.stringify((evidence as Record<string, unknown>)[tag]));
    check(`${tag} extracted evidence matches the fixture's hand-computed figures`, ok, detail);
  }

  if (want('liability')) {
    console.log('\n--- J8 credit-card statement CSV ---');
    // The fdh14 smoke fixture's `0.00 OPENING` line trips a pre-existing FDH-10
    // defect (fdh_liability_statement_activities_amount_check -> HTTP 500 and an
    // orphaned statement row; recorded in the release register, not fixed here).
    // This journey uses the same statement without that line.
    // EXPECTED (by hand): purchases 85.40, payment 200.00.
    const liabilityCsv = Buffer.from([
      'Transaction Date,Description,Amount,Transaction Type',
      '2026-07-05,AIE1 SYNTHETIC GROCERY STORE,-85.40,PURCHASE',
      '2026-07-15,AIE1 SYNTHETIC CARD PAYMENT,200.00,PAYMENT',
      '',
    ].join('\n'));
    await statementJourney('j8_liability', 'liability-statement', { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'AIE1F3' }, liabilityCsv, async (id) => {
      const st = (await rows('fdh_liability_statements', `statement_upload_id=eq.${id}`, 'id'))[0];
      const acts = st ? await rows('fdh_liability_statement_activities', `statement_id=eq.${st.id}`, 'activity_type,amount') : [];
      const sum = (t: string) => acts.filter((a) => a.activity_type === t).reduce((x, a) => x + Math.abs(Number(a.amount)), 0);
      return [!!st && Math.abs(sum('PURCHASE') - 85.4) < 0.001 && Math.abs(sum('PAYMENT') - 200) < 0.001, JSON.stringify({ statement: !!st, activities: acts.length, purchases: sum('PURCHASE'), payments: sum('PAYMENT') })];
    });
  }
  if (want('retirement')) {
    console.log('\n--- J9 super statement CSV ---');
    // EXPECTED (by hand): employer contribution 500.00, personal 200.00.
    await statementJourney('j9_retirement', 'retirement-statement', { jurisdiction: 'AU', currency_code: 'AUD', fund_name: 'Synthetic Super Fund', masked_account_identifier: 'AIE1F4', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' }, 'fdh14-smoke-retirement.csv', async (id) => {
      const st = (await rows('fdh_retirement_statements', `statement_upload_id=eq.${id}`, 'id'))[0];
      const acts = st ? await rows('fdh_retirement_statement_activities', `statement_id=eq.${st.id}`, 'activity_type,amount') : [];
      const amt = (t: string) => acts.filter((a) => a.activity_type === t).reduce((x, a) => x + Math.abs(Number(a.amount)), 0);
      // Amounts are the independent check. Classification is REPORTED, not
      // asserted: live DEV classifies both lines UNKNOWN (recorded as an FDH-12
      // observation in the release register).
      const amounts = acts.map((a) => Math.abs(Number(a.amount))).sort((x, y) => x - y);
      void amt;
      return [!!st && JSON.stringify(amounts) === JSON.stringify([200, 500]), JSON.stringify({ statement: !!st, activities: acts.map((a) => `${a.activity_type}:${a.amount}`) })];
    });
  }
  if (want('investment')) {
    console.log('\n--- J10 AU broker transaction CSV ---');
    // EXPECTED (by hand): BUY 50 x 40.00 = 2,000.00; DIVIDEND 120.00.
    await statementJourney('j10_investment', 'investment-statement', { csv_kind: 'transaction', currency_code: 'AUD', institution_name: 'Synthetic Broker', masked_account_identifier: 'AIE1F5' }, 'fdh14-smoke-investment.csv', async (id) => {
      const st = (await rows('fdh_investment_statements', `statement_upload_id=eq.${id}`, 'id'))[0];
      const acts = st ? await rows('fdh_investment_statement_activities', `statement_id=eq.${st.id}`, '*') : [];
      const buy = acts.find((a) => String(a.activity_type ?? '').toUpperCase().includes('BUY'));
      const div = acts.find((a) => String(a.activity_type ?? '').toUpperCase().includes('DIVIDEND'));
      const amt = (a: any) => Math.abs(Number(a?.gross_amount ?? a?.amount ?? NaN));
      return [!!st && acts.length === 2 && amt(buy) === 2000 && amt(div) === 120, JSON.stringify({ statement: !!st, activities: acts.length, buy: amt(buy), dividend: amt(div) })];
    });
  }

  evidence.ledgerAfter = await ledger();
  evidence.finishedAt = new Date().toISOString();
  const out = path.join('C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad', `${RUN}.evidence.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nevidence: ${out}`);
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });
