/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * 0218 LIVE RE-PROOF, now that migration 0218 is actually applied to DEV.
 * Re-attempts SR-01..SR-04 as real authenticated/anon HTTP calls against DEV and confirms each is
 * refused. All four were proved live BEFORE 0218 by the security certifier and re-proved in PGlite;
 * this script is the first LIVE re-run against a DEV database that actually has 0218.
 *
 *   npx tsx scripts/canonical_cert/final/sr_live_reproof.ts --victim <e> --attacker <e> --port 3973
 */
import fs from 'node:fs';
import path from 'node:path';
import { api, loadSession } from '../lib/session.mjs';
import { loadDevEnv, serviceClient } from '../lib/env.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const victim = arg('--victim')!;
const attacker = arg('--attacker')!;
const port = Number(arg('--port'));
const OUT = path.resolve('.canonical-cert', 'final', 'sr_reproof.json');
const results: { ok: boolean; label: string; detail?: unknown }[] = [];
function expect(cond: boolean, label: string, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`);
  results.push({ ok: cond, label, detail });
}

function tokenFor(email: string): string {
  const s = loadSession(email);
  const chunk = (n: string) => { const m = n.match(/^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/); return m ? Number(m[1] ?? -1) : null; };
  const raw = Object.entries(s.cookies as Record<string, string>).filter(([n]) => chunk(n) !== null)
    .sort(([a], [b]) => (chunk(a) as number) - (chunk(b) as number)).map(([, v]) => v).join('');
  const decoded = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw;
  return JSON.parse(decoded).access_token;
}

/** A raw REST/RPC call directly against Supabase (bypassing every app route), as a given role. */
async function rest(method: string, path2: string, opts: { asUser?: string; anon?: boolean; body?: unknown } = {}) {
  const { url, anonKey } = loadDevEnv();
  const headers: Record<string, string> = { apikey: anonKey, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (opts.asUser) headers.Authorization = `Bearer ${tokenFor(opts.asUser)}`;
  else if (opts.anon) headers.Authorization = `Bearer ${anonKey}`;
  const res = await fetch(`${url}${path2}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function userIdOf(email: string): Promise<string> { return loadSession(email).userId as string; }

async function main() {
  const victimId = await userIdOf(victim);
  const attackerId = await userIdOf(attacker);
  const evidence: Record<string, unknown> = { victim, attacker, victimId, attackerId, at: new Date().toISOString() };

  // ===================================================================== SR-01 =================
  // Forged liability evidence INSERT: approval_status already 'approved', no document.
  console.log('\n=== SR-01: forged fdh_liability_statements INSERT (authenticated, no document) ===');
  const sr01 = await rest('POST', '/rest/v1/fdh_liability_statements', {
    asUser: attacker,
    body: {
      user_id: attackerId, statement_type: 'credit_card', facility_type: 'credit_card', currency_code: 'AUD',
      statement_upload_id: null, approval_status: 'approved', closing_balance: 777.77,
    },
  });
  evidence.sr01 = { status: sr01.status, body: sr01.text.slice(0, 500) };
  expect(sr01.status >= 400 && /system-authoritative/i.test(sr01.text), 'SR-01: forged approved liability statement INSERT refused by the 0218 trigger', evidence.sr01);

  console.log('=== SR-01b: forged fdh_liability_statement_activities with ledger state preset ===');
  // Needs a pending parent statement first (a legitimate-looking pending row is not itself the attack).
  const parent = await rest('POST', '/rest/v1/fdh_liability_statements', {
    asUser: attacker,
    body: { user_id: attackerId, statement_type: 'credit_card', facility_type: 'credit_card', currency_code: 'AUD', statement_upload_id: null },
  });
  const parentId = parent.json?.[0]?.id;
  evidence.sr01_parent = { status: parent.status, id: parentId, body: parent.text.slice(0, 300) };
  expect(parent.status >= 400, 'SR-01b setup: even a PENDING liability statement with no document is refused (statement_upload_id is mandatory)', evidence.sr01_parent);

  // ===================================================================== SR-02 =================
  console.log('\n=== SR-02: cross-tenant split line on the victim\'s own transaction ===');
  const victimTxns = await api(victim, 'GET', '/api/expenses/actuals?pageSize=5', { port });
  // Find a real approved transaction id for the victim to attack, via service-role observation only.
  const svc = await serviceClient();
  const { data: vTxns } = await svc.from('fdh_transactions').select('id').eq('user_id', victimId).limit(1);
  const victimTxnId = vTxns?.[0]?.id;
  evidence.sr02_victimTxn = victimTxnId;
  if (!victimTxnId) {
    expect(false, 'SR-02: no victim transaction found to attack (setup problem, not a security result)', {});
  } else {
    const sr02 = await rest('POST', '/rest/v1/fdh_transaction_allocations', {
      asUser: attacker,
      body: { user_id: attackerId, transaction_id: victimTxnId, allocation_sequence: 999, economic_transaction_type: 'expense', amount: 1, currency_code: 'AUD' },
    });
    evidence.sr02 = { status: sr02.status, body: sr02.text.slice(0, 500) };
    expect(sr02.status >= 400 && /cross-tenant/i.test(sr02.text), 'SR-02: cross-tenant split-line INSERT refused by the 0218 same-tenant trigger', evidence.sr02);
    void victimTxns;
  }

  // ===================================================================== SR-04 =================
  console.log('\n=== SR-04: anon EXECUTE on the WP-15 RPCs ===');
  const sr04a = await rest('POST', '/rest/v1/rpc/fdh15_apply_asset_proposal', { anon: true, body: { p_proposal_id: '00000000-0000-0000-0000-000000000000', p_decision: 'add_new', p_selected_fields: null } });
  evidence.sr04_asset = { status: sr04a.status, body: sr04a.text.slice(0, 300) };
  expect(sr04a.status === 401 || /permission denied/i.test(sr04a.text), 'SR-04a: anon EXECUTE on fdh15_apply_asset_proposal refused at the GRANT layer (401/permission denied, not 400 from inside the function)', evidence.sr04_asset);
  const sr04b = await rest('POST', '/rest/v1/rpc/fdh15_apply_expense_proposals', { anon: true, body: { p_decisions: [] } });
  evidence.sr04_expense = { status: sr04b.status, body: sr04b.text.slice(0, 300) };
  expect(sr04b.status === 401 || /permission denied/i.test(sr04b.text), 'SR-04b: anon EXECUTE on fdh15_apply_expense_proposals refused at the GRANT layer', evidence.sr04_expense);
  // Negative control: the SAME call, authenticated, reaches the function body (proves 401 above is the
  // anon revoke, not a broken RPC).
  const sr04ctl = await rest('POST', '/rest/v1/rpc/fdh15_apply_asset_proposal', { asUser: victim, body: { p_proposal_id: '00000000-0000-0000-0000-000000000000', p_decision: 'add_new', p_selected_fields: null } });
  evidence.sr04_control_authenticated = { status: sr04ctl.status, body: sr04ctl.text.slice(0, 300) };
  expect(sr04ctl.status === 200 && sr04ctl.json?.ok === false && sr04ctl.json?.code === 'PROPOSAL_NOT_FOUND', 'SR-04 control: the SAME RPC, authenticated, reaches the function body (200, PROPOSAL_NOT_FOUND) -- proves anon is refused at the grant, not by a broken function', evidence.sr04_control_authenticated);

  // ===================================================================== SR-03 =================
  // fdh15_apply_asset_proposal re-derives the balance NUMBER from the approved statement but (before
  // 0218) not its CURRENCY. LITERAL reproduction from the migration header: "a hand-made proposal
  // carrying the exact AUD closing balance ... with currency_code 'INR' was applied". `fhip_import_
  // proposals` / `fhip_import_proposal_fields` both carry "insert own" RLS (0091), so the ATTACKER
  // (here: the same user, forging their own evidence -- no cross-tenant access needed) can insert the
  // proposal row directly, skipping the server-side generator entirely.
  console.log('\n=== SR-03: hand-forged proposal, AUD balance labelled currency_code=INR ===');
  const bank3qs = new URLSearchParams({ country_code: 'AU', currency_code: 'AUD', masked_identifier: 'xxxx9903', owner_role: 'self', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', filename: 'fhip-test-sr03-bank.csv' }).toString();
  const bank3b = await api(attacker, 'POST', `/api/financial-data-hub/bank-csv/upload?${bank3qs}`, { port, body: new TextEncoder().encode('Date,Description,Amount,Balance\n2026-08-05,FHIP TEST SR03 SALARY,5000.00,15000.00\n'), contentType: 'text/csv' });
  const bank3DocId = bank3b.json?.data?.document_id;
  evidence.sr03_bankUpload = { status: bank3b.status, documentId: bank3DocId };
  await api(attacker, 'POST', `/api/financial-data-hub/bank-csv/${bank3DocId}/detect`, { port });
  await api(attacker, 'POST', `/api/financial-data-hub/bank-csv/${bank3DocId}/process`, { port });
  await api(attacker, 'POST', '/api/financial-data-hub/bank-transactions/categorise', { port });
  const rv3 = await api(attacker, 'GET', `/api/financial-data-hub/documents/${bank3DocId}/category-review`, { port });
  for (const item of (rv3.json?.data?.needs_decision ?? [])) {
    await api(attacker, 'POST', `/api/financial-data-hub/bank-transactions/${item.id}/set-category`, { port, json: { category_id: '0c046122-43e8-431d-94e2-527e734377b1' } });
  }
  await api(attacker, 'POST', `/api/financial-data-hub/documents/${bank3DocId}/category-review/approve-all`, { port, json: {} });
  const svc2 = await serviceClient();
  const { data: stmtRow } = await svc2.from('fdh_statement_uploads').select('id, financial_account_id, processing_status').eq('id', bank3DocId).maybeSingle();
  evidence.sr03_statement = stmtRow;
  if (!stmtRow || stmtRow.processing_status !== 'approved' || !stmtRow.financial_account_id) {
    expect(false, 'SR-03 setup: the SR-03 bank statement did not reach approved/ordinary-account state', evidence.sr03_statement);
  } else {
    const attackerId2 = await userIdOf(attacker);
    const forgedProposal = await rest('POST', '/rest/v1/fhip_import_proposals', {
      asUser: attacker,
      body: {
        user_id: attackerId2, target_domain: 'asset', source_kind: 'bank_statement', source_statement_upload_id: bank3DocId,
        target_entity_id: null, recommended_apply_mode: 'add_new', status: 'ready',
      },
    });
    const proposalId = forgedProposal.json?.[0]?.id;
    evidence.sr03_forgedProposal = { status: forgedProposal.status, id: proposalId, body: forgedProposal.text.slice(0, 400) };
    if (!proposalId) {
      expect(false, 'SR-03 setup: could not insert the forged proposal row (unexpected -- "insert own" RLS should allow it)', evidence.sr03_forgedProposal);
    } else {
      const fields = [
        { field_name: 'current_value', value_kind: 'money', proposed_value: '15000.00', existing_value: null },
        { field_name: 'currency_code', value_kind: 'enum', proposed_value: 'INR', existing_value: null }, // FORGED: the real statement is AUD
        { field_name: 'asset_name', value_kind: 'text', proposed_value: 'SR-03 forged asset', existing_value: null },
        { field_name: 'asset_class', value_kind: 'enum', proposed_value: 'cash', existing_value: null },
      ].map((f) => ({ ...f, user_id: attackerId2, proposal_id: proposalId }));
      const forgedFields = await rest('POST', '/rest/v1/fhip_import_proposal_fields', { asUser: attacker, body: fields });
      evidence.sr03_forgedFields = { status: forgedFields.status, body: forgedFields.text.slice(0, 500) };
      const attack = await rest('POST', '/rest/v1/rpc/fdh15_apply_asset_proposal', { asUser: attacker, body: { p_proposal_id: proposalId, p_decision: 'add_new', p_selected_fields: ['current_value', 'currency_code', 'asset_name', 'asset_class'] } });
      evidence.sr03_attack = { status: attack.status, body: attack.text.slice(0, 500) };
      expect(attack.status === 200 && attack.json?.ok === false && attack.json?.code === 'CURRENCY_MISMATCH', 'SR-03: an AUD-15,000 statement forged as currency_code=INR is refused as CURRENCY_MISMATCH (0218 re-derives the currency, not only the number)', evidence.sr03_attack);
      const { data: newAssets } = await svc2.from('assets').select('id, current_value, currency_code').eq('user_id', attackerId2).eq('asset_name', 'SR-03 forged asset');
      evidence.sr03_assetsCreated = newAssets;
      expect((newAssets ?? []).length === 0, 'SR-03: no INR asset carrying an AUD number was created', newAssets);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ evidence, results }, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
