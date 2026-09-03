// G3 closure governance — evidence for the four questions asked about the
// orphaned country_confirmed audit events.
//
// STRICTLY READ-ONLY.
//
//   node --env-file=.env.local scripts/g3_audit_residue_inspection.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('missing DEV credentials'); process.exit(2); }
if (/prod/i.test(url)) { console.error('REFUSING: looks like production'); process.exit(3); }
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: rows, error } = await admin
  .from('audit_events')
  .select('id, user_id, event_type, entity, entity_id, metadata, created_at')
  .eq('event_type', 'country_confirmed')
  .is('user_id', null)
  .order('created_at');
if (error) { console.error(error.message); process.exit(1); }

console.log(`orphaned country_confirmed events (user_id IS NULL): ${rows.length}\n`);

// ---------------------------------------------------------------------------
console.log('--- Q1. Do they contain user identifiers or secrets? ---');
// ---------------------------------------------------------------------------
const allKeys = new Set();
for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) allKeys.add(k);
console.log(`  distinct metadata keys across all ${rows.length} rows: ${[...allKeys].sort().join(', ')}`);

const SECRETISH = /(eyJ[A-Za-z0-9_-]{20,}|sk_live|sk_test|re_[A-Za-z0-9]{20,}|password|token|secret|api[_-]?key)/i;
const EMAILISH = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let withSecrets = 0, withEmail = 0, withUuid = 0, withEntityId = 0;
for (const r of rows) {
  const blob = JSON.stringify(r.metadata ?? {});
  if (SECRETISH.test(blob)) withSecrets++;
  if (EMAILISH.test(blob)) withEmail++;
  if (UUIDISH.test(blob)) withUuid++;
  if (r.entity_id) withEntityId++;
}
console.log(`  rows whose metadata contains anything secret-shaped: ${withSecrets}`);
console.log(`  rows whose metadata contains an email address:       ${withEmail}`);
console.log(`  rows whose metadata contains a UUID:                 ${withUuid}`);
console.log(`  rows still carrying a non-null entity_id column:     ${withEntityId}`);
console.log(`  rows still carrying a non-null user_id column:       ${rows.filter((r) => r.user_id).length}`);

// Show one complete row so the claim is inspectable rather than asserted.
if (rows.length) {
  console.log('\n  VERBATIM SAMPLE (one full row, nothing redacted — there is nothing to redact):');
  const s = rows[0];
  console.log(`    ${JSON.stringify({ user_id: s.user_id, entity: s.entity, entity_id: s.entity_id, metadata: s.metadata })}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- Q2. Are they unmistakably marked as CERTIFICATION events? ---');
// ---------------------------------------------------------------------------
const byWriter = {};
for (const r of rows) {
  const w = r.metadata?.written_by ?? '(none)';
  byWriter[w] = (byWriter[w] ?? 0) + 1;
}
console.log(`  written_by values: ${JSON.stringify(byWriter)}`);
const certMarked = rows.filter((r) => r.metadata?.certification === true || /cert/i.test(String(r.metadata?.source ?? ''))).length;
console.log(`  rows carrying an explicit certification marker: ${certMarked}`);
console.log(
  certMarked === rows.length
    ? '  => YES: every row is explicitly marked.'
    : '  => NO: `written_by` identifies the WRITING FUNCTION, not the PURPOSE. A real\n' +
      '     end user confirming their country produces the same marker, and a real user\n' +
      '     who later deleted their account would also leave user_id NULL. These rows are\n' +
      '     therefore NOT distinguishable from genuine confirmations by metadata alone.'
);

// ---------------------------------------------------------------------------
console.log('\n--- Q3. Are they excluded from operational/user analytics? ---');
// ---------------------------------------------------------------------------
// Answered by evidence, not assumption: find every consumer of audit_events
// in the repository and report whether any analytics surface reads it.
console.log('  (see the repository grep reported alongside this script)');

// ---------------------------------------------------------------------------
console.log('\n--- Q4. Total audit_events shape, for retention context ---');
// ---------------------------------------------------------------------------
const { data: allEvents } = await admin.from('audit_events').select('event_type, user_id');
const totals = {};
for (const e of allEvents ?? []) totals[e.event_type] = (totals[e.event_type] ?? 0) + 1;
console.log(`  total audit_events rows: ${(allEvents ?? []).length}`);
console.log(`  by event_type: ${JSON.stringify(totals)}`);
console.log(`  orphaned (user_id NULL) across ALL event types: ${(allEvents ?? []).filter((e) => !e.user_id).length}`);

console.log('\n=== READ-ONLY. No row was created, modified or deleted. ===');
