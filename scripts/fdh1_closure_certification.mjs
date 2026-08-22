// =============================================================================
// FDH-1 Full-Pass Closure — live DEV certification harness.
// =============================================================================
// Why this exists alongside scripts/fdh1_live_dev_verification.mjs:
//
// That suite's 27 checks are the mandated set, but 16 of them are VACUOUS while
// the FDH user tables are empty. "anon reads fdh_transactions and sees 0 rows"
// is not evidence of RLS when the table has 0 rows for everyone — it passes
// identically with RLS disabled. Same for the append-only probe, which PATCHes a
// UUID that does not exist.
//
// This harness runs the SAME 27 checks, but only after seeding a real synthetic
// object graph owned by user A across all 15 user-owned tables, so every
// isolation assertion is made against data that demonstrably exists. It also
// carries a NEGATIVE CONTROL: the service role must SEE each row that anon and
// user B cannot. If the negative control ever fails, the isolation result is
// meaningless and the run aborts.
//
// It then exercises the financial-data integrity constraints (money precision,
// confidence bounds, direction-vs-meaning independence, allocations, purge
// compatibility, raw-identifier protection, reconciliation honesty).
//
// All data created here is synthetic and is removed in the cleanup phase.
// No DDL is executed. No existing row is modified.
//
// Usage: node scripts/fdh1_closure_certification.mjs
// =============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (!fs.existsSync(p)) continue;
    const env = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return { env, source: p };
  }
  throw new Error('no .env.local');
}
const { env, source } = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const TAG = 'FDH1CLOSURE';

async function rest(q, { key = ANON, token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${q}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, text, json };
}
const svc = (q, o = {}) => rest(q, { ...o, key: SERVICE });

async function signUp(label) {
  const email = `fdh1-closure-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: `Fdh1!${Math.random().toString(36).slice(2, 12)}A` }),
  });
  const j = await res.json();
  if (!j.access_token || !j.user?.id) throw new Error(`signup ${label} failed: ${JSON.stringify(j).slice(0, 200)}`);
  return { email, token: j.access_token, userId: j.user.id };
}

const checks = [];
function record(section, name, expected, actual, pass) {
  checks.push({ section, name, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${section}] ${name}  | expected: ${expected} | actual: ${actual}`);
}

const created = { master: {}, a: {}, households: [] };
const A = await signUp('a');
const B = await signUp('b');
console.log(`env: ${new URL(BASE).host}\ncreds: ${source}\nuser A ${A.userId}\nuser B ${B.userId}\n`);

// ---------------------------------------------------------------------------
// Phase 1 — seed synthetic master data (service role = the admin write path).
// ---------------------------------------------------------------------------
console.log('--- phase 1: synthetic master data (service role) ---');
async function mk(table, body, keyName) {
  const r = await svc(table, { method: 'POST', prefer: 'return=representation', body });
  if (!r.ok) throw new Error(`seed ${table} failed: ${r.status} ${r.text.slice(0, 300)}`);
  const id = r.json[0].id ?? r.json[0][keyName];
  created.master[table] = [...(created.master[table] || []), id];
  return r.json[0];
}
const inst = await mk('fdh_financial_institutions', {
  country_code: 'AU', institution_code: `${TAG}_BANK`, institution_name: `${TAG} Test Bank`, institution_type: 'bank',
});
const cat = await mk('fdh_categories', { category_key: `${TAG}_groceries`, display_name: `${TAG} Groceries`, economic_type: 'expense' });
const catOther = await mk('fdh_categories', { category_key: `${TAG}_other`, display_name: `${TAG} Other`, economic_type: 'unknown' });
const sub = await mk('fdh_subcategories', { category_id: cat.id, subcategory_key: `${TAG}_super`, display_name: `${TAG} Supermarket` });
const merch = await mk('fdh_merchants', { canonical_name: `${TAG}_acme`, display_name: `${TAG} Acme`, country_code: 'AU' });
const grule = await mk('fdh_classification_rules', {
  rule_key: `${TAG}_rule`, rule_type: 'mcc',
  match_definition: { match_kind: 'mcc', mcc: '5411' },
  action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
});
const preg = await mk('fdh_parser_registry', {
  parser_key: `${TAG}_parser`, institution_id: inst.id, document_type: 'bank_statement', source_format: 'csv', country_code: 'AU',
});
const pver = await mk('fdh_parser_versions', { parser_id: preg.id, version: '1.0.0', status: 'certified' });
console.log(`seeded master: institution, 2 categories, subcategory, merchant, rule, parser, parser version\n`);

// ---------------------------------------------------------------------------
// Phase 2 — user A builds a real object graph across all 15 user-owned tables.
// ---------------------------------------------------------------------------
console.log('--- phase 2: user A synthetic object graph (RLS-scoped session) ---');
async function asA(table, body) {
  const r = await rest(table, { token: A.token, method: 'POST', prefer: 'return=representation', body });
  if (!r.ok) throw new Error(`A insert ${table} failed: ${r.status} ${r.text.slice(0, 300)}`);
  created.a[table] = [...(created.a[table] || []), r.json[0].id];
  return r.json[0];
}
const hh = await asA('households', { user_id: A.userId, household_type: 'Single', marital_status: 'Single', primary_country: 'AU' });
created.households.push(hh.id);

