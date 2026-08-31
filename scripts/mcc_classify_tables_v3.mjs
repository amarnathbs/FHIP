// Mandatory Country Confirmation, round 3 closure — Gap 1 + Gap 2: builds
// the exact, per-table, per-operation trigger plan from real discovery
// (scripts/mcc_crud_policy_inventory.json), not assumption. For every table
// with ANY authenticated write policy (SELECT/INSERT/UPDATE/DELETE),
// determines:
//   - which of INSERT/UPDATE/DELETE actually have an authenticated policy
//     (only those get trigger coverage — an operation with NO authenticated
//     policy is already blocked by RLS alone, so adding a trigger for it
//     would be redundant, not "smallest safe").
//   - GENERIC (direct user_id) / BESPOKE (owner column or join) / EXCLUDED
//     (with a stated reason), extending round 2's classification to the 5
//     new tables merged in from FDH-10/origin-main since.
//   - the NARROW, per-table onboarding exemption (round-3 fix for Gap 1):
//     ONLY `households`, and ONLY for INSERT/UPDATE (never DELETE, never
//     any other table) — replacing round 2's blanket
//     `onboarding_completed=false exempts everything` defect.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
  await db.exec(sql);
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}

const crud = JSON.parse(fs.readFileSync(path.join(HERE, 'mcc_crud_policy_inventory.json'), 'utf8'));
const anyWrite = crud.filter((r) => r.INSERT || r.UPDATE || r.DELETE);

const { rows: cols } = await db.query(
  `select table_name, column_name from information_schema.columns where table_schema='public' and table_name = any($1) order by table_name, ordinal_position`,
  [anyWrite.map((r) => r.table)]
);
const colsByTable = {};
for (const r of cols) (colsByTable[r.table_name] ??= []).push(r.column_name);

const EXCLUDE_BOOTSTRAP = new Set(['user_profiles']);
const EXCLUDE_CONSENT = new Set(['consents']);
const RESOURCES_CMS_TABLES = new Set([
  'resource_authors', 'resource_categories', 'resource_context_links', 'resource_ctas', 'resource_faqs',
  'resource_media', 'resource_post_categories', 'resource_post_faqs', 'resource_post_sources', 'resource_post_tags',
  'resource_post_versions', 'resource_posts', 'resource_related_content', 'resource_settings', 'resource_sources',
  'resource_tags', 'resource_videos',
]);
const BESPOKE_OWNER_COLUMN = { professional_notes: 'author_user_id' };
const BESPOKE_JOIN = {
  financial_twin_insights: { via: 'financial_twin_run_id', parentTable: 'financial_twin_runs', parentUserCol: 'user_id' },
  financial_twin_metric_results: { via: 'financial_twin_run_id', parentTable: 'financial_twin_runs', parentUserCol: 'user_id' },
};
// Round-3 fix for Gap 1 — the ONLY table/operation pair allowed a
// pre-onboarding-completion exemption, and why: the onboarding wizard's own
// PUT /api/household call runs before country confirmation is ever a
// concept for that user (spec section 10 hard-stop: blocking it would break
// signup). Nothing else — not user_goals (round 2's mistake; the optional
// first-goal write was moved to occur strictly after confirmation instead,
// see app/(onboarding)/confirm-country/ConfirmCountryForm.tsx), not any of
// the other 100+ tables.
const NARROW_ONBOARDING_EXEMPTION = { households: ['INSERT', 'UPDATE'] };

const ops = ['INSERT', 'UPDATE', 'DELETE'];
const generic = [];
const bespokeOwnerCol = [];
const bespokeJoin = [];
const excluded = [];

for (const r of anyWrite) {
  const t = r.table;
  const activeOps = ops.filter((op) => r[op]);
  if (EXCLUDE_BOOTSTRAP.has(t)) {
    excluded.push({ table: t, ops: activeOps, reason: 'signup bootstrap (INSERT) / the confirmation write itself (UPDATE) — a trigger here would make country confirmation impossible to ever perform' });
    continue;
  }
  if (EXCLUDE_CONSENT.has(t)) {
    excluded.push({ table: t, ops: activeOps, reason: 'spec 1.2 consent/privacy/terms carve-out, all operations' });
    continue;
  }
  if (RESOURCES_CMS_TABLES.has(t)) {
    excluded.push({ table: t, ops: activeOps, reason: 'Resources CMS shared content, not per-user financial data; fully covered by the API-layer gate' });
    continue;
  }
  if (BESPOKE_OWNER_COLUMN[t]) {
    bespokeOwnerCol.push({ table: t, ownerColumn: BESPOKE_OWNER_COLUMN[t], ops: activeOps });
    continue;
  }
  if (BESPOKE_JOIN[t]) {
    bespokeJoin.push({ table: t, ...BESPOKE_JOIN[t], ops: activeOps });
    continue;
  }
  const columns = colsByTable[t] || [];
  if (columns.includes('user_id')) {
    generic.push({ table: t, ops: activeOps, onboardingExempt: NARROW_ONBOARDING_EXEMPTION[t] || [] });
  } else {
    excluded.push({ table: t, ops: activeOps, reason: `UNCLASSIFIED — no user_id column and no bespoke rule defined; columns: ${columns.join(',')}` });
  }
}

console.log(`GENERIC: ${generic.length}, BESPOKE-owner: ${bespokeOwnerCol.length}, BESPOKE-join: ${bespokeJoin.length}, EXCLUDED: ${excluded.length}`);
console.log(`Total: ${generic.length + bespokeOwnerCol.length + bespokeJoin.length + excluded.length} (expected ${anyWrite.length})`);
const unclassified = excluded.filter((e) => e.reason.startsWith('UNCLASSIFIED'));
if (unclassified.length) {
  console.error('UNCLASSIFIED tables found:', unclassified.map((u) => u.table));
  process.exit(1);
}

fs.writeFileSync(
  path.join(HERE, 'mcc_table_classification_v3.json'),
  JSON.stringify({ generic, bespokeOwnerCol, bespokeJoin, excluded }, null, 2)
);
console.log('Written to scripts/mcc_table_classification_v3.json');
