// Classifies the 91 tables scripts/mcc_full_table_inventory.mjs flagged as
// "authenticated can insert directly, not yet backstopped" into:
//   - GENERIC: has a direct user_id column referencing the acting user —
//     gets the existing enforce_country_confirmed() trigger (unchanged
//     function, just a new table).
//   - BESPOKE: financial-module data but no direct user_id column — needs a
//     dedicated trigger resolving the owner via a different column/join.
//   - EXCLUDED: deliberately not backstopped, with a stated reason.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const inventory = JSON.parse(fs.readFileSync(path.join(HERE, 'mcc_full_table_inventory.json'), 'utf8'));
const needsReview = inventory.needsReview;

const { rows: cols } = await db.query(
  `select table_name, column_name from information_schema.columns where table_schema='public' and table_name = any($1) order by table_name, ordinal_position`,
  [needsReview]
);
const colsByTable = {};
for (const r of cols) (colsByTable[r.table_name] ??= []).push(r.column_name);

// Explicit, reasoned exclusions.
const EXCLUDE_BOOTSTRAP = new Set(['user_profiles']); // would break signup itself — see migration comment
const EXCLUDE_CONSENT = new Set(['consents']); // spec 1.2 keeps consent/privacy/terms interactions reachable pre-confirmation
const RESOURCES_CMS_TABLES = new Set([
  'resource_authors',
  'resource_categories',
  'resource_context_links',
  'resource_ctas',
  'resource_faqs',
  'resource_media',
  'resource_post_categories',
  'resource_post_faqs',
  'resource_post_sources',
  'resource_post_tags',
  'resource_post_versions',
  'resource_posts',
  'resource_related_content',
  'resource_settings',
  'resource_sources',
  'resource_tags',
  'resource_videos',
]); // shared CMS content, not per-user financial data; role-based RLS, not user_id ownership; already fully covered by the API-layer gate (MCC-2, round 2)

const BESPOKE_OWNER_COLUMN = {
  professional_notes: 'author_user_id',
};
const BESPOKE_JOIN = {
  financial_twin_insights: { via: 'financial_twin_run_id', parentTable: 'financial_twin_runs', parentKey: 'id', parentUserCol: 'user_id' },
  financial_twin_metric_results: { via: 'financial_twin_run_id', parentTable: 'financial_twin_runs', parentKey: 'id', parentUserCol: 'user_id' },
};

const generic = [];
const bespokeOwnerCol = [];
const bespokeJoin = [];
const excluded = [];

for (const t of needsReview) {
  if (EXCLUDE_BOOTSTRAP.has(t)) {
    excluded.push({ table: t, reason: 'signup bootstrap — handle_new_user() inserts this row with no prior country state to check; the trigger would always reject its own creation' });
    continue;
  }
  if (EXCLUDE_CONSENT.has(t)) {
    excluded.push({ table: t, reason: 'consent/privacy/terms acceptance must remain reachable regardless of confirmation state (spec 1.2) — currently unused by any code path, but excluded on principle, not just because it is dormant' });
    continue;
  }
  if (RESOURCES_CMS_TABLES.has(t)) {
    excluded.push({ table: t, reason: 'Resources CMS shared content, not per-user financial data; role-based RLS ownership (resource_user_roles), not auth.uid()=user_id; fully covered by the API-layer gate (all 40 Resources admin write routes gated this round)' });
    continue;
  }
  if (BESPOKE_OWNER_COLUMN[t]) {
    bespokeOwnerCol.push({ table: t, ownerColumn: BESPOKE_OWNER_COLUMN[t] });
    continue;
  }
  if (BESPOKE_JOIN[t]) {
    bespokeJoin.push({ table: t, ...BESPOKE_JOIN[t] });
    continue;
  }
  const columns = colsByTable[t] || [];
  if (columns.includes('user_id')) {
    generic.push(t);
  } else {
    excluded.push({ table: t, reason: `UNCLASSIFIED — no user_id column and no bespoke rule defined; columns: ${columns.join(',')}` });
  }
}

console.log(`GENERIC (direct user_id, reuse enforce_country_confirmed()): ${generic.length}`);
console.log(generic.map((t) => '  ' + t).join('\n'));
console.log(`\nBESPOKE via owner column: ${bespokeOwnerCol.length}`);
console.log(bespokeOwnerCol.map((r) => `  ${r.table} (owner column: ${r.ownerColumn})`).join('\n'));
console.log(`\nBESPOKE via join: ${bespokeJoin.length}`);
console.log(bespokeJoin.map((r) => `  ${r.table} -> ${r.parentTable}.${r.parentKey} via ${r.via}`).join('\n'));
console.log(`\nEXCLUDED (with reason): ${excluded.length}`);
console.log(excluded.map((r) => `  ${r.table}: ${r.reason}`).join('\n'));

const anyUnclassified = excluded.some((r) => r.reason.startsWith('UNCLASSIFIED'));
console.log(`\nTotal reviewed: ${generic.length + bespokeOwnerCol.length + bespokeJoin.length + excluded.length} (expected ${needsReview.length})`);
if (anyUnclassified) {
  console.error('\nERROR: at least one table has no classification rule. Fix this script before generating the migration.');
  process.exit(1);
}

fs.writeFileSync(
  path.join(HERE, 'mcc_table_classification.json'),
  JSON.stringify({ generic, bespokeOwnerCol, bespokeJoin, excluded }, null, 2)
);
console.log('\nWritten to scripts/mcc_table_classification.json');