const acct = await asA('fdh_financial_accounts', {
  user_id: A.userId, household_id: hh.id, institution_id: inst.id, account_type: 'transaction',
  country_code: 'AU', currency_code: 'AUD', display_name: `${TAG} Everyday`, masked_identifier: '****1234',
});
const upload = await asA('fdh_statement_uploads', {
  user_id: A.userId, household_id: hh.id, financial_account_id: acct.id, institution_id: inst.id,
  source_type: 'csv', document_type: 'bank_statement', country_code: 'AU', currency_code: 'AUD',
  parser_id: preg.id, parser_version_id: pver.id, original_filename_sanitised: `${TAG}.csv`,
});
await asA('fdh_ingestion_jobs', { user_id: A.userId, statement_upload_id: upload.id, job_type: 'document_extract' });
const txn = await asA('fdh_transactions', {
  user_id: A.userId, household_id: hh.id, financial_account_id: acct.id, statement_upload_id: upload.id,
  transaction_date: '2026-03-01', amount_original: '650.0000', currency_original: 'AUD',
  credit_debit: 'debit', economic_transaction_type: 'expense', category_id: cat.id,
  description_raw: `${TAG} raw narrative`, merchant_raw: `${TAG} RAW MERCHANT`, merchant_id: merch.id,
});
const txn2 = await asA('fdh_transactions', {
  user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-02',
  amount_original: '650.0000', currency_original: 'AUD', credit_debit: 'debit',
});
for (const [seq, amt] of [[1, '450.0000'], [2, '150.0000'], [3, '50.0000']]) {
  await asA('fdh_transaction_allocations', {
    user_id: A.userId, transaction_id: txn.id, allocation_sequence: seq,
    economic_transaction_type: 'expense', category_id: cat.id, subcategory_id: sub.id,
    amount: amt, currency_code: 'AUD',
  });
}
await asA('fdh_transaction_links', {
  user_id: A.userId, transaction_id_from: txn.id, transaction_id_to: null,
  link_type: 'internal_transfer', created_by_method: 'system_rule', status: 'pending',
});
await asA('fdh_duplicate_candidates', {
  user_id: A.userId, transaction_id_a: txn.id, transaction_id_b: txn2.id, match_method: 'fuzzy_amount_date',
});
const urule = await asA('fdh_user_classification_rules', {
  user_id: A.userId, household_id: hh.id, rule_type: 'merchant_exact',
  match_definition: { match_kind: 'merchant_exact', merchant_id: merch.id },
  action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' },
});
const hist = await asA('fdh_classification_history', {
  user_id: A.userId, transaction_id: txn.id,
  previous_economic_transaction_type: 'unknown', new_economic_transaction_type: 'expense',
  previous_category_id: catOther.id, new_category_id: cat.id,
  classification_method: 'user_manual', changed_by_type: 'user', changed_by_user: A.userId,
  user_rule_id: urule.id,
});
await asA('fdh_recurring_transactions', {
  user_id: A.userId, household_id: hh.id, merchant_id: merch.id, financial_account_id: acct.id,
  frequency: 'monthly', expected_amount: '19.9900', currency_code: 'AUD', status: 'candidate',
});
await asA('fdh_review_items', {
  user_id: A.userId, household_id: hh.id, transaction_id: txn.id,
  review_type: 'missing_counterpart_account', severity: 'warning', status: 'open', title_code: 'review.missing_counterpart',
});
await asA('fdh_reconciliation_results', {
  user_id: A.userId, statement_upload_id: upload.id, opening_balance: '1000.0000',
  extracted_credits: '0.0000', extracted_debits: '650.0000', expected_closing_balance: '350.0000',
  reported_closing_balance: '350.0000', variance: '0.0000', variance_tolerance: '0.0000',
  currency_code: 'AUD', status: 'reconciled', reconciliation_method: 'balance_rollforward',
});
await asA('fdh_data_quality_results', {
  user_id: A.userId, statement_upload_id: upload.id, check_code: 'balance_reconciled', status: 'pass', score: '1.0000',
});
const prov = await asA('fdh_data_provenance', {
  user_id: A.userId, household_id: hh.id, entity_type: 'fdh_transaction', entity_id: txn.id,
  source_type: 'csv', source_statement_id: upload.id, source_transaction_id: txn.id,
  parser_id: preg.id, parser_version_id: pver.id, evidence_completeness: '0.5000',
});
await asA('fdh_evidence_links', {
  user_id: A.userId, provenance_id: prov.id, evidence_type: 'bank_transaction',
  evidence_statement_upload_id: upload.id, evidence_transaction_id: txn.id, evidence_weight: '1.0000',
});
const USER_TABLES = [
  'fdh_financial_accounts', 'fdh_statement_uploads', 'fdh_ingestion_jobs', 'fdh_transactions',
  'fdh_transaction_allocations', 'fdh_transaction_links', 'fdh_duplicate_candidates',
  'fdh_user_classification_rules', 'fdh_classification_history', 'fdh_recurring_transactions',
  'fdh_review_items', 'fdh_reconciliation_results', 'fdh_data_quality_results',
  'fdh_data_provenance', 'fdh_evidence_links',
];
console.log(`seeded A rows in ${USER_TABLES.length} user-owned tables\n`);

