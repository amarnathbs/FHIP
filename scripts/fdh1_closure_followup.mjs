// FDH-1 closure follow-up: triage the 5 failures from the certification run.
//  (a) monetary round-trip — string-compare artefact, or real precision loss?
//  (b) cross-tenant FK reference — does it leak any of A's data to B?
//  (c) residue cleanup — PostgREST `like` uses * not % as the wildcard.
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
    return env;
  }
  throw new Error('no .env.local');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const TAG = 'FDH1FOLLOWUP';

async function rest(q, { key = ANON, token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${q}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, ok: res.ok, text, json };
}
const svc = (q, o = {}) => rest(q, { ...o, key: SERVICE });
async function signUp(l) {
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `fdh1-fu-${l}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, password: `Fdh1!${Math.random().toString(36).slice(2, 12)}A` }),
  });
  const j = await res.json();
  return { token: j.access_token, userId: j.user.id };
}

// ---------------------------------------------------------------------------
console.log('=== (c) clean residue left by the certification run ===');
console.log('(PostgREST `like` wildcard is *, not % — the earlier cleanup filters silently matched nothing)');
for (const q of [
  'fdh_categories?category_key=like.FDH1CLOSURE*',
  'fdh_financial_institutions?institution_code=like.FDH1CLOSURE*',
  'fdh_merchants?canonical_name=like.FDH1CLOSURE*',
  'fdh_classification_rules?rule_key=like.FDH1CLOSURE*',
  'fdh_parser_registry?parser_key=like.FDH1CLOSURE*',
]) {
  const before = await svc(`${q}&select=id`);
  const d = await svc(q, { method: 'DELETE', prefer: 'return=representation' });
  console.log(`  ${q.split('?')[0]}: found ${before.json?.length ?? 0}, deleted ${d.json?.length ?? 0} (http ${d.status})`);
}
console.log('\n  residue re-check across all 24 FDH tables:');
const ALL = ['fdh_source_types','fdh_financial_institutions','fdh_categories','fdh_subcategories','fdh_merchants','fdh_merchant_aliases','fdh_classification_rules','fdh_parser_registry','fdh_parser_versions','fdh_financial_accounts','fdh_statement_uploads','fdh_ingestion_jobs','fdh_transactions','fdh_transaction_allocations','fdh_transaction_links','fdh_duplicate_candidates','fdh_user_classification_rules','fdh_classification_history','fdh_recurring_transactions','fdh_review_items','fdh_reconciliation_results','fdh_data_quality_results','fdh_data_provenance','fdh_evidence_links'];
let residue = 0;
for (const t of ALL) {
  const r = await svc(`${t}?select=*`);
  const c = Array.isArray(r.json) ? r.json.length : 0;
  if (c > 0) { console.log(`    ${t}: ${c} rows${t === 'fdh_source_types' ? ' (migration seed — legitimate, keep)' : ' <-- RESIDUE'}`); if (t !== 'fdh_source_types') residue += c; }
}
console.log(`  synthetic residue remaining: ${residue}`);

// ---------------------------------------------------------------------------
console.log('\n=== (a) monetary precision — raw wire text, not JS-parsed ===');
const A = await signUp('a');
const acct = (await rest('fdh_financial_accounts', { token: A.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: A.userId, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: `${TAG} acct` } })).json[0];
for (const [label, amt, cur] of [['AUD cents', '1234.5600', 'AUD'], ['INR paise', '987654.2100', 'INR'], ['large', '999999999999.9900', 'INR'], ['sub-cent FX residue', '0.0001', 'AUD'], ['classic float trap 0.1+0.2', '0.3000', 'AUD']]) {
  const r = await rest('fdh_transactions', { token: A.token, method: 'POST', prefer: 'return=representation',
    body: { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-01', amount_original: amt, currency_original: cur, credit_debit: 'debit' } });
  const raw = await svc(`fdh_transactions?id=eq.${r.json[0].id}&select=amount_original`);
  const wire = raw.text.match(/"amount_original":([^,}\]]+)/)?.[1];
  const exact = Number(wire) === Number(amt);
  console.log(`  ${label}: sent ${amt} -> wire ${wire} | numerically exact: ${exact ? 'YES' : 'NO'}`);
}
// prove it is NOT a float column: a float8 would mangle this value
const bigr = await rest('fdh_transactions', { token: A.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-01', amount_original: '8191.1230', currency_original: 'AUD', credit_debit: 'debit' } });
const bigRaw = await svc(`fdh_transactions?id=eq.${bigr.json[0].id}&select=amount_original`);
console.log(`  float-artefact probe: sent 8191.1230 -> wire ${bigRaw.text.match(/"amount_original":([^,}\]]+)/)?.[1]} (a float8 column would drift here)`);
// scale enforcement: does numeric(20,4) round a 6-dp input rather than store it?
const scale = await rest('fdh_transactions', { token: A.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: A.userId, financial_account_id: acct.id, transaction_date: '2026-03-01', amount_original: '1.00005', currency_original: 'AUD', credit_debit: 'debit' } });
const scaleRaw = await svc(`fdh_transactions?id=eq.${scale.json[0].id}&select=amount_original`);
console.log(`  scale probe: sent 1.00005 -> wire ${scaleRaw.text.match(/"amount_original":([^,}\]]+)/)?.[1]} (numeric(20,4) rounds to 4dp)`);

// ---------------------------------------------------------------------------
console.log('\n=== (b) cross-tenant FK reference — confidentiality impact ===');
const B = await signUp('b');
// B writes a row it owns that points at A's account id (requires knowing the UUID).
const bTxn = await rest('fdh_transactions', { token: B.token, method: 'POST', prefer: 'return=representation',
  body: { user_id: B.userId, financial_account_id: acct.id, transaction_date: '2026-03-02', amount_original: '1.0000', currency_original: 'AUD', credit_debit: 'debit' } });
console.log(`  B inserts own txn referencing A's account id: http ${bTxn.status}  <-- the finding`);
// THE security question: can B now READ any of A's account data through it?
const embed = await rest(`fdh_transactions?id=eq.${bTxn.json?.[0]?.id}&select=id,financial_account_id,fdh_financial_accounts(id,display_name,masked_identifier,user_id)`, { token: B.token });
console.log(`  B attempts PostgREST embed of the referenced account: http ${embed.status}`);
console.log(`  payload: ${embed.text.slice(0, 300)}`);
const leaked = /display_name|masked_identifier/.test(embed.text) && !/\"fdh_financial_accounts\":null/.test(embed.text);
console.log(`  >>> A's account data leaked to B: ${leaked ? 'YES — CONFIDENTIALITY BREACH' : 'NO — embed returns null, RLS holds'}`);
// can B see A's account directly?
const direct = await rest(`fdh_financial_accounts?id=eq.${acct.id}&select=*`, { token: B.token });
console.log(`  B direct read of A's account: ${direct.json?.length ?? 0} rows`);
// does A see B's polluting row?
const aSees = await rest(`fdh_transactions?financial_account_id=eq.${acct.id}&select=id,user_id`, { token: A.token });
console.log(`  A's view of transactions on A's own account: ${aSees.json?.length ?? 0} rows, all owned by A: ${(aSees.json ?? []).every((r) => r.user_id === A.userId)}`);
// is the account id obtainable by B through any FDH read path?
const enumr = await rest('fdh_financial_accounts?select=id', { token: B.token });
console.log(`  B enumerating account ids via FDH: ${enumr.json?.length ?? 0} rows (UUID must be known out-of-band to exploit)`);

// ---------------------------------------------------------------------------
console.log('\n=== cleanup of follow-up fixtures ===');
for (const t of ['fdh_transactions', 'fdh_financial_accounts']) {
  for (const uid of [A.userId, B.userId]) await svc(`${t}?user_id=eq.${uid}`, { method: 'DELETE' });
}
for (const u of [A, B]) await fetch(`${BASE}/auth/v1/admin/users/${u.userId}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
let left = 0;
for (const t of ALL) {
  const r = await svc(`${t}?select=*`);
  const c = Array.isArray(r.json) ? r.json.length : 0;
  if (c > 0 && t !== 'fdh_source_types') { left += c; console.log(`  RESIDUE ${t}=${c}`); }
}
console.log(`FINAL synthetic residue across all 24 FDH tables: ${left} (fdh_source_types retains its 9 migration-seeded rows)`);
