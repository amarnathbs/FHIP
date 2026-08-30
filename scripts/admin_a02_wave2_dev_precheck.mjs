// Admin A0.2 Wave 2 — DEV pre-check (READ-ONLY). Run BEFORE migration 0116
// is applied. Same methodology as scripts/admin_a02_wave1_dev_precheck.mjs
// and scripts/admin_a02_wave1b_dev_precheck.mjs.
//
// Answers three questions the Product Owner needs before applying 0116:
//
//   1. Are 0116's objects genuinely absent right now? (If they are already
//      present, the migration has been applied and this run is a no-op
//      confirmation, not a pre-check.)
//   2. EXISTING-DATA COMPATIBILITY for the Scope B scheduling invariant
//      (Wave 2 brief §6.5) — how many Resources are currently 'scheduled'
//      with a null or past scheduled_at, and how many non-scheduled
//      Resources carry a stale timestamp? The new rule is a TRANSITION-time
//      check inside the RPC and adds no table constraint, so it cannot
//      invalidate any row at rest; these counts are disclosure, not a
//      blocker.
//   3. EXISTING-DATA baseline for the Scope A reorder invariant — the
//      Related Content row count and, per source, whether positions are
//      already duplicated or gapped. 0116 deliberately adds no
//      unique(source_post_id, sort_order) constraint precisely because this
//      number is non-zero; the Product Owner should see the real figure.
//
// Writes nothing. Reads only.
//
// Usage: node scripts/admin_a02_wave2_dev_precheck.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

console.log(`Target project URL: ${url}`);
console.log('This must be the DEV project (vqycarelcoijzwlpkpcz.supabase.co) — never production.\n');

// Fetch every row of a table, paginating past Supabase's 1000-row REST cap.
async function fetchAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
console.log('=== 1. Are migration 0116 objects present yet? ===');
// ---------------------------------------------------------------------------
{
  const { error } = await admin.rpc('admin_reorder_related_content', { p_source_post_id: null, p_ordered_ids: null });
  if (error && /could not find the function|does not exist|PGRST202/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
    console.log(`admin_reorder_related_content RPC: NOT FOUND (expected BEFORE 0116 is applied) — ${error.code ?? ''} ${error.message}`);
  } else if (error) {
    console.log(`admin_reorder_related_content RPC: EXISTS — the call reached the function body and it correctly rejected the null payload (${error.code}: ${error.message}). Migration 0116 is ALREADY APPLIED.`);
  } else {
    console.log('WARNING: the RPC accepted a null payload. That should be impossible — investigate before proceeding.');
  }
}
{
  // The Scope B guard is inside an existing function, so its presence cannot
  // be detected by existence alone. Probing it safely would require a real
  // approved post and a publisher session, which a read-only pre-check must
  // not create — so this is deliberately deferred to the post-application
  // live verification script rather than guessed at here.
  console.log('transition_resource_post_status scheduling guard: not probed here (requires a real fixture + publisher session).');
  console.log('  -> proved after application by scripts/admin_a02_wave2_live_dev_verification.mjs.');
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. Scope B: existing-data compatibility with the scheduling invariant ===');
// ---------------------------------------------------------------------------
{
  const posts = await fetchAll('resource_posts', 'id, title, content_type, status, scheduled_at');
  const now = Date.now();
  const scheduled = posts.filter((p) => p.status === 'scheduled');
  const scheduledNull = scheduled.filter((p) => p.scheduled_at === null);
  const scheduledPast = scheduled.filter((p) => p.scheduled_at !== null && Date.parse(p.scheduled_at) <= now);
  const scheduledFuture = scheduled.filter((p) => p.scheduled_at !== null && Date.parse(p.scheduled_at) > now);
  const nonScheduledWithTimestamp = posts.filter((p) => p.status !== 'scheduled' && p.scheduled_at !== null);

  console.log(`resource_posts total: ${posts.length}`);
  console.log(`  status='scheduled': ${scheduled.length}`);
  console.log(`    ...with NULL scheduled_at:   ${scheduledNull.length}   (would violate the invariant if re-transitioned)`);
  console.log(`    ...with PAST scheduled_at:   ${scheduledPast.length}   (would violate the invariant if re-transitioned)`);
  console.log(`    ...with FUTURE scheduled_at: ${scheduledFuture.length}`);
  console.log(`  non-scheduled rows carrying a stale scheduled_at: ${nonScheduledWithTimestamp.length}`);
  console.log(`  status='published': ${posts.filter((p) => p.status === 'published').length}`);

  const byType = {};
  for (const p of posts) byType[p.content_type] = (byType[p.content_type] ?? 0) + 1;
  console.log(`  by content_type: ${JSON.stringify(byType)}`);

  if (scheduledNull.length || scheduledPast.length) {
    console.log('\n  Rows that would FAIL the new invariant if someone re-transitioned them to scheduled');
    console.log('  (they are NOT modified by 0116 — the rule is transition-time only, no table constraint is added,');
    console.log('   and none of them blocks the migration):');
    for (const p of [...scheduledNull, ...scheduledPast]) {
      console.log(`    ${p.id}  ${p.scheduled_at ?? 'NULL'}  ${JSON.stringify(p.title)}`);
    }
  } else {
    console.log('\n  No existing row would fail the new invariant.');
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. Scope A: Related Content position baseline ===');
// ---------------------------------------------------------------------------
{
  const links = await fetchAll('resource_related_content', 'id, source_post_id, related_post_id, relationship_type, sort_order');
  const bySource = new Map();
  for (const l of links) {
    if (!bySource.has(l.source_post_id)) bySource.set(l.source_post_id, []);
    bySource.get(l.source_post_id).push(l.sort_order);
  }

  let dup = 0;
  let gapped = 0;
  let clean = 0;
  for (const orders of bySource.values()) {
    const uniq = new Set(orders);
    if (uniq.size !== orders.length) dup++;
    else if (![...uniq].sort((a, b) => a - b).every((v, i) => v === i)) gapped++;
    else clean++;
  }

  const pairKeys = links.map((l) => `${l.source_post_id}|${l.related_post_id}|${l.relationship_type}`);
  const dupPairs = pairKeys.length - new Set(pairKeys).size;
  const selfLinks = links.filter((l) => l.source_post_id === l.related_post_id).length;

  console.log(`resource_related_content rows: ${links.length}`);
  console.log(`distinct source Resources:      ${bySource.size}`);
  console.log(`  sources with DUPLICATE positions:        ${dup}`);
  console.log(`  sources with gapped positions (no dup):  ${gapped}`);
  console.log(`  sources already unique + contiguous:     ${clean}`);
  console.log(`  duplicate source|target|type pairs:      ${dupPairs}  (must be 0 — uq_resource_related_content)`);
  console.log(`  self-links:                              ${selfLinks}  (must be 0 — chk_..._no_self_reference)`);
  console.log(`  largest single set:                      ${Math.max(0, ...[...bySource.values()].map((v) => v.length))}  (RPC cap is 100)`);
  console.log('\n  NOTE: 0116 deliberately adds NO unique(source_post_id, sort_order) constraint.');
  console.log('  The duplicate-position count above is exactly why: such a constraint would fail to apply,');
  console.log('  or force a silent mass repair of existing content, both of which Wave 2 forbids.');
  console.log('  The invariant is enforced by the reorder OPERATION, not retroactively across historical rows.');
}

console.log('\nPre-check complete. Nothing was written.');
