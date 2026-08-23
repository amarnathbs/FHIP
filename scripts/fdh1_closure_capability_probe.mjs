// FDH-1 closure: probe what schema-metadata / DDL access this environment actually has.
// Read-only. Creates nothing. Used to establish, rather than assume, the limits
// under which the FDH-1 live certification must be performed.
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
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function t(label, url, opts = {}) {
  try {
    const res = await fetch(url, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, ...(opts.headers || {}) },
      method: opts.method || 'GET',
      body: opts.body,
    });
    const txt = await res.text();
    console.log(`${label}: http ${res.status} :: ${txt.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${label}: ERROR ${e.message}`);
  }
}

console.log(`host ${new URL(BASE).host}\n--- DDL / SQL execution capability ---`);
for (const fn of ['exec_sql', 'execute_sql', 'run_sql', 'admin_exec']) {
  await t(`rpc/${fn}`, `${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'select 1', sql: 'select 1' }),
  });
}
console.log('\n--- catalog / metadata reachability ---');
await t('public.tables', `${BASE}/rest/v1/tables?select=table_name&limit=1`);
await t('pg_class', `${BASE}/rest/v1/pg_class?select=relname&limit=1`);
await t('Accept-Profile:information_schema', `${BASE}/rest/v1/tables?select=table_name&limit=1`, {
  headers: { 'Accept-Profile': 'information_schema' },
});
await t('supabase_migrations ledger', `${BASE}/rest/v1/schema_migrations?select=version&limit=5`, {
  headers: { 'Accept-Profile': 'supabase_migrations' },
});
console.log('\n--- OpenAPI schema (the metadata channel that does work) ---');
await t('openapi root', `${BASE}/rest/v1/`);
