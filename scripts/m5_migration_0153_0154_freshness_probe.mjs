// M5 (Part L) — fresh, minimal status probe for the TWO migrations this
// mission left awaiting manual DEV application: 0153 (PC5 governed
// resolution) and 0154 (HUF entity_type + India gate).
//
// Written for M5 rather than reusing a whole phase matrix because the only
// question here is "has an operator applied these yet?", and answering it
// should not create four disposable users and ~20 rows.
//
// METHOD
//   0153 — STRUCTURAL. Its objects either exist or they do not. Delegated to
//          `scripts/pc5_migration_baseline_probe.mjs`, which already probes
//          both databases with positive controls; this file restates the
//          0154 half only, plus a compact 0153 re-read.
//   0154 — BEHAVIOURAL, exactly as M4B's own GATE-1/GATE-2 did. 0154 widens a
//          CHECK constraint; a widened CHECK is invisible to PostgREST's
//          schema cache, so the only honest probe is to attempt a real insert
//          with entity_type='huf' and read the refusal. A 23514 on
//          `business_entities_entity_type_check` proves the two-value CHECK is
//          still live, i.e. 0154 has NOT run.
//
// The insert deliberately uses an all-zero user_id so that it CANNOT create a
// real row even in the branch where the CHECK has been widened: it would then
// fail the user_id foreign key (23503) or 0154's own India-gate trigger
// (42501) instead. Any row that somehow lands is deleted before exit and the
// deletion is re-verified.
//
// Writes nothing on the success path. Reads no user data.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

const ENVS = [
  { label: 'DEV', url: pick('NEXT_PUBLIC_SUPABASE_URL'), key: pick('SUPABASE_SERVICE_ROLE_KEY') },
  { label: 'PRODUCTION', url: pick('PRODUCTION_SUPABASE_URL'), key: pick('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY') },
];

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const stamp = new Date().toISOString().replace(/[^0-9]/g, '');

// M4B's own matcher, restated here so this probe is self-contained.
const looksLike0154Gap = (msg) =>
  typeof msg === 'string' &&
  /business_entities_entity_type_check/i.test(msg);

for (const env of ENVS) {
  console.log(`\n=== ${env.label} (${env.url ? new URL(env.url).host : 'MISSING'}) ===`);
  if (!env.url || !env.key) {
    console.log('  SKIPPED — credentials not present');
    continue;
  }
  const admin = createClient(env.url, env.key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 0153: structural ----------------------------------------------------
  const objects = [
    { table: 'ii_ownership_allocation', column: '*' },
    { table: 'aie_review_decision', column: 'original_value_at_decision' },
    { table: 'aie_review_decision', column: 'parser_version_at_decision' },
    { table: 'aie_review_decision', column: 'resulting_reconciliation_at' },
  ];
  let present0153 = 0;
  for (const o of objects) {
    const { error } = await admin.from(o.table).select(o.column).limit(1);
    const absent = Boolean(error);
    if (!absent) present0153 += 1;
    console.log(
      `  [0153] ${o.table}${o.column === '*' ? '' : '.' + o.column}: ` +
        (absent ? `ABSENT — code=${error.code}` : 'PRESENT')
    );
  }
  console.log(
    `  => 0153 VERDICT: ${present0153 === objects.length ? 'APPLIED' : present0153 === 0 ? 'NOT APPLIED' : `PARTIAL (${present0153}/${objects.length}) — INVESTIGATE`}`
  );

  // ---- 0154: behavioural ---------------------------------------------------
  const probe = await admin
    .from('business_entities')
    .insert({
      user_id: ZERO_UUID,
      name: `m5 gate probe ${stamp}`,
      entity_type: 'huf',
      currency_code: 'INR',
      ownership_percentage: 100,
      valuation_mode: 'summary',
      summary_net_asset_value: 1,
    })
    .select('id')
    .single();

  const refusedByCheck = Boolean(probe.error && looksLike0154Gap(probe.error.message));
  console.log(
    `  [0154] insert entity_type='huf': ` +
      (probe.error
        ? `REFUSED code=${probe.error.code} msg=${String(probe.error.message).slice(0, 140)}`
        : `ACCEPTED (id=${probe.data?.id}) — CHECK has been widened`)
  );
  console.log(
    `  => 0154 VERDICT: ${refusedByCheck ? 'NOT APPLIED (two-value CHECK still live)' : 'CHECK NO LONGER REFUSES huf — 0154 may be APPLIED, verify the trigger too'}`
  );

  // ---- cleanup, and re-verify it -------------------------------------------
  if (probe.data?.id) {
    await admin.from('business_entities').delete().eq('id', probe.data.id);
    const { data: still } = await admin
      .from('business_entities')
      .select('id')
      .eq('id', probe.data.id);
    console.log(`  [cleanup] probe row removed; rows remaining=${still?.length ?? 'unknown'}`);
  } else {
    console.log('  [cleanup] nothing to clean — no row was created');
  }
}

console.log('\nDone.');