// NEGATIVE CONTROL — every user table must now be non-empty to the service role.
console.log('--- negative control: service role must SEE what anon/B cannot ---');
let controlOk = true;
for (const t of USER_TABLES) {
  const r = await svc(`${t}?select=id&user_id=eq.${A.userId}`);
  const n = Array.isArray(r.json) ? r.json.length : 0;
  if (n < 1) { controlOk = false; console.log(`  !! ${t} has NO seeded row — isolation assertions on it would be vacuous`); }
}
record('control', 'negative control: all 15 user tables hold real A-owned rows',
  'every table non-empty to service role', controlOk ? 'all 15 non-empty' : 'AT LEAST ONE EMPTY', controlOk);
if (!controlOk) { console.log('\nABORT: negative control failed; isolation results would be meaningless.'); process.exit(1); }
console.log('');

// ---------------------------------------------------------------------------
// Phase 3 — the mandated 27 checks, now against real data.
// ---------------------------------------------------------------------------
console.log('--- phase 3: the 27 mandated checks (against real, non-empty data) ---');
// 1-2 A owns and reads its account
record('rls', '01 A can create own account', 'row created', `id ${acct.id.slice(0, 8)}`, !!acct.id);
const aRead = await rest(`fdh_financial_accounts?id=eq.${acct.id}&select=id`, { token: A.token });
record('rls', '02 A can read own account', '1 row', `${aRead.json?.length} rows`, aRead.json?.length === 1);
// 3-5 cross-user read/update/delete
const bRead = await rest(`fdh_financial_accounts?id=eq.${acct.id}&select=id`, { token: B.token });
record('rls', '03 B cannot read A account', '0 rows', `${bRead.json?.length ?? 0} rows (http ${bRead.status})`, (bRead.json?.length ?? 0) === 0);
const bUpd = await rest(`fdh_financial_accounts?id=eq.${acct.id}`, { token: B.token, method: 'PATCH', prefer: 'return=representation', body: { display_name: 'HIJACKED' } });
const bUpdOk = (bUpd.json?.length ?? 0) === 0;
const stillMine = await svc(`fdh_financial_accounts?id=eq.${acct.id}&select=display_name`);
record('rls', '04 B cannot update A account', '0 rows changed + name intact',
  `${bUpd.json?.length ?? 0} rows; name="${stillMine.json?.[0]?.display_name}"`,
  bUpdOk && stillMine.json?.[0]?.display_name === `${TAG} Everyday`);
const bDel = await rest(`fdh_financial_accounts?id=eq.${acct.id}`, { token: B.token, method: 'DELETE', prefer: 'return=representation' });
const survives = await svc(`fdh_financial_accounts?id=eq.${acct.id}&select=id`);
record('rls', '05 B cannot delete A account', '0 rows deleted + row survives',
  `${bDel.json?.length ?? 0} deleted; survives=${survives.json?.length === 1}`,
  (bDel.json?.length ?? 0) === 0 && survives.json?.length === 1);
// 6 ownership spoof
const spoof = await rest('fdh_financial_accounts', {
  token: B.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: A.userId, account_type: 'savings', country_code: 'AU', currency_code: 'AUD', display_name: 'FORGED' },
});
record('rls', '06 B cannot insert row owned by A', 'denied 401/403', `http ${spoof.status}`, spoof.status === 403 || spoof.status === 401);
// 7 master read
const mRead = await rest('fdh_financial_institutions?select=id&limit=1', { token: A.token });
record('rls', '07 authenticated user can read master data', 'http 200', `http ${mRead.status}`, mRead.ok);
// 8-11 master writes denied
const payloads = {
  fdh_financial_institutions: { country_code: 'AU', institution_code: 'evil', institution_name: 'Evil', institution_type: 'bank' },
  fdh_merchants: { canonical_name: 'evil', display_name: 'Evil' },
  fdh_categories: { category_key: 'evil', display_name: 'Evil', economic_type: 'expense' },
  fdh_classification_rules: { rule_key: 'evil', rule_type: 'mcc', match_definition: { match_kind: 'mcc', mcc: '5411' }, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } },
};
let n = 8;
for (const t of Object.keys(payloads)) {
  const w = await rest(t, { token: A.token, method: 'POST', prefer: 'return=representation', body: payloads[t] });
  record('rls', `${String(n++).padStart(2, '0')} user cannot write master data: ${t}`, 'denied 401/403', `http ${w.status}`, w.status === 403 || w.status === 401);
}
// 12 append-only, now against a REAL owned history row
const hUpd = await rest(`fdh_classification_history?id=eq.${hist.id}`, { token: A.token, method: 'PATCH', prefer: 'return=representation', body: { changed_by_type: 'system' } });
const hAfter = await svc(`fdh_classification_history?id=eq.${hist.id}&select=changed_by_type`);
record('rls', '12 classification history rejects UPDATE by its OWNER (append-only, real row)',
  '0 rows changed + value intact "user"',
  `${hUpd.json?.length ?? 0} rows; value="${hAfter.json?.[0]?.changed_by_type}"`,
  (hUpd.json?.length ?? 0) === 0 && hAfter.json?.[0]?.changed_by_type === 'user');
