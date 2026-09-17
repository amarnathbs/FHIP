// PC5 (M4) — read-only migration-baseline probe.
//
// Re-verifies FRESH (never trusting a prior phase's report) that the next
// migration version PC5 intends to claim is genuinely free, on BOTH the
// repository and the two live databases. Writes nothing.
//
// Method, and its honest limitation: this repository exposes no migrations
// ledger through PostgREST, so "has migration N been applied" is probed
// STRUCTURALLY — by asking for each object that migration creates. A table
// that exists proves its migration ran; a table that does not exist proves
// it did not. That is exactly how `scripts/aiecl_closure_migration_state_
// check.mjs` (the AIE-1 closure pass's own probe) established the same fact,
// reused here rather than invented differently.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

const ENVS = [
  { label: 'DEV', url: pick('NEXT_PUBLIC_SUPABASE_URL'), key: pick('SUPABASE_SERVICE_ROLE_KEY') },
  { label: 'PRODUCTION', url: pick('PRODUCTION_SUPABASE_URL'), key: pick('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY') },
];

// Objects keyed by the migration that creates them.
const PROBES = [
  { migration: '0140', object: 'aie_unresolved_item' },
  { migration: '0140', object: 'aie_review_decision' },
  { migration: '0140', object: 'aie_write_batch' },
  { migration: '0141', object: 'aie_ii_adapter_link' },
  { migration: '0144', object: 'aie_review_decision', column: 'correction_field_name' },
  // 0149's real objects (read from the migration file itself, not guessed).
  { migration: '0149', object: 'aie_document_intake', column: 'purge_status' },
  { migration: '0149', object: 'aie_document_intake', column: 'purge_due_at' },
  // 0150's real object.
  { migration: '0150', object: 'aie_ai_cost_ledger' },
  // The objects PC5 (0153) intends to create — MUST NOT already exist anywhere.
  { migration: '0153 (PC5, proposed)', object: 'ii_ownership_allocation' },
  { migration: '0153 (PC5, proposed)', object: 'aie_review_decision', column: 'original_value_at_decision' },
  { migration: '0153 (PC5, proposed)', object: 'aie_review_decision', column: 'parser_version_at_decision' },
  { migration: '0153 (PC5, proposed)', object: 'aie_review_decision', column: 'resulting_reconciliation_at' },
  // Tables PC5 reads/writes through and must therefore find PRESENT.
  { migration: 'pre-existing', object: 'ii_accounts' },
  { migration: 'pre-existing', object: 'household_members' },
  { migration: 'pre-existing', object: 'business_entities' },
  { migration: 'pre-existing', object: 'ii_review_items' },
];

for (const env of ENVS) {
  console.log(`\n=== ${env.label} (${env.url ? new URL(env.url).host : 'MISSING'}) ===`);
  if (!env.url || !env.key) {
    console.log('  SKIPPED — credentials not present');
    continue;
  }
  const client = createClient(env.url, env.key, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const p of PROBES) {
    const select = p.column ?? '*';
    // `head: true` suppresses the body, and a PostgREST schema-cache miss for
    // a non-existent relation then arrives with an EMPTY message — which read
    // as a false "ABSENT" for real tables and, worse, as a false "PRESENT"
    // for missing ones. So this issues a real (limit-1) body request and
    // reports the raw PostgREST code, which is unambiguous:
    //   PGRST205 = relation not found, 42703 = column not found.
    const { error, data } = await client.from(p.object).select(select).limit(1);
    const what = p.column ? `${p.object}.${p.column}` : p.object;
    if (error) console.log(`  [${p.migration}] ${what}: ABSENT — code=${error.code ?? '(none)'} msg=${(error.message || '(empty)').slice(0, 120)}`);
    else console.log(`  [${p.migration}] ${what}: PRESENT (sample rows returned=${data?.length ?? 0})`);
  }
}
console.log('\nDone (read-only).');
