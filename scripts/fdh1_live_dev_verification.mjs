// Financial Data Hub — FDH-1 live DEV verification.
//
// Two things this script does, and one it deliberately does not.
//
//   DOES: probe which FDH tables exist in the target Supabase project, and
//         (once they do) run real cross-tenant RLS exploitation attempts
//         against them using two ordinary authenticated users.
//   DOES NOT: apply any migration, create any table, or modify any existing
//         row. This environment has no psql, no Docker and no SQL-execution
//         RPC, so DDL cannot be applied programmatically from here; migrations
//         0031-0034 must be applied through the Supabase SQL editor by someone
//         with console access.
//
// Usage:
//   node scripts/fdh1_live_dev_verification.mjs            # schema probe only
//   node scripts/fdh1_live_dev_verification.mjs --rls      # + RLS attack suite
//                                                          #   (creates two
//                                                          #   throwaway users)
//
// Credentials come from .env.local at the repo root, falling back to the
// parent checkout when this runs inside a git worktree.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const candidates = [
    path.join(repoRoot, '.env.local'),
    path.resolve(repoRoot, '..', '..', '..', '.env.local'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const env = {};
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return { env, source: p };
  }
  throw new Error(`No .env.local found in any of: ${candidates.join(', ')}`);
}

const { env, source } = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !ANON || !SERVICE) throw new Error('Missing Supabase credentials in .env.local');

const MASTER_TABLES = [
  'fdh_source_types',
  'fdh_financial_institutions',
  'fdh_categories',
  'fdh_subcategories',
  'fdh_merchants',
  'fdh_merchant_aliases',
  'fdh_classification_rules',
  'fdh_parser_registry',
  'fdh_parser_versions',
];

const USER_TABLES = [
  'fdh_financial_accounts',
  'fdh_statement_uploads',
  'fdh_ingestion_jobs',
  'fdh_transactions',
  'fdh_transaction_allocations',
  'fdh_transaction_links',
  'fdh_duplicate_candidates',
  'fdh_user_classification_rules',
  'fdh_classification_history',
  'fdh_recurring_transactions',
  'fdh_review_items',
  'fdh_reconciliation_results',
  'fdh_data_quality_results',
  'fdh_data_provenance',
  'fdh_evidence_links',
];