// 13-27 anon denied on each user table — now meaningful, rows exist
n = 13;
for (const t of USER_TABLES) {
  const a = await rest(`${t}?select=*&limit=1`);
  const rows = Array.isArray(a.json) ? a.json.length : 0;
  record('rls', `${String(n++).padStart(2, '0')} anon cannot read ${t} (table non-empty)`, '0 rows', `${rows} rows (http ${a.status})`, rows === 0);
}

// ---------------------------------------------------------------------------
// Phase 4 — per-table cross-user isolation (beyond the mandated 27).
// ---------------------------------------------------------------------------
console.log('\n--- phase 4: per-table cross-user isolation (B vs every A-owned table) ---');
for (const t of USER_TABLES) {
  const r = await rest(`${t}?select=id`, { token: B.token });
  const rows = Array.isArray(r.json) ? r.json.length : 0;
  record('isolation', `B sees 0 rows in ${t}`, '0 rows', `${rows} rows`, rows === 0);
}
// B attempts to delete every A row wholesale
for (const t of USER_TABLES) {
  const d = await rest(`${t}?user_id=eq.${A.userId}`, { token: B.token, method: 'DELETE', prefer: 'return=representation' });
  const after = await svc(`${t}?select=id&user_id=eq.${A.userId}`);
  const rows = Array.isArray(after.json) ? after.json.length : 0;
  record('isolation', `B cannot delete A rows in ${t}`, 'A rows survive', `deleted=${d.json?.length ?? 0}, A rows remaining=${rows}`, (d.json?.length ?? 0) === 0 && rows > 0);
}
// household_id is NOT an access path. Note B still sets user_id to ITS OWN id
// here — this is not an ownership spoof (check 06 covers that); it probes
// whether a user may reference another tenant's account/household by id.
const hhSpoof = await rest('fdh_transactions', {
  token: B.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: B.userId, household_id: hh.id, financial_account_id: acct.id, transaction_date: '2026-03-03', amount_original: '1.0000', currency_original: 'AUD', credit_debit: 'debit' },
});
created.a['fdh_transactions'] = [...(created.a['fdh_transactions'] || [])];
// FINDING FDH1-F1: Postgres does not apply RLS to foreign-key validation, so
// the INSERT is accepted. Recorded as a standing finding so it stays visible.
record('finding', 'FDH1-F1 cross-tenant FK reference accepted at INSERT (RLS does not gate FK validation)',
  'ideally denied', `http ${hhSpoof.status} — accepted`, false);
// The property that actually governs confidentiality: can B READ anything of A's through it?
const embed = await rest(`fdh_transactions?id=eq.${hhSpoof.json?.[0]?.id}&select=id,fdh_financial_accounts(display_name,masked_identifier,user_id)`, { token: B.token });
const leaked = /display_name|masked_identifier/.test(embed.text);
record('isolation', 'FDH1-F1 impact: B cannot read A account data through the cross-tenant reference',
  'embedded account null / no leak', leaked ? 'LEAKED' : 'null — RLS holds on the join', !leaked);
const aView = await rest(`fdh_transactions?financial_account_id=eq.${acct.id}&select=user_id`, { token: A.token });
record('isolation', 'FDH1-F1 impact: A\'s own account view is not polluted by B\'s row',
  'all rows owned by A', `${aView.json?.length ?? 0} rows, all A: ${(aView.json ?? []).every((r) => r.user_id === A.userId)}`,
  (aView.json ?? []).every((r) => r.user_id === A.userId));
const enumr = await rest('fdh_financial_accounts?select=id', { token: B.token });
record('isolation', 'FDH1-F1 exploitability: B cannot enumerate any account id via FDH',
  '0 rows (UUID needs an out-of-band leak)', `${enumr.json?.length ?? 0} rows`, (enumr.json?.length ?? 0) === 0);
