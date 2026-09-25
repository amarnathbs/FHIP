/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST/HTTP JSON read back for assertions */
/**
 * Re-upload and resume across every statement type (2026-09-25) -- LIVE DEV
 * journeys, real HTTP against this branch (`scripts/aie1_final_dev_server.mjs`
 * -- DEV Supabase, the DEV S3 + GuardDuty malware gate, every per-type AI flag
 * on, real GPT-4o mini for the pilot cohort shape).
 *
 * Per type: upload -> process -> reload/resume (the panel's own data source,
 * GET /waiting-imports, and a repeated /process) -> re-upload of the SAME
 * bytes (must lead to the original, with no second AI call, no second read
 * and no second canonical write) -> confirm/apply EXACTLY once -> a later
 * re-upload is told it was already applied.
 *
 * Synthetic users and documents only; every artefact goes to the manifest;
 * every DEV write asserts the DEV host; ground truth is read back from the
 * database with the service role, never taken from the API's own answer. No
 * document text is printed or saved.
 *
 * Run (server up on :3971):
 *   AIE1_MANIFEST=<scratch>/resume_dup_manifest.jsonl \
 *     npx tsx scripts/upload_resume_duplicates_live_dev_journeys.ts http://localhost:3971 [bank liability retirement investment bankcsv]
 */
import fs from 'node:fs';
import path from 'node:path';
import { devFetch, BASE, ANON, env, recordArtefact, makeChecker, assertDev } from './aie1_final_dev_harness.mjs';
import * as fx from './aie1_other_pdf_fixtures';
import { normaliseProposedFields } from '../lib/import-bridge/proposedFieldShape';

const APP = process.argv[2] ?? 'http://localhost:3971';
const selected = new Set(process.argv.slice(3));
const want = (j: string) => selected.size === 0 || selected.has(j);
const { check, summary } = makeChecker('RESUME-DUP');
const RUN = `resumedup-${Date.now()}`;
const REF = new URL(BASE).host.split('.')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, any> = { run: RUN, app: APP, startedAt: new Date().toISOString() };
const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/resumedup';
const PILOT_EMAIL = 'aie1-final-pilot-a@fhip-test.invalid';

interface U { id: string; email: string; cookie: string }

