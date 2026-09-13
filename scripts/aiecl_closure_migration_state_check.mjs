// AIE-1 closure mission: read-only reconciliation of reported vs observed
// migration state on DEV and PRODUCTION for migrations 0140-0146.
// Does NOT write anything. Uses schema-cache probing (select each aie_* table
// with limit 0) since this repo has no single migrations-ledger table exposed
// via PostgREST for aie_-prefixed migrations specifically; falls back to
// information_schema via a lightweight RPC if available.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
function pick(name) {
  const m = raw.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m?.[1]?.trim();
}

const DEV_URL = pick('NEXT_PUBLIC_SUPABASE_URL');
const DEV_KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
const PROD_URL = pick('PRODUCTION_SUPABASE_URL');
const PROD_KEY = pick('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY');

const tablesToProbe = [
  'aie_document_intake',
  'aie_extraction_run',
  'aie_unresolved_item',
  'aie_review_decision',
  'aie_mask_token_map',
  'aie_ii_adapter_link',       // 0141
  'aie_fdh_bank_statement_link', // 0142 (guess, will show error if wrong name)
  'aie_insurance_adapter_link', // 0143
  'aie_write_batch',
];

async function probeEnv(label, url, key) {
  console.log(`\n=== ${label} (${url ? new URL(url).host : 'MISSING URL'}) ===`);
  if (!url || !key) {
    console.log('  SKIPPED - missing credentials');
    return;
  }
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const t of tablesToProbe) {
    const { error, count } = await client.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`  ${t}: NOT FOUND / ERROR -> ${error.code || ''} ${error.message}`);
    } else {
      console.log(`  ${t}: EXISTS (row count=${count})`);
    }
  }
}

await probeEnv('DEV', DEV_URL, DEV_KEY);
await probeEnv('PRODUCTION', PROD_URL, PROD_KEY);
console.log('\nDone. This is a read-only existence probe, not a full column-level migration diff.');