// B cannot read A's user rule
const bRule = await rest(`fdh_user_classification_rules?id=eq.${urule.id}&select=id`, { token: B.token });
record('isolation', 'B cannot read A user classification rule', '0 rows', `${bRule.json?.length ?? 0} rows`, (bRule.json?.length ?? 0) === 0);
// B can create its own rule (legitimate use still works)
const bOwnRule = await rest('fdh_user_classification_rules', {
  token: B.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: B.userId, rule_type: 'mcc', match_definition: { match_kind: 'mcc', mcc: '5411' }, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } },
});
record('isolation', 'B CAN create its own rule (isolation is not over-blocking)', 'http 201', `http ${bOwnRule.status}`, bOwnRule.status === 201);
if (bOwnRule.ok) created.bRule = bOwnRule.json[0].id;
// global rule governance: user cannot approve a global rule
const approve = await rest(`fdh_classification_rules?id=eq.${grule.id}`, { token: A.token, method: 'PATCH', prefer: 'return=representation', body: { status: 'approved' } });
const gAfter = await svc(`fdh_classification_rules?id=eq.${grule.id}&select=status`);
record('isolation', 'user cannot approve a global rule', '0 rows changed + status still proposed',
  `${approve.json?.length ?? 0} rows; status="${gAfter.json?.[0]?.status}"`,
  (approve.json?.length ?? 0) === 0 && gAfter.json?.[0]?.status === 'proposed');
// user cannot delete master data
const mDel = await rest(`fdh_merchants?id=eq.${merch.id}`, { token: A.token, method: 'DELETE', prefer: 'return=representation' });
const mAfter = await svc(`fdh_merchants?id=eq.${merch.id}&select=id`);
record('isolation', 'user cannot delete master merchant', 'row survives', `deleted=${mDel.json?.length ?? 0}, survives=${mAfter.json?.length === 1}`, (mDel.json?.length ?? 0) === 0 && mAfter.json?.length === 1);

// ---------------------------------------------------------------------------
// Phase 5 — financial data integrity (live constraint behaviour).
// ---------------------------------------------------------------------------
console.log('\n--- phase 5: financial data integrity ---');
async function tryA(table, body) { return rest(table, { token: A.token, method: 'POST', prefer: 'return=representation', body }); }
function track(t, r) { if (r.ok && r.json?.[0]?.id) created.a[t] = [...(created.a[t] || []), r.json[0].id]; return r; }

// raw account identifier protection
const rawAcct = await tryA('fdh_financial_accounts', {
  user_id: A.userId, account_type: 'savings', country_code: 'AU', currency_code: 'AUD',
  display_name: `${TAG} raw`, masked_identifier: '062000123456789',
});
record('integrity', 'raw long digit run rejected in masked_identifier', 'rejected (constraint)',
  `http ${rawAcct.status} ${rawAcct.json?.message ?? ''}`.slice(0, 120), !rawAcct.ok);
const maskedAcct = track('fdh_financial_accounts', await tryA('fdh_financial_accounts', {
  user_id: A.userId, account_type: 'savings', country_code: 'AU', currency_code: 'AUD',
  display_name: `${TAG} masked`, masked_identifier: 'XXXX-4321',
}));
record('integrity', 'properly masked identifier accepted', 'http 201', `http ${maskedAcct.status}`, maskedAcct.status === 201);
// exactly 6 digits allowed, 7 rejected (boundary)
const six = track('fdh_financial_accounts', await tryA('fdh_financial_accounts', { user_id: A.userId, account_type: 'savings', country_code: 'AU', currency_code: 'AUD', display_name: `${TAG} six`, masked_identifier: '123456' }));
const seven = await tryA('fdh_financial_accounts', { user_id: A.userId, account_type: 'savings', country_code: 'AU', currency_code: 'AUD', display_name: `${TAG} seven`, masked_identifier: '1234567' });
record('integrity', 'digit-run boundary: 6 accepted / 7 rejected', '201 then rejected', `six=${six.status} seven=${seven.status}`, six.status === 201 && !seven.ok);

// country structural
const badCountry = await tryA('fdh_financial_accounts', { user_id: A.userId, account_type: 'savings', country_code: 'ZZ', currency_code: 'AUD', display_name: `${TAG} zz` });
record('integrity', 'invalid country_code rejected (AU/IN only)', 'rejected', `http ${badCountry.status}`, !badCountry.ok);
const inAcct = track('fdh_financial_accounts', await tryA('fdh_financial_accounts', { user_id: A.userId, account_type: 'savings', country_code: 'IN', currency_code: 'INR', display_name: `${TAG} india` }));
record('integrity', 'IN / INR account representable', 'http 201', `http ${inAcct.status}`, inAcct.status === 201);

