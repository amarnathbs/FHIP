// NAV 1 continuation — applies the real stuck-batch reconciliation
// (referenceImportRunner.ts's reconcileStaleRunningBatches) against live
// DEV for the two genuinely-abandoned 'running' rows found and diagnosed
// this dispatch. UPDATE only, never DELETE. Safe to re-run (no-op if
// nothing is stale).
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
const STALE_AFTER_MINUTES = 15;

async function getJson(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return res.json();
}

const now = new Date();
const staleCutoff = new Date(now.getTime() - STALE_AFTER_MINUTES * 60_000);

const running = await getJson('ii_reference_import_batches?select=id,source_key,batch_kind,started_at&status=eq.running');
console.log(`Found ${running.length} 'running' batch row(s) at ${now.toISOString()}:`);
for (const r of running) console.log(`  ${r.id}  ${r.source_key}/${r.batch_kind}  started ${r.started_at}`);

const stale = running.filter((r) => new Date(r.started_at) < staleCutoff);
const stillRunning = running.filter((r) => new Date(r.started_at) >= staleCutoff);

if (stillRunning.length > 0) {
  console.log(`\n${stillRunning.length} batch(es) started within the last ${STALE_AFTER_MINUTES} minutes -- NOT touching these, they may be genuinely in flight.`);
}
if (stale.length === 0) {
  console.log('\nNothing stale to reconcile.');
  process.exit(0);
}

console.log(`\nReconciling ${stale.length} stale batch(es) (older than ${STALE_AFTER_MINUTES} minutes) -- marking status=failed, never touching any other field destructively:`);
for (const r of stale) {
  const res = await fetch(`${URL_}/rest/v1/ii_reference_import_batches?id=eq.${r.id}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'failed',
      finished_at: now.toISOString(),
      error_code: 'STALE_RUNNING_RECONCILED',
      error_detail: `Reconciled by scripts/nav1_reconcile_stale_running_batches.mjs after exceeding ${STALE_AFTER_MINUTES} minute(s) with no terminal status -- most likely an interrupted process (e.g. a function execution-time limit) partway between the parse step and instrument-resolution/write steps, not a real success or failure.`,
    }),
  });
  const updated = await res.json();
  console.log(`  ${res.status}  ${r.id}  ->`, JSON.stringify(updated[0] ?? updated));
}