/** Same content, whatever the key order (a jsonb column reorders keys). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sameDraft = (a: unknown, b: unknown) => !!a && !!b && canon(a) === canon(b);

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
  const password = `ResumeDup!${Date.now()}Zz9`;
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
async function attempts(): Promise<number> { return Number((await rows('aie_ai_cost_ledger', 'id=eq.global'))[0]?.total_attempts ?? NaN); }
async function settled(): Promise<number> { return Number((await rows('aie_ai_cost_ledger', 'id=eq.global'))[0]?.settled_usd ?? NaN); }
async function audits(documentId: string) { return rows('fdh_document_audit_events', `document_id=eq.${documentId}&order=created_at.asc`, 'event_type'); }
async function waiting(u: U, kind: string) {
  const r = await app(u, `/api/financial-data-hub/waiting-imports?kind=${kind}`);
  return (r.json?.data?.items ?? []) as any[];
}

/** Raw-body upload through a class route, then wait out the real scan. */
async function uploadRaw(u: U, route: string, params: Record<string, string>, bytes: Buffer, mime: string) {
  const qs = new URLSearchParams(params).toString();
  const r = await app(u, `/api/financial-data-hub/${route}/upload?${qs}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length) } });
  // The copy's OWN id: for a statement upload the response's document_id is
  // now the original's, so the copy is found by its newest row instead.
  const uploads = await rows('fdh_statement_uploads', `user_id=eq.${u.id}&order=created_at.desc&limit=1`, 'id');
  const ownId = uploads[0]?.id as string;
  recordArtefact({ kind: 'fdh_statement_uploads', id: ownId, userId: u.id, run: RUN });
  let doc = await row('fdh_statement_uploads', ownId);
  const t0 = Date.now();
  while (doc && doc.processing_status === 'validating' && Date.now() - t0 < 180_000) {
    await sleep(3000);
    await cron('/api/financial-data-hub/documents/cron/malware-scan-sweep');
    doc = await row('fdh_statement_uploads', ownId);
  }
  return { upload: r, ownId, doc };
}
/** Upload, then (as the panel does) finish through /process if the scan deferred it. */
async function statementUpload(u: U, route: string, params: Record<string, string>, bytes: Buffer) {
  const up = await uploadRaw(u, route, params, bytes, 'text/csv');
  let res = up.upload;
  if (res.json?.data?.pipeline_status === 'pending_scan') res = await app(u, `/api/financial-data-hub/${route}/${up.ownId}/process`, { method: 'POST', json: params });
  return { ...up, res };
}
const readEvents = new Set(['pdf_native_extraction_started', 'bank_csv_detection_completed', 'liability_statement_ai_fallback_attempted', 'retirement_statement_ai_fallback_attempted', 'investment_statement_ai_fallback_attempted', 'bank_statement_ai_fallback_attempted', 'liability_statement_extraction_failed', 'retirement_statement_extraction_failed', 'investment_statement_extraction_failed']);
async function wasRead(documentId: string) { return (await audits(documentId)).some((a) => readEvents.has(a.event_type)); }

async function main() {
  console.log(`=== re-upload and resume LIVE DEV journeys (${RUN}) against ${APP} ===`);
  if ((await fetch(`${APP}/login`).then((r) => r.status).catch(() => 0)) === 0) throw new Error('app not reachable');
  const pilot = await makeUser(PILOT_EMAIL, 'pilot-a');
  evidence.user = pilot.id;
  evidence.settledBefore = await settled();
  evidence.attemptsBefore = await attempts();
  const cba = (await rows('fdh_financial_institutions', 'institution_code=eq.CBA&country_code=eq.AU', 'id'))[0]?.id as string | undefined;

  // ------------------------------------------------------------ bank PDF
  if (want('bank')) {
    console.log('\n--- BANK PDF: AI reading -> resume -> re-upload -> confirm once -> re-upload after import ---');
    const bytes = fx.bankLetterPdf(`${RUN}-bk`);
    const params = { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-bk.pdf`, masked_identifier: 'RDB1', ...(cba ? { institution_id: cba } : {}) };
    const a0 = await attempts();
    const up1 = await uploadRaw(pilot, 'bank-pdf', params, bytes, 'application/pdf');
    const p1 = await app(pilot, `/api/financial-data-hub/bank-pdf/${up1.ownId}/process`, { method: 'POST', json: {} });
    const draft = p1.json?.data?.ai_fallback_draft;
    const a1 = await attempts();
    check('BANK first upload: the parser could not read it, the AI read a draft (one metered call)', p1.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft && a1 === a0 + 1, JSON.stringify({ p: p1.json?.data?.pipeline_status, attempts: [a0, a1] }));

    const w = await waiting(pilot, 'bank');
    const again = await app(pilot, `/api/financial-data-hub/bank-pdf/${up1.ownId}/process`, { method: 'POST', json: {} });
    check('BANK resume after a reload: the waiting list offers the reading (with its content), and /process returns it instead of refusing the parked document',
      w.some((i) => i.document_id === up1.ownId && i.stage === 'ai_draft' && sameDraft(i.ai_fallback_draft, draft))
        && again.status === 200 && again.json?.data?.pipeline_status === 'ai_fallback_available' && (await attempts()) === a1,
      JSON.stringify({ listed: w.map((i) => [i.document_id === up1.ownId, i.stage]), again: [again.status, again.json?.data?.pipeline_status] }));

    const up2 = await uploadRaw(pilot, 'bank-pdf', params, bytes, 'application/pdf');
    const p2 = await app(pilot, `/api/financial-data-hub/bank-pdf/${up2.ownId}/process`, { method: 'POST', json: {} });
    check('BANK re-upload of the same bytes: the upload is flagged as a copy of the original, processing carries on with the ORIGINAL reading -- no second AI call, the copy is never read',
      up2.upload.json?.data?.duplicate_of_document_id === up1.ownId && p2.json?.data?.pipeline_status === 'ai_fallback_available' && p2.json?.data?.document_id === up1.ownId
        && sameDraft(p2.json?.data?.ai_fallback_draft, draft) && (await attempts()) === a1 && !(await wasRead(up2.ownId)),
      JSON.stringify({ flagged: up2.upload.json?.data?.duplicate_of_document_id === up1.ownId, p: p2.json?.data?.pipeline_status, docIsOriginal: p2.json?.data?.document_id === up1.ownId }));

    // The panel confirms against the document id the response carried (the original).
    const body = { rows: draft.rows, statementPeriodStart: draft.statementPeriodStart, statementPeriodEnd: draft.statementPeriodEnd, declaredOpeningBalance: draft.declaredOpeningBalance, declaredClosingBalance: draft.declaredClosingBalance, maskedAccountIdentifier: draft.maskedAccountIdentifier };
    const confirm = await app(pilot, `/api/financial-data-hub/bank-pdf/${p2.json?.data?.document_id}/ai-fallback/confirm`, { method: 'POST', json: body });
    const tx1 = await rows('fdh_transactions', `user_id=eq.${pilot.id}&statement_upload_id=in.(${up1.ownId},${up2.ownId})`, 'id,statement_upload_id');
    check('BANK confirm once (from the re-upload screen): 3 transactions, all on the original upload, none on the copy', confirm.status === 200 && tx1.length === 3 && tx1.every((t) => t.statement_upload_id === up1.ownId), JSON.stringify({ confirm: confirm.status, tx: tx1.length }));

    const up3 = await uploadRaw(pilot, 'bank-pdf', params, bytes, 'application/pdf');
    const p3 = await app(pilot, `/api/financial-data-hub/bank-pdf/${up3.ownId}/process`, { method: 'POST', json: {} });
    const txAll = await rows('fdh_transactions', `user_id=eq.${pilot.id}`, 'id');
    check('BANK re-upload after the import: answered with the original ("already imported", 0 created, 3 already there), nothing read, no AI call, still exactly 3 transactions',
      p3.json?.data?.duplicate === true && p3.json?.data?.transactions_created === 0 && p3.json?.data?.duplicates_skipped === 3 && p3.json?.data?.document_id === up1.ownId
        && txAll.length === 3 && (await attempts()) === a1 && !(await wasRead(up3.ownId)),
      JSON.stringify({ d: p3.json?.data?.duplicate, created: p3.json?.data?.transactions_created, skipped: p3.json?.data?.duplicates_skipped, tx: txAll.length }));
    check('BANK nothing left waiting once confirmed', !(await waiting(pilot, 'bank')).some((i) => i.document_id === up1.ownId));
    evidence.bank = { original: up1.ownId, copies: [up2.ownId, up3.ownId], aiCalls: a1 - a0, transactions: txAll.length };
  }

  // --------------------------------------------------- statement types
  async function statementType(o: {
    tag: string; kind: string; route: string; params: Record<string, string>; bytes: Buffer; table: string;
    confirmBody: (d: any) => unknown; afterConfirm: (docId: string, statementId: string) => Promise<void>;
  }) {
    const { tag } = o;
    console.log(`\n--- ${tag}: AI reading -> resume -> re-upload -> confirm once -> re-upload -> apply once -> re-upload ---`);
    const a0 = await attempts();
    const up1 = await statementUpload(pilot, o.route, o.params, o.bytes);
    const draft = up1.res.json?.data?.ai_fallback_draft;
    const a1 = await attempts();
    check(`${tag} first upload: the parser could not read it, the AI read a draft (one metered call)`, up1.res.json?.data?.pipeline_status === 'ai_fallback_available' && !!draft && a1 === a0 + 1, JSON.stringify({ p: up1.res.json?.data?.pipeline_status, attempts: [a0, a1] }));

    const w1 = await waiting(pilot, o.kind);
    check(`${tag} resume after a reload: the waiting list offers the AI reading, with its content`, w1.some((i) => i.document_id === up1.ownId && i.stage === 'ai_draft' && sameDraft(i.ai_fallback_draft, draft)), JSON.stringify(w1.map((i) => i.stage)));

    const up2 = await statementUpload(pilot, o.route, o.params, o.bytes);
    const d2 = up2.res.json?.data;
    check(`${tag} re-upload of the same bytes carries on with the ORIGINAL reading -- no second AI call, the copy is never read, nothing written for it`,
      d2?.pipeline_status === 'ai_fallback_available' && d2?.document_id === up1.ownId && d2?.duplicate_of_document_id === up1.ownId
        && sameDraft(d2?.ai_fallback_draft, draft) && (await attempts()) === a1 && !(await wasRead(up2.ownId)),
      JSON.stringify({ p: d2?.pipeline_status, docIsOriginal: d2?.document_id === up1.ownId, attempts: await attempts() }));

    const confirm = await app(pilot, `/api/financial-data-hub/${o.route}/${d2?.document_id}/ai-fallback/confirm`, { method: 'POST', json: o.confirmBody(draft) });
    const st = await rows(o.table, `user_id=eq.${pilot.id}`, 'id,statement_upload_id');
    check(`${tag} confirm once (from the re-upload screen): exactly one statement, on the original upload`, confirm.status === 200 && st.length === 1 && st[0].statement_upload_id === up1.ownId, JSON.stringify({ confirm: confirm.status, statements: st.length }));

    const w2 = await waiting(pilot, o.kind);
    check(`${tag} resume after a reload: the saved statement is offered for review`, w2.some((i) => i.document_id === up1.ownId && i.stage === 'review'), JSON.stringify(w2.map((i) => i.stage)));

    const up3 = await statementUpload(pilot, o.route, o.params, o.bytes);
    const d3 = up3.res.json?.data;
    const review = await app(pilot, `/api/financial-data-hub/${o.route}/${d3?.document_id}`);
    const st3 = await rows(o.table, `user_id=eq.${pilot.id}`, 'id');
    check(`${tag} a THIRD upload leads to the original statement (review loads -- no dead end), nothing read, no AI call, still one statement`,
      d3?.pipeline_status === 'duplicate_statement' && d3?.document_id === up1.ownId && review.status === 200 && st3.length === 1 && (await attempts()) === a1 && !(await wasRead(up3.ownId)),
      JSON.stringify({ p: d3?.pipeline_status, docIsOriginal: d3?.document_id === up1.ownId, review: review.status, statements: st3.length }));

    await o.afterConfirm(up1.ownId, st[0]?.id);
    evidence[tag] = { original: up1.ownId, copies: [up2.ownId, up3.ownId], aiCalls: a1 - a0 };
  }

  /** Approve -> compare -> apply "add as new" with the panel's own default
   * selection (rows read through the shared normaliser) -> a later re-upload
   * is told it was already applied, and nothing is written twice. */
  async function applyOnce(tag: string, kind: string, route: string, docId: string, canonicalTable: string, bytes: Buffer, params: Record<string, string>, applyPath: (proposalId: string) => string, applyBody: (sel: string[], proposalId: string) => unknown) {
    const approve = await app(pilot, `/api/financial-data-hub/${route}/${docId}/approve`, { method: 'POST' });
    const prop = await app(pilot, `/api/financial-data-hub/${route}/${docId}/proposal`, { method: 'POST' });
    const fields = normaliseProposedFields(prop.json?.data?.fields);
    const sel = fields.filter((f) => f.isRecommended && !f.requiresConfirmation && f.proposedValue !== f.existingValue).map((f) => f.fieldName);
    check(`${tag} the comparison screen gets labelled rows and a non-empty default selection`, approve.status === 200 && prop.status === 200 && fields.length > 0 && sel.length > 0, JSON.stringify({ approve: approve.status, prop: prop.status, fields: fields.map((f) => f.fieldName), sel }));
    // What the API really sends. The retirement route sends the adapter's
    // camelCase draft rows: a screen that cast them as snake_case (the old
    // retirement panel) read every label, value and "recommended" flag as
    // undefined -- a blank table and an empty "add as new" selection.
    const raw = (prop.json?.data?.fields ?? [])[0] ?? {};
    const casing = 'fieldName' in raw ? 'camelCase' : 'field_name' in raw ? 'snake_case' : 'unknown';
    const oldScreenSelection = (prop.json?.data?.fields ?? []).filter((f: any) => f.is_recommended && !f.requires_confirmation).map((f: any) => f.field_name);
    evidence[`${tag}_proposalRowCasing`] = { casing, oldSnakeCaseScreenWouldSelect: oldScreenSelection.length };
    if (tag === 'SUPER') {
      check('SUPER live proof of the field-shape defect: the proposal rows arrive camelCase, so the old snake_case screen would have selected NOTHING (and "add as new" would be refused); the shared normaliser selects them',
        casing === 'camelCase' && oldScreenSelection.length === 0 && sel.length > 0, JSON.stringify(evidence[`${tag}_proposalRowCasing`]));
    }
    const w = await waiting(pilot, kind);
    check(`${tag} resume after a reload: the approved statement is offered for its comparison`, w.some((i) => i.document_id === docId && i.stage === 'compare'), JSON.stringify(w.map((i) => i.stage)));
    const apply = await app(pilot, applyPath(prop.json?.data?.proposal_id), { method: 'POST', json: applyBody(sel, prop.json?.data?.proposal_id) });
    const canon1 = await rows(canonicalTable, `user_id=eq.${pilot.id}`, 'id');
    check(`${tag} apply "add as new" once: exactly one record created`, apply.status === 200 && canon1.length === 1, `${apply.status} ${apply.text.slice(0, 200)} rows=${canon1.length}`);
    check(`${tag} nothing left waiting once applied`, !(await waiting(pilot, kind)).some((i) => i.document_id === docId));
    const appliedAfterApply = (await rows('fhip_import_proposals', `user_id=eq.${pilot.id}&status=eq.applied`, 'id')).length;

    const a = await attempts();
    const up4 = await statementUpload(pilot, route, params, bytes);
    const d4 = up4.res.json?.data;
    const again = await app(pilot, `/api/financial-data-hub/${route}/${d4?.document_id}/proposal`, { method: 'POST' });
    const canon2 = await rows(canonicalTable, `user_id=eq.${pilot.id}`, 'id');
    const applied = await rows('fhip_import_proposals', `user_id=eq.${pilot.id}&status=eq.applied`, 'id');
    check(`${tag} a re-upload after applying leads to the original and is told it was already applied (409) -- no new comparison, still one record, one applied decision, no AI call`,
      d4?.document_id === docId && again.status === 409 && again.json?.error === 'already_decided' && canon2.length === 1 && applied.length === appliedAfterApply && (await attempts()) === a,
      JSON.stringify({ docIsOriginal: d4?.document_id === docId, again: [again.status, again.json?.error], records: canon2.length, appliedDecisions: [appliedAfterApply, applied.length] }));
  }

  if (want('liability')) {
    const params = { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'RDL1' };
    const bytes = fx.liabilityLetterCsv(`${RUN}-l`);
    await statementType({
      tag: 'CARD', kind: 'liability', route: 'liability-statement', params, bytes, table: 'fdh_liability_statements',
      confirmBody: (d) => ({
        metadata: {
          statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'Synthetic Card Co', masked_identifier: 'RDL1',
          statement_period_start: d.header?.statementPeriodStart || undefined, statement_period_end: d.header?.statementPeriodEnd || undefined,
          statement_date: d.header?.statementDate || undefined, due_date: d.header?.dueDate || undefined,
          opening_balance: d.header?.openingBalance, closing_balance: d.header?.closingBalance, credit_limit: d.header?.creditLimit, minimum_payment: d.header?.minimumPayment,
        },
        facilityType: 'credit_card', activities: d.activities, aiWarnings: d.warnings,
      }),
      afterConfirm: async (docId) => applyOnce('CARD', 'liability', 'liability-statement', docId, 'liabilities', bytes, params,
        (pid) => `/api/financial-data-hub/liability-proposals/${pid}/apply`, (sel) => ({ decision: 'add_new', selectedFields: sel })),
    });
  }

  if (want('retirement')) {
    const params = { jurisdiction: 'AU', currency_code: 'AUD', fund_name: 'Imaginary Super Fund', masked_account_identifier: 'RDR1', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' };
    const bytes = fx.retirementLetterCsv(`${RUN}-r`);
    await statementType({
      tag: 'SUPER', kind: 'retirement', route: 'retirement-statement', params, bytes, table: 'fdh_retirement_statements',
      confirmBody: (d) => d,
      afterConfirm: async (docId) => {
        // The panel's "Add as a new account", then its evidence matching.
        const m = await app(pilot, `/api/financial-data-hub/retirement-statement/${docId}/account-match`, { method: 'POST', json: { action: 'confirm_new' } });
        await app(pilot, `/api/financial-data-hub/retirement-statement/${docId}/evidence-matches`, { method: 'POST' });
        check('SUPER the statement is matched as a new account', m.status === 200, `${m.status} ${m.text.slice(0, 160)}`);
        await applyOnce('SUPER', 'retirement', 'retirement-statement', docId, 'retirement_accounts', bytes, params,
          () => `/api/financial-data-hub/retirement-statement/${docId}/apply`, (sel, pid) => ({ proposal_id: pid, decision: 'add_new', selected_fields: sel }));
      },
    });
  }

  if (want('investment')) {
    const params = { csv_kind: 'transaction', currency_code: 'AUD', institution_name: 'Imaginary Broking', masked_account_identifier: 'RDI1' };
    const bytes = fx.investmentLetterCsv(`${RUN}-i`);
    await statementType({
      tag: 'BROKER', kind: 'investment', route: 'investment-statement', params, bytes, table: 'fdh_investment_statements',
      // A draft resumed from the waiting list leaves the CSV kind to the server.
      confirmBody: (d) => ({ holdings: d.holdings, activities: d.activities, institutionName: 'Imaginary Broking', maskedAccountIdentifier: 'RDI1', statementDate: d.statementDate, statementPeriodStart: d.statementPeriodStart, statementPeriodEnd: d.statementPeriodEnd }),
      afterConfirm: async (docId, statementId) => {
        // Applied line by line and idempotent per line: a second apply must write nothing.
        const acts = await rows('fdh_investment_statement_activities', `statement_id=eq.${statementId}`, 'id,apply_status,security_match_status');
        evidence.BROKER_lines = acts.map((a) => [a.apply_status, a.security_match_status]);
        check('BROKER the confirmed statement holds the two read lines, none applied yet', acts.length === 2 && acts.every((a) => a.apply_status !== 'applied'), JSON.stringify(evidence.BROKER_lines));
      },
    });
  }

  // ------------------------------------------------------------ bank CSV
  if (want('bankcsv')) {
    console.log('\n--- BANK CSV: native import -> re-upload is answered with the original, never parsed again ---');
    const bytes = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/r7-bank-csv/au_cba_debit_credit.csv'));
    const params = { country_code: 'AU', currency_code: 'AUD', filename: `${RUN}-bc.csv`, masked_identifier: 'RDC1', ...(cba ? { institution_id: cba } : {}) };
    const up1 = await uploadRaw(pilot, 'bank-csv', params, bytes, 'text/csv');
    await app(pilot, `/api/financial-data-hub/bank-csv/${up1.ownId}/detect`, { method: 'POST' });
    const p1 = await app(pilot, `/api/financial-data-hub/bank-csv/${up1.ownId}/process`, { method: 'POST' });
    const tx1 = await rows('fdh_transactions', `statement_upload_id=eq.${up1.ownId}`, 'id');
    check('BANK CSV first upload imported natively', p1.status === 200 && tx1.length > 0 && p1.json?.data?.transactions_created === tx1.length, JSON.stringify({ p: p1.status, created: p1.json?.data?.transactions_created, tx: tx1.length }));
    const up2 = await uploadRaw(pilot, 'bank-csv', params, bytes, 'text/csv');
    // The panel skips detection for a flagged copy; the server refuses to read it either way.
    const det = await app(pilot, `/api/financial-data-hub/bank-csv/${up2.ownId}/detect`, { method: 'POST' });
    const p2 = await app(pilot, `/api/financial-data-hub/bank-csv/${up2.ownId}/process`, { method: 'POST' });
    const txUser = await rows('fdh_transactions', `user_id=eq.${pilot.id}&statement_upload_id=in.(${up1.ownId},${up2.ownId})`, 'id');
    check('BANK CSV re-upload: flagged as a copy, never detected or parsed, answered with the original (0 created), no second set of transactions',
      up2.upload.json?.data?.duplicate_of_document_id === up1.ownId && det.status === 200 && p2.json?.data?.duplicate === true && p2.json?.data?.transactions_created === 0
        && p2.json?.data?.document_id === up1.ownId && txUser.length === tx1.length && !(await wasRead(up2.ownId)),
      JSON.stringify({ flagged: up2.upload.json?.data?.duplicate_of_document_id === up1.ownId, det: det.status, d: p2.json?.data?.duplicate, created: p2.json?.data?.transactions_created, tx: txUser.length }));
    evidence.bankcsv = { original: up1.ownId, copy: up2.ownId, transactions: txUser.length };
  }

  evidence.attemptsAfter = await attempts();
  evidence.settledAfter = await settled();
  evidence.aiCallsThisRun = evidence.attemptsAfter - evidence.attemptsBefore;
  evidence.settledDeltaUsd = evidence.settledAfter - evidence.settledBefore;
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(SCRATCH, { recursive: true });
  const out = path.join(SCRATCH, `${RUN}.evidence.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nAI calls this run: ${evidence.aiCallsThisRun}   settled delta: $${evidence.settledDeltaUsd.toFixed(6)}   evidence: ${out}`);
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });
