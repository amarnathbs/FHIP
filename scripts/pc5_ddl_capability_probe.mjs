// PC5 (M4) — read-only probe: is there ANY DDL execution path from this
// environment to DEV?
//
// Re-verified FRESH rather than inherited. Prior AIE/II scripts in this
// repository record that there is none (no exec_sql/execute_sql/run_sql/
// admin_exec RPC, no Management API token, no direct Postgres connection
// string, no `supabase login` session) — but "it was true last month" is
// not evidence, and migration 0153 either can or cannot be applied by this
// phase. This script answers that, with the exact refusal each candidate
// gives.
//
// Writes nothing. Every RPC below is called with a deliberately trivial
// statement (`select 1`) so that even if one unexpectedly EXISTS, it
// changes nothing.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) {
  console.log('DEV credentials not present — cannot probe.');
  process.exit(0);
}
const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const CANDIDATE_RPCS = ['exec_sql', 'execute_sql', 'run_sql', 'admin_exec', 'sql', 'pg_execute', 'exec', 'query'];

console.log(`=== DEV (${new URL(url).host}) — DDL capability probe ===\n`);
let anyAvailable = false;
for (const fn of CANDIDATE_RPCS) {
  const { error } = await client.rpc(fn, { sql: 'select 1' });
  if (!error) {
    anyAvailable = true;
    console.log(`  ${fn}: AVAILABLE (!) — a DDL path exists via this RPC`);
  } else {
    console.log(`  ${fn}: unavailable — ${error.code ?? '(no code)'} ${(error.message || '').slice(0, 90)}`);
  }
}

// The Supabase Management API would be the other route. A token would have
// to be present in the environment for it to be usable at all.
const MANAGEMENT_TOKEN_NAMES = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_MANAGEMENT_TOKEN', 'SUPABASE_PAT'];
console.log('\n  Management-API tokens in .env.local:');
for (const name of MANAGEMENT_TOKEN_NAMES) {
  console.log(`    ${name}: ${pick(name) ? 'PRESENT' : 'absent'}`);
}
console.log(`\n  Direct Postgres connection string (DATABASE_URL / POSTGRES_URL): ${pick('DATABASE_URL') || pick('POSTGRES_URL') ? 'PRESENT' : 'absent'}`);

console.log(
  anyAvailable
    ? '\nRESULT: a DDL path EXISTS — migration 0153 can be applied from here.'
    : '\nRESULT: NO DDL path exists from this environment. Migration 0153 cannot be applied by this phase;\n' +
        'it must be run by an operator with Supabase dashboard / CLI access. Everything in PC5 that does not\n' +
        'depend on 0153 can still be proven live; everything that does is honestly blocked on that one step.',
);