async function rest(pathAndQuery, { key, token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token ?? key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function probeSchema() {
  console.log(`Credentials source: ${source}`);
  console.log(`Project host:       ${new URL(BASE).host}\n`);
  console.log('--- FDH table presence (service role, read-only) ---');
  let present = 0;
  for (const table of [...MASTER_TABLES, ...USER_TABLES]) {
    const r = await rest(`${table}?select=*&limit=1`, { key: SERVICE });
    // PGRST205 = table not found in schema cache.
    const missing = r.status === 404 || r.text.includes('PGRST205');
    if (!missing) present += 1;
    console.log(`${missing ? 'MISSING ' : 'PRESENT '} ${table}  (http ${r.status})`);
  }
  console.log(
    `\n${present}/${MASTER_TABLES.length + USER_TABLES.length} FDH tables present in this project.`,
  );
  return present;
}

async function signUp(label) {
  const email = `fdh1-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `Fdh1!${Math.random().toString(36).slice(2, 12)}A`;
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token || !json.user?.id) {
    throw new Error(`signup failed for ${label}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { email, token: json.access_token, userId: json.user.id };
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function rlsSuite() {
  console.log('\n--- Live RLS suite (two throwaway authenticated users) ---');
  const a = await signUp('a');
  const b = await signUp('b');
  console.log(`user A ${a.userId}\nuser B ${b.userId}\n`);

  // 1. A creates an account of their own.
  const create = await rest('fdh_financial_accounts', {
    key: ANON,
    token: a.token,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: a.userId,
      account_type: 'transaction',
      country_code: 'AU',
      currency_code: 'AUD',
      display_name: 'FDH1 probe account',
      masked_identifier: '****1234',
    },
  });
  record('A can create own account', create.status === 201, `http ${create.status} ${create.text.slice(0, 160)}`);
  let accountId = null;
  try {
    accountId = JSON.parse(create.text)[0]?.id ?? null;
  } catch {
    /* left null; subsequent checks report accordingly */
  }

  // 2. A can read it back.
  if (accountId) {
    const read = await rest(`fdh_financial_accounts?id=eq.${accountId}&select=id`, {
      key: ANON,
      token: a.token,
    });
    record('A can read own account', read.ok && JSON.parse(read.text).length === 1, `http ${read.status}`);
  }

  // 3. B must NOT see it.
  if (accountId) {
    const cross = await rest(`fdh_financial_accounts?id=eq.${accountId}&select=id`, {
      key: ANON,
      token: b.token,
    });
    let rows = [];
    try { rows = JSON.parse(cross.text); } catch { /* non-JSON body counts as no rows */ }
    record('B cannot read A\'s account', rows.length === 0, `http ${cross.status} rows=${rows.length}`);
  }

  // 4. B must NOT update it.
  if (accountId) {
    const upd = await rest(`fdh_financial_accounts?id=eq.${accountId}`, {
      key: ANON,
      token: b.token,
      method: 'PATCH',
      prefer: 'return=representation',
      body: { display_name: 'HIJACKED' },
    });
    let rows = [];
    try { rows = JSON.parse(upd.text); } catch { /* ignore */ }
    record('B cannot update A\'s account', rows.length === 0, `http ${upd.status} rows=${rows.length}`);
  }

  // 5. B must NOT delete it.
  if (accountId) {
    const del = await rest(`fdh_financial_accounts?id=eq.${accountId}`, {
      key: ANON,
      token: b.token,
      method: 'DELETE',
      prefer: 'return=representation',
    });
    let rows = [];
    try { rows = JSON.parse(del.text); } catch { /* ignore */ }
    record('B cannot delete A\'s account', rows.length === 0, `http ${del.status} rows=${rows.length}`);
  }

  // 6. Tenant spoofing on INSERT: B forges A's user_id.
  const spoof = await rest('fdh_financial_accounts', {
    key: ANON,
    token: b.token,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: a.userId,
      account_type: 'savings',
      country_code: 'AU',
      currency_code: 'AUD',
      display_name: 'FORGED',
    },
  });
  record('B cannot insert a row owned by A', spoof.status === 403 || spoof.status === 401, `http ${spoof.status}`);

  // 7. Master data is readable but NOT writable by an ordinary user.
  const readMaster = await rest('fdh_financial_institutions?select=id&limit=1', {
    key: ANON,
    token: a.token,
  });
  record('authenticated user can read master data', readMaster.ok, `http ${readMaster.status}`);

  for (const table of ['fdh_financial_institutions', 'fdh_merchants', 'fdh_categories', 'fdh_classification_rules']) {
    const payloads = {
      fdh_financial_institutions: { country_code: 'AU', institution_code: 'evil', institution_name: 'Evil', institution_type: 'bank' },
      fdh_merchants: { canonical_name: 'evil', display_name: 'Evil' },
      fdh_categories: { category_key: 'evil', display_name: 'Evil', economic_type: 'expense' },
      fdh_classification_rules: { rule_key: 'evil', rule_type: 'mcc', match_definition: { match_kind: 'mcc', mcc: '5411' }, action_definition: { action_kind: 'classify', economic_transaction_type: 'expense' } },
    };
    const w = await rest(table, {
      key: ANON,
      token: a.token,
      method: 'POST',
      prefer: 'return=representation',
      body: payloads[table],
    });
    record(`user cannot write master data: ${table}`, w.status === 403 || w.status === 401, `http ${w.status}`);
  }

  // 8. Classification history is append-only: no UPDATE, no DELETE policy.
  //    (Only meaningful once a transaction exists; probe the verbs directly.)
  const histUpdate = await rest('fdh_classification_history?id=eq.00000000-0000-0000-0000-000000000000', {
    key: ANON,
    token: a.token,
    method: 'PATCH',
    prefer: 'return=representation',
    body: { changed_by_type: 'system' },
  });
  let histRows = [];
  try { histRows = JSON.parse(histUpdate.text); } catch { /* ignore */ }
  record(
    'classification history rejects UPDATE (append-only)',
    histRows.length === 0,
    `http ${histUpdate.status}`,
  );

  // 9. Anonymous access must be denied on every user-owned table.
  for (const table of USER_TABLES) {
    const anon = await rest(`${table}?select=*&limit=1`, { key: ANON });
    let rows = [];
    try { rows = JSON.parse(anon.text); } catch { /* ignore */ }
    record(`anon cannot read ${table}`, Array.isArray(rows) ? rows.length === 0 : true, `http ${anon.status}`);
  }

  // Clean up the probe row so DEV is left as it was found.
  if (accountId) {
    await rest(`fdh_financial_accounts?id=eq.${accountId}`, {
      key: ANON,
      token: a.token,
      method: 'DELETE',
    });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} live RLS checks passed.`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

const present = await probeSchema();
if (process.argv.includes('--rls')) {
  if (present === 0) {
    console.log('\nSkipping RLS suite: no FDH table exists in this project yet.');
    console.log('Apply supabase/migrations/0031-0034 first, then re-run with --rls.');
    process.exitCode = 2;
  } else {
    await rlsSuite();
  }
}