// monetary precision round-trip
const money = [
  ['AUD cents', 'AUD', '1234.5600'],
  ['INR paise', 'INR', '987654.2100'],
  ['large crore-scale', 'INR', '999999999999.9900'],
];
for (const [label, cur, amt] of money) {
  const r = track('fdh_transactions', await tryA('fdh_transactions', {
    user_id: A.userId, financial_account_id: cur === 'INR' ? inAcct.json?.[0]?.id : acct.id,
    transaction_date: '2026-03-05', amount_original: amt, currency_original: cur, credit_debit: 'debit',
  }));
  // Compare the RAW WIRE TEXT, not a JS-parsed value: JSON.parse normalises
  // 1234.5600 to 1234.56, which would report a false precision failure. The
  // wire form also proves the column is numeric rather than float8.
  const backRes = r.ok ? await svc(`fdh_transactions?id=eq.${r.json[0].id}&select=amount_original`) : null;
  const wire = backRes?.text.match(/"amount_original":([^,}\]]+)/)?.[1] ?? 'n/a';
  record('integrity', `monetary round-trip ${label}`, `${amt} exact on the wire`, `${wire}`, wire === amt);
}
const negAmt = await tryA('fdh_transactions', { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-05', amount_original: '-10.0000', currency_original: 'AUD', credit_debit: 'debit' });
record('integrity', 'negative amount rejected (magnitude-only design)', 'rejected', `http ${negAmt.status}`, !negAmt.ok);

// currency separation + FX nullability
const fxTxn = track('fdh_transactions', await tryA('fdh_transactions', {
  user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-06',
  amount_original: '100.0000', currency_original: 'INR', amount_reporting_currency: '1.8000',
  reporting_currency: 'AUD', fx_rate: '0.0180000000', fx_rate_date: '2026-03-06', fx_rate_source: 'statement_supplied', credit_debit: 'debit',
}));
record('integrity', 'original currency separable from reporting currency (INR->AUD)', 'http 201', `http ${fxTxn.status}`, fxTxn.status === 201);
const noFx = track('fdh_transactions', await tryA('fdh_transactions', { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-06', amount_original: '5.0000', currency_original: 'AUD', credit_debit: 'debit' }));
record('integrity', 'FX metadata nullable when no conversion occurred', 'http 201', `http ${noFx.status}`, noFx.status === 201);
const halfFx = await tryA('fdh_transactions', { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-06', amount_original: '5.0000', currency_original: 'AUD', credit_debit: 'debit', amount_reporting_currency: '5.0000' });
record('integrity', 'reporting amount without reporting currency rejected', 'rejected', `http ${halfFx.status}`, !halfFx.ok);

// confidence bounds
for (const [v, want] of [['0.0000', true], ['1.0000', true], ['0.5000', true], ['-0.0100', false], ['1.0100', false]]) {
  const r = track('fdh_transactions', await tryA('fdh_transactions', {
    user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-07',
    amount_original: '1.0000', currency_original: 'AUD', credit_debit: 'debit', classification_confidence: v,
  }));
  record('integrity', `confidence ${v} ${want ? 'accepted' : 'rejected'}`, want ? 'http 201' : 'rejected', `http ${r.status}`, want ? r.status === 201 : !r.ok);
}

// direction vs economic meaning independence
for (const [cd, et] of [['credit', 'transfer'], ['debit', 'investment'], ['credit', 'refund'], ['debit', 'debt_principal']]) {
  const r = track('fdh_transactions', await tryA('fdh_transactions', {
    user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-08',
    amount_original: '1.0000', currency_original: 'AUD', credit_debit: cd, economic_transaction_type: et,
  }));
  record('integrity', `direction independent of meaning: ${cd}+${et}`, 'http 201', `http ${r.status}`, r.status === 201);
}

// allocations
const allocSum = await svc(`fdh_transaction_allocations?transaction_id=eq.${txn.id}&select=amount`);
const total = (allocSum.json || []).reduce((s, r2) => s + Number(r2.amount), 0);
record('integrity', 'exact split 650 = 450+150+50 persists', '650', `${total}`, total === 650);
const dupSeq = await tryA('fdh_transaction_allocations', { user_id: A.userId, transaction_id: txn.id, allocation_sequence: 1, economic_transaction_type: 'expense', amount: '1.0000', currency_code: 'AUD' });
record('integrity', 'duplicate allocation_sequence rejected', 'rejected', `http ${dupSeq.status}`, !dupSeq.ok);
const partial = track('fdh_transaction_allocations', await tryA('fdh_transaction_allocations', { user_id: A.userId, transaction_id: txn2.id, allocation_sequence: 1, economic_transaction_type: 'expense', amount: '100.0000', currency_code: 'AUD' }));
record('integrity', 'draft under-allocation allowed (incomplete review state by design)', 'http 201', `http ${partial.status}`, partial.status === 201);

// reconciliation honesty
const badRecon = await tryA('fdh_reconciliation_results', {
  user_id: A.userId, statement_upload_id: upload.id, variance: '25.0000', variance_tolerance: '0.0000', status: 'reconciled', currency_code: 'AUD',
});
record('integrity', 'reconciled status with variance beyond tolerance rejected', 'rejected', `http ${badRecon.status}`, !badRecon.ok);
for (const st of ['failed', 'not_available']) {
  const r = track('fdh_reconciliation_results', await tryA('fdh_reconciliation_results', { user_id: A.userId, statement_upload_id: upload.id, variance: '25.0000', status: st, currency_code: 'AUD' }));
  record('integrity', `reconciliation status ${st} representable with variance`, 'http 201', `http ${r.status}`, r.status === 201);
}

// purge compatibility
const purgeBad = await rest(`fdh_statement_uploads?id=eq.${upload.id}`, { token: A.token, method: 'PATCH', prefer: 'return=representation', body: { raw_document_purge_status: 'purged', raw_document_storage_reference: 'bucket/doc.pdf' } });
record('integrity', 'cannot claim purged while still holding a storage reference', 'rejected', `http ${purgeBad.status}`, !purgeBad.ok);
const purgeSeq = [];
for (const st of ['pending', 'purged', 'failed']) {
  const body = st === 'purged' ? { raw_document_purge_status: 'purged', raw_document_storage_reference: null, raw_document_purged_at: new Date().toISOString() } : { raw_document_purge_status: st, raw_document_purged_at: null };
  const r = await rest(`fdh_statement_uploads?id=eq.${upload.id}`, { token: A.token, method: 'PATCH', prefer: 'return=representation', body });
  purgeSeq.push(`${st}:${r.status}`);
}
record('integrity', 'purge lifecycle PENDING->PURGED->FAILED transitions structurally', 'all accepted', purgeSeq.join(' '), purgeSeq.every((s) => s.endsWith(':200')));
const nulled = await rest(`fdh_transactions?id=eq.${txn.id}`, { token: A.token, method: 'PATCH', prefer: 'return=representation', body: { description_raw: null, merchant_raw: null } });
const nAfter = await svc(`fdh_transactions?id=eq.${txn.id}&select=description_raw,merchant_raw`);
record('integrity', 'raw fields nullable/purgeable (description_raw, merchant_raw)', 'both null',
  `raw=${nAfter.json?.[0]?.description_raw} merch=${nAfter.json?.[0]?.merchant_raw}`,
  nulled.ok && nAfter.json?.[0]?.description_raw === null && nAfter.json?.[0]?.merchant_raw === null);

// provenance + review persistence
const provRow = await svc(`fdh_data_provenance?id=eq.${prov.id}&select=parser_id,parser_version_id`);
record('integrity', 'provenance retains parser_id AND parser_version_id', 'both set',
  `parser=${!!provRow.json?.[0]?.parser_id} version=${!!provRow.json?.[0]?.parser_version_id}`,
  !!provRow.json?.[0]?.parser_id && !!provRow.json?.[0]?.parser_version_id);
const openReview = await svc(`fdh_review_items?user_id=eq.${A.userId}&status=eq.open&select=id,review_type`);
record('integrity', 'review item persists OPEN independent of any job/session', '>=1 open item',
  `${openReview.json?.length ?? 0} open (${openReview.json?.[0]?.review_type})`, (openReview.json?.length ?? 0) >= 1);
const openLink = await svc(`fdh_transaction_links?user_id=eq.${A.userId}&select=link_type,transaction_id_to`);
record('integrity', 'transaction link representable with NULL counterpart (future transfer match)', 'to=null',
  `type=${openLink.json?.[0]?.link_type} to=${openLink.json?.[0]?.transaction_id_to}`,
  openLink.json?.[0]?.transaction_id_to === null);
const histRow = await svc(`fdh_classification_history?id=eq.${hist.id}&select=previous_economic_transaction_type,new_economic_transaction_type,classification_method`);
const h0 = histRow.json?.[0];
record('integrity', 'classification history records unknown->expense via user_manual', 'unknown/expense/user_manual',
  `${h0?.previous_economic_transaction_type}/${h0?.new_economic_transaction_type}/${h0?.classification_method}`,
  h0?.previous_economic_transaction_type === 'unknown' && h0?.new_economic_transaction_type === 'expense' && h0?.classification_method === 'user_manual');

// FK delete semantics — behavioural spot-checks of each of the three actions
const cascadeProbe = track('fdh_transactions', await tryA('fdh_transactions', { user_id: A.userId, financial_account_id: maskedAcct.json?.[0]?.id, transaction_date: '2026-03-09', amount_original: '3.0000', currency_original: 'AUD', credit_debit: 'debit' }));
await rest(`fdh_financial_accounts?id=eq.${maskedAcct.json?.[0]?.id}`, { token: A.token, method: 'DELETE' });
const cascaded = await svc(`fdh_transactions?id=eq.${cascadeProbe.json?.[0]?.id}&select=id`);
record('fk', 'ON DELETE CASCADE live: deleting account removes its transactions', '0 rows remain', `${cascaded.json?.length ?? 0} rows`, (cascaded.json?.length ?? 0) === 0);
const restrictProbe = await svc(`fdh_financial_institutions?id=eq.${inst.id}`, { method: 'DELETE', prefer: 'return=representation' });
record('fk', 'ON DELETE RESTRICT live: institution in use cannot be deleted', 'rejected', `http ${restrictProbe.status}`, !restrictProbe.ok);
const setNullProbe = await svc(`fdh_merchants?id=eq.${merch.id}`, { method: 'DELETE', prefer: 'return=representation' });
const txnAfterMerch = await svc(`fdh_transactions?id=eq.${txn.id}&select=merchant_id`);
record('fk', 'ON DELETE SET NULL live: deleting merchant nulls txn.merchant_id', 'merchant_id null',
  `delete http ${setNullProbe.status}, merchant_id=${txnAfterMerch.json?.[0]?.merchant_id}`,
  setNullProbe.ok && txnAfterMerch.json?.[0]?.merchant_id === null);

// ---------------------------------------------------------------------------
// Phase 6 — cleanup. Remove every synthetic artefact.
// ---------------------------------------------------------------------------
console.log('\n--- phase 6: synthetic data cleanup ---');
const DELETE_ORDER = [
  'fdh_evidence_links', 'fdh_data_provenance', 'fdh_data_quality_results',
  'fdh_reconciliation_results', 'fdh_review_items', 'fdh_recurring_transactions',
  'fdh_classification_history', 'fdh_user_classification_rules', 'fdh_duplicate_candidates',
  'fdh_transaction_links', 'fdh_transaction_allocations', 'fdh_transactions',
  'fdh_ingestion_jobs', 'fdh_statement_uploads', 'fdh_financial_accounts',
];
for (const t of DELETE_ORDER) {
  for (const uid of [A.userId, B.userId]) await svc(`${t}?user_id=eq.${uid}`, { method: 'DELETE' });
}
for (const hid of created.households) await svc(`households?id=eq.${hid}`, { method: 'DELETE' });
await svc(`fdh_parser_versions?id=eq.${pver.id}`, { method: 'DELETE' });
await svc(`fdh_parser_registry?id=eq.${preg.id}`, { method: 'DELETE' });
await svc(`fdh_classification_rules?id=eq.${grule.id}`, { method: 'DELETE' });
// NB: PostgREST's `like` wildcard is *, NOT the SQL %. Using % here matches
// nothing and silently leaves synthetic master data behind in DEV.
await svc(`fdh_merchants?canonical_name=like.${TAG}*`, { method: 'DELETE' });
await svc(`fdh_subcategories?id=eq.${sub.id}`, { method: 'DELETE' });
await svc(`fdh_categories?category_key=like.${TAG}*`, { method: 'DELETE' });
await svc(`fdh_financial_institutions?institution_code=like.${TAG}*`, { method: 'DELETE' });
for (const u of [A, B]) {
  await fetch(`${BASE}/auth/v1/admin/users/${u.userId}`, {
    method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
}
let residue = 0;
const residueDetail = [];
for (const t of [...USER_TABLES, 'fdh_financial_institutions', 'fdh_categories', 'fdh_subcategories', 'fdh_merchants', 'fdh_classification_rules', 'fdh_parser_registry', 'fdh_parser_versions']) {
  const r = await svc(`${t}?select=*`, { prefer: 'count=exact' });
  const c = Array.isArray(r.json) ? r.json.length : 0;
  if (c > 0) { residue += c; residueDetail.push(`${t}=${c}`); }
}
record('cleanup', 'no synthetic FDH data remains in DEV', '0 rows across all 22 non-seed FDH tables',
  residue === 0 ? '0 rows' : `RESIDUE ${residueDetail.join(', ')}`, residue === 0);
const st = await svc('fdh_source_types?select=source_type_key', { prefer: 'count=exact' });
record('cleanup', 'migration-seeded fdh_source_types left intact (legitimate data preserved)', '9 rows', `${st.json?.length} rows`, st.json?.length === 9);
const hhCount = await fetch(`${BASE}/rest/v1/households?select=*`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact', Range: '0-0' } });
record('cleanup', 'pre-existing households row count unchanged (242 before)', '242', `${hhCount.headers.get('content-range')}`, (hhCount.headers.get('content-range') || '').endsWith('/242'));

// ---------------------------------------------------------------------------
console.log('\n=============================================================');
const bySection = {};
for (const c of checks) {
  bySection[c.section] ||= { pass: 0, fail: 0 };
  if (c.pass) bySection[c.section].pass++;
  else bySection[c.section].fail++;
}
for (const [s, v] of Object.entries(bySection)) console.log(`${s}: ${v.pass}/${v.pass + v.fail} passed`);
const failed = checks.filter((c) => !c.pass);
console.log(`\nTOTAL: ${checks.length - failed.length}/${checks.length} passed`);
const rls = checks.filter((c) => c.section === 'rls');
console.log(`MANDATED 27-CHECK SUITE: ${rls.filter((c) => c.pass).length}/${rls.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - [${f.section}] ${f.name} | expected ${f.expected} | actual ${f.actual}`);
  process.exitCode = 1;
}
fs.writeFileSync(path.join(repoRoot, 'scripts', '.fdh1-closure-results.json'), JSON.stringify(checks, null, 2));
