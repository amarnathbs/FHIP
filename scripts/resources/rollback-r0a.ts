// R1.7 — rollback for a specific import run.
//
//   npm run resources:rollback-r0a -- --manifest=artifacts/resources/r1-7-import-manifest.json --confirm-project=vqycarelcoijzwlpkpcz
//
// Deletes ONLY the resource_posts rows this specific run *inserted*
// (manifest.inserted_post_ids) — never rows it merely updated/reconciled
// (those existed before this run and are not this run's to delete) and
// never protected-skipped rows. Deleting a resource_posts row cascades
// (on delete cascade, migration 0033) to resource_post_categories,
// resource_post_tags, resource_videos, resource_post_sources,
// resource_post_faqs, resource_related_content and resource_context_links
// automatically — no separate cleanup needed for those. Newly-created
// categories/tags are deliberately left in place (harmless, reusable
// taxonomy) — see the completion report for this decision.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from './lib/env';

interface Manifest {
  run_id: string;
  environment: string;
  inserted_post_ids: string[];
  content_ids: string[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const manifestArg = args.find((a) => a.startsWith('--manifest='));
  const confirmArg = args.find((a) => a.startsWith('--confirm-project='));
  return {
    manifestPath: manifestArg ? manifestArg.split('=')[1] : null,
    confirmProject: confirmArg ? confirmArg.split('=')[1] : null,
  };
}

async function main() {
  const { manifestPath, confirmProject } = parseArgs();
  const creds = assertDevProject();

  if (!manifestPath) {
    console.error('Usage: npm run resources:rollback-r0a -- --manifest=<path> --confirm-project=' + creds.projectRef);
    process.exit(1);
  }
  if (confirmProject !== creds.projectRef) {
    console.error(`FATAL: rollback requires --confirm-project=${creds.projectRef}. Refusing.`);
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (manifest.environment !== creds.projectRef) {
    console.error(`FATAL: manifest was recorded against "${manifest.environment}", not the current project "${creds.projectRef}". Refusing.`);
    process.exit(1);
  }

  const postIds = manifest.inserted_post_ids.filter(Boolean);
  console.log(`Rolling back run ${manifest.run_id}: ${postIds.length} inserted post(s) eligible for deletion.`);
  if (postIds.length === 0) {
    console.log('Nothing to roll back (0 inserted rows in this manifest).');
    return;
  }

  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Safety re-check immediately before delete: confirm every id we're about
  // to delete still has a content_id from this run's content_id set (in
  // case something else in DEV reused the id space, which should be
  // impossible with uuid PKs, but this keeps the check honest rather than
  // trusting the manifest blindly).
  const { data: rows, error: checkErr } = await supa.from('resource_posts').select('id, content_id').in('id', postIds);
  if (checkErr) {
    console.error('Failed to verify rows before rollback:', checkErr.message);
    process.exit(1);
  }
  const unexpected = (rows ?? []).filter((r) => !r.content_id || !manifest.content_ids.includes(r.content_id));
  if (unexpected.length > 0) {
    console.error(`FATAL: ${unexpected.length} row(s) about to be deleted do not carry a content_id from this manifest's run. Aborting rollback to avoid deleting the wrong content.`);
    process.exit(1);
  }

  await supa.from('resource_audit_log').delete().eq('entity_type', 'resource_post').in('entity_id', postIds);

  const { error: delErr, count } = await supa.from('resource_posts').delete({ count: 'exact' }).in('id', postIds);
  if (delErr) {
    console.error('Rollback delete failed:', delErr.message);
    process.exit(1);
  }
  console.log(`Rollback complete: deleted ${count} resource_posts rows (and their cascaded relationships) + matching audit_log rows.`);
}

main().catch((e) => {
  console.error('FATAL unhandled error:', e);
  process.exit(1);
});
