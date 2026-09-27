/**
 * R20 live-DEV forge probe (feature/canonical-cert-final-timing-and-r20-scope).
 *
 * Uses the SIGNED-IN FIXTURE USER's OWN access token (never the service role) to hand-craft a
 * WP-15 expense proposal directly against PostgREST -- exactly what a malicious authenticated
 * user could send with curl + their own JWT, bypassing the Next.js app's /api routes entirely
 * for the proposal-creation step. Then applies it through the REAL app route
 * (POST /api/expenses/planned-from-actuals) to see whether the apply RPC re-derives the amount
 * or trusts the hand-inserted proposed_value.
 *
 * Never prints the access token itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDevEnv } from '../lib/env.mjs';
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
if (!email || !port) throw new Error('usage: r20_forge_probe.mjs --email e --port p');

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

async function restCall(method, pathAndQuery, { anonKey, url, token, body, prefer }) {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  const { url, anonKey } = loadDevEnv();
  const { token, userId } = loadAccessToken(email);
  const results = {};

  // 1) Hand-craft a fhip_import_proposals row directly via PostgREST, as the authenticated user.
  //    No source_statement_upload_id (nullable, unenforced) -- claims bank_statement provenance
  //    with ZERO real evidence behind it.
  const proposalBody = {
    user_id: userId,
    target_domain: 'expense',
    source_kind: 'bank_statement',
    currency_code: 'AUD',
    target_entity_id: null,
    recommended_apply_mode: 'add_new',
    status: 'ready',
  };
  const propRes = await restCall('POST', 'fhip_import_proposals', { anonKey, url, token, body: proposalBody, prefer: 'return=representation' });
  results.insertProposal = { status: propRes.status, body: propRes.json ?? propRes.text.slice(0, 400) };
  console.log('INSERT fhip_import_proposals ->', propRes.status, JSON.stringify(propRes.json ?? propRes.text.slice(0, 300)));

  const proposalId = Array.isArray(propRes.json) ? propRes.json[0]?.id : propRes.json?.id;
  if (!proposalId) {
    console.log('proposal insert failed; stopping forge attempt here.');
  } else {
    const masterKey = `FORGED_ITEM_${Date.now()}`;
    const fields = [
      { field_name: 'expense_name', value_kind: 'text', proposed_value: 'Totally Legit Forged Expense' },
      { field_name: 'master_item_key', value_kind: 'text', proposed_value: masterKey },
      { field_name: 'expense_category', value_kind: 'enum', proposed_value: 'other' },
      { field_name: 'amount', value_kind: 'money', proposed_value: '999999.99' },
      { field_name: 'frequency', value_kind: 'enum', proposed_value: 'monthly' },
      { field_name: 'currency_code', value_kind: 'enum', proposed_value: 'AUD' },
    ].map((f) => ({ ...f, user_id: userId, proposal_id: proposalId, is_recommended: true, requires_confirmation: false }));
    const fieldsRes = await restCall('POST', 'fhip_import_proposal_fields', { anonKey, url, token, body: fields, prefer: 'return=representation' });
    results.insertFields = { status: fieldsRes.status, body: fieldsRes.json ?? fieldsRes.text.slice(0, 400) };
    console.log('INSERT fhip_import_proposal_fields ->', fieldsRes.status, JSON.stringify(fieldsRes.json ?? fieldsRes.text.slice(0, 300)));

    // 2) Apply through the REAL app route (this is the only sanctioned entry point) to see
    //    whether the apply RPC re-derives the amount or trusts the forged proposed_value.
    const applyRes = await api(email, 'POST', '/api/expenses/planned-from-actuals', {
      port,
      json: { action: 'apply', decisions: [{ proposalId, decision: 'add_new' }] },
    });
    results.apply = { status: applyRes.status, body: applyRes.json ?? applyRes.text.slice(0, 500) };
    console.log('POST /api/expenses/planned-from-actuals apply ->', applyRes.status, applyRes.text.slice(0, 500));

    results.masterKey = masterKey;
    results.proposalId = proposalId;
  }

  const outFile = path.resolve('.canonical-cert', 'final', 'r20-forge-probe.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`wrote ${outFile}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
