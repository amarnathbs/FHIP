/**
 * Owner-before-upload -- HTTP-level NEGATIVE CONTROLS for every owner-capable upload route.
 *
 *   node scripts/canonical_cert/signin.mjs --range <R> --email <fixture email>          # once
 *   node scripts/canonical_cert/final/owner_required_negative_controls.mjs --email <fixture email> --port <localhost port>
 *
 * Run it against a LOCALHOST app pointed at DEV (never production). It signs in as ONE existing fixture user
 * through the canonical-cert session harness (it never creates an account) and proves, per route:
 *
 *   1. NO owner            -> 422 owner_required            (the owner is chosen BEFORE the file is read)
 *   2. a garbled owner     -> 422 owner_invalid
 *   3. a foreign member id -> 4xx owner_not_found           (a random UUID is not this user's member)
 *   4. a Trust-owned BANK statement -> refused              (PO-OBU-02: entity bank cash flow is deferred)
 *   5. CONTROL: the SAME bank upload with a valid synthetic Self owner is accepted (200)
 *      -- so (1) is the owner check refusing, not an earlier gate.
 *
 * Every row is written to .canonical-cert/owner_required_negative_controls.json. The only rows this creates
 * are the one control upload on the fixture user's own account; clean them with the harness's residue.mjs.
 *
 * NOT RUN by the engineer who wrote it (no DEV access in that session); delivered for the PO's DEV pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
if (!email || !port) throw new Error('usage: owner_required_negative_controls.mjs --email <fixture email> --port <port>');

const results = [];
const check = (label, ok, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const csv = fs.readFileSync(path.resolve('tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv'));
const enc = (o) => encodeURIComponent(typeof o === 'string' ? o : JSON.stringify(o));
const errCode = (r) => r.json?.error ?? r.json?.code ?? null;

const ROUTES = [
  ['bank-csv', '/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD&filename=obu-neg.csv', 'text/csv'],
  ['bank-pdf', '/api/financial-data-hub/bank-pdf/upload?country_code=AU&currency_code=AUD&filename=obu-neg.pdf', 'application/pdf'],
  ['liability', '/api/financial-data-hub/liability-statement/upload?statement_type=credit_card&country_code=AU&currency_code=AUD&institution_name=NegCard&filename=obu-neg.csv', 'text/csv'],
  ['retirement', '/api/financial-data-hub/retirement-statement/upload?jurisdiction=AU&currency_code=AUD&filename=obu-neg.csv', 'text/csv'],
  ['au-investment', '/api/financial-data-hub/investment-statement/upload?csv_kind=portfolio&currency_code=AUD&institution_name=NegBroker&filename=obu-neg.csv', 'text/csv'],
];

async function main() {
  for (const [name, route, contentType] of ROUTES) {
    const none = await api(email, 'POST', route, { port, body: csv, contentType, owner: null });
    check(`${name}: no owner is refused 422 owner_required`, none.status === 422 && errCode(none) === 'owner_required', `HTTP ${none.status} ${errCode(none)}`);

    const garbled = await api(email, 'POST', `${route}&owner=${enc('{not json')}`, { port, body: csv, contentType, owner: null });
    check(`${name}: a garbled owner is refused 422 owner_invalid`, garbled.status === 422 && errCode(garbled) === 'owner_invalid', `HTTP ${garbled.status} ${errCode(garbled)}`);

    const foreign = await api(email, 'POST', `${route}&owner=${enc({ kind: 'member', memberId: '99999999-9999-4999-8999-999999999999' })}`, { port, body: csv, contentType, owner: null });
    check(`${name}: a member id that is not this user's is refused owner_not_found`, foreign.status >= 400 && foreign.status < 500 && errCode(foreign) === 'owner_not_found', `HTTP ${foreign.status} ${errCode(foreign)}`);
  }

  // PO-OBU-02: entity-owned bank statements stay refused, before any canonical write.
  const bankCsv = ROUTES[0][1];
  const options = await api(email, 'GET', '/api/ownership/options?flow=ii_cas', { port });
  const entity = (options.json?.data?.entities ?? [])[0];
  if (entity) {
    const trustBank = await api(email, 'POST', `${bankCsv}&owner=${enc({ kind: 'entity', entityId: entity.id })}`, { port, body: csv, contentType: 'text/csv', owner: null });
    check('bank-csv: an entity-owned (Trust/Company/HUF) bank statement is refused owner_not_allowed_for_flow', trustBank.status === 422 && errCode(trustBank) === 'owner_not_allowed_for_flow', `HTTP ${trustBank.status} ${errCode(trustBank)}`);
  } else {
    console.log('SKIP  entity bank refusal: this fixture user has no Trust / Company / HUF (create one, then re-run)');
  }

  // CONTROL: the identical request WITH a valid owner is accepted -- the refusals above are the owner check.
  const withOwner = await api(email, 'POST', bankCsv, { port, body: csv, contentType: 'text/csv' }); // api() adds a valid synthetic Self owner
  check('CONTROL: the same bank-csv upload WITH a valid Self owner is accepted (200)', withOwner.status === 200 && !!withOwner.json?.data?.document_id, `HTTP ${withOwner.status}`);

  // The upload-session route for an owner-bearing document type.
  const sessionBody = { document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: 1000 };
  const noOwnerSession = await api(email, 'POST', '/api/financial-data-hub/documents/upload-sessions', { port, json: sessionBody, owner: null });
  check('upload-sessions (payslip): no owner is refused 422 owner_required', noOwnerSession.status === 422 && errCode(noOwnerSession) === 'owner_required', `HTTP ${noOwnerSession.status} ${errCode(noOwnerSession)}`);

  const outDir = path.resolve('.canonical-cert');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'owner_required_negative_controls.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
